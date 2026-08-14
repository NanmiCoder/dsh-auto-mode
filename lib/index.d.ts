import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
export { ArtifactRegistry } from './artifacts.js';
export { createHttpClassifier, sanitizeClassifierArguments, type HttpClassifierConfig } from './classifier.js';
export * from './paths.js';
export * from './policy.js';
export * from './shell.js';
export type * from './types.js';
export declare const name = "auto-permission-mode";
export declare const inject: string[];
/** Official permission preset key that activates this policy. */
export declare const AUTO_PERMISSION_PRESET = "auto";
/** Host policy configuration. */
export interface Config {
    readonly presetName?: string;
    readonly workspaceRoot?: string;
    readonly dshHome?: string;
    readonly tempRoots?: string[];
    readonly classifierEndpoint?: string;
    readonly classifierModel?: string;
    readonly classifierApiKeyEnv?: string;
    readonly classifierTimeoutMs?: number;
}
export declare const Config: z<Config>;
/** Whether the pending tool call belongs to a session currently using the Auto permission preset. */
export declare function isAutoPermissionExecution(exec: Readonly<ToolExecution>, presetName?: string): boolean;
/** Install the automatic permission policy on the official tool pipeline. */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map