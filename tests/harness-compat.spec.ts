import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { sessionEventsNewestFirst } from '../src/harness-compat.js'
import { trustedUserMessages } from '../src/index.js'

const user = (text: string, kind = 'user') => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } })

describe('versioned session event reader', () => {
  it('uses the exclusive RC sequence and preserves receiver binding without touching removed events', () => {
    const events = [user('old'), user('ignore plugin', 'plugin'), user('latest')]
    const session = {
      seq: events.length,
      eventAt(index: number) { expect(this).toBe(session); return events[index] },
      get events(): never { throw new Error('removed API must not be touched') },
    }
    const agent = { session } as unknown as ToolExecution['agent']
    expect(trustedUserMessages(agent)).toEqual(['old', 'latest'])
    expect([...sessionEventsNewestFirst({ seq: 0, eventAt: () => { throw new Error('empty session') } })]).toEqual([])
  })

  it('retains the latest four direct-user messages and bounds them across both APIs', () => {
    const events = [user('old'), ...Array.from({ length: 5 }, (_, i) => user(String(i).repeat(2000))), user('ignore', 'plugin')]
    for (const session of [{ events }, { seq: events.length, eventAt: (i: number) => events[i] }]) {
      const messages = trustedUserMessages({ session } as unknown as ToolExecution['agent'])
      expect(messages.map(m => m[0])).toEqual(['1', '2', '3', '4'])
      expect(messages.join('').length).toBe(4000)
    }
    expect(() => [...sessionEventsNewestFirst({})]).toThrow(/unsupported Harness/)
  })
})
