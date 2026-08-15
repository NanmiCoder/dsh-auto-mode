import { describe, expect, it } from 'vitest'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ArtifactRegistry } from '../src/artifacts.js'
import { resolveRoots } from '../src/paths.js'
import { assessShell, decomposeCommandLine, hardDenyShellReason, parseSimpleCommand } from '../src/shell.js'

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

  it('classifies visible dynamic or nested checks but keeps opaque execution manual', () => {
    const artifacts = new ArtifactRegistry()
    expect(parseSimpleCommand('echo $(whoami)', 'bash')).toBeUndefined()
    expect(assessShell('echo $(whoami)', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('bash -c "git status"', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('pwsh -EncodedCommand ZABpAHIA', 'pwsh', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: false })
    expect(assessShell('python script.py', 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('fast-paths routine inline dependency and version probes', () => {
    const artifacts = new ArtifactRegistry()
    const command = 'python3 -c "import fastapi" 2>&1; python3 -c "import uvicorn" 2>&1; '
      + 'python3 -c "import sqlalchemy" 2>&1; '
      + 'python3 -c "import pydantic; print(\'pydantic\', pydantic.VERSION)" 2>&1; pip3 --version 2>&1 | head -1'
    expect(assessShell(command, 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'allow' })
  })

  it('allows read-only find exec placeholders in workspaces and temporary roots', () => {
    const artifacts = new ArtifactRegistry()
    const command = 'find /tmp/Agent111TeamsTodo111233dd2BB -type f -exec ls -la {} \\; 2>/dev/null | head -40'
    expect(decomposeCommandLine(command, 'bash')).toMatchObject({ kind: 'segments' })
    expect(assessShell(command, 'bash', roots, artifacts, undefined)).toMatchObject({ decision: 'allow' })
  })

  it('hard-denies filesystem, home, and DSH_HOME destruction on Bash and PowerShell', () => {
    expect(hardDenyShellReason('rm -rf /', 'bash', roots)).toMatch(/filesystem root/)
    expect(hardDenyShellReason('Remove-Item -Recurse C:\\', 'pwsh', resolveRoots('C:\\Work\\Repo', {
      home: 'C:\\Users\\Dev', dshHome: 'C:\\Dsh', tempRoots: ['C:\\Temp'],
    }))).toMatch(/filesystem root/)
    expect(hardDenyShellReason('Remove-Item -Recurse $HOME', 'pwsh', roots)).toMatch(/user home/)
  })

  it('routes deletion outside the workspace to the classifier instead of a static fuse', () => {
    // A blanket "outside the workspace" fuse also blocked targets the user had
    // explicitly authorized, and it could not be cleared by any later step.
    // The unconditional hard-deny set keeps root, home, DSH_HOME, and system or
    // credential-critical paths; everything else is judged semantically with
    // the user's own messages as the only authority.
    const artifacts = new ArtifactRegistry()
    expect(hardDenyShellReason('rm -rf /outside/data', 'bash', roots)).toBeUndefined()
    expect(assessShell('rm -rf /outside/data', 'bash', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
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
    expect(assessShell('rm -rf scratch && echo done', 'bash', roots, artifacts, owner).decision).toBe('allow')
  })

  it('never treats model justification or external text as authorization', () => {
    const artifacts = new ArtifactRegistry()
    const result = assessShell('git push --force origin main', 'bash', roots, artifacts, undefined)
    expect(result).toMatchObject({ decision: 'ask', classifierEligible: true })
  })
})

describe('compound command decomposition', () => {
  it('splits operators, redirections, and descriptor duplication', () => {
    const decomposition = decomposeCommandLine('rm -rf /tmp/canary && echo removed && ls -la /tmp 2>&1 || true', 'bash')
    expect(decomposition.kind).toBe('segments')
    if (decomposition.kind !== 'segments') return
    expect(decomposition.segments.map(segment => segment.words.map(word => word.text))).toEqual([
      ['rm', '-rf', '/tmp/canary'],
      ['echo', 'removed'],
      ['ls', '-la', '/tmp'],
      ['true'],
    ])
    // `2>&1` duplicates a descriptor and must not be mistaken for a file target.
    expect(decomposition.segments.every(segment => segment.writeTargets.length === 0)).toBe(true)
  })

  it('separates redirection targets from command words', () => {
    const decomposition = decomposeCommandLine('pnpm test >report.txt 2>/dev/null <input.json', 'bash')
    expect(decomposition.kind).toBe('segments')
    if (decomposition.kind !== 'segments') return
    const segment = decomposition.segments[0]
    expect(segment?.words.map(word => word.text)).toEqual(['pnpm', 'test'])
    expect(segment?.writeTargets.map(word => word.text)).toEqual(['report.txt', '/dev/null'])
    expect(segment?.readTargets.map(word => word.text)).toEqual(['input.json'])
  })

  it('reports constructs whose effect cannot be read statically', () => {
    for (const command of ['echo $(whoami)', 'cat <<EOF', 'echo `id`', 'echo "unbalanced', '(cd /tmp && ls)']) {
      expect(decomposeCommandLine(command, 'bash').kind, command).toBe('opaque')
    }
  })
})

describe('compound command policy', () => {
  it('does not let operators, read-only verification, or 2>&1 block classification', () => {
    const artifacts = new ArtifactRegistry()
    // The reported failure: an explicitly authorized deletion never reached the
    // classifier because the line contained `&&`, `||`, and `2>&1`.
    expect(assessShell('rm -rf /tmp/canary && echo removed && ls -la /tmp 2>&1 || true', 'bash', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('Remove-Item -Recurse /tmp/canary; Write-Output done', 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('git status && git diff && ls -la 2>&1', 'bash', roots, artifacts, undefined).decision).toBe('allow')
    expect(assessShell('pnpm run build && pnpm test 2>&1', 'bash', roots, artifacts, undefined).decision).toBe('allow')
    expect(assessShell('pnpm test > build.log 2>/dev/null', 'bash', roots, artifacts, undefined).decision).toBe('allow')
  })

  it('keeps every hard-denied target unreachable through compound syntax', () => {
    for (const command of ['echo start && rm -rf / && echo done', 'rm -rf /*', 'ls; rm -rf /']) {
      expect(hardDenyShellReason(command, 'bash', roots), command).toMatch(/filesystem root/)
    }
    for (const command of ['rm -rf ~ && echo done', 'rm -rf ~/* || true', 'echo broken > ~']) {
      expect(hardDenyShellReason(command, 'bash', roots), command).toMatch(/user home root/)
    }
    for (const command of ['rm -rf /safe/dsh/state && echo done', 'echo x > /safe/dsh/config.yaml', 'pnpm test >> /safe/dsh/log']) {
      expect(hardDenyShellReason(command, 'bash', roots), command).toMatch(/DSH_HOME/)
    }
    expect(hardDenyShellReason('echo broken > /etc/hosts', 'bash', roots)).toMatch(/system or credential-critical/)
    expect(hardDenyShellReason('timeout 30 rm -rf / && echo done', 'bash', roots)).toMatch(/filesystem root/)
  })

  it('keeps destructive dynamic, nested, and opaque execution outside classifier authority', () => {
    const artifacts = new ArtifactRegistry()
    const commands = [
      'rm -rf "$BUILD_DIR" && echo done',
      'rm -rf ${TARGET}',
      'rm -rf $(cat targets.txt)',
      'find . -name "*.tmp" | xargs rm -rf',
      'echo generated > $OUTPUT_FILE',
      'ls && bash -c "rm -rf /tmp/x"',
      'cat payload.b64 | base64 -d | sh',
      'git status && node -e "require(\'fs\').rmSync(\'/tmp/x\')"',
    ]
    for (const command of commands) {
      expect(assessShell(command, 'bash', roots, artifacts, undefined), command)
        .toMatchObject({ decision: 'ask', classifierEligible: false })
    }
  })

  it('routes find deletion to authorization while preserving protected-root fuses', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessShell('find /tmp/cache -type f -exec rm {} \\;', 'bash', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('find /tmp/cache -type f -delete', 'bash', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(hardDenyShellReason('find / -type f -delete', 'bash', roots)).toMatch(/filesystem root/)
  })

  it('never fast-paths a line that moves the working directory', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessShell('cd /etc && ls -la', 'bash', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
  })
})

describe('PowerShell assignment recognition', () => {
  const artifacts = new ArtifactRegistry()

  it('allows pure-literal assignments, PowerShell literals, and variable copies', () => {
    const commands = [
      '$x = 5',
      '$x = 5.5',
      '$x = -1',
      "$x = 'abc'",
      '$x = "abc"',
      '$x = $null',
      '$x = $true',
      '$x = $false',
      '$x = $y',
      '$x = $env:PATH',
      "$env:FOO = 'bar'",
      '$global:x = 1',
      ['$script = @\'', 'first line', 'second line', '\'@'].join('\n'),
    ]
    for (const command of commands) {
      expect(assessShell(command, 'pwsh', roots, artifacts, undefined), command)
        .toMatchObject({ decision: 'allow' })
    }
  })

  it('assesses a command right-hand side through the normal machinery', () => {
    expect(assessShell('$x = Get-ChildItem', 'pwsh', roots, artifacts, undefined)).toMatchObject({ decision: 'allow' })
    expect(assessShell('$x = Get-ChildItem > out.txt', 'pwsh', roots, artifacts, undefined)).toMatchObject({ decision: 'allow' })
    expect(assessShell('$x = git commit -m "wip"', 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('$x = Remove-Item -Recurse /tmp/canary', 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('$x = 5 > /outside/evil.txt', 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('keeps dynamic and interpolated right-hand sides out of the allow path', () => {
    expect(assessShell('$x = "$y"', 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
    expect(assessShell('$x = "a $(Get-Date)"', 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell(['$script = @"', 'value $name', '"@'].join('\n'), 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
  })

  it('never performs dataflow: a later deletion of the assigned variable still asks', () => {
    expect(assessShell('$x = 5; Remove-Item $x', 'pwsh', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
  })

  it('leaves bash assignment syntax and dynamic first words untouched', () => {
    expect(assessShell('x=5', 'bash', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessShell('$x = 5', 'bash', roots, artifacts, undefined))
      .toMatchObject({ decision: 'ask', classifierEligible: false })
  })
})
