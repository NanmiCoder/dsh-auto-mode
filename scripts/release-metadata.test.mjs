import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

// Test the real metadata script in disposable Git repositories. Only the
// registry subprocess is replaced; no npm credentials or network are used.
const metadataSource = readFileSync(new URL('./release-metadata.mjs', import.meta.url), 'utf8')
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')

function fixture(t, { version = '0.1.7', tagged = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'auto-release-metadata-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), output = join(root, 'output.txt'), registryCalls = join(root, 'registry.jsonl')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'gitconfig'), '')
  const env = {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = (message) => {
    git('add', '--all')
    git('-c', 'commit.gpgsign=false', 'commit', '--no-gpg-sign', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '--initial-branch=main')
  json(join(repo, 'package.json'), { name: '@nanmicoder/dsh-auto-mode', version })
  json(join(repo, 'release-candidate.json'), { version, artifactSha256: 'fixture-only-no-real-api' })
  writeFileSync(join(repo, 'RELEASE_NOTES.md'), 'Synthetic release metadata fixture.\n')
  writeFileSync(join(repo, 'scripts/release-metadata.mjs'), metadataSource)
  const taggedSha = commit('Accepted fixture source')
  if (tagged) git('-c', 'tag.gpgsign=false', 'tag', '-a', `v${version}`, '-m', 'Immutable fixture release')

  const registryStub = join(root, 'registry-stub.mjs')
  writeFileSync(registryStub, `
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const execute = childProcess.execFileSync;
childProcess.execFileSync = function(command, args, options) {
  if (command !== 'npm') return execute(command, args, options);
  if (JSON.stringify(args) !== JSON.stringify(['view', '@nanmicoder/dsh-auto-mode@latest', 'version', '--json', '--registry=https://registry.npmjs.org/'])) {
    throw Error('Unexpected npm invocation in metadata test');
  }
  appendFileSync(process.env.METADATA_TEST_CALLS, JSON.stringify(args) + '\\n');
  if (process.env.METADATA_TEST_REGISTRY_ERROR) throw Error('Synthetic registry unavailable');
  return process.env.METADATA_TEST_LATEST + '\\n';
};
syncBuiltinESMExports();
`)
  function run({ manual = false, releaseVersion = manual ? version : '', refType = manual ? 'branch' : 'tag',
    refName = manual ? 'main' : `v${version}`, expectedSource = '', latest = '0.1.6', registryError = false } = {}) {
    rmSync(output, { force: true })
    rmSync(registryCalls, { force: true })
    const result = spawnSync(process.execPath, ['--import', registryStub, join(repo, 'scripts/release-metadata.mjs'), '--registry-check'], {
      cwd: repo, encoding: 'utf8', env: {
        ...env, GITHUB_EVENT_NAME: manual ? 'workflow_dispatch' : 'push', GITHUB_REF_TYPE: refType,
        GITHUB_REF_NAME: refName, RELEASE_VERSION: releaseVersion, RELEASE_SOURCE_SHA: expectedSource,
        GITHUB_OUTPUT: output, METADATA_TEST_CALLS: registryCalls,
        METADATA_TEST_LATEST: JSON.stringify(latest), METADATA_TEST_REGISTRY_ERROR: registryError ? '1' : '',
      },
    })
    const lines = existsSync(output) ? readFileSync(output, 'utf8').trim() : ''
    return {
      ...result,
      outputs: Object.fromEntries(lines.split('\n').filter(Boolean).map(line => {
        const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]
      })),
      registryCalls: existsSync(registryCalls) ? readFileSync(registryCalls, 'utf8').trim().split('\n').map(JSON.parse) : [],
    }
  }
  return { repo, version, taggedSha, git, commit, run }
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stderr)
  for (const [key, value] of Object.entries(result.outputs)) assert.ok(result.stdout.includes(`${key}=${value}\n`))
}

function rejected(result, error) {
  assert.notEqual(result.status, 0, result.stdout)
  assert.deepEqual(result.outputs, {}, 'A rejected release must not emit publish outputs')
  if (error) assert.match(result.stderr, error)
}

test('selects the existing annotated release tag and emits its peeled commit', t => {
  const state = fixture(t), result = state.run()
  succeeded(result)
  assert.equal(result.outputs['source-sha'], state.taggedSha)
  assert.notEqual(result.outputs['source-sha'], state.git('rev-parse', `refs/tags/v${state.version}`))
  assert.equal(result.outputs.tag, 'v0.1.7')
  assert.equal(result.outputs['dist-tag'], 'latest')
  assert.equal(result.registryCalls.length, 1)
})

test('manual retry may change CI while tests and publication remain pinned to the accepted tag', t => {
  const state = fixture(t)
  writeFileSync(join(state.repo, 'ci-fix.txt'), 'Workflow-only repair.\n')
  const retrySha = state.commit('Repair release workflow')
  assert.notEqual(retrySha, state.taggedSha)
  const result = state.run({ manual: true })
  succeeded(result)
  assert.equal(result.outputs['source-sha'], state.taggedSha)
  assert.equal(state.git('rev-parse', `refs/tags/v${state.version}^{commit}`), state.taggedSha)
})

for (const releaseVersion of ['', '0.1.6']) {
  test(`rejects a manual retry with ${releaseVersion || 'missing'} version`, t => {
    rejected(fixture(t).run({ manual: true, releaseVersion }), /current accepted package version/)
  })
}

test('rejects release selection when its immutable tag is absent', t => {
  rejected(fixture(t, { tagged: false }).run({ manual: true }), /rev-parse|Needed a single revision/)
})

test('rejects a non-manual run from a branch or a different version tag', t => {
  const state = fixture(t)
  rejected(state.run({ refType: 'branch', refName: 'main' }), /exact package version tag/)
  rejected(state.run({ refName: 'v0.1.6' }), /exact package version tag/)
})

test('tag-triggered runs require checkout HEAD to equal the tagged commit', t => {
  const state = fixture(t)
  writeFileSync(join(state.repo, 'other.txt'), 'Another commit.\n')
  state.commit('Different checkout')
  rejected(state.run(), /Checkout differs from the exact release tag/)
})

const metadataChanges = {
  'package.json': state => json(join(state.repo, 'package.json'), { name: '@nanmicoder/dsh-auto-mode', version: state.version, description: 'Changed after acceptance' }),
  'release-candidate.json': state => json(join(state.repo, 'release-candidate.json'), { version: state.version, artifactSha256: 'different-fixture-bytes' }),
  'RELEASE_NOTES.md': state => writeFileSync(join(state.repo, 'RELEASE_NOTES.md'), 'Changed release notes.\n'),
}
for (const [file, change] of Object.entries(metadataChanges)) {
  test(`rejects committed tag/current metadata drift in ${file}`, t => {
    const state = fixture(t); change(state); state.commit(`Change ${file}`)
    rejected(state.run({ manual: true }))
  })
  test(`rejects uncommitted tag/current metadata drift in ${file}`, t => {
    const state = fixture(t); change(state)
    rejected(state.run({ manual: true }))
  })
}

test('second validation rejects a release tag moved after source SHA selection', t => {
  const state = fixture(t), first = state.run({ manual: true })
  succeeded(first)
  writeFileSync(join(state.repo, 'other.txt'), 'Different fixture source.\n')
  const movedSha = state.commit('Another fixture source')
  // Mutate only this disposable test repository to simulate remote ref drift.
  state.git('update-ref', `refs/tags/v${state.version}`, movedSha)
  rejected(state.run({ manual: true, expectedSource: first.outputs['source-sha'] }), /Release tag changed after validation/)
})

test('second validation accepts the unchanged source SHA', t => {
  const state = fixture(t), first = state.run({ manual: true })
  succeeded(first)
  succeeded(state.run({ manual: true, expectedSource: first.outputs['source-sha'] }))
})

for (const latest of ['0.1.7', '0.1.8', '0.2.0']) {
  test(`refuses moving registry latest ${latest} to candidate 0.1.7`, t => {
    rejected(fixture(t).run({ latest }), /Refusing to move latest/)
  })
}

test('registry errors and malformed latest values fail closed', t => {
  const state = fixture(t)
  rejected(state.run({ registryError: true }), /Synthetic registry unavailable/)
  rejected(state.run({ latest: { version: '0.1.6' } }), /Cannot verify current stable registry version/)
})

test('pre-release tags use next and never query or move stable latest', t => {
  const state = fixture(t, { version: '0.1.8-rc-next.1' }), result = state.run()
  succeeded(result)
  assert.equal(result.outputs['dist-tag'], 'next')
  assert.equal(result.outputs['source-sha'], state.taggedSha)
  assert.deepEqual(result.registryCalls, [])
})

for (const version of ['00.1.7', '0.1.8-01']) {
  test(`rejects invalid SemVer ${version} before registry access`, t => {
    const result = fixture(t, { version }).run()
    rejected(result, /Invalid release version/)
    assert.deepEqual(result.registryCalls, [])
  })
}
