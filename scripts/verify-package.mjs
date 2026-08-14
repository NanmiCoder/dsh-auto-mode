import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

if (manifest.dsh?.client !== undefined || manifest.exports?.['./client'] !== undefined) {
  throw new Error('host-only package must not declare a client entry')
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('bundle patch declaration is missing or incorrect')
}
for (const path of ['./lib/index.js', './lib/index.d.ts', './cordis.patch.yml', './README.md', './DESIGN.md']) {
  await access(resolve(root, path))
}
console.log('package contract verified')
