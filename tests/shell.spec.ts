import { describe, expect, it } from 'vitest'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ArtifactRegistry } from '../src/artifacts.js'
import { resolveRoots } from '../src/paths.js'
import { assessShell, hardDenyShellReason, parseSimpleCommand } from '../src/shell.js'

const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })

describe('shell policy', () => {
  it('allows narrow read and build commands', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessShell('git status', 'bash', roots, artifacts, undefined).decision).toBe('allow')
    expect(assessShell('pnpm test', 'bash', roots, artifacts, undefined).decision).toBe('allow')
    expect(assessShell('Get-ChildItem .', 'pwsh', roots, artifacts, undefined).decision).toBe('allow')
    expect(assessShell('pnpm --version', 'bash', roots, artifacts, undefined).decision).toBe('allow')
    expect(assessShell('od -c output.txt', 'bash', roots, artifacts, undefined).decision).toBe('allow')
  })

  it('asks on dynamic, nested, or unrecognized syntax', () => {
    const artifacts = new ArtifactRegistry()
    expect(parseSimpleCommand('echo $(whoami)', 'bash')).toBeUndefined()
    expect(assessShell('echo $(whoami)', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: false })
    expect(assessShell('bash -c "git status"', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: false })
    expect(assessShell('pwsh -EncodedCommand ZABpAHIA', 'pwsh', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: false })
    expect(assessShell('python script.py', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('hard-denies root and external recursive deletion on Bash and PowerShell', () => {
    expect(hardDenyShellReason('rm -rf /', 'bash', roots)).toMatch(/filesystem root/)
    expect(hardDenyShellReason('rm -rf /outside/data', 'bash', roots)).toMatch(/outside the workspace/)
    expect(hardDenyShellReason('Remove-Item -Recurse C:\\', 'pwsh', resolveRoots('C:\\Work\\Repo', {
      home: 'C:\\Users\\Dev', dshHome: 'C:\\Dsh', tempRoots: ['C:\\Temp'],
    }))).toMatch(/filesystem root/)
    expect(hardDenyShellReason('Remove-Item -Recurse $HOME', 'pwsh', roots)).toMatch(/user home/)
  })

  it('requires approval for pre-session deletion but allows exact live artifacts', () => {
    const artifacts = new ArtifactRegistry()
    const owner = {}
    expect(assessShell('rm -rf scratch', 'bash', roots, artifacts, owner)).toMatchObject({ decision: 'ask', classifierEligible: true })
    const exec = { name: 'write', token: Symbol('write'), agent: { session: owner } } as unknown as ToolExecution
    const result = {
      isError: false,
      value: { operation: 'create', path: '/work/repo/scratch' },
      content: [],
    } as unknown as ToolExecutionResult
    artifacts.settle(exec, result, roots)
    expect(assessShell('rm -rf scratch', 'bash', roots, artifacts, owner).decision).toBe('allow')
  })

  it('never treats model justification or external text as authorization', () => {
    const artifacts = new ArtifactRegistry()
    const result = assessShell('git push --force origin main', 'bash', roots, artifacts, undefined)
    expect(result).toMatchObject({ decision: 'ask', classifierEligible: true })
  })
})
