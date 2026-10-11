import {open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createKeyPool,parseFlags} from './keyPool.mjs';
import {readLimited,atomicSave,locked} from './privateStore.mjs';
import {journalPath,runDirect} from './directH3.mjs';
import {manifest} from './parameters.mjs';
import {safeError} from './h3-pool.mjs';

const settled=['completed','failed','cancelled'];
const save=(p,s)=>atomicSave(p,Buffer.from(JSON.stringify(s,null,2)));
async function read(p){return JSON.parse((await readLimited(p,8*1024*1024)).toString('utf8'));}
function view(path,s){return {journal:path,phase:s.phase,jobs:s.jobs.map(j=>({id:j.id,journal:j.journal,phase:j.phase,result:j.result??null,error:j.error??null}))};}
export async function runBatch(args){
  const [action,...rest]=args,f=parseFlags(rest,['manifest','journal','poolDirectory','confirm','waitSeconds']);
  if(!['plan','run','status','resume'].includes(action)||!f.journal)throw Error('用法：batch.mjs plan --manifest 批次.json --journal 新批次.json；run --journal 同一批次.json --confirm submit；status/resume 只查询');
  const loc=await journalPath(f.poolDirectory,f.journal);
  return locked(loc.path+'.lock',async()=>{
    if(action==='plan'){
      if(!f.manifest)throw Error('plan 需要 --manifest');
      const spec=await read(resolve(f.manifest));
      if(!Array.isArray(spec.jobs)||spec.jobs.length<1||spec.jobs.length>100)throw Error('批次 jobs 数量范围为 1–100');
      const inputs=await Promise.all(spec.jobs.map(j=>manifest(resolve(j.manifest))));
      const h=await open(loc.path,'wx',0o600);await h.close();
      const id=randomUUID(),jobs=[];
      for(let i=0;i<inputs.length;i++){
        const dir=join(loc.root,'batches',id),input=await journalPath(loc.root,join(dir,`${i+1}.input.json`));
        await save(input.path,inputs[i]);jobs.push({id:i+1,manifest:input.path,journal:join(dir,`${i+1}.task.json`),phase:'queued'});
      }
      const s={version:1,poolDirectory:loc.root,phase:'planned',jobs,createdAt:new Date().toISOString()};await save(loc.path,s);return view(loc.path,s);
    }
    const s=await read(loc.path);
    if(s.version!==1||s.poolDirectory!==loc.root||!Array.isArray(s.jobs))throw Error('批次 journal 无效');
    for(const j of s.jobs){await journalPath(loc.root,j.journal);await journalPath(loc.root,j.manifest);}
    const pool=await createKeyPool(loc.root);
    async function updateKnown(j){
      let state;try{state=await read(j.journal);}catch(e){if(e.code==='ENOENT')return;throw e;}
      j.phase=state.phase;
      if(['submitted','submitting','unknown','completed'].includes(state.phase)){
        try{j.result=await runDirect('status',{poolDirectory:loc.root,journal:j.journal});j.phase=j.result.phase;j.error=null;}
        catch(e){j.error=safeError(e);}
      }
    }
    if(action!=='run'){
      await Promise.all(s.jobs.map(updateKnown));await save(loc.path,s);return view(loc.path,s);
    }
    if(f.confirm!=='submit')throw Error('run 将生成整个已计划批次，需要用户明确授权并传 --confirm submit');
    const seconds=Number(f.waitSeconds??60);
    if(!Number.isInteger(seconds)||seconds<0||seconds>3600)throw Error('waitSeconds 范围为 0–3600');
    const deadline=Date.now()+seconds*1000;
    let pause=false;
    // Explicit rerun may resume a safe, never-submitted resource wait; never clear unknown/API errors.
    for(const j of s.jobs)if(['waiting','prepared'].includes(j.phase)&&['pool_busy','pool_exhausted','account_busy','balance_checks_exhausted'].includes(j.error?.error))j.error=null;
    do{
      await Promise.all(s.jobs.map(updateKnown));
      if(s.jobs.some(j=>j.phase==='unknown'||j.error)){pause=true;break;}
      const snapshot=await pool.list(),free=Math.max(0,snapshot.settings.maxConcurrent-snapshot.activeOperations);
      // Prepared reservations already hold pool slots, and must not be counted as new ones.
      const prepared=s.jobs.filter(j=>j.phase==='prepared');
      const waiting=s.jobs.filter(j=>['queued','waiting'].includes(j.phase)).slice(0,free);
      await Promise.all([...prepared,...waiting].map(async j=>{
        try{
          let state;try{state=await read(j.journal);}catch(e){if(e.code!=='ENOENT')throw e;}
          if(state&&['submitted','submitting','unknown','completed','failed','cancelled','preparing'].includes(state.phase)){
            // Crash recovery never recreates a child or resumes an uncertain submission by sending again.
            await updateKnown(j);return;
          }
          if(!state||state.phase==='waiting'){
            j.result=await runDirect('prepare',{manifest:j.manifest,journal:j.journal,poolDirectory:loc.root});j.phase=j.result.phase;await save(loc.path,s);
          }
          if(pause)return;
          j.result=await runDirect('generate',{journal:j.journal,poolDirectory:loc.root,confirm:'submit',shouldSubmit:()=>!pause});j.phase=j.result.phase;j.error=null;
        }catch(e){
          try{j.phase=(await read(j.journal)).phase;}catch{}
          if(e.code==='pool_busy'&&j.phase==='waiting')return;
          j.error=safeError(e);pause=true;
        }
      }));
      if(s.jobs.some(j=>j.phase==='preparing'||j.phase==='unknown'))pause=true;
      s.phase=pause?'paused':s.jobs.every(j=>settled.includes(j.phase))?'finished':'running';await save(loc.path,s);
      if(pause||s.phase==='finished'||Date.now()>=deadline)break;
      await new Promise(r=>setTimeout(r,Math.min(5000,deadline-Date.now())));
    }while(Date.now()<=deadline);
    if(pause)s.phase='paused';await save(loc.path,s);return view(loc.path,s);
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runBatch(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify(safeError(e)));process.exitCode=1;});
