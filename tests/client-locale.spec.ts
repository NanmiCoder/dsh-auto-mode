// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import * as AutoModeClient from '../src/client/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('Auto permission locale integration', () => {
  it('registers with the official locale service and follows a live language switch', async () => {
    document.body.innerHTML = `
      <div role="menu">
        <button role="menuitem">Read Only</button>
        <button role="menuitem">Workspace Write</button>
        <button role="menuitem">Auto</button>
        <button role="menuitem">Full access</button>
      </div>
    `
    const auto = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      .find(item => item.textContent === 'Auto')
    context = new Context()
    const dictionaries = new Map<string, Map<string, Record<string, string>>>()
    const listeners = new Set<() => void>()
    let active = 'en'
    const locale = {
      register(namespace: string, language: string, dictionary: Record<string, string>) {
        const entries = dictionaries.get(namespace) ?? new Map<string, Record<string, string>>()
        dictionaries.set(namespace, entries)
        entries.set(language, dictionary)
        return () => { entries.delete(language) }
      },
      bind(namespace: string) {
        return (key: string): string => dictionaries.get(namespace)?.get(active)?.[key] ?? key
      },
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as LocaleRuntime
    context.provide('locale', locale)
    const plugin = context.plugin(AutoModeClient)
    await plugin

    expect(auto?.textContent).toBe('Auto')
    active = 'zh'
    for (const listener of listeners) listener()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(auto?.textContent).toBe('自动审批')

    await plugin.dispose()
    expect(auto?.textContent).toBe('Auto')
    expect(listeners.size).toBe(0)
    expect(Array.from(dictionaries.values()).every(entries => entries.size === 0)).toBe(true)
  })
})
