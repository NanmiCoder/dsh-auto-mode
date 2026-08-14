import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { isAutoOrDelegatedPermissionExecution, isAutoPermissionExecution } from '../src/index.js'

function execution(...presets: string[]): ToolExecution {
  return {
    name: 'bash',
    token: Symbol('mode'),
    agent: {
      session: {
        events: presets.map(preset => ({ type: 'permission/preset', data: { preset } })),
      },
    },
  } as unknown as ToolExecution
}

function child(parentSession: string, ...presets: string[]): ToolExecution {
  return {
    name: 'bash',
    token: Symbol('child'),
    agent: {
      session: {
        header: { origin: 'subagent', parentSession },
        events: [
          { type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
          { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
          ...presets.map(preset => ({ type: 'permission/preset', data: { preset } })),
        ],
      },
    },
  } as unknown as ToolExecution
}

describe('Auto permission activation', () => {
  it('activates only for the session current preset', () => {
    expect(isAutoPermissionExecution(execution('auto'))).toBe(true)
    expect(isAutoPermissionExecution(execution('auto', 'danger-full-access'))).toBe(false)
    expect(isAutoPermissionExecution(execution('danger-full-access', 'auto'))).toBe(true)
    expect(isAutoPermissionExecution(execution('workspace-write'))).toBe(false)
    expect(isAutoPermissionExecution({ name: 'bash', token: Symbol('mode') } as ToolExecution)).toBe(false)
  })

  it('supports a deployment-specific preset key', () => {
    expect(isAutoPermissionExecution(execution('guarded'), 'guarded')).toBe(true)
    expect(isAutoPermissionExecution(execution('auto'), 'guarded')).toBe(false)
  })

  it('inherits Auto through official subagent lineage only', () => {
    const autoParent = execution('auto').agent
    const fullParent = execution('danger-full-access').agent
    const lookup = (id: string) => id === 'auto-parent' ? autoParent : id === 'full-parent' ? fullParent : undefined
    // This is the real persisted shape of an AgentTeams/Workflow spawn child:
    // DSH pins its knobs to full-access + never while Auto remains authority
    // from the direct live parent.
    expect(isAutoPermissionExecution(child('auto-parent', 'danger-full-access'))).toBe(false)
    expect(isAutoOrDelegatedPermissionExecution(child('auto-parent', 'danger-full-access'), lookup)).toBe(true)
    expect(isAutoOrDelegatedPermissionExecution(child('full-parent'), lookup)).toBe(false)
    expect(isAutoOrDelegatedPermissionExecution(child('missing'), lookup)).toBe(false)
  })

  it('inherits Auto across nested live subagents and rejects lineage cycles', () => {
    const autoParent = execution('auto').agent
    const middle = child('auto-parent', 'danger-full-access').agent
    const nested = child('middle', 'danger-full-access')
    const lookup = (id: string) => id === 'auto-parent' ? autoParent : id === 'middle' ? middle : undefined
    expect(isAutoOrDelegatedPermissionExecution(nested, lookup)).toBe(true)

    const first = child('second').agent
    const second = child('first').agent
    expect(isAutoOrDelegatedPermissionExecution(child('first'), id => id === 'first' ? first : second)).toBe(false)
  })
})
