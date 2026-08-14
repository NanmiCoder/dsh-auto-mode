/** Browser decorator for the Auto permission glyph missing from DSH 0.1.0-rc.6. */

import type { Context } from '@deepseek-ai/cordis'
import { installAutoPermissionIcon } from './icon-injection.js'

/** This decorator needs no Cordis service beyond the root effect lifecycle. */
export const inject: string[] = []

/** Install the permission-icon compatibility layer for this client fiber. */
export function apply(ctx: Context): void {
  ctx.effect(() => installAutoPermissionIcon(document), 'auto-mode: permission icon')
}
