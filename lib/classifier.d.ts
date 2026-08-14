import type { ClassifierDecision, SafetyClassifier } from './types.js';
/** Shared policy for native and OpenAI-compatible classifier calls. */
export declare const CLASSIFIER_SYSTEM_PROMPT: string;
/** Configuration for the independent OpenAI-compatible safety classifier. */
export interface HttpClassifierConfig {
    readonly endpoint: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly fetchImpl?: typeof fetch;
}
/** Redact likely secrets and bound one classifier-visible text value. */
export declare function sanitizeClassifierText(value: string): string;
/** Remove bulk content and likely secrets before crossing the classifier network boundary. */
export declare function sanitizeClassifierArguments(value: unknown, depth?: number): unknown;
/** Parse the complete strict classifier response shared by every transport. */
export declare function parseClassifierDecision(value: unknown): ClassifierDecision;
/** Create a fail-loud classifier; callers own the fail-closed fallback policy. */
export declare function createHttpClassifier(config: HttpClassifierConfig): SafetyClassifier;
//# sourceMappingURL=classifier.d.ts.map