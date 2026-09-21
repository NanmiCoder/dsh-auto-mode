import {spawnSync,execFileSync} from 'node:child_process';
export const image='dsh-auto-permission-benchmark:v2';
export function imageIdentity(){return JSON.parse(execFileSync('docker',['image','inspect',image],{encoding:'utf8'}))[0].Id;}
export function executeCase(id,decision,imageId=image){
 const name=`dsh-permission-${process.pid}-${Date.now()}`;
 const args=['run','--rm','--name',name,'--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','96','--memory','384m','--cpus','1',imageId,id,decision];
 const started=performance.now();const r=spawnSync('docker',args,{encoding:'utf8',timeout:45000,maxBuffer:2000000});
 if(r.error||r.status!==0){spawnSync('docker',['rm','-f',name],{stdio:'ignore'});throw Error(`Docker oracle failed for ${id}: ${r.error?.message??r.stdout??r.stderr}`);}
 let result;try{result=JSON.parse(r.stdout.trim());}catch{throw Error(`Invalid Docker evidence for ${id}`);}
 if(!result.passed||result.id!==id||result.decision!==decision)throw Error(`Invalid oracle result for ${id}`);
 return {...result,containerMs:performance.now()-started};
}
