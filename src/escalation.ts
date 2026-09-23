import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxEscalationRequest } from './policy.js'

interface PendingGrant {
  readonly toolName: string
  readonly approvalReason: string
}

function callKey(callId: unknown): string | undefined {
  return callId === undefined ? undefined : String(callId)
}

/**
 * Exact bridge from an Auto decision that has authorized this call — a classifier
 * `allow`, or a human approval the plugin raised itself — to the official approval
 * seam. A grant is scoped to the same live Agent, tool name, call id, requested
 * mode, and justification. It is consumed once and never changes session policy.
 */
export class AutoApprovalGrants {
  private readonly byAgent = new WeakMap<object, Map<string, PendingGrant>>()

  plan(exec: Readonly<ToolExecution>, request: SandboxEscalationRequest): void {
    const agent = exec.agent
    const key = callKey(exec.callId)
    if (agent === undefined || key === undefined) return
    let calls = this.byAgent.get(agent)
    if (calls === undefined) {
      calls = new Map()
      this.byAgent.set(agent, calls)
    }
    calls.set(key, {
      toolName: exec.name,
      approvalReason: `escalate sandbox to ${request.requestedMode}: ${request.justification}`,
    })
  }

  /** Consume an exact planned grant, or leave unrelated approval requests untouched. */
  decide(request: ApprovalRequest): ApprovalOutcome | undefined {
    const key = callKey(request.callId)
    if (key === undefined) return undefined
    const calls = this.byAgent.get(request.agent)
    const pending = calls?.get(key)
    if (pending === undefined
      || pending.toolName !== request.toolName
      || pending.approvalReason !== request.reason) return undefined
    calls?.delete(key)
    if (calls?.size === 0) this.byAgent.delete(request.agent)
    return 'allowed-once'
  }

  /** Drop an unused grant when the tool settles before reaching the approval seam. */
  settle(exec: Readonly<ToolExecution>): void {
    const agent = exec.agent
    const key = callKey(exec.callId)
    if (agent === undefined || key === undefined) return
    const calls = this.byAgent.get(agent)
    calls?.delete(key)
    if (calls?.size === 0) this.byAgent.delete(agent)
  }
}

/**
 * Refusal classes that owe the Agent recovery guidance.
 *
 * `authority` needs authority the Agent does not hold, `escalation` is a refused
 * one-shot escalation and must not be repeated, `delegated` is a subagent whose
 * widening is impossible by construction, `hard` is monotonic, and `redundant` is
 * a repeated standing sandbox request that needs the fields removed.
 */
export type AutoRefusalClass = 'authority' | 'escalation' | 'delegated' | 'hard' | 'redundant'

/**
 * Refusals recorded by the decision that produced them, keyed to the live call.
 *
 * Guidance is attached from this record instead of being parsed back out of the
 * tool's error text. A tool result is untrusted data, so a tool that returns its
 * own `[auto-mode ...]`-looking error must not be able to make the trusted plugin
 * inject a notice claiming that a call did not execute.
 */
export class AutoRefusalNotices {
  private readonly byAgent = new WeakMap<object, Map<string, AutoRefusalClass>>()

  record(exec: Readonly<ToolExecution>, refusalClass: AutoRefusalClass): void {
    const agent = exec.agent
    const key = callKey(exec.callId)
    if (agent === undefined || key === undefined) return
    let calls = this.byAgent.get(agent)
    if (calls === undefined) {
      calls = new Map()
      this.byAgent.set(agent, calls)
    }
    calls.set(key, refusalClass)
  }

  /** Consume the record for one settled call, if the plugin refused it. */
  consume(exec: Readonly<ToolExecution>): AutoRefusalClass | undefined {
    const agent = exec.agent
    const key = callKey(exec.callId)
    if (agent === undefined || key === undefined) return undefined
    const calls = this.byAgent.get(agent)
    const refusalClass = calls?.get(key)
    this.settle(exec)
    return refusalClass
  }

  /** Retire a record without reading it, for a call that settled elsewhere. */
  settle(exec: Readonly<ToolExecution>): void {
    const agent = exec.agent
    const key = callKey(exec.callId)
    if (agent === undefined || key === undefined) return
    const calls = this.byAgent.get(agent)
    calls?.delete(key)
    if (calls?.size === 0) this.byAgent.delete(agent)
  }
}
