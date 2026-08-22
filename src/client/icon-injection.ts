import {
  en, translateEnglish, zh, type AutoModeLocaleKey, type AutoModeTranslate,
} from './locales.js'

const PLUGIN_ID = '@nanmicoder/dsh-auto-mode'
const ICON_ATTRIBUTE = 'data-dsh-auto-mode-icon'
const DIALOG_ATTRIBUTE = 'data-dsh-auto-mode-risk-dialog'
const LOCALIZED_ATTRIBUTE = 'data-dsh-auto-mode-localized'
const COPY_ATTRIBUTE = 'data-dsh-auto-mode-copy'
const COPY_ARIA_ATTRIBUTE = 'data-dsh-auto-mode-copy-aria'
const AUTO_SOURCE_LABEL = 'Auto'
const AUTO_LABELS = new Set([AUTO_SOURCE_LABEL, en['preset.label'], zh['preset.label']])
const AUTO_DESCRIPTIONS = new Set([en['preset.description'], zh['preset.description']])
const PERMISSION_LABEL_SETS = [
  ['Read Only', 'Workspace Write', 'Full access'],
  ['仅可查看', '可写入工作区', '完全权限'],
] as const
const PERMISSION_ROW_TITLES = new Set(['Permission', '权限'])

/** Register one locale-change listener and return its disposer. */
export type AutoModeLocaleSubscribe = (listener: () => void) => () => void

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8.21.9l6.58 2.47v3.64c0 4.99-3.74 7.2-6.58 8.29C5.36 14.21 1.62 12 1.62 7.01V3.37L8.21.9Z" fill="none" stroke="black" stroke-width="1.32" stroke-linejoin="round"/><path d="M8.75 3.65 5.95 8.2h2.08l-.78 4.15 2.82-4.9H8.12l.63-3.8Z" fill="black"/></svg>'

function iconStyles(): string {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(ICON_SVG)}")`
  return `
[${ICON_ATTRIBUTE}]::before {
  content: "";
  display: inline-block;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  background-color: var(--dsw-alias-label-tertiary, currentColor);
  -webkit-mask-image: ${mask};
  mask-image: ${mask};
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
}
[${ICON_ATTRIBUTE}="trigger"]::before {
  width: 14px;
  height: 14px;
}
@container (max-width: 460px) {
  [${ICON_ATTRIBUTE}="trigger"] > span:first-of-type {
    display: none;
  }
}
[${DIALOG_ATTRIBUTE}] {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--dsw-alias-label-primary, #171717);
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
  backdrop-filter: var(--dsw-mask-blur, blur(2px));
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: min(440px, 100%);
  max-height: calc(100vh - 48px);
  padding: 0 0 24px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted, rgba(0, 0, 0, 0.08));
  border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: var(--dsw-shadow-lv3, 0 18px 48px rgba(0, 0, 0, 0.18));
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-content {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 22px 14px 12px 24px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #666);
  background: transparent;
  font: inherit;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-body {
  padding: 0 24px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-warning {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  color: var(--dsw-alias-label-secondary, #666);
  font-size: 14px;
  line-height: 22px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-warning p {
  margin: 0;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-warning-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  color: var(--dsw-alias-state-error-primary, #e5484d);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-acknowledgement {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 20px;
  color: var(--dsw-alias-label-primary, #171717);
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-acknowledgement input {
  flex: none;
  width: 16px;
  height: 16px;
  margin: 3px 0 0;
  accent-color: var(--dsw-alias-button-primary-fill, #171717);
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 24px;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-action {
  min-width: 72px;
  min-height: 36px;
  padding: 7px 16px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14));
  border-radius: 12px;
  color: var(--dsw-alias-label-primary, #171717);
  background: transparent;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-confirm {
  min-width: 136px;
  border-color: transparent;
  color: var(--dsw-alias-label-on-fill, #fff);
  background: var(--dsw-alias-button-primary-fill, #171717);
}
[${DIALOG_ATTRIBUTE}] .dsh-auto-risk-confirm:disabled {
  color: var(--dsw-alias-label-disable, rgba(255, 255, 255, 0.78));
  background: var(--dsw-alias-button-disabled-fill, #aaa);
  cursor: not-allowed;
}
@supports (height: 100dvh) {
  [${DIALOG_ATTRIBUTE}] .dsh-auto-risk-card {
    max-height: calc(100dvh - 48px);
  }
}
`
}

function setCopyKey(element: Element, key: AutoModeLocaleKey): void {
  element.setAttribute(COPY_ATTRIBUTE, key)
}

function setAriaCopyKey(element: Element, key: AutoModeLocaleKey): void {
  element.setAttribute(COPY_ARIA_ATTRIBUTE, key)
}

