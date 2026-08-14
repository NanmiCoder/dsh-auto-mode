import { existsSync } from 'node:fs';
import { isArtifactArea, normalizePath } from './paths.js';
/** In-memory provenance for exact paths created successfully during the live session. */
export class ArtifactRegistry {
    created = new WeakMap();
    pending = new Map();
    /** Whether a path was observed as created in this exact live session. */
    has(owner, path, roots) {
        if (owner === undefined)
            return false;
        const normalized = normalizePath(path, roots.workspace, roots.home);
        return isArtifactArea(normalized, roots) && this.created.get(owner)?.has(normalized) === true;
    }
    /** Record planned exact creations for settlement-time promotion. */
    plan(exec, paths, roots) {
        const owner = exec.agent?.session;
        if (owner === undefined)
            return;
        const eligible = paths
            .map(path => normalizePath(path, roots.workspace, roots.home))
            .filter(path => isArtifactArea(path, roots) && !existsSync(path));
        if (eligible.length > 0)
            this.pending.set(exec.token, { owner, paths: eligible });
    }
    /** Promote successful creates and forget every pending execution. */
    settle(exec, result, roots) {
        const owner = exec.agent?.session;
        const pending = this.pending.get(exec.token);
        this.pending.delete(exec.token);
        if (owner === undefined || result.isError)
            return;
        const value = result.value;
        const shellSucceeded = typeof value === 'object' && value !== null
            && 'exitCode' in value && value.exitCode === 0;
        if (pending !== undefined && pending.owner === owner && shellSucceeded) {
            for (const path of pending.paths)
                this.add(owner, path);
        }
        if (exec.name === 'write' && typeof value === 'object' && value !== null
            && 'operation' in value && value.operation === 'create'
            && 'path' in value && typeof value.path === 'string') {
            const path = normalizePath(value.path, roots.workspace, roots.home);
            if (isArtifactArea(path, roots))
                this.add(owner, path);
        }
    }
    add(owner, path) {
        const paths = this.created.get(owner) ?? new Set();
        paths.add(path);
        this.created.set(owner, paths);
    }
}
//# sourceMappingURL=artifacts.js.map