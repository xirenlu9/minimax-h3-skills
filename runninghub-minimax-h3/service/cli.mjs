import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {readFile,mkdir,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {unlockDataDirectory,acquireProcessLock} from './lib/store.mjs';
import {windowsPassphrase} from './lib/windowsVault.mjs';
import {privateDirectory} from '../scripts/privateStore.mjs';

export const dataDirectory=()=>resolve(process.env.RH_H3_HOME||join(homedir(),'.runninghub-h3-service'));
const defaultBase=()=>process.env.RH_H3_BASE||`http://127.0.0.1:${process.env.RH_H3_PORT||'4317'}`;
function localBase(value){
  const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Only the local independent RunningHub H3 service is supported.');return url.origin;
}
async function serviceToken(){const token=(await readFile(join(dataDirectory(),'service.token'),'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('Service token is invalid; start the independent H3 service first.');return token;}
async function call(path,{method='GET',body}={}){
  const base=localBase(defaultBase()),token=await serviceToken();let response;
  try{response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});}catch{throw Error('Independent H3 service is not reachable. Start it with node service/cli.mjs start.');}
  let result;try{result=await response.json();}catch{throw Error('Independent H3 service returned an unreadable response.');}
  if(!response.ok)throw Error(result.error||`Independent H3 service returned HTTP ${response.status}.`);return result;
}
function promptSecret(label){
  return new Promise((resolvePrompt,reject)=>{
    const input=process.stdin;if(!input.isTTY||typeof input.setRawMode!=='function'){reject(Error(`${label} requires an interactive terminal; use the documented environment variable for unattended service startup.`));return;}
    let value='';process.stdout.write(label);input.setRawMode(true);input.setEncoding('utf8');input.resume();
    const done=(error,result)=>{input.setRawMode(false);input.pause();input.removeListener('data',onData);process.stdout.write('\n');error?reject(error):resolvePrompt(result);};
    const onData=chunk=>{for(const char of chunk){if(char==='\u0003'){done(Error('Cancelled.'));return;}if(char==='\r'||char==='\n'){done(null,value);return;}if(char==='\u007f'||char==='\b'){value=value.slice(0,-1);continue;}if(char>=' '&&char<='~')value+=char;}};
    input.on('data',onData);
  });
}
function options(args){const out={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||!args[i+1])throw Error(`Expected an option and value near ${args[i]}.`);out[args[i].slice(2)]=args[++i];}return out;}
function print(value){process.stdout.write(JSON.stringify(value,null,2)+'\n');}

async function start(){
  const fromEnvironment=Boolean(process.env.RH_H3_VAULT_PASSPHRASE);let passphrase=process.env.RH_H3_VAULT_PASSPHRASE;
  if(!passphrase&&process.platform==='win32')passphrase=await windowsPassphrase(dataDirectory());
  if(!passphrase)passphrase=await promptSecret('Vault passphrase (not echoed): ');
  const port=Number(process.env.RH_H3_PORT||4317);if(!Number.isInteger(port)||port<1||port>65535)throw Error('RH_H3_PORT must be between 1 and 65535.');
  const dir=await privateDirectory(dataDirectory());const releaseLock=await acquireProcessLock(dir);
  try{let hasState=true;try{await access(join(dir,'state.json'));}catch(error){if(error.code==='ENOENT')hasState=false;else throw error;}if(!hasState&&!fromEnvironment&&process.platform!=='win32'){const confirmation=await promptSecret('Confirm vault passphrase (not echoed): ');if(confirmation!==passphrase)throw Error('Vault passphrases did not match; no service data was created.');}const unlocked=await unlockDataDirectory(dir,passphrase);const {startServer}=await import('./server.mjs');await startServer({unlocked,port,releaseLock});}
  catch(error){await releaseLock();throw error;}
}
async function main(args){
  const [group,action,...rest]=args;
  if(group==='start'&&!action)return start();
  if(group==='migrate'){
    const flags=options([action,...rest]);if(!flags.file||!flags['legacy-pool'])throw Error('Usage: migrate --file ACCOUNT_FILE --legacy-pool PRIVATE_DIRECTORY');
    const dir=await privateDirectory(dataDirectory()),release=await acquireProcessLock(dir);
    try{const passphrase=process.env.RH_H3_VAULT_PASSPHRASE||await windowsPassphrase(dir),unlocked=await unlockDataDirectory(dir,passphrase);
      const {migrateLegacyPool}=await import('./lib/migration.mjs');print(await migrateLegacyPool({unlocked,poolDirectory:resolve(flags['legacy-pool']),accountFile:resolve(flags.file)}));}
    finally{await release();}return;
  }
  if(group==='executor'&&['status','pause','resume'].includes(action)){print(await call(action==='status'?'/api/executor':`/api/executor/${action}`,action==='status'?{}:{method:'POST',body:{}}));return;}
  if(group==='settings'){
    const flags=options([action,...rest].filter(Boolean)),body={};
    if(flags['max-concurrent']!==undefined)body.maxConcurrent=Number(flags['max-concurrent']);if(flags['min-credits']!==undefined)body.minCredits=Number(flags['min-credits']);
    print(await call('/api/settings',{method:'PATCH',body}));return;
  }
  if(group==='key'&&action==='probe-all'){
    const before=await call('/api/keys');let checked=0;
    for(const entry of before.keys){try{await call(`/api/keys/${encodeURIComponent(entry.keyId)}/probe`,{method:'POST',body:{}});checked++;}
      catch{print({checked,total:before.keys.length,stopped:true,error:'Account verification failed; stopped without rotating around the error.'});process.exitCode=1;return;}
      await new Promise(ok=>setTimeout(ok,250));
    }
    const after=await call('/api/keys');print({checked,total:after.keys.length,consumer:after.keys.filter(e=>e.consumerStatus==='consumer').length,enabled:after.keys.filter(e=>e.enabled).length,zeroBalance:after.keys.filter(e=>e.accountStatus?.remainCoins===0).length,billingTaskSubmitted:false});return;
  }
  if(group==='key'&&action==='add'){
    const flags=options(rest),accountGroup=flags['account-group'];if(!accountGroup)throw Error('Provide --account-group so multiple keys from the same RunningHub account share one local concurrency slot.');
    const apiKey=(await promptSecret('RunningHub consumer API key (not echoed): ')).trim();const result=await call('/api/keys',{method:'POST',body:{apiKey,accountGroup}});print(result);return;
  }
  if(group==='key'&&action==='list'){print(await call('/api/keys'));return;}
  if(group==='key'&&action==='probe'){
    const id=rest[0];if(!id)throw Error('Usage: node service/cli.mjs key probe KEY_ID');print(await call(`/api/keys/${encodeURIComponent(id)}/probe`,{method:'POST',body:{}}));return;
  }
  if(group==='key'&&['enable','disable'].includes(action)){
    const id=rest[0];if(!id)throw Error(`Usage: node service/cli.mjs key ${action} KEY_ID`);print(await call(`/api/keys/${encodeURIComponent(id)}`,{method:'PATCH',body:{enabled:action==='enable'}}));return;
  }
  if(group==='job'&&action==='attach-task'){
    const [jobId,taskId]=rest;if(!jobId||!taskId)throw Error('Usage: node service/cli.mjs job attach-task JOB_ID RUNNINGHUB_TASK_ID');print(await call(`/api/jobs/${encodeURIComponent(jobId)}/attach-task`,{method:'POST',body:{taskId}}));return;
  }
  if(group==='job'&&action==='resolve-not-accepted'){
    const jobId=rest[0];if(!jobId)throw Error('Usage: node service/cli.mjs job resolve-not-accepted JOB_ID');
    const terminal=createInterface({input:process.stdin,output:process.stdout});let answer;try{answer=await terminal.question('Check RunningHub first. Type exactly "I checked RunningHub and found no task for this submission." to release this local slot: ');}finally{terminal.close();}
    print(await call(`/api/jobs/${encodeURIComponent(jobId)}/resolve-not-accepted`,{method:'POST',body:{confirmation:answer}}));return;
  }
  if(group==='job'&&action==='list'){print(await call('/api/jobs'));return;}
  throw Error('Usage: start | migrate --file ACCOUNT_FILE --legacy-pool PRIVATE_DIRECTORY | key add/list/probe/probe-all/enable/disable | executor status/pause/resume | settings --max-concurrent 3 --min-credits 1 | job list/attach-task/resolve-not-accepted');
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  main(process.argv.slice(2)).catch(error=>{process.stderr.write((error instanceof Error?error.message:'Command failed.')+'\n');process.exitCode=1;});
}
