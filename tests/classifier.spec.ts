import { describe, expect, it, vi } from 'vitest'
import { LlmError, ProviderRequestId, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CLASSIFIER_SYSTEM_PROMPT, createHttpClassifier, parseClassifierDecision, sanitizeClassifierArguments, sanitizeClassifierText } from '../src/classifier.js'
import { DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS, createDshClassifier } from '../src/dsh-classifier.js'

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
  it('redacts credential families in arbitrary fields while retaining bulk-content privacy', () => {
    const values = ['AKIA' + 'A'.repeat(16), 'ASIA' + 'B'.repeat(16), 'gho_' + 'C'.repeat(36), 'ghu_' + 'D'.repeat(36), '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----']
    for (const credential of values) {
      const result = JSON.stringify(sanitizeClassifierArguments({ nested: { value: credential } }))
      expect(result).not.toContain(credential)
      expect(result).toContain('redacted')
    }
    expect(JSON.stringify(sanitizeClassifierArguments({ file_text: 'private project source', input: '*** Begin Patch\nprivate source\n*** End Patch' }))).not.toContain('private')
  })
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
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      temperature: 0,
      maxTokens: DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS,
      // The pin is what stops the adapter's advertised `high` defaultEffort from
      // spending the provider's effort on reasoning tokens.
      reasoningEffort: 'off',
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

  it('rejects an effort spelling that cannot be an adapter effort id', () => {
    const runtime = { stream: vi.fn() as unknown as (options: GenerateOptions) => AsyncIterable<StreamChunk> }
    // Effort ids are adapter-owned and opaque, so the factory cannot tell an
    // unknown id from a legitimate one; it can and does reject a spelling no
    // adapter could publish, which would otherwise be coerced or dropped silently.
    for (const malformed of ['not an effort', 'off!', '.*']) {
      expect(() => createDshClassifier(runtime, { timeoutMs: 1_000, reasoningEffort: malformed }))
        .toThrow(/classifierReasoningEffort/)
    }
    // The documented "inherit" spelling and a padded id stay legal.
    expect(() => createDshClassifier(runtime, { timeoutMs: 1_000, reasoningEffort: '' })).not.toThrow()
    expect(() => createDshClassifier(runtime, { timeoutMs: 1_000, reasoningEffort: '  off  ' })).not.toThrow()
  })
})

type FinishReason = Extract<StreamChunk, { type: 'finish' }>['reason']

/** A route with reasoning metadata, shaped exactly like `LlmResolvedModelInfo`. */
function reasoningInfo(
  efforts: readonly string[],
  defaultEffort?: string,
): LlmResolvedModelInfo {
  return {
    provider: 'deepseek-official',
    id: 'deepseek-v4-flash',
    name: 'deepseek-v4-flash',
    inputModalities: ['text'],
    reasoning: {
      efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
      ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
    },
  } satisfies LlmResolvedModelInfo
}

/** A route that advertises no reasoning support at all. */
const NON_REASONING_ROUTE = {
  provider: 'deepseek-official',
  id: 'deepseek-v4-flash',
  name: 'deepseek-v4-flash',
  inputModalities: ['text'],
} satisfies LlmResolvedModelInfo

interface RuntimeOptions {
  /** Absent omits the capability probe; null advertises no reasoning; a list advertises those efforts. */
  readonly efforts?: readonly string[] | null
  /** Effort the adapter applies when the caller omits one; only reachable via inherit. */
  readonly defaultEffort?: string
  /** Makes the capability probe reject, exercising the advisory fallback. */
  readonly failProbe?: boolean
  readonly answer: string
  readonly finish?: FinishReason
  readonly rejectFirstEffort?: boolean
}

/** Runtime that records every request and answers with one scripted response. */
function recordingRuntime(options: RuntimeOptions) {
  const requests: GenerateOptions[] = []
  const probe = options.efforts === undefined
    ? {}
    : {
        resolveModelInfo: async () => {
          if (options.failProbe === true) throw new Error('INVALID_MODEL_REASONING: malformed adapter metadata')
          return options.efforts === null
            ? NON_REASONING_ROUTE
            : reasoningInfo(options.efforts, options.defaultEffort)
        },
      }
  const runtime = {
    ...probe,
    stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(request)
      const rejectPin = options.rejectFirstEffort === true && requests.length === 1
      const { answer } = options
      const finish: FinishReason = options.finish ?? { kind: 'stop' }
      return (async function* () {
        if (rejectPin) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'DeepSeek does not support reasoning effort "off"', code: 'UNSUPPORTED_REASONING_EFFORT' },
            },
          } as const
          return
        }
        yield { type: 'text-delta', index: 0, text: answer } as const
        yield { type: 'finish', reason: finish } as const
      })()
    },
  }
  return { runtime, requests }
}

