import {execFileSync} from 'node:child_process';
import {cases} from './cases.mjs';
import {executeCase,imageIdentity} from './docker.mjs';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const out=process.argv[2];if(!out?.startsWith('/tmp/'))throw Error('Evidence directory must be outside the repository in /tmp');
mkdirSync(out,{recursive:true,mode:0o700});
const imageId=imageIdentity(),results=[];
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const manifest=JSON.parse(execFileSync('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--entrypoint','node',imageId,'-e',"const f=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(['cases.mjs','worker.mjs'].map(n=>[n,c.createHash('sha256').update(f.readFileSync('/opt/benchmark/'+n)).digest('hex')]))))"],{encoding:'utf8'}));
for(const name of ['cases.mjs','worker.mjs'])if(manifest[name]!==hash(new URL('./'+name,import.meta.url)))throw Error('Stale Docker image: '+name);
for(const c of cases){
 const allow=executeCase(c.id,'allow',imageId),deny=executeCase(c.id,'deny',imageId);
 results.push({id:c.id,allow,deny});
 writeFileSync(out+'/oracle.json',JSON.stringify({imageId,manifest,datasetSha256:createHash('sha256').update(readFileSync(new URL('./cases.mjs',import.meta.url))).digest('hex'),results},null,2));
 console.log(JSON.stringify({id:c.id,oracle:allow.passed&&deny.passed}));
}
