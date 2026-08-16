import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import ToolRuntime, { type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as AutoMode from '../src/index.js'
import type { ClassifierInput } from '../src/types.js'

const seatbeltProbe = process.platform === 'darwin'
  ? spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
  : undefined
const realSandboxAvailable = process.platform === 'darwin' && seatbeltProbe?.status === 0

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

interface BusinessHarness {
  readonly context: Context
  readonly workspace: string
  readonly outside: string
  readonly classifierCalls: ClassifierInput[]
  readonly events: Array<{ type: string; data?: Record<string, unknown> }>
  run(callId: string, command: string, options?: { escalate?: boolean }): Promise<ToolExecutionResult>
  runEditor(callId: string, argumentsValue: Record<string, unknown>): Promise<ToolExecutionResult>
}

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface BusinessPaths {
  readonly workspace: string
  readonly outside: string
}

async function createBusinessHarness(userMessage: string | ((paths: BusinessPaths) => string)): Promise<BusinessHarness> {
  const workspace = await mkdtemp(join(homedir(), 'dsh-auto-business-workspace-'))
  const outside = await mkdtemp(join(homedir(), 'dsh-auto-business-outside-'))
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
        id: 'business-user-message',
        role: 'user',
        content: [{ type: 'text', text: typeof userMessage === 'function' ? userMessage({ workspace, outside }) : userMessage }],
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
      const deletionEffects = input.filesystemEffects?.filter(effect => effect.kind === 'delete') ?? []
      const explicitDeletion = deletionEffects.length > 0
        && deletionEffects.every(effect => directMessages.includes(effect.path))
        && /(?:删除|永久删除|delete|remove)/i.test(directMessages)
      const createOnlyOutsideEffect = input.filesystemEffects !== undefined
        && input.filesystemEffects.length > 0
        && input.filesystemEffects.every(effect => effect.kind === 'create-or-overwrite' && !effect.existedBefore)
      const reversibleOutsideTask = input.sandboxRequest !== undefined
        && command.includes(outside)
        && directMessages.includes(outside)
        && /(?:导出|写入|复制|export|write|copy|save)/i.test(directMessages)
        && createOnlyOutsideEffect
      const explicitOutsideOverwrite = input.sandboxRequest !== undefined
        && command.includes(outside)
        && directMessages.includes(outside)
        && /(?:覆盖|替换|overwrite|replace)/i.test(directMessages)
        && input.filesystemEffects?.some(effect => effect.kind === 'create-or-overwrite' && effect.existedBefore) === true
      const requestedGitCommit = /\bgit\s+commit\b/i.test(command) && /(?:提交|commit)/i.test(directMessages)
      const requestedInstall = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/i.test(command)
        && /(?:安装|install|dependency)/i.test(directMessages)
      const requestedTransmission = /\bcurl\b/i.test(command)
        && /(?:发送|上传|send|post|upload)/i.test(directMessages)
      const broadDeletion = /\bgit\s+clean\b|\bfind\b[^\n]*(?:-delete|-exec\s+rm)/i.test(command)
      const allow = !broadDeletion && (explicitDeletion || reversibleOutsideTask || explicitOutsideOverwrite || requestedGitCommit || requestedInstall || requestedTransmission)
      const needsAuthorization = input.sandboxRequest !== undefined
        || deletionEffects.length > 0
        || broadDeletion
        || /\bgit\s+commit\b/i.test(command)
        || /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/i.test(command)
        || /\bcurl\b/i.test(command)
      const decision = allow
        ? { decision: 'allow', reason: 'the direct task authorizes this exact bounded business effect' }
        : needsAuthorization
          ? { decision: 'deny', reason: 'the risky effect lacks the required exact direct-user authority' }
          : { decision: 'allow', reason: 'routine sandbox-contained development' }
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
  await context.plugin(SandboxedFileSystem, { cwd: workspace })
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 30_000 })
  await context.plugin(ShellEnv)
  await context.plugin(ToolBash, { enableRunInBackground: false })
  await context.plugin(ToolStrReplaceEditor, {})
  await context.plugin(AutoMode, { workspaceRoot: workspace, dshHome: join(workspace, '.dsh') })

  const sessionId = 'business-session'
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
    context,
    workspace,
    outside,
    classifierCalls,
    events,
    run(callId, command, options = {}) {
      return context.tools.execute({
        callId: CallId(callId),
        name: 'bash',
        arguments: {
          command,
          description: 'business scenario command',
          ...(options.escalate === true ? {
            sandbox_permissions: 'danger-full-access',
            justification: `write the explicitly requested external fixture ${outside}`,
          } : {}),
        },
        agent,
        signal: new AbortController().signal,
      })
    },
    runEditor(callId, argumentsValue) {
      return context.tools.execute({
        callId: CallId(callId),
        name: 'str_replace_editor',
        arguments: argumentsValue,
        agent,
        signal: new AbortController().signal,
      })
    },
  }
}

