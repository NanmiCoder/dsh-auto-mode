import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxWideningRequest } from './policy.js'

interface PendingGrant {
  readonly toolName: string
  readonly approvalReason: string
}

function callKey(callId: unknown): string | undefined {
  return callId === undefined ? undefined : String(callId)
}

/**
 * Exact bridge from an Auto classifier allow to the official approval seam.
 * A grant is scoped to the same live Agent, tool name, call id, requested mode,
 * and justification. It is consumed once and never changes session policy.
 */
export class AutoApprovalGrants {
  private readonly byAgent = new WeakMap<object, Map<string, PendingGrant>>()

  plan(exec: Readonly<ToolExecution>, request: SandboxWideningRequest): void {
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
