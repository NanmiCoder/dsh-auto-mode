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
  document.documentElement.removeAttribute('lang')
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

  it('requires acknowledgement before replaying the official Auto selection', () => {
    document.body.innerHTML = permissionMenu()
    const auto = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .find(item => item.textContent?.trim() === 'Auto')
    expect(auto).toBeDefined()
    let selections = 0
    auto?.addEventListener('click', () => { selections += 1 })
    const dispose = installAutoPermissionIcon(document)

    auto?.click()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.textContent === 'Enable Auto')
    expect(dialog?.getAttribute('aria-label')).toBe('Enable Auto?')
    expect(selections).toBe(0)
    expect(confirm?.disabled).toBe(true)

    checkbox?.click()
    expect(confirm?.disabled).toBe(false)
    confirm?.click()
    expect(selections).toBe(1)
    expect(document.querySelector('[data-dsh-auto-mode-risk-dialog]')).toBeNull()

    dispose()
  })

  it('cancels without selecting and localizes the warning in Chinese', () => {
    document.documentElement.lang = 'zh-CN'
    document.body.innerHTML = permissionMenu()
    const auto = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .find(item => item.textContent?.trim() === 'Auto')
    let selections = 0
    auto?.addEventListener('click', () => { selections += 1 })
    const dispose = installAutoPermissionIcon(document)

    auto?.click()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('确认启用 Auto？')
    expect(dialog?.textContent).toContain('workspace-write 操作系统级文件沙箱')
    expect(dialog?.textContent).toContain('Windows 文件边界是 partial')
    const cancel = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.textContent === '取消')
    cancel?.click()
    expect(selections).toBe(0)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    dispose()
  })

  it('does not gate an unrelated menu that happens to contain Auto', () => {
    document.body.innerHTML = '<div role="menu"><button role="menuitem">Auto</button></div>'
    const auto = document.querySelector<HTMLButtonElement>('button')
    let selections = 0
    auto?.addEventListener('click', () => { selections += 1 })
    const dispose = installAutoPermissionIcon(document)

    auto?.click()
    expect(selections).toBe(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    dispose()
  })

  it('gates Auto selected from the bare /permission popup', () => {
    document.body.innerHTML = `
      <div aria-label="/permission options">
        <div role="listbox" aria-label="/permission matches">
          <div role="option"><span>Auto</span><span>automatic policy</span></div>
        </div>
      </div>
    `
    const auto = document.querySelector<HTMLElement>('[role="option"]')
    let selections = 0
    auto?.addEventListener('click', () => { selections += 1 })
    const dispose = installAutoPermissionIcon(document)

    auto?.click()
    expect(selections).toBe(0)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.textContent === 'Enable Auto')
    checkbox?.click()
    confirm?.click()
    expect(selections).toBe(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    dispose()
  })

  it('gates Enter on the active Auto row in the /permission popup', () => {
    document.body.innerHTML = `
      <div aria-label="/permission options">
        <input aria-label="Filter options">
        <div role="listbox" aria-label="/permission matches">
          <div role="option" aria-selected="true"><span>Auto</span><span>automatic policy</span></div>
        </div>
      </div>
    `
    const input = document.querySelector<HTMLInputElement>('input')
    const auto = document.querySelector<HTMLElement>('[role="option"]')
    let selections = 0
    auto?.addEventListener('click', () => { selections += 1 })
    const dispose = installAutoPermissionIcon(document)

    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(selections).toBe(0)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => button.textContent === 'Enable Auto')
    checkbox?.click()
    confirm?.click()
    expect(selections).toBe(1)

    dispose()
  })

  it('removes an open warning and click gate on disposal', () => {
    document.body.innerHTML = permissionMenu()
    const auto = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .find(item => item.textContent?.trim() === 'Auto')
    let selections = 0
    auto?.addEventListener('click', () => { selections += 1 })
    const dispose = installAutoPermissionIcon(document)

    auto?.click()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    dispose()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    auto?.click()
    expect(selections).toBe(1)
  })
})
