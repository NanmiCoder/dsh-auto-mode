import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CLASSIFIER_SYSTEM_PROMPT, createHttpClassifier, parseClassifierDecision, redactClassifierText, sanitizeClassifierArguments, sanitizeClassifierText } from '../src/classifier.js'
import { createDshClassifier } from '../src/dsh-classifier.js'

const input = {
  toolName: 'unknown',
  arguments: { text: 'untrusted' },
  workspaceRoot: '/work/repo',
  policyReason: 'unknown',
  trustedUserMessages: ['run the project diagnostics'],
  filesystemEffects: [{ kind: 'create-or-overwrite' as const, path: '/work/repo/report.json', existedBefore: false }],
  route: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
}

describe('HTTP classifier', () => {
  it('helps with narrow reversible widening but keeps deletion explicitly scoped', () => {
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('without magic words such as "authorize"')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('only creates new data or is readily reversible')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('existedBefore=true means the call may overwrite or delete pre-existing data')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('deletion or replacement of pre-existing data')
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain('Never generalize permission from one path to a glob')
  })

  it('accepts only a strict decision object', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"decision":"allow","reason":"routine local check"}' } }],
    }), { status: 200 }))
    const classifier = createHttpClassifier({ endpoint: 'https://classifier.invalid/v1/chat/completions', model: 'safe', timeoutMs: 1000, fetchImpl })
    await expect(classifier.classify(input, new AbortController().signal)).resolves.toEqual({ decision: 'allow', reason: 'routine local check' })
    const request = fetchImpl.mock.calls[0]?.[1]
    expect(request?.body).not.toContain('repository payload')
  })

  it('rejects malformed and unavailable responses for caller fallback', async () => {
    const malformed = createHttpClassifier({
      endpoint: 'https://classifier.invalid', model: 'safe', timeoutMs: 1000,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"maybe"}' } }] }), { status: 200 }),
    })
    await expect(malformed.classify(input, new AbortController().signal)).rejects.toThrow(/decision|reason/)
    const unavailable = createHttpClassifier({
      endpoint: 'https://classifier.invalid', model: 'safe', timeoutMs: 1000,
      fetchImpl: async () => { throw new Error('offline') },
    })
    await expect(unavailable.classify(input, new AbortController().signal)).rejects.toThrow('offline')
  })

  it('redacts bulk content and credentials before classification', () => {
    expect(sanitizeClassifierArguments({
      command: 'curl -H "Authorization: Bearer secret-token-value" https://example.invalid',
      content: 'repository payload',
      apiKey: 'sk-example-secret',
    })).toEqual({
      command: 'curl -H "Authorization: [redacted-bearer]" https://example.invalid',
      content: 'repository payload',
      apiKey: '[redacted-secret-field]',
    })
    expect(sanitizeClassifierText('please use sk-example-secret-value for the test')).toBe('please use [redacted-llm-key] for the test')
  })
})

