import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { ArtifactRegistry } from './artifacts.js'
import { createHttpClassifier, sanitizeClassifierArguments, sanitizeClassifierText } from './classifier.js'
import { createDshClassifier } from './dsh-classifier.js'
import { AutoApprovalGrants } from './escalation.js'
import { resolveRoots, type RootOptions } from './paths.js'
import { assessTool, hardDenyReason, sandboxEscalationRequest } from './policy.js'
import type { SafetyClassifier } from './types.js'

export { ArtifactRegistry } from './artifacts.js'
export { createHttpClassifier, sanitizeClassifierArguments, type HttpClassifierConfig } from './classifier.js'
export { createDshClassifier, type DshClassifierConfig } from './dsh-classifier.js'
export { AutoApprovalGrants } from './escalation.js'
export * from './paths.js'
export * from './policy.js'
export * from './shell.js'
export type * from './types.js'

export const name = 'auto-permission-mode'
export const inject = ['tools', 'llm']
/** Official permission preset key that activates this policy. */
export const AUTO_PERMISSION_PRESET = 'auto'

/** Dynamic Agent guidance shown only while Auto (or inherited Auto) is active. */
export const AUTO_MODE_AGENT_GUIDANCE = [
  '<auto_mode_policy>',
  'Work normally inside the workspace-write sandbox. Do not ask the user merely because Bash or PowerShell syntax is unfamiliar.',
  'If a necessary, narrow operation is denied only because it must write outside the workspace, retry that exact operation once with sandbox_permissions="danger-full-access" and a concrete justification. Split unrelated actions into separate calls; never request standing or broad access.',
  'Treat deletion as the highest-risk routine operation. You may clean up an exact artifact created during this live session. For pre-existing data, act only when the direct user explicitly requested deletion of the exact literal target; never widen that authority to a variable, glob, parent directory, sibling, or additional target.',
  'When permanent deletion was not explicitly requested, prefer a reversible move/backup or a version-control-backed deletion. If policy denies a hidden target, resolve it and retry with visible literal paths.',
  'A subagent cannot widen its sandbox. Report a necessary wider action to the parent agent.',
  '</auto_mode_policy>',
].join('\n')

/** Host policy configuration. */
export interface Config {
  readonly presetName?: string
  readonly workspaceRoot?: string
  readonly dshHome?: string
  readonly tempRoots?: string[]
  readonly classifierEndpoint?: string
  readonly classifierProvider?: string
  readonly classifierModel?: string
  readonly classifierApiKeyEnv?: string
  readonly classifierTimeoutMs?: number
  readonly classifierMaxOutputTokens?: number
}

export const Config: z<Config> = z.object({
  presetName: z.string().default(AUTO_PERMISSION_PRESET),
  workspaceRoot: z.string(),
  dshHome: z.string(),
  tempRoots: z.array(z.string()),
  classifierEndpoint: z.string(),
  classifierProvider: z.string(),
  classifierModel: z.string(),
  classifierApiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
  classifierTimeoutMs: z.number().default(8_000),
  classifierMaxOutputTokens: z.number().default(1_024),
})

/** Whether the pending tool call belongs to a session currently using the Auto permission preset. */
export function isAutoPermissionExecution(exec: Readonly<ToolExecution>, presetName = AUTO_PERMISSION_PRESET): boolean {
  const events = exec.agent?.session.events
  return events !== undefined && effectivePermissionPreset(events) === presetName
}

type ParentSessionId = NonNullable<NonNullable<ToolExecution['agent']>['session']['header']['parentSession']>

interface ParentAgentLookup {
  (sessionId: ParentSessionId): ToolExecution['agent'] | undefined
}

/**
 * Auto is a session capability, so official in-process subagents inherit it
 * through their durable parentSession lineage. DSH already inherits the
 * parent's tool composition/sandbox but deliberately pins child approval to
 * `never`; applying Auto to every child tool call keeps routine work moving
 * while ambiguous calls fail closed instead of bypassing this policy.
 */
export function isAutoOrDelegatedPermissionExecution(
  exec: Readonly<ToolExecution>,
  parentAgent: ParentAgentLookup,
  presetName = AUTO_PERMISSION_PRESET,
): boolean {
  return autoPermissionAuthority(exec, parentAgent, presetName) !== undefined
}

