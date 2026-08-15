import { createHash } from 'node:crypto';
export class ClassifierDecisionCache {
    entries = new Map();
    ttlMs;
    maxEntries;
    now;
    constructor(options) {
        this.ttlMs = options.ttlMs;
        this.maxEntries = options.maxEntries;
        this.now = options.now ?? Date.now;
    }
    get size() {
        return this.entries.size;
    }
    get(key) {
        const entry = this.entries.get(key);
        if (entry === undefined)
            return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        // LRU refresh: reinsert at the tail.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.decision;
    }
    set(key, decision) {
        if (decision.decision === 'ask')
            return;
        const expiresAt = this.now() + this.ttlMs;
        this.entries.delete(key);
        this.entries.set(key, { decision, expiresAt });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.entries.delete(oldest);
        }
    }
}
/** Stable cache key over the exact payload the classifier will judge. */
export function classifierCacheKey(payload) {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
//# sourceMappingURL=classifier-cache.js.map