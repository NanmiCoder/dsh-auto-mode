import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const pkg = read('package.json'), compat = read('compatibility.json'), lock = read('skills/upstream-lock.json');
const versions = compat.supportedHosts.map(h => h.version);
if (new Set(versions).size !== versions.length || !versions.includes(compat.recommendedHost)) throw Error('Invalid supported host matrix');
for (const [name, version] of Object.entries(pkg.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh') && version !== compat.recommendedHost) throw Error(`Non-exact development host: ${name}`);
}
for (const [name, range] of Object.entries(pkg.peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh') && range !== versions.join(' || ')) throw Error(`Peer drift: ${name}`);
}
if (JSON.stringify(pkg.overrides) !== JSON.stringify(pkg.pnpm.overrides)) throw Error('npm and pnpm host overrides differ');
for (const [name, version] of Object.entries(pkg.overrides)) {
  if (name.startsWith('@deepseek-ai/dsh') && version !== compat.recommendedHost) throw Error(`Mixed host override: ${name}`);
}
for (const [name, sha256] of Object.entries(lock.files)) {
  const actual = createHash('sha256').update(readFileSync(resolve(root, 'skills', name))).digest('hex');
  if (actual !== sha256) throw Error(`Vendored skill changed: ${name}`);
}
console.log(`Maintenance contract verified: ${versions.length} exact hosts, ${Object.keys(lock.files).length} pinned skill files`);
