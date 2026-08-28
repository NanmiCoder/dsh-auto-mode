import { lstatSync } from 'node:fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ArtifactRegistry } from './artifacts.js'
import {
  hardDestructiveTargetReason,
  isProtectedProjectPath,
  isWithin,
  normalizePath,
  type PolicyRoots,
} from './paths.js'
import { assessShell, hardDenyShellReason } from './shell.js'
import type { Assessment } from './types.js'

function existedBefore(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function pathArgument(args: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['file_path', 'path', 'cwd', 'workdir']) {
    const value = args?.[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function serializedArguments(argumentsValue: unknown): string {
  try {
    return JSON.stringify(argumentsValue)
  } catch {
    return ''
  }
}

function containsCredentialMaterial(argumentsValue: unknown): boolean {
  return /(?:BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~+\/-]{8,}|\.ssh[\\/](?:id_|config)|\.credentials\.yaml)/i
    .test(serializedArguments(argumentsValue))
}

/** One model-requested, tool-native widening of the standing workspace sandbox. */
export interface SandboxWideningRequest {
  readonly requestedMode: 'danger-full-access'
  readonly justification: string
}

/**
 * @deprecated Use `SandboxRequestState` / `sandboxRequestState` for new code.
 * Kept as a compatibility view for consumers of the pre-rc.2 export.
 */
export interface SandboxEscalationRequest {
  readonly requestedMode: string
  readonly justification: string
}

/** Semantic state of the raw sandbox fields before any authorization decision. */
export type SandboxRequestState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'redundant-standing' }
  | { readonly kind: 'widening'; readonly request: SandboxWideningRequest }
  | { readonly kind: 'invalid'; readonly requestedMode: unknown }

/** Classify the official sandbox request fields without treating them as authorization. */
export function sandboxRequestState(argumentsValue: unknown): SandboxRequestState {
  const args = record(argumentsValue)
  if (args === undefined || !Object.prototype.hasOwnProperty.call(args, 'sandbox_permissions')) {
    return { kind: 'absent' }
  }
  const requestedMode = args.sandbox_permissions
  if (typeof requestedMode !== 'string') return { kind: 'invalid', requestedMode }
  if (requestedMode === 'workspace-write') return { kind: 'redundant-standing' }
  if (requestedMode === 'danger-full-access') {
    return {
      kind: 'widening',
      request: {
        requestedMode,
        justification: typeof args?.justification === 'string' ? args.justification : '',
      },
    }
  }
  return { kind: 'invalid', requestedMode }
}

/** Read the legacy paired sandbox fields without treating them as authorization. */
export function sandboxEscalationRequest(argumentsValue: unknown): SandboxEscalationRequest | undefined {
  const args = record(argumentsValue)
  const requestedMode = args?.sandbox_permissions
  if (typeof requestedMode !== 'string') return undefined
  return {
    requestedMode,
    justification: typeof args?.justification === 'string' ? args.justification : '',
  }
}

function sensitiveReadPath(path: string): boolean {
  return /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.config[\\/]gh|\.docker)(?:[\\/]|$)|(?:^|[\\/])(?:id_rsa|id_ed25519|credentials|credentials\.yaml|config\.json|\.env)(?:$|[.\\/])/i.test(path)
}

const DESTRUCTIVE_TOOL = /(?:^|[_-])(?:delete|destroy|remove|erase|purge|drop|truncate|wipe|unlink|rmdir|reset|revoke)(?:$|[_-])/i
const EXTERNAL_WRITE_TOOL = /(?:^|[_-])(?:deploy|publish|push|upload|send|post|release|merge|submit|create[-_]?(?:issue|pull[-_]?request))(?:$|[_-])/i
const SECURITY_CHANGE_TOOL = /(?:^|[_-])(?:chmod|chown|permission|permissions|policy|grant|revoke|role|credential|credentials|secret|secrets|auth)(?:$|[_-])/i

function riskyPluginToolReason(name: string): string | undefined {
  if (DESTRUCTIVE_TOOL.test(name)) return `registered tool name indicates a destructive operation: ${name}`
  if (EXTERNAL_WRITE_TOOL.test(name)) return `registered tool name indicates an external write: ${name}`
  if (SECURITY_CHANGE_TOOL.test(name)) return `registered tool name indicates a security-boundary change: ${name}`
  return undefined
}

/** Exact, audited session/control-plane tools whose effects stay in Harness state. */
const SESSION_STATE_TOOLS = new Set([
  'ask_user_question',
  'todo_write',
  'get_goal',
  'create_goal',
  'update_goal',
  'exit_plan_mode',
  'skill',
  'report',
])

