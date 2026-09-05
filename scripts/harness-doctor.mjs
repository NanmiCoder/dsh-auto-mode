#!/usr/bin/env node
/** Read-only identities for the actual resolved Harness, profile and packaged plugin. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, existsSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const PLUGIN = '@nanmicoder/dsh-auto-mode'
const isDsh = name => /^@deepseek-ai\/dsh(?:-|$)/.test(name)
export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const requireAt = root => createRequire(join(resolve(root), 'package.json'))

function packageIdentity(name, root) {
  const path = requireAt(root).resolve(`${name}/package.json`)
  const realPath = realpathSync(path)
  const manifest = readJson(realPath)
  if (manifest.name !== name) throw Error(`Resolved ${name} to unexpected package ${manifest.name}`)
  return { name, version: manifest.version, manifestPath: path, realPath, root: dirname(realPath) }
}

/** Scan nested node_modules and pnpm stores by real identity, never user configuration. */
function installedDsh(roots) {
  const found = new Map(), visited = new Set()
  function packageDir(path) {
    let actual
    try { actual = realpathSync(path) } catch { return }
    const manifestPath = join(actual, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath)
      if (isDsh(manifest.name)) found.set(manifestPath, { name: manifest.name, version: manifest.version, root: actual, realPath: manifestPath })
    }
    modules(join(actual, 'node_modules'))
  }
  function modules(path) {
    if (!existsSync(path)) return
    const actual = realpathSync(path)
    if (visited.has(actual)) return
    visited.add(actual)
    for (const entry of readdirSync(actual, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const child = join(actual, entry.name)
      if (entry.name === '.pnpm') {
        for (const stored of readdirSync(child, { withFileTypes: true })) {
          if (stored.isDirectory()) modules(join(child, stored.name, 'node_modules'))
        }
      } else if (entry.name.startsWith('@')) {
        for (const pkg of readdirSync(child)) packageDir(join(child, pkg))
      } else if (!entry.name.startsWith('.')) packageDir(child)
    }
  }
  for (const root of roots) modules(join(root, 'node_modules'))
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root))
}

