const PLUGIN_ID = '@nanmicoder/dsh-auto-mode'
const ICON_ATTRIBUTE = 'data-dsh-auto-mode-icon'
const REQUIRED_PERMISSION_LABELS = ['Read Only', 'Workspace Write', 'Auto', 'Full access'] as const

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
`
}

function normalizedText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function isPermissionMenu(menu: Element): boolean {
  const labels = new Set(
    Array.from(menu.querySelectorAll('button[role="menuitem"]'), normalizedText),
  )
  return REQUIRED_PERMISSION_LABELS.every(label => labels.has(label))
}

function isAutoMenuItem(element: Element): boolean {
  if (element.matches('button[role="menuitem"]') && normalizedText(element) === 'Auto') {
    const menu = element.closest('[role="menu"]')
    return menu !== null && isPermissionMenu(menu)
  }
  return false
}

function isAutoTrigger(element: Element): boolean {
  if (!element.matches('button[aria-label]')) return false
  const label = element.getAttribute('aria-label') ?? ''
  return /(?:访问模式|Access mode)[\s\S]*Auto\s*$/i.test(label)
}

/** Mark the official Auto permission row and active trigger for CSS decoration. */
export function decorateAutoPermissionIcons(document: Document): void {
  for (const marked of document.querySelectorAll(`[${ICON_ATTRIBUTE}]`)) {
    const kind = marked.getAttribute(ICON_ATTRIBUTE)
    if ((kind === 'menu' && !isAutoMenuItem(marked)) || (kind === 'trigger' && !isAutoTrigger(marked))) {
      marked.removeAttribute(ICON_ATTRIBUTE)
    }
  }

  for (const menu of document.querySelectorAll('[role="menu"]')) {
    if (!isPermissionMenu(menu)) continue
    for (const item of menu.querySelectorAll('button[role="menuitem"]')) {
      if (normalizedText(item) === 'Auto') item.setAttribute(ICON_ATTRIBUTE, 'menu')
    }
  }

  for (const button of document.querySelectorAll('button[aria-label]')) {
    if (isAutoTrigger(button)) button.setAttribute(ICON_ATTRIBUTE, 'trigger')
  }
}

/** Install the DOM compatibility decorator and return its complete disposer. */
export function installAutoPermissionIcon(document: Document): () => void {
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
      if (active) decorateAutoPermissionIcons(document)
    })
  }

  decorateAutoPermissionIcons(document)
  const observer = new MutationObserver(scan)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['aria-label'],
    characterData: true,
    childList: true,
    subtree: true,
  })

  return () => {
    active = false
    observer.disconnect()
    style.remove()
    for (const marked of document.querySelectorAll(`[${ICON_ATTRIBUTE}]`)) {
      marked.removeAttribute(ICON_ATTRIBUTE)
    }
  }
}
