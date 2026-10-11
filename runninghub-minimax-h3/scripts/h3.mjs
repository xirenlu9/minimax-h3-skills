import {readFile,open,mkdir,rename} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {journalPath as privateJournal} from './directH3.mjs';

function localBase(value=`http://127.0.0.1:${process.env.RH_H3_PORT||'4317'}`){
  const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Only the local independent RunningHub H3 service is supported.');return url.origin;
}
function dataDirectory(){return resolve(process.env.RH_H3_HOME||join(homedir(),'.runninghub-h3-service'));}
async function token(){const value=(await readFile(join(dataDirectory(),'service.token'),'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(value))throw Error('Independent H3 service token is invalid; start the service first.');return value;}
async function request(base,path,body){
  let response;try{response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${await token()}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});}catch{throw Error('Independent H3 service is not reachable. Start it with node service/cli.mjs start.');}
  let result;try{result=await response.json();}catch{throw Error('Independent H3 service returned an unreadable response.');}
  if(!response.ok)throw Error(result.error||`Independent H3 service returned HTTP ${response.status}.`);return result;
}
async function save(path,state){await mkdir(dirname(path),{recursive:true});const temp=path+'.'+randomUUID()+'.tmp',handle=await open(temp,'wx');try{await handle.writeFile(JSON.stringify(state,null,2));await handle.sync();}finally{await handle.close();}await rename(temp,path);}
async function readPrompt(manifest,manifestPath){
  if(typeof manifest.prompt==='string')return manifest.prompt;
  if(typeof manifest.promptFile==='string')return readFile(resolve(dirname(manifestPath),manifest.promptFile),'utf8');
  throw Error('manifest needs prompt or promptFile.');
}
function parseFlags(args){const flags={};for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||!args[i+1])throw Error('Expected --name value.');flags[args[i].slice(2)]=args[i+1];}return flags;}
function publicResult(path,job,extra={}){return {journal:path,jobId:job.id,operationId:job.operationId,taskId:job.taskId??null,keyId:job.keyId??null,accountGroup:job.accountGroup??null,status:job.status,appId:job.appId,parameters:job.parameters,schemaFingerprint:job.schemaFingerprint,usage:job.usage??null,error:job.error??null,lastQueryError:job.lastQueryError??null,outputs:job.outputs??[],...extra};}

export async function run(args){
  const [action,...rest]=args,flags=parseFlags(rest);
  if(!['prepare','generate','status','resume','cancel'].includes(action)||!flags.journal)throw Error('Usage: prepare --manifest INPUT.json --journal PRIVATE.json; generate --journal SAME.json --confirm submit; status|resume|cancel --journal SAME.json');
  if(action==='generate'&&flags.confirm!=='submit')throw Error('Generation may incur charges. Explicit user authorization and --confirm submit are required.');
  const journalPath=(await privateJournal(dataDirectory(),flags.journal)).path,base=localBase(flags.base||process.env.RH_H3_BASE);
  if(action==='prepare'){
    if(!flags.manifest)throw Error('prepare requires --manifest.');
    const manifestPath=resolve(flags.manifest),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    if((typeof manifest.prompt==='string')===(typeof manifest.promptFile==='string'))throw Error('Provide exactly one of prompt and promptFile.');
    const input={prompt:await readPrompt(manifest,manifestPath),references:(manifest.references||[]).map(ref=>({path:resolve(dirname(manifestPath),ref.path),kind:ref.kind,role:ref.role||'reference'})),parameters:manifest.parameters||{},...(typeof manifest.keyId==='string'?{keyId:manifest.keyId}:{})};
    let state;try{state=JSON.parse(await readFile(journalPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Journal exists but is unreadable.');}
    if(state&&state.phase!=='preparing')throw Error('Journal already contains a prepared operation; choose a new journal for new input.');
    if(state&&!state.operationId)throw Error('Existing preparation journal has no operationId.');
    if(!state){await mkdir(dirname(journalPath),{recursive:true});const placeholder=await open(journalPath,'wx');await placeholder.close();state={version:1,base,operationId:randomUUID(),phase:'preparing',input};await save(journalPath,state);}
    else if(JSON.stringify(state.input)!==JSON.stringify(input))throw Error('This preparation journal belongs to different input.');
    const healthResponse=await fetch(base+'/api/health',{signal:AbortSignal.timeout(5000)});const health=await healthResponse.json();if(!healthResponse.ok||health.service!=='runninghub-minimax-h3-independent')throw Error('Independent H3 service health check did not match.');
    const result=await request(base,'/api/h3/prepare',{operationId:state.operationId,...input});
    state.jobId=result.job.id;state.phase='prepared';state.preview={appId:result.appId,parameters:result.parameters,schemaFingerprint:result.schemaFingerprint,references:result.references,notes:result.notes};await save(journalPath,state);
    return {journal:journalPath,jobId:state.jobId,operationId:state.operationId,keyId:result.job.keyId??null,accountGroup:result.job.accountGroup??null,status:result.job.status,...state.preview};
  }
  const state=JSON.parse(await readFile(journalPath,'utf8'));if(state.base!==base)throw Error('Journal service URL does not match this call; use the original --base.');if(!state.jobId)throw Error('Journal has no prepared service job.');
  if(action==='generate'){
    state.phase='queue_requested';await save(journalPath,state);
    const result=await request(base,`/api/jobs/${encodeURIComponent(state.jobId)}/submit`,{confirmation:'submit'});state.phase=result.job.status;await save(journalPath,state);return publicResult(journalPath,result.job);
  }
  if(action==='cancel'){const result=await request(base,`/api/jobs/${encodeURIComponent(state.jobId)}/cancel`,{});state.phase=result.job.status;await save(journalPath,state);return publicResult(journalPath,result.job);}
  const result=await request(base,`/api/jobs/${encodeURIComponent(state.jobId)}`);state.phase=result.job.status;await save(journalPath,state);return publicResult(journalPath,result.job);
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  run(process.argv.slice(2)).then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write((error instanceof Error?error.message:'H3 command failed.')+'\n');process.exitCode=1;});
}
