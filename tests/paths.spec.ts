import { describe, expect, it } from 'vitest'
import {
  canonicalizePosixSystemAlias,
  canonicalizeWindowsNamespace,
  extractApplyPatchPaths,
  hardDestructiveTargetReason,
  isFilesystemRoot,
  isProtectedProjectPath,
  isWithin,
  normalizePath,
  resolveRoots,
} from '../src/paths.js'

describe('path policy', () => {
  it('normalizes POSIX traversal and checks containment', () => {
    expect(normalizePath('../file', '/work/project/sub', '/home/test')).toBe('/work/project/file')
    expect(normalizePath('/work/project/file', 'C:\\host\\cwd', 'C:\\Users\\Dev')).toBe('/work/project/file')
    expect(isWithin('/work/project', '/work/project/src/index.ts')).toBe(true)
    expect(isWithin('/work/project', '/work/project-evil/file')).toBe(false)
    expect(isWithin('/work/project', 'C:\\work\\project\\src\\index.ts')).toBe(false)
  })

  it('treats macOS /tmp, /var, and /etc aliases as their /private targets', () => {
    expect(canonicalizePosixSystemAlias('/tmp/project/file', 'darwin')).toBe('/private/tmp/project/file')
    expect(canonicalizePosixSystemAlias('/var/folders/cache', 'darwin')).toBe('/private/var/folders/cache')
    expect(canonicalizePosixSystemAlias('/etc/hosts', 'darwin')).toBe('/private/etc/hosts')
    expect(canonicalizePosixSystemAlias('/tmp/project/file', 'linux')).toBe('/tmp/project/file')
  })

  it('normalizes Windows drive letters case-insensitively', () => {
    expect(normalizePath('C:\\Work\\Repo\\..\\Repo\\File.ts', 'C:\\Work\\Repo', 'C:\\Users\\Dev'))
      .toBe('c:\\work\\repo\\file.ts')
    expect(normalizePath('src\\x.ts', 'C:\\Work\\Repo', 'C:\\Users\\Dev')).toBe('c:\\work\\repo\\src\\x.ts')
    expect(isWithin('C:\\Work\\Repo', 'c:\\work\\repo\\src\\x.ts')).toBe(true)
    expect(isFilesystemRoot('C:\\')).toBe(true)
  })

  it('canonicalizes Windows namespace aliases before policy checks', () => {
    expect(canonicalizeWindowsNamespace('\\\\?\\C:\\Windows\\System32')).toBe('C:\\Windows\\System32')
    expect(canonicalizeWindowsNamespace('\\??\\C:\\Windows\\System32')).toBe('C:\\Windows\\System32')
    expect(canonicalizeWindowsNamespace('\\\\?\\UNC\\server\\share\\dir')).toBe('\\\\server\\share\\dir')
    expect(normalizePath('\\\\?\\C:\\Windows\\System32', 'C:\\Work\\Repo', 'C:\\Users\\Dev'))
      .toBe('c:\\windows\\system32')
  })

  it('hard-denies Windows drive-relative and reserved-device mutation targets', () => {
    const windowsRoots = resolveRoots('C:\\Work\\Repo', {
      home: 'C:\\Users\\Dev', dshHome: 'C:\\Users\\Dev\\.dsh', tempRoots: ['C:\\Temp'],
    })
    expect(hardDestructiveTargetReason('\\\\?\\C:\\Windows\\System32\\config\\SAM', windowsRoots)).toMatch(/critical/)
    expect(hardDestructiveTargetReason('\\??\\C:\\Windows\\System32\\config\\SAM', windowsRoots)).toMatch(/critical/)
    expect(hardDestructiveTargetReason('C:..\\..\\Windows\\System32\\config\\SAM', windowsRoots)).toMatch(/drive-relative/)
    expect(hardDestructiveTargetReason('C:\\Work\\Repo\\CON', windowsRoots)).toMatch(/reserved device/)
    expect(hardDestructiveTargetReason('C:\\Work\\Repo\\con.txt', windowsRoots)).toMatch(/reserved device/)
  })

  it('hard-denies Windows namespace, trailing-segment, and 8.3 critical aliases', () => {
    const windowsRoots = resolveRoots('C:\\Work\\Repo', {
      home: 'C:\\Users\\Dev', dshHome: 'C:\\Users\\Dev\\.dsh', tempRoots: ['C:\\Temp'],
    })
    expect(hardDestructiveTargetReason('C:\\Windows.\\System32\\config\\SAM', windowsRoots)).toMatch(/critical/)
    expect(hardDestructiveTargetReason('C:\\Windows \\System32\\config\\SAM', windowsRoots)).toMatch(/critical/)
    expect(hardDestructiveTargetReason('C:\\PROGRA~1\\probe.txt', windowsRoots)).toMatch(/critical/)
    expect(hardDestructiveTargetReason('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Windows', windowsRoots)).toMatch(/device namespace/)
    expect(hardDestructiveTargetReason('\\Device\\HarddiskVolume1\\Windows', windowsRoots)).toMatch(/object namespace/)
  })

  it('hard-denies root, DSH_HOME, and credential trees', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    expect(hardDestructiveTargetReason('/', roots)).toMatch(/filesystem root/)
    expect(hardDestructiveTargetReason('/safe/dsh/profiles', roots)).toMatch(/DSH_HOME/)
    expect(hardDestructiveTargetReason('/home/dev/.ssh/id_ed25519', roots)).toMatch(/critical/)
    expect(hardDestructiveTargetReason('/work/repo/src/a.ts', roots)).toBeUndefined()
  })

  it('extracts single-file modification paths from a patch', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 0123..4567 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/a.ts'])
  })

  it('records new file paths from --- /dev/null + +++ b/<path>', () => {
    const patch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/src/new.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/new.ts'])
  })

  it('records deleted file paths from --- a/<path> + +++ /dev/null', () => {
    const patch = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index 1234567..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/old.ts'])
  })

  it('records all target paths in a multi-file patch, deduplicated, in order', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old2',
      '+new2',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('records the destination path from rename from/rename to pairs', () => {
    const patch = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 100%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['src/new-name.ts'])
  })

  it('returns [] for an unparseable patch (no +++ pair)', () => {
    expect(extractApplyPatchPaths('--- a/x\n@@ -1 +1 @@\n-old\n')).toEqual([])
  })

  it('returns [] when patch text is empty or non-string', () => {
    expect(extractApplyPatchPaths('')).toEqual([])
    // @ts-expect-error: runtime contract accepts unknown inputs safely.
    expect(extractApplyPatchPaths(undefined)).toEqual([])
  })

  it('strips the optional leading a/ or b/ from recorded paths', () => {
    const patch = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['foo.ts'])
  })

  it('preserves raw paths (no normalization applied)', () => {
    const patch = [
      '--- a/CAPS.ts',
      '+++ b/CAPS.ts',
    ].join('\n')
    expect(extractApplyPatchPaths(patch)).toEqual(['CAPS.ts'])
  })
})
