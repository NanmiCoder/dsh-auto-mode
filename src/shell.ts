import { basename } from 'node:path'
import type { ArtifactRegistry } from './artifacts.js'
import {
  hardDestructiveTargetReason,
  isArtifactArea,
  isProtectedProjectPath,
  isWithin,
  normalizePath,
  type PolicyRoots,
} from './paths.js'
import type { Assessment } from './types.js'

export type ShellKind = 'bash' | 'pwsh'

export interface ParsedCommand {
  readonly tokens: readonly string[]
}

function ambiguous(reason: string): Assessment {
  return { decision: 'ask', reason, classifierEligible: true }
}

function manualReview(reason: string): Assessment {
  return { decision: 'ask', reason, classifierEligible: false }
}

function semanticReview(reason: string): Assessment {
  return { decision: 'ask', reason, classifierEligible: true }
}

function denied(reason: string): Assessment {
  return { decision: 'deny', reason, classifierEligible: false }
}

function allowed(reason: string, plannedCreates?: readonly string[]): Assessment {
  return {
    decision: 'allow', reason, classifierEligible: false,
    ...(plannedCreates === undefined || plannedCreates.length === 0 ? {} : { plannedCreates }),
  }
}

/** Parse one static shell command. Any executable shell syntax fails closed. */
export function parseSimpleCommand(source: string, shell: ShellKind): ParsedCommand | undefined {
  const input = source.trim()
  if (input === '' || /[\n\r;&|<>(){}\[\]*?]/.test(input)) return undefined
  if (shell === 'bash' && (input.includes('$') || input.includes('`'))) return undefined
  if (shell === 'pwsh' && (input.includes('$') || input.includes('`') || /%[^%]+%/.test(input))) return undefined

  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | undefined
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string
    if (quote === undefined && /\s/.test(char)) {
      if (token !== '') {
        tokens.push(token)
        token = ''
      }
      continue
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single'
      continue
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double'
      continue
    }
    if (shell === 'bash' && char === '\\' && quote !== 'single') {
      const next = input[index + 1]
      if (next === undefined) return undefined
      token += next
      index += 1
      continue
    }
    token += char
  }
  if (quote !== undefined) return undefined
  if (token !== '') tokens.push(token)
  if (tokens.length === 0 || tokens[0]?.includes('=') === true) return undefined
  return { tokens }
}

function commandName(token: string): string {
  return basename(token.replaceAll('\\', '/')).toLowerCase()
}

function dynamicHomeTarget(source: string): boolean {
  return /(?:\$\{?HOME\}?|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%|%HOME%)/i.test(source)
}

function sensitiveMarker(source: string): boolean {
  return /(?:\.ssh[\\/]|\.gnupg[\\/]|\.aws[\\/]|\.kube[\\/]|\.credentials\.yaml|id_(?:rsa|ed25519)|(?:API|AUTH|ACCESS|SECRET)[_-]?KEY|TOKEN|PASSWORD)/i.test(source)
}

/** Hard-deny shell patterns independent of parsing and classifier behavior. */
export function hardDenyShellReason(source: string, shell: ShellKind, roots: PolicyRoots): string | undefined {
  const compact = source.trim()
  if (/(?:^|\s)(?:sudo|doas|su)(?:\s|$)/i.test(compact)) return 'privilege escalation is not permitted by auto mode'
  if (/(?:set-executionpolicy|disable-windowsdefender|clear-disk|format-volume|remove-partition|bcdedit)(?:\s|$)/i.test(compact)) {
    return 'operating-system security or disk policy changes are not permitted'
  }
  if (/(?:curl|wget|invoke-webrequest|invoke-restmethod)/i.test(compact) && sensitiveMarker(compact)) {
    return 'credential or private-data exfiltration pattern is not permitted'
  }
  if (dynamicHomeTarget(compact) && /(?:rm|remove-item|rmdir)\b/i.test(compact)) {
    return 'dynamic deletion targeting the user home is not permitted'
  }

  const parsed = parseSimpleCommand(compact, shell)
  if (parsed === undefined) return undefined
  const name = commandName(parsed.tokens[0] as string)
  const deletion = deletionSpec(name, parsed.tokens, shell)
  if (deletion === undefined) return undefined
  for (const target of deletion.targets) {
    const normalized = normalizePath(target, roots.workspace, roots.home)
    const protectedReason = hardDestructiveTargetReason(normalized, roots)
    if (protectedReason !== undefined) return `destructive operation targets ${protectedReason}`
    if (deletion.recursive && !isWithin(roots.workspace, normalized)) {
      return `recursive deletion outside the workspace is not permitted: ${normalized}`
    }
  }
  return undefined
}

