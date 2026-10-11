import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {createKeyPool} from '../../scripts/keyPool.mjs';
import {readLimited} from '../../scripts/privateStore.mjs';
import {createStateStore,encryptSecret,fingerprint} from './store.mjs';

function accountGroups(text){
  const groups=new Map();
  for(const [i,line] of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
    if(!line.trim())continue;
    const fields=line.split('----').map(value=>value.trim());
    if(fields.length!==5||!/^\S+@\S+\.\S+$/.test(fields[0])||!/^\d+(\.\d+)?$/.test(fields[2])||!/^[a-fA-F0-9]{32}$/.test(fields[3]))throw Error(`Account file row ${i+1} is invalid; no credentials were printed.`);
    const digest=fingerprint(fields[3]),group='acct_'+createHash('sha256').update(fields[0].toLowerCase()).digest('hex').slice(0,24);
    if(groups.has(digest)&&groups.get(digest)!==group)throw Error('One Key is assigned to different accounts; review the source file.');
    groups.set(digest,group);
  }
  if(!groups.size)throw Error('No consumer keys found.');return groups;
}
export async function migrateLegacyPool({unlocked,poolDirectory,accountFile}){
  const bytes=await readLimited(accountFile,1024*1024);let groups;
  try{groups=accountGroups(bytes.toString('utf8'));}finally{bytes.fill(0);}
  await readLimited(join(resolve(poolDirectory),'runninghubPool.bin'),16*1024*1024);
  const oldPool=await createKeyPool(poolDirectory),store=await createStateStore(unlocked);
  return oldPool.migrateToService(unlocked.dir,async snapshot=>{
    // All validation before any destination write. Only ciphertext is persisted.
    for(const entry of snapshot.entries)if(!/^[a-fA-F0-9]{32}$/.test(entry.apiKey)||!groups.has(fingerprint(entry.apiKey)))throw Error('Account file does not match the existing private pool.');
    return store.transact(state=>{
      let added=0,existing=0;
      for(const entry of snapshot.entries){
        const digest=fingerprint(entry.apiKey),accountGroup=groups.get(digest),prior=state.keys.find(item=>item.fingerprint===digest);
        if(prior){if(prior.accountGroup!==accountGroup)throw Error('Existing Key account group differs; no overwrite.');existing++;continue;}
        if(state.keys.length>=100)throw Error('The 100-Key pool limit has been reached.');
        state.keys.push({keyId:`rhkey_${randomUUID()}`,accountGroup,fingerprint:digest,enabled:false,enableAfterProbe:entry.enabled,
          capacity:1,consumerStatus:'unverified',importedCredits:entry.credits,createdAt:new Date().toISOString(),secret:encryptSecret(unlocked.key,entry.apiKey)});added++;
      }
      state.settings??={maxConcurrent:Math.min(snapshot.settings.maxConcurrent,4),minCredits:snapshot.settings.minCredits};
      state.executor={paused:true,reason:'migration_pending_verification'};
      state.migration={source:'windows-dpapi-pool',phase:'pending',legacyDirectory:oldPool.root};
      return {added,existing,total:state.keys.length,accountGroups:new Set(state.keys.map(item=>item.accountGroup)).size,legacyPoolDisabled:true};
    });
  },async()=>store.transact(state=>{if(state.migration?.legacyDirectory!==oldPool.root)throw Error('Migration destination changed unexpectedly.');state.migration.phase='completed';state.migration.completedAt=new Date().toISOString();}));
}