/** Read-only tools backed by owner/workspace-authorized Harness services. */
const HARNESS_READ_TOOLS = new Set([
  'job_output',
  'job_list',
  'schedule_list',
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
  'terminal_read',
  'terminal_list',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
])

/** Lifecycle controls that stop only owner-scoped background work. */
const OWNER_CONTROL_TOOLS = new Set([
  'job_kill',
  'terminal_signal',
  'terminal_close',
])

/**
 * Audited AgentTeams control calls. These mutate only workspace-local team
 * coordination state. Member file/shell calls are separate tool executions
 * and inherit Auto from their captain in the runtime integration.
 */
const AGENT_TEAMS_CONTROL_TOOLS = new Set([
  'agent_teams_create',
  'agent_teams_add_member',
  'agent_teams_remove_member',
  'agent_teams_create_task',
  'agent_teams_claim_task',
  'agent_teams_update_task',
  'agent_teams_send_message',
  'agent_teams_status',
  // The verified implementation archives team state instead of erasing it.
  'agent_teams_delete',
])

/** Synchronous hard-deny reason suitable for the monotonic tool guard. */
export function hardDenyReason(exec: Readonly<ToolExecution>, roots: PolicyRoots): string | undefined {
  const args = record(exec.arguments)
  if ((/^(?:web_fetch|curl|wget)/i.test(exec.name) || EXTERNAL_WRITE_TOOL.test(exec.name)) && containsCredentialMaterial(exec.arguments)) {
    return 'external call contains credential or private-key material'
  }
  if ((exec.name === 'bash' || exec.name === 'pwsh') && typeof args?.command === 'string') {
    return hardDenyShellReason(args.command, exec.name, roots)
  }
  if (['write', 'edit', 'apply_patch'].includes(exec.name)
    || (exec.name === 'str_replace_editor' && args?.command !== 'view')) {
    const path = pathArgument(args)
    if (path !== undefined) {
      const reason = hardDestructiveTargetReason(path, roots)
      if (reason !== undefined) return `mutation targets ${reason}`
    }
  }
  if (DESTRUCTIVE_TOOL.test(exec.name)) {
    const path = pathArgument(args)
    if (path !== undefined) {
      const reason = hardDestructiveTargetReason(path, roots)
      if (reason !== undefined) return `destructive plugin tool targets ${reason}`
    }
  }
  return undefined
}

