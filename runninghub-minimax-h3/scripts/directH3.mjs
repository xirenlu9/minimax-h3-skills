import {mkdir,open,realpath} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createKeyPool,PoolWait} from './keyPool.mjs';
import {atomicSave,locked,privateDirectory,readLimited,defaultDirectory} from './privateStore.mjs';
import {manifest,buildNodes} from './parameters.mjs';
import * as rh from './runninghubApi.mjs';

const hash=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
const terminal=['SUCCESS','FAILED','CANCELLED','CANCELED'];
export async function journalPath(directory,path){
  if(typeof path!=='string'||!isAbsolute(path))throw Error('journal 必须是绝对路径');
  const root=await privateDirectory(directory),target=resolve(path);
  const inside=(base,p)=>{const r=relative(base,p);return r!==''&&r!=='..'&&!r.startsWith('..'+String.fromCharCode(92))&&!r.startsWith('../')&&!isAbsolute(r);};
  // Windows TEMP/LOCALAPPDATA may use an 8.3 alias: compare both the provided and canonical root.
  if((!inside(root,target)&&!inside(resolve(directory??defaultDirectory()),target))||!target.endsWith('.json'))throw Error('journal 必须为私有数据目录内的 .json 文件');
  let nearest=dirname(target),actual;
  for(;;){try{actual=await realpath(nearest);break;}catch(e){if(e.code!=='ENOENT')throw e;const next=dirname(nearest);if(next===nearest)throw Error('journal 父目录不存在');nearest=next;}}
  if(actual!==root&&!inside(root,actual))throw Error('journal 父目录越界');
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const parent=await realpath(dirname(target)),r=relative(root,parent);
  if(r.startsWith('..')||isAbsolute(r))throw Error('journal 父目录越界');
  try{const actual=await realpath(target);if(actual!==join(parent,target.split(/[\\/]/).at(-1)))throw Error('journal 不能是符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}
  return {root,path:join(parent,target.split(/[\\/]/).at(-1))};
}
async function load(path,root){
  const s=JSON.parse((await readLimited(path,8*1024*1024)).toString('utf8'));
  if(s.version!==2||s.backend!=='runninghub'||s.appId!==rh.APP_ID||s.poolDirectory!==root||!s.operationId||!s.input||s.inputHash!==hash(s.input))throw Error('journal 不匹配或输入已被修改；不能自动重建任务');
  return s;
}
async function save(path,s){await atomicSave(path,Buffer.from(JSON.stringify(s,null,2)));}
function publicState(path,s){return {journal:path,operationId:s.operationId,appId:s.appId,phase:s.phase,keyId:s.keyId??null,taskId:s.taskId??null,status:s.status??null,parameters:s.input.parameters,minCredits:s.minCredits??null,usage:s.usage??null,outputs:s.outputs??[],notice:s.notice??null};}
async function reserveAndCheck(pool,s,allowReselect){
  let lease=await pool.getLease(s.operationId);
  if(lease.phase!=='reserved')throw Error('原操作已提交或结束；不能更换 Key');
  for(let tries=0;tries<5;tries++){
    const {apiKey,entryId}=await pool.credential(s.operationId),a=await rh.account(apiKey);
    await pool.updateEntry(entryId,{credits:a.remainCoins});
    if(a.currentTaskCounts>0){await pool.updateEntry(entryId,{cooldownSeconds:60});throw new PoolWait('account_busy');}
    if(a.remainCoins>=lease.minCredits){s.keyId=entryId;s.minCredits=lease.minCredits;return apiKey;}
    if(!allowReselect||s.fixedKeyId)throw new PoolWait('pool_exhausted');
    lease=await pool.replaceBeforeSubmission(s.operationId,a.remainCoins);
    if(!lease)throw new PoolWait('pool_exhausted');
  }
  throw new PoolWait('balance_checks_exhausted');
}
async function materialize(pool,path,s,apiKey,expectedFingerprint){
  const app=await rh.schema(apiKey);
  if(expectedFingerprint&&app.fingerprint!==expectedFingerprint)throw Error('应用 schema 已改变；停止，不沿用旧映射');
  buildNodes(app,s.input,[]);
  const uploaded=[];
  for(const ref of s.input.references){
    const bytes=await readLimited(ref.path,(ref.kind==='audio'?20:30)*1024*1024),contentHash=createHash('sha256').update(bytes).digest('hex');
    const original=s.mediaHashes?.find(x=>x.path===ref.path);
    if(original&&original.hash!==contentHash)throw Error('参考素材在准备后改变，停止自动重新调度');
    uploaded.push({...ref,fileName:await rh.upload(apiKey,ref,bytes),hash:contentHash});
  }
  s.mediaHashes=uploaded.map(r=>({path:r.path,hash:r.hash}));
  s.uploaded=uploaded;s.schemaFingerprint=app.fingerprint;s.nodes=buildNodes(app,s.input,uploaded);s.nodesHash=hash(s.nodes);s.phase='prepared';
  await save(path,s);
}
async function prepare(f){
  if(!f.manifest)throw Error('prepare 需要 --manifest');
  const input=await manifest(resolve(f.manifest)),loc=await journalPath(f.poolDirectory,f.journal),pool=await createKeyPool(loc.root);
  return locked(loc.path+'.lock',async()=>{
    let s;
    try{s=await load(loc.path,loc.root);}catch(e){
      if(e.code!=='ENOENT')throw e;
      const h=await open(loc.path,'wx',0o600);await h.close();
      s={version:2,backend:'runninghub',appId:rh.APP_ID,poolDirectory:loc.root,operationId:randomUUID(),phase:'waiting',input,inputHash:hash(input),fixedKeyId:f.keyId??null,usage:null,createdAt:new Date().toISOString()};await save(loc.path,s);
    }
    if(s.inputHash!==hash(input)||s.fixedKeyId!==(f.keyId??null))throw Error('不能用同一 journal 覆盖不同输入或 Key 选择');
    if(s.phase==='prepared')return publicState(loc.path,s);
    if(s.phase!=='waiting')throw Error('只能恢复尚未预约的 prepare；请查询或取消原操作');
    try {
      const l=await pool.reserve(s.operationId,input.minCredits,s.fixedKeyId??undefined);
      s.phase='preparing';s.keyId=l.entryId;await save(loc.path,s);
      const apiKey=await reserveAndCheck(pool,s,true);await materialize(pool,loc.path,s,apiKey);
      return publicState(loc.path,s);
    } catch(e) {
      let l;try{l=await pool.getLease(s.operationId);}catch{}
      const waiting=e instanceof PoolWait;
      if(l?.phase==='reserved'){if(waiting)await pool.releaseUnsubmitted(s.operationId);else await pool.complete(s.operationId,'cancelled');}
      s.phase=waiting||!l?'waiting':'failed';s.notice=waiting?e.code:'prepare_failed';await save(loc.path,s);throw e;
    }
  });
}
async function inspect(pool,path,s){
  let lease=await pool.getLease(s.operationId);
  if(!s.taskId&&lease.taskId){s.taskId=lease.taskId;s.phase='submitted';await save(path,s);}
  if(s.taskId&&['submitting','unknown'].includes(lease.phase)){await pool.attachTask(s.operationId,s.taskId);lease=await pool.getLease(s.operationId);}
  if(!s.taskId){s.phase=['submitting','unknown'].includes(lease.phase)?'unknown':lease.phase==='completed'?(lease.outcome==='cancelled'?'cancelled':'failed'):s.phase;s.notice=s.phase==='unknown'?'提交结果不明：不能重提或换 Key，需人工核对原账户任务':'';await save(path,s);return publicState(path,s);}
  if(s.taskId!==lease.taskId)throw Error('journal 与 Key 池任务绑定不一致');
  const {apiKey}=await pool.credential(s.operationId);
  s.status=await rh.taskStatus(apiKey,s.taskId);
  if(terminal.includes(s.status)){
    s.phase='completed';
    let balance;try{balance=(await rh.account(apiKey)).remainCoins;}catch{s.notice='任务已结束，但余额刷新失败；该 Key 暂时禁用，其他 Key 可继续处理新任务';}
    await pool.complete(s.operationId,s.status==='SUCCESS'?'succeeded':s.status==='FAILED'?'failed':'cancelled',balance);
    if(s.status==='SUCCESS'){
      try{s.outputs=await rh.outputs(apiKey,s.taskId);s.notice=balance===undefined?s.notice:null;}
      catch{s.notice='任务已成功但结果收集失败；用同一 journal 执行 resume，不能重新生成';}
    }
    s.usage=null;
  }else s.phase='submitted';
  await save(path,s);return publicState(path,s);
}
export async function runDirect(action,f){
  if(!f.journal)throw Error('需要 --journal（私有数据目录内绝对路径）');
  if(action==='prepare')return prepare(f);
  const loc=await journalPath(f.poolDirectory,f.journal),pool=await createKeyPool(loc.root);
  return locked(loc.path+'.lock',async()=>{
    const s=await load(loc.path,loc.root),lease=await pool.getLease(s.operationId);
    if(action==='cancel'){
      if(lease.phase!=='reserved')throw Error('cancel 只取消本地未提交预约，不取消远端任务或释放 unknown');
      await pool.complete(s.operationId,'cancelled');s.phase='cancelled';await save(loc.path,s);return publicState(loc.path,s);
    }
    if(action==='recover-task'){
      if(!['submitting','unknown'].includes(lease.phase)||!f.taskId||s.taskId)throw Error('仅允许为提交结果不明的原操作恢复人工确认的 taskId');
      const {apiKey}=await pool.credential(s.operationId);await rh.taskStatus(apiKey,f.taskId);
      s.taskId=f.taskId;s.phase='submitted';await save(loc.path,s);await pool.attachTask(s.operationId,f.taskId);
    }else if(action==='generate'&&lease.phase==='reserved'){
      if(f.confirm!=='submit')throw Error('生成会扣费：用户已授权本次生成后，传 --confirm submit；配置 Key 池不是生成授权');
      if(s.phase!=='prepared'||s.nodesHash!==hash(s.nodes))throw Error('任务未准备好或节点参数已修改');
      const originalKey=s.keyId,apiKey=await reserveAndCheck(pool,s,true),app=await rh.schema(apiKey);
      if(app.fingerprint!==s.schemaFingerprint)throw Error('实时 schema 已变，停止提交');
      if(s.keyId!==originalKey)await materialize(pool,loc.path,s,apiKey,s.schemaFingerprint);
      if(hash(buildNodes(app,s.input,s.uploaded))!==s.nodesHash)throw Error('已准备参数不匹配实时映射');
      if(f.shouldSubmit&&!f.shouldSubmit())return publicState(loc.path,s);
      await pool.beginSubmission(s.operationId);s.phase='submitting';await save(loc.path,s);
      if(f.shouldSubmit&&!f.shouldSubmit()){
        await pool.abortSubmissionBeforeRequest(s.operationId);s.phase='prepared';await save(loc.path,s);return publicState(loc.path,s);
      }
      try{
        s.taskId=await rh.submit(apiKey,s.nodes);s.phase='submitted';
        // Persist a returned task ID before touching the pool binding so recovery never loses it.
        await save(loc.path,s);await pool.attachTask(s.operationId,s.taskId);
      }catch(e){
        if(!s.taskId){await pool.markUnknown(s.operationId);s.phase='unknown';s.notice='提交未获得可持久化的 taskId；不会自动换 Key 重试';await save(loc.path,s);}
        throw e;
      }
    }else if(!['generate','status','resume','recover-task'].includes(action))throw Error('不支持的直接模式动作');
    return inspect(pool,loc.path,s);
  });
}
export async function probe(directory){
  const pool=await createKeyPool(directory),id='probe:'+randomUUID();await pool.reserve(id);
  try{
    const {apiKey}=await pool.credential(id),a=await rh.account(apiKey),app=await rh.schema(apiKey);
    return {appId:rh.APP_ID,balanceChecked:true,currentTaskCounts:a.currentTaskCounts,schemaFingerprint:app.fingerprint,fields:app.nodes.map(n=>n.nodeId+'.'+n.fieldName),billingTaskSubmitted:false};
  }finally{await pool.complete(id,'cancelled');}
}
