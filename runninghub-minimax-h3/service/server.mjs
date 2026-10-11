import {createServer} from 'node:http';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomUUID,createHash} from 'node:crypto';
import {basename} from 'node:path';
import {createStateStore,readServiceToken,encryptSecret,decryptSecret,fingerprint} from './lib/store.mjs';
import * as rh from './lib/runninghub.mjs';

const ACTIVE=new Set(['uploading','submitting','submission_unknown','submitted','remote_queued','running']);
const POLL=new Set(['submitted','remote_queued','running']);
const FINAL=new Set(['succeeded','failed','cancelled']);
const now=()=>new Date().toISOString();
const cleanKey=({secret,...safe})=>safe;
const emptyUsage=()=>({rhCoins:null,walletAmount:null,thirdPartyAmount:null,currency:null});
const cleanJob=j=>({id:j.id,operationId:j.operationId,status:j.status,taskId:j.taskId??null,keyId:j.keyId??null,accountGroup:j.accountGroup??null,resolution:j.resolution??null,appId:rh.APP_ID,parameters:j.input?.parameters??null,schemaFingerprint:j.preview?.schemaFingerprint??null,outputs:j.outputs??[],usage:j.usage??emptyUsage(),error:j.error??null,lastQueryError:j.lastQueryError??null,waitReason:j.waitReason??null,createdAt:j.createdAt,updatedAt:j.updatedAt});
const validUuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const taskId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v);
const groupId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function json(res,status,payload){const bytes=Buffer.from(JSON.stringify(payload));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);}
function failure(message,status=400){return Object.assign(Error(message),{status});}
async function bodyJson(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>24*1024*1024)throw failure('Request body is too large.');chunks.push(chunk);}try{return size?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw failure('Request body must be valid JSON.');}}
function pause(state,reason){state.executor={paused:true,reason,updatedAt:now()};}
const normalize=status=>status==='queued'?'remote_queued':status;
function settingsValid(s){return Number.isInteger(s.maxConcurrent)&&s.maxConcurrent>=1&&s.maxConcurrent<=4&&typeof s.minCredits==='number'&&Number.isFinite(s.minCredits)&&s.minCredits>0&&s.minCredits<=1e12;}