interface DeletionSpec {
  readonly recursive: boolean
  readonly targets: readonly string[]
}

function deletionSpec(name: string, tokens: readonly string[], shell: ShellKind): DeletionSpec | undefined {
  if (shell === 'bash' && ['rm', 'rmdir', 'unlink'].includes(name)) {
    const flags = tokens.slice(1).filter(token => token.startsWith('-'))
    const targets = tokens.slice(1).filter(token => !token.startsWith('-'))
    return { recursive: flags.some(flag => flag === '--recursive' || /^-[^-]*r/i.test(flag)), targets }
  }
  if (shell === 'pwsh' && ['remove-item', 'rm', 'ri', 'del', 'erase', 'rmdir'].includes(name)) {
    const targets: string[] = []
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] as string
      if (/^-(?:path|literalpath)$/i.test(token)) {
        const value = tokens[index + 1]
        if (value !== undefined) targets.push(value)
        index += 1
      } else if (!token.startsWith('-')) {
        targets.push(token)
      }
    }
    return { recursive: tokens.some(token => /^-(?:recurse|r)$/i.test(token)), targets }
  }
  return undefined
}

function nestedInterpreter(name: string): boolean {
  return ['sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)
}

function explicitPaths(tokens: readonly string[], roots: PolicyRoots): string[] {
  return tokens
    .filter(token => token === '~' || token.startsWith('./') || token.startsWith('../') || token.startsWith('/')
      || token.startsWith('~\\') || token.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token))
    .map(token => normalizePath(token, roots.workspace, roots.home))
}

function workspacePathsAreRoutine(tokens: readonly string[], roots: PolicyRoots): boolean {
  return explicitPaths(tokens, roots).every(path => isWithin(roots.workspace, path) && !isProtectedProjectPath(path, roots))
}

function buildOrTest(tokens: readonly string[]): boolean {
  const name = commandName(tokens[0] as string)
  const first = tokens[1]?.toLowerCase()
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(name)) {
    if (first === 'test') return true
    if (first === 'run') return /^(?:build|test|typecheck|check|verify|lint)(?::[\w-]+)?$/.test(tokens[2] ?? '')
    if (name === 'pnpm' && first === 'exec') return ['tsc', 'vitest', 'eslint'].includes(commandName(tokens[2] ?? ''))
    return false
  }
  if (['tsc', 'vitest', 'eslint', 'pytest'].includes(name)) return true
  if (['cargo', 'go'].includes(name)) return ['build', 'test', 'check', 'vet'].includes(first ?? '')
  if (name === 'make') return tokens.length === 1 || tokens.slice(1).every(token => /^(?:build|test|check|verify|lint)$/.test(token))
  return false
}

function versionProbe(tokens: readonly string[]): boolean {
  const name = commandName(tokens[0] as string)
  if (['node', 'python', 'python3', 'pnpm', 'npm', 'yarn', 'bun', 'git', 'cargo', 'rustc'].includes(name)) {
    return tokens.length === 2 && ['--version', '-v', 'version'].includes(tokens[1]?.toLowerCase() ?? '')
  }
  return name === 'go' && tokens.length === 2 && tokens[1]?.toLowerCase() === 'version'
}

function readOnlyCommand(name: string, tokens: readonly string[], shell: ShellKind): boolean {
  if (shell === 'bash') {
    if (['pwd', 'ls', 'rg', 'grep', 'head', 'tail', 'cat', 'wc', 'od', 'du', 'stat', 'file', 'which', 'type'].includes(name)) return true
    if (name === 'sed') return tokens.includes('-n')
    if (name === 'git') return ['status', 'diff', 'log', 'show', 'rev-parse'].includes(tokens[1]?.toLowerCase() ?? '')
    return false
  }
  return ['get-location', 'get-childitem', 'get-content', 'select-string', 'get-item', 'test-path'].includes(name)
}

