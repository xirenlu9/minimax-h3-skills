import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,realpath,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {unlockDataDirectory,encryptSecret,createStateStore} from './lib/store.mjs';
import {windowsPassphrase} from './lib/windowsVault.mjs';
import {migrateLegacyPool} from './lib/migration.mjs';
import {startServer} from './server.mjs';
import * as realProvider from './lib/runninghub.mjs';
import {createKeyPool} from '../scripts/keyPool.mjs';
import {run as runClient} from '../scripts/h3.mjs';

const password='synthetic-test-vault-password',secret=n=>n.toString(16).padStart(32,'0');
const details=(coins=100)=>({apiType:'NORMAL',remainCoins:coins,remainMoney:null,currency:null,currentTaskCount:0,checkedAt:new Date().toISOString()});
const schema={fingerprint:'test-schema'};
const input={prompt:'Synthetic test, 5 seconds',references:[],parameters:{durationSeconds:5,aspectRatio:'16:9'}};
const job=(status='queued',extra={})=>({id:randomUUID(),operationId:randomUUID(),status,input:structuredClone(input),preview:{schemaFingerprint:schema.fingerprint},requestedKeyId:null,createdAt:new Date().toISOString(),...extra});
function provider(){const submissions=[],queries=[],uploads=[];return {...realProvider,submissions,queries,uploads,
  inspectH3Schema:async()=>schema,buildNodeInfo:()=>[],verifyConsumerKey:async()=>details(),
  uploadReference:async(key,ref)=>{uploads.push({key,ref});return 'mock-upload.png';},
  submitH3:async(key)=>{const taskId=String(1000+submissions.length);submissions.push({key,taskId});return {status:'submitted',taskId};},
  queryTask:async(key,id)=>{queries.push({key,id});return {status:'queued'};}};}
async function port(){const s=createServer();await new Promise((ok,bad)=>{s.once('error',bad);s.listen(0,'127.0.0.1',ok);});const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
async function eventually(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(10);}assert.fail('Timed out waiting for fixture state');}
async function isolated(fn){const base=await realpath(tmpdir()),dir=await mkdtemp(join(base,'h3-service-test-'));let service;
  try{await fn(dir,async(p,seed=()=>{})=>{const unlocked=await unlockDataDirectory(dir,password);seed(unlocked);service=await startServer({unlocked,port:await port(),provider:p,tickIntervalMs:60000});service.base=`http://127.0.0.1:${service.server.address().port}`;await delay(20);return service;});}
  finally{if(service)await service.close();const r=relative(base,resolve(dir));assert.ok(r.startsWith('h3-service-test-')&&!r.includes('..')&&!isAbsolute(r));await rm(dir,{recursive:true,force:true});}}
