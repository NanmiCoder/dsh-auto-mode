import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
export { ArtifactRegistry } from './artifacts.js';
export { createHttpClassifier, sanitizeClassifierArguments, type HttpClassifierConfig } from './classifier.js';
export { createDshClassifier, type DshClassifierConfig } from './dsh-classifier.js';
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
    readonly classifierProvider?: string;
    readonly classifierModel?: string;
    readonly classifierApiKeyEnv?: string;
    readonly classifierTimeoutMs?: number;
    readonly classifierMaxOutputTokens?: number;
}
export declare const Config: z<Config>;
/** Whether the pending tool call belongs to a session currently using the Auto permission preset. */
export declare function isAutoPermissionExecution(exec: Readonly<ToolExecution>, presetName?: string): boolean;
type ParentSessionId = NonNullable<NonNullable<ToolExecution['agent']>['session']['header']['parentSession']>;
interface ParentAgentLookup {
    (sessionId: ParentSessionId): ToolExecution['agent'] | undefined;
}
/**
 * Auto is a session capability, so official in-process subagents inherit it
 * through their durable parentSession lineage. DSH already inherits the
 * parent's tool composition/sandbox but deliberately pins child approval to
 * `never`; applying Auto to every child tool call keeps routine work moving
 * while ambiguous calls fail closed instead of bypassing this policy.
 */
export declare function isAutoOrDelegatedPermissionExecution(exec: Readonly<ToolExecution>, parentAgent: ParentAgentLookup, presetName?: string): boolean;
/** Resolve the direct Auto session whose durable user messages authorize this execution. */
export declare function autoPermissionAuthority(exec: Readonly<ToolExecution>, parentAgent: ParentAgentLookup, presetName?: string): ToolExecution['agent'] | undefined;
/** Install the automatic permission policy on the official tool pipeline. */
export declare function apply(ctx: Context, config?: Config): void;
//# sourceMappingURL=index.d.ts.map