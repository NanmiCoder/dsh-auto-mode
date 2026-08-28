import { describe, expect, it } from 'vitest'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ArtifactRegistry } from '../src/artifacts.js'
import { resolveRoots } from '../src/paths.js'
import { assessTool, hardDenyReason, sandboxEscalationRequest, sandboxRequestState } from '../src/policy.js'

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

  it('classifies raw sandbox fields into the rc.2 request states without normalization', () => {
    expect(sandboxRequestState({ command: 'pnpm test' })).toEqual({ kind: 'absent' })
    expect(sandboxRequestState({ sandbox_permissions: null })).toEqual({ kind: 'invalid', requestedMode: null })
    expect(sandboxRequestState({ sandbox_permissions: 1 })).toEqual({ kind: 'invalid', requestedMode: 1 })
    expect(sandboxRequestState({ sandbox_permissions: { mode: 'workspace-write' } })).toEqual({
      kind: 'invalid',
      requestedMode: { mode: 'workspace-write' },
    })
    expect(sandboxRequestState({ sandbox_permissions: undefined })).toEqual({ kind: 'invalid', requestedMode: undefined })
    expect(sandboxRequestState({ sandbox_permissions: 'workspace-write' })).toEqual({ kind: 'redundant-standing' })
    expect(sandboxRequestState({ sandbox_permissions: 'workspace-write', justification: 'anything' })).toEqual({ kind: 'redundant-standing' })
    expect(sandboxRequestState({ sandbox_permissions: 'danger-full-access', justification: 'write one exact target' })).toEqual({
      kind: 'widening',
      request: { requestedMode: 'danger-full-access', justification: 'write one exact target' },
    })
    expect(sandboxRequestState({ sandbox_permissions: 'danger-full-access' })).toEqual({
      kind: 'widening',
      request: { requestedMode: 'danger-full-access', justification: '' },
    })
    for (const requestedMode of [' workspace-write ', 'WORKSPACE-WRITE', '', 'read-only', 'other']) {
      expect(sandboxRequestState({ sandbox_permissions: requestedMode })).toEqual({ kind: 'invalid', requestedMode })
    }
  })

  it('keeps the legacy sandbox escalation view available for consumers', () => {
    expect(sandboxEscalationRequest({ sandbox_permissions: 'workspace-write', justification: 'why' })).toEqual({
      requestedMode: 'workspace-write',
      justification: 'why',
    })
    expect(sandboxEscalationRequest({ sandbox_permissions: null })).toBeUndefined()
  })
})
