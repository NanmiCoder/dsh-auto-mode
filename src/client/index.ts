/** Browser compatibility layer for Auto's localized label, missing glyph, and risk acknowledgement. */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the official browser locale service into Context.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { installAutoPermissionIcon } from './icon-injection.js'
import {
  AUTO_MODE_LOCALE_NAMESPACE, en, zh, type AutoModeTranslate,
} from './locales.js'

/** The UI copy follows the same locale service as the official permission surfaces. */
export const inject = ['locale']

/** Install the permission UI compatibility layer for this client fiber. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(AUTO_MODE_LOCALE_NAMESPACE, 'zh', zh),
      ctx.locale.register(AUTO_MODE_LOCALE_NAMESPACE, 'en', en),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'auto-mode: permission dictionaries')
  const translate = ctx.locale.bind(AUTO_MODE_LOCALE_NAMESPACE) as AutoModeTranslate
  ctx.effect(() => installAutoPermissionIcon(
    document,
    translate,
    listener => ctx.locale.subscribe(listener),
  ), 'auto-mode: permission UI')
}
