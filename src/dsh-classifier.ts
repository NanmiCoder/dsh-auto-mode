import { randomUUID } from 'node:crypto'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CLASSIFIER_SYSTEM_PROMPT, parseClassifierDecision } from './classifier.js'
import type { ClassifierDecision, ClassifierInput, SafetyClassifier } from './types.js'

interface LlmStreamRuntime {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Configuration for a classifier that reuses the current Harness LLM route. */
export interface DshClassifierConfig {
  readonly timeoutMs: number
  readonly maxOutputTokens?: number
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

async function collectResponse(runtime: LlmStreamRuntime, options: GenerateOptions): Promise<string> {
  const textByIndex = new Map<number, string>()
  let finish: Extract<StreamChunk, { type: 'finish' }>['reason'] | undefined
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
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
  if (finish.kind === 'max-tokens') throw new Error('classifier response reached its output limit')
  if (finish.kind === 'tool-calls') throw new Error('classifier unexpectedly requested a tool')
  return [...textByIndex.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join('')
}

/** Reuse `ctx.llm` for an independent, low-token classifier request. */
export function createDshClassifier(runtime: LlmStreamRuntime, config: DshClassifierConfig): SafetyClassifier {
  const overridePair = config.provider !== undefined || config.model !== undefined
  if (overridePair && (config.provider === undefined || config.model === undefined)) {
    throw new Error('classifierProvider and classifierModel must be configured together')
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
      const options: GenerateOptions = {
        provider: route.provider,
        model: route.model,
        messages: [classifierMessage(input)],
        system: CLASSIFIER_SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: config.maxOutputTokens ?? 256,
        signal: combined,
      }
      const response = await collectResponse(runtime, options)
      return parseClassifierDecision(JSON.parse(jsonText(response)))
    },
  }
}
