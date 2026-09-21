// Loaded by the exact Harness product entry. Imports classifiers from the tarball.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
export const name='jev-permission-benchmark';
export const inject=['llm'];
export function apply(ctx) {
 void (async()=>{
  await ctx.get('loader').await();
  const out=process.env.AUTO_ACCEPTANCE_DIR,source=process.env.AUTO_ACCEPTANCE_SOURCE_ROOT;
  const config=JSON.parse(readFileSync(process.env.AUTO_ACCEPTANCE_BENCHMARK_CONFIG,'utf8'));
  const fingerprint=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const fingerprints={dataset:fingerprint(join(source,'benchmarks/permission/cases.mjs')),metrics:fingerprint(join(source,'benchmarks/permission/metrics.mjs')),driver:fingerprint(new URL(import.meta.url))};
  if(!['test','development'].includes(config.split??'test'))throw Error('invalid benchmark split');
  if(!Array.isArray(config.jev)||!config.jev.length||new Set(config.jev.map(l=>l.id)).size!==config.jev.length||config.jev.some(l=>!l.id||l.id==='harness'))throw Error('invalid benchmark lanes');
  const {cases}=await import(pathToFileURL(join(source,'benchmarks/permission/cases.mjs')));
  const {summarize,pairedComparison}=await import(pathToFileURL(join(source,'benchmarks/permission/metrics.mjs')));
  const {createDshClassifier,createJevClassifier}=await import('@nanmicoder/dsh-auto-mode');
  const route={provider:'deepseek-official',model:process.env.AUTO_ACCEPTANCE_MODEL};
  const repetitions=config.repetitions??3;
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>10)throw Error('invalid repetitions');
  const lanes=[{id:'harness',classifier:createDshClassifier(ctx.llm,{timeoutMs:30000}),route}];
  const observations=[];
  let active;
  const observedFetch=async(url,options)=>{
    const response=await fetch(url,options);
    if(response.ok){const value=await response.clone().json();observations.push({active,model:value.model,usage:value.usage,permission:value.answers?.permission,providerMetadata:value.provider_metadata});}
    return response;
  };
  const skipped=[];
  for(const lane of config.jev){
    let apiKey;try{apiKey=readFileSync(lane.keyFile,'utf8').trim();}catch{skipped.push({id:lane.id,reason:'credential unavailable'});continue;}
    lanes.push({id:lane.id,classifier:createJevClassifier({provider:lane.provider,apiKey,timeoutMs:30000,minAllowProbability:0.9,fetchImpl:observedFetch,...(lane.model?{model:lane.model}:{})}),route:{provider:lane.provider,model:lane.model??null}});
  }
  const split=config.split??'test',selected=cases.filter(c=>c.split===split);
  if(lanes.length<2||!selected.length)throw Error('benchmark requires cases and at least one candidate provider');
  writeFileSync(join(out,'benchmark-inputs.json'),JSON.stringify(selected,null,2)+'\n',{mode:0o600});
  const rows=[],warmups=[],usage=[];
  ctx.on('llm/stream',async function*(options,next){for await(const chunk of next()){if(chunk.type==='usage')usage.push({active,usage:chunk.usage});yield chunk;}});
  const run=async(c,lane,repeat,warmup=false)=>{
    active={id:c.id,lane:lane.id,repeat};const start=performance.now();let result,error;
    try{result=await lane.classifier.classify({...c.input,route},new AbortController().signal);}catch(e){error=String(e.message).slice(0,160);}
    const row={id:c.id,family:c.family,category:c.category,expected:c.expected,lane:lane.id,repeat,ms:performance.now()-start,...(error?{error}:{decision:result.decision,reason:result.reason})};
    if(warmup)warmups.push(row);else {rows.push(row);appendFileSync(join(out,'benchmark-rows.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});}
  };
  for(const lane of lanes)await run(cases.find(c=>c.id==='dev-build'),lane,-1,true);
  let seed=20260920;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let repeat=0;repeat<repetitions;repeat++){
    const order=[...selected];for(let i=order.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
    for(let i=0;i<order.length;i++){
      // Sequential, rotated provider order: same concurrency and input per call.
      for(let offset=0;offset<lanes.length;offset++)await run(order[i],lanes[(i+repeat+offset)%lanes.length],repeat);
      if((i+1)%10===0)console.log(JSON.stringify({benchmarkProgress:true,repeat:repeat+1,cases:i+1,total:selected.length}));
    }
  }
  const report={schemaVersion:1,date:new Date().toISOString(),datasetSha256:fingerprints.dataset,fingerprints,split,repetitions,caseCount:selected.length,concurrency:1,seed:20260920,minAllowProbability:0.9,timeoutMs:30000,warmups,skipped,routes:lanes.map(l=>({id:l.id,...l.route})),summary:Object.fromEntries(lanes.map(l=>[l.id,summarize(rows.filter(r=>r.lane===l.id))])),comparisons:lanes.slice(1).map(l=>pairedComparison(rows,'harness',l.id)),nativeUsage:usage,rows};
  report.jevObservations=observations;
  writeFileSync(join(out,'benchmark-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({benchmarkComplete:true,cases:selected.length,repetitions,lanes:lanes.map(l=>l.id),skipped}));
  ctx.get('appExit')(rows.some(r=>r.error)?1:0);
 })().catch(error=>{console.error('BENCHMARK_FAILED',error.message);ctx.get('appExit')(1);});
}
