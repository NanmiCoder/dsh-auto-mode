import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export const name = 'auto-mode-web-observer';
export const inject = ['llm','workspaceRegistry'];
export async function apply(ctx) {
  const record = data => appendFileSync(join(process.env.AUTO_ACCEPTANCE_DIR,'web-trace.jsonl'),JSON.stringify({time:Date.now(),...data})+'\n');
  const workspace=await ctx.workspaceRegistry.create('/tmp','/tmp');
  record({event:'workspace-registered',id:workspace.id,root:'/tmp'});
  let count=0;
  ctx.on('llm/stream',async function*(options,next){
    if(++count>60) throw Error('Acceptance request budget exceeded');
    record({event:'request',request:count,provider:options.provider,model:options.model,classifier:options.system?.includes('independent security classifier')===true});
    for await(const chunk of next()){
      if(chunk.type==='usage')record({event:'usage',usage:chunk.usage});
      if(chunk.type==='finish')record({event:'finish',kind:chunk.reason.kind});
      if(chunk.type==='block-end'&&chunk.block.type==='tool-call')record({event:'tool-call',name:chunk.block.name});
      yield chunk;
    }
  });
}
