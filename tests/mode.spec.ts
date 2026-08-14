import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { isAutoPermissionExecution } from '../src/index.js'

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
})
