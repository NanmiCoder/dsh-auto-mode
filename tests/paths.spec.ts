import { describe, expect, it } from 'vitest'
import {
  canonicalizePosixSystemAlias,
  canonicalizeWindowsNamespace,
  hardDestructiveTargetReason,
  isFilesystemRoot,
  isWithin,
  normalizePath,
  resolveRoots,
} from '../src/paths.js'

describe('path policy', () => {
  it('normalizes POSIX traversal and checks containment', () => {
    expect(normalizePath('../file', '/work/project/sub', '/home/test')).toBe('/work/project/file')
    expect(isWithin('/work/project', '/work/project/src/index.ts')).toBe(true)
    expect(isWithin('/work/project', '/work/project-evil/file')).toBe(false)
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
})
