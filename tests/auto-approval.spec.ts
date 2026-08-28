import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type GenerateOptions, type StreamChunk, type ToolSchema } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as AutoMode from '../src/index.js'
import type { ClassifierDecision, ClassifierInput } from '../src/types.js'

/**
 * End-to-end coverage for the reported over-prompting: an explicitly authorized
 * deletion of a task-created canary must run in the background even when the
 * model writes it as a compound line with `&&`, `||`, and `2>&1`.
 *
 * The registered `bash` body never runs a shell. It only records the command
 * string, so no destructive payload is executed by this suite; the canary is
 * asserted to survive every case.
 */

const AUTHORIZATION = /(?:授权|authoriz|approve|go ahead)/i

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Deterministic stand-in for the independent model classifier. */
function classifierDecision(input: ClassifierInput): ClassifierDecision {
  const command = (input.arguments as { command?: string } | undefined)?.command ?? ''
  const match = /rm -rf (?:'([^']*)'|(\S+))/.exec(command)
  const deletion = match?.[1] ?? match?.[2]
  if (deletion === undefined) return { decision: 'allow', reason: 'routine development command' }
  const authorized = input.trustedUserMessages.some(message => AUTHORIZATION.test(message) && message.includes(deletion))
  return authorized
    ? { decision: 'allow', reason: 'the user authorized this exact deletion target' }
    : { decision: 'deny', reason: 'no trusted user message authorizes this deletion target' }
}

interface Harness {
  readonly canary: string
  readonly dshHome: string
  readonly workspace: string
  readonly scratch: string
  readonly classifierCalls: readonly ClassifierInput[]
  readonly approvalRequests: readonly unknown[]
  readonly commands: readonly string[]
  readonly results: readonly ToolExecutionResult[]
  autoGuidance(userMessages: readonly string[]): Promise<string | undefined>
  modelTools(userMessages: readonly string[]): Promise<readonly ToolSchema[]>
  run(id: string, command: string, userMessages: readonly string[], sandboxArguments?: Record<string, unknown>): Promise<PreToolDecision>
  runTool(name: ToolExecutionInput['name'], id: string, command: string, userMessages: readonly string[], sandboxArguments?: Record<string, unknown>): Promise<PreToolDecision>
  dispose(): Promise<void>
}

