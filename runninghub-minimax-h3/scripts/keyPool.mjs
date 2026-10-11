import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateDirectory,atomicSave,locked,readLimited} from './privateStore.mjs';

const keyPattern=/^[a-zA-Z0-9_-]{16,256}$/;
const opPattern=/^[a-zA-Z0-9_.:-]{1,128}$/;
const idPattern=/^rh[a-f0-9]{24}$/;
const phases=['reserved','submitting','submitted','unknown','completed'];
const limit=16*1024*1024;
export class PoolWait extends Error {constructor(code){super(code);this.code=code;}}
function credit(n){if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1e12)throw Error('积分格式无效');return n;}
function timestamp(n){if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>Number.MAX_SAFE_INTEGER)throw Error('时间格式无效');}
function operationId(s){if(typeof s!=='string'||!opPattern.test(s))throw Error('操作 ID 格式无效');}
function taskId(s){if(typeof s!=='string'||!/^\d{1,40}$/.test(s))throw Error('RunningHub taskId 格式无效');}
function checkState(s) {
  if(s?.version!==1||!Array.isArray(s.entries)||!Array.isArray(s.leases))throw Error('invalid');
  s.settings??={maxConcurrent:3,minCredits:1};
  if(!Number.isInteger(s.settings.maxConcurrent)||s.settings.maxConcurrent<1||s.settings.maxConcurrent>100)throw Error('invalid');
  credit(s.settings.minCredits);
  for(const e of s.entries) {
    if(!idPattern.test(e.id)||!keyPattern.test(e.apiKey)||typeof e.enabled!=='boolean'||!['imported','updated'].includes(e.creditsSource)||typeof e.creditsUpdatedAt!=='string')throw Error('invalid');
    credit(e.credits);timestamp(e.cooldownUntil);timestamp(e.lastUsedAt);
    if(e.id!=='rh'+createHash('sha256').update(e.apiKey).digest('hex').slice(0,24))throw Error('invalid');
  }
  for(const l of s.leases){operationId(l.operationId);credit(l.minCredits);if(!phases.includes(l.phase)||typeof l.createdAt!=='string'||!s.entries.some(e=>e.id===l.entryId))throw Error('invalid');if(l.taskId!==undefined)taskId(l.taskId);}
  if(new Set(s.entries.map(e=>e.id)).size!==s.entries.length||new Set(s.leases.map(l=>l.operationId)).size!==s.leases.length)throw Error('invalid');
  const active=s.leases.filter(l=>l.phase!=='completed');
  if(new Set(active.map(l=>l.entryId)).size!==active.length)throw Error('invalid');
  return s;
}
async function protect(bytes,decrypt=false) {
  if(process.platform!=='win32'||!process.env.SystemRoot)throw Error('当前 Key 池仅支持 Windows 当前用户 DPAPI；不支持跨用户/机器复制密文');
  const command=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; try { $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('runninghub-minimax-h3.keyPool.v1'); $result=[Security.Cryptography.ProtectedData]::${decrypt?'Unprotect':'Protect'}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result)) } catch { exit 1 }`;
  return new Promise((ok,fail)=>{
    const p=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    let size=0;const chunks=[];
    const timer=setTimeout(()=>p.kill(),15000);
    p.stdout.on('data',c=>{size+=c.length;if(size>24*1024*1024)p.kill();else chunks.push(c);});
    p.stdin.on('error',()=>{});
    p.once('error',()=>{clearTimeout(timer);fail(Error('无法启动 Windows 凭据保护服务'));});
    p.once('close',code=>{
      clearTimeout(timer);
      if(code!==0||size>24*1024*1024)return fail(Error('凭据保护失败；请使用原 Windows 用户与机器'));
      const b64=Buffer.concat(chunks).toString('ascii').trim();
      if(!/^[a-zA-Z0-9+/]+={0,2}$/.test(b64))return fail(Error('凭据保护服务返回无效结果'));
      ok(Buffer.from(b64,'base64'));
    });
    // Never put credentials in command arguments, environment, logs or plaintext temporary files.
    p.stdin.end(bytes.toString('base64'));
  });
}
export async function createKeyPool(directory) {
  const root=await privateDirectory(directory),path=join(root,'runninghubPool.bin');
  async function load(){
    let encrypted;
    try{encrypted=await readLimited(path,limit);}catch(e){if(e.code==='ENOENT')return {version:1,settings:{maxConcurrent:3,minCredits:1},entries:[],leases:[]};throw e;}
    const plain=await protect(encrypted,true);
    try{return checkState(JSON.parse(plain.toString('utf8')));}catch{throw Error('Key 池数据无效；不会输出或覆盖原凭据');}finally{plain.fill(0);}
  }
  async function update(fn){return locked(join(root,'runninghubPool.lock'),async()=>{
    const s=await load(),result=fn(s),plain=Buffer.from(JSON.stringify(checkState(s)));
    try{const enc=await protect(plain);if(enc.length>limit)throw Error('Key 池超过容量限制');await atomicSave(path,enc);}finally{plain.fill(0);}
    return result;
  });}
  function lease(s,id){operationId(id);const l=s.leases.find(l=>l.operationId===id);if(!l)throw Error('原操作不存在；不能自动新建替代任务');return l;}
  return {
    root,path,
    async importText(text){
      if(Buffer.byteLength(text)>1024*1024)throw Error('导入文件不能超过 1MB');
      const keys=new Map();let duplicateRows=0;
      const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
      for(let i=0;i<lines.length;i++){
        if(!lines[i].trim())continue;
        const f=lines[i].split('----').map(x=>x.trim());
        if(f.length!==5||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f[0])||!/^\d+(\.\d+)?$/.test(f[2])||!keyPattern.test(f[3]))throw Error(`第 ${i+1} 行不符合五字段格式`);
        credit(Number(f[2]));if(keys.has(f[3]))duplicateRows++;else keys.set(f[3],Number(f[2]));
      }
      if(!keys.size)throw Error('没有可导入的 Key');
      return update(s=>{let added=0,existing=0;for(const [apiKey,credits] of keys){
        const id='rh'+createHash('sha256').update(apiKey).digest('hex').slice(0,24),old=s.entries.find(e=>e.id===id);
        if(old){if(old.apiKey!==apiKey)throw Error('Key 标识冲突');existing++;continue;}
        s.entries.push({id,apiKey,credits,creditsSource:'imported',creditsUpdatedAt:new Date().toISOString(),enabled:true,cooldownUntil:0,lastUsedAt:0});added++;
      }return {added,existing,duplicateRows,total:s.entries.length};});
    },
    async list(){const s=await load(),active=s.leases.filter(l=>l.phase!=='completed');return {total:s.entries.length,settings:{...s.settings},activeOperations:active.length,entries:s.entries.map(({apiKey,...e})=>({...e,busy:active.some(l=>l.entryId===e.id),coolingDown:e.cooldownUntil>Date.now()})),operations:s.leases.map(l=>({...l}))};},
    async configure(patch){
      if(Object.keys(patch).some(k=>!['maxConcurrent','minCredits'].includes(k)))throw Error('配置参数无效');
      if(patch.maxConcurrent!==undefined&&(!Number.isInteger(patch.maxConcurrent)||patch.maxConcurrent<1||patch.maxConcurrent>100))throw Error('并发范围为 1–100；仍受平台权限限制');
      if(patch.minCredits!==undefined){credit(patch.minCredits);if(patch.minCredits<=0)throw Error('最低积分必须大于零');}
      return update(s=>{if(patch.maxConcurrent!==undefined&&patch.maxConcurrent<s.leases.filter(l=>l.phase!=='completed').length)throw Error('不能把并发调低到已有预约/任务数以下；先等待或取消未提交预约');Object.assign(s.settings,patch);return {...s.settings};});
    },
    async reserve(id,minCredits,keyId){operationId(id);if(minCredits!==undefined)credit(minCredits);if(keyId!==undefined&&!idPattern.test(keyId))throw Error('Key ID 无效');return update(s=>{
      minCredits=Math.max(minCredits??s.settings.minCredits,s.settings.minCredits);
      const old=s.leases.find(l=>l.operationId===id);if(old){if(old.phase==='completed')throw Error('原操作已结束，不允许重放');return {...old};}
      if(s.migration)throw Error('Key 池已迁移到新版独立服务；旧入口只用于查询历史任务，不能再预约生成');
      const active=s.leases.filter(l=>l.phase!=='completed'),busy=new Set(active.map(l=>l.entryId));
      if(active.length>=s.settings.maxConcurrent)throw new PoolWait('pool_busy');
      const eligible=s.entries.filter(e=>(!keyId||e.id===keyId)&&e.enabled&&e.credits>0&&e.credits>=minCredits&&e.cooldownUntil<=Date.now());
      const e=eligible.filter(e=>!busy.has(e.id)).sort((a,b)=>a.lastUsedAt-b.lastUsedAt)[0];
      if(!e)throw new PoolWait(eligible.length?'pool_busy':'pool_exhausted');
      e.lastUsedAt=Math.max(Date.now(),...s.entries.map(e=>e.lastUsedAt))+1;
      const l={operationId:id,entryId:e.id,minCredits,phase:'reserved',createdAt:new Date().toISOString()};s.leases.push(l);return {...l};
    });},
    async getLease(id){return {...lease(await load(),id)};},
    // Internal script-only interface. NEVER log or serialize its result to the model.
    async credential(id){const s=await load(),l=lease(s,id);return {apiKey:s.entries.find(e=>e.id===l.entryId).apiKey,entryId:l.entryId};},
    async beginSubmission(id){return update(s=>{
      const l=lease(s,id),e=s.entries.find(e=>e.id===l.entryId);
      if(l.phase!=='reserved')throw Error('原操作已进入提交阶段；只能查询，不能再次提交');
      if(!e.enabled||e.cooldownUntil>Date.now()||e.credits<=0||e.credits<l.minCredits)throw Error('原预约 Key 不可用；不会自动换 Key');
      l.phase='submitting';return {...l};
    });},
    // Internal only: call solely when no provider request has been initiated.
    async abortSubmissionBeforeRequest(id){return update(s=>{const l=lease(s,id);if(l.phase!=='submitting'||l.taskId)throw Error('不能回滚已发出或未知的请求');l.phase='reserved';});},
    async migrateToService(destination,consume,finalize=async()=>{}){return locked(join(root,'runninghubPool.lock'),async()=>{
      const s=await load();if(!s.entries.length)throw Error('旧 Key 池不存在或没有凭据，不能报告迁移成功');if(s.leases.some(l=>l.phase!=='completed'))throw Error('旧 Key 池有活动或未知任务，必须先恢复，不能迁移');
      if(s.migration&&s.migration.destination!==destination)throw Error('旧 Key 池已绑定另一新版服务目录');
      const snapshot={entries:s.entries.map(e=>({...e,enabled:s.migration?e.enabledBeforeMigration:e.enabled})),settings:{...s.settings}};
      async function persist(){const plain=Buffer.from(JSON.stringify(checkState(s)));try{await atomicSave(path,await protect(plain));}finally{plain.fill(0);}}
      // Freeze the source durably FIRST. Later failures leave it frozen, never automatically roll back.
      if(!s.migration)for(const e of s.entries){e.enabledBeforeMigration=e.enabled;e.enabled=false;}
      s.migration={destination,phase:'pending',startedAt:s.migration?.startedAt??new Date().toISOString()};await persist();
      const result=await consume(snapshot);
      s.migration.phase='completed';s.migration.completedAt=new Date().toISOString();await persist();
      await finalize();
      return result;
    });},
    async attachTask(id,task){taskId(task);return update(s=>{const l=lease(s,id);if(!['submitting','submitted','unknown'].includes(l.phase)||(l.taskId&&l.taskId!==task))throw Error('不能覆盖原任务绑定');l.taskId=task;l.phase='submitted';});},
    async markUnknown(id){return update(s=>{const l=lease(s,id);if(l.phase!=='submitting')throw Error('当前状态不能标记 unknown');l.phase='unknown';});},
    async releaseUnsubmitted(id){return update(s=>{const l=lease(s,id);if(l.phase!=='reserved'||l.taskId)throw Error('只能释放从未提交的预约');s.leases.splice(s.leases.indexOf(l),1);});},
    async replaceBeforeSubmission(id,remaining){credit(remaining);return update(s=>{
      const l=lease(s,id);if(l.phase!=='reserved'||l.taskId)throw Error('提交后不能换 Key');
      const prior=s.entries.find(e=>e.id===l.entryId);
      if(remaining>=l.minCredits)throw Error('只有实时积分不足时才能在提交前重新调度');
      prior.credits=remaining;prior.creditsSource='updated';prior.creditsUpdatedAt=new Date().toISOString();
      const busy=new Set(s.leases.filter(x=>x.phase!=='completed').map(x=>x.entryId));
      const next=s.entries.filter(e=>e.id!==prior.id&&!busy.has(e.id)&&e.enabled&&e.credits>=l.minCredits&&e.cooldownUntil<=Date.now()).sort((a,b)=>a.lastUsedAt-b.lastUsedAt)[0];
      if(!next)return null;
      next.lastUsedAt=Math.max(Date.now(),...s.entries.map(e=>e.lastUsedAt))+1;
      l.entryId=next.id;return {...l};
    });},
    async complete(id,outcome,remaining){
      if(!['succeeded','failed','cancelled'].includes(outcome))throw Error('终态无效');if(remaining!==undefined)credit(remaining);
      return update(s=>{const l=lease(s,id);if(l.phase==='completed')return;
        if(l.phase==='reserved'&&outcome!=='cancelled')throw Error('未提交操作只能取消');
        const wasReserved=l.phase==='reserved';l.phase='completed';l.outcome=outcome;const e=s.entries.find(e=>e.id===l.entryId);
        if(remaining!==undefined){e.credits=remaining;e.creditsSource='updated';e.creditsUpdatedAt=new Date().toISOString();}
        else if(!wasReserved)e.enabled=false;
      });
    },
    async updateEntry(id,patch){
      if(!idPattern.test(id)||Object.keys(patch).some(k=>!['credits','enabled','cooldownSeconds'].includes(k)))throw Error('更新参数无效');
      if(patch.credits!==undefined)credit(patch.credits);if(patch.cooldownSeconds!==undefined&&(credit(patch.cooldownSeconds)>604800))throw Error('冷却时间过长');if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw Error('启用参数无效');
      return update(s=>{const e=s.entries.find(e=>e.id===id);if(!e)throw Error('Key 标识不存在');
        if(patch.enabled!==undefined)e.enabled=patch.enabled;if(patch.cooldownSeconds!==undefined)e.cooldownUntil=Date.now()+patch.cooldownSeconds*1000;
        if(patch.credits!==undefined){e.credits=patch.credits;e.creditsSource='updated';e.creditsUpdatedAt=new Date().toISOString();}
      });
    },
  };
}
export function parseFlags(args,allowed){
  if(args.length%2)throw Error('参数需要 --name value');const f={};
  for(let i=0;i<args.length;i+=2){const k=args[i].slice(2);if(!args[i].startsWith('--')||!allowed.includes(k)||k in f||!args[i+1])throw Error('未知或重复参数');f[k]=args[i+1];}return f;
}
export async function main(args){
  const [action,...rest]=args,f=parseFlags(rest,['file','poolDirectory','id','credits','enabled','cooldownSeconds','maxConcurrent','minCredits']);
  if(!['import','summary','list','update','configure'].includes(action))throw Error('用法：keyPool.mjs import --file 绝对路径；summary；list；configure --maxConcurrent 3；update --id 脱敏ID --enabled false');
  const pool=await createKeyPool(f.poolDirectory);
  if(action==='import'){
    if(!f.file||!isAbsolute(f.file))throw Error('请指定账户文件绝对路径');
    const bytes=await readLimited(f.file,1024*1024);try{const r=await pool.importText(bytes.toString('utf8'));console.log(JSON.stringify({...r,encryptedPath:pool.path}));}finally{bytes.fill(0);}
  }
  if(action==='update'){
    const p={};for(const k of ['credits','cooldownSeconds'])if(f[k]!==undefined)p[k]=Number(f[k]);
    if(f.enabled!==undefined){if(!['true','false'].includes(f.enabled))throw Error('enabled 必须是 true/false');p.enabled=f.enabled==='true';}
    await pool.updateEntry(f.id,p);
  }
  if(action==='configure'){const p={};for(const k of ['maxConcurrent','minCredits'])if(f[k]!==undefined)p[k]=Number(f[k]);await pool.configure(p);}
  const s=await pool.list();if(action==='list')return s;
  return {total:s.total,settings:s.settings,perKeyConcurrency:1,enabled:s.entries.filter(e=>e.enabled).length,availableSnapshot:s.entries.filter(e=>e.enabled&&e.credits>=s.settings.minCredits&&!e.busy&&!e.coolingDown).length,activeOperations:s.activeOperations,importedBalanceEntries:s.entries.filter(e=>e.creditsSource==='imported').length,balanceNotice:'导入积分仅为文件快照；提交前核验实时余额，最低积分不是单条视频费用预测；遵守平台和账户配额',encryptedPath:pool.path};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.error('Key 池操作失败；请核对格式、私有目录、锁状态及 Windows 用户。原凭据未输出。');process.exitCode=1;});