/** Deterministic first-pass classification for every normal tool call. */
export function assessTool(exec: Readonly<ToolExecution>, roots: PolicyRoots, artifacts: ArtifactRegistry): Assessment {
  const hard = hardDenyReason(exec, roots)
  if (hard !== undefined) return { decision: 'deny', reason: hard, classifierEligible: false }
  const args = record(exec.arguments)
  const owner = exec.agent?.session

  if ((exec.name === 'bash' || exec.name === 'pwsh') && typeof args?.command === 'string') {
    return assessShell(args.command, exec.name, roots, artifacts, owner)
  }
  if (exec.name === 'bash' || exec.name === 'pwsh') {
    return { decision: 'ask', reason: `${exec.name} command argument is missing or invalid`, classifierEligible: false }
  }

  const readTools = new Set(['read', 'read_image', 'grep', 'glob', 'lsp'])
  if (readTools.has(exec.name)) {
    const path = pathArgument(args)
    if (path === undefined) return { decision: 'allow', reason: 'read-only project inspection', classifierEligible: false }
    const normalized = normalizePath(path, roots.workspace, roots.home)
    return !isWithin(roots.workspace, normalized) && sensitiveReadPath(normalized)
      ? { decision: 'ask', reason: `reading sensitive data outside the workspace requires semantic review: ${normalized}`, classifierEligible: true }
      : { decision: 'allow', reason: 'read-only inspection without a sensitive credential target', classifierEligible: false }
  }

  if (exec.name === 'write' || exec.name === 'edit') {
    const path = pathArgument(args)
    if (path === undefined) return { decision: 'ask', reason: `${exec.name} target path is missing`, classifierEligible: false }
    const normalized = normalizePath(path, roots.workspace, roots.home)
    if (isProtectedProjectPath(normalized, roots)) {
      return {
        decision: 'ask', reason: `mutation of protected project metadata requires specific user authorization: ${normalized}`, classifierEligible: true,
        filesystemEffects: [{ kind: 'create-or-overwrite', path: normalized, existedBefore: existedBefore(normalized) }],
      }
    }
    const targetExisted = existedBefore(normalized)
    return {
      decision: 'allow',
      reason: isWithin(roots.workspace, normalized)
        ? 'routine project-local file edit'
        : 'external mutation is delegated to the workspace-write filesystem sandbox',
      classifierEligible: false,
      ...(targetExisted ? {} : { plannedCreates: [normalized] }),
      filesystemEffects: [{ kind: 'create-or-overwrite', path: normalized, existedBefore: targetExisted }],
    }
  }


  if (exec.name === 'str_replace_editor') {
    const command = args?.command
    const path = typeof args?.path === 'string' ? args.path : undefined
    if (!['view', 'create', 'str_replace', 'insert'].includes(String(command))) {
      return { decision: 'ask', reason: 'str_replace_editor command is missing or invalid', classifierEligible: false }
    }
    if (path === undefined) {
      return { decision: 'ask', reason: 'str_replace_editor target path is missing', classifierEligible: false }
    }
    const normalized = normalizePath(path, roots.workspace, roots.home)
    if (command === 'view') {
      return !isWithin(roots.workspace, normalized) && sensitiveReadPath(normalized)
        ? { decision: 'ask', reason: `reading sensitive data outside the workspace requires semantic review: ${normalized}`, classifierEligible: true }
        : { decision: 'allow', reason: 'read-only inspection without a sensitive credential target', classifierEligible: false }
    }
    if (isProtectedProjectPath(normalized, roots)) {
      return {
        decision: 'ask', reason: `mutation of protected project metadata requires specific user authorization: ${normalized}`, classifierEligible: true,
        filesystemEffects: [{ kind: 'create-or-overwrite', path: normalized, existedBefore: existedBefore(normalized) }],
      }
    }
    const targetExisted = existedBefore(normalized)
    return {
      decision: 'allow',
      reason: isWithin(roots.workspace, normalized)
        ? 'routine project-local file edit'
        : 'external mutation is delegated to the workspace-write filesystem sandbox',
      classifierEligible: false,
      ...(command === 'create' && !targetExisted ? { plannedCreates: [normalized] } : {}),
      filesystemEffects: [{ kind: 'create-or-overwrite', path: normalized, existedBefore: targetExisted }],
    }
  }

  if (SESSION_STATE_TOOLS.has(exec.name)) {
    return { decision: 'allow', reason: 'trusted Harness session-state operation', classifierEligible: false }
  }
  if (HARNESS_READ_TOOLS.has(exec.name)) {
    return { decision: 'allow', reason: 'trusted read-only Harness operation', classifierEligible: false }
  }
  if (AGENT_TEAMS_CONTROL_TOOLS.has(exec.name)) {
    return { decision: 'allow', reason: 'trusted AgentTeams coordination operation', classifierEligible: false }
  }
  if (OWNER_CONTROL_TOOLS.has(exec.name)) {
    return { decision: 'allow', reason: 'trusted owner-scoped lifecycle control', classifierEligible: false }
  }

  // Persistent terminals retain cwd, environment, aliases, and interpreter
  // state across calls. A standalone text fragment cannot be parsed with the
  // same guarantees as one Bash/PowerShell invocation, so never fast-path it.
  if (exec.name === 'terminal_open' || exec.name === 'terminal_send') {
    return { decision: 'ask', reason: 'stateful terminal execution requires semantic review because prior shell state is hidden', classifierEligible: true }
  }

  if (['web_search', 'web_fetch', 'time', 'weather'].includes(exec.name)) {
    return { decision: 'allow', reason: 'read-only external information lookup', classifierEligible: false }
  }
  if (['subagent', 'workflow', 'ralph', 'spawn_agent', 'send_message', 'wait_agent', 'list_agents', 'interrupt_agent', 'read_thread', 'wait_threads'].includes(exec.name)) {
    return { decision: 'allow', reason: 'orchestration call; child tool actions remain independently checked', classifierEligible: false }
  }
  if (['git_push', 'deploy', 'publish', 'send_email', 'create_issue', 'create_pull_request'].includes(exec.name)) {
    return { decision: 'ask', reason: `external write requires specific user authorization: ${exec.name}`, classifierEligible: true }
  }
  const riskyReason = riskyPluginToolReason(exec.name)
  if (riskyReason !== undefined) {
    return { decision: 'ask', reason: riskyReason, classifierEligible: true }
  }
  return { decision: 'allow', reason: `ordinary registered plugin tool: ${exec.name}`, classifierEligible: false }
}
