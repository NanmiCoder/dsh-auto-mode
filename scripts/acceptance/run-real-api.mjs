import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, symlinkSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const [runtimeArg, artifactArg, runArg, mode = 'headless', driverArg, shell = 'bash'] = process.argv.slice(2);
if (!runtimeArg || !artifactArg || !runArg) throw Error('Usage: node scripts/acceptance/run-real-api.mjs <runtime> <tgz> <new-report-dir> [headless|web] [driver.mjs] [bash|pwsh]');
if (!['headless','web'].includes(mode) || !['bash','pwsh'].includes(shell)) throw Error('Invalid acceptance mode');
const userDshHome = process.env.AUTO_REAL_DSH_HOME ?? join(homedir(), '.dsh');
const runtime = resolve(runtimeArg), artifact = resolve(artifactArg), run = resolve(runArg);
let evidenceParent = dirname(run);
while (!existsSync(evidenceParent)) evidenceParent = dirname(evidenceParent);
const fromTmp = relative(realpathSync('/tmp'), realpathSync(evidenceParent));
if (fromTmp === '..' || fromTmp.startsWith('../') || isAbsolute(fromTmp)) throw Error('Acceptance evidence must stay inside the existing /tmp directory');
if (existsSync(run)) throw Error('Use a new evidence directory; existing results are not overwritten');
const require = createRequire(join(runtime, 'package.json')), yaml = require('yaml');
const version = require('@deepseek-ai/dsh/package.json').version;
const settings = yaml.parse(readFileSync(join(userDshHome, 'settings.yaml'), 'utf8'));
let credentials = yaml.parse(readFileSync(join(userDshHome, '.credentials.yaml'), 'utf8'));
const route = settings['agent-default-model'], provider = settings['llm-deepseek'] ?? {};
if (route?.provider !== 'deepseek-official' || route?.model !== 'deepseek-v4-flash') throw Error('Unexpected user model route');
const ref = provider.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
let key = credentials?.refs?.[ref] ?? credentials?.[ref];
if (typeof key !== 'string' || !key.trim()) key = parseEnv(readFileSync(join(userDshHome, '.env'), 'utf8'))[ref];
if (typeof key !== 'string' || !key.trim()) throw Error('No configured real API credential');
key = key.trim(); credentials = undefined;
const providerConfig = { apiKeyEnv: 'DEEPSEEK_API_KEY', maxTokens: 4096, reasoningEffort: 'low', retryPolicy: { mode: 'normal', maxRetries: 0 } };
for (const field of ['baseURL','models','thinking','defaultContextWindow']) if (provider[field] !== undefined) providerConfig[field] = provider[field];
const home = join(run, 'home'), profile = join(home, 'profiles', mode), extracted = join(run, 'artifact');
for (const path of [profile, extracted, join(run, 'user-home'), join(run, 'tmp'), join(profile, 'node_modules/@nanmicoder')]) mkdirSync(path, { recursive: true });
execFileSync('tar', ['-xzf', artifact, '-C', extracted]);
symlinkSync(join(runtime, 'node_modules'), join(extracted, 'package/node_modules'), 'dir');
symlinkSync(join(extracted, 'package'), join(profile, 'node_modules/@nanmicoder/dsh-auto-mode'), 'dir');
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
json(join(profile, 'package.json'), { name: 'auto-mode-acceptance-profile', version: '0.0.0', private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', mode === 'web' ? '@deepseek-ai/dsh-web-app' : '@deepseek-ai/dsh-headless', '@nanmicoder/dsh-auto-mode'], patchReload: 'startup' } } });
const patches = [{ id: 'permission', config: { ...yaml.parse(readFileSync(join(extracted, 'package/cordis.patch.yml'), 'utf8')).find(p => p.id === 'permission').config, defaultPreset: 'auto' } }, { id: 'llm-pi-ai', disabled: true }, { id: 'llm-deepseek', config: providerConfig }, { id: 'agent-default-model', config: route }];
if (shell === 'pwsh') patches.push({id:'bash-sandbox',disabled:true},{id:'tool-bash',disabled:true},{id:'pwsh-sandbox',disabled:false},{id:'tool-pwsh',disabled:false});
if (driverArg) {
  copyFileSync(resolve(driverArg), join(profile, 'acceptance-driver.mjs'));
  // Resolve test observer imports from the actual host, never from source deps.
  symlinkSync(join(runtime, 'node_modules/@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), 'dir');
  if (mode === 'headless') patches.push({ id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true });
  patches.push({ insert: [{ id: 'auto-mode-acceptance', name: './acceptance-driver.mjs' }] });
}
writeFileSync(join(profile, 'cordis.patch.yml'), yaml.stringify(patches));
const env = { PATH: process.env.PATH, HOME: join(run,'user-home'), TMPDIR: join(run,'tmp'), LANG: 'en_US.UTF-8', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', DEEPSEEK_API_KEY: key, AUTO_ACCEPTANCE_DIR: run, AUTO_ACCEPTANCE_VERSION: version, AUTO_ACCEPTANCE_SHELL: shell };
const args = [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', mode, ...(mode === 'web' ? ['--port', '0', '--no-open'] : [])];
const child = spawn(process.execPath, args, { cwd: '/tmp', env, stdio: ['ignore','pipe','pipe'] });
let output = '', announced = false;
json(join(run,'identity.json'), { version, plugin: JSON.parse(readFileSync(join(extracted,'package/package.json'))).version, artifactSha256: createHash('sha256').update(readFileSync(artifact)).digest('hex'), node: process.version, runtime, profile, cwd: '/tmp', pid: child.pid, provider: route.provider, model: route.model });
for (const stream of [child.stdout,child.stderr]) stream.on('data', data => {
  output += data; writeFileSync(join(run,'host.log'), output.split(key).join('[REDACTED]'), { mode: 0o600 });
  const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/);
  if (match && !announced) { announced = true; writeFileSync(join(run,'startup-url.txt'),match[1],{ mode:0o600 }); const url=new URL(match[1]);url.search='';console.log(JSON.stringify({ ready:true,version,pid:child.pid,run,url:url.href })); }
});
console.log(JSON.stringify({ started:true,version,pid:child.pid,run,mode }));
child.on('exit',(code,signal)=>{console.log(JSON.stringify({exit:code,signal,run}));process.exitCode=code??1;});
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGTERM'));
