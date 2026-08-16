import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { isArtifactArea, normalizePath, type PolicyRoots } from './paths.js'

interface PendingCreation {
  readonly owner: object
  readonly paths: readonly string[]
}

interface WorkspaceSnapshot {
  readonly workspace: string
  readonly capturedAt: number
  readonly directChildren: ReadonlyMap<string, ArtifactIdentity>
  readonly allPaths?: ReadonlyMap<string, ArtifactIdentity>
}

interface PendingShellDiscovery {
  readonly owner: object
  readonly before: WorkspaceSnapshot
}

interface ArtifactIdentity {
  readonly dev: number
  readonly ino: number
  readonly birthtimeMs: number
  readonly kind: 'file' | 'directory' | 'symlink' | 'other'
}

function identityOf(path: string): ArtifactIdentity | undefined {
  try {
    const stat = lstatSync(path)
    return {
      dev: stat.dev,
      ino: stat.ino,
      birthtimeMs: stat.birthtimeMs,
      kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
    }
  } catch {
    return undefined
  }
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.kind === right.kind
}

function identityKey(identity: ArtifactIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.birthtimeMs}:${identity.kind}`
}

const MAX_DISCOVERY_PATHS = 50_000

interface TreeWalk {
  readonly paths: ReadonlyMap<string, ArtifactIdentity>
  readonly complete: boolean
}

function boundedTreePaths(seedPaths: readonly string[], workspace: string, home: string): TreeWalk {
  const paths = new Map<string, ArtifactIdentity>()
  const pending = [...seedPaths]
  let index = 0
  try {
    // Breadth-first traversal records useful shallow project files before a
    // large generated subtree reaches the cap. Partial walks are used only
    // beneath a direct child proven absent before the exact shell call.
    while (index < pending.length) {
      const path = pending[index] as string
      index += 1
      if (paths.size >= MAX_DISCOVERY_PATHS) return { paths, complete: false }
      const identity = identityOf(path)
      if (identity === undefined) return { paths, complete: false }
      paths.set(path, identity)
      if (identity.kind !== 'directory') continue
      for (const entry of readdirSync(path)) pending.push(normalizePath(join(path, entry), workspace, home))
    }
    return { paths, complete: true }
  } catch {
    return { paths, complete: false }
  }
}

/**
 * Capture a bounded workspace view without following symlinks. If a broad
 * workspace such as /tmp exceeds the cap, direct children remain usable: a
 * newly created project directory can still be attributed safely as a whole.
 */
function workspaceSnapshot(roots: PolicyRoots): WorkspaceSnapshot | undefined {
  const workspace = normalizePath(roots.workspace, roots.workspace, roots.home)
  const rootIdentity = identityOf(workspace)
  if (rootIdentity?.kind !== 'directory') {
    return { workspace, capturedAt: Date.now(), directChildren: new Map(), allPaths: new Map() }
  }
  try {
    const directPaths = readdirSync(workspace).map(entry => normalizePath(join(workspace, entry), workspace, roots.home))
    const directChildren = new Map<string, ArtifactIdentity>()
    for (const path of directPaths) {
      const identity = identityOf(path)
      if (identity === undefined) return undefined
      directChildren.set(path, identity)
    }
    const walk = boundedTreePaths(directPaths, workspace, roots.home)
    const capturedAt = Date.now()
    return walk.complete
      ? { workspace, capturedAt, directChildren, allPaths: walk.paths }
      : { workspace, capturedAt, directChildren }
  } catch {
    return undefined
  }
}

/** In-memory provenance for exact paths created successfully during the live session. */
export class ArtifactRegistry {
  private readonly created = new WeakMap<object, Map<string, ArtifactIdentity>>()
  private readonly pending = new Map<symbol, PendingCreation>()
  private readonly pendingShellDiscovery = new Map<symbol, PendingShellDiscovery>()

  /** Whether a path was observed as created in this exact live session. */
  has(owner: object | undefined, path: string, roots: PolicyRoots): boolean {
    if (owner === undefined) return false
    const normalized = normalizePath(path, roots.workspace, roots.home)
    const recorded = this.created.get(owner)?.get(normalized)
    const current = identityOf(normalized)
    return isArtifactArea(normalized, roots)
      && recorded !== undefined
      && current !== undefined
      && sameIdentity(recorded, current)
  }

  /**
   * Whether every object in a recursively deleted tree is still an observed
   * Session artifact. This prevents an old file moved into a new directory
   * from inheriting the directory's automatic-cleanup authority.
   */
  hasTree(owner: object | undefined, path: string, roots: PolicyRoots): boolean {
    if (owner === undefined) return false
    const normalized = normalizePath(path, roots.workspace, roots.home)
    const recordedPaths = this.created.get(owner)
    if (!isArtifactArea(normalized, roots) || recordedPaths === undefined) return false
    let remaining = 4096
    const visit = (candidate: string): boolean => {
      remaining -= 1
      if (remaining < 0) return false
      const recorded = recordedPaths.get(candidate)
      const current = identityOf(candidate)
      if (recorded === undefined || current === undefined || !sameIdentity(recorded, current)) return false
      if (current.kind !== 'directory') return true
      try {
        return readdirSync(candidate).every(entry => visit(join(candidate, entry)))
      } catch {
        return false
      }
    }
    return visit(normalized)
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

  /**
   * Observe a normal shell call so files created by arbitrary project tools or
   * scaffolders can be distinguished from data that existed before the call.
   */
  discoverShellCreates(exec: ToolExecution, roots: PolicyRoots): void {
    if (exec.name !== 'bash' && exec.name !== 'pwsh') return
    const owner = exec.agent?.session
    if (owner === undefined) return
    const before = workspaceSnapshot(roots)
    if (before !== undefined) this.pendingShellDiscovery.set(exec.token, { owner, before })
  }

  /** Promote successful creates and forget every pending execution. */
  settle(exec: ToolExecution, result: ToolExecutionResult, roots: PolicyRoots): void {
    const owner = exec.agent?.session
    const pending = this.pending.get(exec.token)
    const discovery = this.pendingShellDiscovery.get(exec.token)
    this.pending.delete(exec.token)
    this.pendingShellDiscovery.delete(exec.token)
    if (owner === undefined || result.isError) return
    const value = result.value
    const shellSucceeded = typeof value === 'object' && value !== null
      && 'exitCode' in value && value.exitCode === 0
    const pendingSucceeded = exec.name === 'bash' || exec.name === 'pwsh' ? shellSucceeded : true
    if (pending !== undefined && pending.owner === owner && pendingSucceeded) {
      for (const path of pending.paths) this.add(owner, path)
    }
    if (discovery !== undefined && discovery.owner === owner) {
      const after = workspaceSnapshot(roots)
      if (after !== undefined && after.workspace === discovery.before.workspace) {
        if (discovery.before.allPaths !== undefined && after.allPaths !== undefined) {
          const identitiesBefore = new Set([...discovery.before.allPaths.values()].map(identityKey))
          for (const [path, identity] of after.allPaths) {
            if (!discovery.before.allPaths.has(path) && !identitiesBefore.has(identityKey(identity))) {
              this.add(owner, path)
            }
          }
        } else {
          // A broad workspace may be too large to scan fully. Descendants of
          // a new direct child are promoted only when their filesystem birth
          // time is after the exact pre-call snapshot. An older inode moved
          // into that new tree therefore remains protected.
          const directIdentitiesBefore = new Set([...discovery.before.directChildren.values()].map(identityKey))
          const newlyCreatedRoots = [...after.directChildren]
            .filter(([path, identity]) => !discovery.before.directChildren.has(path)
              && !directIdentitiesBefore.has(identityKey(identity)))
            .map(([path]) => path)
          for (const root of newlyCreatedRoots) {
            const tree = boundedTreePaths([root], after.workspace, roots.home)
            for (const [path, identity] of tree.paths) {
              if (identity.birthtimeMs >= discovery.before.capturedAt) this.add(owner, path)
            }
          }
        }
      }
    }
    if (exec.name === 'write' && typeof value === 'object' && value !== null
      && 'operation' in value && value.operation === 'create'
      && 'path' in value && typeof value.path === 'string') {
      const path = normalizePath(value.path, roots.workspace, roots.home)
      if (isArtifactArea(path, roots)) this.add(owner, path)
    }
  }

  private add(owner: object, path: string): void {
    const identity = identityOf(path)
    if (identity === undefined) return
    const paths = this.created.get(owner) ?? new Map<string, ArtifactIdentity>()
    paths.set(path, identity)
    this.created.set(owner, paths)
  }
}
