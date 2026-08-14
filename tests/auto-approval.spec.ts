import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
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

/** Deterministic stand-in for the independent model classifier. */
function classifierDecision(input: ClassifierInput): ClassifierDecision {
  const command = (input.arguments as { command?: string } | undefined)?.command ?? ''
  const deletion = /rm -rf (\S+)/.exec(command)?.[1]
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
  readonly commands: readonly string[]
  run(id: string, command: string, userMessages: readonly string[]): Promise<PreToolDecision>
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
  const commands: string[] = []
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

  let decision: PreToolDecision | undefined
  context.on('tools/pre-execute', async (_exec, next) => {
    decision = await next()
    return decision
  }, { prepend: true })

  context.tools.register(defineTool({
    name: 'bash',
    description: 'Records the command instead of running a shell.',
    parameters: { command: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'number', required: true } } },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    async execute(args: { command: string }) {
      commands.push(args.command)
      return { exitCode: 0 }
    },
  }))

  const agentFor = (userMessages: readonly string[]) => ({
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
  }) as unknown as NonNullable<ToolExecutionInput['agent']>

  return {
    canary,
    dshHome,
    workspace,
    scratch,
    classifierCalls,
    commands,
    async run(id, command, userMessages) {
      decision = undefined
      await context.tools.execute({
        callId: CallId(id),
        name: 'bash',
        arguments: { command },
        agent: agentFor(userMessages),
        signal: new AbortController().signal,
      })
      return decision as PreToolDecision
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
  it('runs an explicitly authorized compound deletion without asking again', async () => {
    const active = harness as Harness
    const command = `rm -rf ${active.canary} && echo removed && ls -la ${active.scratch} 2>&1 || true`
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
    const command = `rm -rf ${active.canary} && echo removed && ls -la ${active.scratch} 2>&1 || true`
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
      [`rm -rf ${active.dshHome}/state && echo done`, /DSH_HOME/],
      [`echo broken > ${active.dshHome}/settings.yaml`, /DSH_HOME/],
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

  it('still requires one-shot approval for dynamic and nested execution', async () => {
    const active = harness as Harness
    const cases = [
      `rm -rf $TARGET_DIR && echo done`,
      `bash -c "rm -rf ${active.canary}"`,
      `find ${active.scratch} -name "*.txt" | xargs rm -rf`,
    ]
    for (const command of cases) {
      const decision = await active.run(`manual-${command}`, command, [`我明确授权删除 ${active.canary}。`])
      expect(decision, command).toMatchObject({ kind: 'ask' })
      expect((decision as { reason: string }).reason, command).toContain('[auto-mode approval required]')
    }
    expect(active.classifierCalls).toEqual([])
    expect(active.commands).toEqual([])
    await expect(stat(join(active.canary, 'keep.txt'))).resolves.toBeDefined()
  })
})

describe('auto mode classifier failure', () => {
  it('falls back to approval when the classifier cannot answer', async () => {
    const failing = await createHarness({ failClassifier: true })
    try {
      const command = `rm -rf ${failing.canary} && echo removed`
      const decision = await failing.run('unavailable', command, [`我明确授权删除 ${failing.canary}。`])
      expect(decision).toMatchObject({ kind: 'ask' })
      expect((decision as { reason: string }).reason).toContain('[auto-mode classifier unavailable]')
      expect(failing.commands).toEqual([])
      await expect(stat(join(failing.canary, 'keep.txt'))).resolves.toBeDefined()
    } finally {
      await failing.dispose()
    }
  })
})
