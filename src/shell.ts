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

/** One command-line word with the static properties this policy depends on. */
export interface CommandWord {
  /** Quote-removed text; an unresolved expansion keeps its written form. */
  readonly text: string
  /** Whether the word expands a variable that cannot be resolved statically. */
  readonly dynamic: boolean
  /** Whether the word carries an unquoted `*` or `?` metacharacter. */
  readonly glob: boolean
  /** Whether the word was written with quoting or escaping. */
  readonly quoted: boolean
}

/** One statically separated command inside a Bash or PowerShell command line. */
export interface ShellSegment {
  readonly words: readonly CommandWord[]
  /** File targets of `>`/`>>`-style redirection; descriptor duplication has none. */
  readonly writeTargets: readonly CommandWord[]
  /** File sources of `<`-style redirection. */
  readonly readTargets: readonly CommandWord[]
}

/** Static split of a command line, or the reason it cannot be read at all. */
export type ShellDecomposition =
  | { readonly kind: 'segments'; readonly segments: readonly ShellSegment[] }
  | { readonly kind: 'opaque'; readonly reason: string }

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

function opaque(reason: string): ShellDecomposition {
  return { kind: 'opaque', reason }
}

/** Sticky patterns matched in place, so the lexer never copies the remaining input. */
const DESCRIPTOR_DUPLICATION = /[<>]&\s*(?:[0-9]+|-)/y
const REDIRECT_OPERATOR = /(?:>>|>\||>&|<&|>|<)/y
const MERGED_REDIRECT = /&>>?/y
const CMD_VARIABLE = /%[A-Za-z_][A-Za-z0-9_()]*%/y
const BASH_EXPANSION = /\$[A-Za-z_][A-Za-z0-9_]*/y
const PWSH_EXPANSION = /\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*/y

function matchAt(pattern: RegExp, input: string, index: number): string | undefined {
  pattern.lastIndex = index
  return pattern.exec(input)?.[0]
}

/**
 * Read one `$` expansion and return its written form, or `undefined` when the
 * construct executes a nested command instead of naming a variable.
 */
