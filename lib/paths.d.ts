/** Fully resolved roots used by deterministic policy. */
export interface PolicyRoots {
    readonly workspace: string;
    readonly home: string;
    readonly dshHome: string;
    readonly tempRoots: readonly string[];
}
/** Optional root overrides from plugin configuration. */
export interface RootOptions {
    readonly workspaceRoot?: string;
    readonly dshHome?: string;
    readonly tempRoots?: readonly string[];
    readonly home?: string;
}
/** Collapse Win32/NT namespace aliases before any containment decision. */
export declare function canonicalizeWindowsNamespace(input: string): string;
/** Canonicalize macOS system symlink spellings without filesystem I/O. */
export declare function canonicalizePosixSystemAlias(path: string, platform?: NodeJS.Platform): string;
/** Normalize an absolute or cwd-relative user path without following links. */
export declare function normalizePath(input: string, cwd: string, userHome?: string): string;
/** Resolve runtime roots from the active workspace and current process environment. */
export declare function resolveRoots(activeWorkspace: string | undefined, options?: RootOptions): PolicyRoots;
/** Whether target equals root or is contained below it. */
export declare function isWithin(root: string, target: string): boolean;
/** Whether a path is a POSIX, drive, or UNC filesystem root. */
export declare function isFilesystemRoot(target: string): boolean;
/** Whether a target belongs to an operating-system or credential-critical tree. */
export declare function isCriticalPath(target: string, roots: PolicyRoots): boolean;
/** Whether a workspace path is protected metadata rather than ordinary project content. */
export declare function isProtectedProjectPath(target: string, roots: PolicyRoots): boolean;
/** Deterministic destructive-target fuse. */
export declare function hardDestructiveTargetReason(target: string, roots: PolicyRoots): string | undefined;
/** Whether a path is eligible for observed session-artifact cleanup. */
export declare function isArtifactArea(target: string, roots: PolicyRoots): boolean;
//# sourceMappingURL=paths.d.ts.map