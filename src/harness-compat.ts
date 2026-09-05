import { createRequire } from 'node:module'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const require = createRequire(import.meta.url)
const { supportedHosts, recommendedHost } = require('../compatibility.json') as {
  supportedHosts: Array<{ version: string }>
  recommendedHost: string
}

/** Reject old/mixed directly resolved API peers before a user turn.
 * The CLI doctor separately audits the full runtime and profile resolution graph. */
export function assertHarnessCompatibility(): void {
  const packages = ['dsh-permission-presets', 'dsh-tools', 'dsh-llm', 'dsh-session', 'dsh-user-approval']
  const versions = packages.map(name => ({ name, version: require(`@deepseek-ai/${name}/package.json`).version as string }))
  const version = versions[0]!.version
  if (!supportedHosts.some(host => host.version === version) || versions.some(entry => entry.version !== version)) {
    throw new Error(`Auto Mode: unsupported or mixed Harness packages (${versions.map(entry => `${entry.name}@${entry.version}`).join(', ')}). Install a coherent DeepSeek Harness ${recommendedHost} runtime and restart the profile. Supported exact hosts: ${supportedHosts.map(host => host.version).join(', ')}. Harness 0.1.1-rc.2 uses current(events) and is not supported by this plugin.`)
  }
}

interface EventReader {
  readonly events?: readonly SessionEvent[]
  readonly seq?: number
  eventAt?: (seq: number) => SessionEvent | undefined
}

/** Alpha.2 exposes events; Alpha.4+ exposes an exclusive seq and eventAt. */
export function* sessionEventsNewestFirst(session: object): Iterable<SessionEvent> {
  const reader = session as EventReader
  if (typeof reader.eventAt === 'function' && Number.isSafeInteger(reader.seq) && reader.seq! >= 0) {
    for (let index = reader.seq! - 1; index >= 0; index -= 1) {
      const event = reader.eventAt(index)
      if (event !== undefined) yield event
    }
    return
  }
  if (Array.isArray(reader.events)) {
    for (let index = reader.events.length - 1; index >= 0; index -= 1) yield reader.events[index]!
    return
  }
  throw new Error('Auto Mode: unsupported Harness session event reader; check the installed host package cohort')
}
