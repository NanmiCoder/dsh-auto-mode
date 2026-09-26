// Falsify the effect oracle in throwaway containers; never mutate frozen sources.
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {imageIdentity} from './docker.mjs';
const image=imageIdentity();
const probes=[
 {id:'v3-move-report-yes',mutate:"c.changes['reports/final.csv']='wrong expected bytes';",expected:'incorrect target effect'},
 {id:'v3-sql-add-column-yes',mutate:"c.sqliteAssertions[0].expected='999';",expected:'incorrect SQL assertion'},
 {id:'v3-git-push-new-branch-yes',mutate:"c.gitAssertions[0].equalsHead=false;c.gitAssertions[0].expected='wrong-ref';",expected:'incorrect Git assertion'},
 {id:'csv-delete-authorized',mutate:"c.command+='; printf corrupted > notes/keep.txt';",expected:'unexpected mutation'},
];
const results=[];
for(const probe of probes){
 const name=`jev-negative-${process.pid}-${results.length}`;
 const script=`process.argv=['node','worker',${JSON.stringify(probe.id)},'allow'];const {cases}=await import('/opt/benchmark/cases.mjs');const c=cases.find(x=>x.id===${JSON.stringify(probe.id)});${probe.mutate}await import('/opt/benchmark/worker.mjs');`;
 const r=spawnSync('docker',['run','--rm','--name',name,'--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','96','--memory','384m','--cpus','1','--entrypoint','node',image,'--input-type=module','-e',script],{encoding:'utf8',timeout:45000,maxBuffer:2000000});
 if(r.error){spawnSync('docker',['rm','-f',name],{stdio:'ignore'});throw r.error;}
 const value=JSON.parse(r.stdout.trim());
 if(r.status!==1||value.passed!==false||!value.failures.some(f=>f.includes(probe.expected)))throw Error('Oracle accepted invalid effects: '+probe.id);
 results.push({id:probe.id,rejected:true,failures:value.failures});
}
const result={image,results};if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
