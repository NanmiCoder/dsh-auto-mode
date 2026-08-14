import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as AutoMode from '../src/index.js'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Cordis Loader composition', () => {
  it('allows a routine command and blocks danger before the body', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-auto-mode-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: 'dsh-auto-mode'",
      '  config:',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      `    dshHome: ${JSON.stringify(join(root, '.dsh'))}`,
      '    classifierEndpoint: http://127.0.0.1:9/v1/chat/completions',
      '    classifierTimeoutMs: 250',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['dsh-auto-mode', AutoMode],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    context.on('tools/pre-execute', (exec, next) => {
      const args = exec.arguments as { command?: string }
      return args.command === 'rm -rf /' ? Promise.resolve({ kind: 'allow' as const }) : next()
    }, { prepend: true })

    let bodyCalls = 0
    context.tools.register(defineTool({
      name: 'bash',
      description: 'Test shell body.',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'ok' }],
      },
      async execute() {
        bodyCalls += 1
        return { ok: true }
      },
    }))
    const agentFor = (preset: string) => ({
      session: {
        header: { cwd: root },
        events: [{ type: 'permission/preset', data: { preset } }],
      },
    }) as unknown as NonNullable<ToolExecutionInput['agent']>
    const run = (id: string, command: string, preset = 'auto') => context!.tools.execute({
      callId: CallId(id), name: 'bash', arguments: { command }, agent: agentFor(preset), signal: new AbortController().signal,
    })

    await expect(run('safe', 'pnpm test')).resolves.toMatchObject({ isError: false })
    await expect(run('root', 'rm -rf /')).resolves.toMatchObject({ isError: true })
    await expect(run('ambiguous', 'python script.py')).resolves.toMatchObject({ isError: true })
    await expect(run('full-access-root', 'rm -rf /', 'danger-full-access')).resolves.toMatchObject({ isError: false })
    expect(bodyCalls).toBe(2)
  })
})
