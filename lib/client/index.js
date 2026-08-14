/** Browser decorator for the Auto permission glyph missing from DSH 0.1.0-rc.6. */
import { installAutoPermissionIcon } from './icon-injection.js';
/** This decorator needs no Cordis service beyond the root effect lifecycle. */
export const inject = [];
/** Install the permission-icon compatibility layer for this client fiber. */
export function apply(ctx) {
    ctx.effect(() => installAutoPermissionIcon(document), 'auto-mode: permission icon');
}
//# sourceMappingURL=index.js.map