export function inspectHarness({ runtime, profile, artifactRoot, artifact, expectedVersion }) {
  runtime = resolve(runtime)
  if (profile) profile = resolve(profile)
  if (artifactRoot) artifactRoot = resolve(artifactRoot)
  const issues = [], warnings = []
  const host = packageIdentity('@deepseek-ai/dsh', runtime)
  const version = expectedVersion ?? host.version
  if (host.version !== version) issues.push({ code: 'HOST_VERSION_MISMATCH', expected: version, actual: host.version })
  const scopes = { runtime, ...(profile ? { profile } : {}), ...(artifactRoot ? { artifact: artifactRoot } : {}) }
  const installed = installedDsh(Object.values(scopes))
  if (!installed.some(pkg => pkg.realPath === host.realPath)) issues.push({ code: 'HOST_NOT_IN_COHORT_SCAN' })
  for (const pkg of installed) if (pkg.version !== version) issues.push({ code: 'MIXED_DSH_COHORT', ...pkg, expected: version })
  const byName = new Map()
  for (const pkg of installed) {
    const entries = byName.get(pkg.name) ?? []
    entries.push(pkg); byName.set(pkg.name, entries)
  }
  for (const [name, copies] of byName) if (copies.length > 1) issues.push({ code: 'DUPLICATE_DSH_IDENTITY', name, copies })
  // Check the dependency edges each installed DSH package actually resolves, not just directory labels.
  const edges = []
  for (const pkg of installed) {
    const manifest = readJson(pkg.realPath)
    const dependencies = { ...manifest.peerDependencies, ...manifest.optionalDependencies, ...manifest.dependencies }
    for (const name of Object.keys(dependencies).filter(isDsh)) {
      try {
        const resolved = packageIdentity(name, pkg.root)
        edges.push({ from: pkg.name, fromRoot: pkg.root, to: name, root: resolved.root, version: resolved.version })
        if (resolved.version !== version) issues.push({ code: 'RESOLVED_EDGE_COHORT_MISMATCH', from: pkg.name, ...resolved, expected: version })
      } catch (error) {
        const optional = name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional === true
        const finding = { code: 'UNRESOLVED_DSH_EDGE', from: pkg.name, name, optional, error: error.message }
        ;(optional ? warnings : issues).push(finding)
      }
    }
  }
  const identities = {}
  const shared = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-permission-presets', '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-client-locale']
  for (const [label, root] of Object.entries(scopes)) {
    identities[label] = {}
    for (const name of shared) {
      try { identities[label][name] = packageIdentity(name, root) }
      catch (error) { issues.push({ code: 'UNRESOLVED_SHARED_PEER', scope: label, name, error: error.message }) }
    }
  }
  for (const name of shared) {
    const base = identities.runtime[name]
    for (const label of Object.keys(scopes).filter(label => label !== 'runtime')) {
      const candidate = identities[label][name]
      if (base && candidate && base.realPath !== candidate.realPath) issues.push({ code: 'PEER_IDENTITY_MISMATCH', name, scope: label, host: base.realPath, plugin: candidate.realPath })
    }
  }
  let plugin, profileEvidence, artifactEvidence
  if (artifactRoot) {
    const manifestPath = join(artifactRoot, 'package.json')
    const manifest = readJson(manifestPath)
    plugin = { name: manifest.name, version: manifest.version, root: realpathSync(artifactRoot), manifestSha256: sha256(manifestPath) }
    if (manifest.name !== PLUGIN) issues.push({ code: 'ARTIFACT_PACKAGE_MISMATCH', expected: PLUGIN, actual: manifest.name })
    const compatibilityPath = join(artifactRoot, 'compatibility.json')
    if (existsSync(compatibilityPath) && !readJson(compatibilityPath).supportedHosts?.some(host => host.version === version)) issues.push({ code: 'PLUGIN_HOST_NOT_SUPPORTED', version })
    if (artifact) {
      const compared = []
      const entries = execFileSync('tar', ['-tzf', resolve(artifact)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\n').filter(Boolean)
      if (!entries.every(path => path.startsWith('package/') && !path.split('/').includes('..'))) throw Error('Artifact contains an invalid package path')
      const files = new Set(entries.filter(path => !path.endsWith('/')).map(path => path.slice('package/'.length)))
      function checkExtra(directory, prefix = '') {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (prefix === '' && entry.name === 'node_modules') continue
          const relative = prefix + entry.name
          if (entry.isDirectory()) checkExtra(join(directory, entry.name), relative + '/')
          else if (!files.has(relative)) issues.push({ code: 'ARTIFACT_UNEXPECTED_FILE', file: relative })
        }
      }
      checkExtra(artifactRoot)
      for (const file of files) {
        const installed = join(artifactRoot, file)
        if (!existsSync(installed)) { issues.push({ code: 'ARTIFACT_FILE_MISSING', file }); continue }
        if (!lstatSync(installed).isFile()) { issues.push({ code: 'ARTIFACT_NON_REGULAR_FILE', file }); continue }
        try {
          const bytes = execFileSync('tar', ['-xOf', resolve(artifact), 'package/' + file], { maxBuffer: 32 * 1024 * 1024 })
          const packedSha256 = createHash('sha256').update(bytes).digest('hex')
          const installedSha256 = sha256(installed)
          compared.push({ file, packedSha256, installedSha256 })
          if (packedSha256 !== installedSha256) issues.push({ code: 'ARTIFACT_BYTES_MISMATCH', file })
        } catch (error) { issues.push({ code: 'ARTIFACT_MEMBER_UNREADABLE', file, error: error.message }) }
      }
      artifactEvidence = { path: resolve(artifact), sha256: sha256(resolve(artifact)), compared }
    }
  }
  if (profile) {
    const manifestPath = join(profile, 'package.json')
    const manifest = readJson(manifestPath)
    const bundles = manifest.dsh?.profile?.bundles
    if (typeof manifest.version !== 'string' || !manifest.version) issues.push({ code: 'PROFILE_VERSION_MISSING' })
    profileEvidence = { root: profile, realRoot: realpathSync(profile), manifestSha256: sha256(manifestPath), bundles }
    if (!Array.isArray(bundles) || !bundles.includes(PLUGIN)) issues.push({ code: 'PLUGIN_NOT_IN_PROFILE_BUNDLES' })
    try {
      const resolved = packageIdentity(PLUGIN, profile)
      profileEvidence.plugin = resolved
      if (plugin && resolved.root !== plugin.root) issues.push({ code: 'PROFILE_ARTIFACT_IDENTITY_MISMATCH', expected: plugin.root, actual: resolved.root })
    } catch (error) { issues.push({ code: 'PLUGIN_NOT_RESOLVABLE_FROM_PROFILE', error: error.message }) }
  }
  const bin = join(host.root, 'lib/bin.js')
  if (!existsSync(bin)) issues.push({ code: 'PRODUCT_BIN_MISSING', bin })
  return { passed: issues.length === 0, kind: 'resolved-harness-identity-diagnostic', processIdentityVerified: false, host: { ...host, bin, binSha256: existsSync(bin) ? sha256(bin) : undefined }, expectedVersion: version, node: process.version, installedCohortCount: installed.length, installed, edges, identities, plugin, profile: profileEvidence, artifact: artifactEvidence, issues, warnings }
}

function argumentsOf(argv) {
  const result = {}
  const names = new Set(['runtime', 'profile', 'artifact-root', 'artifact', 'host-version', 'out'])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    if (!names.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--') || key in result) throw Error('Expected --runtime <root> [--profile <root> --artifact-root <package> --artifact <tgz> --host-version <exact> --out <json>]')
    result[key] = argv[index + 1]
  }
  if (!result.runtime) throw Error('--runtime is required')
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsOf(process.argv.slice(2))
    const report = inspectHarness({ runtime: args.runtime, profile: args.profile, artifactRoot: args['artifact-root'], artifact: args.artifact, expectedVersion: args['host-version'] })
    if (args.out) writeFileSync(resolve(args.out), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ passed: report.passed, version: report.host.version, cohortCount: report.installedCohortCount, issues: report.issues, warnings: report.warnings, report: args.out }, null, 2))
    process.exitCode = report.passed ? 0 : 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
