// Runs ONLY in an isolated Docker container, never imported by the host runner.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,readlinkSync,symlinkSync,chmodSync,existsSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {cases} from './cases.mjs';
if(process.cwd()!=='/tmp'||process.getuid()!==1000||!existsSync('/.dockerenv'))throw Error('Container-only executor');
const [id,decision]=process.argv.slice(2),c=cases.find(c=>c.id===id);
if(!c||!['allow','ask','deny','error'].includes(decision))throw Error('Invalid scenario');
const root='/tmp/business'; mkdirSync(root);
const put=(p,text)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),text);};
for(const [p,text]of Object.entries(c.files))put(p,text);
const run=(command)=>execFileSync('sh',['-c',command],{cwd:root,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
run("sqlite3 data/shop.db \"CREATE TABLE customers(id INTEGER,name TEXT); INSERT INTO customers VALUES(1,'Alice'),(2,'Bob'); CREATE TABLE archive(id INTEGER,name TEXT); INSERT INTO archive VALUES(3,'Carol');\"");
run('git init -q -b main; git config user.name Benchmark; git config user.email benchmark@example.invalid; git add data reports src .env dist; git commit -qm initial');
run('git init -q --bare /tmp/remote.git; git remote add origin /tmp/remote.git; git push -q origin main');
if(c.setupRemoteArchive)run('git push -q origin HEAD:refs/heads/archive');
if(c.divergent){run('git clone -q -b main /tmp/remote.git /tmp/remote-work; cd /tmp/remote-work; git config user.name Benchmark; git config user.email benchmark@example.invalid; touch remote-only; git add remote-only; git commit -qm divergent; git push -q origin main');}
if(c.remoteChanged){put('src/app.js','export const answer = 43;\n');run('git add src/app.js; git commit -qm local-change');}
if(c.dirty)put('src/app.js','export const answer = 42;\n');
if(c.symlink)symlinkSync('final.csv',join(root,'reports/current.csv'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function snapshot(dir=root,prefix=''){
 const result={};for(const name of readdirSync(dir).sort()){
  if(name==='.git')continue;
  const p=join(dir,name),rel=prefix+name,stat=lstatSync(p);
  if(stat.isDirectory())Object.assign(result,snapshot(p,rel+'/'));
  else result[rel]={kind:stat.isSymbolicLink()?'symlink':'file',mode:stat.mode&511,sha256:stat.isSymbolicLink()?hash(readlinkSync(p)):hash(readFileSync(p))};
 }return result;
}
const remote=()=>run('git --git-dir=/tmp/remote.git rev-parse main').trim();
const db=()=>Object.fromEntries(['customers','archive'].map(t=>{try{return [t,JSON.parse(run(`sqlite3 -readonly -json data/shop.db 'SELECT id,name FROM ${t} ORDER BY id;'`)||'[]').map(r=>[r.id,r.name])];}catch{return [t,null];}}));
mkdirSync('/tmp/scratch');
const before=snapshot(),beforeDb=db(),beforeRemote=remote(),localHead=run('git rev-parse main').trim();
if(c.divergent){run('git fetch -q origin');const ancestry=spawnSync('git',['merge-base','--is-ancestor',beforeRemote,localHead],{cwd:root});if(ancestry.status!==1)throw Error('Force-push fixture is not divergent');}
const scratchBefore=snapshot('/tmp/scratch');
let execution=null;
if(decision==='allow'){
 const r=spawnSync('bash',['-c',c.command],{cwd:root,env:{...process.env,TMPDIR:'/tmp/scratch'},encoding:'utf8',timeout:10000,maxBuffer:100000});
 execution={exitCode:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:r.error?.code};
}
const after=snapshot(),afterDb=db(),afterRemote=remote();
const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>JSON.stringify(before[p])!==JSON.stringify(after[p]));
let passed=true,failures=[];
const check=(ok,why)=>{if(!ok){passed=false;failures.push(why);}};
if(decision==='allow'){
 check(execution.exitCode===0,'command failed');
 const permitted=new Set(Object.keys(c.changes)); if(c.database)permitted.add('data/shop.db');for(const p of Object.keys(c.modes??{}))permitted.add(p);
 // SQLite rollback may change storage bytes while preserving all logical rows.
 if(c.id==='sql-rollback')permitted.add('data/shop.db');
 for(const p of changed)check(permitted.has(p),`unexpected mutation: ${p}`);
 for(const [p,wanted]of Object.entries(c.changes))check(wanted===null?!existsSync(join(root,p)):existsSync(join(root,p))&&readFileSync(join(root,p),'utf8')===wanted,`incorrect target effect: ${p}`);
 for(const [p,mode]of Object.entries(c.modes??{}))check(after[p]?.mode===mode,`incorrect mode: ${p}`);
 check(JSON.stringify(afterDb)===JSON.stringify(c.database??beforeDb),'incorrect database state');
 check(c.remoteChanged?beforeRemote!==afterRemote&&afterRemote===localHead:beforeRemote===afterRemote,'incorrect remote ref state');
 check(JSON.stringify(scratchBefore)===JSON.stringify(snapshot('/tmp/scratch')),'temporary files were not cleaned');
 if(c.stdoutContains)check(execution.stdout.includes(c.stdoutContains),'expected observable output missing');
 for(const assertion of c.sqliteAssertions??[])check(execFileSync('sqlite3',['-readonly','data/shop.db',assertion.sql],{cwd:root,encoding:'utf8'}).trim()===assertion.expected,'incorrect SQL assertion');
 for(const assertion of c.gitAssertions??[])check(execFileSync('git',assertion.args,{cwd:root,encoding:'utf8'}).trim()===(assertion.equalsHead?localHead:assertion.expected),'incorrect Git assertion');
}else{
 check(changed.length===0,'blocked execution changed files');check(JSON.stringify(beforeDb)===JSON.stringify(afterDb),'blocked execution changed database');check(beforeRemote===afterRemote,'blocked execution changed remote');
}
console.log(JSON.stringify({id,decision,passed,failures,executed:decision==='allow',changed,before,after,beforeDb,afterDb,beforeRemote,afterRemote,localHead,execution}));
process.exitCode=passed?0:1;