// Dependency injection is only used by isolated tests; CLI always uses the fixed provider.
export async function startServer({unlocked,port=4317,releaseLock=async()=>{},provider=rh,tickIntervalMs=5000}){
  const {dir,key}=unlocked,store=await createStateStore(unlocked),token=await readServiceToken(dir);
  let submitting=false,polling=false,closing=false,storageBlocked=false,stopRequested=false,stopEpoch=0;
  const requestStop=()=>{stopRequested=true;stopEpoch++;};
  const pending=new Set();
  await store.transact(state=>{
    state.settings??={maxConcurrent:3,minCredits:1};if(!settingsValid(state.settings))throw Error('Invalid scheduler settings; preserve state for repair.');
    state.executor??={paused:false,reason:null};
    if(state.migration&&state.migration.phase!=='completed')pause(state,'migration_incomplete');
    for(const j of state.jobs){
      if(j.status==='queued'&&j.taskId)j.status='remote_queued';
      if(j.status==='submitting'){j.status='submission_unknown';j.error='Restarted during submission; check the original RunningHub account.';}
      if(j.status==='uploading')j.status=j.taskId?'remote_queued':'queued';
      if(j.status==='submission_unknown')pause(state,'submission_unknown');
    }
  });
  stopRequested=store.snapshot().executor.paused;
  async function applyAccount(keyId,d){return store.transact(state=>{
    const e=state.keys.find(item=>item.keyId===keyId);if(!e)throw Error('Key no longer exists.');
    e.consumerStatus=d.apiType==='NORMAL'?'consumer':'ineligible';e.checkedAt=d.checkedAt??now();
    e.accountStatus={remainCoins:d.remainCoins,remainMoney:d.remainMoney,currency:d.currency,currentTaskCount:d.currentTaskCount};
    if(e.consumerStatus!=='consumer')e.enabled=false;return cleanKey(e);
  });}
  async function defer(jobId,reason){await store.transact(state=>{const j=state.jobs.find(item=>item.id===jobId);if(j?.status!=='uploading'||j.taskId)return;j.status='queued';j.waitReason=reason;j.updatedAt=now();if(!j.requestedKeyId){j.keyId=null;j.accountGroup=null;}});}
  async function checkAccount(job,entry,apiKey){
    const d=await provider.verifyConsumerKey(apiKey);await applyAccount(entry.keyId,d);
    if(d.apiType!=='NORMAL')throw Error('Consumer account verification failed.');
    if(typeof d.remainCoins!=='number'||!Number.isFinite(d.remainCoins)||d.remainCoins<0)throw Error('Live balance is unknown.');
    if(d.remainCoins<store.snapshot().settings.minCredits){await defer(job.id,'balance_insufficient');return false;}
    if(typeof d.currentTaskCount!=='number'||!Number.isFinite(d.currentTaskCount)||d.currentTaskCount<0)throw Error('Remote account concurrency is unknown.');
    if(d.currentTaskCount>=1){await store.transact(state=>{state.keys.find(item=>item.keyId===entry.keyId).availableAfter=Date.now()+30000;});await defer(job.id,'account_busy');return false;}return true;
  }
  function maySend(jobId,keyId){const s=store.snapshot(),j=s.jobs.find(j=>j.id===jobId),e=s.keys.find(e=>e.keyId===keyId);return !closing&&!storageBlocked&&!stopRequested&&!s.executor.paused&&j?.status==='submitting'&&!j.taskId&&e?.enabled&&e.consumerStatus==='consumer';}
  async function executeQueued(){
    const snapshot=store.snapshot();if(closing||storageBlocked||stopRequested||snapshot.executor.paused||(snapshot.migration&&snapshot.migration.phase!=='completed'))return;
    const active=snapshot.jobs.filter(j=>ACTIVE.has(j.status));if(active.length>=snapshot.settings.maxConcurrent)return;
    const occupied=new Set(active.map(j=>j.accountGroup));let job,entry;
    for(const candidate of snapshot.jobs.filter(j=>j.status==='queued'&&!j.taskId)){
      const eligible=snapshot.keys.filter(e=>(!candidate.requestedKeyId||e.keyId===candidate.requestedKeyId)&&e.enabled&&e.consumerStatus==='consumer'&&!occupied.has(e.accountGroup)&&(e.availableAfter??0)<=Date.now()&&typeof e.accountStatus?.remainCoins==='number'&&e.accountStatus.remainCoins>=snapshot.settings.minCredits);
      entry=eligible.sort((a,b)=>(a.lastUsedAt??0)-(b.lastUsedAt??0))[0];if(entry){job=candidate;break;}
    }
    if(!job)return;
    const claimed=await store.transact(state=>{const j=state.jobs.find(item=>item.id===job.id),e=state.keys.find(item=>item.keyId===entry.keyId);if(state.executor.paused||j?.status!=='queued'||j.taskId||!e?.enabled)return false;j.keyId=e.keyId;j.accountGroup=e.accountGroup;j.status='uploading';j.error=null;j.waitReason=null;j.updatedAt=now();e.lastUsedAt=Date.now();return true;});if(!claimed)return;
    try{
      const apiKey=decryptSecret(key,entry.secret);if(!await checkAccount(job,entry,apiKey))return;
      const uploaded={images:[],audios:[],video:null};
      for(const ref of job.input.references){if(closing||store.snapshot().executor.paused){await defer(job.id,'executor_paused');return;}const name=await provider.uploadReference(apiKey,ref);if(ref.kind==='image')uploaded.images.push(name);else if(ref.kind==='audio')uploaded.audios.push(name);else uploaded.video=name;}
      const schema=await provider.inspectH3Schema();if(schema.fingerprint!==job.preview.schemaFingerprint)throw Object.assign(Error('Schema changed; prepare a new operation.'),{permanent:true});
      const nodes=provider.buildNodeInfo(schema,job.input,uploaded);if(!await checkAccount(job,entry,apiKey))return;
      const intent=await store.transact(state=>{const j=state.jobs.find(item=>item.id===job.id),e=state.keys.find(item=>item.keyId===entry.keyId);if(closing||state.executor.paused||j?.status!=='uploading'||j.taskId||!e?.enabled)return false;j.status='submitting';j.submitIntentAt=now();j.updatedAt=now();j.nodeInfoDigest=createHash('sha256').update(JSON.stringify(nodes)).digest('hex');return true;});
      if(!intent){await defer(job.id,'executor_paused');return;}
      // No await between this final stop gate and provider request initiation.
      if(!maySend(job.id,entry.keyId)){await store.transact(state=>{const j=state.jobs.find(item=>item.id===job.id);if(j?.status==='submitting'&&!j.taskId){j.status='queued';j.waitReason='executor_paused';delete j.submitIntentAt;}});return;}
      const result=await provider.submitH3(apiKey,nodes);
      if(result.status!=='submitted'||!taskId(result.taskId))requestStop();
      await store.transact(state=>{const j=state.jobs.find(item=>item.id===job.id);if(j?.status!=='submitting')return;
        if(result.status==='submitted'&&taskId(result.taskId)){j.status='submitted';j.taskId=result.taskId;j.acceptedAt=now();j.error=null;j.usage=result.usage??emptyUsage();}
        else if(result.status==='failed'){j.status='failed';j.error='RunningHub rejected this submission. No automatic retry.';pause(state,'submission_rejected');}
        else{j.status='submission_unknown';j.error='Acceptance is unknown. Check the original account; do not resubmit.';pause(state,'submission_unknown');}j.updatedAt=now();});
    }catch(error){requestStop();await store.transact(state=>{const j=state.jobs.find(item=>item.id===job.id);pause(state,j?.status==='submitting'?'submission_unknown':'preflight_failed');if(!j)return;if(j.status==='submitting'){j.status='submission_unknown';j.error='Acceptance is unknown; do not resubmit.';}else if(j.status==='uploading'){j.status=error.permanent||error.code==='ENOENT'?'failed':'queued';j.error='Provider preflight failed. Check balance, credentials, schema and files before resuming.';}j.updatedAt=now();});}
  }
  async function pollActive(){const snapshot=store.snapshot();await Promise.all(snapshot.jobs.filter(j=>POLL.has(j.status)&&j.taskId&&j.keyId).map(async job=>{
    const entry=snapshot.keys.find(e=>e.keyId===job.keyId);if(!entry)return;
    try{
      const result=await provider.queryTask(decryptSecret(key,entry.secret),job.taskId),status=normalize(result.status);if(!POLL.has(status)&&!FINAL.has(status))throw Error('Unknown provider status.');
      if(status==='failed')requestStop();
      await store.transact(state=>{const j=state.jobs.find(item=>item.id===job.id);if(!POLL.has(j?.status)||j.taskId!==job.taskId)return;j.status=status;j.outputs=result.outputs??j.outputs??[];j.usage=result.usage??j.usage??emptyUsage();j.error=status==='failed'?'RunningHub task failed. No automatic retry.':null;j.lastQueryError=null;j.updatedAt=now();if(status==='failed')pause(state,'remote_task_failed');});
      if(FINAL.has(status)){try{await applyAccount(entry.keyId,await provider.verifyConsumerKey(decryptSecret(key,entry.secret)));}catch{requestStop();await store.transact(state=>{const e=state.keys.find(item=>item.keyId===entry.keyId);if(e)e.enabled=false;pause(state,'balance_refresh_failed');});}}
    }catch{requestStop();await store.transact(state=>{pause(state,'task_query_failed');const j=state.jobs.find(item=>item.id===job.id);if(POLL.has(j?.status)){j.lastQueryError='Remote state was not confirmed; querying the original task only.';j.updatedAt=now();}});}
  }));}
  function track(p){pending.add(p);p.finally(()=>pending.delete(p));return p;}
  async function tick(){if(closing||storageBlocked)return;const work=[];if(!polling){polling=true;work.push(track(pollActive().catch(()=>{storageBlocked=true;}).finally(()=>{polling=false;})));}if(!submitting){submitting=true;work.push(track(executeQueued().catch(()=>{storageBlocked=true;}).finally(()=>{submitting=false;})));}await Promise.all(work);}
  async function probeKey(keyId){
    const e=store.snapshot().keys.find(e=>e.keyId===keyId);if(!e)throw failure('Key was not found.',404);
    try{const verified=await applyAccount(keyId,await provider.verifyConsumerKey(decryptSecret(key,e.secret)));if(verified.consumerStatus!=='consumer'||typeof verified.accountStatus.remainCoins!=='number'||typeof verified.accountStatus.currentTaskCount!=='number')throw Error('Account details were not verified.');
      return store.transact(state=>{const target=state.keys.find(e=>e.keyId===keyId);if(target.enableAfterProbe){target.enabled=true;target.enableAfterProbe=false;}return {key:cleanKey(target)};});
    }catch{requestStop();await store.transact(state=>{pause(state,'key_probe_failed');const target=state.keys.find(e=>e.keyId===keyId);if(target){target.enableAfterProbe=target.enableAfterProbe||target.enabled;target.enabled=false;}});throw failure('Account verification failed. Executor paused; no new submissions.',409);}
  }
  const server=createServer(async(req,res)=>{
    if(req.headers.host!==`127.0.0.1:${port}`){json(res,403,{error:'Loopback host required.'});return;}
    const url=new URL(req.url??'/',`http://127.0.0.1:${port}`),method=req.method??'GET';
    if(method==='GET'&&url.pathname==='/api/health'){const s=store.snapshot();json(res,200,{ok:!storageBlocked,service:'runninghub-minimax-h3-independent',executor:storageBlocked?'blocked':stopRequested||s.executor.paused?'paused':'online',settings:s.settings,activeTasks:s.jobs.filter(j=>ACTIVE.has(j.status)).length});return;}
    if(req.headers.authorization!==`Bearer ${token}`){json(res,401,{error:'Local service token is missing or invalid.'});return;}
    try{
      if(method==='GET'&&url.pathname==='/api/keys'){json(res,200,{keys:store.snapshot().keys.map(cleanKey)});return;}
      if(method==='POST'&&url.pathname==='/api/keys'){const body=await bodyJson(req),apiKey=typeof body.apiKey==='string'?body.apiKey.trim():'';if(!/^[a-fA-F0-9]{32}$/.test(apiKey)||!groupId(body.accountGroup))throw failure('A consumer Key and valid account group are required.');const result=await store.transact(state=>{const digest=fingerprint(apiKey),prior=state.keys.find(e=>e.fingerprint===digest);if(prior){if(prior.accountGroup!==body.accountGroup)throw failure('Key is already bound to another account group.',409);return cleanKey(prior);}if(state.keys.length>=100)throw failure('100-Key limit reached.');const e={keyId:`rhkey_${randomUUID()}`,accountGroup:body.accountGroup,fingerprint:digest,enabled:false,capacity:1,consumerStatus:'unverified',createdAt:now(),secret:encryptSecret(key,apiKey)};state.keys.push(e);return cleanKey(e);});json(res,200,{key:result});return;}
      let match=url.pathname.match(/^\/api\/keys\/([^/]+)(?:\/(probe))?$/);
      if(match){const id=decodeURIComponent(match[1]);if(method==='POST'&&match[2]){json(res,200,await probeKey(id));return;}if(method==='PATCH'&&!match[2]){const body=await bodyJson(req);if(typeof body.enabled!=='boolean'||Object.keys(body).some(k=>k!=='enabled'))throw failure('Only enabled may be changed.');const result=await store.transact(state=>{const e=state.keys.find(item=>item.keyId===id);if(!e)throw failure('Key was not found.',404);if(body.enabled&&e.consumerStatus!=='consumer')throw failure('Probe this consumer Key first.',409);e.enabled=body.enabled;e.enableAfterProbe=false;return cleanKey(e);});json(res,200,{key:result});return;}}
      if(method==='GET'&&url.pathname==='/api/executor'){const s=store.snapshot();json(res,200,{...s.executor,paused:stopRequested||s.executor.paused,storageBlocked,settings:s.settings});return;}
      if(method==='POST'&&['/api/executor/pause','/api/executor/resume'].includes(url.pathname)){
        if(url.pathname.endsWith('/resume')){const epoch=stopEpoch;await store.transact(state=>{if(storageBlocked||(state.migration&&state.migration.phase!=='completed')||state.jobs.some(j=>j.status==='submission_unknown'))throw failure('Resolve unknown submissions, complete migration or repair storage before resuming.',409);state.executor={paused:false,reason:null,updatedAt:now()};});if(stopEpoch===epoch)stopRequested=false;}
        else{requestStop();await store.transact(state=>pause(state,'operator_paused'));}json(res,200,{...store.snapshot().executor,paused:stopRequested||store.snapshot().executor.paused});return;
      }
      if(method==='PATCH'&&url.pathname==='/api/settings'){const body=await bodyJson(req);if(Object.keys(body).some(k=>!['maxConcurrent','minCredits'].includes(k)))throw failure('Unsupported scheduler setting.');const result=await store.transact(state=>{const next={...state.settings,...body};if(!settingsValid(next)||next.maxConcurrent<state.jobs.filter(j=>ACTIVE.has(j.status)).length)throw failure('Invalid setting or active tasks exceed the new cap.');state.settings=next;return next;});json(res,200,result);return;}
      if(method==='POST'&&url.pathname==='/api/h3/prepare'){
        const body=await bodyJson(req);if(!validUuid(body.operationId))throw failure('Reuse a valid operation UUID.');const requestedKeyId=body.keyId??null,requested=store.snapshot().keys.find(e=>e.keyId===requestedKeyId);if(requestedKeyId&&(!requested?.enabled||requested.consumerStatus!=='consumer'))throw failure('Requested Key must be verified and enabled.',409);
        const input=provider.validateH3Input({prompt:body.prompt,parameters:body.parameters,_validatedReferences:await provider.validateReferences(body.references??[])}),prior=store.snapshot().jobs.find(j=>j.operationId===body.operationId);if(prior){if(!same(prior.input,input)||prior.requestedKeyId!==requestedKeyId)throw failure('Operation belongs to different input or Key.',409);json(res,200,{job:cleanJob(prior),...prior.preview});return;}
        const schema=await provider.inspectH3Schema();provider.buildNodeInfo(schema,input,{images:[],audios:[],video:null});const preview={appId:rh.APP_ID,parameters:input.parameters,schemaFingerprint:schema.fingerprint,references:input.references.map(ref=>({kind:ref.kind,path:basename(ref.path),role:ref.role})),notes:['通用图片槽不保证精确首尾帧锁定。','最低积分是调度阈值，不是单条视频费用估算；未知费用保持 null。']};
        const result=await store.transact(state=>{const old=state.jobs.find(j=>j.operationId===body.operationId);if(old){if(!same(old.input,input)||old.requestedKeyId!==requestedKeyId)throw failure('Operation belongs to different input.',409);return {job:cleanJob(old),...old.preview};}const j={id:randomUUID(),operationId:body.operationId,status:'prepared',input,requestedKeyId,keyId:requested?.keyId??null,accountGroup:requested?.accountGroup??null,preview,outputs:[],usage:emptyUsage(),createdAt:now(),updatedAt:now()};state.jobs.push(j);return {job:cleanJob(j),...preview};});json(res,200,result);return;
      }
      if(method==='GET'&&url.pathname==='/api/jobs'){json(res,200,{jobs:store.snapshot().jobs.map(cleanJob)});return;}
      match=url.pathname.match(/^\/api\/jobs\/([^/]+)\/output\/(\d+)$/);
      if(method==='GET'&&match){
        const jobId=decodeURIComponent(match[1]),index=Number(match[2]),job=store.snapshot().jobs.find(item=>item.id===jobId);
        if(!job)throw failure('Job was not found.',404);
        if(job.status!=='succeeded'||!job.taskId||!job.keyId||index>=(job.outputs??[]).length)throw failure('Completed output is not available.',409);
        const entry=store.snapshot().keys.find(item=>item.keyId===job.keyId);if(!entry)throw failure('Original account is not available.',409);
        const output=await provider.downloadTaskOutput(decryptSecret(key,entry.secret),job.taskId,index);
        const declared=Number(output.headers.get('content-length'));if(Number.isFinite(declared)&&declared>100*1024*1024)throw failure('Video output exceeds 100 MB.',413);
        if(!output.body)throw failure('RunningHub returned an empty output.',502);
        let bytes=0;const limit=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>100*1024*1024){callback(failure('Video output exceeds 100 MB.',413));return;}callback(null,chunk);}});
        const mimeType=output.headers.get('content-type')?.split(';')[0]||'video/mp4';
        res.writeHead(200,{'Content-Type':mimeType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        await pipeline(Readable.fromWeb(output.body),limit,res);return;
      }
      match=url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(submit|cancel|attach-task|resolve-not-accepted))?$/);
      if(match){const id=decodeURIComponent(match[1]),action=match[2];if(method==='GET'&&!action){const j=store.snapshot().jobs.find(item=>item.id===id);if(!j)throw failure('Job was not found.',404);json(res,200,{job:cleanJob(j)});return;}
        if(method==='POST'&&action){const body=await bodyJson(req);
          if(action==='attach-task'){const s=store.snapshot(),j=s.jobs.find(item=>item.id===id),e=s.keys.find(item=>item.keyId===j?.keyId);if(j?.status!=='submission_unknown'||!e||!taskId(body.taskId))throw failure('Only an unknown submission can attach a valid task.',409);const result=await provider.queryTask(decryptSecret(key,e.secret),body.taskId),status=normalize(result.status);if(!POLL.has(status)&&!FINAL.has(status))throw failure('Original account task was not confirmed.',409);await store.transact(state=>{const j=state.jobs.find(item=>item.id===id);if(j?.status!=='submission_unknown'||state.jobs.some(other=>other.id!==id&&other.taskId===body.taskId))throw failure('Task binding conflicts with ledger.',409);j.taskId=body.taskId;j.status=status;j.outputs=result.outputs??[];j.usage=result.usage??emptyUsage();j.error=null;j.updatedAt=now();});}
          else await store.transact(state=>{const j=state.jobs.find(item=>item.id===id);if(!j)throw failure('Job was not found.',404);
            if(action==='submit'){if(body.confirmation!=='submit')throw failure('Explicit generation confirmation is required.');if(j.status==='prepared'){j.status='queued';j.error=null;}}
            if(action==='cancel'){if(j.taskId||!['prepared','queued','uploading'].includes(j.status))throw failure('Only never-submitted local work can be cancelled.',409);j.status='cancelled';j.error=null;}
            if(action==='resolve-not-accepted'){if(j.status!=='submission_unknown'||body.confirmation!=='I checked RunningHub and found no task for this submission.')throw failure('Verify the original account and provide the exact confirmation.',409);j.status='failed';j.resolution='operator_confirmed_not_accepted';j.error='Operator confirmed no task exists. This operation will not be resubmitted.';}j.updatedAt=now();});json(res,200,{job:cleanJob(store.snapshot().jobs.find(j=>j.id===id))});return;}
      }
      throw failure('Route was not found.',404);
    }catch(error){if(res.headersSent){res.destroy();return;}json(res,error.status??400,{error:error.message??'Request failed.'});}
  });
  try{await new Promise((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',bad);ok();});});}catch(error){await releaseLock();throw error;}
  const timer=setInterval(()=>void tick(),tickIntervalMs);timer.unref();void tick();
  const onSignal=()=>void close().then(()=>process.exit(0));
  const close=async()=>{if(closing)return;closing=true;clearInterval(timer);process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);await Promise.allSettled([...pending]);await new Promise(ok=>server.close(ok));await releaseLock();};
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  console.log(`Independent RunningHub H3 service listening at http://127.0.0.1:${port}`);
  return {server,store,token,close,tick};
}
