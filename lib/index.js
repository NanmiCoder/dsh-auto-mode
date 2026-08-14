import z from '@deepseek-ai/schemastery';
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets';
import { ArtifactRegistry } from './artifacts.js';
import { createHttpClassifier, sanitizeClassifierArguments, sanitizeClassifierText } from './classifier.js';
import { createDshClassifier } from './dsh-classifier.js';
import { resolveRoots } from './paths.js';
import { assessTool, hardDenyReason } from './policy.js';
export { ArtifactRegistry } from './artifacts.js';
export { createHttpClassifier, sanitizeClassifierArguments } from './classifier.js';
export { createDshClassifier } from './dsh-classifier.js';
export * from './paths.js';
export * from './policy.js';
export * from './shell.js';
export const name = 'auto-permission-mode';
export const inject = ['tools', 'llm'];
/** Official permission preset key that activates this policy. */
export const AUTO_PERMISSION_PRESET = 'auto';
export const Config = z.object({
    presetName: z.string().default(AUTO_PERMISSION_PRESET),
    workspaceRoot: z.string(),
    dshHome: z.string(),
    tempRoots: z.array(z.string()),
    classifierEndpoint: z.string(),
    classifierProvider: z.string(),
    classifierModel: z.string(),
    classifierApiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
    classifierTimeoutMs: z.number().default(8_000),
});
/** Whether the pending tool call belongs to a session currently using the Auto permission preset. */
export function isAutoPermissionExecution(exec, presetName = AUTO_PERMISSION_PRESET) {
    const events = exec.agent?.session.events;
    return events !== undefined && effectivePermissionPreset(events) === presetName;
}
/**
 * Auto is a session capability, so official in-process subagents inherit it
 * through their durable parentSession lineage. DSH already inherits the
 * parent's tool composition/sandbox but deliberately pins child approval to
 * `never`; applying Auto to every child tool call keeps routine work moving
 * while ambiguous calls fail closed instead of bypassing this policy.
 */
export function isAutoOrDelegatedPermissionExecution(exec, parentAgent, presetName = AUTO_PERMISSION_PRESET) {
    return autoPermissionAuthority(exec, parentAgent, presetName) !== undefined;
}
/** Resolve the direct Auto session whose durable user messages authorize this execution. */
export function autoPermissionAuthority(exec, parentAgent, presetName = AUTO_PERMISSION_PRESET) {
    if (isAutoPermissionExecution(exec, presetName))
        return exec.agent;
    let session = exec.agent?.session;
    const visited = new Set();
    while (session?.header?.origin === 'subagent' && session.header.parentSession !== undefined) {
        const parentSessionId = session.header.parentSession;
        const parentKey = String(parentSessionId);
        if (visited.has(parentKey))
            return undefined;
        visited.add(parentKey);
        const parent = parentAgent(parentSessionId);
        if (parent === undefined)
            return undefined;
        const parentExec = { ...exec, agent: parent };
        if (isAutoPermissionExecution(parentExec, presetName))
            return parent;
        session = parent.session;
    }
    return undefined;
}
function classifierFrom(ctx, config) {
    const timeoutMs = config.classifierTimeoutMs ?? 8_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
        throw new Error('classifierTimeoutMs must be between 100 and 60000');
    }
    if (config.classifierEndpoint === undefined || config.classifierEndpoint.trim() === '') {
        return createDshClassifier(ctx.llm, {
            timeoutMs,
            ...(config.classifierProvider === undefined ? {} : { provider: config.classifierProvider }),
            ...(config.classifierModel === undefined ? {} : { model: config.classifierModel }),
        });
    }
    const endpoint = new URL(config.classifierEndpoint);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
        throw new Error('classifierEndpoint must use HTTPS (HTTP is accepted only for a loopback test service)');
    }
    const envName = config.classifierApiKeyEnv ?? 'DEEPSEEK_API_KEY';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName))
        throw new Error('classifierApiKeyEnv must be an environment-variable name');
    const apiKey = process.env[envName];
    return createHttpClassifier({
        endpoint: endpoint.href,
        model: config.classifierModel ?? 'deepseek-chat',
        ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
        timeoutMs,
    });
}
function modelRoute(agent) {
    const session = agent?.session;
    const request = session?.requestHeader?.()?.config;
    if (request !== undefined)
        return { provider: request.provider, model: request.model };
    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    return provider === undefined || model === undefined ? undefined : { provider, model };
}
function trustedUserMessages(authority) {
    if (authority === undefined)
        return [];
    const messages = [];
    let remaining = 4_000;
    for (let index = authority.session.events.length - 1; index >= 0 && messages.length < 4 && remaining > 0; index -= 1) {
        const event = authority.session.events[index];
        if (event?.type !== 'user/message' || event.data.source.kind !== 'user')
            continue;
        const text = event.data.content
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('\n')
            .trim();
        if (text === '')
            continue;
        const sanitized = sanitizeClassifierText(text).slice(0, remaining);
        messages.push(sanitized);
        remaining -= sanitized.length;
    }
    return messages.reverse();
}
/** Install the automatic permission policy on the official tool pipeline. */
export function apply(ctx, config = {}) {
    const artifacts = new ArtifactRegistry();
    const classifier = classifierFrom(ctx, config);
    const presetName = config.presetName ?? AUTO_PERMISSION_PRESET;
    const rootOptions = {
        ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
        ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
        ...(config.tempRoots === undefined ? {} : { tempRoots: config.tempRoots }),
    };
    const rootsFor = (exec) => resolveRoots(exec.agent?.session.header.cwd, rootOptions);
    const parentAgent = sessionId => ctx.get('agents')?.get(sessionId);
    const authorityFor = (exec) => autoPermissionAuthority(exec, parentAgent, presetName);
    const isAutoExecution = (exec) => authorityFor(exec) !== undefined;
    ctx.tools.guard((exec) => isAutoExecution(exec) ? hardDenyReason(exec, rootsFor(exec)) : undefined);
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (!isAutoExecution(exec))
            return next();
        const roots = rootsFor(exec);
        const assessment = assessTool(exec, roots, artifacts);
        if (assessment.plannedCreates !== undefined)
            artifacts.plan(exec, assessment.plannedCreates, roots);
        if (assessment.decision === 'deny')
            return { kind: 'deny', reason: `[auto-mode hard deny] ${assessment.reason}` };
        if (assessment.decision === 'allow')
            return next();
        if (!assessment.classifierEligible) {
            return { kind: 'ask', reason: `[auto-mode approval required] ${assessment.reason}` };
        }
        try {
            const authority = authorityFor(exec);
            const route = modelRoute(exec.agent) ?? modelRoute(authority);
            const decision = await classifier.classify({
                toolName: exec.name,
                arguments: sanitizeClassifierArguments(exec.arguments),
                workspaceRoot: roots.workspace,
                policyReason: assessment.reason,
                trustedUserMessages: trustedUserMessages(authority),
                ...(route === undefined ? {} : { route }),
            }, exec.signal);
            if (decision.decision === 'allow')
                return next();
            if (decision.decision === 'deny')
                return { kind: 'deny', reason: `[auto-mode classifier deny] ${decision.reason}` };
            return { kind: 'ask', reason: `[auto-mode classifier asks] ${decision.reason}` };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { kind: 'ask', reason: `[auto-mode classifier unavailable] ${message}` };
        }
    });
    ctx.on('tools/result', (exec, result) => {
        if (!isAutoExecution(exec))
            return;
        artifacts.settle(exec, result, rootsFor(exec));
    });
}
//# sourceMappingURL=index.js.map