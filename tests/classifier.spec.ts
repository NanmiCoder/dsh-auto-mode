import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CLASSIFIER_SYSTEM_PROMPT, createHttpClassifier, parseClassifierDecision, sanitizeClassifierArguments, sanitizeClassifierText } from '../src/classifier.js'
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
      command: 'curl -H "Authorization: Bearer [redacted-secret]" https://example.invalid',
      content: '[redacted-content:18-chars]',
      apiKey: '[redacted-secret-field]',
    })
    expect(sanitizeClassifierText('please use sk-example-secret-value for the test')).toBe('please use [redacted-secret] for the test')
  })

  it('redacts editor and patch bodies without depending on a tool name', () => {
    const oldStr = 'const previous = "sensitive source"'
    const newStr = 'const next = "replacement source"'
    const fileText = 'PRIVATE FILE BODY'
    const patch = '@@ -1 +1 @@\n-secret\n+replacement'
    const replacementText = 'camel-case schema body'
    const sanitized = sanitizeClassifierArguments({
      command: 'str_replace',
      path: '/work/repo/src/config.ts',
      old_str: oldStr,
      new_str: newStr,
      nested: { file_text: fileText, patch, replacementText },
    })

    expect(sanitized).toEqual({
      command: 'str_replace',
      path: '/work/repo/src/config.ts',
      old_str: `[redacted-old_str:${oldStr.length}-chars]`,
      new_str: `[redacted-new_str:${newStr.length}-chars]`,
      nested: {
        file_text: `[redacted-file_text:${fileText.length}-chars]`,
        patch: `[redacted-patch:${patch.length}-chars]`,
        replacementText: `[redacted-replacementText:${replacementText.length}-chars]`,
      },
    })
    expect(JSON.stringify(sanitized)).not.toContain('sensitive source')
    expect(JSON.stringify(sanitized)).not.toContain('PRIVATE FILE BODY')
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
