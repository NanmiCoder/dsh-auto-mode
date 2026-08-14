import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { ArtifactRegistry } from './artifacts.js';
import { type PolicyRoots } from './paths.js';
import type { Assessment } from './types.js';
/** Synchronous hard-deny reason suitable for the monotonic tool guard. */
export declare function hardDenyReason(exec: Readonly<ToolExecution>, roots: PolicyRoots): string | undefined;
/** Deterministic first-pass classification for every normal tool call. */
export declare function assessTool(exec: Readonly<ToolExecution>, roots: PolicyRoots, artifacts: ArtifactRegistry): Assessment;
//# sourceMappingURL=policy.d.ts.map