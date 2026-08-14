import type { ArtifactRegistry } from './artifacts.js';
import { type PolicyRoots } from './paths.js';
import type { Assessment } from './types.js';
export type ShellKind = 'bash' | 'pwsh';
export interface ParsedCommand {
    readonly tokens: readonly string[];
}
/** Parse one static shell command. Any executable shell syntax fails closed. */
export declare function parseSimpleCommand(source: string, shell: ShellKind): ParsedCommand | undefined;
/** Hard-deny shell patterns independent of parsing and classifier behavior. */
export declare function hardDenyShellReason(source: string, shell: ShellKind, roots: PolicyRoots): string | undefined;
/** Classify one Bash or PowerShell call after hard-deny evaluation. */
export declare function assessShell(source: string, shell: ShellKind, roots: PolicyRoots, artifacts: ArtifactRegistry, owner: object | undefined): Assessment;
//# sourceMappingURL=shell.d.ts.map