async function createHarness(options: { failClassifier?: boolean } = {}): Promise<Harness> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-auto-mode-workspace-'))
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-auto-mode-scratch-'))
  const dshHome = join(await mkdtemp(join(tmpdir(), 'dsh-auto-mode-home-')), '.dsh')
  await mkdir(dshHome, { recursive: true })
  const canary = join(scratch, 'dsh-auto-protected-canary')
  await mkdir(canary, { recursive: true })
  await writeFile(join(canary, 'keep.txt'), 'canary\n')

  const classifierCalls: ClassifierInput[] = []
  const approvalRequests: unknown[] = []
  const commands: string[] = []
  const results: ToolExecutionResult[] = []
  const context = new Context()
  context.provide('agents', { get: () => undefined })
  context.provide('llm', {
    stream(generate: GenerateOptions): AsyncIterable<StreamChunk> {
      const block = generate.messages[0]?.content[0]
      const input = JSON.parse(block?.type === 'text' ? block.text : '{}') as ClassifierInput
      classifierCalls.push(input)
      if (options.failClassifier === true) throw new Error('classifier route is unavailable')
      const text = JSON.stringify(classifierDecision(input))
      return (async function* () {
        yield { type: 'text-delta', index: 0, text } as const
        yield { type: 'finish', reason: { kind: 'stop' } } as const
      })()
    },
  })
  await context.plugin(SystemPrompt).await()
  await context.plugin(ToolRuntime).await()
  await context.plugin(AutoMode, {
    workspaceRoot: workspace,
    dshHome,
    tempRoots: [scratch],
    classifierTimeoutMs: 1_000,
  }).await()

  context.on('approval/request', (request, next) => {
    approvalRequests.push(request)
    return next()
  })
  context.on('tools/result', (_exec, result) => {
    results.push(result)
  })

  let decision: PreToolDecision | undefined
  context.on('tools/pre-execute', async (_exec, next) => {
    decision = await next()
    return decision
  }, { prepend: true })

  context.tools.register(defineTool({
    name: 'bash',
    description: 'Records the command instead of running a shell.',
    parameters: {
      command: { type: 'string', required: true },
      sandbox_permissions: { type: 'string' },
      justification: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true } } },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute(args: { command: string; sandbox_permissions?: string; justification?: string }) {
      commands.push(args.command)
      return { exitCode: 0 }
    },
  }))
  context.tools.register(defineTool({
    name: 'pwsh',
    description: 'Unrelated recovery-schema probe.',
    parameters: {
      command: { type: 'string', required: true },
      sandbox_permissions: { type: 'string', required: true },
      justification: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true } } },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute() {
      return { exitCode: 0 }
    },
  }))

  const agents = new Map<string, NonNullable<ToolExecutionInput['agent']>>()
  const agentFor = (userMessages: readonly string[]) => {
    const key = JSON.stringify(userMessages)
    const existing = agents.get(key)
    if (existing !== undefined) return existing
    const agent = {
      options: { provider: 'mock-provider', model: 'mock-model' },
      session: {
        header: { id: 'session-auto', cwd: workspace },
        requestHeader: () => ({ config: { provider: 'mock-provider', model: 'mock-model' } }),
        events: [
          { type: 'permission/preset', data: { preset: 'auto' } },
          ...userMessages.map((text, index) => ({
            type: 'user/message',
            data: {
              id: `message-${index}`,
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'user' },
            },
          })),
        ],
      },
    } as unknown as NonNullable<ToolExecutionInput['agent']>
    agents.set(key, agent)
    return agent
  }

  const runTool = async (
    name: ToolExecutionInput['name'],
    id: string,
    command: string,
    userMessages: readonly string[],
    sandboxArguments?: Record<string, unknown>,
  ): Promise<PreToolDecision> => {
    decision = undefined
    await context.tools.execute({
      callId: CallId(id),
      name,
      arguments: { command, ...sandboxArguments },
      agent: agentFor(userMessages),
      signal: new AbortController().signal,
    })
    return decision as PreToolDecision
  }

  return {
    canary,
    dshHome,
    workspace,
    scratch,
    classifierCalls,
    approvalRequests,
    commands,
    results,
    async autoGuidance(userMessages) {
      return (await context.systemPrompt.assemble({ agent: agentFor(userMessages) })).contexts
        .find(item => item.name === 'auto-mode:policy')?.text
    },
    async modelTools(userMessages) {
      return (await context.systemPrompt.assemble({ agent: agentFor(userMessages) })).tools
    },
    runTool,
    async run(id, command, userMessages, sandboxArguments) {
      return runTool('bash', id, command, userMessages, sandboxArguments)
    },
    async dispose() {
      await context.fiber.dispose()
      for (const path of [workspace, scratch, join(dshHome, '..')]) {
        await rm(path, { recursive: true, force: true })
      }
    },
  }
}

