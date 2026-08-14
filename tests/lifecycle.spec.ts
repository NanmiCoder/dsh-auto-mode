import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as AutoMode from '../src/index.js'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('plugin lifecycle', () => {
  it('removes its monotonic guard and listeners on fiber disposal', async () => {
    context = new Context()
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
      callId: CallId(id), name: 'bash', arguments: { command: 'rm -rf /' }, agent, signal: new AbortController().signal,
    })
    await expect(run('guarded')).resolves.toMatchObject({ isError: true })
    expect(calls).toBe(0)
    await policy.dispose()
    await expect(run('disposed')).resolves.toMatchObject({ isError: false })
    expect(calls).toBe(1)
  })
})
