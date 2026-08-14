import { existsSync } from 'node:fs'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isArtifactArea, normalizePath, type PolicyRoots } from './paths.js'

interface PendingCreation {
  readonly owner: object
  readonly paths: readonly string[]
}

/** In-memory provenance for exact paths created successfully during the live session. */
export class ArtifactRegistry {
  private readonly created = new WeakMap<object, Set<string>>()
  private readonly pending = new Map<symbol, PendingCreation>()

  /** Whether a path was observed as created in this exact live session. */
  has(owner: object | undefined, path: string, roots: PolicyRoots): boolean {
    if (owner === undefined) return false
    const normalized = normalizePath(path, roots.workspace, roots.home)
    return isArtifactArea(normalized, roots) && this.created.get(owner)?.has(normalized) === true
  }

  /** Record planned exact creations for settlement-time promotion. */
  plan(exec: ToolExecution, paths: readonly string[], roots: PolicyRoots): void {
    const owner = exec.agent?.session
    if (owner === undefined) return
    const eligible = paths
      .map(path => normalizePath(path, roots.workspace, roots.home))
      .filter(path => isArtifactArea(path, roots) && !existsSync(path))
    if (eligible.length > 0) this.pending.set(exec.token, { owner, paths: eligible })
  }

  /** Promote successful creates and forget every pending execution. */
  settle(exec: ToolExecution, result: ToolExecutionResult, roots: PolicyRoots): void {
    const owner = exec.agent?.session
    const pending = this.pending.get(exec.token)
    this.pending.delete(exec.token)
    if (owner === undefined || result.isError) return
    const value = result.value
    const shellSucceeded = typeof value === 'object' && value !== null
      && 'exitCode' in value && value.exitCode === 0
    if (pending !== undefined && pending.owner === owner && shellSucceeded) {
      for (const path of pending.paths) this.add(owner, path)
    }
    if (exec.name === 'write' && typeof value === 'object' && value !== null
      && 'operation' in value && value.operation === 'create'
      && 'path' in value && typeof value.path === 'string') {
      const path = normalizePath(value.path, roots.workspace, roots.home)
      if (isArtifactArea(path, roots)) this.add(owner, path)
    }
  }

  private add(owner: object, path: string): void {
    const paths = this.created.get(owner) ?? new Set<string>()
    paths.add(path)
    this.created.set(owner, paths)
  }
}