function keys(unlocked,groups=['a','b','c','d']){groups.forEach((accountGroup,i)=>unlocked.state.keys.push({keyId:`key${i}`,accountGroup,enabled:true,consumerStatus:'consumer',accountStatus:details(),secret:encryptSecret(unlocked.key,secret(i+1))}));}
async function api(s,path,method='GET',body){const response=await fetch(s.base+path,{method,headers:{Authorization:`Bearer ${s.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
async function cycles(s,n=3){for(let i=0;i<n;i++){await delay(15);await s.tick();}}

test('remote queue and global/account caps: no replacement task; freed slot serves next authorized job',async()=>isolated(async(dir,start)=>{
  const p=provider();let finished;
  p.queryTask=async(key,id)=>{p.queries.push({key,id});return id===finished?{status:'succeeded',outputs:[]}:{status:'queued'};};
  const s=await start(p,u=>{keys(u,['a','a','b','c']);u.state.jobs.push(...Array.from({length:4},()=>job()));});
  await cycles(s,6);assert.equal(p.submissions.length,3);
  const active=s.store.snapshot().jobs.filter(j=>j.taskId);assert.equal(new Set(active.map(j=>j.accountGroup)).size,3);assert.ok(active.every(j=>j.status==='remote_queued'));
  const original=active.map(j=>j.taskId);await cycles(s,4);assert.equal(p.submissions.length,3);assert.deepEqual(s.store.snapshot().jobs.filter(j=>j.taskId).map(j=>j.taskId),original);
  finished=original[0];await cycles(s,4);assert.equal(p.submissions.length,4);assert.equal(s.store.snapshot().jobs[0].taskId,original[0]);
}));

test('legacy queued+taskId on restart is polling-only',async()=>isolated(async(dir,start)=>{
  const p=provider(),s=await start(p,u=>{keys(u);u.state.jobs.push(job('queued',{taskId:'old-123',keyId:'key0',accountGroup:'a'}));});
  await cycles(s,4);assert.equal(p.submissions.length,0);assert.equal(s.store.snapshot().jobs[0].status,'remote_queued');assert.ok(p.queries.every(q=>q.id==='old-123'));
}));

test('live balance handoff before submit only, with fixed-Key selection respected',async()=>isolated(async(dir,start)=>{
  const p=provider();p.verifyConsumerKey=async key=>details(key===secret(1)?0:100);
  const pinned=job('queued',{requestedKeyId:'key0',keyId:'key0',accountGroup:'a'});
  const s=await start(p,u=>{keys(u,['a','b']);u.state.jobs.push(pinned,job());});
  await cycles(s,6);assert.equal(p.submissions.length,1);assert.equal(p.submissions[0].key,secret(2));
  const state=s.store.snapshot();assert.equal(state.jobs[0].status,'queued');assert.equal(state.jobs[0].keyId,'key0');assert.equal(state.keys[0].accountStatus.remainCoins,0);
}));

test('unknown submission pauses globally; retries, cancel and resume cannot release or re-submit it',async()=>isolated(async(dir,start)=>{
  const p=provider();p.submitH3=async key=>{p.submissions.push({key});throw Error('Mock lost response');};
  const s=await start(p,u=>{keys(u);u.state.jobs.push(job(),job());});await cycles(s,4);
  const j=s.store.snapshot().jobs[0];assert.equal(j.status,'submission_unknown');assert.equal(p.submissions.length,1);assert.equal(s.store.snapshot().executor.paused,true);
  assert.equal((await api(s,`/api/jobs/${j.id}/submit`,'POST',{confirmation:'submit'})).body.job.status,'submission_unknown');
  assert.equal((await api(s,`/api/jobs/${j.id}/cancel`,'POST',{})).status,409);
  assert.equal((await api(s,'/api/executor/resume','POST',{})).status,409);await cycles(s,3);assert.equal(p.submissions.length,1);
  const attach=await api(s,`/api/jobs/${j.id}/attach-task`,'POST',{taskId:'original-accepted-id'});assert.equal(attach.status,200);assert.equal(attach.body.job.keyId,'key0');
  assert.ok(p.queries.some(q=>q.key===secret(1)&&q.id==='original-accepted-id'));await cycles(s,3);assert.equal(p.submissions.length,1);
}));

test('a polling failure during sibling preflight stops request initiation',async()=>isolated(async(dir,start)=>{
  const p=provider();let entered=false,releaseSchema,failQuery;
  p.inspectH3Schema=()=>{entered=true;return new Promise(ok=>{releaseSchema=()=>ok(schema);});};
  p.queryTask=()=>new Promise((ok,bad)=>{failQuery=()=>bad(Error('mock HTTP 429'));});
  const s=await start(p,u=>{keys(u,['a','b']);u.state.jobs.push(job('submitted',{taskId:'existing',keyId:'key0',accountGroup:'a'}),job());});
  await eventually(()=>entered&&Boolean(failQuery));failQuery();await eventually(()=>s.store.snapshot().executor.paused);releaseSchema();await delay(40);
  assert.equal(p.submissions.length,0);assert.equal(s.store.snapshot().jobs[1].status,'queued');
  // Prevent another pending mock poll when closing.
  p.queryTask=async()=>({status:'running'});
}));

test('new client resolves relative references; prepare is pure preview and generation needs explicit confirmation',async()=>isolated(async(dir,start)=>{
  const p=provider(),s=await start(p,u=>keys(u));const oldHome=process.env.RH_H3_HOME;process.env.RH_H3_HOME=dir;
  try{const image=Buffer.alloc(32);image.write('\x89PNG\r\n\x1a\n',0,'latin1');image.writeUInt32BE(640,16);image.writeUInt32BE(360,20);await writeFile(join(dir,'reference.png'),image);
    const manifest=join(dir,'input.json'),journal=join(dir,'task.journal.json');await writeFile(manifest,JSON.stringify({prompt:'<Picture 1> is the first frame. 5 seconds.',references:[{kind:'image',role:'first-frame',path:'reference.png'}]}));
    const prepared=await runClient(['prepare','--manifest',manifest,'--journal',journal,'--base',s.base]);assert.equal(prepared.status,'prepared');assert.equal(prepared.parameters.aspectRatio,'16:9');
    assert.equal(p.uploads.length,0);assert.equal(p.submissions.length,0);assert.equal(s.store.snapshot().jobs[0].input.references[0].path,join(dir,'reference.png'));
    const unauth=await fetch(s.base+'/api/jobs');assert.equal(unauth.status,401);
    await assert.rejects(runClient(['generate','--journal',journal,'--base',s.base]));
    assert.equal((await api(s,`/api/jobs/${prepared.jobId}/submit`,'POST',{})).status,400);assert.equal(p.submissions.length,0);
    const cancelled=await runClient(['cancel','--journal',journal,'--base',s.base]);assert.equal(cancelled.status,'cancelled');
  }finally{if(oldHome===undefined)delete process.env.RH_H3_HOME;else process.env.RH_H3_HOME=oldHome;}
}));

test('DPAPI pool migration: anonymous account grouping, ciphertext, legacy freeze and idempotence',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const oldDir=join(dir,'old'),newDir=join(dir,'new'),pool=await createKeyPool(oldDir);
  const rows=[`one@example.invalid----LOGIN-SECRET----100----${secret(1)}----MAIL-SECRET`,`one@example.invalid----LOGIN-SECRET----100----${secret(2)}----MAIL-SECRET`,`two@example.invalid----LOGIN-SECRET----100----${secret(3)}----MAIL-SECRET`].join('\n');
  await pool.importText(rows);const file=join(dir,'synthetic-accounts.txt');await writeFile(file,rows);
  const unlocked=await unlockDataDirectory(newDir,password),result=await migrateLegacyPool({unlocked,poolDirectory:oldDir,accountFile:file});assert.equal(result.added,3);assert.equal(result.accountGroups,2);
  const bytes=await readFile(join(newDir,'state.json'));for(const sensitive of [secret(1),'example.invalid','LOGIN-SECRET','MAIL-SECRET'])assert.ok(!bytes.includes(Buffer.from(sensitive)));
  assert.equal((await pool.list()).entries.filter(e=>e.enabled).length,0);await assert.rejects(pool.reserve('must-not-submit'));
  const again=await unlockDataDirectory(newDir,password),store=await createStateStore(again);await store.transact(s=>{s.keys[0].enabled=true;s.keys[0].consumerStatus='consumer';});
  const retry=await migrateLegacyPool({unlocked:await unlockDataDirectory(newDir,password),poolDirectory:oldDir,accountFile:file});assert.equal(retry.added,0);assert.equal(retry.existing,3);
  assert.equal((await unlockDataDirectory(newDir,password)).state.keys[0].enabled,true);
}));

test('Windows vault bootstrap is encrypted and reuses the same private passphrase',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const phrase=await windowsPassphrase(dir);assert.ok(phrase.length>=12);assert.equal(await windowsPassphrase(dir),phrase);
  assert.ok(!(await readFile(join(dir,'vault.passphrase.dpapi'))).includes(Buffer.from(phrase)));
  const unlocked=await unlockDataDirectory(dir,phrase);unlocked.key.fill(0);
  assert.equal(await windowsPassphrase(dir),phrase);
}));

test('Chinese seconds and H3 timelines infer duration without silently truncating',()=>{
  const validate=(prompt,parameters={})=>realProvider.validateH3Input({prompt,parameters,_validatedReferences:{references:[],counts:{image:0,audio:0,video:0}}});
  assert.equal(validate('人物回头，持续5秒。').parameters.durationSeconds,5);
  assert.equal(validate('[0s-5s] 人物停顿。[5s-12s] 转身。').parameters.durationSeconds,12);
  assert.throws(()=>validate('[0s-16s] 内容超限。'));
  assert.throws(()=>validate('[0s-12s] 内容。',{durationSeconds:5}));
});

test('migration refuses an active/unknown legacy lease before adding destination keys',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const oldDir=join(dir,'old'),newDir=join(dir,'new'),pool=await createKeyPool(oldDir),file=join(dir,'accounts.txt');
  const rows=`test@example.invalid----DISCARDED----100----${secret(1)}----DISCARDED`;await pool.importText(rows);await writeFile(file,rows);
  await pool.reserve('old-operation');await pool.beginSubmission('old-operation');await pool.markUnknown('old-operation');
  const unlocked=await unlockDataDirectory(newDir,password);await assert.rejects(migrateLegacyPool({unlocked,poolDirectory:oldDir,accountFile:file}));
  assert.equal((await unlockDataDirectory(newDir,password)).state.keys.length,0);assert.equal((await pool.list()).activeOperations,1);
}));

test('failed explicit account probe pauses future submissions on every account',async()=>isolated(async(dir,start)=>{
  const p=provider();p.verifyConsumerKey=async key=>{if(key===secret(1))throw Error('mock HTTP 401');return details();};
  const s=await start(p,u=>keys(u,['a','b']));assert.equal((await api(s,'/api/keys/key0/probe','POST',{})).status,409);
  assert.equal(s.store.snapshot().executor.paused,true);await s.store.transact(state=>state.jobs.push(job()));
  await cycles(s,4);assert.equal(p.submissions.length,0);assert.equal(s.store.snapshot().keys[0].enabled,false);
}));

test('invalid falsy vault state is rejected and preserved byte-for-byte',async()=>isolated(async dir=>{
  const path=join(dir,'state.json');for(const text of ['null','false','0']){await writeFile(path,text);await assert.rejects(unlockDataDirectory(dir,password));assert.equal(await readFile(path,'utf8'),text);}
}));

test('a missing legacy pool cannot report successful zero-key migration',async()=>isolated(async dir=>{
  const file=join(dir,'accounts.txt');await writeFile(file,`test@example.invalid----DISCARDED----100----${secret(1)}----DISCARDED`);
  const unlocked=await unlockDataDirectory(join(dir,'new'),password);await assert.rejects(migrateLegacyPool({unlocked,poolDirectory:join(dir,'nonexistent'),accountFile:file}));
  assert.equal((await unlockDataDirectory(join(dir,'new'),password)).state.keys.length,0);
}));

test('cloud-signed output URLs are suppressed instead of exposing credentials',async()=>{
  const original=globalThis.fetch;
  try{for(const signature of ['signature','X-Amz-Signature','X-Goog-Signature','X-OSS-Signature']){
    globalThis.fetch=async()=>Response.json({code:0,data:[{fileUrl:`https://cdn.runninghub.ai/video.mp4?${signature}=synthetic-signature`}]});
    const result=await realProvider.queryTask('synthetic-key','synthetic-task');assert.equal(result.outputs[0].url,null);assert.equal(result.outputs[0].requiresRunningHubAccount,true);
  }}finally{globalThis.fetch=original;}
});