describe.skipIf(!realSandboxAvailable)('Auto business flows through the real macOS workspace sandbox', () => {
  it('runs unfamiliar workspace-local development without classifier traffic', async () => {
    const harness = await createBusinessHarness('Build and verify the current workspace.')
    const output = join(harness.workspace, 'business.txt')
    const result = await harness.run(
      'routine',
      `awk 'BEGIN { print "business-ok" }' > ${shellQuote(output)} && test -s ${shellQuote(output)}`,
    )

    expect(result.isError).toBe(false)
    expect(await readFile(output, 'utf8')).toBe('business-ok\n')
    expect(harness.classifierCalls).toEqual([])
  })

  it('lets the OS deny an outside write without classifying unfamiliar shell syntax', async () => {
    const harness = await createBusinessHarness('Work only in the current workspace.')
    const target = join(harness.outside, 'blocked.txt')
    await harness.run('outside-denied', `awk 'BEGIN { print "blocked" }' > ${shellQuote(target)}`)

    expect(existsSync(target)).toBe(false)
    expect(harness.classifierCalls).toEqual([])
  })

  it('uses the official filesystem fence for editor writes without classifier traffic', async () => {
    const harness = await createBusinessHarness('Create the requested project file only in the workspace.')
    const inside = join(harness.workspace, 'editor-inside.txt')
    const outside = join(harness.outside, 'editor-outside.txt')

    const insideResult = await harness.runEditor('editor-inside', {
      command: 'create',
      path: inside,
      file_text: 'inside-ok',
    })
    const outsideResult = await harness.runEditor('editor-outside', {
      command: 'create',
      path: outside,
      file_text: 'must-not-land',
    })

    expect(insideResult.isError).toBe(false)
    expect(await readFile(inside, 'utf8')).toBe('inside-ok')
    expect(outsideResult.isError).toBe(true)
    expect(existsSync(outside)).toBe(false)
    expect(harness.classifierCalls).toEqual([])
  })

  it('builds and tests a multi-package project with real Node, pipelines, and generated artifacts', async () => {
    const harness = await createBusinessHarness('Build and test every package, then generate the aggregate report.')
    await mkdir(join(harness.workspace, 'packages', 'orders'), { recursive: true })
    await mkdir(join(harness.workspace, 'packages', 'billing'), { recursive: true })
    await writeFile(join(harness.workspace, 'packages', 'orders', 'data.json'), JSON.stringify([12, 18, 30]))
    await writeFile(join(harness.workspace, 'packages', 'billing', 'data.json'), JSON.stringify([5, 7, 9]))
    await writeFile(join(harness.workspace, 'build.mjs'), [
      "import { mkdir, readFile, writeFile } from 'node:fs/promises'",
      "const orders = JSON.parse(await readFile(new URL('./packages/orders/data.json', import.meta.url)))",
      "const billing = JSON.parse(await readFile(new URL('./packages/billing/data.json', import.meta.url)))",
      "await mkdir(new URL('./dist/', import.meta.url), { recursive: true })",
      "await writeFile(new URL('./dist/report.json', import.meta.url), JSON.stringify({ orders: orders.reduce((a, b) => a + b, 0), billing: billing.reduce((a, b) => a + b, 0) }))",
    ].join('\n'))
    await writeFile(join(harness.workspace, 'verify.test.mjs'), [
      "import assert from 'node:assert/strict'",
      "import { readFile } from 'node:fs/promises'",
      "import test from 'node:test'",
      "test('aggregate report', async () => assert.deepEqual(JSON.parse(await readFile(new URL('./dist/report.json', import.meta.url))), { orders: 60, billing: 21 }))",
    ].join('\n'))

    const result = await harness.run('monorepo-build', [
      'node build.mjs',
      'node --test verify.test.mjs',
      `awk 'BEGIN { print "orders,billing"; print "60,21" }' > ${shellQuote(join(harness.workspace, 'dist', 'summary.csv'))}`,
      'find dist -type f -print | sort',
    ].join(' && '))

    expect(result.isError).toBe(false)
    expect(JSON.parse(await readFile(join(harness.workspace, 'dist', 'report.json'), 'utf8'))).toEqual({ orders: 60, billing: 21 })
    expect(await readFile(join(harness.workspace, 'dist', 'summary.csv'), 'utf8')).toBe('orders,billing\n60,21\n')
    expect(harness.classifierCalls).toEqual([])
  })

  it('creates a real Git commit when the direct task asks for that state change', async () => {
    const harness = await createBusinessHarness('Create the initial Git commit for this fixture project.')
    await writeFile(join(harness.workspace, 'README.md'), '# Fixture\n')
    const result = await harness.run('git-commit', [
      'git init',
      'git config user.email fixture@example.invalid',
      'git config user.name Fixture',
      'git add README.md',
      'git commit -m "Initial fixture"',
    ].join(' && '))

    expect(result.isError).toBe(false)
    expect(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: harness.workspace, encoding: 'utf8' }).stdout.trim()).toBe('1')
    expect(harness.classifierCalls).toHaveLength(1)
    expect(harness.classifierCalls[0]?.policyReason).toMatch(/Git state-changing/)
  })

  it('installs a real local package and runs its lifecycle code inside the workspace sandbox', async () => {
    const harness = await createBusinessHarness(({ outside }) => `Install the local dependency from ${join(outside, 'fixture-dependency')} into this project.`)
    const dependency = join(harness.outside, 'fixture-dependency')
    await mkdir(dependency)
    await writeFile(join(dependency, 'package.json'), JSON.stringify({
      name: 'dsh-auto-fixture-dependency',
      version: '1.0.0',
      scripts: { postinstall: 'node postinstall.cjs' },
    }))
    await writeFile(join(dependency, 'postinstall.cjs'), "require('node:fs').writeFileSync('postinstall-ran.txt', 'lifecycle-ok')\n")
    const packed = spawnSync('npm', ['pack', '--pack-destination', harness.outside], {
      cwd: dependency,
      encoding: 'utf8',
    })
    expect(packed.status, packed.stderr).toBe(0)
    const tarball = join(harness.outside, packed.stdout.trim().split(/\r?\n/).at(-1) as string)
    await writeFile(join(harness.workspace, 'package.json'), JSON.stringify({ name: 'business-fixture', version: '1.0.0', private: true }))
    const result = await harness.run(
      'local-package-install',
      `npm install --no-audit --no-fund --cache ${shellQuote(join(harness.workspace, '.npm-cache'))} ${shellQuote(tarball)}`,
    )

    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ exitCode: 0 })
    expect(await readFile(join(harness.workspace, 'node_modules', 'dsh-auto-fixture-dependency', 'postinstall-ran.txt'), 'utf8'))
      .toBe('lifecycle-ok')
    expect(harness.classifierCalls).toHaveLength(1)
    expect(harness.classifierCalls[0]?.policyReason).toMatch(/package installation|downloaded-code/)
  }, 30_000)

  it('sends a real report to a local HTTP service only when the direct task requests transmission', async () => {
    let received = ''
    const server = createServer()
    const receivedRequest = new Promise<void>((resolve) => {
      server.once('request', (request, response) => {
        request.setEncoding('utf8')
        request.on('data', chunk => { received += chunk })
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('ok')
          resolve()
        })
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const endpoint = `http://127.0.0.1:${address.port}/reports`
    try {
      const harness = await createBusinessHarness(`Send the generated report to ${endpoint} for local validation.`)
      const report = join(harness.workspace, 'report.json')
      await writeFile(report, JSON.stringify({ status: 'ready', total: 81 }))
      const result = await harness.run(
        'local-http-post',
        `curl --fail --silent --show-error -X POST --data-binary @${shellQuote(report)} ${shellQuote(endpoint)}`,
      )
      await receivedRequest

      expect(result.isError).toBe(false)
      expect(JSON.parse(received)).toEqual({ status: 'ready', total: 81 })
      expect(harness.classifierCalls).toHaveLength(1)
      expect(harness.classifierCalls[0]?.policyReason).toMatch(/network transmission|remote mutation/)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })

  it('auto-authorizes a narrow outside export from task intent without requiring magic authorization words', async () => {
    const harness = await createBusinessHarness(({ outside }) => `把生成的构建报告导出到 ${join(outside, 'release-report.txt')}。`)
    const target = join(harness.outside, 'release-report.txt')
    const result = await harness.run(
      'implicit-outside-export',
      `printf release-ready > ${shellQuote(target)}`,
      { escalate: true },
    )

    expect(result.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('release-ready')
    expect(harness.classifierCalls).toHaveLength(1)
    expect(harness.events.find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })

    const ungrantedTarget = join(harness.outside, 'second-report.txt')
    await harness.run('no-standing-grant', `printf second > ${shellQuote(ungrantedTarget)}`)
    expect(existsSync(ungrantedTarget)).toBe(false)
    expect(harness.classifierCalls).toHaveLength(1)
  })

  it('distinguishes a new outside export from overwriting pre-existing outside data', async () => {
    const deniedHarness = await createBusinessHarness(({ outside }) => `把新报告导出到 ${join(outside, 'existing-report.txt')}。`)
    const deniedTarget = join(deniedHarness.outside, 'existing-report.txt')
    await writeFile(deniedTarget, 'original')
    const denied = await deniedHarness.run(
      'implicit-existing-overwrite',
      `printf replaced > ${shellQuote(deniedTarget)}`,
      { escalate: true },
    )
    expect(denied.isError).toBe(true)
    expect(await readFile(deniedTarget, 'utf8')).toBe('original')
    expect(deniedHarness.classifierCalls[0]?.filesystemEffects).toEqual([
      { kind: 'create-or-overwrite', path: deniedTarget, existedBefore: true },
    ])

    const allowedHarness = await createBusinessHarness(({ outside }) => `请覆盖这个已有报告：${join(outside, 'replace-me.txt')}。`)
    const allowedTarget = join(allowedHarness.outside, 'replace-me.txt')
    await writeFile(allowedTarget, 'old')
    const allowed = await allowedHarness.run(
      'explicit-existing-overwrite',
      `printf new > ${shellQuote(allowedTarget)}`,
      { escalate: true },
    )
    expect(allowed.isError).toBe(false)
    expect(await readFile(allowedTarget, 'utf8')).toBe('new')
    expect(allowedHarness.events.find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
  })

  it('keeps partial workspace effects visible when a later outside write is denied', async () => {
    const harness = await createBusinessHarness('Generate the report only in this workspace.')
    const inside = join(harness.workspace, 'partial-inside.txt')
    const outside = join(harness.outside, 'partial-outside.txt')
    await harness.run(
      'partial-transaction',
      `printf inside-landed > ${shellQuote(inside)} && printf outside-blocked > ${shellQuote(outside)}`,
    )

    expect(await readFile(inside, 'utf8')).toBe('inside-landed')
    expect(existsSync(outside)).toBe(false)
    expect(harness.classifierCalls).toEqual([])
  })

  it('blocks a real symlink escape at the kernel boundary', async () => {
    const harness = await createBusinessHarness('Generate files only inside the current project.')
    const link = join(harness.workspace, 'linked-outside')
    const escaped = join(harness.outside, 'escaped.txt')
    await symlink(harness.outside, link, 'dir')
    await harness.run('symlink-escape', `printf escaped > ${shellQuote(join(link, 'escaped.txt'))}`)

    expect(existsSync(escaped)).toBe(false)
    expect(harness.classifierCalls).toEqual([])
  })

  it('cleans an exact same-session artifact without classification but rejects hidden deletion', async () => {
    const harness = await createBusinessHarness('Build the fixture and clean only the generated scratch artifact afterward.')
    const scratch = join(harness.workspace, 'scratch-generated')
    await harness.run('create-scratch', `mkdir -p ${shellQuote(scratch)} && printf generated > ${shellQuote(join(scratch, 'output.txt'))}`)
    expect(existsSync(scratch)).toBe(true)
    const cleanup = await harness.run('clean-scratch', `rm -rf ${shellQuote(scratch)}`)
    expect(cleanup.isError).toBe(false)
    expect(existsSync(scratch)).toBe(false)
    expect(harness.classifierCalls).toEqual([])

    const hidden = join(harness.workspace, 'must-survive-hidden-delete')
    await mkdir(hidden)
    const hiddenResult = await harness.run('hidden-delete', `TARGET=${shellQuote(hidden)} rm -rf "$TARGET"`)
    expect(hiddenResult.isError).toBe(true)
    expect(existsSync(hidden)).toBe(true)
    expect(harness.classifierCalls).toEqual([])
  })

  it('revokes recursive auto-cleanup when pre-existing data is moved into a session-created directory', async () => {
    const harness = await createBusinessHarness('Build generated output and clean only generated files; preserve valuable.txt.')
    const valuable = join(harness.workspace, 'valuable.txt')
    const scratch = join(harness.workspace, 'mixed-scratch')
    await writeFile(valuable, 'must survive')
    await harness.run('create-mixed-scratch', `mkdir -p ${shellQuote(scratch)} && printf generated > ${shellQuote(join(scratch, 'generated.txt'))}`)
    await harness.run('move-preexisting-file', `mv ${shellQuote(valuable)} ${shellQuote(join(scratch, 'valuable.txt'))}`)

    const cleanup = await harness.run('reject-mixed-cleanup', `rm -rf ${shellQuote(scratch)}`)

    expect(cleanup.isError).toBe(true)
    expect(await readFile(join(scratch, 'valuable.txt'), 'utf8')).toBe('must survive')
    expect(await readFile(join(scratch, 'generated.txt'), 'utf8')).toBe('generated')
    expect(harness.classifierCalls).toHaveLength(1)
  })

  it('deletes only an explicitly named existing target and preserves its sibling', async () => {
    const harness = await createBusinessHarness(({ workspace }) => `请删除这个已有目录：${join(workspace, 'obsolete-output')}，不要删除其他内容。`)
    const target = join(harness.workspace, 'obsolete-output')
    const sibling = join(harness.workspace, 'keep-output')
    await mkdir(target)
    await mkdir(sibling)
    await writeFile(join(target, 'old.txt'), 'old')
    await writeFile(join(sibling, 'keep.txt'), 'keep')
    const result = await harness.run('authorized-existing-delete', `rm -rf ${shellQuote(target)}`)

    expect(result.isError).toBe(false)
    expect(existsSync(target)).toBe(false)
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('keep')
    expect(harness.classifierCalls).toHaveLength(1)
  })

  it('does not generalize one authorized deletion target to a second literal target', async () => {
    const harness = await createBusinessHarness(({ workspace }) => `请删除 ${join(workspace, 'delete-only-this')}。`)
    const authorized = join(harness.workspace, 'delete-only-this')
    const extra = join(harness.workspace, 'not-authorized')
    await mkdir(authorized)
    await mkdir(extra)
    const result = await harness.run(
      'no-delete-generalization',
      `rm -rf ${shellQuote(authorized)} ${shellQuote(extra)}`,
    )

    expect(result.isError).toBe(true)
    expect(existsSync(authorized)).toBe(true)
    expect(existsSync(extra)).toBe(true)
    expect(harness.classifierCalls).toHaveLength(0)
  })

  it('uses one exact wider grant for an explicitly named outside deletion and nothing else', async () => {
    const harness = await createBusinessHarness(({ outside }) => `请删除这个已有目录：${join(outside, 'obsolete-external')}，保留同级目录。`)
    const target = join(harness.outside, 'obsolete-external')
    const sibling = join(harness.outside, 'keep-external')
    await mkdir(target)
    await mkdir(sibling)
    await writeFile(join(target, 'old.txt'), 'old')
    await writeFile(join(sibling, 'keep.txt'), 'keep')
    const result = await harness.run(
      'authorized-outside-delete',
      `rm -rf ${shellQuote(target)}`,
      { escalate: true },
    )

    expect(result.isError).toBe(false)
    expect(existsSync(target)).toBe(false)
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('keep')
    expect(harness.classifierCalls).toHaveLength(1)
    expect(harness.events.find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
  })

  it('rejects broad Git cleanup even when the task vaguely says to clean the project', async () => {
    const harness = await createBusinessHarness('Clean up the project before building it.')
    const untracked = join(harness.workspace, 'important-untracked.txt')
    await writeFile(untracked, 'keep until the user names it')
    const result = await harness.run('broad-git-clean', 'git clean -fd')

    expect(result.isError).toBe(true)
    expect(await readFile(untracked, 'utf8')).toBe('keep until the user names it')
    expect(harness.classifierCalls).toHaveLength(1)
  })

  it('auto-approves only an exact authorized one-shot escalation', async () => {
    const harness = await createBusinessHarness(({ outside }) => `我明确授权写入这个测试文件夹：${outside}`)
    const target = join(harness.outside, 'approved.txt')
    const result = await harness.run(
      'outside-approved',
      `printf approved > ${shellQuote(target)}`,
      { escalate: true },
    )

    expect(result.isError).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('approved')
    expect(harness.classifierCalls).toHaveLength(1)
    expect(harness.classifierCalls[0]?.sandboxRequest).toMatchObject({
      currentMode: 'workspace-write',
      requestedMode: 'danger-full-access',
    })
    expect(harness.events.filter(event => event.type === 'approval/asked')).toHaveLength(1)
    expect(harness.events.find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
  })

  it('denies an unauthorized escalation and never reaches the OS command body', async () => {
    const harness = await createBusinessHarness('Keep all changes inside the workspace.')
    const target = join(harness.outside, 'must-not-exist.txt')
    const result = await harness.run(
      'outside-rejected',
      `printf rejected > ${shellQuote(target)}`,
      { escalate: true },
    )

    expect(result.isError).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(harness.classifierCalls).toHaveLength(1)
    expect(harness.events.filter(event => event.type === 'approval/asked')).toHaveLength(0)
  })

  it('blocks deletion of existing workspace data before execution', async () => {
    const harness = await createBusinessHarness('Inspect and build this project; do not delete existing data.')
    const existing = join(harness.workspace, 'existing.txt')
    await writeFile(existing, 'keep')
    const result = await harness.run('existing-delete', `rm -rf ${shellQuote(existing)}`)

    expect(result.isError).toBe(true)
    expect(await readFile(existing, 'utf8')).toBe('keep')
    expect(harness.classifierCalls).toHaveLength(1)
  })
})
