import { randomUUID } from 'node:crypto'
import {
  ReasoningEffortId,
  type GenerateOptions,
  type LlmFailure,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { CLASSIFIER_SYSTEM_PROMPT, parseClassifierDecision } from './classifier.js'
import type { ClassifierDecision, ClassifierInput, SafetyClassifier } from './types.js'

/**
 * Answer budget for classifier requests.
 *
 * Reasoning tokens share this cap with the answer, and no route can be *proven*
 * to have thinking disabled: `@deepseek-ai/dsh-llm-pi-ai` publishes `off` in its
 * effort list yet translates it into *omitting* the reasoning option, so a
 * provider whose own default is to think keeps thinking with `off` selected. The
 * default is therefore the reasoning ceiling itself. `maxTokens` is a ceiling
 * rather than a reservation, so the headroom is free on a route where thinking
 * really is off, and on one where it is not it is the difference between a
 * truncated answer and a complete one — while a smaller value re-creates the
 * `finish_reason: "length"` denial this module exists to avoid.
 */
export const DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS = 4_096
/** Effort pinned on classifier requests unless configuration overrides it. */
export const DEFAULT_CLASSIFIER_REASONING_EFFORT = 'off'

interface LlmStreamRuntime {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  /**
   * Optional exact-route capability probe. Its answer decides which effort may be
   * pinned on this route: the requested one when offered, otherwise `off` when
   * offered, otherwise none at all. An absent or failing probe still pins the
   * requested effort and relies on the rejected-pin retry, so a stream-only test
   * seam still works.
   */
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

/** Configuration for a classifier that reuses the current Harness LLM route. */
export interface DshClassifierConfig {
  readonly timeoutMs: number
  readonly maxOutputTokens?: number
  /**
   * Effort pinned on classifier requests. The default `off` keeps the classifier
   * from spending the provider's effort on reasoning tokens; an empty string
   * inherits the adapter default instead.
   */
  readonly reasoningEffort?: string
  readonly provider?: string
  readonly model?: string
}

function classifierPayload(input: ClassifierInput): string {
  return JSON.stringify({
    toolName: input.toolName,
    arguments: input.arguments,
    workspaceRoot: input.workspaceRoot,
    policyReason: input.policyReason,
    trustedUserMessages: input.trustedUserMessages,
    filesystemEffects: input.filesystemEffects,
    sandboxRequest: input.sandboxRequest,
  })
}

function classifierMessage(input: ClassifierInput): Message {
  return Object.freeze({
    id: `auto-mode-classifier-${randomUUID()}` as Message['id'],
    role: 'user' as const,
    content: [{ type: 'text' as const, text: classifierPayload(input) }],
    source: { kind: 'plugin' as const, plugin: '@nanmicoder/dsh-auto-mode' },
  })
}

function jsonText(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return fenced?.[1]?.trim() ?? trimmed
}

/**
 * Rebuild an adapter failure as an Error, keeping every diagnostic field.
 *
 * `code` routes the rejected-pin retry; `status` and `requestId` are what let an
 * operator correlate a provider failure with provider-side logs, so dropping them
 * here would lose the only handle on a real incident.
 */
function finishFailureError(failure: LlmFailure): Error {
  return Object.assign(new Error(failure.message), failure)
}

/** Diagnostics an adapter failure can carry that are worth preserving on a rebuild. */
const FAILURE_DIAGNOSTIC_FIELDS = ['code', 'failure', 'status', 'providerRetryAfterMs', 'requestId'] as const

/**
 * Carry an adapter failure's own diagnostics onto a rebuilt error.
 *
 * An explicit allow-list rather than spreading the source: a spread would also
 * copy `name`, leaving a plain `Error` that claims to be an `LlmError` without
 * being one.
 */
function carryFailureDiagnostics(target: Error, source: unknown): Error {
  if (source === null || typeof source !== 'object') return target
  const fields = source as Record<string, unknown>
  const carried = target as unknown as Record<string, unknown>
  for (const field of FAILURE_DIAGNOSTIC_FIELDS) {
    if (fields[field] !== undefined) carried[field] = fields[field]
  }
  return target
}

interface CollectedResponse {
  readonly text: string
  readonly finish: Extract<StreamChunk, { type: 'finish' }>['reason']
}

async function collectResponse(runtime: LlmStreamRuntime, options: GenerateOptions): Promise<CollectedResponse> {
  const textByIndex = new Map<number, string>()
  let finish: CollectedResponse['finish'] | undefined
  let size = 0
  for await (const chunk of runtime.stream(options)) {
    if (chunk.type === 'text-delta') {
      const value = (textByIndex.get(chunk.index) ?? '') + chunk.text
      textByIndex.set(chunk.index, value)
      size += chunk.text.length
    } else if (chunk.type === 'block-end') {
      if (chunk.block.type === 'tool-call') throw new Error('classifier unexpectedly requested a tool')
      if (chunk.block.type === 'text') {
        textByIndex.set(chunk.index, chunk.block.text)
        size = [...textByIndex.values()].reduce((total, value) => total + value.length, 0)
      }
    } else if (chunk.type === 'tool-call-delta') {
      throw new Error('classifier unexpectedly requested a tool')
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
    if (size > 20_000) throw new Error('classifier response is too large')
  }
  if (finish === undefined) throw new Error('classifier response has no finish reason')
  return {
    text: [...textByIndex.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join(''),
    finish,
  }
}

/**
 * Turn one collected response into a decision, or throw the fail-closed reason.
 *
 * A truncated response is never partially trusted. A `max-tokens` finish is
 * refused before the text is even parsed, because the only way to recover a
 * decision from a partial answer is to guess whether the model concluded it or
 * merely quoted text that arrived as untrusted input, and no provenance signal
 * exists to tell those apart. Refusing the whole response keeps the classifier's
 * failure mode a denial, which is what the policy already does with every other
 * malformed answer.
 */
function decisionFromResponse(response: CollectedResponse): ClassifierDecision {
  const { finish, text } = response
  if (finish.kind === 'error' || finish.kind === 'aborted') throw finishFailureError(finish.failure)
  if (finish.kind === 'tool-calls') throw new Error('classifier unexpectedly requested a tool')
  if (finish.kind === 'max-tokens') throw new Error('classifier response reached its output limit')
  // `FinishReasonMap` is merge-extensible, so allow-list the one kind that means
  // the model finished its answer. An unmodelled kind is not a licence to parse.
  if (finish.kind !== 'stop') {
    throw new Error(`classifier response stopped for an unsupported reason: ${String((finish as { kind: string }).kind)}`)
  }
  return parseClassifierDecision(JSON.parse(jsonText(text)))
}

function isUnsupportedEffort(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'UNSUPPORTED_REASONING_EFFORT'
}

interface EffortPlan {
  /** Effort to send, or undefined to inherit the adapter default. */
  readonly effort?: string
  /** A capability probe that threw, kept so a later failure can name its cause. */
  readonly probeFailure?: unknown
}

/**
 * Decide which effort to pin on this exact route.
 *
 * Harness `resolveCallWithInfo` (reached through `LlmService.adapterStream`)
 * materializes the adapter's advertised `defaultEffort` whenever a caller omits
 * one, and the DeepSeek adapter advertises `high`. Reasoning then shares the
 * output cap with the answer, which is what truncated a classifier call to
 * `finish_reason: "length"` and failed closed. Pinning `off` puts
 * `thinking: { type: "disabled" }` on the wire on adapters that honor it, which
 * keeps the classifier fast and cheap.
 *
 * The cap is *not* lowered to match: the same `off` means something different on
 * `@deepseek-ai/dsh-llm-pi-ai`, which publishes `off` in its effort list yet
 * translates it into *omitting* the reasoning option — its own documentation
 * warns that a provider whose default is to think keeps thinking with `off`
 * selected. No field of `LlmResolvedModelInfo` distinguishes the two meanings, so
 * no route can be proven to have thinking disabled and the answer budget stays at
 * the ceiling (see `DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS`).
 */
async function planReasoningEffort(
  runtime: LlmStreamRuntime,
  provider: string,
  model: string,
  requested: string | undefined,
  signal: AbortSignal,
): Promise<EffortPlan> {
  const inherit = requested === undefined || requested === ''
  let info: LlmResolvedModelInfo | undefined
  let probeFailure: unknown
  if (runtime.resolveModelInfo !== undefined) {
    try {
      info = await runtime.resolveModelInfo(provider, model, signal)
    } catch (error: unknown) {
      // The probe is advisory: an unknown route still gets the pin, and an adapter
      // that rejects it is retried without the pin. The failure is kept so a later
      // classifier error can name it instead of surfacing as an unrelated symptom.
      probeFailure = error
    }
  }
  const reasoning = info?.reasoning
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
  const withProbe = (plan: EffortPlan): EffortPlan => probeFailure === undefined ? plan : { ...plan, probeFailure }

  if (inherit) {
    // An inherited effort sends nothing, so the adapter's own default applies.
    return withProbe({})
  }
  if (info === undefined) {
    // No probe available, or it failed: keep the pin and rely on the rejected-pin retry.
    return withProbe({ effort: requested })
  }
  // No usable reasoning metadata: the route rejects every explicit effort, so
  // nothing can be pinned.
  if (reasoning === undefined || efforts.length === 0) return withProbe({})
  if (efforts.some(entry => entry.id === requested)) return withProbe({ effort: requested })
  const off = efforts.find(entry => entry.id === DEFAULT_CLASSIFIER_REASONING_EFFORT)
  // Fall back to `off` rather than failing every classification on a route that
  // does not offer the configured effort; a route offering neither sends nothing.
  return withProbe(off === undefined ? {} : { effort: off.id })
}

/** Reuse `ctx.llm` for an independent, low-token classifier request. */
export function createDshClassifier(runtime: LlmStreamRuntime, config: DshClassifierConfig): SafetyClassifier {
  const overridePair = config.provider !== undefined || config.model !== undefined
  if (overridePair && (config.provider === undefined || config.model === undefined)) {
    throw new Error('classifierProvider and classifierModel must be configured together')
  }
  const reasoningEffort = config.reasoningEffort?.trim()
  // A typo here is not inert: it is coerced to `off` on one route and dropped on
  // another, so both look like a working configuration. Reject it at the seam.
  if (reasoningEffort !== undefined && reasoningEffort !== '' && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(reasoningEffort)) {
    throw new Error('classifierReasoningEffort must be an adapter effort id such as "off", or an empty string to inherit the adapter default')
  }
  return {
    async classify(input: ClassifierInput, signal: AbortSignal): Promise<ClassifierDecision> {
      const route = config.provider === undefined
        ? input.route
        : { provider: config.provider, model: config.model as string }
      if (route === undefined || route.provider === '' || route.model === '') {
        throw new Error('current session has no provider/model route for classification')
      }
      const timeout = AbortSignal.timeout(config.timeoutMs)
      const combined = AbortSignal.any([signal, timeout])
      const cap = config.maxOutputTokens ?? DEFAULT_CLASSIFIER_MAX_OUTPUT_TOKENS
      const buildOptions = (effort: string | undefined): GenerateOptions => ({
        provider: route.provider,
        model: route.model,
        messages: [classifierMessage(input)],
        system: CLASSIFIER_SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: cap,
        signal: combined,
        ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      })
      let probeFailure: unknown
      try {
        // The probe runs inside this try so a cancellation or timeout it observes is
        // still translated to the caller-facing wording. Its own metadata failures
        // are advisory and fall back to the pin — see `planReasoningEffort`.
        const plan = await planReasoningEffort(
          runtime, route.provider, route.model, reasoningEffort ?? DEFAULT_CLASSIFIER_REASONING_EFFORT, combined,
        )
        probeFailure = plan.probeFailure
        try {
          return decisionFromResponse(await collectResponse(runtime, buildOptions(plan.effort)))
        } catch (error: unknown) {
          // The route refused the pin (an unverifiable probe, or an adapter whose
          // metadata disagrees). One retry without it still classifies instead of
          // failing closed for every call on that route.
          if (plan.effort === undefined || !isUnsupportedEffort(error)) throw error
          return decisionFromResponse(await collectResponse(runtime, buildOptions(undefined)))
        }
      } catch (error: unknown) {
        if (signal.aborted) {
          throw new Error('classifier request cancelled because the pending tool call was aborted', { cause: error })
        }
        if (timeout.aborted) {
          throw new Error(`classifier timed out after ${config.timeoutMs}ms`, { cause: error })
        }
        if (probeFailure === undefined) throw error
        // A failing capability probe would otherwise be reported as the symptom of
        // whatever the attempt did next. The wrapper keeps the original error's own
        // diagnostics, so the `code`/`status`/`requestId` correlation a plain rethrow
        // preserved is still available alongside the probe's cause.
        const message = error instanceof Error ? error.message : String(error)
        throw carryFailureDiagnostics(new Error(message, { cause: { probeFailure, error } }), error)
      }
    },
  }
}
