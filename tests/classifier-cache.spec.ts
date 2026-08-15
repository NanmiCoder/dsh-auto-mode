import { describe, expect, it } from 'vitest'
import { ClassifierDecisionCache, classifierCacheKey } from '../src/classifier-cache.js'
import type { ClassifierInput } from '../src/types.js'

const cache = (options: { ttlMs?: number; maxEntries?: number; clock?: () => number } = {}) =>
  new ClassifierDecisionCache({
    ttlMs: options.ttlMs ?? 60_000,
    maxEntries: options.maxEntries ?? 128,
    ...(options.clock === undefined ? {} : { now: options.clock }),
  })

describe('classifier decision cache', () => {
  it('stores allow and deny verdicts but never ask', () => {
    const store = cache()
    store.set('a', { decision: 'allow', reason: 'ok' })
    store.set('b', { decision: 'ask', reason: 'must reach the user' })
    store.set('c', { decision: 'deny', reason: 'no' })
    expect(store.get('a')).toEqual({ decision: 'allow', reason: 'ok' })
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toEqual({ decision: 'deny', reason: 'no' })
  })

  it('expires entries after the TTL', () => {
    let clock = 0
    const store = cache({ clock: () => clock })
    store.set('a', { decision: 'allow', reason: 'ok' })
    clock = 59_999
    expect(store.get('a')).toBeDefined()
    clock = 60_000
    expect(store.get('a')).toBeUndefined()
  })

  it('evicts the least recently used entry at capacity', () => {
    let clock = 0
    const store = cache({ maxEntries: 2, clock: () => clock })
    store.set('a', { decision: 'allow', reason: '1' })
    store.set('b', { decision: 'allow', reason: '2' })
    store.get('a') // refresh LRU order: b is now the oldest
    store.set('c', { decision: 'allow', reason: '3' })
    expect(store.get('a')).toBeDefined()
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBeDefined()
  })
})

describe('classifier cache key', () => {
  const base: ClassifierInput = {
    toolName: 'bash',
    arguments: { command: 'rm -rf x' },
    workspaceRoot: '/work/repo',
    policyReason: 'deletion requires authorization',
    trustedUserMessages: ['请删除 x，我明确授权。'],
    route: { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  }

  it('is stable for identical payloads and sensitive to authorization context', () => {
    const original = classifierCacheKey(base)
    expect(classifierCacheKey(base)).toBe(original)
    expect(classifierCacheKey({ ...base, trustedUserMessages: ['无关消息'] })).not.toBe(original)
    expect(classifierCacheKey({ ...base, route: { provider: 'other', model: 'other' } })).not.toBe(original)
    expect(classifierCacheKey({ ...base, arguments: { command: 'rm -rf y' } })).not.toBe(original)
    expect(classifierCacheKey({ ...base, policyReason: 'other reason' })).not.toBe(original)
  })
})
