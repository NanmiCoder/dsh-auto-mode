import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Policy result before optional classifier resolution. */
export interface Assessment {
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason: string
  readonly classifierEligible: boolean
  readonly plannedCreates?: readonly string[]
}

/** Independent classifier input; no transcript, tool output, or repository text is included. */
export interface ClassifierInput {
  readonly toolName: string
  readonly arguments: unknown
  readonly workspaceRoot: string
  readonly policyReason: string
}

/** Valid independent classifier result. */
export interface ClassifierDecision {
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason: string
}

/** Classifier interface used by the plugin and tests. */
export interface SafetyClassifier {
  classify(input: ClassifierInput, signal: AbortSignal): Promise<ClassifierDecision>
}

/** Minimum execution fields used by pure policy helpers. */
export type PendingExecution = Pick<ToolExecution, 'name' | 'arguments' | 'agent' | 'token'>
