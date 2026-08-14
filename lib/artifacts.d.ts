import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { type PolicyRoots } from './paths.js';
/** In-memory provenance for exact paths created successfully during the live session. */
export declare class ArtifactRegistry {
    private readonly created;
    private readonly pending;
    /** Whether a path was observed as created in this exact live session. */
    has(owner: object | undefined, path: string, roots: PolicyRoots): boolean;
    /** Record planned exact creations for settlement-time promotion. */
    plan(exec: ToolExecution, paths: readonly string[], roots: PolicyRoots): void;
    /** Promote successful creates and forget every pending execution. */
    settle(exec: ToolExecution, result: ToolExecutionResult, roots: PolicyRoots): void;
    private add;
}
//# sourceMappingURL=artifacts.d.ts.map