describe('native DSH classifier', () => {
  it('accepts the complete allow, ask, and deny vocabulary only', () => {
    for (const decision of ['allow', 'ask', 'deny'] as const) {
      expect(parseClassifierDecision({ decision, reason: `${decision} reason` })).toEqual({ decision, reason: `${decision} reason` })
    }
    expect(() => parseClassifierDecision({ decision: 'allow', reason: 'ok', authorized: true })).toThrow(/only/)
  })

  it('reuses the current Harness route for one bounded independent model call', async () => {
    let request: GenerateOptions | undefined
    const runtime = {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        request = options
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '```json\n{"decision":"allow","reason":"safe version probe"}\n```' } as const
          yield { type: 'finish', reason: { kind: 'stop' } } as const
        })()
      },
    }
    const classifier = createDshClassifier(runtime, { timeoutMs: 1_000 })
    await expect(classifier.classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'safe version probe' })
    expect(request).toMatchObject({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', temperature: 0, maxTokens: 1_024,
    })
    expect(request?.sessionId).toBeUndefined()
    expect(request?.messages[0]?.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.stringify(request?.messages)).toContain('trustedUserMessages')
    expect(JSON.stringify(request?.messages)).toContain('filesystemEffects')
  })

  it('fails loud on unavailable routes, invalid output, and provider failures', async () => {
    const invalidRuntime = {
      stream(): AsyncIterable<StreamChunk> {
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: '{"decision":"maybe","reason":"unknown"}' } as const
          yield { type: 'finish', reason: { kind: 'stop' } } as const
        })()
      },
    }
    const classifier = createDshClassifier(invalidRuntime, { timeoutMs: 1_000 })
    await expect(classifier.classify(input, new AbortController().signal)).rejects.toThrow(/decision/)
    await expect(classifier.classify({ ...input, route: undefined }, new AbortController().signal)).rejects.toThrow(/no provider\/model/)

    const failedRuntime = {
      stream(): AsyncIterable<StreamChunk> {
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider offline', code: 'OFFLINE' } } } as const
        })()
      },
    }
    await expect(createDshClassifier(failedRuntime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .rejects.toThrow('provider offline')
  })

  it('distinguishes classifier timeout from cancellation of the pending tool call', async () => {
    const abortOnlyRuntime = {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new Error('DeepSeek request aborted by caller'))
            if (options.signal.aborted) abort()
            else options.signal.addEventListener('abort', abort, { once: true })
          })
          yield { type: 'finish', reason: { kind: 'stop' } } as const
        })()
      },
    }
    await expect(createDshClassifier(abortOnlyRuntime, { timeoutMs: 10 }).classify(input, new AbortController().signal))
      .rejects.toThrow('classifier timed out after 10ms')

    const caller = new AbortController()
    caller.abort()
    await expect(createDshClassifier(abortOnlyRuntime, { timeoutMs: 1_000 }).classify(input, caller.signal))
      .rejects.toThrow('classifier request cancelled because the pending tool call was aborted')
  })

  it('requires provider and model overrides as a pair', () => {
    const runtime = { stream: vi.fn() as unknown as (options: GenerateOptions) => AsyncIterable<StreamChunk> }
    expect(() => createDshClassifier(runtime, { timeoutMs: 1_000, provider: 'deepseek-official' })).toThrow(/together/)
  })
})

describe('redactClassifierText', () => {
  it('redacts AKIA / ASIA AWS access-key IDs', () => {
    const result = redactClassifierText('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')
    expect(result.value).toBe('export AWS_ACCESS_KEY_ID=[redacted-aws-access-key]')
    expect(result.redactedNames).toContain('aws-access-key')
  })

  it('redacts github classic / user / server PATs (gh[pus]_<36>)', () => {
    const result = redactClassifierText('token = ghp_012345678901234567890123456789012345')
    expect(result.value).toBe('token = [redacted-github-classic]')
    expect(result.redactedNames).toContain('github-classic')
    const user = redactClassifierText('token = ghu_012345678901234567890123456789012345')
    expect(user.value).toBe('token = [redacted-github-classic]')
    const server = redactClassifierText('token = ghs_012345678901234567890123456789012345')
    expect(server.value).toBe('token = [redacted-github-classic]')
  })

  it('redacts gho_ github OAuth access tokens (40 chars)', () => {
    const result = redactClassifierText('token = gho_0123456789abcdef0123456789abcdef01234567')
    expect(result.value).toBe('token = [redacted-github-oauth]')
    expect(result.redactedNames).toContain('github-oauth')
  })

  it('redacts github_pat_ fine-grained PATs (22+ chars body)', () => {
    const result = redactClassifierText('token = github_pat_0123456789abcdef_0123456789abcdef')
    expect(result.value).toBe('token = [redacted-github-fine-pat]')
    expect(result.redactedNames).toContain('github-fine-pat')
  })

  it('redacts sk- / sk-proj- LLM API keys (16+ chars)', () => {
    const plain = redactClassifierText('sk-0123456789abcdef0123456789abcdef')
    expect(plain.value).toBe('[redacted-llm-key]')
    expect(plain.redactedNames).toContain('llm-key')
    const proj = redactClassifierText('sk-proj-0123456789abcdef0123456789abcdef')
    expect(proj.value).toBe('[redacted-llm-key]')
  })

  it('redacts Anthropic keys only when anchored to sk-ant-api<NN>-<32+>', () => {
    // Real Anthropic key (api03 + 40-char body) — matches.
    const real = redactClassifierText('sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890')
    expect(real.value).toBe('[redacted-anthropic-key]')
    // Documentation strings without the api<NN>- prefix — DO NOT match.
    expect(redactClassifierText('uses sk-ant-abcdefghij1234567890 in config').redactedNames)
      .not.toContain('anthropic-key')
    // Single-digit api version — does NOT match.
    expect(redactClassifierText('sk-ant-api3-abcdefghijklmnopqrstuvwxyz123456').redactedNames)
      .not.toContain('anthropic-key')
  })

  it('redacts a complete PEM private-key block (BEGIN ... END inclusive)', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'abc',
      'def',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    const result = redactClassifierText(pem)
    expect(result.value).toBe('[redacted-pem-private-key]')
    expect(result.redactedNames).toContain('pem-private-key')
  })

  it('redacts multiple credential shapes in one input and lists each name once', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE sk-ant-api03-abcabcabcabcabcabcabcabcabcabc12AKIAL'
    const result = redactClassifierText(input)
    expect(result.redactedNames).toContain('aws-access-key')
    expect(result.redactedNames).toContain('anthropic-key')
  })

  it('emits the input unchanged when no pattern matches', () => {
    const input = 'just a plain string with no credentials'
    const result = redactClassifierText(input)
    expect(result.value).toBe(input)
    expect(result.redactedNames).toEqual([])
  })

  it('truncates the redacted value to maxLength when supplied', () => {
    const result = redactClassifierText('A'.repeat(2000), 100)
    expect(result.value.length).toBe(100)
  })
})

