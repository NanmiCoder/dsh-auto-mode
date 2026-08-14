import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')

if (manifest.name !== '@nanmicoder/dsh-auto-mode') {
  throw new Error(`unexpected npm package name: ${JSON.stringify(manifest.name)}`)
}
if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  throw new Error('scoped package must publish publicly to the official npm registry')
}
if (!patch.includes("name: '@nanmicoder/dsh-auto-mode'")) {
  throw new Error('cordis.patch.yml must resolve the scoped npm package name')
}
if (manifest.scripts?.prepublishOnly !== 'pnpm verify' || manifest.scripts?.prepare !== 'pnpm run build') {
  throw new Error('npm and Git distribution lifecycle scripts are missing or incorrect')
}
for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
  if (manifest.peerDependenciesMeta?.[peer]?.optional !== true) {
    throw new Error(`DSH-provided peer must be optional for clean profile installation: ${peer}`)
  }
}

if (manifest.dsh?.client?.platform !== 'web' || !Array.isArray(manifest.dsh?.client?.inject)) {
  throw new Error('Web client manifest is missing or invalid')
}
if (manifest.exports?.['./client']?.default !== './lib/client.js'
  || manifest.exports?.['./client']?.types !== './lib/client/index.d.ts') {
  throw new Error('Web client export is missing or incorrect')
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('bundle patch declaration is missing or incorrect')
}
for (const path of ['./lib/index.js', './lib/index.d.ts', './lib/client.js', './lib/client.js.map', './lib/client/index.d.ts', './assets/readme/hero.svg', './cordis.patch.yml', './README.md', './README_ZH.md', './DESIGN.md']) {
  await access(resolve(root, path))
}
for (const entry of ['lib', 'assets/readme/hero.svg', 'cordis.patch.yml', 'README.md', 'README_ZH.md', 'DESIGN.md']) {
  if (!manifest.files?.includes(entry)) throw new Error(`npm files[] is missing ${entry}`)
}
const clientBundle = await readFile(resolve(root, 'lib/client.js'), 'utf8')
if (!/window\.__ModuleLoader__\.load\(\{\s*id:\s*["']@nanmicoder\/dsh-auto-mode["']/.test(clientBundle)) {
  throw new Error('client bundle does not register the npm package id')
}
if (/require\(["']@deepseek-ai\//.test(clientBundle)) {
  throw new Error('client bundle contains an unresolved DeepSeek package import')
}
console.log('package contract verified')
