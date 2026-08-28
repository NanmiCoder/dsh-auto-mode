import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SandboxPwshExecutor from '@deepseek-ai/dsh-pwsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import ToolRuntime, { type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as AutoMode from '../src/index.js'
import type { ClassifierInput } from '../src/types.js'

const nativePwshPath = process.platform === 'win32'
  ? [
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'pwsh',
    ].find(candidate => candidate === 'pwsh' || existsSync(candidate)) ?? 'pwsh'
  : 'pwsh'
const nativeWindowsPwsh = process.platform === 'win32'
  && spawnSync(nativePwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], {
    timeout: 5_000,
    stdio: 'ignore',
  }).status === 0

function pwshQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

interface WindowsHarness {
  readonly workspace: string
  readonly outside: string
  readonly classifierCalls: ClassifierInput[]
  readonly events: Array<{ type: string; data?: Record<string, unknown> }>
  run(callId: string, command: string, options?: { escalate?: boolean; sandboxArguments?: Record<string, unknown> }): Promise<ToolExecutionResult>
}

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createWindowsHarness(userMessage: string | ((outside: string) => string)): Promise<WindowsHarness> {
  const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
  const workspace = await mkdtemp(join(homedir(), 'dsh-auto-windows-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-auto-windows-outside-'))
  tempDirs.push(workspace, outside)
  const classifierCalls: ClassifierInput[] = []
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [
    { type: 'turn/start' },
    { type: 'permission/preset', data: { preset: 'auto' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
    {
      type: 'user/message',
      data: {
        id: 'windows-business-user-message',
        role: 'user',
        content: [{ type: 'text', text: typeof userMessage === 'function' ? userMessage(outside) : userMessage }],
        source: { kind: 'user' },
      },
    },
  ]
  const context = new Context()
  contexts.push(context)
  context.provide('agents', { get: () => undefined })
  context.provide('llm', {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const block = options.messages[0]?.content[0]
      const input = JSON.parse(block?.type === 'text' ? block.text : '{}') as ClassifierInput
      classifierCalls.push(input)
      const command = (input.arguments as { command?: string } | undefined)?.command ?? ''
      const directMessages = input.trustedUserMessages.join('\n')
      const createOnlyOutside = input.filesystemEffects !== undefined
        && input.filesystemEffects.length > 0
        && input.filesystemEffects.every(effect => effect.kind === 'create-or-overwrite' && !effect.existedBefore)
        && directMessages.includes(outside)
        && /(?:导出|写入|export|write|save)/i.test(directMessages)
      const authorizedEscalation = input.sandboxRequest !== undefined
        && (createOnlyOutside || input.trustedUserMessages.some(message => message.includes(outside) && /授权|authoriz/i.test(message)))
      const decision = authorizedEscalation
        ? { decision: 'allow', reason: 'the direct user authorized this exact Windows fixture write' }
        : input.sandboxRequest !== undefined || /remove-item/i.test(command)
          ? { decision: 'deny', reason: 'the Windows side effect lacks exact direct-user authorization' }
          : { decision: 'allow', reason: 'routine workspace-contained PowerShell' }
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify(decision) } as const
        yield { type: 'finish', reason: { kind: 'stop' } } as const
      })()
    },
  })
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime)
  await context.plugin(ApprovalService, { policy: 'ask' })
  await context.plugin(LocalSandboxProvider, {})
  await context.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(SandboxPwshExecutor, { cwd: workspace, timeoutMs: 30_000 })
  await context.plugin(ShellEnv)
  await context.plugin(ToolPwsh, { enableRunInBackground: false })
  await context.plugin(AutoMode, { workspaceRoot: workspace, dshHome: join(workspace, '.dsh') })

  const sessionId = 'windows-business-session'
  const agent = {
    id: sessionId,
    options: { provider: 'mock-provider', model: 'mock-model' },
    session: {
      id: sessionId,
      header: { version: 0, id: sessionId, createdAt: 0, cwd: workspace },
      events,
      requestHeader: () => ({ config: { provider: 'mock-provider', model: 'mock-model' } }),
      append(type: string, data: Record<string, unknown>) {
        const event = { type, data }
        events.push(event)
        return event
      },
    },
  } as unknown as NonNullable<ToolExecutionInput['agent']>

  return {
    workspace,
    outside,
    classifierCalls,
    events,
    run(callId, command, options = {}) {
      const sandboxArguments = options.sandboxArguments ?? (options.escalate === true ? {
        sandbox_permissions: 'danger-full-access',
        justification: 'write the explicitly requested Windows fixture ' + outside,
      } : {})
      return context.tools.execute({
        callId: CallId(callId),
        name: 'pwsh',
        arguments: {
          command,
          description: 'native Windows business scenario command',
          ...sandboxArguments,
        },
        agent,
        signal: new AbortController().signal,
      })
    },
  }
}