/** Resolve the direct Auto session whose durable user messages authorize this execution. */
export function autoPermissionAuthority(
  exec: Readonly<ToolExecution>,
  parentAgent: ParentAgentLookup,
  presetName = AUTO_PERMISSION_PRESET,
): ToolExecution['agent'] | undefined {
  if (isAutoPermissionExecution(exec, presetName)) return exec.agent
  let session = exec.agent?.session
  const visited = new Set<string>()
  while (session?.header?.origin === 'subagent' && session.header.parentSession !== undefined) {
    const parentSessionId = session.header.parentSession
    const parentKey = String(parentSessionId)
    if (visited.has(parentKey)) return undefined
    visited.add(parentKey)
    const parent = parentAgent(parentSessionId)
    if (parent === undefined) return undefined
    const parentExec = { ...exec, agent: parent }
    if (isAutoPermissionExecution(parentExec, presetName)) return parent
    session = parent.session
  }
  return undefined
}

function classifierFrom(ctx: Context, config: Config): SafetyClassifier {
  const timeoutMs = config.classifierTimeoutMs ?? 8_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('classifierTimeoutMs must be between 100 and 60000')
  }
  const maxOutputTokens = config.classifierMaxOutputTokens ?? 1_024
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64 || maxOutputTokens > 4_096) {
    throw new Error('classifierMaxOutputTokens must be an integer between 64 and 4096')
  }
  if (config.classifierEndpoint === undefined || config.classifierEndpoint.trim() === '') {
    return createDshClassifier(ctx.llm, {
      timeoutMs,
      maxOutputTokens,
      ...(config.classifierProvider === undefined ? {} : { provider: config.classifierProvider }),
      ...(config.classifierModel === undefined ? {} : { model: config.classifierModel }),
    })
  }
  const endpoint = new URL(config.classifierEndpoint)
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('classifierEndpoint must use HTTPS (HTTP is accepted only for a loopback test service)')
  }
  const envName = config.classifierApiKeyEnv ?? 'DEEPSEEK_API_KEY'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error('classifierApiKeyEnv must be an environment-variable name')
  const apiKey = process.env[envName]
  return createHttpClassifier({
    endpoint: endpoint.href,
    model: config.classifierModel ?? 'deepseek-chat',
    ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
    timeoutMs,
  })
}

function modelRoute(agent: ToolExecution['agent']): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  type AgentSession = NonNullable<ToolExecution['agent']>['session']
  const session = agent?.session as (AgentSession & { requestHeader?: () => { config: LlmCallConfig } | undefined }) | undefined
  const request = session?.requestHeader?.()?.config
  if (request !== undefined) return { provider: request.provider, model: request.model }
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

