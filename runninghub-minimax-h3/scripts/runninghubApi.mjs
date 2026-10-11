import {basename,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {readLimited} from './privateStore.mjs';

export const APP_ID='2084320751339032577';
const ORIGIN='https://www.runninghub.ai';
export class RHError extends Error {
  constructor(kind,code){super(kind);this.kind=kind;this.code=code;}
}
// Errors intentionally exclude response bodies, fetch URLs and authentication headers.
async function request(apiKey,path,body,query) {
  const url=new URL(path,ORIGIN);
  if(query)for(const [k,v] of Object.entries(query))url.searchParams.set(k,v);
  const form=body instanceof FormData;
  let response;
  try {
    response=await fetch(url,{method:body===undefined?'GET':'POST',redirect:'error',headers:{Authorization:'Bearer '+apiKey,...(body!==undefined&&!form?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:form?body:JSON.stringify(body),signal:AbortSignal.timeout(form?120000:45000)});
  } catch {throw new RHError('network_error');}
  if(!response.ok)throw new RHError('http_error',response.status);
  const bytes=await response.arrayBuffer().catch(()=>{throw new RHError('network_error');});
  if(bytes.byteLength>4*1024*1024)throw new RHError('response_too_large');
  let doc;try{doc=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw new RHError('invalid_response');}
  if(!doc||typeof doc!=='object'||doc.code!==0)throw new RHError('api_rejected',Number.isSafeInteger(doc?.code)?doc.code:undefined);
  return doc.data;
}
export async function account(apiKey) {
  const data=await request(apiKey,'/uc/openapi/accountStatus',{apikey:apiKey});
  const coins=String(data?.remainCoins??''),count=String(data?.currentTaskCounts??'');
  if(!/^\d+(\.\d+)?$/.test(coins)||!/^\d+$/.test(count))throw new RHError('invalid_account_response');
  const remainCoins=Number(coins),currentTaskCounts=Number(count);
  if(!Number.isFinite(remainCoins)||remainCoins>1e12||!Number.isSafeInteger(currentTaskCounts))throw new RHError('invalid_account_response');
  return {remainCoins,currentTaskCounts};
}
export async function schema(apiKey) {
  const data=await request(apiKey,'/api/webapp/apiCallDemo',undefined,{apiKey,webappId:APP_ID});
  const nodes=data?.nodeInfoList;
  if(!Array.isArray(nodes)||!nodes.length||nodes.length>100)throw new RHError('invalid_app_schema');
  // Never retain the returned curl demo (it may echo the Key).
  const cleaned=nodes.map(n=>{
    if(!/^\d+$/.test(String(n.nodeId))||!/^\w+$/.test(n.fieldName)||!['string','number','boolean'].includes(typeof n.fieldValue))throw new RHError('invalid_app_schema');
    let fieldData=n.fieldData??null;
    if(typeof fieldData==='string'){try{fieldData=JSON.parse(fieldData);}catch{throw new RHError('invalid_app_schema');}}
    const item={nodeId:String(n.nodeId),fieldName:n.fieldName,fieldValue:n.fieldValue,fieldType:n.fieldType??null,fieldData};
    if(JSON.stringify(item).includes(apiKey))throw new RHError('credential_in_schema');
    return item;
  });
  if(new Set(cleaned.map(n=>n.nodeId+'.'+n.fieldName)).size!==cleaned.length)throw new RHError('duplicate_schema_fields');
  // Ignore mutable media dropdown lists; retain default video/LoRA values and parameter contracts.
  const fingerprint=createHash('sha256').update(JSON.stringify([...cleaned].sort((a,b)=>(a.nodeId+'.'+a.fieldName).localeCompare(b.nodeId+'.'+b.fieldName)).map(n=>({...n,fieldData:['image','audio','video'].includes(n.fieldName)?null:n.fieldData})))).digest('hex');
  return {nodes:cleaned,fingerprint};
}
export async function upload(apiKey,reference,snapshotBytes) {
  const ext=extname(reference.path).slice(1).toLowerCase();
  const mimes={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',mp4:'video/mp4',avi:'video/x-msvideo',mov:'video/quicktime',mkv:'video/x-matroska'};
  const mime=mimes[ext];if(!mime||mime.split('/')[0]!==reference.kind)throw Error('参考文件格式与 kind 不匹配');
  const sizeLimit=(reference.kind==='audio'?20:30)*1024*1024;
  const bytes=snapshotBytes??await readLimited(reference.path,sizeLimit);
  if(!Buffer.isBuffer(bytes)||bytes.length>sizeLimit)throw Error('参考素材快照无效或过大');
  const form=new FormData();form.append('apiKey',apiKey);form.append('fileType','input');form.append('file',new Blob([bytes],{type:mime}),basename(reference.path));
  const data=await request(apiKey,'/task/openapi/upload',form);
  if(typeof data?.fileName!=='string'||data.fileName.length>500||data.fileName.includes(apiKey))throw new RHError('invalid_upload_response');
  return data.fileName;
}
export async function submit(apiKey,nodes) {
  const data=await request(apiKey,'/task/openapi/ai-app/run',{apiKey,webappId:APP_ID,nodeInfoList:nodes});
  if(typeof data?.taskId!=='string'||!/^\d{1,40}$/.test(data.taskId))throw new RHError('missing_task_id');
  return data.taskId;
}
export async function taskStatus(apiKey,taskId) {
  const data=await request(apiKey,'/task/openapi/status',{apiKey,taskId});
  if(typeof data!=='string'||!['QUEUED','RUNNING','SUCCESS','FAILED','CANCELLED','CANCELED'].includes(data))throw new RHError('unknown_task_status');
  return data;
}
export async function outputs(apiKey,taskId) {
  const data=await request(apiKey,'/task/openapi/outputs',{apiKey,taskId});
  if(!Array.isArray(data))throw new RHError('invalid_outputs');
  return data.map(n=>{
    let url;try{url=new URL(n.fileUrl);}catch{throw new RHError('invalid_output_url');}
    if(url.protocol!=='https:'||url.username||url.password||url.href.includes(apiKey))throw new RHError('invalid_output_url');
    const amount=v=>v==null?null:/^\d+(\.\d+)?$/.test(String(v))?Number(v):null;
    return {fileUrl:url.href,fileType:typeof n.fileType==='string'&&/^\w{1,16}$/.test(n.fileType)?n.fileType:null,consumeCoins:amount(n.consumeCoins),consumeMoney:amount(n.consumeMoney),thirdPartyConsumeMoney:amount(n.thirdPartyConsumeMoney)};
  });
}
