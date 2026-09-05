import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const candidate = JSON.parse(readFileSync(new URL('../release-candidate.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (!process.argv[2]) throw Error('Pass the exact release tarball');
const hash = createHash('sha256').update(readFileSync(process.argv[2])).digest('hex');
if (candidate.version !== pkg.version || candidate.artifactSha256 !== hash || candidate.realApiPassed !== true) throw Error('Artifact differs from the locally accepted real API candidate');
console.log(`Release artifact matches local real API acceptance: ${pkg.version} ${hash}`);