describe('sanitizeClassifierArguments', () => {
  it('redacts a top-level credential-shaped string value but leaves neighbors alone', () => {
    const out = sanitizeClassifierArguments({
      command: 'curl https://example.invalid',
      note: 'use AKIAIOSFODNN7EXAMPLE in production',
    }) as Record<string, string>
    expect(out.command).toBe('curl https://example.invalid')
    expect(out.note).toBe('use [redacted-aws-access-key] in production')
  })

  it('redacts string credentials nested inside arrays and objects', () => {
    const out = sanitizeClassifierArguments({
      env: [
        'GITHUB_TOKEN=ghp_012345678901234567890123456789012345',
        'OTHER=plain',
      ],
      nested: {
        body: 'token = AKIAIOSFODNN7EXAMPLE',
      },
    })
    expect(out).toEqual({
      env: [
        'GITHUB_[redacted-key-value]',
        'OTHER=plain',
      ],
      nested: {
        body: 'token = [redacted-aws-access-key]',
      },
    })
  })

  it('wholesale-redacts SECRET_KEYS-matched keys', () => {
    const out = sanitizeClassifierArguments({ apiKey: 'sk-example-secret' }) as Record<string, string>
    expect(out.apiKey).toBe('[redacted-secret-field]')
  })

  it('does NOT truncate CONTENT_KEYS-matched fields any more (content keys emit plain text after pattern scan)', () => {
    const out = sanitizeClassifierArguments({ content: 'repository payload' }) as Record<string, string>
    expect(out.content).toBe('repository payload')
  })

  it('preserves non-string scalars at depth 0', () => {
    expect(sanitizeClassifierArguments({ count: 7, flag: true, missing: null }))
      .toEqual({ count: 7, flag: true, missing: null })
  })

  it('caps array size at 25 entries', () => {
    const arr = Array.from({ length: 30 }, (_, i) => `item-${i}`)
    const out = sanitizeClassifierArguments({ list: arr }) as { list: unknown[] }
    expect(out.list.length).toBe(25)
  })

  it('caps object key count at 50 entries', () => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < 60; i++) obj[`k${i}`] = `v${i}`
    const out = sanitizeClassifierArguments(obj) as Record<string, string>
    expect(Object.keys(out).length).toBe(50)
  })
})