function readExpansion(input: string, index: number, shell: ShellKind): string | undefined {
  const next = input[index + 1]
  if (next === '(' || next === "'" || next === '"') return undefined
  if (next === '{') {
    const end = input.indexOf('}', index + 2)
    if (end < 0) return undefined
    const body = input.slice(index + 2, end)
    if (/[($`]/.test(body)) return undefined
    return input.slice(index, end + 1)
  }
  return matchAt(shell === 'pwsh' ? PWSH_EXPANSION : BASH_EXPANSION, input, index) ?? '$'
}

/**
 * Split one command line into segments, redirections, and word metadata.
 *
 * Operators separate segments so that every command in a compound line is
 * assessed on its own. Constructs whose effect cannot be read statically —
 * command substitution, here-documents, grouping, unbalanced quotes — return
 * `opaque` so callers fail closed instead of guessing shell semantics.
 */
export function decomposeCommandLine(source: string, shell: ShellKind): ShellDecomposition {
  const input = source
  const segments: ShellSegment[] = []
  let words: CommandWord[] = []
  let writeTargets: CommandWord[] = []
  let readTargets: CommandWord[] = []
  let text = ''
  let started = false
  let dynamic = false
  let glob = false
  let quoted = false
  let quote: 'single' | 'double' | undefined
  let pending: 'write' | 'read' | undefined

  const flushWord = (): void => {
    if (!started) return
    const word: CommandWord = { text, dynamic, glob, quoted }
    if (pending === 'write') writeTargets.push(word)
    else if (pending === 'read') readTargets.push(word)
    else words.push(word)
    pending = undefined
    text = ''
    started = false
    dynamic = false
    glob = false
    quoted = false
  }
  const flushSegment = (): void => {
    flushWord()
    if (words.length > 0 || writeTargets.length > 0 || readTargets.length > 0) {
      segments.push({ words, writeTargets, readTargets })
    }
    words = []
    writeTargets = []
    readTargets = []
    pending = undefined
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string

    if (quote === 'single') {
      if (char === "'") {
        quote = undefined
        continue
      }
      text += char
      continue
    }

    if (quote === 'double') {
      if (shell === 'bash' && char === '\\') {
        const next = input[index + 1]
        if (next === undefined) return opaque('the command line ends inside an escape')
        if ('\\"$`\n'.includes(next)) {
          text += next
          index += 1
          continue
        }
        text += char
        continue
      }
      if (char === '`') {
        return opaque(shell === 'bash'
          ? 'command substitution cannot be read statically'
          : 'PowerShell escape sequences cannot be read statically')
      }
      if (char === '"') {
        quote = undefined
        continue
      }
      if (char === '$') {
        const expansion = readExpansion(input, index, shell)
        if (expansion === undefined) return opaque('command substitution cannot be read statically')
        text += expansion
        dynamic = true
        index += expansion.length - 1
        continue
      }
      text += char
      continue
    }

    if (char === '\n' || char === '\r') {
      flushSegment()
      continue
    }
    if (/\s/.test(char)) {
      flushWord()
      continue
    }
    if (char === "'") {
      quote = 'single'
      started = true
      quoted = true
      continue
    }
    if (char === '"') {
      quote = 'double'
      started = true
      quoted = true
      continue
    }
    if (shell === 'bash' && char === '\\') {
      const next = input[index + 1]
      if (next === undefined) return opaque('the command line ends inside an escape')
      index += 1
      if (next === '\n') continue
      text += next
      started = true
      quoted = true
      continue
    }
    if (char === '`') {
      return opaque(shell === 'bash'
        ? 'command substitution cannot be read statically'
        : 'PowerShell escape sequences cannot be read statically')
    }
    if (char === '$') {
      const expansion = readExpansion(input, index, shell)
      if (expansion === undefined) return opaque('command substitution cannot be read statically')
      text += expansion
      started = true
      dynamic = true
      index += expansion.length - 1
      continue
    }
    if (char === '#' && !started) {
      while (index + 1 < input.length && input[index + 1] !== '\n') index += 1
      continue
    }
    if (shell === 'pwsh' && char === '%' && matchAt(CMD_VARIABLE, input, index) !== undefined) {
      return opaque('cmd-style variable expansion cannot be read statically')
    }
    if (char === '&') {
      if (input[index + 1] === '&') {
        flushSegment()
        index += 1
        continue
      }
      const merged = matchAt(MERGED_REDIRECT, input, index)
      if (merged !== undefined) {
        flushWord()
        pending = 'write'
        index += merged.length - 1
        continue
      }
      flushSegment()
      continue
    }
    if (char === '|') {
      if (input[index + 1] === '|') index += 1
      flushSegment()
      continue
    }
    if (char === ';') {
      flushSegment()
      continue
    }
    if (char === '>' || char === '<') {
      if (input.startsWith('<<', index)) return opaque('here-document input cannot be read statically')
      if (started && !quoted && !dynamic && !glob && /^[0-9]+$/.test(text)) {
        text = ''
        started = false
      } else {
        flushWord()
      }
      const duplication = matchAt(DESCRIPTOR_DUPLICATION, input, index)
      if (duplication !== undefined) {
        index += duplication.length - 1
        continue
      }
      const operator = matchAt(REDIRECT_OPERATOR, input, index) as string
      pending = char === '>' ? 'write' : 'read'
      index += operator.length - 1
      continue
    }
    if ('(){}'.includes(char)) return opaque('shell grouping or brace expansion cannot be read statically')
    if (char === '*' || char === '?') {
      glob = true
    }
    text += char
    started = true
  }

  if (quote !== undefined) return opaque('the command line ends inside an unbalanced quote')
  if (pending !== undefined && !started) return opaque('a redirection has no target')
  flushSegment()
  if (segments.length === 0) return opaque('the command line contains no command')
  return { kind: 'segments', segments }
}

