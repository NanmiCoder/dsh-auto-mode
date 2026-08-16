import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** High-confidence literal filesystem effect observed before execution. */
export interface FilesystemEffect {
  readonly kind: 'create-or-overwrite' | 'delete'
  readonly path: string
  readonly existedBefore: boolean
}

/** Policy result before optional classifier resolution. */
export interface Assessment {
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly reason: string
  readonly classifierEligible: boolean
  readonly plannedCreates?: readonly string[]
  readonly filesystemEffects?: readonly FilesystemEffect[]
}

/** Independent classifier input; no transcript, tool output, or repository text is included. */
export interface ClassifierInput {
  readonly toolName: string
  readonly arguments: unknown
  readonly workspaceRoot: string
  readonly policyReason: string
  /** Recent direct-human messages; repository, tool, plugin, and subagent text is excluded. */
  readonly trustedUserMessages: readonly string[]
  /** Literal pre-execution facts; omitted when the target cannot be resolved safely. */
  readonly filesystemEffects?: readonly FilesystemEffect[]
  /** Exact one-shot sandbox widening requested by the pending call, when present. */
  readonly sandboxRequest?: {
    readonly currentMode: 'workspace-write'
    readonly requestedMode: string
    readonly justification: string
    readonly platform: NodeJS.Platform
  }
  /** Current Harness route, used by the native classifier and ignored by external HTTP classifiers. */
  readonly route?: {
    readonly provider: string
    readonly model: string
  }
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
