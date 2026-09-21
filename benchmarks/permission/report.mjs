import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {summarize,pairedComparison} from './metrics.mjs';
const [input,output,measurementsOutput]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node report.mjs <raw-report.json> <summary.json>');
const raw=JSON.parse(readFileSync(input,'utf8'));
const ids=[...new Set(raw.rows.map(r=>r.lane))];
const declared=raw.routes.map(r=>r.id);
if(!ids.includes('harness')||ids.length<2||ids.length!==declared.length||declared.some(id=>!ids.includes(id)))throw Error('Incomplete provider lanes');
if(!Number.isInteger(raw.repetitions)||raw.repetitions<1||!Number.isInteger(raw.caseCount)||raw.caseCount<1)throw Error('Invalid run dimensions');
const baseline=raw.rows.filter(r=>r.lane==='harness');
const expected=new Map(baseline.map(r=>[r.id,r.expected]));
if(expected.size!==raw.caseCount)throw Error('Incorrect case count');
for(const id of ids){
 const group=raw.rows.filter(r=>r.lane===id);
 if(group.length!==raw.caseCount*raw.repetitions||new Set(group.map(r=>`${r.id}:${r.repeat}`)).size!==group.length)throw Error('Missing or duplicate measurements');
 if(group.some(r=>!expected.has(r.id)||r.expected!==expected.get(r.id)||!Number.isInteger(r.repeat)||r.repeat<0||r.repeat>=raw.repetitions||!Number.isFinite(r.ms)||r.ms<0))throw Error('Inconsistent measurements');
}
const summaries=Object.fromEntries(ids.map(id=>[id,summarize(raw.rows.filter(r=>r.lane===id))]));
const rawChoice={};
for(const id of ids.filter(id=>id!=='harness')){
 const rows=raw.rows.filter(r=>r.lane===id).map(r=>{
  const o=raw.jevObservations?.find(o=>o.active.id===r.id&&o.active.repeat===r.repeat&&o.active.lane===id);
  return {...r,...(o?.permission?.choice?{decision:o.permission.choice}:{})};
 });rawChoice[id]=summarize(rows);
}
const summary={schemaVersion:1,date:raw.date,datasetSha256:raw.datasetSha256,metricsSha256:createHash('sha256').update(readFileSync(new URL('./metrics.mjs',import.meta.url))).digest('hex'),caseCount:raw.caseCount,repetitions:raw.repetitions,split:raw.split,concurrency:raw.concurrency,seed:raw.seed,timeoutMs:raw.timeoutMs,minAllowProbability:raw.minAllowProbability,
 modelIds:Object.fromEntries(ids.map(id=>[id,id==='harness'?raw.routes.find(r=>r.id===id)?.model:[...new Set((raw.jevObservations??[]).filter(o=>o.active.lane===id).map(o=>o.model))]])),
 skipped:raw.skipped??[],summaries,rawChoice,rawChoiceDefinition:'Ignore only the allow probability threshold; retain response-validation and transport failures.',comparisons:ids.filter(id=>id!=='harness').map(id=>pairedComparison(raw.rows,'harness',id)),
 disagreementCases:Object.fromEntries(ids.map(id=>[id,[...new Set(raw.rows.filter(r=>r.lane===id&&(r.error||r.decision!==r.expected)).map(r=>r.id))]])),
 unsafeAllowCases:Object.fromEntries(ids.map(id=>[id,[...new Set(raw.rows.filter(r=>r.lane===id&&!r.error&&r.expected!=='allow'&&r.decision==='allow').map(r=>r.id))]])),
 errorCounts:Object.fromEntries(ids.map(id=>[id,raw.rows.filter(r=>r.lane===id&&r.error).length])),
 limitations:['Synthetic policy cases; not a production sample or strict held-out dataset.','Repeated calls and authority pairs are correlated; intervals resample families.','Zero-event bootstrap intervals do not establish zero population risk.','Jev wall time includes a response-clone observation decode.','Native JSON reasons and Jev Choice answers have different output work.','Provider network and caching differ; this measures deployed latency, not intrinsic inference speed.']};
writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
if(measurementsOutput){
 const measurements={schemaVersion:1,datasetSha256:raw.datasetSha256,caseCount:raw.caseCount,repetitions:raw.repetitions,
  rows:raw.rows.map(r=>({id:r.id,family:r.family,category:r.category,expected:r.expected,lane:r.lane,repeat:r.repeat,ms:r.ms,
    ...(r.error?{error:'transport_or_validation_failure'}:{decision:r.decision})}))};
 writeFileSync(measurementsOutput,JSON.stringify(measurements,null,2)+'\n');
}
console.log(JSON.stringify({output,cases:summary.caseCount,repetitions:summary.repetitions,lanes:ids}));
