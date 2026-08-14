import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
function styleOf(...values) {
    return values.some(value => /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) ? 'win32' : 'posix';
}
function pathApi(style) {
    return style === 'win32' ? win32 : posix;
}
/** Normalize an absolute or cwd-relative user path without following links. */
export function normalizePath(input, cwd, userHome = homedir()) {
    const expanded = input === '~'
        ? userHome
        : input.startsWith('~/') || input.startsWith('~\\')
            ? pathApi(styleOf(userHome)).join(userHome, input.slice(2))
            : input;
    const style = styleOf(expanded, cwd);
    const api = pathApi(style);
    const absolute = api.isAbsolute(expanded) ? expanded : api.resolve(cwd, expanded);
    const normalized = api.normalize(absolute);
    return style === 'win32' ? normalized.toLowerCase() : normalized;
}
/** Resolve runtime roots from the active workspace and current process environment. */
export function resolveRoots(activeWorkspace, options = {}) {
    const home = normalizePath(options.home ?? homedir(), options.home ?? homedir(), options.home ?? homedir());
    const workspace = normalizePath(activeWorkspace ?? options.workspaceRoot ?? process.cwd(), process.cwd(), home);
    const environmentDshHome = process.env.DSH_HOME?.trim();
    const configuredDshHome = options.dshHome ?? (environmentDshHome === '' ? undefined : environmentDshHome);
    const dshHome = normalizePath(configuredDshHome ?? posix.join(home, '.dsh'), workspace, home);
    const tempRoots = (options.tempRoots ?? [tmpdir()]).map(root => normalizePath(root, workspace, home));
    return { workspace, home, dshHome, tempRoots };
}
/** Whether target equals root or is contained below it. */
export function isWithin(root, target) {
    const style = styleOf(root, target);
    const api = pathApi(style);
    const normalizedRoot = normalizePath(root, root);
    const normalizedTarget = normalizePath(target, root);
    const relative = api.relative(normalizedRoot, normalizedTarget);
    return relative === '' || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
}
/** Whether a path is a POSIX, drive, or UNC filesystem root. */
export function isFilesystemRoot(target) {
    const style = styleOf(target);
    const api = pathApi(style);
    const normalized = normalizePath(target, target);
    return api.parse(normalized).root === normalized;
}
/** Whether a target belongs to an operating-system or credential-critical tree. */
export function isCriticalPath(target, roots) {
    const normalized = normalizePath(target, roots.workspace, roots.home);
    const critical = styleOf(normalized) === 'win32'
        ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata', 'c:\\boot']
        : ['/etc', '/bin', '/sbin', '/usr', '/system', '/library', '/private/etc', '/boot'];
    const credentialRoots = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.config/gcloud']
        .map(path => normalizePath(path, roots.home, roots.home));
    return [...critical, ...credentialRoots].some(root => isWithin(root, normalized));
}
/** Whether a workspace path is protected metadata rather than ordinary project content. */
export function isProtectedProjectPath(target, roots) {
    const normalized = normalizePath(target, roots.workspace, roots.home);
    if (!isWithin(roots.workspace, normalized))
        return false;
    const style = styleOf(roots.workspace);
    const api = pathApi(style);
    const relative = api.relative(roots.workspace, normalized).replaceAll('\\', '/');
    const first = relative.split('/')[0]?.toLowerCase();
    if (first !== undefined && ['.git', '.vscode', '.idea', '.husky', '.dsh'].includes(first))
        return true;
    const base = api.basename(normalized).toLowerCase();
    return ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.mcp.json'].includes(base);
}
/** Deterministic destructive-target fuse. */
export function hardDestructiveTargetReason(target, roots) {
    const normalized = normalizePath(target, roots.workspace, roots.home);
    if (isFilesystemRoot(normalized))
        return `filesystem root ${normalized}`;
    if (normalized === roots.home)
        return `user home root ${normalized}`;
    if (isWithin(roots.dshHome, normalized))
        return `DSH_HOME path ${normalized}`;
    if (isCriticalPath(normalized, roots))
        return `system or credential-critical path ${normalized}`;
    return undefined;
}
/** Whether a path is eligible for observed session-artifact cleanup. */
export function isArtifactArea(target, roots) {
    const normalized = normalizePath(target, roots.workspace, roots.home);
    return isWithin(roots.workspace, normalized) || roots.tempRoots.some(root => isWithin(root, normalized));
}
//# sourceMappingURL=paths.js.map