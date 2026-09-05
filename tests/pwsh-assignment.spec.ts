import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArtifactRegistry } from '../src/artifacts.js'
import { normalizePath, resolveRoots } from '../src/paths.js'
import { assessShell, hardDenyShellReason } from '../src/shell.js'

const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
const artifacts = new ArtifactRegistry()
const assess = (source: string) => assessShell(source, 'pwsh', roots, artifacts, undefined)

describe('PowerShell assignment policy', () => {
  // PR #3 reported the original false approval for a dynamic assignment target.
  it.each([
    '$x = 5', '$x = -1', '$x = 5.5', '$x = .5', '$x = 1e-3',
    "$x = 'abc'", '$x = "abc"', "$x = 'terraform'",
    '$x = $null', '$x = $TRUE', '$x = $false', '$x = $value',
    '$script:x = $local:value', "$env:DSH_FAKE_SETTING = 'fixture'",
  ])('allows a non-executing value: %s', (source) => {
    expect(assess(source)).toMatchObject({ decision: 'allow', classifierEligible: false })
  })

  it.each(['psql', "p's'ql", 'ku"be"ctl', 'Invoke-Expression'])('evaluates a bare or partly quoted RHS as a command: %s', (command) => {
    const direct = assess(command)
    expect(direct).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assess(`$x = ${command}`)).toEqual(direct)
  })

  it.each([
    'Get-ChildItem .',
    'Remove-Item old-output',
    'git reset --hard HEAD',
    'Invoke-RestMethod https://example.invalid/api -Method Post -Body fixture',
    'New-Item -Path generated.txt -ItemType File',
  ])('preserves the normal command decision and filesystem facts: %s', (command) => {
    expect(assess(`$x = ${command}`)).toEqual(assess(command))
  })

  it.each([
    'Remove-Item -Recurse /',
    'Remove-Item -Recurse /home/dev',
    'Remove-Item -Recurse /safe/dsh',
    'Remove-Item -Recurse $env:USERPROFILE',
  ])('keeps protected deletion in the unconditional guard: %s', (command) => {
    const source = `$outer = $inner = ${command}`
    expect(hardDenyShellReason(source, 'pwsh', roots)).toBeDefined()
    expect(assess(source)).toMatchObject({ decision: 'deny', classifierEligible: false })
  })

  it('keeps Windows root deletion protected through assignments', () => {
    const windows = resolveRoots('C:\\work\\repo', {
      home: 'C:\\Users\\dev', dshHome: 'C:\\dsh', tempRoots: ['C:\\Temp'],
    })
    const source = '$x = Remove-Item -Recurse C:\\'
    expect(hardDenyShellReason(source, 'pwsh', windows)).toBeDefined()
    expect(assessShell(source, 'pwsh', windows, artifacts, undefined)).toMatchObject({ decision: 'deny' })
  })

  it.each([
    '$x = Remove-Item $target',
    '$x = Remove-Item *.txt',
    '$x = Remove-Item first.txt second.txt',
    '$x = 5; Remove-Item $x',
    '$x = & $command',
    '$x = Invoke-Expression $code',
    '$x = pwsh -Command $code',
    '$x = "$(Remove-Item old-output)"',
  ])('does not authorize hidden execution or deletion through assignment: %s', (source) => {
    expect(assess(source)).toMatchObject({ decision: 'deny', classifierEligible: false })
  })

  it.each([
    'pwsh -co $code',
    'pwsh -Com $code',
    'pwsh -CommandWithArgs $code',
    'pwsh -Command:$code',
    'node --eval=$code',
    'node -e$code',
    'python -c$code',
    'bash -lc $code',
    'node --unrecognized-inline-option $code',
  ])('denies dynamic code with attached, abbreviated or unknown interpreter flags: %s', (command) => {
    expect(assess(command)).toMatchObject({ decision: 'deny', classifierEligible: false })
    expect(assess(`$x = ${command}`)).toMatchObject({ decision: 'deny', classifierEligible: false })
  })

  it.each([
    'pwsh -co "Write-Output fixture"',
    'pwsh -CommandWithArgs "Write-Output fixture"',
    'node --unrecognized-inline-option fixture',
  ])('reviews an interpreter whose inline source cannot be determined: %s', (command) => {
    expect(assess(`$x = ${command}`)).toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it.each([
    'node script.js --eval $value',
    'node --test',
    'node --test verify.test.mjs',
    'python script.py -c $value',
    'bash script.sh -c $value',
    'pwsh -File script.ps1 -Command $value',
    'pwsh -NoProfile -NonInteractive -File script.ps1 -Name $value',
    'pwsh script.ps1 -Name $value',
  ])('keeps arguments of a literal script separate from interpreter source: %s', (command) => {
    expect(assess(`$x = ${command}`)).toMatchObject({ decision: 'allow', classifierEligible: false })
  })

  it.each([
    '$x = $env:PATH',
    '$x = $ENV:DSH_FAKE_TOKEN',
    '$x = ${env:DSH_FAKE_VALUE}',
    '$x = "$env:DSH_FAKE_VALUE"',
    '$x = $PASSWORD',
    '$x = Get-Content /home/dev/.ssh/id_rsa',
  ])('keeps sensitive variable or environment reads reviewed: %s', (source) => {
    expect(assess(source)).toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('does not infer a value for incomplete or interpolated assignments', () => {
    expect(assess('$x =')).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assess('$x = "$value"')).toMatchObject({ decision: 'deny', classifierEligible: false })
  })

  it('retains redirection protection on literal and command RHS values', () => {
    expect(assess('$x = 5 > .git/config')).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assess('$x = Get-Date > .git/config')).toEqual(assess('Get-Date > .git/config'))
    expect(assess('$x = 5 > /safe/dsh/settings.json')).toMatchObject({ decision: 'deny' })
    expect(assess("$x = node -e 'console.log(1)' > .git/config")).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assess("$x = node -e 'console.log(process.version)' > .git/config")).toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('records pre-existing and newly created redirect destinations without executing a command', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-pwsh-assignment-'))
    try {
      const local = resolveRoots(workspace, { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: [workspace] })
      const existing = normalizePath(join(workspace, 'existing.txt'), workspace)
      const created = normalizePath(join(workspace, 'created.txt'), workspace)
      await writeFile(existing, 'fixture only\n')
      expect(assessShell('$x = 5 > existing.txt', 'pwsh', local, artifacts, undefined)).toMatchObject({
        decision: 'allow', filesystemEffects: [{ kind: 'create-or-overwrite', path: existing, existedBefore: true }],
      })
      expect(assessShell('$x = Get-Date > created.txt', 'pwsh', local, artifacts, undefined)).toMatchObject({
        decision: 'allow', plannedCreates: [created],
        filesystemEffects: [{ kind: 'create-or-overwrite', path: created, existedBefore: false }],
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('leaves Bash assignment and dynamic executable rules unchanged', () => {
    expect(assessShell('x=5', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'allow' })
    expect(assessShell('$x = 5', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'deny' })
  })

  it('does not mistake inherited object keys for interpreter names', () => {
    expect(assess('$x = constructor')).toMatchObject({ decision: 'allow', classifierEligible: false })
  })
})
