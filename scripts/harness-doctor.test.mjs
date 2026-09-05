import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectHarness, PLUGIN } from './harness-doctor.mjs'

const version = '0.1.2-rc.1'
const shared = ['cordis', 'dsh-session', 'dsh-tools', 'dsh-llm', 'dsh-permission-presets', 'dsh-user-approval', 'dsh-system-prompt', 'dsh-client-locale']
const json = (path, data) => writeFileSync(path, JSON.stringify(data))
function packageAt(root, name, targetVersion = version) {
  const path = join(root, 'node_modules', '@deepseek-ai', name)
  mkdirSync(path, { recursive: true })
  json(join(path, 'package.json'), { name: '@deepseek-ai/' + name, version: targetVersion, exports: { './package.json': './package.json' } })
  return path
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'auto-mode-doctor-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime'), profile = join(root, 'profile'), artifactRoot = join(root, 'package'), artifact = join(root, 'fixture.tgz')
  mkdirSync(runtime)
  json(join(runtime, 'package.json'), { name: 'diagnostic-test-runtime', version: '0.0.0' })
  const cli = packageAt(runtime, 'dsh')
  mkdirSync(join(cli, 'lib')); writeFileSync(join(cli, 'lib/bin.js'), '// Diagnostic fixture, never executed.\n')
  for (const name of shared) packageAt(runtime, name, name === 'cordis' ? '4.0.2' : version)
  mkdirSync(join(artifactRoot, 'lib'), { recursive: true })
  json(join(artifactRoot, 'package.json'), { name: PLUGIN, version: '0.1.7', exports: { './package.json': './package.json' } })
  json(join(artifactRoot, 'compatibility.json'), { supportedHosts: [{ version }] })
  writeFileSync(join(artifactRoot, 'cordis.patch.yml'), '- insert: []\n')
  for (const file of ['index.js', 'client.js', 'policy.js']) writeFileSync(join(artifactRoot, 'lib', file), '// Packaged diagnostic fixture.\n')
  execFileSync('tar', ['-czf', artifact, '-C', root, 'package'])
  symlinkSync(join(runtime, 'node_modules'), join(artifactRoot, 'node_modules'), 'dir')
  mkdirSync(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
  for (const name of shared) symlinkSync(join(runtime, 'node_modules/@deepseek-ai', name), join(profile, 'node_modules/@deepseek-ai', name), 'dir')
  mkdirSync(join(profile, 'node_modules/@nanmicoder'), { recursive: true })
  symlinkSync(artifactRoot, join(profile, 'node_modules/@nanmicoder/dsh-auto-mode'), 'dir')
  json(join(profile, 'package.json'), { name: 'diagnostic-test-profile', version: '0.0.0', dsh: { profile: { bundles: [PLUGIN] } } })
  return { runtime, profile, artifactRoot, artifact, expectedVersion: version }
}

test('accepts coherent shared identities and every unchanged packed file', t => {
  const report = inspectHarness(fixture(t))
  assert.equal(report.passed, true, JSON.stringify(report.issues))
  assert.equal(report.artifact.compared.length, 6)
  assert.equal(report.processIdentityVerified, false)
})
test('rejects a mixed installed and resolved cohort', t => {
  const state = fixture(t)
  packageAt(state.runtime, 'dsh-session', '0.1.2-alpha.2')
  assert.ok(inspectHarness(state).issues.some(issue => issue.code === 'MIXED_DSH_COHORT'))
})
test('rejects a same-version peer resolved from a second module identity', t => {
  const state = fixture(t)
  unlinkSync(join(state.profile, 'node_modules/@deepseek-ai/dsh-session'))
  packageAt(state.profile, 'dsh-session')
  const issues = inspectHarness(state).issues
  assert.ok(issues.some(issue => issue.code === 'PEER_IDENTITY_MISMATCH'))
  assert.ok(issues.some(issue => issue.code === 'DUPLICATE_DSH_IDENTITY'))
})
test('detects an otherwise unused nested DSH copy', t => {
  const state = fixture(t)
  const nested = join(state.runtime, 'node_modules/fixture-carrier')
  mkdirSync(nested)
  json(join(nested, 'package.json'), { name: 'fixture-carrier', version: '1.0.0' })
  packageAt(nested, 'dsh-session')
  assert.ok(inspectHarness(state).issues.some(issue => issue.code === 'DUPLICATE_DSH_IDENTITY'))
})
test('checks all packaged library bytes, including policy and unexpected modules', t => {
  const state = fixture(t)
  writeFileSync(join(state.artifactRoot, 'lib/policy.js'), '// Tampered test fixture.\n')
  writeFileSync(join(state.artifactRoot, 'lib/unexpected.js'), '// Extra test fixture.\n')
  const issues = inspectHarness(state).issues
  assert.ok(issues.some(issue => issue.code === 'ARTIFACT_BYTES_MISMATCH' && issue.file === 'lib/policy.js'))
  assert.ok(issues.some(issue => issue.code === 'ARTIFACT_UNEXPECTED_FILE' && issue.file === 'lib/unexpected.js'))
})
test('requires a profile version for provider package inventory', t => {
  const state = fixture(t)
  const path = join(state.profile, 'package.json'), manifest = JSON.parse(readFileSync(path, 'utf8'))
  delete manifest.version; json(path, manifest)
  assert.ok(inspectHarness(state).issues.some(issue => issue.code === 'PROFILE_VERSION_MISSING'))
})
