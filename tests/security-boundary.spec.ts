import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as AutoMode from '../src/index.js'
import type { ClassifierInput } from '../src/types.js'
import { provideTestPermissionPresets } from './harness.js'

const SYNTHETIC_TOKEN = 'ghp_SYNTHETIC0123456789'
const ORIGINAL_CANARY = 'original test data\n'

interface ProbeArguments {
  input?: string
  patch?: string
  path?: string
  sandbox_permissions?: string
  justification?: string
}

/**
 * Keep the real tool pipeline and policy; only model output and tool effects
 * are fixtures. An always-allow classifier proves manual-only calls cannot
 * accidentally gain authority by reaching the model. All writes are limited
 * to a disposable canary, including when a regression makes a test fail.
 */
async function createHarness() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-auto-mode-security-'))
  const workspace = join(base, 'workspace')
  const dshHome = join(base, 'dsh')
  const canary = join(base, 'outside', 'canary.txt')
  const classifierInputs: ClassifierInput[] = []
  const decisions: PreToolDecision[] = []
  const executions: string[] = []
  const context = new Context()
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(join(base, 'outside'), { recursive: true })
    await writeFile(canary, ORIGINAL_CANARY)
    provideTestPermissionPresets(context)
    context.provide('agents', { get: () => undefined })
    context.provide('llm', {
      stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const block = options.messages[0]?.content[0]
        classifierInputs.push(JSON.parse(block?.type === 'text' ? block.text : '{}') as ClassifierInput)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ decision: 'allow', reason: 'synthetic allow for boundary regression tests' }) } as const
          yield { type: 'finish', reason: { kind: 'stop' } } as const
        })()
      },
    })
    await context.plugin(SystemPrompt).await()
    await context.plugin(ToolRuntime).await()
    await context.plugin(AutoMode, { workspaceRoot: workspace, dshHome, classifierTimeoutMs: 1_000 }).await()
    context.on('tools/pre-execute', async (_exec, next) => {
      const decision = await next()
      decisions.push(decision)
      return decision
    }, { prepend: true })
    for (const name of ['apply_patch', 'write', 'read'] as const) {
      context.tools.register(defineTool({
        name,
        description: 'Disposable security-boundary fixture.',
        parameters: {
          input: { type: 'string' }, patch: { type: 'string' }, path: { type: 'string' },
          sandbox_permissions: { type: 'string' }, justification: { type: 'string' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
          render: () => [{ type: 'text', text: 'fixture completed' }],
        },
        async execute(args: ProbeArguments) {
          executions.push(name)
          if (name === 'apply_patch') {
            if (!args.input?.includes(canary)) throw new Error('fixture rejects every target except its disposable canary')
            await writeFile(canary, 'unauthorized fixture execution\n')
          }
          return { ok: true }
        },
      }))
    }
  } catch (error) {
    await context.fiber.dispose()
    await rm(base, { recursive: true, force: true })
    throw error
  }
  let sequence = 0
  return {
    base, workspace, dshHome, canary, classifierInputs, decisions, executions,
    async run(name: ToolExecutionInput['name'], args: ProbeArguments, cwd = workspace) {
      const agent = {
        options: { provider: 'fixture', model: 'fixture' },
        session: {
          header: { id: 'security-boundary', cwd },
          requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }),
          events: [
            { type: 'permission/preset', data: { preset: 'auto' } },
            { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Read project status only.' }] } },
          ],
        },
      } as unknown as NonNullable<ToolExecutionInput['agent']>
      return context.tools.execute({
        callId: ToolCallId(`security-${++sequence}`), name, arguments: args, agent, signal: new AbortController().signal,
      })
    },
    async dispose() {
      await context.fiber.dispose()
      await rm(base, { recursive: true, force: true })
    },
  }
}

let harness: Awaited<ReturnType<typeof createHarness>>
beforeEach(async () => { harness = await createHarness() })
afterEach(async () => { await harness?.dispose() })

describe('classifier and unaudited patch security boundaries', () => {
  it.each([false, true])('keeps third-party patch execution manual even with widening=%s', async (widening) => {
    const input = `*** Begin Patch\n*** Add File: ${harness.canary}\n+fixture\n*** End Patch`
    const result = await harness.run('apply_patch', {
      input,
      ...(widening ? { sandbox_permissions: 'danger-full-access', justification: 'test that widening cannot bypass manual-only policy' } : {}),
    })
    expect(result).toMatchObject({ isError: true })
    expect(harness.decisions.at(-1)).toMatchObject({ kind: 'ask', reason: expect.stringContaining('no verified Harness filesystem sandbox') })
    expect(harness.classifierInputs).toEqual([])
    expect(harness.executions).toEqual([])
    expect(await readFile(harness.canary, 'utf8')).toBe(ORIGINAL_CANARY)
  })

  it.each(['input', 'patch'] as const)('hard-denies a critical target hidden in the %s payload', async (criticalField) => {
    const harmless = `*** Begin Patch\n*** Add File: ${harness.canary}\n+fixture\n*** End Patch`
    const critical = `*** Begin Patch\n*** Delete File: ${harness.dshHome}/settings.yaml\n*** End Patch`
    const result = await harness.run('apply_patch', {
      input: criticalField === 'input' ? critical : harmless,
      patch: criticalField === 'patch' ? critical : harmless,
    })
    expect(result).toMatchObject({ isError: true, error: { message: expect.stringContaining('DSH_HOME') } })
    expect(harness.classifierInputs).toEqual([])
    expect(harness.executions).toEqual([])
    expect(await readFile(harness.canary, 'utf8')).toBe(ORIGINAL_CANARY)
  })

  it.each([['redacted', SYNTHETIC_TOKEN], ['truncated', 'x'.repeat(1_100)]])('keeps %s effect paths local', async (_kind, suffix) => {
    const result = await harness.run('write', { path: `.git/${suffix}` })
    expect(result).toMatchObject({ isError: true })
    expect(harness.decisions.at(-1)).toMatchObject({ kind: 'ask', reason: expect.stringContaining('cannot be safely disclosed') })
    expect(harness.classifierInputs).toEqual([])
    expect(harness.executions).toEqual([])
  })

  it.each([['redacted', SYNTHETIC_TOKEN], ['truncated', 'x'.repeat(1_100)]])('keeps %s workspace metadata local', async (_kind, suffix) => {
    const result = await harness.run('read', { path: join(harness.base, 'home', '.aws', 'fixture') }, `${harness.workspace}/${suffix}`)
    expect(result).toMatchObject({ isError: true })
    expect(harness.decisions.at(-1)).toMatchObject({ kind: 'ask', reason: expect.stringContaining('cannot be safely disclosed') })
    expect(harness.classifierInputs).toEqual([])
    expect(harness.executions).toEqual([])
  })

  it('redacts policy reasons as well as arguments before classification', async () => {
    await harness.run('read', { path: join(harness.base, 'home', '.aws', SYNTHETIC_TOKEN) })
    expect(harness.classifierInputs).toHaveLength(1)
    expect(harness.classifierInputs[0]?.policyReason).toContain('[redacted-secret]')
    expect(JSON.stringify(harness.classifierInputs)).not.toContain(SYNTHETIC_TOKEN)
  })
})