/** Parse one static shell command. Any executable shell syntax fails closed. */
export function parseSimpleCommand(source: string, shell: ShellKind): ParsedCommand | undefined {
  const decomposition = decomposeCommandLine(source, shell)
  if (decomposition.kind === 'opaque' || decomposition.segments.length !== 1) return undefined
  const segment = decomposition.segments[0] as ShellSegment
  if (segment.writeTargets.length > 0 || segment.readTargets.length > 0) return undefined
  if (segment.words.some(word => word.dynamic || word.glob)) return undefined
  const tokens = segment.words.map(word => word.text)
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

/** Whether a redirection target discards output instead of writing a file. */
function isNullSink(word: CommandWord, shell: ShellKind): boolean {
  const text = word.text.toLowerCase()
  return text === '/dev/null' || (shell === 'pwsh' && (text === '$null' || text === 'nul'))
}

/**
 * Reduce a globbed path to the deepest directory it cannot escape, so an
 * unbounded expansion such as `/*` is judged against `/`.
 */
function globRoot(target: string): string {
  const parts = target.split(/[\\/]/)
  const index = parts.findIndex(part => /[*?]/.test(part))
  if (index < 0) return target
  const kept = parts.slice(0, index)
  if (kept.length === 0) return '.'
  if (kept.length === 1 && kept[0] === '') return target.startsWith('\\') ? '\\' : '/'
  return kept.join(target.includes('\\') && !target.includes('/') ? '\\' : '/')
}

interface DeletionSpec {
  readonly recursive: boolean
  readonly targets: readonly CommandWord[]
}

function deletionSpec(name: string, words: readonly CommandWord[], shell: ShellKind): DeletionSpec | undefined {
  if (shell === 'bash' && ['rm', 'rmdir', 'unlink', 'shred'].includes(name)) {
    const rest = words.slice(1)
    const flags = rest.filter(word => word.text.startsWith('-'))
    const targets = rest.filter(word => !word.text.startsWith('-'))
    return { recursive: flags.some(flag => flag.text === '--recursive' || /^-[^-]*r/i.test(flag.text)), targets }
  }
  if (shell === 'pwsh' && ['remove-item', 'rm', 'ri', 'del', 'erase', 'rmdir'].includes(name)) {
    const targets: CommandWord[] = []
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index] as CommandWord
      if (/^-(?:path|literalpath)$/i.test(word.text)) {
        const value = words[index + 1]
        if (value !== undefined) targets.push(value)
        index += 1
      } else if (!word.text.startsWith('-')) {
        targets.push(word)
      }
    }
    return { recursive: words.some(word => /^-(?:recurse|r)$/i.test(word.text)), targets }
  }
  return undefined
}

/** Commands whose real work is another command this policy cannot see yet. */
const WRAPPERS = new Set(['env', 'nohup', 'setsid', 'stdbuf', 'command', 'time', 'timeout', 'xargs', 'nice', 'ionice'])

interface UnwrappedCommand {
  readonly words: readonly CommandWord[]
  /** Whether the effective command receives its operands from piped input. */
  readonly dynamicInput: boolean
}

/** Wrapper flags that consume the following word as their value. */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, RegExp>> = {
  xargs: /^-(?:n|I|i|P|L|s|d|E|a)$/,
  stdbuf: /^-(?:i|o|e)$/,
  nice: /^-(?:n)$/,
  ionice: /^-(?:c|n|p)$/,
}

/** Strip prefix wrappers so the effective command is judged, not the wrapper. */
function unwrapCommand(words: readonly CommandWord[]): UnwrappedCommand {
  let current = words
  let dynamicInput = false
  for (let depth = 0; depth < 4; depth += 1) {
    const name = commandName(current[0]?.text ?? '')
    if (!WRAPPERS.has(name)) break
    if (name === 'xargs') dynamicInput = true
    const valueFlag = WRAPPER_VALUE_FLAGS[name]
    let index = 1
    while (index < current.length) {
      const token = (current[index] as CommandWord).text
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1
        continue
      }
      if (!token.startsWith('-')) break
      if (valueFlag?.test(token) === true) index += 1
      index += 1
    }
    if (name === 'timeout' && /^[0-9]+(?:\.[0-9]+)?[smhd]?$/.test(current[index]?.text ?? '')) index += 1
    const next = current.slice(index)
    if (next.length === 0) return { words: current, dynamicInput }
    current = next
  }
  return { words: current, dynamicInput }
}

/** Commands that execute code this policy cannot inspect at all. */
function nestedInterpreter(name: string, words: readonly CommandWord[]): boolean {
  if (['sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
    'eval', 'exec', 'source', '.', 'iex', 'invoke-expression', 'invoke-command', 'start-process'].includes(name)) return true
  if (['node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript'].includes(name)) {
    return words.slice(1).some(word => /^(?:-c|-e|-E|--eval|--exec|--command|--print)$/.test(word.text))
  }
  return false
}

