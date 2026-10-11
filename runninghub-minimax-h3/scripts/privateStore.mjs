import {mkdir,open,rename,unlink,realpath,stat,readFile} from 'node:fs/promises';
import {dirname,join,isAbsolute,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function defaultDirectory() {
  if (!process.env.LOCALAPPDATA) throw Error('需要 Windows LOCALAPPDATA 或显式 --poolDirectory 绝对路径');
  return join(process.env.LOCALAPPDATA,'RunningHubH3');
}
export async function privateDirectory(value=defaultDirectory()) {
  if (!isAbsolute(value)) throw Error('私有数据目录必须是绝对路径');
  await mkdir(value,{recursive:true,mode:0o700});
  const root=await realpath(value);
  // Neither the source checkout nor the installed Skill may contain credentials/journals.
  const skill=await realpath(fileURLToPath(new URL('..',import.meta.url)));
  const repo=dirname(skill);
  for (const forbidden of [skill,repo]) {
    const r=relative(forbidden,root);
    if (!r || (!r.startsWith('..')&&!isAbsolute(r))) throw Error('私有数据必须保存在 Skill/Git 仓库之外');
  }
  return root;
}
export async function atomicSave(path,bytes) {
  const temp=path+'.'+randomUUID()+'.tmp';
  let h;
  try {
    h=await open(temp,'wx',0o600); await h.writeFile(bytes); await h.sync(); await h.close(); h=null;
    await rename(temp,path);
  } finally { if(h) await h.close(); await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
}
export async function locked(path,fn) {
  let h;
  const deadline=Date.now()+30000;
  while(!h){
    try {h=await open(path,'wx',0o600);} catch(e) {
      if(e.code!=='EEXIST')throw e;
      if(Date.now()>=deadline)throw Error('本地锁等待超时；确认执行器已退出后才能人工清理 lock，不自动重提远端任务');
      await new Promise(r=>setTimeout(r,100));
    }
  }
  try {await h.writeFile(JSON.stringify({pid:process.pid}));return await fn();}
  finally {await h.close();await unlink(path);}
}
export async function readLimited(path,limit) {
  const info=await stat(path);
  if(!info.isFile()||info.size>limit)throw Error('文件不是普通文件或超过容量限制');
  const bytes=await readFile(path);
  if(bytes.length>limit)throw Error('文件超过容量限制');
  return bytes;
}