test('legacy marker write failure never enables simultaneous source/destination execution',{skip:process.platform!=='win32'},async()=>isolated(async(dir,start)=>{
  const pool=await createKeyPool(join(dir,'old'));await pool.importText(`test@example.invalid----DISCARDED----100----${secret(1)}----DISCARDED`);
  let consumed=false;await chmod(pool.path,0o444);
  try{await assert.rejects(pool.migrateToService(dir,async()=>{consumed=true;}));assert.equal(consumed,false);}
  finally{await chmod(pool.path,0o600);}
  // Fail the second source write, after the destination was populated as pending.
  const u=await unlockDataDirectory(dir,password),destination=await createStateStore(u);
  try{await assert.rejects(pool.migrateToService(dir,async()=>{
    await destination.transact(state=>{keys({key:u.key,state},['a']);state.migration={phase:'pending'};state.jobs.push(job());});
    await chmod(pool.path,0o444);
  },async()=>destination.transact(state=>{state.migration.phase='completed';})));
  }finally{await chmod(pool.path,0o600);}
  await assert.rejects(pool.reserve('must-remain-frozen'));
  const p=provider(),s=await start(p);assert.equal((await api(s,'/api/executor/resume','POST',{})).status,409);
  await cycles(s,3);assert.equal(p.submissions.length,0);assert.equal(s.store.snapshot().executor.reason,'migration_incomplete');
}));