function explicitPaths(words: readonly CommandWord[], roots: PolicyRoots): string[] {
  return words
    .map(word => word.text)
    .filter(token => token === '~' || token.startsWith('./') || token.startsWith('../') || token.startsWith('/')
      || token.startsWith('~\\') || token.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token))
    .map(token => normalizePath(token, roots.workspace, roots.home))
}

function workspacePathsAreRoutine(words: readonly CommandWord[], roots: PolicyRoots): boolean {
  return explicitPaths(words, roots).every(path => isWithin(roots.workspace, path) && !isProtectedProjectPath(path, roots))
}

/** Every redirection target must be a discard sink or ordinary project content. */
function writeTargetsAreRoutine(segment: ShellSegment, shell: ShellKind, roots: PolicyRoots): boolean {
  return segment.writeTargets.every((target) => {
    if (isNullSink(target, shell)) return true
    if (target.dynamic || target.glob) return false
    const normalized = normalizePath(target.text, roots.workspace, roots.home)
    return isWithin(roots.workspace, normalized) && !isProtectedProjectPath(normalized, roots)
  })
}

function buildOrTest(words: readonly CommandWord[]): boolean {
  const tokens = words.map(word => word.text)
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

function versionProbe(words: readonly CommandWord[]): boolean {
  const tokens = words.map(word => word.text)
  const name = commandName(tokens[0] as string)
  if (['node', 'python', 'python3', 'pnpm', 'npm', 'yarn', 'bun', 'git', 'cargo', 'rustc'].includes(name)) {
    return tokens.length === 2 && ['--version', '-v', 'version'].includes(tokens[1]?.toLowerCase() ?? '')
  }
  return name === 'go' && tokens.length === 2 && tokens[1]?.toLowerCase() === 'version'
}

/**
 * Directory changers stay out of both fast-path sets on purpose. `cd` rewrites
 * the working directory for every later segment of the same line, so relative
 * paths could no longer be resolved against the workspace. Leaving it
 * unrecognized keeps any line containing it out of the static allow path and
 * routes the whole line to semantic classification instead.
 */
const BASH_READ_ONLY = [
  'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'cat', 'wc', 'od', 'du', 'df', 'stat', 'file', 'which', 'type',
  'echo', 'printf', 'true', 'false', ':', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id',
  'hostname', 'uname', 'printenv', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff', 'cmp', 'jq', 'tree', 'column',
  'md5sum', 'shasum', 'sha1sum', 'sha256sum',
]

const PWSH_READ_ONLY = [
  'get-location', 'get-childitem', 'get-content', 'select-string', 'get-item', 'test-path',
  'write-output', 'write-host', 'measure-object', 'select-object', 'sort-object', 'get-date',
]

function readOnlyCommand(name: string, words: readonly CommandWord[], shell: ShellKind): boolean {
  const tokens = words.map(word => word.text)
  if (shell === 'bash') {
    if (BASH_READ_ONLY.includes(name)) return true
    if (name === 'sed') return tokens.includes('-n')
    if (name === 'find') return !tokens.some(token => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(token))
    if (name === 'git') return ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'].includes(tokens[1]?.toLowerCase() ?? '')
    return false
  }
  return PWSH_READ_ONLY.includes(name)
}

function creationSpec(
  name: string,
  words: readonly CommandWord[],
  shell: ShellKind,
  roots: PolicyRoots,
): { paths: string[]; protected: boolean } | undefined {
  let raw: string[] | undefined
  if (shell === 'bash' && ['mkdir', 'touch'].includes(name)) raw = words.slice(1).filter(word => !word.text.startsWith('-')).map(word => word.text)
  if (shell === 'pwsh' && name === 'new-item') {
    raw = []
    for (let index = 1; index < words.length; index += 1) {
      const token = (words[index] as CommandWord).text
      if (/^-(?:path|literalpath)$/i.test(token)) {
        const value = words[index + 1]
        if (value !== undefined) raw.push(value.text)
        index += 1
      } else if (!token.startsWith('-') && !/^(?:file|directory)$/i.test(token)) raw.push(token)
    }
  }
  if (raw === undefined || raw.length === 0) return undefined
  const paths = raw.map(path => normalizePath(path, roots.workspace, roots.home))
  return { paths, protected: paths.some(path => !isWithin(roots.workspace, path) || isProtectedProjectPath(path, roots)) }
}

/** Unconditional hard deny for one segment, independent of classifier behavior. */
function segmentHardDenyReason(segment: ShellSegment, shell: ShellKind, roots: PolicyRoots): string | undefined {
  for (const target of segment.writeTargets) {
    if (isNullSink(target, shell)) continue
    if (target.dynamic) {
      if (dynamicHomeTarget(target.text)) return 'dynamic redirection targeting the user home is not permitted'
      continue
    }
    const reason = hardDestructiveTargetReason(globRoot(target.text), roots)
    if (reason !== undefined) return `redirection overwrites ${reason}`
  }
  const unwrapped = unwrapCommand(segment.words)
  const name = commandName(unwrapped.words[0]?.text ?? '')
  const deletion = deletionSpec(name, unwrapped.words, shell)
  if (deletion === undefined) return undefined
  for (const target of deletion.targets) {
    if (target.dynamic) {
      if (dynamicHomeTarget(target.text)) return 'dynamic deletion targeting the user home is not permitted'
      continue
    }
    const reason = hardDestructiveTargetReason(globRoot(target.text), roots)
    if (reason !== undefined) return `destructive operation targets ${reason}`
  }
  return undefined
}

/**
 * Hard-deny shell patterns independent of parsing and classifier behavior.
 *
 * The whole-line rules stay unconditional because they must also cover a
 * command line no parser can decompose. The structural rules then judge every
 * segment of a compound line, so an operator cannot smuggle a protected target
 * past the fuse.
 */
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

  const decomposition = decomposeCommandLine(compact, shell)
  if (decomposition.kind === 'opaque') return undefined
  for (const segment of decomposition.segments) {
    const reason = segmentHardDenyReason(segment, shell, roots)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** Classify one segment of an already hard-deny-cleared command line. */
function assessSegment(
  segment: ShellSegment,
  shell: ShellKind,
  roots: PolicyRoots,
  artifacts: ArtifactRegistry,
  owner: object | undefined,
): Assessment {
  if (segment.words.length === 0) return semanticReview('redirection without a command requires semantic review')
  const first = segment.words[0] as CommandWord
  if (first.dynamic) return manualReview('the command name is produced by a dynamic expansion')
  if (first.glob) return manualReview('the command name is produced by a glob')
  if (first.quoted) return manualReview('the command name is quoted or escaped rather than written literally')
  if (segment.writeTargets.some(target => target.dynamic && !isNullSink(target, shell))) {
    return manualReview('the redirection target is produced by a dynamic expansion')
  }

  const unwrapped = unwrapCommand(segment.words)
  const words = unwrapped.words
  const name = commandName((words[0] as CommandWord).text)
  if (nestedInterpreter(name, words)) return manualReview('nested shell or inline-code execution requires manual review')

  const base = classifyEffectiveCommand(name, words, segment, shell, roots, artifacts, owner, unwrapped.dynamicInput)
  if (base.decision !== 'allow' || writeTargetsAreRoutine(segment, shell, roots)) return base
  return semanticReview(`redirection writes outside routine project content: ${
    segment.writeTargets.map(target => target.text).join(', ')}`)
}

function classifyEffectiveCommand(
  name: string,
  words: readonly CommandWord[],
  segment: ShellSegment,
  shell: ShellKind,
  roots: PolicyRoots,
  artifacts: ArtifactRegistry,
  owner: object | undefined,
  dynamicInput: boolean,
): Assessment {
  const operands = [...words.slice(1), ...segment.readTargets]

  const deletion = deletionSpec(name, words, shell)
  if (deletion !== undefined) {
    if (dynamicInput) return manualReview('deletion operands arrive from piped input and cannot be read statically')
    if (deletion.targets.length === 0) return manualReview('deletion target could not be determined')
    if (deletion.targets.some(target => target.dynamic)) {
      return manualReview('deletion target is produced by a dynamic expansion')
    }
    const paths = deletion.targets.map(target => normalizePath(target.text, roots.workspace, roots.home))
    if (deletion.targets.every(target => !target.glob)
      && paths.every(path => artifacts.has(owner, path, roots) && isArtifactArea(path, roots))) {
      return allowed(`delete exact session-created artifact${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`)
    }
    return semanticReview(`deleting pre-session or unobserved data requires specific user authorization: ${paths.join(', ')}`)
  }

  if (dynamicInput) return ambiguous(`operands arrive from piped input and require independent classification: ${name}`)

  if (readOnlyCommand(name, words, shell)) {
    return workspacePathsAreRoutine(operands, roots)
      ? allowed('static read-only command inside the workspace')
      : semanticReview('read-only command references a protected or external path')
  }
  if (versionProbe(words)) return allowed('static development-tool version probe')
  if (buildOrTest(words)) {
    return workspacePathsAreRoutine(operands, roots)
      ? allowed('recognized project build, test, or verification command')
      : semanticReview('build or test command references a protected or external path')
  }

  const creation = creationSpec(name, words, shell, roots)
  if (creation !== undefined) {
    if (words.some(word => word.dynamic || word.glob)) {
      return semanticReview(`creating a dynamically named path requires semantic review: ${creation.paths.join(', ')}`)
    }
    return creation.protected
      ? semanticReview(`creating outside routine project content requires specific user authorization: ${creation.paths.join(', ')}`)
      : allowed('create exact project-local artifacts', creation.paths)
  }

  if (shell === 'bash' && ['cp', 'mv'].includes(name)) {
    const paths = explicitPaths(words.slice(1).filter(word => !word.text.startsWith('-')), roots)
    return paths.length > 0 && paths.every(path => isWithin(roots.workspace, path) && !isProtectedProjectPath(path, roots))
      ? allowed('static project-local file operation')
      : semanticReview('file move/copy target is external, protected, or unclear')
  }

  const tokens = words.map(word => word.text)
  if (name === 'git' && ['reset', 'clean', 'commit', 'push', 'rebase', 'checkout', 'switch', 'branch', 'tag'].includes(tokens[1]?.toLowerCase() ?? '')) {
    return semanticReview(`Git state-changing command requires specific user authorization: ${tokens.slice(0, 3).join(' ')}`)
  }
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'ssh', 'scp', 'rsync'].includes(name)) {
    return semanticReview(`external network operation requires specific user authorization when it writes or transmits data: ${name}`)
  }
  if (/^(?:dropdb|createdb|psql|mysql|mongosh|redis-cli|kubectl|terraform|ansible|systemctl|launchctl)$/.test(name)) {
    return semanticReview(`database, service, or infrastructure operation requires specific user authorization: ${name}`)
  }
  return ambiguous(`unrecognized ${shell} command requires independent classification: ${name}`)
}