let harness: Harness | undefined

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('auto mode approval traffic', () => {
  it('rejects every redundant workspace-write request before classifier, approval, grant, or body activity', async () => {
    const active = harness as Harness
    const variants: Array<Record<string, unknown>> = [
      { sandbox_permissions: 'workspace-write' },
      { sandbox_permissions: 'workspace-write', justification: '' },
      { sandbox_permissions: 'workspace-write', justification: '   ' },
      { sandbox_permissions: 'workspace-write', justification: 'the model repeated the standing mode' },
    ]
    const reasons: string[] = []
    for (const [index, sandboxArguments] of variants.entries()) {
      const decision = await active.run('redundant-' + index, 'printf routine', ['继续执行工作区内的普通命令。'], sandboxArguments)
      expect(decision, JSON.stringify(sandboxArguments)).toMatchObject({ kind: 'deny' })
      reasons.push((decision as { reason: string }).reason)
    }

    expect(new Set(reasons)).toEqual(new Set([
      AutoMode.AUTO_MODE_REDUNDANT_SANDBOX_REASON,
    ]))
    expect(active.classifierCalls).toEqual([])
    expect(active.approvalRequests).toEqual([])
    expect(active.commands).toEqual([])
  })

  it('recovers only after the model removes both redundant sandbox fields', async () => {
    const active = harness as Harness
    const command = 'printf retry-succeeded'
    const autoGuidance = await active.autoGuidance(['继续执行工作区内的普通命令。'])
    expect(autoGuidance).toContain(AutoMode.AUTO_MODE_REDUNDANT_SANDBOX_MARKER)
    expect(autoGuidance).toContain('sandbox_permissions and justification completely absent')
    expect(autoGuidance).toContain('null, an empty string, whitespace, or workspace-write')
    const redundant = await active.run('redundant-before-retry', command, ['继续执行工作区内的普通命令。'], {
      sandbox_permissions: 'workspace-write',
      justification: 'standing mode is already workspace-write',
    })
    expect(redundant).toMatchObject({ kind: 'deny' })
    const deniedResult = active.results[active.results.length - 1]
    expect(deniedResult).toMatchObject({
      isError: true,
      error: { message: AutoMode.AUTO_MODE_REDUNDANT_SANDBOX_REASON },
    })
    expect(deniedResult?.additionalContexts).toHaveLength(1)
    expect(deniedResult?.additionalContexts?.[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: AutoMode.AUTO_MODE_REDUNDANT_SANDBOX_RETRY_CONTEXT }],
      source: {
        kind: 'plugin',
        plugin: AutoMode.name,
        form: 'notice',
        summary: 'Auto Mode requires a field-less retry.',
      },
    })

    const retry = await active.run('fieldless-retry', command, ['继续执行工作区内的普通命令。'])
    expect(retry).toEqual({ kind: 'allow' })
    expect(active.classifierCalls).toEqual([])
    expect(active.approvalRequests).toEqual([])
    expect(active.commands).toEqual([command])
    expect(active.results[active.results.length - 1]?.additionalContexts).toBeUndefined()
  })

  it('projects a one-step field-less recovery for only the denied tool and then restores the full schema', async () => {
    const active = harness as Harness
    const userMessages = ['继续执行工作区内的普通命令。']
    const parametersOf = (tool: ToolSchema) => tool.parameters as {
      properties?: Record<string, unknown>
      required?: unknown[]
    }
    const initial = await active.modelTools(userMessages)
    const initialBash = initial.find(tool => tool.name === 'bash') as ToolSchema
    const initialPwsh = initial.find(tool => tool.name === 'pwsh') as ToolSchema
    expect(parametersOf(initialPwsh).properties).toHaveProperty('sandbox_permissions')
    expect(parametersOf(initialPwsh).properties).toHaveProperty('justification')
    expect(parametersOf(initialPwsh).required).toEqual(expect.arrayContaining(['sandbox_permissions', 'justification']))

    const redundant = await active.runTool('pwsh', 'projection-deny', 'printf projection', userMessages, {
      sandbox_permissions: 'workspace-write',
      justification: 'standing mode is already workspace-write',
    })
    expect(redundant).toMatchObject({ kind: 'deny' })

    const projected = await active.modelTools(userMessages)
    const projectedBash = projected.find(tool => tool.name === 'bash') as ToolSchema
    const projectedPwsh = projected.find(tool => tool.name === 'pwsh') as ToolSchema
    expect(parametersOf(projectedPwsh).properties).not.toHaveProperty('sandbox_permissions')
    expect(parametersOf(projectedPwsh).properties).not.toHaveProperty('justification')
    expect(parametersOf(projectedPwsh).required).not.toEqual(expect.arrayContaining(['sandbox_permissions', 'justification']))
    expect(parametersOf(projectedBash).properties).toEqual(parametersOf(initialBash).properties)

    // The prior assembly and canonical unaffected tool remain unchanged.
    expect(parametersOf(initialPwsh).properties).toHaveProperty('sandbox_permissions')
    expect(parametersOf(initialPwsh).properties).toHaveProperty('justification')

    const restored = await active.modelTools(userMessages)
    const restoredPwsh = restored.find(tool => tool.name === 'pwsh') as ToolSchema
    expect(parametersOf(restoredPwsh).properties).toEqual(parametersOf(initialPwsh).properties)
    expect(parametersOf(restoredPwsh).required).toEqual(parametersOf(initialPwsh).required)
  })

  it('fails closed for unknown modes and missing or blank widening justification', async () => {
    const active = harness as Harness
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown-mode', { sandbox_permissions: 'read-only', justification: 'not an escalation' }],
      ['empty-mode', { sandbox_permissions: '' }],
      ['missing-justification', { sandbox_permissions: 'danger-full-access' }],
      ['empty-justification', { sandbox_permissions: 'danger-full-access', justification: '' }],
      ['blank-justification', { sandbox_permissions: 'danger-full-access', justification: ' ' + String.fromCharCode(9) + ' ' }],
    ]
    for (const [id, sandboxArguments] of cases) {
      const decision = await active.run(id, 'printf should-not-run', ['继续执行工作区内的普通命令。'], sandboxArguments)
      expect(decision, id).toMatchObject({ kind: 'deny' })
      expect((decision as { reason: string }).reason, id).toContain('[auto-mode invalid sandbox request]')
    }
    expect(active.classifierCalls).toEqual([])
    expect(active.approvalRequests).toEqual([])
    expect(active.commands).toEqual([])
  })

  it('keeps hard and deterministic denies ahead of redundant-mode remediation', async () => {
    const active = harness as Harness
    const hard = await active.run('redundant-hard-deny', 'rm -rf ' + bashQuote(active.dshHome), ['我授权执行任何操作。'], {
      sandbox_permissions: 'workspace-write',
      justification: 'standing mode repeated by the model',
    })
    expect(hard).toMatchObject({ kind: 'deny' })
    expect((hard as { reason: string }).reason).toContain('[auto-mode hard deny]')
    expect((hard as { reason: string }).reason).toContain('DSH_HOME')

    const deterministic = await active.run('redundant-deterministic-deny', 'rm -rf ' + String.fromCharCode(36) + 'TARGET_DIR', ['我授权执行任何操作。'], {
      sandbox_permissions: 'workspace-write',
      justification: 'standing mode repeated by the model',
    })
    expect(deterministic).toMatchObject({ kind: 'deny' })
    expect((deterministic as { reason: string }).reason).toContain('[auto-mode deterministic deny]')
    expect((deterministic as { reason: string }).reason).toContain('dynamically')

    expect(active.classifierCalls).toEqual([])
    expect(active.approvalRequests).toEqual([])
    expect(active.commands).toEqual([])
  })

  it('still classifies an exact danger-full-access widening after the redundant state split', async () => {
    const active = harness as Harness
    const target = join(active.scratch, 'widened.txt')
    const command = 'printf widened > ' + bashQuote(target)
    const decision = await active.run('exact-widening', command, [
      '请把结果写入 ' + target + '。',
    ], {
      sandbox_permissions: 'danger-full-access',
      justification: 'write the explicitly requested target ' + target,
    })

    expect(decision).toEqual({ kind: 'allow' })
    expect(active.classifierCalls).toHaveLength(1)
    expect(active.classifierCalls[0]?.sandboxRequest).toMatchObject({
      currentMode: 'workspace-write',
      requestedMode: 'danger-full-access',
      justification: 'write the explicitly requested target ' + target,
    })
    expect(active.commands).toEqual([command])
  })

  it('runs an explicitly authorized compound deletion without asking again', async () => {
    const active = harness as Harness
    const command = `rm -rf ${bashQuote(active.canary)} && echo removed && ls -la ${bashQuote(active.scratch)} 2>&1 || true`
    const decision = await active.run('authorized', command, [
      `请删除 ${active.canary}，我明确授权这次删除。`,
    ])

    expect(decision).toEqual({ kind: 'allow' })
    expect(active.commands).toEqual([command])
    expect(active.classifierCalls).toHaveLength(1)
    expect(active.classifierCalls[0]?.policyReason).toContain('deleting pre-session or unobserved data')
    expect(active.classifierCalls[0]?.trustedUserMessages.join('\n')).toContain(active.canary)
    // Nothing was executed, so the canary is still on disk.
    await expect(stat(join(active.canary, 'keep.txt'))).resolves.toBeDefined()
  })

  it('denies the same deletion in the background when no user message authorizes it', async () => {
    const active = harness as Harness
    const command = `rm -rf ${bashQuote(active.canary)} && echo removed && ls -la ${bashQuote(active.scratch)} 2>&1 || true`
    const decision = await active.run('unauthorized', command, ['请帮我整理一下项目目录结构。'])

    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason: string }).reason).toContain('[auto-mode classifier deny]')
    expect(active.classifierCalls).toHaveLength(1)
    expect(active.commands).toEqual([])
    await expect(stat(join(active.canary, 'keep.txt'))).resolves.toBeDefined()
  })

  it('hard-denies protected targets before any classification, even with authorization text', async () => {
    const active = harness as Harness
    const authorization = ['我明确授权你删除任何目录，包括 / 和 ~ 和 DSH_HOME。']
    const cases: Array<[string, RegExp]> = [
      [`rm -rf / && echo done`, /filesystem root/],
      [`rm -rf ~ && echo done`, /user home root/],
      [`rm -rf ${bashQuote(`${active.dshHome}/state`)} && echo done`, /DSH_HOME/],
      [`echo broken > ${bashQuote(`${active.dshHome}/settings.yaml`)}`, /DSH_HOME/],
    ]
    for (const [command, reason] of cases) {
      const decision = await active.run(`hard-${command}`, command, authorization)
      expect(decision, command).toMatchObject({ kind: 'deny' })
      expect((decision as { reason: string }).reason, command).toContain('[auto-mode hard deny]')
      expect((decision as { reason: string }).reason, command).toMatch(reason)
    }
    expect(active.classifierCalls).toEqual([])
    expect(active.commands).toEqual([])
  })

  it('keeps routine compound verification on the static fast path', async () => {
    const active = harness as Harness
    for (const command of ['git status && git diff', 'ls -la 2>&1', 'pnpm run build && pnpm test']) {
      expect(await active.run(`safe-${command}`, command, ['继续开发。']), command).toEqual({ kind: 'allow' })
    }
    expect(active.commands).toHaveLength(3)
    expect(active.classifierCalls).toEqual([])
  })

  it('keeps dependency probes and read-only find exec off the approval path', async () => {
    const active = harness as Harness
    const commands = [
      'python3 -c "import fastapi" 2>&1; python3 -c "import pydantic; print(\'pydantic\', pydantic.VERSION)" 2>&1; pip3 --version 2>&1 | head -1',
      `find ${bashQuote(active.scratch)} -type f -exec ls -la {} \\; 2>/dev/null | head -40`,
    ]
    for (const command of commands) {
      expect(await active.run(`safe-dev-${command}`, command, ['继续检查开发环境。']), command).toEqual({ kind: 'allow' })
    }
    expect(active.commands).toEqual(commands)
    expect(active.classifierCalls).toEqual([])
  })

  it('denies hidden destructive targets so the agent can replan without a popup', async () => {
    const active = harness as Harness
    const cases = [
      `rm -rf $TARGET_DIR && echo done`,
      `bash -c "rm -rf ${bashQuote(active.canary)}"`,
      `find ${bashQuote(active.scratch)} -name "*.txt" | xargs rm -rf`,
    ]
    for (const command of cases) {
      const decision = await active.run(`manual-${command}`, command, [`我明确授权删除 ${active.canary}。`])
      expect(decision, command).toMatchObject({ kind: 'deny' })
      expect((decision as { reason: string }).reason, command).toContain('[auto-mode deterministic deny]')
    }
    expect(active.classifierCalls).toEqual([])
    expect(active.commands).toEqual([])
    await expect(stat(join(active.canary, 'keep.txt'))).resolves.toBeDefined()
  })
})

describe('auto mode classifier failure', () => {
  it('denies transient failures twice, then falls back to one manual approval instead of looping', async () => {
    const failing = await createHarness({ failClassifier: true })
    try {
      const command = `rm -rf ${bashQuote(failing.canary)} && echo removed`
      const userMessages = [`我明确授权删除 ${failing.canary}。`]
      for (const id of ['unavailable-1', 'unavailable-2']) {
        const decision = await failing.run(id, command, userMessages)
        expect(decision).toMatchObject({ kind: 'deny' })
        expect((decision as { reason: string }).reason).toContain('[auto-mode classifier unavailable; action denied]')
      }
      const fallback = await failing.run('unavailable-3', command, userMessages)
      expect(fallback).toMatchObject({ kind: 'ask' })
      expect((fallback as { reason: string }).reason).toContain('manual approval required')
      expect(failing.commands).toEqual([])
      await expect(stat(join(failing.canary, 'keep.txt'))).resolves.toBeDefined()
    } finally {
      await failing.dispose()
    }
  })
})
