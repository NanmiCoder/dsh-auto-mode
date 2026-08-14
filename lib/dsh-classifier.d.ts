import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { SafetyClassifier } from './types.js';
interface LlmStreamRuntime {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
/** Configuration for a classifier that reuses the current Harness LLM route. */
export interface DshClassifierConfig {
    readonly timeoutMs: number;
    readonly maxOutputTokens?: number;
    readonly provider?: string;
    readonly model?: string;
}
/** Reuse `ctx.llm` for an independent, low-token classifier request. */
export declare function createDshClassifier(runtime: LlmStreamRuntime, config: DshClassifierConfig): SafetyClassifier;
export {};
//# sourceMappingURL=dsh-classifier.d.ts.map