/**
 * The reported failure was `finish_reason: "length"` on every classifier call,
 * because the adapter materializes its advertised `high` defaultEffort whenever
 * the caller omits one and reasoning tokens then consume the whole answer budget.
 * These cases pin the effort selection, the answer cap, and the retry.
 */
describe('native classifier reasoning budget', () => {
  it('pins off on a route that advertises the off effort', async () => {
    const { runtime, requests } = recordingRuntime({
      efforts: ['off', 'low', 'high', 'max'],
      answer: '{"decision":"allow","reason":"routine"}',
    })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.reasoningEffort).toBe('off')
    expect(requests[0]?.maxTokens).toBe(DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS)
  })

  it('sends no effort on a route that advertises no reasoning support', async () => {
    const { runtime, requests } = recordingRuntime({ efforts: null, answer: '{"decision":"allow","reason":"routine"}' })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    // An explicit effort would be rejected with UNSUPPORTED_REASONING_EFFORT, so
    // nothing is sent.
    expect(requests[0]).not.toHaveProperty('reasoningEffort')
    expect(requests[0]?.maxTokens).toBe(DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS)
  })

  it('sends no effort when an adapter publishes an empty effort list', async () => {
    // Defensive: the real `normalizeModelInfo` rejects an empty list outright, so
    // this only guards the planner against a hand-built seam.
    const { runtime, requests } = recordingRuntime({ efforts: [], answer: '{"decision":"allow","reason":"routine"}' })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests[0]).not.toHaveProperty('reasoningEffort')
  })

  it('sends the configured effort when the route offers it', async () => {
    const { runtime, requests } = recordingRuntime({
      efforts: ['off', 'low', 'high'],
      answer: '{"decision":"allow","reason":"routine"}',
    })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000, reasoningEffort: 'high' })
      .classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests[0]?.reasoningEffort).toBe('high')
    expect(requests[0]?.maxTokens).toBe(DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS)
  })

  it('falls back to off when the route does not offer the configured effort', async () => {
    const { runtime, requests } = recordingRuntime({
      efforts: ['off', 'low', 'high'],
      answer: '{"decision":"allow","reason":"routine"}',
    })
    // An unavailable id must not fail every classification on the route.
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000, reasoningEffort: 'max' })
      .classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests[0]?.reasoningEffort).toBe('off')
  })

  it('sends no effort when the route offers neither the configured effort nor off', async () => {
    const { runtime, requests } = recordingRuntime({ efforts: ['low', 'high'], answer: '{"decision":"allow","reason":"routine"}' })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests[0]).not.toHaveProperty('reasoningEffort')
  })

  it('inherits the adapter default when the configured effort is empty', async () => {
    const { runtime, requests } = recordingRuntime({
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
      answer: '{"decision":"allow","reason":"routine"}',
    })
    // The documented "inherit" spelling sends nothing, whatever the adapter would
    // apply instead — including the `high` that caused the reported truncation.
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000, reasoningEffort: '' })
      .classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests[0]).not.toHaveProperty('reasoningEffort')
    expect(requests[0]?.maxTokens).toBe(DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS)
  })

  it('uses an operator cap below the ceiling verbatim', async () => {
    const { runtime, requests } = recordingRuntime({ efforts: ['off', 'high'], answer: '{"decision":"allow","reason":"routine"}' })
    // No route can be proven to have thinking disabled, so a smaller cap is the
    // operator's own choice to risk the truncation denial. It is still honoured.
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000, maxOutputTokens: 512 })
      .classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests[0]?.maxTokens).toBe(512)
  })

  it('retries once without the pin when the adapter rejects it', async () => {
    const { runtime, requests } = recordingRuntime({
      efforts: ['off', 'high'],
      answer: '{"decision":"allow","reason":"routine"}',
      rejectFirstEffort: true,
    })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.reasoningEffort).toBe('off')
    expect(requests[1]).not.toHaveProperty('reasoningEffort')
    // The retry inherits the adapter default, and the cap is unchanged either way.
    expect(requests[1]?.maxTokens).toBe(DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS)
  })

  it('does not retry an ordinary provider failure', async () => {
    const { runtime, requests } = recordingRuntime({
      efforts: ['off', 'high'],
      answer: '',
      finish: { kind: 'error', failure: { message: 'provider offline', code: 'OFFLINE' } },
    })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .rejects.toThrow('provider offline')
    // Only UNSUPPORTED_REASONING_EFFORT justifies a second request.
    expect(requests).toHaveLength(1)
  })

  it('keeps the pin and recovers when the capability probe fails', async () => {
    const { runtime, requests } = recordingRuntime({
      efforts: ['off', 'high'],
      failProbe: true,
      answer: '{"decision":"allow","reason":"routine"}',
      rejectFirstEffort: true,
    })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason: 'routine' })
    // An advisory probe failure must not stop the pin, and the pin is still retried.
    expect(requests).toHaveLength(2)
    expect(requests[0]?.reasoningEffort).toBe('off')
    expect(requests[1]).not.toHaveProperty('reasoningEffort')
  })

  it('names a probe failure as the cause of a later classifier failure', async () => {
    const { runtime } = recordingRuntime({
      efforts: ['off', 'high'],
      failProbe: true,
      answer: '',
      finish: { kind: 'error', failure: { message: 'provider offline', code: 'OFFLINE' } },
    })
    // A failing probe would otherwise be reported as the symptom of whatever the
    // attempt did next, which is the classic six-months-later debugging shape. The
    // original error's own routing code survives the wrapper.
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .rejects.toMatchObject({ code: 'OFFLINE', cause: { probeFailure: expect.any(Error) } })
  })

  it('keeps a provider failure status and request id through the probe-failure wrapper', async () => {
    const { runtime } = recordingRuntime({
      efforts: ['off', 'high'],
      // The wrapper only runs when the probe failed; without this the original error
      // is rethrown untouched and the assertion below would not exercise it.
      failProbe: true,
      answer: '',
      finish: {
        kind: 'error',
        failure: {
          message: 'provider overloaded',
          code: 'RATE_LIMIT',
          status: 503,
          requestId: ProviderRequestId('req-1'),
        },
      },
    })
    // These are the only handles an operator has for correlating the failure with
    // provider-side logs, so rebuilding the error must not drop them.
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .rejects.toMatchObject({
        message: 'provider overloaded',
        code: 'RATE_LIMIT',
        status: 503,
        requestId: 'req-1',
        cause: { probeFailure: expect.any(Error) },
      })
  })

  it('keeps an adapter failure record without pretending to be that error class', async () => {
    const failure = {
      message: 'provider overloaded',
      code: 'RATE_LIMIT',
      status: 503,
      requestId: ProviderRequestId('req-2'),
    }
    const runtime = {
      resolveModelInfo: async () => { throw new Error('INVALID_MODEL_REASONING: malformed adapter metadata') },
      // The real adapter throws a typed `LlmError`, whose own enumerable `failure`
      // record carries the validated provider facts.
      stream(): AsyncIterable<StreamChunk> {
        return (async function* () {
          throw new LlmError(failure.message, failure.code, {
            status: failure.status,
            requestId: failure.requestId,
          })
        })()
      },
    }
    const rejection = await createDshClassifier(runtime, { timeoutMs: 1_000 })
      .classify(input, new AbortController().signal).catch((error: unknown) => error)
    const wrapped = rejection as Error & { code?: unknown; failure?: unknown }
    expect(wrapped.message).toBe('provider overloaded')
    expect(wrapped.code).toBe('RATE_LIMIT')
    // `status` and `requestId` live inside the adapter's own `failure` record; the
    // wrapper must carry that whole record rather than only the routing code.
    expect(wrapped.failure).toEqual(failure)
    // The wrapper is a plain Error, not a counterfeit `LlmError`: a consumer that
    // switches on the class must not be fooled by a copied `name`.
    expect(rejection).not.toBeInstanceOf(LlmError)
    expect(wrapped.name).toBe('Error')
  })

  it('refuses a truncated response even when it contains a complete object', async () => {
    // Recovering a decision from a partial answer cannot separate the model's own
    // conclusion from text it merely quoted out of untrusted input, and no
    // provenance signal exists to tell those apart. A max-tokens finish therefore
    // stays the fail-closed denial it has always been.
    const { runtime } = recordingRuntime({
      efforts: ['low', 'high'],
      answer: '{"decision":"allow","reason":"reads a project file"}\nand the rest was cut off',
      finish: { kind: 'max-tokens' },
    })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .rejects.toThrow('classifier response reached its output limit')
  })

  it('refuses a response that is not exactly one object', async () => {
    const { runtime } = recordingRuntime({
      efforts: null,
      answer: 'The call is routine.\n{"decision":"allow","reason":"routine"}\n',
    })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .rejects.toThrow(/JSON/)
  })

  it('parses a reason that contains a brace and an escaped quote', async () => {
    const reason = 'a"}'
    const { runtime } = recordingRuntime({ efforts: null, answer: JSON.stringify({ decision: 'allow', reason }) })
    await expect(createDshClassifier(runtime, { timeoutMs: 1_000 }).classify(input, new AbortController().signal))
      .resolves.toEqual({ decision: 'allow', reason })
  })
})