function creationSpec(name: string, tokens: readonly string[], shell: ShellKind, roots: PolicyRoots): { paths: string[]; protected: boolean } | undefined {
  let raw: string[] | undefined
  if (shell === 'bash' && ['mkdir', 'touch'].includes(name)) raw = tokens.slice(1).filter(token => !token.startsWith('-'))
  if (shell === 'pwsh' && name === 'new-item') {
    raw = []
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index] as string
      if (/^-(?:path|literalpath)$/i.test(token)) {
        const value = tokens[index + 1]
        if (value !== undefined) raw.push(value)
        index += 1
      } else if (!token.startsWith('-') && !/^(?:file|directory)$/i.test(token)) raw.push(token)
    }
  }
  if (raw === undefined || raw.length === 0) return undefined
  const paths = raw.map(path => normalizePath(path, roots.workspace, roots.home))
  return { paths, protected: paths.some(path => !isWithin(roots.workspace, path) || isProtectedProjectPath(path, roots)) }
}

/** Classify one Bash or PowerShell call after hard-deny evaluation. */
export function assessShell(
  source: string,
  shell: ShellKind,
  roots: PolicyRoots,
  artifacts: ArtifactRegistry,
  owner: object | undefined,
): Assessment {
  const hard = hardDenyShellReason(source, shell, roots)
  if (hard !== undefined) return denied(hard)
  const parsed = parseSimpleCommand(source, shell)
  if (parsed === undefined) return manualReview(`${shell} command is not one static simple command`)
  const name = commandName(parsed.tokens[0] as string)
  if (nestedInterpreter(name)) return manualReview('nested shell execution requires manual review')

  const deletion = deletionSpec(name, parsed.tokens, shell)
  if (deletion !== undefined) {
    if (deletion.targets.length === 0) return manualReview('deletion target could not be determined')
    const paths = deletion.targets.map(path => normalizePath(path, roots.workspace, roots.home))
    if (paths.every(path => artifacts.has(owner, path, roots) && isArtifactArea(path, roots))) {
      return allowed(`delete exact session-created artifact${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`)
    }
    return semanticReview(`deleting pre-session or unobserved data requires specific user authorization: ${paths.join(', ')}`)
  }

  if (readOnlyCommand(name, parsed.tokens, shell)) {
    return workspacePathsAreRoutine(parsed.tokens.slice(1), roots)
      ? allowed('static read-only command inside the workspace')
      : semanticReview('read-only command references a protected or external path')
  }
  if (versionProbe(parsed.tokens)) return allowed('static development-tool version probe')
  if (buildOrTest(parsed.tokens)) {
    return workspacePathsAreRoutine(parsed.tokens.slice(1), roots)
      ? allowed('recognized project build, test, or verification command')
      : semanticReview('build or test command references a protected or external path')
  }

  const creation = creationSpec(name, parsed.tokens, shell, roots)
  if (creation !== undefined) {
    return creation.protected
      ? semanticReview(`creating outside routine project content requires specific user authorization: ${creation.paths.join(', ')}`)
      : allowed('create exact project-local artifacts', creation.paths)
  }

  if (shell === 'bash' && ['cp', 'mv'].includes(name)) {
    const paths = explicitPaths(parsed.tokens.slice(1).filter(token => !token.startsWith('-')), roots)
    return paths.length > 0 && paths.every(path => isWithin(roots.workspace, path) && !isProtectedProjectPath(path, roots))
      ? allowed('static project-local file operation')
      : semanticReview('file move/copy target is external, protected, or unclear')
  }

  if (name === 'git' && ['reset', 'clean', 'commit', 'push', 'rebase', 'checkout', 'switch', 'branch', 'tag'].includes(parsed.tokens[1]?.toLowerCase() ?? '')) {
    return semanticReview(`Git state-changing command requires specific user authorization: ${parsed.tokens.slice(0, 3).join(' ')}`)
  }
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'ssh', 'scp', 'rsync'].includes(name)) {
    return semanticReview(`external network operation requires specific user authorization when it writes or transmits data: ${name}`)
  }
  if (/^(?:dropdb|createdb|psql|mysql|mongosh|redis-cli|kubectl|terraform|ansible|systemctl|launchctl)$/.test(name)) {
    return semanticReview(`database, service, or infrastructure operation requires specific user authorization: ${name}`)
  }
  return ambiguous(`unrecognized ${shell} command requires independent classification: ${name}`)
}