function refreshRiskDialog(document: Document, t: AutoModeTranslate): void {
  const dialog = document.querySelector(`[${DIALOG_ATTRIBUTE}]`)
  if (dialog === null) return
  for (const element of dialog.querySelectorAll(`[${COPY_ATTRIBUTE}]`)) {
    const key = element.getAttribute(COPY_ATTRIBUTE) as AutoModeLocaleKey
    const copy = t(key)
    if (element.textContent !== copy) element.textContent = copy
  }
  for (const element of dialog.querySelectorAll(`[${COPY_ARIA_ATTRIBUTE}]`)) {
    const key = element.getAttribute(COPY_ARIA_ATTRIBUTE) as AutoModeLocaleKey
    const copy = t(key)
    if (element.getAttribute('aria-label') !== copy) element.setAttribute('aria-label', copy)
  }
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

/** Build the plugin-owned equivalent of DSH's shared RiskConfirmation dialog. */
function createRiskDialog(
  document: Document,
  t: AutoModeTranslate,
  onCancel: () => void,
  onConfirm: () => void,
): HTMLElement {
  const layer = document.createElement('div')
  layer.setAttribute(DIALOG_ATTRIBUTE, '')
  layer.setAttribute('role', 'presentation')

  const mask = makeElement(document, 'div', 'dsh-auto-risk-mask')
  mask.setAttribute('aria-hidden', 'true')

  const card = makeElement(document, 'div', 'dsh-auto-risk-card')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', t('dialog.title'))
  setAriaCopyKey(card, 'dialog.title')

  const content = makeElement(document, 'div', 'dsh-auto-risk-content')
  const header = makeElement(document, 'div', 'dsh-auto-risk-header')
  const title = makeElement(document, 'h2', 'dsh-auto-risk-title', t('dialog.title'))
  setCopyKey(title, 'dialog.title')
  const close = makeElement(document, 'button', 'dsh-auto-risk-close', '×')
  close.type = 'button'
  close.setAttribute('aria-label', t('dialog.close'))
  setAriaCopyKey(close, 'dialog.close')
  header.append(title, close)

  const body = makeElement(document, 'div', 'dsh-auto-risk-body')
  const warning = makeElement(document, 'div', 'dsh-auto-risk-warning')
  const warningIcon = makeElement(document, 'span', 'dsh-auto-risk-warning-icon', '!')
  warningIcon.setAttribute('aria-hidden', 'true')
  const description = makeElement(document, 'p', '', t('dialog.description'))
  setCopyKey(description, 'dialog.description')
  warning.append(warningIcon, description)

  const acknowledgement = makeElement(document, 'label', 'dsh-auto-risk-acknowledgement')
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  const acknowledgementCopy = makeElement(document, 'span', '', t('dialog.acknowledge'))
  setCopyKey(acknowledgementCopy, 'dialog.acknowledge')
  acknowledgement.append(checkbox, acknowledgementCopy)
  body.append(warning, acknowledgement)
  content.append(header, body)

  const footer = makeElement(document, 'div', 'dsh-auto-risk-footer')
  const cancel = makeElement(document, 'button', 'dsh-auto-risk-action', t('dialog.cancel'))
  cancel.type = 'button'
  setCopyKey(cancel, 'dialog.cancel')
  const confirm = makeElement(document, 'button', 'dsh-auto-risk-action dsh-auto-risk-confirm', t('dialog.confirm'))
  confirm.type = 'button'
  confirm.disabled = true
  setCopyKey(confirm, 'dialog.confirm')
  footer.append(cancel, confirm)
  card.append(content, footer)
  layer.append(mask, card)

  checkbox.addEventListener('change', () => { confirm.disabled = !checkbox.checked })
  mask.addEventListener('click', onCancel)
  close.addEventListener('click', onCancel)
  cancel.addEventListener('click', onCancel)
  confirm.addEventListener('click', () => {
    if (confirm.disabled) return
    onConfirm()
  })

  // Keep the still-open official permission menu alive behind the modal. It
  // owns the original selection callback that is replayed after confirmation.
  layer.addEventListener('pointerdown', event => { event.stopPropagation() })
  queueMicrotask(() => { if (checkbox.isConnected) checkbox.focus() })
  return layer
}

function normalizedText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function hasAutoLabel(element: Element): boolean {
  return AUTO_LABELS.has(normalizedText(element))
}

function replaceKnownText(element: Element, known: ReadonlySet<string>, replacement: string): boolean {
  let matched = false
  for (const child of element.childNodes) {
    if (child.nodeType === 3) {
      const text = child.textContent ?? ''
      const match = /^(\s*)(.*?)(\s*)$/s.exec(text)
      if (match !== null && known.has(match[2] ?? '')) {
        const localized = `${match[1] ?? ''}${replacement}${match[3] ?? ''}`
        if (text !== localized) child.textContent = localized
        matched = true
      }
      continue
    }
    if (child.nodeType === 1) {
      matched = replaceKnownText(child as Element, known, replacement) || matched
    }
  }
  return matched
}

function replaceAutoSuffix(value: string, replacement: string): string {
  for (const label of AUTO_LABELS) {
    if (!value.endsWith(label)) continue
    const prefix = value.slice(0, -label.length)
    if (prefix === '' || /[\s,:，：]$/.test(prefix)) return `${prefix}${replacement}`
  }
  return value
}

function isPermissionMenu(menu: Element): boolean {
  const labels = new Set(
    Array.from(menu.querySelectorAll('button[role="menuitem"]'), normalizedText),
  )
  return [...AUTO_LABELS].some(label => labels.has(label))
    && PERMISSION_LABEL_SETS.some(required => required.every(label => labels.has(label)))
}

function isAutoMenuItem(element: Element): boolean {
  if (element.matches('button[role="menuitem"]') && hasAutoLabel(element)) {
    const menu = element.closest('[role="menu"]')
    return menu !== null && isPermissionMenu(menu)
  }
  return false
}

function isAutoPermissionOption(element: Element): boolean {
  if (!element.matches('[role="option"]')) return false
  const listbox = element.closest('[role="listbox"][aria-label]')
  const listboxLabel = listbox?.getAttribute('aria-label') ?? ''
  if (!/^\/permission\s+(?:matches|匹配项)$/i.test(listboxLabel.trim())) return false
  return hasAutoLabel(element.firstElementChild ?? element)
}

function activeAutoPermissionOption(target: Element): Element | null {
  const overlay = target.closest('[aria-label^="/permission"]')
  const overlayLabel = overlay?.getAttribute('aria-label') ?? ''
  if (!/^\/permission\s+(?:options|选项)$/i.test(overlayLabel.trim())) return null
  const option = overlay?.querySelector('[role="listbox"] [role="option"][aria-selected="true"]') ?? null
  return option !== null && isAutoPermissionOption(option) ? option : null
}

function isAutoPermissionChoice(element: Element): boolean {
  return isAutoMenuItem(element) || isAutoPermissionOption(element)
}

function isAutoTrigger(element: Element): boolean {
  if (!element.matches('button[aria-label]')) return false
  const label = element.getAttribute('aria-label') ?? ''
  return /(?:访问模式|Access mode)/i.test(label)
    && [...AUTO_LABELS].some(autoLabel => label.trimEnd().endsWith(autoLabel))
}

function hasPermissionTitle(element: Element): boolean {
  return Array.from(element.querySelectorAll('div'))
    .some(candidate => PERMISSION_ROW_TITLES.has(normalizedText(candidate)))
}

function isAutoSettingsTrigger(element: Element): boolean {
  if (!element.matches('button[aria-haspopup="menu"]') || !hasAutoLabel(element)) return false
  let ancestor = element.parentElement
  for (let depth = 0; ancestor !== null && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
    if (hasPermissionTitle(ancestor)) return true
    if (ancestor.matches('[role="dialog"]')) return false
  }
  return false
}

function localizeAutoLabel(element: Element, kind: string, t: AutoModeTranslate): void {
  if (replaceKnownText(element, AUTO_LABELS, t('preset.label'))) {
    element.setAttribute(LOCALIZED_ATTRIBUTE, kind)
  }
}

function localizeAutoTrigger(element: Element, t: AutoModeTranslate): void {
  localizeAutoLabel(element, 'trigger', t)
  const label = element.getAttribute('aria-label')
  if (label !== null) {
    const localized = replaceAutoSuffix(label, t('preset.label'))
    if (localized !== label) element.setAttribute('aria-label', localized)
  }
}

function localizeAutoOption(element: Element, t: AutoModeTranslate): void {
  localizeAutoLabel(element.firstElementChild ?? element, 'option', t)
  replaceKnownText(element, AUTO_DESCRIPTIONS, t('preset.description'))
  element.setAttribute(LOCALIZED_ATTRIBUTE, 'option')
}

function restoreLocalizedCopy(document: Document): void {
  for (const element of document.querySelectorAll(`[${LOCALIZED_ATTRIBUTE}]`)) {
    const kind = element.getAttribute(LOCALIZED_ATTRIBUTE)
    replaceKnownText(element, AUTO_LABELS, AUTO_SOURCE_LABEL)
    if (kind === 'option') replaceKnownText(element, AUTO_DESCRIPTIONS, en['preset.description'])
    if (kind === 'trigger') {
      const label = element.getAttribute('aria-label')
      if (label !== null) element.setAttribute('aria-label', replaceAutoSuffix(label, AUTO_SOURCE_LABEL))
    }
    element.removeAttribute(LOCALIZED_ATTRIBUTE)
  }
}

/** Localize and mark the official Auto permission surfaces for CSS decoration. */
export function decorateAutoPermissionIcons(
  document: Document,
  t: AutoModeTranslate = translateEnglish,
): void {
  for (const marked of document.querySelectorAll(`[${ICON_ATTRIBUTE}]`)) {
    const kind = marked.getAttribute(ICON_ATTRIBUTE)
    if ((kind === 'menu' && !isAutoMenuItem(marked))
      || (kind === 'trigger' && !isAutoTrigger(marked))
      || (kind === 'settings' && !isAutoSettingsTrigger(marked))) {
      marked.removeAttribute(ICON_ATTRIBUTE)
      marked.removeAttribute(LOCALIZED_ATTRIBUTE)
    }
  }

  for (const menu of document.querySelectorAll('[role="menu"]')) {
    if (!isPermissionMenu(menu)) continue
    for (const item of menu.querySelectorAll('button[role="menuitem"]')) {
      if (!hasAutoLabel(item)) continue
      localizeAutoLabel(item, 'menu', t)
      item.setAttribute(ICON_ATTRIBUTE, 'menu')
    }
  }

  for (const button of document.querySelectorAll('button[aria-label]')) {
    if (!isAutoTrigger(button)) continue
    localizeAutoTrigger(button, t)
    button.setAttribute(ICON_ATTRIBUTE, 'trigger')
  }

  for (const button of document.querySelectorAll('button[aria-haspopup="menu"]')) {
    if (!isAutoSettingsTrigger(button)) continue
    localizeAutoLabel(button, 'settings', t)
    button.setAttribute(ICON_ATTRIBUTE, 'settings')
  }

  for (const option of document.querySelectorAll('[role="option"]')) {
    if (isAutoPermissionOption(option)) localizeAutoOption(option, t)
  }

  refreshRiskDialog(document, t)
}

/** Install the localized Auto UI and explicit risk gate, then return their disposer. */
export function installAutoPermissionIcon(
  document: Document,
  t: AutoModeTranslate = translateEnglish,
  subscribe?: AutoModeLocaleSubscribe,
): () => void {
  for (const existing of document.querySelectorAll('style[data-plugin]')) {
    if (existing.getAttribute('data-plugin') === PLUGIN_ID) existing.remove()
  }

  const style = document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = `${PLUGIN_ID}/permission-icon`
  style.textContent = iconStyles()
  document.head.appendChild(style)

  let active = true
  let queued = false
  const scan = (): void => {
    if (!active || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (active) decorateAutoPermissionIcons(document, t)
    })
  }

  decorateAutoPermissionIcons(document, t)
  const observer = new MutationObserver(scan)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['aria-label', 'lang'],
    characterData: true,
    childList: true,
    subtree: true,
  })
  const unsubscribe = subscribe?.(scan)

  const bypassed = new WeakSet<Element>()
  let dialog: HTMLElement | null = null
  const closeDialog = (): void => {
    dialog?.remove()
    dialog = null
  }
  const dismissDialog = (): void => {
    if (dialog === null) return
    closeDialog()
    // Mirror the official flow: cancelling the acknowledgement also dismisses
    // the menu or /permission popup that remains mounted behind the modal.
    const MouseEvent = document.defaultView?.MouseEvent
    if (MouseEvent !== undefined) {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    }
  }
  const openDialog = (item: Element): void => {
    if (dialog !== null) return
    dialog = createRiskDialog(document, t, dismissDialog, () => {
      closeDialog()
      if (!item.isConnected) return
      bypassed.add(item)
      ;(item as HTMLElement).click()
    })
    document.body.appendChild(dialog)
  }
  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const item = target.closest('button[role="menuitem"], [role="option"]')
    if (item === null || !isAutoPermissionChoice(item)) return
    if (bypassed.has(item)) {
      bypassed.delete(item)
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    openDialog(item)
  }
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target
    if (dialog === null || !(target instanceof Node) || !dialog.contains(target)) return
    // DSH's /permission popup dismisses outside pointer presses from a later
    // document-capture listener. Hold it open so its original row can be
    // replayed after acknowledgement.
    event.stopImmediatePropagation()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && dialog !== null) {
      event.preventDefault()
      event.stopImmediatePropagation()
      dismissDialog()
      return
    }
    if (event.key !== 'Enter' || dialog !== null || !(event.target instanceof Element)) return
    const option = activeAutoPermissionOption(event.target)
    if (option === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    openDialog(option)
  }
  document.addEventListener('click', onClick, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)

  return () => {
    active = false
    observer.disconnect()
    unsubscribe?.()
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    closeDialog()
    style.remove()
    restoreLocalizedCopy(document)
    for (const marked of document.querySelectorAll(`[${ICON_ATTRIBUTE}]`)) {
      marked.removeAttribute(ICON_ATTRIBUTE)
    }
  }
}
