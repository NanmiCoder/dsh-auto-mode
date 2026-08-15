import { createHash } from 'node:crypto'
import type { ClassifierDecision, ClassifierInput } from './types.js'

/**
 * Bounded LRU cache of FINAL classifier verdicts.
 *
 * Only `allow` and `deny` are stored: an `ask` must always reach the user, so
 * caching it would bypass the approval popup. The key is a hash of the FULL
 * sanitized classifier payload — including `trustedUserMessages` and the
 * model `route` — because the classifier judges a call against the user's own
 * authorization messages: a verdict conditioned on one session's "yes, delete
 * it" must never be reused for another session's identical but unauthorized
 * call. The TTL bounds staleness if authorization changes mid-flight.
 */
export interface ClassifierCacheOptions {
  readonly ttlMs: number
  readonly maxEntries: number
  readonly now?: () => number
}

interface CacheEntry {
  readonly decision: ClassifierDecision
  readonly expiresAt: number
}

export class ClassifierDecisionCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: ClassifierCacheOptions) {
    this.ttlMs = options.ttlMs
    this.maxEntries = options.maxEntries
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): ClassifierDecision | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    // LRU refresh: reinsert at the tail.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.decision
  }

  set(key: string, decision: ClassifierDecision): void {
    if (decision.decision === 'ask') return
    const expiresAt = this.now() + this.ttlMs
    this.entries.delete(key)
    this.entries.set(key, { decision, expiresAt })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

/** Stable cache key over the exact payload the classifier will judge. */
export function classifierCacheKey(payload: ClassifierInput): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}
