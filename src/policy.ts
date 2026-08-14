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

/** Synchronous hard-deny reason suitable for the monotonic tool guard. */
export function hardDenyReason(exec: Readonly<ToolExecution>, roots: PolicyRoots): string | undefined {
  const args = record(exec.arguments)
  if (/^(?:web_fetch|send_|upload|post_|publish|deploy|curl|wget)/i.test(exec.name) && containsCredentialMaterial(exec.arguments)) {
    return 'external call contains credential or private-key material'
  }
  if ((exec.name === 'bash' || exec.name === 'pwsh') && typeof args?.command === 'string') {
    return hardDenyShellReason(args.command, exec.name, roots)
  }
  if (['write', 'edit', 'apply_patch'].includes(exec.name)) {
    const path = pathArgument(args)
    if (path !== undefined) {
      const reason = hardDestructiveTargetReason(normalizePath(path, roots.workspace, roots.home), roots)
      if (reason !== undefined) return `mutation targets ${reason}`
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
    return isWithin(roots.workspace, normalized)
      ? { decision: 'allow', reason: 'read-only project inspection', classifierEligible: false }
      : { decision: 'ask', reason: `reading outside the workspace requires approval: ${normalized}`, classifierEligible: false }
  }

  if (exec.name === 'write' || exec.name === 'edit') {
    const path = pathArgument(args)
    if (path === undefined) return { decision: 'ask', reason: `${exec.name} target path is missing`, classifierEligible: false }
    const normalized = normalizePath(path, roots.workspace, roots.home)
    if (!isWithin(roots.workspace, normalized) || isProtectedProjectPath(normalized, roots)) {
      return { decision: 'ask', reason: `mutation of external or protected path requires approval: ${normalized}`, classifierEligible: false }
    }
    return { decision: 'allow', reason: 'routine project-local file edit', classifierEligible: false }
  }

  if (['web_search', 'web_fetch', 'time', 'weather'].includes(exec.name)) {
    return { decision: 'allow', reason: 'read-only external information lookup', classifierEligible: false }
  }
  if (['spawn_agent', 'send_message', 'wait_agent', 'list_agents', 'read_thread', 'wait_threads'].includes(exec.name)) {
    return { decision: 'allow', reason: 'orchestration call; child tool actions remain independently checked', classifierEligible: false }
  }
  if (['git_push', 'deploy', 'publish', 'send_email', 'create_issue', 'create_pull_request'].includes(exec.name)) {
    return { decision: 'ask', reason: `external write requires approval: ${exec.name}`, classifierEligible: false }
  }
  return { decision: 'ask', reason: `unknown tool requires independent classification: ${exec.name}`, classifierEligible: true }
}
