/** Browser compatibility layer for Auto's missing glyph and risk acknowledgement. */
import { installAutoPermissionIcon } from './icon-injection.js';
/** This decorator needs no Cordis service beyond the root effect lifecycle. */
export const inject = [];
/** Install the permission UI compatibility layer for this client fiber. */
export function apply(ctx) {
    ctx.effect(() => installAutoPermissionIcon(document), 'auto-mode: permission UI');
}
//# sourceMappingURL=index.js.map