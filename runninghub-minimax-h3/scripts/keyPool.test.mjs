import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createKeyPool} from './keyPool.mjs';
import {buildNodes,manifest} from './parameters.mjs';
import {runDirect} from './directH3.mjs';
import {runBatch} from './batch.mjs';

async function isolated(fn){
  const base=resolve(tmpdir()),dir=await mkdtemp(join(base,'runninghub-h3-test-'));
  try{return await fn(dir);}finally{const r=relative(base,resolve(dir));assert.ok(r.startsWith('runninghub-h3-test-')&&!r.includes('..')&&!isAbsolute(r));await rm(dir,{recursive:true,force:true});}
}
const rows=Array.from({length:5},(_,i)=>`test${i}@example.invalid----DISCARDED_LOGIN_PASSWORD----100----synthetic_key_${String(i).padStart(20,'0')}----DISCARDED_MAIL_PASSWORD`).join('\n');

test('DPAPI import/dedup/private projection; three different slots, fixed operation, submission recovery', {skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const pool=await createKeyPool(dir);
  assert.equal((await pool.importText(rows)).added,5);assert.equal((await pool.importText(rows)).added,0);
  const publicText=JSON.stringify(await pool.list());assert.ok(!publicText.includes('synthetic_key'));assert.ok(!publicText.includes('example.invalid'));assert.ok(!publicText.includes('DISCARDED'));
  const encrypted=await readFile(pool.path);assert.ok(!encrypted.includes(Buffer.from('synthetic_key')));
  const reservations=await Promise.all(['one','two','three'].map(id=>pool.reserve(id,5)));
  assert.equal(new Set(reservations.map(r=>r.entryId)).size,3);
  await assert.rejects(pool.configure({maxConcurrent:1}));
  assert.equal((await pool.reserve('one')).entryId,reservations[0].entryId);
  await assert.rejects(pool.reserve('four'),e=>e.code==='pool_busy');
  await pool.beginSubmission('one');await pool.markUnknown('one');
  assert.equal((await pool.reserve('one')).phase,'unknown');
  await assert.rejects(pool.beginSubmission('one'));
  await assert.rejects(pool.replaceBeforeSubmission('one',0));
  await assert.rejects(pool.releaseUnsubmitted('one'));
  await pool.attachTask('one','1234567890123');
  await assert.rejects(pool.attachTask('one','9876543210987'));
  await pool.complete('one','succeeded',80);await pool.complete('two','cancelled');await pool.complete('three','cancelled');
  await assert.rejects(pool.reserve('one'));
  const fourth=await pool.reserve('four',5);
  assert.ok(!reservations.some(r=>r.entryId===fourth.entryId),'least-used unused Key should get next new job');
  const replacement=await pool.replaceBeforeSubmission('four',0);assert.ok(replacement&&replacement.entryId!==fourth.entryId);
  await pool.complete('four','cancelled');
  assert.equal((await pool.list()).activeOperations,0);
  await pool.updateEntry(reservations[0].entryId,{enabled:false});await pool.importText(rows);
  assert.equal((await pool.list()).entries.find(e=>e.id===reservations[0].entryId).enabled,false);
}));

test('exhaustion and configuration are bounded; completed unknown Key without fresh balance is quarantined',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const pool=await createKeyPool(dir);await pool.importText(rows);await pool.configure({maxConcurrent:2,minCredits:50});
  await assert.rejects(pool.configure({maxConcurrent:0}));
  const l=await pool.reserve('job');await pool.beginSubmission('job');await pool.markUnknown('job');await pool.complete('job','failed');
  assert.equal((await pool.list()).entries.find(e=>e.id===l.entryId).enabled,false);
  for(const e of (await pool.list()).entries)await pool.updateEntry(e.id,{credits:0});
  await assert.rejects(pool.reserve('next'),e=>e.code==='pool_exhausted');
}));

