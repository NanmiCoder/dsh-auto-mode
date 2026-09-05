import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const core = '(0|[1-9][0-9]*)';
if (!new RegExp(`^${core}\\.${core}\\.${core}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(version)
  || version.split('-').slice(1).join('-').split('.').some(id => /^0[0-9]+$/.test(id))) throw Error('Invalid release version');
const tag = `v${version}`, distTag = version.includes('-') ? 'next' : 'latest';
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
if (manual) {
  if (process.env.RELEASE_VERSION !== version) throw Error('Manual retry requires the current accepted package version');
} else if (process.env.GITHUB_REF_TYPE !== 'tag' || process.env.GITHUB_REF_NAME !== tag) {
  throw Error('Publish must run from the exact package version tag');
}
if (process.env.RELEASE_VERSION && process.env.RELEASE_VERSION !== version) throw Error('Dispatch version differs from package');
const sourceSha = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8' }).trim();
if (process.env.RELEASE_SOURCE_SHA && process.env.RELEASE_SOURCE_SHA !== sourceSha) throw Error('Release tag changed after validation');
if (manual) {
  // Recovery may fix CI on main, but must keep the accepted tag and its metadata.
  execFileSync('git', ['diff', '--exit-code', sourceSha, 'HEAD', '--', 'package.json', 'release-candidate.json', 'RELEASE_NOTES.md'], { stdio: 'pipe' });
} else if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceSha) {
  throw Error('Checkout differs from the exact release tag');
}
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'package.json', 'release-candidate.json', 'RELEASE_NOTES.md'], { stdio: 'pipe' });
if (process.argv.includes('--registry-check') && distTag === 'latest') {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const latest = JSON.parse(execFileSync('npm', ['view', `${manifest.name}@latest`, 'version', '--json', '--registry=https://registry.npmjs.org/'], { encoding: 'utf8' }));
  if (typeof latest !== 'string' || !/^\d+\.\d+\.\d+$/.test(latest)) throw Error('Cannot verify current stable registry version');
  const candidate = version.split('.').map(Number), current = latest.split('.').map(Number);
  const firstDifference = candidate.findIndex((value, i) => value !== current[i]);
  if (firstDifference < 0 || candidate[firstDifference] < current[firstDifference]) throw Error(`Refusing to move latest from ${latest} to ${version}`);
}
const output = `version=${version}\ntag=${tag}\ndist-tag=${distTag}\nsource-sha=${sourceSha}\n`;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
console.log(output.trim());
