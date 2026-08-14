import z from '@deepseek-ai/schemastery';
import { effectivePermissionPreset } from '@deepseek-ai/dsh-permission-presets';
import { ArtifactRegistry } from './artifacts.js';
import { createHttpClassifier, sanitizeClassifierArguments } from './classifier.js';
import { resolveRoots } from './paths.js';
import { assessTool, hardDenyReason } from './policy.js';
export { ArtifactRegistry } from './artifacts.js';
export { createHttpClassifier, sanitizeClassifierArguments } from './classifier.js';
export * from './paths.js';
export * from './policy.js';
export * from './shell.js';
export const name = 'auto-permission-mode';
export const inject = ['tools'];
/** Official permission preset key that activates this policy. */
export const AUTO_PERMISSION_PRESET = 'auto';
export const Config = z.object({
    presetName: z.string().default(AUTO_PERMISSION_PRESET),
    workspaceRoot: z.string(),
    dshHome: z.string(),
    tempRoots: z.array(z.string()),
    classifierEndpoint: z.string(),
    classifierModel: z.string().default('deepseek-chat'),
    classifierApiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
    classifierTimeoutMs: z.number().default(8_000),
});
/** Whether the pending tool call belongs to a session currently using the Auto permission preset. */
export function isAutoPermissionExecution(exec, presetName = AUTO_PERMISSION_PRESET) {
    const events = exec.agent?.session.events;
    return events !== undefined && effectivePermissionPreset(events) === presetName;
}
function classifierFrom(config) {
    if (config.classifierEndpoint === undefined || config.classifierEndpoint.trim() === '')
        return undefined;
    const endpoint = new URL(config.classifierEndpoint);
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
        throw new Error('classifierEndpoint must use HTTPS (HTTP is accepted only for a loopback test service)');
    }
    const envName = config.classifierApiKeyEnv ?? 'DEEPSEEK_API_KEY';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName))
        throw new Error('classifierApiKeyEnv must be an environment-variable name');
    const timeoutMs = config.classifierTimeoutMs ?? 8_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
        throw new Error('classifierTimeoutMs must be between 100 and 60000');
    }
    const apiKey = process.env[envName];
    return createHttpClassifier({
        endpoint: endpoint.href,
        model: config.classifierModel ?? 'deepseek-chat',
        ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
        timeoutMs,
    });
}
/** Install the automatic permission policy on the official tool pipeline. */
export function apply(ctx, config = {}) {
    const artifacts = new ArtifactRegistry();
    const classifier = classifierFrom(config);
    const presetName = config.presetName ?? AUTO_PERMISSION_PRESET;
    const rootOptions = {
        ...(config.workspaceRoot === undefined ? {} : { workspaceRoot: config.workspaceRoot }),
        ...(config.dshHome === undefined ? {} : { dshHome: config.dshHome }),
        ...(config.tempRoots === undefined ? {} : { tempRoots: config.tempRoots }),
    };
    const rootsFor = (exec) => resolveRoots(exec.agent?.session.header.cwd, rootOptions);
    ctx.tools.guard((exec) => isAutoPermissionExecution(exec, presetName) ? hardDenyReason(exec, rootsFor(exec)) : undefined);
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (!isAutoPermissionExecution(exec, presetName))
            return next();
        const roots = rootsFor(exec);
        const assessment = assessTool(exec, roots, artifacts);
        if (assessment.plannedCreates !== undefined)
            artifacts.plan(exec, assessment.plannedCreates, roots);
        if (assessment.decision === 'deny')
            return { kind: 'deny', reason: `[auto-mode hard deny] ${assessment.reason}` };
        if (assessment.decision === 'allow')
            return next();
        if (!assessment.classifierEligible || classifier === undefined) {
            return { kind: 'ask', reason: `[auto-mode approval required] ${assessment.reason}` };
        }
        try {
            const decision = await classifier.classify({
                toolName: exec.name,
                arguments: sanitizeClassifierArguments(exec.arguments),
                workspaceRoot: roots.workspace,
                policyReason: assessment.reason,
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
        if (!isAutoPermissionExecution(exec, presetName))
            return;
        artifacts.settle(exec, result, rootsFor(exec));
    });
}
//# sourceMappingURL=index.js.map