test('manifest validation / real mapped slots preserve video and LoRA defaults',async()=>isolated(async dir=>{
  const path=join(dir,'input.json');await writeFile(path,JSON.stringify({prompt:'[0s-10s] 人物回头。',references:[],parameters:{aspectRatio:'16:9'}}));
  const input=await manifest(path);assert.equal(input.parameters.durationSeconds,10);
  // A synthetic schema, not a platform request. The binding invariants are what is under test.
  const fields=['141.image','142.image','143.image','161.image','175.image','176.image','144.audio','160.audio','189.audio','164.video','163.value','150.value','186.value','115.aspect_ratio','147.value','192.value','185.value','171.value','169.value','158.value','159.lora_name','159.strength_model'];
  const app={nodes:fields.map(k=>{const [nodeId,fieldName]=k.split('.');return {nodeId,fieldName,fieldValue:k==='164.video'?'original.mp4':k==='159.lora_name'?'original.safetensors':'0',fieldData:k==='115.aspect_ratio'?['COMBO',{options:['16:9 (widescreen)','9:16 (portrait)']}]:null};})};
  const nodes=buildNodes(app,input,[]),get=k=>nodes.find(n=>n.nodeId+'.'+n.fieldName===k).fieldValue;
  assert.equal(get('164.video'),'original.mp4');assert.equal(get('163.value'),'false');assert.equal(get('159.lora_name'),'original.safetensors');assert.equal(get('141.image'),'None');assert.equal(get('115.aspect_ratio'),'16:9 (widescreen)');
  await writeFile(path,JSON.stringify({prompt:'[0s-16s] 超出时长。'}));await assert.rejects(manifest(path));
  await writeFile(path,JSON.stringify({prompt:'@图片2',references:[]}));await assert.rejects(manifest(path));
}));

function simulatedPlatform(){
  const fields=['141.image','142.image','143.image','161.image','175.image','176.image','144.audio','160.audio','189.audio','164.video','163.value','150.value','186.value','115.aspect_ratio','147.value','192.value','185.value','171.value','169.value','158.value','159.lora_name','159.strength_model'];
  const nodes=fields.map(k=>{const [nodeId,fieldName]=k.split('.');return {nodeId,fieldName,fieldValue:k==='164.video'?'original.mp4':k==='159.lora_name'?'original.safetensors':'0',fieldData:k==='115.aspect_ratio'?['COMBO',{options:['16:9 (widescreen)','9:16 (portrait)']}]:null};});
  const submissions=[],done=new Set();let unknown=false;
  return {submissions,done,setUnknown:()=>{unknown=true;},fetch:async(url,options)=>{
    const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;
    let data;
    if(path==='/uc/openapi/accountStatus')data={remainCoins:'100',currentTaskCounts:'0'};
    else if(path==='/api/webapp/apiCallDemo')data={nodeInfoList:nodes};
    else if(path==='/task/openapi/ai-app/run'){
      submissions.push({apiKey:body.apiKey,taskId:String(1000+submissions.length)});
      if(unknown)throw Error('simulated interrupted response');
      data={taskId:submissions.at(-1).taskId};
    }else if(path==='/task/openapi/status')data=done.has(body.taskId)?'SUCCESS':'RUNNING';
    else if(path==='/task/openapi/outputs')data=[];
    else throw Error('unexpected request, real network disabled');
    return new Response(JSON.stringify({code:0,data}),{status:200,headers:{'Content-Type':'application/json'}});
  }};
}

test('offline simulated batch fills three slots, reuses freed capacity, never duplicates known tasks',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const platform=simulatedPlatform(),old=globalThis.fetch;globalThis.fetch=platform.fetch;
  try{
    const pool=await createKeyPool(dir);await pool.importText(rows);
    const input=join(dir,'input.json'),spec=join(dir,'batch.json'),journal=join(dir,'queue.json');
    await writeFile(input,JSON.stringify({prompt:'[0s-5s] 静态场景。'}));await writeFile(spec,JSON.stringify({jobs:Array.from({length:4},()=>({manifest:input}))}));
    await runBatch(['plan','--manifest',spec,'--journal',journal,'--poolDirectory',dir]);
    const args=['run','--journal',journal,'--poolDirectory',dir,'--confirm','submit','--waitSeconds','0'];
    const first=await runBatch(args);assert.equal(platform.submissions.length,3);assert.equal(first.jobs.filter(j=>j.phase==='submitted').length,3);assert.equal(new Set(platform.submissions.map(s=>s.apiKey)).size,3);
    platform.submissions.forEach(s=>platform.done.add(s.taskId));
    const second=await runBatch(args);assert.equal(platform.submissions.length,4);assert.equal(second.jobs.filter(j=>j.phase==='completed').length,3);
    platform.submissions.forEach(s=>platform.done.add(s.taskId));
    const final=await runBatch(args);assert.ok(final.jobs.every(j=>j.phase==='completed'));assert.equal(platform.submissions.length,4);assert.equal((await pool.list()).activeOperations,0);
  }finally{globalThis.fetch=old;}
}));

