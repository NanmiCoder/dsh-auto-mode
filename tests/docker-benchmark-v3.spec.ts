import {describe,it,expect} from 'vitest'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {cases} from '../benchmarks/docker-permission-v3/cases.mjs'

// Offline report fixtures only: no Docker process, model request or real evidence.
function fixture() {
 const lanes=['harness','jev-typesafe'];
 const rows=lanes.flatMap(lane=>cases.flatMap(c=>[0,1,2,3,4].map(repeat=>({
  cohort:c.cohort,id:c.id,family:c.family,category:c.category,expected:c.expected,lane,repeat,ms:20,
  decision:c.informationGap?(c.expected==='allow'?'deny':'allow'):c.expected,
  reason:'PRIVATE_MODEL_REASON',informationGap:!!c.informationGap,
 }))));
 const effects=rows.map(r=>({...r,passed:true,executed:r.decision==='allow',changed:[],containerMs:30,execution:{stdout:'PRIVATE_TOOL_OUTPUT'}}));
 const providers:Record<string,string>={harness:'deepseek-official','jev-typesafe':'typesafe','jev-openrouter':'openrouter'};
 const raw={rows,routes:lanes.map(id=>({id,provider:providers[id]})),repetitions:5,caseCount:cases.length,skipped:[],jevObservations:[],fingerprints:Object.fromEntries([['baseline','baseline-cases.mjs'],['worker','worker.mjs']].map(([name,file])=>[name,createHash('sha256').update(readFileSync('benchmarks/docker-permission-v3/'+file)).digest('hex')])),
  datasetSha256:createHash('sha256').update(readFileSync('benchmarks/docker-permission-v3/cases.mjs')).digest('hex')};
 return {raw,effects};
}

describe('Expanded official-only Docker benchmark publication',()=>{
 it('counts errors, separates hidden cases, links effects and excludes private payloads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'docker-benchmark-report-test-'));
  try {
   const {raw,effects}=fixture();
   const index=raw.rows.findIndex(r=>r.lane==='jev-typesafe'&&!r.informationGap&&r.expected==='allow');
   Object.assign(raw.rows[index],{error:'PRIVATE_PROVIDER_ERROR',decision:undefined});
   Object.assign(effects[index],{decision:'error',executed:false});
   writeFileSync(join(dir,'benchmark-report.json'),JSON.stringify(raw));
   writeFileSync(join(dir,'docker-effects.jsonl'),effects.map(r=>JSON.stringify(r)).join('\n'));
   const prefix=join(dir,'public');
   const result=spawnSync(process.execPath,['benchmarks/docker-permission-v3/report.mjs',dir,prefix],{encoding:'utf8'});
   expect(result.status,result.stderr).toBe(0);
   const text=readFileSync(prefix+'.summary.json','utf8')+readFileSync(prefix+'.measurements.json','utf8');
   expect(text).not.toContain('PRIVATE_');
   const summary=JSON.parse(readFileSync(prefix+'.summary.json','utf8'));
   const n=cases.filter(c=>!c.informationGap).length*5;
   expect(summary.summary['jev-typesafe'].n).toBe(n);
   expect(summary.summary['jev-typesafe'].errors).toBe(1);
   expect(summary.summary['jev-typesafe'].accuracy).toBe((n-1)/n);
   expect(summary.summary.harness.accuracy).toBe(1);
   expect(summary.allCasesSummary.harness.accuracy).toBeLessThan(1);
   expect(summary.informationGap).toHaveLength(cases.filter(c=>c.informationGap).length*10);
   expect(summary.comparisons[0].accuracyDelta).toBe(-1/n);
   expect(summary.businessEffects['jev-typesafe'].completedAllowTasks).toBe(summary.businessEffects['jev-typesafe'].allowTasks-1);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it.each(['missing','duplicate','decision-mismatch','execution-mismatch','wrong-provider','wrong-round-count'])('rejects %s effect evidence',kind=>{
  const dir=mkdtempSync(join(tmpdir(),'docker-benchmark-report-test-'));
  try {
   const {raw,effects}=fixture();
   if(kind==='wrong-provider')raw.routes[1]={id:'jev-openrouter',provider:'openrouter'};
   if(kind==='wrong-round-count')raw.repetitions=3;
   if(kind==='missing')effects.pop();
   if(kind==='duplicate')effects[1]=effects[0];
   if(kind==='decision-mismatch')effects[0].decision='deny';
   if(kind==='execution-mismatch')effects[0].executed=!effects[0].executed;
   writeFileSync(join(dir,'benchmark-report.json'),JSON.stringify(raw));
   writeFileSync(join(dir,'docker-effects.jsonl'),effects.map(r=>JSON.stringify(r)).join('\n'));
   const result=spawnSync(process.execPath,['benchmarks/docker-permission-v3/report.mjs',dir,join(dir,'public')],{encoding:'utf8'});
   expect(result.status).not.toBe(0);
   expect(result.stderr).toMatch(/Incomplete measurements|Duplicate measurements|Inconsistent measurement|Unexpected provider routes|Incomplete planned comparison/);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
});
