import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as AutoMode from '../src/index.js'
import { AUTO_MODE_AGENT_GUIDANCE } from '../src/index.js'
import { provideTestPermissionPresets } from './harness.js'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('plugin lifecycle', () => {
  it('removes its monotonic guard and listeners on fiber disposal', async () => {
    context = new Context()
    provideTestPermissionPresets(context)
    context.provide('llm', { stream: () => (async function* () {})() })
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRuntime)
    let calls = 0
    context.tools.register(defineTool({
      name: 'bash',
      description: 'Lifecycle probe.',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'ok' }],
      },
      async execute() { calls += 1; return { ok: true } },
    }))
    const policy = context.plugin(AutoMode, { workspaceRoot: '/work/repo', dshHome: '/safe/dsh' })
    await policy
    const agent = {
      session: {
        header: { cwd: '/work/repo' },
        events: [{ type: 'permission/preset', data: { preset: 'auto' } }],
      },
    } as unknown as NonNullable<ToolExecutionInput['agent']>
    const run = (id: string) => context!.tools.execute({
      callId: ToolCallId(id), name: 'bash', arguments: { command: 'rm -rf /' }, agent, signal: new AbortController().signal,
    })
    const autoContext = (await context.systemPrompt.assemble({ agent })).contexts
      .find(item => item.name === 'auto-mode:policy')?.text
    expect(autoContext).toBe(AUTO_MODE_AGENT_GUIDANCE)
    await expect(run('guarded')).resolves.toMatchObject({ isError: true })
    expect(calls).toBe(0)
    await policy.dispose()
    expect((await context.systemPrompt.assemble({ agent })).contexts.some(item => item.name === 'auto-mode:policy')).toBe(false)
    await expect(run('disposed')).resolves.toMatchObject({ isError: false })
    expect(calls).toBe(1)
  })
})
