import { describe, expect, it } from 'vitest'
import {
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

  it('normalizes Windows drive letters case-insensitively', () => {
    expect(normalizePath('C:\\Work\\Repo\\..\\Repo\\File.ts', 'C:\\Work\\Repo', 'C:\\Users\\Dev'))
      .toBe('c:\\work\\repo\\file.ts')
    expect(isWithin('C:\\Work\\Repo', 'c:\\work\\repo\\src\\x.ts')).toBe(true)
    expect(isFilesystemRoot('C:\\')).toBe(true)
  })

  it('hard-denies root, DSH_HOME, and credential trees', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    expect(hardDestructiveTargetReason('/', roots)).toMatch(/filesystem root/)
    expect(hardDestructiveTargetReason('/safe/dsh/profiles', roots)).toMatch(/DSH_HOME/)
    expect(hardDestructiveTargetReason('/home/dev/.ssh/id_ed25519', roots)).toMatch(/critical/)
    expect(hardDestructiveTargetReason('/work/repo/src/a.ts', roots)).toBeUndefined()
  })
})
