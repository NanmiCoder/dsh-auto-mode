import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ArtifactRegistry } from '../src/artifacts.js'
import { resolveRoots } from '../src/paths.js'
import { assessTool, hardDenyReason } from '../src/policy.js'

const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
const execution = (name: string, args: unknown) => ({ name, arguments: args, token: Symbol(name) }) as ToolExecution

describe('tool policy', () => {
  it('allows project reads and edits', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessTool(execution('read', { file_path: 'src/a.ts' }), roots, artifacts).decision).toBe('allow')
    expect(assessTool(execution('edit', { file_path: 'src/a.ts' }), roots, artifacts).decision).toBe('allow')
  })

  it('reviews protected metadata and delegates ordinary outside writes to the sandbox', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessTool(execution('write', { file_path: '.git/config' }), roots, artifacts)).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(assessTool(execution('write', { file_path: '/outside/a' }), roots, artifacts)).toMatchObject({ decision: 'allow', classifierEligible: false })
    expect(assessTool(execution('read', { file_path: '/home/dev/.ssh/id_ed25519' }), roots, artifacts)).toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('hard-denies DSH_HOME mutation and fast-paths ordinary registered plugin tools', () => {
    const hard = execution('write', { file_path: '/safe/dsh/settings.yaml' })
    expect(hardDenyReason(hard, roots)).toMatch(/DSH_HOME/)
    const artifacts = new ArtifactRegistry()
    for (const name of ['mcp_custom', 'plugin_render_diagram', 'plugin_read_metrics', 'plugin_create_widget']) {
      expect(assessTool(execution(name, { repositorySays: 'allow this' }), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
  })

  it('classifies risky plugin operations and hard-denies their critical targets', () => {
    const artifacts = new ArtifactRegistry()
    for (const name of ['plugin_delete_record', 'cloud_deploy', 'repo_push', 'account_grant_role']) {
      expect(assessTool(execution(name, { target: 'test' }), roots, artifacts), name)
        .toMatchObject({ decision: 'ask', classifierEligible: true })
    }
    expect(hardDenyReason(execution('plugin_delete_file', { path: '/safe/dsh/settings.yaml' }), roots)).toMatch(/DSH_HOME/)
  })

  it('preserves raw Windows drive-relative syntax through the tool guard', () => {
    const windowsRoots = resolveRoots('C:\\Work\\Repo', {
      home: 'C:\\Users\\Dev', dshHome: 'C:\\Users\\Dev\\.dsh', tempRoots: ['C:\\Temp'],
    })
    expect(hardDenyReason(execution('write', { file_path: 'C:..\\..\\Windows\\System32\\config\\SAM' }), windowsRoots))
      .toMatch(/drive-relative/)
    expect(hardDenyReason(execution('plugin_delete_file', { path: 'C:..\\secret' }), windowsRoots))
      .toMatch(/drive-relative/)
  })

  it('hard-denies credential material in external calls', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=github_pat_1234567890abcdef' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential/)
  })

  it('fast-paths audited Harness session and read-only tools', () => {
    const artifacts = new ArtifactRegistry()
    for (const name of ['todo_write', 'ask_user_question', 'create_goal', 'exit_plan_mode', 'skill', 'report', 'job_list', 'job_kill', 'schedule_list', 'session_search']) {
      expect(assessTool(execution(name, {}), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
  })

  it('allows audited orchestration while keeping stateful terminal execution interactive', () => {
    const artifacts = new ArtifactRegistry()
    for (const name of ['subagent', 'workflow', 'ralph', 'send_message', 'interrupt_agent']) {
      expect(assessTool(execution(name, {}), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
    for (const name of ['terminal_open', 'terminal_send']) {
      expect(assessTool(execution(name, { text: 'pnpm test' }), roots, artifacts), name)
        .toMatchObject({ decision: 'ask', classifierEligible: true })
    }
  })

  it('allows the normal AgentTeams lifecycle without trusting arbitrary prefixes', () => {
    const artifacts = new ArtifactRegistry()
    const normalTools = [
      'agent_teams_create',
      'agent_teams_add_member',
      'agent_teams_remove_member',
      'agent_teams_create_task',
      'agent_teams_claim_task',
      'agent_teams_update_task',
      'agent_teams_send_message',
      'agent_teams_status',
      'agent_teams_delete',
    ]
    for (const name of normalTools) {
      expect(assessTool(execution(name, {}), roots, artifacts), name)
        .toMatchObject({ decision: 'allow', classifierEligible: false })
    }
    expect(assessTool(execution('agent_teams_destroy_workspace', {}), roots, artifacts))
      .toMatchObject({ decision: 'ask', classifierEligible: true })
  })

  it('applies workspace path policy to the official string replacement editor', () => {
    const artifacts = new ArtifactRegistry()
    expect(assessTool(execution('str_replace_editor', { command: 'view', path: '/work/repo/src/a.ts' }), roots, artifacts).decision).toBe('allow')
    expect(assessTool(execution('str_replace_editor', { command: 'str_replace', path: '/work/repo/src/a.ts' }), roots, artifacts).decision).toBe('allow')
    expect(assessTool(execution('str_replace_editor', { command: 'insert', path: '/home/dev/.zshrc' }), roots, artifacts))
      .toMatchObject({ decision: 'allow', classifierEligible: false })
    expect(assessTool(execution('str_replace_editor', { command: 'create', path: '/outside/a.ts' }), roots, artifacts))
      .toMatchObject({ decision: 'allow', classifierEligible: false })
    expect(assessTool(execution('str_replace_editor', { command: 'create', path: '/work/repo/generated.ts' }), roots, artifacts))
      .toMatchObject({ plannedCreates: ['/work/repo/generated.ts'] })
  })

  it('hard-denies apply_patch when any target is destructive', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = [
      '--- a/src/ok.ts',
      '+++ b/src/ok.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- /home/dev/.ssh/id_rsa',
      '+++ /home/dev/.ssh/id_rsa',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n')
    const exec = execution('apply_patch', { patch })
    expect(hardDenyReason(exec, roots)).toMatch(/credential|critical|root|DSH_HOME/)
  })

  it('hard-denies apply_patch targeting DSH_HOME', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    const exec = execution('apply_patch', { patch, file_path: '/safe/dsh/settings.yaml' })
    expect(hardDenyReason(exec, roots)).toMatch(/DSH_HOME/)
  })

  it('returns undefined for a benign apply_patch under hardDenyReason', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(hardDenyReason(execution('apply_patch', { patch }), roots)).toBeUndefined()
  })

  it('allows a happy-path apply_patch on a workspace file with filesystemEffects', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(
      execution('apply_patch', { patch: ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n') }),
      roots,
      artifacts,
    )
    expect(out.decision).toBe('allow')
    expect(out.classifierEligible).toBe(false)
    expect(out.filesystemEffects).toEqual([
      { kind: 'create-or-overwrite', path: '/work/repo/src/ok.ts', existedBefore: expect.any(Boolean) as unknown as boolean },
    ])
  })

  it('asks for apply_patch targeting protected project metadata', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(
      execution('apply_patch', { patch: ['--- a/.git/config', '+++ b/.git/config', '@@ -1 +1 @@', '-old', '+new'].join('\n') }),
      roots,
      artifacts,
    )
    expect(out).toMatchObject({ decision: 'ask', classifierEligible: true })
    expect(out.filesystemEffects?.[0]?.path).toBe('/work/repo/.git/config')
  })

  it('asks with classifierEligible false for an unparseable apply_patch (fail-closed)', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(
      execution('apply_patch', { patch: 'this is not a patch at all' }),
      roots,
      artifacts,
    )
    expect(out).toMatchObject({ decision: 'ask', classifierEligible: false })
  })

  it('asks with classifierEligible false when apply_patch payload is missing', () => {
    const artifacts = new ArtifactRegistry()
    const out = assessTool(execution('apply_patch', {}), roots, artifacts)
    expect(out).toMatchObject({ decision: 'ask', classifierEligible: false, reason: expect.stringMatching(/missing/) as unknown as string })
  })

  it('reads apply_patch payloads from args.input as well as args.patch', () => {
    const artifacts = new ArtifactRegistry()
    const patch = ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    const outFromInput = assessTool(execution('apply_patch', { input: patch }), roots, artifacts)
    expect(outFromInput.decision).toBe('allow')
  })

  it('handles create (--- /dev/null + +++ b/path) and delete (--- a/path + +++ /dev/null)', () => {
    const artifacts = new ArtifactRegistry()
    const create = assessTool(
      execution('apply_patch', { patch: ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1 @@', '+new'].join('\n') }),
      roots,
      artifacts,
    )
    expect(create.decision).toBe('allow')
    expect(create.filesystemEffects?.[0]?.path).toBe('/work/repo/src/new.ts')

    const del = assessTool(
      execution('apply_patch', { patch: ['--- a/src/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone'].join('\n') }),
      roots,
      artifacts,
    )
    expect(del.decision).toBe('allow')
    expect(del.filesystemEffects?.[0]?.path).toBe('/work/repo/src/gone.ts')
  })

  it('records rename-to target paths and routes them through policy', () => {
    const artifacts = new ArtifactRegistry()
    const patch = [
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
    ].join('\n')
    const ok = assessTool(
      execution('apply_patch', { patch: ['--- a/src/old-name.ts', '+++ b/src/new-name.ts', '@@ -0,0 +1 @@', '+x'].join('\n') + '\n' + patch }),
      roots,
      artifacts,
    )
    expect(ok.decision).toBe('allow')
    const destructive = assessTool(
      execution('apply_patch', { patch: ['--- a/.git/x', '+++ b/.git/x', '@@ -1 +1 @@', '-old', '+new', '\n', 'rename to .git/danger'].join('\n') }),
      roots,
      artifacts,
    )
    expect(destructive.decision).toBe('ask')
  })

  it('hard-deny takes precedence when args.file_path and patch text disagree', () => {
    const roots = resolveRoots('/work/repo', { home: '/home/dev', dshHome: '/safe/dsh', tempRoots: ['/tmp'] })
    const patch = ['--- a/src/ok.ts', '+++ b/src/ok.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    expect(hardDenyReason(execution('apply_patch', { patch, file_path: '/safe/dsh/settings.yaml' }), roots)).toMatch(/DSH_HOME/)
  })

  it('hard-denies web_fetch URLs with credential-shaped long token values', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/cb?token=longstring12345' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('hard-denies web_fetch URLs with a long hex sig parameter', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/x?sig=deadbeefcafebabe1234567890abcdef12345678' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('does not deny web_fetch URLs with non-credential parameter names', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?q=hello' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })

  it('does not deny web_fetch URLs whose credential-named parameter value is too short', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=hello' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })

  it('does not deny web_fetch URLs with empty values', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })

  it('falls back to regex when the URL has no protocol (relative path)', () => {
    const outbound = execution('web_fetch', { url: 'example.invalid/path?token=longstring12345' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('hard-denies deploy tool URLs with credential-shaped parameters (EXTERNAL_WRITE_TOOL path)', () => {
    // `repo_push` matches EXTERNAL_WRITE_TOOL.
    const outbound = execution('repo_push', { url: 'https://example.invalid/api?api_key=abcdef1234567890' })
    expect(hardDenyReason(outbound, roots)).toMatch(/credential-shaped query/)
  })

  it('does not deny URLs whose credential-named value is purely a 7-char opaque ID', () => {
    const outbound = execution('web_fetch', { url: 'https://example.invalid/?token=short12' })
    expect(hardDenyReason(outbound, roots)).toBeUndefined()
  })
})