test('offline simulated lost submit response freezes original Key and refuses resubmission',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const platform=simulatedPlatform(),old=globalThis.fetch;globalThis.fetch=platform.fetch;
  try{
    const pool=await createKeyPool(dir);await pool.importText(rows);
    const input=join(dir,'input.json'),journal=join(dir,'task.json');await writeFile(input,JSON.stringify({prompt:'[0s-5s] 场景。'}));
    const p=await runDirect('prepare',{manifest:input,journal,poolDirectory:dir});platform.setUnknown();
    await assert.rejects(runDirect('generate',{journal,poolDirectory:dir,confirm:'submit'}));
    const result=await runDirect('generate',{journal,poolDirectory:dir,confirm:'submit'});assert.equal(result.phase,'unknown');assert.equal(platform.submissions.length,1);assert.equal((await pool.getLease(p.operationId)).entryId,p.keyId);assert.equal((await pool.list()).activeOperations,1);
  }finally{globalThis.fetch=old;}
}));

test('batch planning is offline; run requires explicit generation authorization',async()=>isolated(async dir=>{
  const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('network forbidden in offline test');};
  try{
    const input=join(dir,'input.json'),spec=join(dir,'batch.json'),journal=join(dir,'queue.json');
    await writeFile(input,JSON.stringify({prompt:'[0s-5s] 静态场景。'}));await writeFile(spec,JSON.stringify({jobs:[{manifest:input},{manifest:input}]}));
    const planned=await runBatch(['plan','--manifest',spec,'--journal',journal,'--poolDirectory',dir]);assert.equal(planned.jobs.length,2);assert.ok(planned.jobs.every(j=>j.phase==='queued'));
    await assert.rejects(runBatch(['run','--journal',journal,'--poolDirectory',dir]));
    const status=await runBatch(['status','--journal',journal,'--poolDirectory',dir]);assert.ok(status.jobs.every(j=>j.phase==='queued'));
  }finally{globalThis.fetch=old;}
}));

test('prepared task cannot submit without confirm; cancellation has no network call',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const pool=await createKeyPool(dir);await pool.importText(rows);await pool.reserve('auth-boundary');
  const input={prompt:'[0s-5s] 场景。',references:[],parameters:{durationSeconds:5}},journal=join(dir,'task.json');
  const {createHash}=await import('node:crypto'),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  await writeFile(journal,JSON.stringify({version:2,backend:'runninghub',appId:'2084320751339032577',poolDirectory:pool.root,operationId:'auth-boundary',input,inputHash:hash(input),nodes:[],nodesHash:hash([]),phase:'prepared'}));
  const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('network forbidden in offline test');};
  try{
    await assert.rejects(runDirect('generate',{journal,poolDirectory:dir}));assert.equal((await pool.getLease('auth-boundary')).phase,'reserved');
    assert.equal((await runDirect('cancel',{journal,poolDirectory:dir})).phase,'cancelled');
  }finally{globalThis.fetch=old;}
}));

test('sibling pause after durable intent prevents the legacy direct request and allows explicit safe resume',{skip:process.platform!=='win32'},async()=>isolated(async dir=>{
  const platform=simulatedPlatform(),old=globalThis.fetch;globalThis.fetch=platform.fetch;
  try{
    const pool=await createKeyPool(dir);await pool.importText(rows);
    const input=join(dir,'input.json'),journal=join(dir,'task.json');await writeFile(input,JSON.stringify({prompt:'[0s-5s] 场景。'}));
    const prepared=await runDirect('prepare',{manifest:input,journal,poolDirectory:dir});let checks=0;
    const paused=await runDirect('generate',{journal,poolDirectory:dir,confirm:'submit',shouldSubmit:()=>++checks===1});
    assert.equal(checks,2);assert.equal(paused.phase,'prepared');assert.equal(platform.submissions.length,0);assert.equal((await pool.getLease(prepared.operationId)).phase,'reserved');
    const resumed=await runDirect('generate',{journal,poolDirectory:dir,confirm:'submit'});assert.equal(resumed.phase,'submitted');assert.equal(platform.submissions.length,1);assert.equal(resumed.keyId,prepared.keyId);
  }finally{globalThis.fetch=old;}
}));
