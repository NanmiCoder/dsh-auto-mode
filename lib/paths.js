import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
function explicitStyleOf(value) {
    const canonical = canonicalizeWindowsNamespace(value);
    if (/^[A-Za-z]:/.test(canonical) || canonical.startsWith('\\'))
        return 'win32';
    if (canonical.startsWith('/'))
        return 'posix';
    return undefined;
}
/** Prefer the path's own explicit syntax; use cwd only for relative paths. */
function styleOf(value, cwd) {
    return explicitStyleOf(value)
        ?? (cwd === undefined ? undefined : explicitStyleOf(cwd))
        ?? (process.platform === 'win32' ? 'win32' : 'posix');
}
function pathApi(style) {
    return style === 'win32' ? win32 : posix;
}
function normalizeWindowsSegments(path) {
    const root = win32.parse(path).root;
    const tail = path.slice(root.length)
        .split('\\')
        .map(segment => segment.replace(/[ .]+$/g, ''))
        .join('\\');
    return tail === '' ? root : `${root}${tail}`;
}
function windowsDeviceNamespaceReason(input) {
    const path = input.replaceAll('/', '\\').toLowerCase();
    if (path.startsWith('\\\\.\\'))
        return `Windows device namespace ${input}`;
    if (path.startsWith('\\device\\') || path.startsWith('\\global??\\') || path.startsWith('\\dosdevices\\')) {
        return `Windows NT object namespace ${input}`;
    }
    if (path.startsWith('\\\\?\\') && !/^\\\\\?\\(?:unc\\|[a-z]:\\)/.test(path)) {
        return `Windows extended device namespace ${input}`;
    }
    if ((path.startsWith('\\??\\') || path.startsWith('\\\\??\\'))
        && !/^(?:\\\?\?\\|\\\\\?\?\\)(?:unc\\|[a-z]:\\)/.test(path)) {
        return `Windows NT device namespace ${input}`;
    }
    return undefined;
}
/** Collapse Win32/NT namespace aliases before any containment decision. */
export function canonicalizeWindowsNamespace(input) {
    const lower = input.toLowerCase();
    if (lower.startsWith('\\\\?\\unc\\'))
        return `\\\\${input.slice(8)}`;
    if (lower.startsWith('\\\\?\\'))
        return input.slice(4);
    if (lower.startsWith('\\\\??\\'))
        return input.slice(5);
    if (lower.startsWith('\\??\\'))
        return input.slice(4);
    return input;
}
/** Canonicalize macOS system symlink spellings without filesystem I/O. */
export function canonicalizePosixSystemAlias(path, platform = process.platform) {
    if (platform !== 'darwin')
        return path;
    for (const alias of ['/tmp', '/var', '/etc']) {
        if (path === alias || path.startsWith(`${alias}/`))
            return `/private${path}`;
    }
    return path;
}
/** Normalize an absolute or cwd-relative user path without following links. */
export function normalizePath(input, cwd, userHome = homedir()) {
    const canonicalInput = canonicalizeWindowsNamespace(input);
    const expanded = canonicalInput === '~'
        ? userHome
        : canonicalInput.startsWith('~/') || canonicalInput.startsWith('~\\')
            ? pathApi(styleOf(userHome)).join(userHome, canonicalInput.slice(2))
            : canonicalInput;
    const style = styleOf(expanded, cwd);
    const api = pathApi(style);
    const absolute = api.isAbsolute(expanded) ? expanded : api.resolve(cwd, expanded);
    const normalized = api.normalize(absolute);
    return style === 'win32' ? normalizeWindowsSegments(normalized).toLowerCase() : canonicalizePosixSystemAlias(normalized);
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
    const normalizedRoot = normalizePath(root, root);
    const normalizedTarget = normalizePath(target, root);
    const style = styleOf(normalizedRoot);
    if (styleOf(normalizedTarget) !== style)
        return false;
    const api = pathApi(style);
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
    const windowsCritical = /^[a-z]:\\(?:windows|window~\d+|program files|program files \(x86\)|programdata|progra~\d+|boot)(?:\\|$)/i.test(normalized);
    const critical = styleOf(normalized) === 'win32'
        ? []
        : ['/etc', '/bin', '/sbin', '/usr', '/system', '/library', '/private/etc', '/boot'];
    const credentialRoots = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.config/gcloud']
        .map(path => normalizePath(path, roots.home, roots.home));
    return windowsCritical || [...critical, ...credentialRoots].some(root => isWithin(root, normalized));
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
    const namespaceReason = windowsDeviceNamespaceReason(target);
    if (namespaceReason !== undefined)
        return namespaceReason;
    const canonicalTarget = canonicalizeWindowsNamespace(target);
    if (/^[A-Za-z]:(?![\\/])/.test(canonicalTarget))
        return `ambiguous Windows drive-relative path ${canonicalTarget}`;
    const normalized = normalizePath(target, roots.workspace, roots.home);
    if (isFilesystemRoot(normalized))
        return `filesystem root ${normalized}`;
    if (styleOf(normalized) === 'win32') {
        const hasReservedDevice = normalized.split(/[\\/]/).some((segment) => {
            const base = segment.replace(/[ .]+$/g, '').split('.')[0];
            return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base ?? '');
        });
        if (hasReservedDevice)
            return `Windows reserved device path ${normalized}`;
    }
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