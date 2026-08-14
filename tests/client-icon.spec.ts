// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { decorateAutoPermissionIcons, installAutoPermissionIcon } from '../src/client/icon-injection.ts'

const permissionMenu = () => `
  <div role="menu">
    <button role="menuitem"><span>Read Only</span></button>
    <button role="menuitem"><span>Workspace Write</span></button>
    <button role="menuitem"><span>Auto</span></button>
    <button role="menuitem"><span>Full access</span></button>
  </div>
`

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('Auto permission icon decorator', () => {
  it('marks only Auto inside a complete permission menu and the active access trigger', () => {
    document.body.innerHTML = `
      ${permissionMenu()}
      <div role="menu"><button role="menuitem">Auto</button></div>
      <button aria-label="访问模式，当前：Auto"><span>Auto</span><span>⌄</span></button>
    `

    decorateAutoPermissionIcons(document)

    const autoRows = document.querySelectorAll('[data-dsh-auto-mode-icon="menu"]')
    expect(autoRows).toHaveLength(1)
    expect(autoRows[0]?.textContent?.trim()).toBe('Auto')
    expect(document.querySelector('[data-dsh-auto-mode-icon="trigger"]')?.getAttribute('aria-label')).toContain('Auto')
  })

  it('observes menus added later and removes every owned mark and style on disposal', async () => {
    const dispose = installAutoPermissionIcon(document)
    document.body.innerHTML = permissionMenu()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(document.querySelector('[data-dsh-auto-mode-icon="menu"]')).not.toBeNull()
    const style = document.querySelector('style[data-plugin="@nanmicoder/dsh-auto-mode"]')
    expect(style?.textContent).toContain('mask-image')

    dispose()
    expect(document.querySelector('[data-dsh-auto-mode-icon]')).toBeNull()
    expect(document.querySelector('style[data-plugin="@nanmicoder/dsh-auto-mode"]')).toBeNull()
  })

  it('removes a stale trigger mark after the active mode changes', () => {
    document.body.innerHTML = '<button aria-label="Access mode, current: Auto"><span>Auto</span></button>'
    const trigger = document.querySelector('button')
    decorateAutoPermissionIcons(document)
    expect(trigger?.getAttribute('data-dsh-auto-mode-icon')).toBe('trigger')

    trigger?.setAttribute('aria-label', 'Access mode, current: Full access')
    if (trigger !== null) trigger.textContent = 'Full access'
    decorateAutoPermissionIcons(document)
    expect(trigger?.hasAttribute('data-dsh-auto-mode-icon')).toBe(false)
  })
})
