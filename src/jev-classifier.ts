import { CLASSIFIER_SYSTEM_PROMPT } from './classifier.js'
import type { ClassifierDecision, ClassifierInput, SafetyClassifier } from './types.js'

export type JevProvider = 'typesafe' | 'openrouter' | 'vercel'

/** Verified System One endpoints; no chat-completions translation is involved. */
export const JEV_PROVIDERS = {
  typesafe: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY' },
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'typesafe/jev-1.13', apiKeyEnv: 'OPENROUTER_API_KEY' },
  vercel: { endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev', apiKeyEnv: 'AI_GATEWAY_API_KEY' },
} as const

export interface JevClassifierConfig {
  readonly provider: JevProvider
  readonly apiKey: string
  readonly model?: string
  readonly endpoint?: string
  readonly timeoutMs: number
  /** Conservative starting gate, not a calibrated security guarantee. */
  readonly minAllowProbability?: number
  readonly fetchImpl?: typeof fetch
}

const decisions = ['allow', 'ask', 'deny'] as const
const policy = CLASSIFIER_SYSTEM_PROMPT.split('\n').filter(line => !line.startsWith('Return exactly one JSON object')).join('\n')

export function buildJevRequest(input: ClassifierInput, model: string) {
  const { route: _route, ...state } = input
  return {
    model,
    state,
    questions: {
      permission: {
        type: 'choice',
        instructions: policy,
        criteria: {
          allow: 'The concrete operation is permitted by the policy and the trusted user authority. Routine reversible workspace development is allowed.',
          ask: 'A genuine unresolved user choice remains after the narrower safe plan. A protected effect lacking authority or a hidden widening target is deny, not ask.',
          deny: 'The concrete operation violates the policy, has a protected effect without specific user authority, or attempts credential exfiltration or permission bypass.',
        },
      },
    },
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid Jev response object')
  return value as Record<string, unknown>
}

function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('invalid Jev probability')
  return value
}

export function parseJevDecision(value: unknown, minAllowProbability: number): ClassifierDecision {
  const answer = object(object(object(value).answers).permission)
  if (answer.type !== 'choice' || !decisions.includes(answer.choice as typeof decisions[number])) throw new Error('invalid Jev permission choice')
  const choice = answer.choice as typeof decisions[number]
  const probabilities = object(answer.probabilities)
  if (Object.keys(probabilities).length !== decisions.length) throw new Error('invalid Jev probability keys')
  const values = decisions.map(key => probability(probabilities[key]))
  const sum = values.reduce((a, b) => a + b, 0)
  // Live providers round each of the three probabilities to two decimals.
  // Three half-unit rounding errors can total 0.015; reject larger drift.
  if (Math.abs(sum - 1) > 0.015 + 1e-9) throw new Error('invalid Jev probability sum')
  const selected = probability(probabilities[choice])
  if (values.some(p => p > selected + 1e-6)) throw new Error('Jev choice contradicts probabilities')
  probability(answer.confidence)
  // Never inflate allow confidence when rounded probabilities sum below one.
  const allowProbability = selected / Math.max(1, sum)
  // Reasons are host-authored summaries: Jev does not generate explanations.
  if (choice === 'allow' && allowProbability < minAllowProbability) {
    return { decision: 'ask', reason: `Jev allow probability ${allowProbability.toFixed(4)} is below ${minAllowProbability}; manual review required (host summary)` }
  }
  return { decision: choice, reason: `Jev selected ${choice}, probability ${selected.toFixed(4)} (host summary)` }
}

/** Fail loud: the existing permission middleware owns fail-closed recovery. */
export function createJevClassifier(config: JevClassifierConfig): SafetyClassifier {
  const defaults = JEV_PROVIDERS[config.provider]
  if (!defaults) throw new Error('unsupported Jev provider')
  if (!config.apiKey?.trim()) throw new Error('Jev API key is missing')
  const threshold = config.minAllowProbability ?? 0.9
  probability(threshold)
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60_000) throw new Error('invalid Jev timeout')
  let endpoint: URL
  try { endpoint = new URL(config.endpoint ?? defaults.endpoint) }
  catch { throw new Error('invalid Jev endpoint') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))) throw new Error('invalid Jev endpoint')
  const model = config.model ?? defaults.model
  if (!model.trim()) throw new Error('Jev model must not be empty')
  return {
    async classify(input, signal) {
      const timeout = AbortSignal.timeout(config.timeoutMs)
      const combined = AbortSignal.any([signal, timeout])
      try {
        combined.throwIfAborted()
        const response = await (config.fetchImpl ?? fetch)(endpoint.href, {
          method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(buildJevRequest(input, model)), signal: combined,
        })
        if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
        const reader = response.body?.getReader()
        if (!reader) throw new Error('empty Jev response')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 20_000) throw new Error('Jev response is too large')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => {}) }
        combined.throwIfAborted()
        return parseJevDecision(JSON.parse(Buffer.concat(chunks).toString('utf8')), threshold)
      } catch (error) {
        if (signal.aborted) throw new Error('Jev classifier request cancelled')
        if (timeout.aborted) throw new Error(`Jev classifier timed out after ${config.timeoutMs}ms`)
        // Do not forward remote response bodies, URLs, credentials or fetch causes.
        if (error instanceof Error && /^(invalid Jev|Jev (HTTP|response|choice)|empty Jev)/.test(error.message)) throw error
        throw new Error('Jev classifier request failed')
      }
    },
  }
}
