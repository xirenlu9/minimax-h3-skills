import {createCipheriv,createDecipheriv,createHash,randomBytes,scryptSync,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {atomicSave} from '../../scripts/privateStore.mjs';

const STATE_VERSION=1;
const verifierText='runninghub-minimax-h3-independent-vault-v1';
function derive(passphrase,salt){return scryptSync(passphrase,salt,32);}
function encrypt(key,value){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return {nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
function decrypt(key,entry){
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(entry.nonce,'base64'));
  decipher.setAuthTag(Buffer.from(entry.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext,'base64')),decipher.final()]).toString('utf8');
}
async function atomicJson(path,value){
  await atomicSave(path,Buffer.from(JSON.stringify(value)));
}
export function fingerprint(secret){return createHash('sha256').update(secret).digest('hex');}
export function encryptSecret(key,secret){return encrypt(key,secret);}
export function decryptSecret(key,entry){return decrypt(key,entry);}

export async function unlockDataDirectory(inputDir,passphrase){
  if(typeof passphrase!=='string'||passphrase.length<12)throw Error('Vault passphrase must contain at least 12 characters.');
  const dir=resolve(inputDir);await mkdir(dir,{recursive:true,mode:0o700});
  const statePath=join(dir,'state.json');let state,exists=true;
  try{state=JSON.parse(await readFile(statePath,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw Error('Service state is unreadable; preserve the data directory and inspect it before recovery.');exists=false;}
  if(!exists){
    const salt=randomBytes(16),key=derive(passphrase,salt);
    state={version:STATE_VERSION,salt:salt.toString('base64'),verifier:encrypt(key,verifierText),keys:[],jobs:[]};
    await atomicJson(statePath,state);return {dir,statePath,key,state};
  }
  if(!state||state.version!==STATE_VERSION||!Array.isArray(state.keys)||!Array.isArray(state.jobs)||!state.salt||!state.verifier)throw Error('Service state format is invalid or unsupported.');
  const key=derive(passphrase,Buffer.from(state.salt,'base64'));
  try{if(decrypt(key,state.verifier)!==verifierText)throw Error();}catch{throw Error('Vault passphrase is incorrect or the vault is damaged.');}
  return {dir,statePath,key,state};
}

export async function createStateStore(unlocked){
  let current=unlocked.state,chain=Promise.resolve();
  async function persist(next){await atomicJson(unlocked.statePath,next);current=next;}
  return {
    snapshot:()=>structuredClone(current),
    transact(mutator){
      const result=chain.then(async()=>{const draft=structuredClone(current);const value=await mutator(draft);await persist(draft);return value;});
      chain=result.catch(()=>{});return result;
    },
  };
}

export async function readServiceToken(dir){
  const path=join(dir,'service.token');
  try{const token=(await readFile(path,'utf8')).trim();if(/^[a-f0-9]{64}$/.test(token))return token;throw Error('The local service token is malformed; preserve the data directory and inspect it before recovery.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const token=randomBytes(32).toString('hex');
  try{await writeFile(path,token,{flag:'wx',mode:0o600});}
  catch(error){if(error.code==='EEXIST')return (await readFile(path,'utf8')).trim();throw error;}
  return token;
}

export async function acquireProcessLock(dir){
  const path=join(dir,'service.lock');
  for(let attempt=0;attempt<2;attempt++){
    try{const handle=await open(path,'wx',0o600);await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await handle.sync();let released=false;return async()=>{if(released)return;released=true;await handle.close();await unlink(path).catch(()=>{});};}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      try{const existing=JSON.parse(await readFile(path,'utf8'));if(Number.isInteger(existing.pid)){try{process.kill(existing.pid,0);throw Error('An independent H3 service is already running for this data directory.');}catch(check){if(check.code==='EPERM')throw Error('An independent H3 service is already running for this data directory.');if(check.message==='An independent H3 service is already running for this data directory.')throw check;}}await unlink(path);}
      catch(check){if(check.message==='An independent H3 service is already running for this data directory.')throw check;if(check.code==='ENOENT')continue;throw Error('A service lock exists and could not be safely inspected; do not remove it while another service may be running.');}
    }
  }
  throw Error('Could not acquire the service lock.');
}
