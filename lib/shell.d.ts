import type { ArtifactRegistry } from './artifacts.js';
import { type PolicyRoots } from './paths.js';
import type { Assessment } from './types.js';
export type ShellKind = 'bash' | 'pwsh';
export interface ParsedCommand {
    readonly tokens: readonly string[];
}
/** One command-line word with the static properties this policy depends on. */
export interface CommandWord {
    /** Quote-removed text; an unresolved expansion keeps its written form. */
    readonly text: string;
    /** Whether the word expands a variable that cannot be resolved statically. */
    readonly dynamic: boolean;
    /** Whether the word carries an unquoted `*` or `?` metacharacter. */
    readonly glob: boolean;
    /** Whether the word was written with quoting or escaping. */
    readonly quoted: boolean;
}
/** One statically separated command inside a Bash or PowerShell command line. */
export interface ShellSegment {
    readonly words: readonly CommandWord[];
    /** File targets of `>`/`>>`-style redirection; descriptor duplication has none. */
    readonly writeTargets: readonly CommandWord[];
    /** File sources of `<`-style redirection. */
    readonly readTargets: readonly CommandWord[];
}
/** Static split of a command line, or the reason it cannot be read at all. */
export type ShellDecomposition = {
    readonly kind: 'segments';
    readonly segments: readonly ShellSegment[];
} | {
    readonly kind: 'opaque';
    readonly reason: string;
};
/**
 * Split one command line into segments, redirections, and word metadata.
 *
 * Operators separate segments so that every command in a compound line is
 * assessed on its own. Constructs whose effect cannot be read statically —
 * command substitution, here-documents, grouping, unbalanced quotes — return
 * `opaque` so callers fail closed instead of guessing shell semantics.
 */
export declare function decomposeCommandLine(source: string, shell: ShellKind): ShellDecomposition;
/** Parse one static shell command. Any executable shell syntax fails closed. */
export declare function parseSimpleCommand(source: string, shell: ShellKind): ParsedCommand | undefined;
/**
 * Hard-deny shell patterns independent of parsing and classifier behavior.
 *
 * The whole-line rules stay unconditional because they must also cover a
 * command line no parser can decompose. The structural rules then judge every
 * segment of a compound line, so an operator cannot smuggle a protected target
 * past the fuse.
 */
export declare function hardDenyShellReason(source: string, shell: ShellKind, roots: PolicyRoots): string | undefined;
/**
 * Classify one Bash or PowerShell call after hard-deny evaluation.
 *
 * A compound line is assessed segment by segment. Syntax alone never blocks
 * semantic classification: only a segment this policy cannot read statically —
 * a nested interpreter, a dynamic destructive target, or an opaque construct —
 * falls back to one-shot human approval.
 */
export declare function assessShell(source: string, shell: ShellKind, roots: PolicyRoots, artifacts: ArtifactRegistry, owner: object | undefined): Assessment;
//# sourceMappingURL=shell.d.ts.map