describe.skipIf(!nativeWindowsPwsh)('Auto business flows through the real Windows ACL sandbox', () => {
  it('rejects redundant workspace-write requests before classifier, approval, and PowerShell body activity', async () => {
    const harness = await createWindowsHarness('继续执行普通的 Windows 工作区操作。')
    const target = join(harness.outside, 'redundant-must-not-exist.txt')
    const variants: Array<Record<string, unknown>> = [
      { sandbox_permissions: 'workspace-write' },
      { sandbox_permissions: 'workspace-write', justification: '' },
      { sandbox_permissions: 'workspace-write', justification: ' ' + String.fromCharCode(9) + ' ' },
      { sandbox_permissions: 'workspace-write', justification: 'the model repeated the standing mode' },
    ]
    for (const [index, sandboxArguments] of variants.entries()) {
      const result = await harness.run('windows-redundant-' + index, 'Set-Content -LiteralPath ' + pwshQuote(target) + ' -Value blocked', {
        sandboxArguments,
      })
      expect(result.isError, JSON.stringify(sandboxArguments)).toBe(true)
    }
    expect(existsSync(target)).toBe(false)
    expect(harness.classifierCalls).toEqual([])
    expect(harness.events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
  }, 60_000)

  it('retries a redundant request successfully after removing both sandbox fields', async () => {
    const harness = await createWindowsHarness('在当前 Windows 工作区内生成并验证结果。')
    const target = join(harness.workspace, 'fieldless-retry.txt')
    const redundant = await harness.run('windows-redundant-before-retry', 'Set-Content -LiteralPath ' + pwshQuote(target) + ' -Value blocked', {
      sandboxArguments: {
        sandbox_permissions: 'workspace-write',
        justification: 'standing mode is already workspace-write',
      },
    })
    expect(redundant.isError).toBe(true)

    const retry = await harness.run('windows-fieldless-retry', 'Set-Content -LiteralPath ' + pwshQuote(target) + ' -Value retried -NoNewline')
    expect(retry.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('retried')
    expect(harness.classifierCalls).toEqual([])
    expect(harness.events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
  }, 60_000)

  it('fails closed for unknown modes and blank danger-full-access justification', async () => {
    const harness = await createWindowsHarness('继续执行普通的 Windows 工作区操作。')
    const target = join(harness.workspace, 'invalid-must-not-exist.txt')
    const cases: Array<Record<string, unknown>> = [
      { sandbox_permissions: 'read-only', justification: 'unsupported mode' },
      { sandbox_permissions: '' },
      { sandbox_permissions: 'danger-full-access' },
      { sandbox_permissions: 'danger-full-access', justification: ' ' + String.fromCharCode(9) + ' ' },
    ]
    for (const [index, sandboxArguments] of cases.entries()) {
      const result = await harness.run('windows-invalid-' + index, 'Set-Content -LiteralPath ' + pwshQuote(target) + ' -Value blocked', {
        sandboxArguments,
      })
      expect(result.isError, JSON.stringify(sandboxArguments)).toBe(true)
    }
    expect(existsSync(target)).toBe(false)
    expect(harness.classifierCalls).toEqual([])
    expect(harness.events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
  }, 60_000)

  it('runs ordinary assignment and pipeline syntax inside the workspace without classification', async () => {
    const harness = await createWindowsHarness('Build and verify this Windows workspace.')
    const target = join(harness.workspace, 'business.txt')
    const result = await harness.run('windows-routine', [
      "$values = @(1, 2, 3)",
      `$values | ForEach-Object { $_ * 2 } | Set-Content -LiteralPath ${pwshQuote(target)}`,
    ].join('; '))

    expect(result.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toMatch(/2\r?\n4\r?\n6/)
    expect(harness.classifierCalls).toEqual([])
  }, 60_000)

  it('lets the native ACL runner deny an outside write without classification', async () => {
    const harness = await createWindowsHarness('Keep all work inside this Windows workspace.')
    const target = join(harness.outside, 'blocked.txt')
    await harness.run('windows-outside-denied', `Set-Content -LiteralPath ${pwshQuote(target)} -Value blocked`)

    expect(existsSync(target)).toBe(false)
    expect(harness.classifierCalls).toEqual([])
  }, 60_000)

  it('uses one exact allowed-once approval for an authorized wider retry', async () => {
    const harness = await createWindowsHarness(outside => `我明确授权写入这个 Windows 测试文件夹：${outside}`)
    const target = join(harness.outside, 'approved.txt')
    const result = await harness.run(
      'windows-outside-approved',
      `Set-Content -LiteralPath ${pwshQuote(target)} -Value approved -NoNewline`,
      { escalate: true },
    )

    expect(result.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('approved')
    expect(harness.classifierCalls).toHaveLength(1)
    expect(harness.events.filter(event => event.type === 'approval/asked')).toHaveLength(1)
    expect(harness.events.find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
  }, 60_000)

  it('auto-authorizes one new outside export from direct task intent', async () => {
    const harness = await createWindowsHarness(outside => `把生成的报告导出到 ${join(outside, 'new-report.txt')}。`)
    const target = join(harness.outside, 'new-report.txt')
    const result = await harness.run(
      'windows-implicit-export',
      `Set-Content -LiteralPath ${pwshQuote(target)} -Value ready -NoNewline`,
      { escalate: true },
    )

    expect(result.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('ready')
    expect(harness.classifierCalls[0]?.filesystemEffects).toEqual([
      { kind: 'create-or-overwrite', path: target.toLowerCase(), existedBefore: false },
    ])
    expect(harness.events.find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
  }, 60_000)

  it('blocks deletion of existing workspace data before PowerShell executes', async () => {
    const harness = await createWindowsHarness('Inspect this project; do not delete existing data.')
    const target = join(harness.workspace, 'existing.txt')
    await writeFile(target, 'keep')
    const result = await harness.run('windows-existing-delete', `Remove-Item -LiteralPath ${pwshQuote(target)} -Force`)

    expect(result.isError).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('keep')
    expect(harness.classifierCalls).toHaveLength(1)
  }, 60_000)
})
