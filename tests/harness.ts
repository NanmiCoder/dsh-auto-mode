import type { Context } from '@deepseek-ai/cordis'
import type { CurrentPermissionPreset } from '../src/index.js'

/** Event-backed test adapter for contexts that do not assemble the full session projection stack. */
export const currentTestPermissionPreset: CurrentPermissionPreset = (session) => {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'permission/preset') return event.data.preset
  }
  return 'workspace-write'
}

/** Satisfy Auto's real Alpha.2 service dependency in focused policy compositions. */
export function provideTestPermissionPresets(ctx: Context): void {
  ctx.provide('permissionPresets', { current: currentTestPermissionPreset } as never)
}
