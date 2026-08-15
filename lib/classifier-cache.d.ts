import type { ClassifierDecision, ClassifierInput } from './types.js';
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
    readonly ttlMs: number;
    readonly maxEntries: number;
    readonly now?: () => number;
}
export declare class ClassifierDecisionCache {
    private readonly entries;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly now;
    constructor(options: ClassifierCacheOptions);
    get size(): number;
    get(key: string): ClassifierDecision | undefined;
    set(key: string, decision: ClassifierDecision): void;
}
/** Stable cache key over the exact payload the classifier will judge. */
export declare function classifierCacheKey(payload: ClassifierInput): string;
//# sourceMappingURL=classifier-cache.d.ts.map