/**
 * Classify one Bash or PowerShell call after hard-deny evaluation.
 *
 * A compound line is assessed segment by segment. Syntax alone never blocks
 * semantic classification: only a segment this policy cannot read statically —
 * a nested interpreter, a dynamic destructive target, or an opaque construct —
 * falls back to one-shot human approval.
 */
export function assessShell(
  source: string,
  shell: ShellKind,
  roots: PolicyRoots,
  artifacts: ArtifactRegistry,
  owner: object | undefined,
): Assessment {
  const hard = hardDenyShellReason(source, shell, roots)
  if (hard !== undefined) return denied(hard)
  const decomposition = decomposeCommandLine(source, shell)
  if (decomposition.kind === 'opaque') {
    return manualReview(`${shell} command cannot be read statically: ${decomposition.reason}`)
  }

  const assessments = decomposition.segments.map(segment => assessSegment(segment, shell, roots, artifacts, owner))
  const blocked = assessments.find(assessment => assessment.decision === 'ask' && !assessment.classifierEligible)
  if (blocked !== undefined) return blocked
  if (assessments.every(assessment => assessment.decision === 'allow')) {
    const creates = assessments.flatMap(assessment => assessment.plannedCreates ?? [])
    return allowed(assessments.length === 1
      ? (assessments[0] as Assessment).reason
      : `every command in this ${shell} line is a recognized routine operation`, creates)
  }
  const reasons = assessments.filter(assessment => assessment.decision !== 'allow').map(assessment => assessment.reason)
  return semanticReview([...new Set(reasons)].join('; ').slice(0, 800))
}
