#!/usr/bin/env node
/** Run the packaged plugin through the actual Harness CLI. Only the model is a fixture. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { inspectHarness, sha256, PLUGIN } from './harness-doctor.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const runnerSha256 = sha256(fileURLToPath(import.meta.url))
const doctorSha256 = sha256(join(scriptRoot, 'harness-doctor.mjs'))
const flags = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  if (!['--runtime', '--artifact', '--out', '--host-version', '--timeout-ms'].includes(key) || key in flags || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw Error('Usage: node scripts/harness-runtime-verify.mjs --artifact <tgz> --out <new-directory> [--runtime <host-root>] [--host-version <exact>] [--timeout-ms <milliseconds>]')
  flags[key] = process.argv[index + 1]
}
if (!flags['--artifact'] || !flags['--out'] || (!flags['--runtime'] && !flags['--host-version'])) throw Error('--artifact, --out and either --runtime or --host-version are required')
const reportDir = resolve(flags['--out'])
if (existsSync(reportDir) && readdirSync(reportDir).length) throw Error('Report directory must be empty; existing evidence is never overwritten')
mkdirSync(reportDir, { recursive: true })
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const timeoutMs = Number(flags['--timeout-ms'] ?? 150000)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) throw Error('Invalid --timeout-ms (1000..900000)')
const runtime = resolve(flags['--runtime'] ?? join(reportDir, 'runtime'))
const artifact = resolve(flags['--artifact'])
const artifactSha256 = sha256(artifact)
const artifactCopy = join(reportDir, `artifact-${artifactSha256}.tgz`)
copyFileSync(artifact, artifactCopy)
const safeHome = join(reportDir, 'user-home'), temp = join(reportDir, 'tmp')
mkdirSync(safeHome, { recursive: true }); mkdirSync(temp, { recursive: true })
const emptyNpmConfig = join(reportDir, 'npmrc.empty')
writeFileSync(emptyNpmConfig, '')
const environment = extra => ({ PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''), HOME: safeHome, USERPROFILE: safeHome, TMPDIR: temp, TMP: temp, TEMP: temp, LANG: 'en_US.UTF-8', npm_config_userconfig: emptyNpmConfig, npm_config_registry: 'https://registry.npmjs.org', ...extra })

async function runCommand(command, args, cwd, env, label, limit) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let stdout = '', stderr = '', timedOut = false, forceTimer
  const cap = 8 * 1024 * 1024
  child.stdout.on('data', value => { stdout = (stdout + value).slice(-cap) })
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-cap) })
  const signalOwned = signal => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const stop = () => {
    signalOwned('SIGTERM')
    forceTimer = setTimeout(() => signalOwned('SIGKILL'), 5000)
    forceTimer.unref()
  }
  const timer = setTimeout(() => { timedOut = true; stop() }, limit)
  const interrupted = () => stop()
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted)
  let exit
  try { exit = await new Promise((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })) }) }
  finally {
    clearTimeout(timer); clearTimeout(forceTimer)
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted)
    writeFileSync(join(reportDir, label + '.stdout.log'), stdout)
    writeFileSync(join(reportDir, label + '.stderr.log'), stderr)
  }
  let remainingProcessGroup = false
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 0); remainingProcessGroup = true } catch (error) { if (error.code !== 'ESRCH') throw error }
    if (remainingProcessGroup) signalOwned('SIGKILL')
  }
  return { ...exit, pid: child.pid, timedOut, remainingProcessGroup, stdout, stderr }
}

async function installRuntime(version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(version)) throw Error('--host-version must be exact semver')
  mkdirSync(runtime, { recursive: true })
  if (readdirSync(runtime).length) throw Error('Automatic installation needs a fresh runtime directory')
  const packages = new Map(), pending = new Set(['@deepseek-ai/dsh'])
  while (pending.size) {
    const batch = [...pending].filter(name => !packages.has(name)).slice(0, 12)
    if (!batch.length) break
    batch.forEach(name => pending.delete(name))
    const results = await Promise.all(batch.map(async name => {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(45000) })
      if (!response.ok) throw Error(`Official registry lacks exact ${name}@${version}: HTTP ${response.status}`)
      const pkg = await response.json()
      if (pkg.name !== name || pkg.version !== version) throw Error('Registry package identity mismatch')
      return pkg
    }))
    for (const pkg of results) {
      packages.set(pkg.name, pkg)
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) if (/^@deepseek-ai\/dsh(?:-|$)/.test(name) && !packages.has(name)) pending.add(name)
    }
  }
  json(join(reportDir, 'registry-cohort.json'), { registry: 'https://registry.npmjs.org', version, packages: [...packages.values()].map(pkg => ({ name: pkg.name, version: pkg.version, gitHead: pkg.gitHead, integrity: pkg.dist?.integrity })) })
  json(join(runtime, 'package.json'), { name: 'auto-mode-product-runtime-test', version: '0.0.0', private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': version }, overrides: Object.fromEntries([...packages.keys()].map(name => [name, version])) })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const installed = await runCommand(npm, ['install', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--userconfig=' + emptyNpmConfig], runtime, environment({ npm_config_cache: join(reportDir, 'npm-cache') }), 'install', 900000)
  if (installed.code !== 0 || installed.timedOut) throw Error('Exact runtime install failed; inspect install.stderr.log')
}

let final
try {
  if (!flags['--runtime']) await installRuntime(flags['--host-version'])
  const initial = inspectHarness({ runtime, expectedVersion: flags['--host-version'] })
  json(join(reportDir, 'runtime-doctor.json'), initial)
  if (!initial.passed) throw Error('Runtime cohort/identity check failed; inspect runtime-doctor.json')
  const version = initial.host.version
  const extracted = join(reportDir, 'extracted')
  mkdirSync(extracted)
  const entries = execFileSync('tar', ['-tzf', artifactCopy], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean)
  if (!entries.every(path => path.startsWith('package/') && !path.split('/').includes('..'))) throw Error('Artifact contains a path outside package/')
  execFileSync('tar', ['-xzf', artifactCopy, '-C', extracted])
  const artifactRoot = join(extracted, 'package')
  const pluginManifest = JSON.parse(readFileSync(join(artifactRoot, 'package.json'), 'utf8'))
  if (pluginManifest.name !== PLUGIN) throw Error('Not an Auto Mode package artifact')
  if (existsSync(join(artifactRoot, 'node_modules'))) throw Error('Package unexpectedly includes node_modules')
  symlinkSync(join(runtime, 'node_modules'), join(artifactRoot, 'node_modules'), 'dir')
  const home = join(reportDir, 'home'), profile = join(home, 'profiles/headless')
  mkdirSync(join(profile, 'node_modules/@nanmicoder'), { recursive: true })
  symlinkSync(artifactRoot, join(profile, 'node_modules/@nanmicoder/dsh-auto-mode'), 'dir')
  symlinkSync(join(runtime, 'node_modules/@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), 'dir')
  const yaml = createRequire(join(runtime, 'package.json'))('yaml')
  json(join(profile, 'package.json'), { name: 'auto-mode-product-test-profile', version: '0.0.0', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', PLUGIN], patchReload: 'startup' } } })
  const pluginPatch = yaml.parse(readFileSync(join(artifactRoot, 'cordis.patch.yml'), 'utf8'))
  const permission = pluginPatch.find(patch => patch.id === 'permission')?.config
  if (!permission?.presets?.auto) throw Error('Artifact does not declare the Auto permission preset')
  const fixture = join(profile, 'auto-mode-fixture.mjs')
  copyFileSync(join(scriptRoot, 'fixtures/harness-runtime-llm.mjs'), fixture)
  writeFileSync(join(profile, 'cordis.patch.yml'), yaml.stringify([
    { id: 'permission', config: { ...permission, defaultPreset: 'auto' } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'agent-default-model', config: { provider: 'auto-mode-fixture', model: 'deterministic' } },
    { insert: [{ id: 'auto-mode-product-fixture', name: './auto-mode-fixture.mjs' }] },
  ]))
  const doctor = inspectHarness({ runtime, profile, artifactRoot, artifact: artifactCopy, expectedVersion: version })
  json(join(reportDir, 'doctor.json'), doctor)
  if (!doctor.passed) throw Error('Profile/artifact identity check failed; inspect doctor.json')
  const effects = join(reportDir, 'effects'), protectedPath = join(safeHome, '.ssh', 'synthetic-protected-canary.txt')
  mkdirSync(effects)
  mkdirSync(dirname(protectedPath), { recursive: true })
  const protectedValue = 'SYNTHETIC FIXTURE CANARY; NEVER A REAL CREDENTIAL\n'
  writeFileSync(protectedPath, protectedValue)
  const tracePath = join(reportDir, 'trace.jsonl')
  const env = environment({ DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', AUTO_FIXTURE_TRACE: tracePath, AUTO_FIXTURE_EFFECTS: effects, AUTO_FIXTURE_PROTECTED: protectedPath })
  const cwd = '/tmp'
  if (!existsSync(cwd)) throw Error('Fixture needs an existing /tmp workspace')
  const args = [doctor.host.bin, '--profile', 'headless', 'Execute the authorized deterministic Auto Mode product fixture in the existing /tmp workspace. Test only the isolated fixture files and report the results.']
  json(join(reportDir, 'launch.json'), { version, pluginVersion: pluginManifest.version, command: process.execPath, args, cwd, runtime: realpathSync(runtime), profile, artifactSha256, model: 'deterministic fixture', realApi: false, fixtureSha256: sha256(fixture), runnerSha256, doctorSha256 })
  const run = await runCommand(process.execPath, args, cwd, env, 'host', timeoutMs)
  const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const resultFor = label => trace.find(event => event.event === 'tool-result' && event.label === label)
  const modelFor = label => trace.find(event => event.event === 'model-request' && event.step === label)
  const contents = file => existsSync(join(effects, file)) ? readFileSync(join(effects, file), 'utf8') : undefined
  const expectedResults = { ordinary: false, redundant: true, recovery: false, 'classifier-allow': false, 'classifier-deny': true, 'classifier-ask': true, 'hard-deny': true, delegation: false, 'child-ordinary': false, 'child-widening': true, 'classifier-error-1': true, 'classifier-error-2': true, 'classifier-error-3': true }
  const asked = trace.filter(event => event.event === 'approval/asked')
  const decisions = trace.filter(event => event.event === 'approval/decided')
  const exactAllowAsk = asked.find(event => String(event.data.callId).endsWith('-classifier-allow'))
  const exactAllowDecision = decisions.find(event => event.data.id === exactAllowAsk?.data.id)
  const assertions = {
    verificationCodeUnchanged: sha256(fileURLToPath(import.meta.url)) === runnerSha256 && sha256(join(scriptRoot, 'harness-doctor.mjs')) === doctorSha256,
    normalExit: run.code === 0 && !run.timedOut,
    noRemainingProcessGroup: !run.remainingProcessGroup,
    productMarker: run.stdout.includes('AUTO_MODE_PRODUCT_FIXTURE_OK'),
    fixtureActive: trace.some(event => event.event === 'fixture-activated' && event.realApi === false && ['/tmp', '/private/tmp'].includes(event.process.cwd)),
    activeServiceIdentitiesMatch: Object.values(trace.find(event => event.event === 'fixture-activated')?.servicesMatchResolvedClasses ?? {}).length === 3 && Object.values(trace.find(event => event.event === 'fixture-activated')?.servicesMatchResolvedClasses ?? {}).every(Boolean) && trace.filter(event => event.event === 'tool-result').every(event => event.sessionIdentityMatches === true),
    allToolsSettledCorrectly: Object.entries(expectedResults).every(([label, expected]) => resultFor(label)?.isError === expected),
    ordinaryFile: contents('ordinary.txt') === 'ordinary\n',
    fieldlessRetryExecuted: contents('recovery.txt') === 'recovery\n',
    exactAllowExecuted: contents('allowed.txt') === 'classifier-allow\n',
    childExecuted: contents('child.txt') === 'child-ordinary\n',
    deniedEffectsAbsent: ['denied.txt', 'asked.txt', 'error-1.txt', 'error-2.txt', 'error-3.txt', 'child-widening.txt'].every(file => contents(file) === undefined),
    canaryUnchanged: readFileSync(protectedPath, 'utf8') === protectedValue,
    allSessionCwdExistingTmp: trace.filter(event => event.event === 'tool-result').every(event => event.cwd === '/tmp' || event.cwd === '/private/tmp'),
    parentAutoActive: trace.filter(event => event.event === 'tool-result' && !event.child).every(event => event.preset === 'auto'),
    childInheritedGuidance: modelFor('child-ordinary')?.autoGuidance === true,
    recoverySchemaFieldsRemoved: modelFor('recovery')?.bashHasSandboxField === false,
    ordinarySchemaFieldsRestored: modelFor('classifier-allow')?.bashHasSandboxField === true,
    classifierRouteReused: trace.filter(event => event.event === 'classifier-request').length === 6 && trace.filter(event => event.event === 'classifier-request').every(event => event.provider === 'auto-mode-fixture' && event.model === 'deterministic' && event.directUserMessages.some(text => text.includes('authorized deterministic Auto Mode'))),
    oneShotGrantAudited: exactAllowAsk !== undefined && exactAllowDecision?.data.outcome === 'allowed-once' && asked.length === 3 && decisions.length === 3,
    manualAnswererUsedOnlyForAsks: trace.filter(event => event.event === 'manual-approval').map(event => event.label).sort().join(',') === 'classifier-ask,classifier-error-3',
  }
  const processIdentity = trace.find(event => event.event === 'fixture-activated')?.process
  assertions.actualProcessMatchesLaunch = processIdentity?.pid === run.pid && processIdentity?.node === process.version
  final = { passed: Object.values(assertions).every(Boolean), kind: 'real-product-entry-with-fixture-model', realApi: false, version, pluginVersion: pluginManifest.version, artifactSha256, fixtureSha256: sha256(fixture), runnerSha256, doctorSha256, node: process.version, platform: process.platform, runtime, profile, cwd, processIdentity, cohortCount: doctor.installedCohortCount, exit: { code: run.code, signal: run.signal, timedOut: run.timedOut, remainingProcessGroup: run.remainingProcessGroup }, assertions, toolResults: trace.filter(event => event.event === 'tool-result'), unverified: ['real provider APIs', 'browser interaction', 'PowerShell and Windows sandbox', 'live user-data migration'] }
} catch (error) {
  final = { passed: false, kind: 'real-product-entry-with-fixture-model', realApi: false, artifactSha256, runtime, error: error.stack ?? error.message }
}
json(join(reportDir, 'result.json'), final)
console.log(JSON.stringify({ passed: final.passed, version: final.version, artifactSha256, assertions: final.assertions, error: final.error, report: reportDir }, null, 2))
process.exitCode = final.passed ? 0 : 1
