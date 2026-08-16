import { lstatSync } from 'node:fs'
import { basename } from 'node:path'
import type { ArtifactRegistry } from './artifacts.js'
import {
  hardDestructiveTargetReason,
  isProtectedProjectPath,
  isWithin,
  normalizePath,
  type PolicyRoots,
} from './paths.js'
import type { Assessment, FilesystemEffect } from './types.js'

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

function semanticReview(reason: string, filesystemEffects?: readonly FilesystemEffect[]): Assessment {
  return {
    decision: 'ask', reason, classifierEligible: true,
    ...(filesystemEffects === undefined || filesystemEffects.length === 0 ? {} : { filesystemEffects }),
  }
}

function denied(reason: string): Assessment {
  return { decision: 'deny', reason, classifierEligible: false }
}

function allowed(
  reason: string,
  plannedCreates?: readonly string[],
  filesystemEffects?: readonly FilesystemEffect[],
): Assessment {
  return {
    decision: 'allow', reason, classifierEligible: false,
    ...(plannedCreates === undefined || plannedCreates.length === 0 ? {} : { plannedCreates }),
    ...(filesystemEffects === undefined || filesystemEffects.length === 0 ? {} : { filesystemEffects }),
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function filesystemEffects(kind: FilesystemEffect['kind'], paths: readonly string[]): FilesystemEffect[] {
  return paths.map(path => ({ kind, path, existedBefore: pathExists(path) }))
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
 * `opaque`. The policy can still run ordinary opaque syntax inside the OS
 * sandbox while separately recognizing sensitive or destructive effects.
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
    if (char === '{' && input[index + 1] === '}' && !started && (input[index + 2] === undefined || /\s/.test(input[index + 2] as string))) {
      // `find -exec ... {} \;` uses an exact literal placeholder. It is not
      // brace expansion, and treating it as one made routine read-only
      // inspection impossible. Other braces remain opaque.
      text = '{}'
      started = true
      index += 1
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

/** Parse one fully static shell command for helpers that need exact words. */
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

function sensitiveReadMarker(source: string): boolean {
  return sensitiveMarker(source)
    || /(?:^|[\\/])(?:\.env(?:\.[^\\/\s]+)?|credentials(?:\.json|\.yaml)?|netrc|npmrc)(?:$|[\\/\s"'])/i.test(source)
    || /(?:^|\s)(?:env|set|printenv|get-childitem\s+env:)(?:\s|$)/i.test(source)
}

function networkMutation(name: string, words: readonly CommandWord[]): boolean {
  const rawTokens = words.slice(1).map(word => word.text)
  const tokens = rawTokens.map(token => token.toLowerCase())
  if (['ssh', 'scp', 'sftp', 'rsync'].includes(name)) return true
  if (name === 'curl') {
    return rawTokens.some(token => /^(?:-d(?:.+)?|--data(?:-ascii|-binary|-raw|-urlencode)?(?:=.+)?|-F(?:.+)?|--form(?:-string)?(?:=.+)?|-T(?:.+)?|--upload-file(?:=.+)?|--json(?:=.+)?)$/.test(token))
      || tokens.some((token, index) => /^(?:-x|--request)$/.test(token)
        && /^(?:post|put|patch|delete)$/.test(tokens[index + 1] ?? ''))
      || tokens.some(token => /^(?:-x|--request=)(?:post|put|patch|delete)$/.test(token))
  }
  if (name === 'wget') return tokens.some(token => /^(?:--post-data|--post-file|--method=(?:post|put|patch|delete))/.test(token))
  if (['invoke-webrequest', 'invoke-restmethod'].includes(name)) {
    return tokens.some((token, index) => /^-method$/i.test(token)
      && /^(?:post|put|patch|delete)$/i.test(tokens[index + 1] ?? ''))
      || tokens.some(token => /^-(?:body|infile|outfile)$/i.test(token))
  }
  return false
}

function packageCodeExecution(name: string, words: readonly CommandWord[]): boolean {
  const action = words[1]?.text.toLowerCase()
  return ['npx', 'bunx'].includes(name)
    || (['pnpm', 'yarn'].includes(name) && action === 'dlx')
    || (name === 'npm' && action === 'exec')
}

/** Preserve semantic guardrails when shell expansion prevents full splitting. */
function opaqueSemanticReason(source: string): string | undefined {
  const compact = source.replace(/\s+/g, ' ')
  if (/\b(?:ssh|scp|sftp|rsync)\b/i.test(compact)
    || /\bcurl\b[^\r\n]*(?:\s-d(?:\s|[^\s])|--data(?:-ascii|-binary|-raw|-urlencode)?(?:=|\s)|\s-F(?:\s|[^\s])|--form(?:-string)?(?:=|\s)|\s-T(?:\s|[^\s])|--upload-file(?:=|\s)|--json(?:=|\s)|-X\s*(?:POST|PUT|PATCH|DELETE)|--request(?:=|\s)(?:POST|PUT|PATCH|DELETE))/i.test(compact)
    || /\bwget\b[^\r\n]*(?:--post-(?:data|file)(?:=|\s)|--method=(?:post|put|patch|delete))/i.test(compact)
    || /\b(?:invoke-webrequest|invoke-restmethod)\b[^\r\n]*(?:-method\s+(?:post|put|patch|delete)|-(?:body|infile|outfile)\b)/i.test(compact)) {
    return 'opaque shell syntax contains network transmission or remote mutation'
  }
  if (/\b(?:npx|bunx)\b|\b(?:pnpm|yarn)\s+dlx\b|\bnpm\s+exec\b/i.test(compact)) {
    return 'opaque shell syntax executes an ephemeral downloaded package'
  }
  if (/\bgit\s+(?:reset|clean|push|rebase)\b/i.test(compact)
    || /\bgit\s+(?:checkout|switch)\b[^\r\n]*(?:--force|--discard-changes|(?:^|\s)-f(?:\s|$))/i.test(compact)) {
    return 'opaque shell syntax changes durable Git state'
  }
  if (/\b(?:dropdb|createdb|psql|mysql|mongosh|redis-cli|kubectl|terraform|ansible|systemctl|launchctl)\b/i.test(compact)) {
    return 'opaque shell syntax operates on a database, service, or infrastructure target'
  }
  return undefined
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
  const firstCommand = current.findIndex(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text))
  if (firstCommand > 0) current = current.slice(firstCommand)
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

interface NestedExecution {
  /** Inline source is visible to the independent classifier. */
  readonly source?: string
}

/** Describe an interpreter boundary and whether its inline source is visible. */
function nestedExecution(name: string, words: readonly CommandWord[]): NestedExecution | undefined {
  if (['node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript'].includes(name)) {
    const index = words.findIndex((word, wordIndex) => wordIndex > 0 && /^(?:-c|-e|-E|--eval|--exec|--command|--print)$/.test(word.text))
    if (index >= 0) return { ...(words[index + 1] === undefined ? {} : { source: (words[index + 1] as CommandWord).text }) }
    if (words.length === 1 || words.some((word, wordIndex) => wordIndex > 0 && word.text === '-')) return {}
    return undefined
  }
  if (['sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)) {
    const index = words.findIndex((word, wordIndex) => wordIndex > 0 && /^(?:-c|\/c|--command)$/.test(word.text))
    return { ...(index < 0 || words[index + 1] === undefined ? {} : { source: (words[index + 1] as CommandWord).text }) }
  }
  if (['eval', 'iex', 'invoke-expression'].includes(name)) {
    return { ...(words.length < 2 ? {} : { source: words.slice(1).map(word => word.text).join(' ') }) }
  }
  if (['exec', 'source', '.', 'invoke-command', 'start-process'].includes(name)) return {}
  return undefined
}

const PYTHON_IMPORT = /^(?:import\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s+as\s+[A-Za-z_]\w*)?(?:\s*,\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s+as\s+[A-Za-z_]\w*)?)*|from\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s+import\s+(?:[A-Za-z_*]\w*(?:\s+as\s+[A-Za-z_]\w*)?)(?:\s*,\s*[A-Za-z_*]\w*(?:\s+as\s+[A-Za-z_]\w*)?)*)$/
const PYTHON_PRINT_VALUE = String.raw`(?:'[^'\n]*'|"[^"\n]*"|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|[-+]?\d+(?:\.\d+)?)`
const PYTHON_SAFE_PRINT = new RegExp(String.raw`^print\(\s*${PYTHON_PRINT_VALUE}(?:\s*,\s*${PYTHON_PRINT_VALUE})*\s*\)$`)

/** Common package/version probes are safe enough to avoid a model round trip. */
function routineInlineProbe(name: string, source: string | undefined): boolean {
  if (source === undefined) return false
  if (name === 'python' || name === 'python3') {
    const statements = source.split(/[;\n]+/).map(statement => statement.trim()).filter(Boolean)
    return statements.length > 0 && statements.every(statement => PYTHON_IMPORT.test(statement) || PYTHON_SAFE_PRINT.test(statement))
  }
  if (['node', 'bun', 'deno'].includes(name)) {
    const compact = source.trim().replace(/;$/, '')
    return /^(?:require(?:\.resolve)?\(\s*(['"])[@A-Za-z0-9_./-]+\1\s*\)|console\.log\(\s*process\.version\s*\))$/.test(compact)
  }
  return false
}

/** Deletion hidden behind an interpreter stays outside classifier authority. */
function destructiveNestedSource(source: string): boolean {
  return /(?:^|[\s;&|()])(?:rm|rmdir|unlink|shred|remove-item|del|erase)(?:\s|$)|\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|file\.(?:delete|unlink)|directory\.delete)\s*\(|\.(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync|delete)\s*\(|\b(?:delete\s+from|drop\s+(?:table|database)|truncate\s+table)\b/i.test(source)
}

function explicitPaths(words: readonly CommandWord[], roots: PolicyRoots): string[] {
  return words
    .map(word => word.text)
    .filter(token => token === '~' || token.startsWith('./') || token.startsWith('../') || token.startsWith('/')
      || token.startsWith('~\\') || token.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token))
    .map(token => normalizePath(token, roots.workspace, roots.home))
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
  if (['node', 'python', 'python3', 'pip', 'pip3', 'pnpm', 'npm', 'yarn', 'bun', 'git', 'cargo', 'rustc'].includes(name)) {
    return tokens.length === 2 && ['--version', '-v', 'version'].includes(tokens[1]?.toLowerCase() ?? '')
  }
  return name === 'go' && tokens.length === 2 && tokens[1]?.toLowerCase() === 'version'
}

/** High-confidence read-only commands; unknown commands still run sandboxed. */
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

const FIND_MUTATING_ACTION = /^-(?:delete|fprint|fprintf|fls)$/
const FIND_NESTED_ACTION = /^-(?:exec|execdir|ok|okdir)$/

function findSearchRoots(words: readonly CommandWord[]): readonly CommandWord[] {
  const roots: CommandWord[] = []
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] as CommandWord
    if (word.text.startsWith('-') || word.text === '!' || word.text === '(') break
    roots.push(word)
  }
  return roots
}

function findHasDestructiveAction(words: readonly CommandWord[]): boolean {
  for (let index = 1; index < words.length; index += 1) {
    const token = (words[index] as CommandWord).text.toLowerCase()
    if (token === '-delete') return true
    if (!FIND_NESTED_ACTION.test(token)) continue
    const terminator = words.findIndex((word, nestedIndex) => nestedIndex > index && (word.text === ';' || word.text === '+'))
    if (terminator < 0) return false
    const nested = words.slice(index + 1, terminator)
    const nestedName = commandName(nested[0]?.text ?? '')
    if (deletionSpec(nestedName, nested, 'bash') !== undefined
      || destructiveNestedSource(nested.map(word => word.text).join(' '))) return true
    index = terminator
  }
  return false
}

/** `find -exec` is read-only only when every nested command is itself read-only. */
function findActionsAreReadOnly(words: readonly CommandWord[]): boolean {
  for (let index = 1; index < words.length; index += 1) {
    const token = (words[index] as CommandWord).text.toLowerCase()
    if (FIND_MUTATING_ACTION.test(token) || /^(?:-execdir|-ok|-okdir)$/.test(token)) return false
    if (token !== '-exec') continue
    const terminator = words.findIndex((word, nestedIndex) => nestedIndex > index && (word.text === ';' || word.text === '+'))
    if (terminator < 0) return false
    const nested = words.slice(index + 1, terminator)
    const nestedName = commandName(nested[0]?.text ?? '')
    const nestedReadOnly = BASH_READ_ONLY.includes(nestedName)
      || (nestedName === 'sed' && nested.some(word => word.text === '-n'))
      || (nestedName === 'git' && ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'].includes(nested[1]?.text.toLowerCase() ?? ''))
      || versionProbe(nested)
    if (!nestedReadOnly) return false
    index = terminator
  }
  return true
}

function readOnlyCommand(name: string, words: readonly CommandWord[], shell: ShellKind): boolean {
  const tokens = words.map(word => word.text)
  if (shell === 'bash') {
    if (BASH_READ_ONLY.includes(name)) return true
    if (name === 'sed') return tokens.includes('-n')
    if (name === 'find') return findActionsAreReadOnly(words)
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
  if (shell === 'pwsh' && ['set-content', 'out-file'].includes(name)) {
    raw = []
    for (let index = 1; index < words.length; index += 1) {
      const token = (words[index] as CommandWord).text
      if (/^-(?:path|literalpath|filepath)$/i.test(token)) {
        const value = words[index + 1]
        if (value !== undefined) raw.push(value.text)
        index += 1
      }
    }
  }
  if (raw === undefined || raw.length === 0) return undefined
  const paths = raw.map(path => normalizePath(path, roots.workspace, roots.home))
  return { paths, protected: paths.some(path => isProtectedProjectPath(path, roots)) }
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
  if (name === 'find' && findHasDestructiveAction(unwrapped.words)) {
    const rootsToCheck = findSearchRoots(unwrapped.words)
    for (const target of rootsToCheck) {
      if (target.dynamic) {
        if (dynamicHomeTarget(target.text)) return 'dynamic find deletion targeting the user home is not permitted'
        continue
      }
      const reason = hardDestructiveTargetReason(globRoot(target.text), roots)
      if (reason !== undefined) return `destructive find operation targets ${reason}`
    }
  }
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
  const unwrapped = unwrapCommand(segment.words)
  const first = unwrapped.words[0] as CommandWord
  if (first.dynamic || first.glob) {
    return denied('the executable name is produced dynamically; resolve it and retry with a visible literal command')
  }

  const words = unwrapped.words
  const name = commandName((words[0] as CommandWord).text)
  const nested = nestedExecution(name, words)
  if (nested !== undefined) {
    if (routineInlineProbe(name, nested.source)) return allowed('routine inline package or version probe')
    if (nested.source === undefined
      && (words.length === 1 || words.some(word => /^(?:-|--?|\/)?(?:encodedcommand|enc)$/i.test(word.text) || word.text === '-'))) {
      return semanticReview('opaque interpreter input requires semantic review because its network and read effects are not sandboxed')
    }
    if (nested.source !== undefined && destructiveNestedSource(nested.source)) {
      return denied('nested deletion must be rewritten as a visible command with literal targets before Auto can review it')
    }
    return allowed('nested or inline code remains confined by the workspace-write sandbox')
  }

  const base = classifyEffectiveCommand(name, words, segment, shell, roots, artifacts, owner, unwrapped.dynamicInput)
  if (base.decision !== 'allow') return base
  const staticWritePaths = segment.writeTargets
    .filter(target => !target.dynamic && !isNullSink(target, shell))
    .map(target => normalizePath(target.text, roots.workspace, roots.home))
  const writeEffects = filesystemEffects('create-or-overwrite', staticWritePaths)
  const protectedTargets = staticWritePaths.filter(target => isProtectedProjectPath(target, roots))
  if (protectedTargets.length > 0) {
    return semanticReview(`redirection mutates protected project metadata: ${protectedTargets.join(', ')}`, writeEffects)
  }
  if (writeEffects.length === 0) return base
  const plannedCreates = [
    ...(base.plannedCreates ?? []),
    ...writeEffects.filter(effect => !effect.existedBefore).map(effect => effect.path),
  ]
  return allowed(base.reason, [...new Set(plannedCreates)], [...(base.filesystemEffects ?? []), ...writeEffects])
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
  const deletion = deletionSpec(name, words, shell)
  if (deletion !== undefined) {
    if (dynamicInput) return denied('deletion operands arrive from piped input; rewrite the deletion with literal targets')
    if (deletion.targets.length === 0) return denied('deletion target could not be determined; rewrite the deletion with literal targets')
    if (deletion.targets.length > 1) {
      return denied('multiple deletion targets are not authorized together; split them into one visible literal target per call')
    }
    if (deletion.targets.some(target => target.dynamic)) {
      return denied('deletion target is produced dynamically; resolve it and retry with literal targets')
    }
    if (deletion.targets.some(target => target.glob)) {
      return denied('globbed deletion targets are not authorized in Auto; resolve the glob and retry one visible literal target per call')
    }
    const paths = deletion.targets.map(target => normalizePath(target.text, roots.workspace, roots.home))
    const effects = filesystemEffects('delete', paths)
    if (paths.every(path => deletion.recursive
      ? artifacts.hasTree(owner, path, roots)
      : artifacts.has(owner, path, roots))) {
      return allowed(`delete exact session-created artifact${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`, undefined, effects)
    }
    return semanticReview(`deleting pre-session or unobserved data requires specific user authorization: ${paths.join(', ')}`, effects)
  }

  if (dynamicInput) return allowed(`piped operands remain confined by the workspace-write sandbox: ${name}`)

  if (name === 'find' && !findActionsAreReadOnly(words)) {
    return semanticReview(findHasDestructiveAction(words)
      ? 'find deletion requires specific user authorization'
      : 'find nested work remains confined by the workspace-write sandbox')
  }

  if (readOnlyCommand(name, words, shell)) {
    return sensitiveReadMarker(words.map(word => word.text).join(' '))
      ? semanticReview('shell command reads potentially sensitive credential or environment data')
      : allowed('read-only inspection without a sensitive credential target')
  }
  if (versionProbe(words)) return allowed('static development-tool version probe')
  if (buildOrTest(words)) {
    return allowed('recognized project build, test, or verification command under the workspace sandbox')
  }

  const creation = creationSpec(name, words, shell, roots)
  if (creation !== undefined) {
    if (words.some(word => word.dynamic || word.glob)) {
      return semanticReview(`creating a dynamically named path requires semantic review: ${creation.paths.join(', ')}`)
    }
    return creation.protected
      ? semanticReview(`creating protected project metadata requires specific user authorization: ${creation.paths.join(', ')}`, filesystemEffects('create-or-overwrite', creation.paths))
      : allowed('create paths under the workspace-write boundary', creation.paths, filesystemEffects('create-or-overwrite', creation.paths))
  }

  if (shell === 'bash' && ['cp', 'mv'].includes(name)) {
    const paths = explicitPaths(words.slice(1).filter(word => !word.text.startsWith('-')), roots)
    if (words.some(word => sensitiveReadMarker(word.text))) {
      return semanticReview('file move/copy references potentially sensitive credential data')
    }
    return paths.some(path => isProtectedProjectPath(path, roots))
      ? semanticReview('file move/copy mutates protected project metadata')
      : allowed('file move/copy remains confined by the workspace-write sandbox')
  }

  const tokens = words.map(word => word.text)
  const gitAction = tokens[1]?.toLowerCase() ?? ''
  const forcedCheckout = ['checkout', 'switch'].includes(gitAction)
    && tokens.some(token => ['-f', '--force', '--discard-changes'].includes(token.toLowerCase()))
  if (name === 'git' && (['reset', 'clean', 'push', 'rebase'].includes(gitAction) || forcedCheckout)) {
    return semanticReview(`Git state-changing command requires specific user authorization: ${tokens.slice(0, 3).join(' ')}`)
  }
  if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'ssh', 'scp', 'rsync'].includes(name)) {
    return networkMutation(name, words)
      ? semanticReview(`network transmission or remote mutation requires specific user authorization: ${name}`)
      : allowed(`read-only network retrieval does not require shell syntax classification: ${name}`)
  }
  if (packageCodeExecution(name, words)) {
    return semanticReview(`ephemeral downloaded-package execution requires specific user authorization: ${tokens.slice(0, 3).join(' ')}`)
  }
  if (/^(?:dropdb|createdb|psql|mysql|mongosh|redis-cli|kubectl|terraform|ansible|systemctl|launchctl)$/.test(name)) {
    return semanticReview(`database, service, or infrastructure operation requires specific user authorization: ${name}`)
  }
  return sensitiveReadMarker(words.map(word => word.text).join(' '))
    ? semanticReview(`command may read sensitive credentials or environment data: ${name}`)
    : allowed(`unrecognized ${shell} syntax runs inside the workspace-write sandbox: ${name}`)
}

/**
 * Classify one Bash or PowerShell call after hard-deny evaluation.
 *
 * A compound line is assessed segment by segment. Syntax alone never blocks
 * semantic classification. Destructive targets hidden behind dynamic or
 * opaque execution are denied; recognized external effects remain eligible
 * for semantic review even when the full shell grammar is unavailable.
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
    const semanticReason = opaqueSemanticReason(source)
    return destructiveNestedSource(source)
      ? denied(`${shell} destructive command must be rewritten with visible literal targets: ${decomposition.reason}`)
      : sensitiveReadMarker(source)
        ? semanticReview(`${shell} command may read sensitive credentials or environment data`)
        : semanticReason !== undefined
          ? semanticReview(`${semanticReason}: ${decomposition.reason}`)
          : allowed(`${shell} syntax remains confined by the workspace-write sandbox even though static decomposition is unavailable`)
  }

  const assessments = decomposition.segments.map(segment => assessSegment(segment, shell, roots, artifacts, owner))
  const deterministicDeny = assessments.find(assessment => assessment.decision === 'deny')
  if (deterministicDeny !== undefined) return deterministicDeny
  if (assessments.every(assessment => assessment.decision === 'allow')) {
    const creates = assessments.flatMap(assessment => assessment.plannedCreates ?? [])
    const effects = assessments.flatMap(assessment => assessment.filesystemEffects ?? [])
    return allowed(assessments.length === 1
      ? (assessments[0] as Assessment).reason
      : `every command in this ${shell} line is a recognized routine operation`, creates, effects)
  }
  const reasons = assessments.filter(assessment => assessment.decision !== 'allow').map(assessment => assessment.reason)
  const effects = assessments.flatMap(assessment => assessment.filesystemEffects ?? [])
  return semanticReview([...new Set(reasons)].join('; ').slice(0, 800), effects)
}
