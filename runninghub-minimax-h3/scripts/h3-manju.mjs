import {readFile,rename,open,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
export function localBase(value='http://127.0.0.1:4317'){
 const u=new URL(value); if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Only a loopback Manju service is allowed');return u.origin;
}
export async function api(base,path,body){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||result.message||'Manju request failed');return result;
}
async function save(path,state){await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp';const h=await open(temp,'wx');try{await h.writeFile(JSON.stringify(state,null,2));await h.sync();}finally{await h.close();}await rename(temp,path);}
async function importReference(base,projectId,ref){
 const path=resolve(ref.path);const mime=ref.mimeType||({'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp','mp3':'audio/mpeg','wav':'audio/wav','ogg':'audio/ogg','mp4':'video/mp4','webm':'video/webm'}[path.split('.').at(-1).toLowerCase()]);
 if(!mime)throw Error('Unsupported reference file type: '+path);
 const bytes=await readFile(path);const form=new FormData();form.append('file',new Blob([bytes],{type:mime}),path.split(/[\\/]/).at(-1));
 const response=await fetch(base+'/api/projects/'+encodeURIComponent(projectId)+'/assets',{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
 const doc=await response.json();if(!response.ok)throw Error(doc.error||doc.message||'Reference import failed');
 const asset=doc.assets.at(-1);if(!asset)throw Error('Import returned no asset');
 return {assetId:asset.id,kind:ref.kind||mime.split('/')[0],role:ref.role||'reference'};
}
export async function run(args){
 const [action,...rest]=args;const flags={};for(let i=0;i<rest.length;i+=2){if(!rest[i].startsWith('--')||!rest[i+1])throw Error('Expected --name value');flags[rest[i].slice(2)]=rest[i+1];}
 if(!['prepare','generate','status','resume'].includes(action)||!flags.journal)throw Error('Usage: node h3.mjs prepare --manifest input.json --journal NEW.json [--base URL]; generate|status|resume --journal SAME.json');
 const path=resolve(flags.journal);
 if(action==='prepare'){
   if(!flags.manifest)throw Error('prepare requires --manifest');
   const manifest=JSON.parse(await readFile(resolve(flags.manifest),'utf8'));
   const base=localBase(flags.base);
   const health=await api(base,'/api/health');if(!health)throw Error('Manju service unavailable');
   await mkdir(dirname(path),{recursive:true});
   const h=await open(path,'wx');await h.close();
   const state={version:1,base,operationId:randomUUID(),phase:'preparing',projectId:manifest.projectId||null,input:{prompt:manifest.prompt??await readFile(resolve(manifest.promptFile),'utf8'),references:[],parameters:manifest.parameters||{}},imported:[]};
   await save(path,state);
   if(!state.projectId){const doc=await api(base,'/api/projects',{title:manifest.title||'MiniMax H3 独立生成',brief:'用户提示词与参考媒体直接生成',settings:{style:'',aspectRatio:['16:9','9:16','1:1','3:4'].includes(manifest.parameters?.aspectRatio)?manifest.parameters.aspectRatio:'16:9',videoAppId:'2084320751339032577',autoRun:false}});state.projectId=doc.project.id;await save(path,state);}
   for(const ref of manifest.references||[]){state.input.references.push(ref.assetId?{assetId:ref.assetId,kind:ref.kind,role:ref.role||'reference'}:await importReference(base,state.projectId,ref));state.imported.push(ref.path||ref.assetId);await save(path,state);}
   state.preview=await api(base,'/api/projects/'+state.projectId+'/h3/prepare',state.input);
   state.expectedRevision=(await api(base,'/api/projects/'+state.projectId)).project.revision;
   state.phase='prepared';await save(path,state);return {journal:path,projectId:state.projectId,...state.preview};
 }
 const state=JSON.parse(await readFile(path,'utf8'));const base=localBase(state.base);
 if(action==='generate'){
   if(!['prepared','submitting','submitted'].includes(state.phase))throw Error('Journal is not prepared');
   if(!state.jobId){
     state.phase='submitting';await save(path,state);
     const job=await api(base,'/api/projects/'+state.projectId+'/h3/generate',{input:state.input,operationId:state.operationId,expectedRevision:state.expectedRevision});
     state.jobId=job.id;state.phase='submitted';await save(path,state);
   }
 }
 if(!state.jobId){const jobs=await api(base,'/api/projects/'+state.projectId+'/jobs');const existing=jobs.find(j=>j.operationId==='h3:'+state.operationId);if(existing){state.jobId=existing.id;state.phase='submitted';await save(path,state);}else throw Error('No known job. generate replays the same local operation ID; resume never submits.');}
 const jobs=await api(base,'/api/projects/'+state.projectId+'/jobs');const job=jobs.find(j=>j.id===state.jobId);if(!job)throw Error('Job missing; do not submit again');
 const doc=await api(base,'/api/projects/'+state.projectId);const outputs=doc.assets.filter(a=>a.sourceJobId===job.id);
 return {journal:path,projectId:state.projectId,jobId:job.id,status:job.status,usage:job.usage??null,error:job.error??null,stale:job.result?.stale??false,outputs:outputs.map(a=>({path:a.path,mimeType:a.mimeType,status:a.status,metadata:a.metadata}))};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
 run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
