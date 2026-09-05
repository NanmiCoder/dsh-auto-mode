/** Conservative support for the native *** Begin Patch format. Other dialects ask. */
export interface PatchEffect {
  readonly kind: 'create-or-overwrite' | 'delete'
  readonly path: string
}

export function patchPayload(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = args as Record<string, unknown>
  if (typeof value.patch === 'string' && typeof value.input === 'string' && value.patch !== value.input) return undefined
  return typeof value.patch === 'string' ? value.patch : typeof value.input === 'string' ? value.input : undefined
}

export function patchPayloadsForGuard(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const value = args as Record<string, unknown>
  return [value.patch, value.input].filter((entry): entry is string => typeof entry === 'string')
}

/** Inspect both native and unified headers for critical destinations, even in malformed patches. */
export function patchGuardPaths(patch: string): string[] {
  return patch.split(/\r?\n/).flatMap(line => {
    const native = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(line)
    if (native) return [native[1]!]
    const unified = /^(?:---|\+\+\+) (.+)$/.exec(line)
    if (!unified || unified[1] === '/dev/null') return []
    return [unified[1]!.replace(/^[ab]\//, '').split('\t')[0]!]
  })
}

export function parsePatchEffects(patch: string): PatchEffect[] | undefined {
  if (patch.length > 1_000_000 || patch.includes('\0')) return undefined
  const lines = patch.trimEnd().split(/\r?\n/)
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') return undefined
  const effects: PatchEffect[] = []
  let index = 0
  while (index < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index++]!)
    if (!header || !header[2]!.trim() || header[2] !== header[2]!.trim()) return undefined
    const operation = header[1]!, path = header[2]!
    if (operation === 'Delete') {
      effects.push({ kind: 'delete', path })
      continue
    }
    let destination = path
    if (operation === 'Update' && lines[index]?.startsWith('*** Move to: ')) {
      destination = lines[index++]!.slice('*** Move to: '.length)
      if (!destination.trim() || destination !== destination.trim()) return undefined
      effects.push({ kind: 'delete', path })
    }
    effects.push({ kind: 'create-or-overwrite', path: destination })
    let body = 0
    while (index < lines.length && !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[index]!)) {
      const line = lines[index++]!
      const valid = operation === 'Add' ? line.startsWith('+')
        : /^[ +\-]/.test(line) || line === '@@' || line.startsWith('@@ ') || line === '*** End of File'
      if (!valid) return undefined
      body += 1
    }
    if (operation === 'Update' && body === 0) return undefined
  }
  return effects.length ? effects : undefined
}