function trustedUserMessages(authority: ToolExecution['agent']): string[] {
  if (authority === undefined) return []
  const messages: string[] = []
  let remaining = 4_000
  for (let index = authority.session.events.length - 1; index >= 0 && messages.length < 4 && remaining > 0; index -= 1) {
    const event = authority.session.events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter((block): block is Extract<(typeof event.data.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    const sanitized = sanitizeClassifierText(text).slice(0, remaining)
    messages.push(sanitized)
    remaining -= sanitized.length
  }
  return messages.reverse()
}

/** Install the automatic permission policy on the official tool pipeline. */
export function apply(ctx: Context, config: Config = {}): void {
  const artifacts = new ArtifactRegistry()
  const grants = new AutoApprovalGrants()
  const classifierFailures = new WeakMap<object, number>()
  const classifier = classifierFrom(ctx, config)
  const presetName = config.presetName ?? AUTO_PERMISSION_PRESET
  const rootOptions: RootOptions = {
    ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
    ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
    ...(config.tempRoots === undefined ? {} : { tempRoots: config.tempRoots }),
  }
  const rootsFor = (exec: Readonly<ToolExecution>) => resolveRoots(exec.agent?.session.header.cwd, rootOptions)
  const parentAgent: ParentAgentLookup = sessionId => ctx.get('agents')?.get(sessionId)
  const authorityFor = (exec: Readonly<ToolExecution>): ToolExecution['agent'] | undefined => autoPermissionAuthority(
    exec, parentAgent, presetName,
  )
  const isAutoExecution = (exec: Readonly<ToolExecution>): boolean => authorityFor(exec) !== undefined

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'auto-mode:policy',
      order: 111,
      text: ({ agent }) => agent !== undefined && authorityFor({ agent } as Readonly<ToolExecution>) !== undefined
        ? AUTO_MODE_AGENT_GUIDANCE
        : '',
    })
  })

  ctx.tools.guard((exec) => isAutoExecution(exec) ? hardDenyReason(exec, rootsFor(exec)) : undefined)
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!isAutoExecution(exec)) return next()
    const roots = rootsFor(exec)
    const hard = hardDenyReason(exec, roots)
    if (hard !== undefined) return { kind: 'deny', reason: `[auto-mode hard deny] ${hard}` }
    const assessment = assessTool(exec, roots, artifacts)
    if (assessment.plannedCreates !== undefined) artifacts.plan(exec, assessment.plannedCreates, roots)
    if (assessment.decision === 'deny') return { kind: 'deny', reason: `[auto-mode deterministic deny] ${assessment.reason}` }
    const escalation = sandboxEscalationRequest(exec.arguments)
    if (escalation !== undefined) {
      if (escalation.requestedMode !== 'danger-full-access') {
        return { kind: 'deny', reason: `[auto-mode invalid sandbox request] Auto already runs in workspace-write; only an exact one-shot danger-full-access escalation is wider` }
      }
      if (escalation.justification.trim() === '') {
        return { kind: 'deny', reason: '[auto-mode invalid sandbox request] sandbox_permissions requires a non-empty justification' }
      }
      if (authorityFor(exec) !== exec.agent) {
        return { kind: 'deny', reason: '[auto-mode delegated escalation denied] a subagent cannot widen the parent workspace sandbox; report the blocked action to the parent' }
      }
    } else if (assessment.decision === 'allow') {
      return next()
    }
    if (escalation === undefined && !assessment.classifierEligible) {
      return { kind: 'ask', reason: `[auto-mode approval required] ${assessment.reason}` }
    }
    const authority = authorityFor(exec)
    const failureOwner = authority?.session
    try {
      const route = modelRoute(exec.agent) ?? modelRoute(authority)
      const decision = await classifier.classify({
        toolName: exec.name,
        arguments: sanitizeClassifierArguments(exec.arguments),
        workspaceRoot: roots.workspace,
        policyReason: escalation === undefined
          ? assessment.reason
          : `exact one-shot sandbox escalation requested; underlying action: ${assessment.reason}`,
        trustedUserMessages: trustedUserMessages(authority),
        ...(assessment.filesystemEffects === undefined ? {} : { filesystemEffects: assessment.filesystemEffects }),
        ...(escalation === undefined ? {} : {
          sandboxRequest: {
            currentMode: 'workspace-write' as const,
            requestedMode: escalation.requestedMode,
            justification: sanitizeClassifierText(escalation.justification),
            platform: process.platform,
          },
        }),
        ...(route === undefined ? {} : { route }),
      }, exec.signal)
      if (failureOwner !== undefined) classifierFailures.delete(failureOwner)
      if (decision.decision === 'allow') {
        if (escalation !== undefined) grants.plan(exec, escalation)
        return next()
      }
      if (decision.decision === 'deny') return { kind: 'deny', reason: `[auto-mode classifier deny] ${decision.reason}` }
      // A sandbox escalation already owns one exact approval request inside
      // the official tool body. Let it ask there instead of producing two UI
      // prompts (one from tools/pre-execute and another from ctx.approval).
      if (escalation !== undefined) return next()
      return { kind: 'ask', reason: `[auto-mode classifier asks] ${decision.reason}` }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (!exec.signal.aborted && failureOwner !== undefined) {
        const failures = (classifierFailures.get(failureOwner) ?? 0) + 1
        if (failures >= 3) {
          classifierFailures.delete(failureOwner)
          return { kind: 'ask', reason: `[auto-mode classifier unavailable after ${failures} attempts; manual approval required] ${message}` }
        }
        classifierFailures.set(failureOwner, failures)
      }
      return { kind: 'deny', reason: `[auto-mode classifier unavailable; action denied] ${message}` }
    }
  })
  ctx.on('approval/request', (request, next) => {
    const outcome = grants.decide(request)
    return outcome === undefined ? next() : Promise.resolve(outcome)
  }, { prepend: true })
  ctx.on('tools/result', (exec, result) => {
    // A planned grant is scoped to this exact tool call. Always retire it when
    // the call settles, even if the preset changed while the tool was running.
    grants.settle(exec)
    if (!isAutoExecution(exec)) return
    artifacts.settle(exec, result, rootsFor(exec))
  })
}
