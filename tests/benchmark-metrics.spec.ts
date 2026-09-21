import {describe,it,expect} from 'vitest'
import {summarize,pairedComparison} from '../benchmarks/permission/metrics.mjs'
import {cases} from '../benchmarks/permission/cases.mjs'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
describe('permission benchmark',()=>{
 it('keeps errors in accuracy and includes asks in unsafe allows',()=>{
  const s=summarize([{expected:'allow',decision:'allow',ms:10},{expected:'deny',decision:'allow',ms:20},{expected:'ask',error:'timeout',ms:100}]);
  expect(s.accuracy).toBe(1/3);expect(s.errors).toBe(1);expect(s.unsafeAllow.rate).toBe(.5);expect(s.confusion.ask.error).toBe(1);expect(s.latencyMs.successP95).toBe(20);
  expect(summarize([{expected:'allow',decision:'allow',error:'invalid response',ms:1}]).accuracy).toBe(0);
 });
 it('pairs the same case and repeat without substituting failed calls',()=>{
  const rows=[{lane:'a',id:'x',family:'x',repeat:0,ms:20,expected:'deny',decision:'deny'},{lane:'b',id:'x',family:'x',repeat:0,ms:10,expected:'deny',decision:'allow'}];
  expect(pairedComparison(rows,'a','b').medianPairedSpeedup).toBe(2);expect(pairedComparison(rows,'a','b').accuracyDelta).toBe(-1);
  const failed=[...rows,{lane:'a',id:'y',family:'y',repeat:0,ms:20,expected:'allow',decision:'allow'},{lane:'b',id:'y',family:'y',repeat:0,ms:30000,expected:'allow',error:'timeout'}];
  expect(pairedComparison(failed,'a','b').accuracyDelta).toBe(-1);
  expect(pairedComparison(failed,'a','b').matchedPairs).toBe(2);
  expect(pairedComparison(failed,'a','b').successfulPairs).toBe(1);
 });
 it('has unique ids, paired authority contrasts and no label inside inputs',()=>{
  expect(new Set(cases.map(c=>c.id)).size).toBe(cases.length);
  for(const c of cases){expect(c.input).not.toHaveProperty('expected');expect(c.input).not.toHaveProperty('rationale');expect(['allow','ask','deny']).toContain(c.expected);}
  expect(cases.filter(c=>c.category==='authority-pair')).toHaveLength(20);
 });
 it('publishes only complete measurements and retains skipped boundaries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jev-report-test-'));
  try {
   const input=join(dir,'raw.json'),output=join(dir,'summary.json'),measurements=join(dir,'measurements.json');
   const rows=['harness','jev'].map(lane=>({lane,id:'one',family:'one',category:'routine',expected:'allow',decision:'allow',repeat:0,ms:10,reason:'PRIVATE_EXPLANATION'}));
   const report={rows,routes:[{id:'harness',model:'flash'},{id:'jev'}],caseCount:1,repetitions:1,skipped:[{id:'vercel',reason:'credential unavailable'}]};
   const run=()=>spawnSync(process.execPath,['benchmarks/permission/report.mjs',input,output,measurements],{encoding:'utf8'});
   writeFileSync(input,JSON.stringify(report));expect(run().status).toBe(0);
   const text=readFileSync(output,'utf8');expect(text).not.toContain('PRIVATE_EXPLANATION');expect(JSON.parse(text).skipped).toEqual(report.skipped);
   expect(readFileSync(measurements,'utf8')).not.toContain('PRIVATE_EXPLANATION');
   expect(JSON.parse(readFileSync(measurements,'utf8')).rows).toHaveLength(2);
   writeFileSync(input,JSON.stringify({...report,rows:rows.slice(0,1)}));expect(run().status).not.toBe(0);
   writeFileSync(input,JSON.stringify({...report,rows:[...rows,rows[0]]}));expect(run().status).not.toBe(0);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
});
