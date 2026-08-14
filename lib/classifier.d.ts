import type { SafetyClassifier } from './types.js';
/** Configuration for the independent OpenAI-compatible safety classifier. */
export interface HttpClassifierConfig {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly fetchImpl?: typeof fetch;
}
/** Remove bulk content and likely secrets before crossing the classifier network boundary. */
export declare function sanitizeClassifierArguments(value: unknown, depth?: number): unknown;
/** Create a fail-loud classifier; callers own the fail-closed fallback policy. */
export declare function createHttpClassifier(config: HttpClassifierConfig): SafetyClassifier;
//# sourceMappingURL=classifier.d.ts.map