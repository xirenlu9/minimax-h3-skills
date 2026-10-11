import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {atomicSave,readLimited,privateDirectory} from '../../scripts/privateStore.mjs';

// AES vault passphrase is wrapped by Windows CurrentUser DPAPI, never an argument or env var.
async function protect(bytes,unprotect=false){
  const command=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; try { $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $e=[Text.Encoding]::UTF8.GetBytes('runninghub-minimax-h3.service.v1'); $r=[Security.Cryptography.ProtectedData]::${unprotect?'Unprotect':'Protect'}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)) } catch { exit 1 }`;
  return new Promise((ok,bad)=>{
    const p=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    const chunks=[];let size=0;const timer=setTimeout(()=>p.kill(),15000);
    p.stdout.on('data',chunk=>{size+=chunk.length;if(size>65536)p.kill();else chunks.push(chunk);});p.stdin.on('error',()=>{});
    p.once('error',()=>{clearTimeout(timer);bad(Error('Windows vault protection could not start.'));});
    p.once('close',code=>{clearTimeout(timer);const text=Buffer.concat(chunks).toString('ascii').trim();if(code!==0||size>65536||!/^[a-zA-Z0-9+/]+={0,2}$/.test(text))return bad(Error('Windows vault could not be unlocked by this user.'));ok(Buffer.from(text,'base64'));});
    p.stdin.end(bytes.toString('base64'));
  });
}
export async function windowsPassphrase(directory){
  if(process.platform!=='win32')throw Error('Automatic private vault startup requires Windows.');
  const dir=await privateDirectory(directory),path=join(dir,'vault.passphrase.dpapi');
  let encrypted;
  try{encrypted=await readLimited(path,65536);}catch(error){
    if(error.code!=='ENOENT')throw error;
    // Do not invent a new password for an already existing passphrase vault.
    try{await readLimited(join(dir,'state.json'),32*1024*1024);throw Error('An existing vault needs its original passphrase.');}catch(check){if(check.code!=='ENOENT')throw check;}
    const plain=Buffer.from(randomBytes(48).toString('hex'));
    try{encrypted=await protect(plain);await atomicSave(path,encrypted);return plain.toString('utf8');}finally{plain.fill(0);}
  }
  const plain=await protect(encrypted,true);try{return plain.toString('utf8');}finally{plain.fill(0);}
}
