import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {basename,extname,resolve} from 'node:path';

export const RH_BASE='https://www.runninghub.ai';
export const APP_ID='2084320751339032577';
const SLOT_KEYS=[
  ...['141','142','143','161','175','176'].map(id=>`${id}.image`),
  ...['144','160','189'].map(id=>`${id}.audio`),
  '164.video','163.value','150.value','186.value','115.aspect_ratio',
  '147.value','192.value','185.value','171.value','169.value','158.value','159.strength_model','159.lora_name',
];
const EXPECTED_TYPES={
  '150.value':'STRING','186.value':'INT','115.aspect_ratio':'LIST',
  '141.image':'IMAGE','142.image':'IMAGE','143.image':'IMAGE','161.image':'IMAGE','175.image':'IMAGE','176.image':'IMAGE',
  '144.audio':'AUDIO','160.audio':'AUDIO','189.audio':'AUDIO','164.video':'VIDEO','163.value':'BOOLEAN',
  '147.value':'FLOAT','192.value':'INT','185.value':'BOOLEAN','171.value':'BOOLEAN','169.value':'BOOLEAN','158.value':'BOOLEAN','159.strength_model':'FLOAT','159.lora_name':'LORA',
};
const MEDIA_TYPES={
  png:['image/png','image'],jpg:['image/jpeg','image'],jpeg:['image/jpeg','image'],webp:['image/webp','image'],
  mp3:['audio/mpeg','audio'],wav:['audio/wav','audio'],flac:['audio/flac','audio'],
  mp4:['video/mp4','video'],avi:['video/x-msvideo','video'],mov:['video/quicktime','video'],mkv:['video/x-matroska','video'],
};
// 只扩大请求等待预算，保持轮询频率、单次提交与异常暂停策略不变。
const timeoutSignal=(ms=30000)=>AbortSignal.timeout(ms*3);

async function jsonRequest(url,init={},timeout=30000){
  let response;
  try{response=await fetch(url,{...init,redirect:'error',signal:timeoutSignal(timeout)});}catch{throw Error('RunningHub connection failed. Remote state was not confirmed.');}
  if(!response.ok){await response.body?.cancel();throw Error(`RunningHub returned HTTP ${response.status}.`);}
  try{return await response.json();}catch{throw Error('RunningHub returned an unreadable response.');}
}
function decodeNuxt(values){
  const cache=new Map();
  function decode(index,depth=0){
    if(depth>100||!Number.isInteger(index))throw Error('RunningHub application metadata is invalid.');
    if(index<0)return null;if(cache.has(index))return cache.get(index);const value=values[index];
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value)){
      if(['ShallowReactive','Reactive','Ref','ShallowRef'].includes(String(value[0])))return decode(Number(value[1]),depth+1);
      const out=[];cache.set(index,out);for(const item of value[0]==='Set'?value.slice(1):value)out.push(decode(Number(item),depth+1));return out;
    }
    const out=Object.create(null);cache.set(index,out);for(const [key,item]of Object.entries(value))out[key]=decode(Number(item),depth+1);return out;
  }
  return decode(0);
}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{ };}
function fieldsFingerprint(detail,fields){return createHash('sha256').update(JSON.stringify({appId:APP_ID,workflowId:detail.workflowId??null,updateTime:detail.updateTime??null,appState:detail.webappState,workflowState:detail.workflowState,fields})).digest('hex');}
function fieldKey(field){return `${field.nodeId}.${field.fieldName}`;}

export async function inspectH3Schema(){
  const response=await fetch(`${RH_BASE}/ai-detail/${APP_ID}`,{redirect:'error',signal:timeoutSignal(20000)}).catch(()=>{throw Error('Could not refresh the public RunningHub H3 app schema.');});
  if(!response.ok){await response.body?.cancel();throw Error(`The public H3 app page returned HTTP ${response.status}.`);}
  const html=await response.text();if(Buffer.byteLength(html)>8*1024*1024)throw Error('The public H3 app page exceeded the size limit.');
  const match=html.match(/<script[^>]*id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if(!match)throw Error('The public H3 app page did not expose a readable input schema.');
  let root;try{root=object(decodeNuxt(JSON.parse(match[1])));}catch{throw Error('The public H3 app schema could not be decoded.');}
  const data=object(root.data);const entry=Object.entries(data).find(([key])=>key.startsWith(`ai-detail-${APP_ID}-`));const detail=object(object(entry?.[1]).detail);
  if(String(detail.id)!==APP_ID||!Array.isArray(detail.inputNodes))throw Error('The public app schema does not match the fixed H3 application.');
  const fields=detail.inputNodes.map(node=>{
    const item=object(node);if(!item.nodeId||!item.fieldName)throw Error('The public H3 app schema contains an invalid input.');
    let options;try{const parsed=JSON.parse(String(item.fieldData??'null'));if(Array.isArray(parsed))options=parsed;}catch{throw Error('The public H3 app schema contains invalid parameter options.');}
    return {nodeId:String(item.nodeId),fieldName:String(item.fieldName),fieldType:String(item.fieldType??'').toUpperCase(),defaultValue:item.fieldValue,options};
  }).sort((a,b)=>fieldKey(a).localeCompare(fieldKey(b)));
  const byKey=new Map(fields.map(field=>[fieldKey(field),field]));
  if(byKey.size!==SLOT_KEYS.length||fields.length!==SLOT_KEYS.length)throw Error('H3 app input layout changed; refusing to use stale node mappings.');
  for(const key of SLOT_KEYS)if(!byKey.has(key)||byKey.get(key).fieldType!==EXPECTED_TYPES[key])throw Error(`H3 app input changed at ${key}; refusing to submit.`);
  if(Number(detail.webappState)!==1)throw Error('The fixed H3 application is not publicly active.');
  const ratioField=byKey.get('115.aspect_ratio');
  const choices=ratioField.options?.flatMap(item=>Array.isArray(object(item).options)?object(item).options:[])??[];
  if(!choices.some(value=>String(value).startsWith('16:9')))throw Error('The H3 app aspect-ratio choices could not be verified.');
  return {fingerprint:fieldsFingerprint(detail,fields),fields,byKey,checkedAt:new Date().toISOString()};
}

export async function verifyConsumerKey(apiKey){
  const result=await jsonRequest(`${RH_BASE}/uc/openapi/accountStatus`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({apikey:apiKey})});
  if(Number(result.code)!==0)throw Error('RunningHub did not verify this consumer key.');
  const data=object(result.data);
  return {apiType:typeof data.apiType==='string'?data.apiType:null,remainCoins:numberOrNull(data.remainCoins),remainMoney:numberOrNull(data.remainMoney),currency:typeof data.currency==='string'?data.currency:null,currentTaskCount:numberOrNull(data.currentTaskCounts),checkedAt:new Date().toISOString()};
}
function numberOrNull(value){if(value===undefined||value===null||value===''||typeof value==='boolean')return null;const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;}

function localMedia(path,expectedKind){
  const ext=extname(path).slice(1).toLowerCase(),definition=MEDIA_TYPES[ext];
  if(!definition)throw Error(`Unsupported reference file type: ${basename(path)}.`);
  if(definition[1]!==expectedKind)throw Error(`Reference type does not match its file extension: ${basename(path)}.`);
  return {mimeType:definition[0],safeName:basename(path).replace(/[^a-zA-Z0-9_.-]/g,'_')};
}
function imageDimensions(bytes,extension){
  if(extension==='png'&&bytes.length>=24&&bytes.toString('ascii',1,4)==='PNG')return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  if(extension==='jpg'||extension==='jpeg'){
    let offset=2;while(offset+4<bytes.length){if(bytes[offset]!==0xff){offset++;continue;}while(bytes[offset]===0xff)offset++;const marker=bytes[offset++];if(marker===0xd8||marker===0xd9||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;if(offset+2>bytes.length)break;const size=bytes.readUInt16BE(offset);if(size<2||offset+size>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&size>=7)return {height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)};offset+=size;}
  }
  if(extension==='webp'&&bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    const chunk=bytes.toString('ascii',12,16);
    if(chunk==='VP8X')return {width:1+bytes[24]+(bytes[25]<<8)+(bytes[26]<<16),height:1+bytes[27]+(bytes[28]<<8)+(bytes[29]<<16)};
    if(chunk==='VP8 '&&bytes.length>=30)return {width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff};
    if(chunk==='VP8L'&&bytes.length>=25&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);return {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};}
  }
  return null;
}
export async function validateReferences(references){
  if(!Array.isArray(references))throw Error('references must be an array.');
  const counts={image:0,audio:0,video:0},seen=new Set(),normalized=[];
  for(const ref of references){
    if(!ref||!['image','audio','video'].includes(ref.kind)||typeof ref.path!=='string')throw Error('Each reference needs a local path and kind: image, audio, or video.');
    const roles=['reference','first-frame','last-frame','character','scene','motion','voice','sound','music'];if(ref.role!==undefined&&!roles.includes(ref.role))throw Error('Reference role is not supported.');
    const path=resolve(ref.path),identity=path.toLowerCase();if(seen.has(identity))throw Error('The same local reference path cannot be used more than once.');seen.add(identity);
    const media=localMedia(path,ref.kind),info=await stat(path);if(!info.isFile())throw Error('Each reference path must point to a regular file.');
    const limit=(ref.kind==='audio'?20:30)*1024*1024;if(info.size<=0||info.size>limit)throw Error(`Reference file size is outside the allowed range: ${basename(path)}.`);
    counts[ref.kind]++;if(counts[ref.kind]>{image:6,audio:3,video:1}[ref.kind])throw Error('H3 supports at most six images, three audio references and one video reference.');
    const bytes=await readFile(path);if(bytes.length===0||bytes.length>limit)throw Error(`Reference file size changed during validation: ${basename(path)}.`);const entry={path,kind:ref.kind,role:ref.role||'reference',mimeType:media.mimeType,safeName:media.safeName,sha256:createHash('sha256').update(bytes).digest('hex')};
    if(ref.kind==='image'&&entry.role==='first-frame')entry.dimensions=imageDimensions(bytes,extname(path).slice(1).toLowerCase());
    normalized.push(entry);
  }
  const first=normalized.filter(ref=>ref.role==='first-frame');if(first.length>1)throw Error('Only one first-frame image may be specified.');
  if(normalized.some(ref=>['first-frame','last-frame','character','scene'].includes(ref.role)&&ref.kind!=='image'))throw Error('First/last-frame, character and scene references must be images.');
  return {references:normalized,counts};
}
export function validateH3Input(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('H3 input must be a JSON object.');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>12000)throw Error('A non-empty prompt of at most 12,000 characters is required.');
  const {references,counts}=input._validatedReferences;
  for(const kind of ['Picture','Audio','Video']){
    const key=kind.toLowerCase()==='picture'?'image':kind.toLowerCase();const count=counts[key];
    for(const match of input.prompt.matchAll(new RegExp(`<${kind}\\s+(\\d+)>`,'g')))if(Number(match[1])<1||Number(match[1])>count)throw Error(`Prompt reference ${match[0]} has no matching local reference.`);
  }
  const labels={image:'Picture',audio:'Audio',video:'Video'},indices={image:0,audio:0,video:0};
  for(const ref of references){const label=`<${labels[ref.kind]} ${++indices[ref.kind]}>`;if(ref.role!=='reference'&&!input.prompt.includes(label))throw Error(`Describe ${label} as ${ref.role} in the prompt; the original text will not be rewritten.`);}
  const p=input.parameters??{};if(!p||typeof p!=='object'||Array.isArray(p))throw Error('parameters must be a JSON object.');
  const allowed=new Set(['durationSeconds','aspectRatio','megapixels','steps','promptOptimization','highestConsistency','interpolation','zipOnly','loraStrength']);
  if(Object.keys(p).some(key=>!allowed.has(key)))throw Error('parameters contains an unsupported field.');
  const inferred=inferDuration(input.prompt),duration=p.durationSeconds??inferred??10;
  if(!Number.isInteger(duration)||duration<5||duration>15)throw Error('durationSeconds must be an integer from 5 through 15.');
  if(inferred!==null&&inferred>duration)throw Error('Prompt timeline exceeds durationSeconds; resolve the conflict instead of truncating it.');
  const aspects=['1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9'];
  const aspectRatio=p.aspectRatio??(deriveAspect(references)??'16:9');if(!aspects.includes(aspectRatio))throw Error('Unsupported H3 aspect ratio.');
  const number=(name,fallback,min,max)=>{const v=p[name]??fallback;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(`Invalid ${name}.`);return v;};
  const bool=(name,fallback=false)=>{const v=p[name]??fallback;if(typeof v!=='boolean')throw Error(`Invalid ${name}.`);return v;};
  const steps=number('steps',8,1,50);if(!Number.isInteger(steps))throw Error('steps must be an integer.');
  return {prompt:input.prompt,references,parameters:{durationSeconds:duration,aspectRatio,megapixels:number('megapixels',0.4,0.1,2),steps,promptOptimization:bool('promptOptimization'),highestConsistency:bool('highestConsistency'),interpolation:bool('interpolation'),zipOnly:bool('zipOnly'),loraStrength:number('loraStrength',0,0,2)}};
}
function inferDuration(prompt){
  const ranges=[...prompt.matchAll(/(\d+(?:\.\d+)?)\s*(?:s|秒|seconds?)?\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|秒|s)(?![a-z])/gi)];
  for(const match of ranges)if(Number(match[1])>Number(match[2]))throw Error('Prompt timeline is reversed.');
  const seconds=[...prompt.matchAll(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|秒)(?![a-z])/gi)];
  const values=[...ranges.map(m=>Number(m[2])),...seconds.map(m=>Number(m[1]))];return values.length?Math.max(...values):null;
}
function deriveAspect(references){
  const dimensions=references.find(ref=>ref.role==='first-frame')?.dimensions;if(!dimensions?.width||!dimensions?.height)return null;
  const ratios=['1:1','2:3','3:2','3:4','4:3','9:16','16:9','21:9'];const actual=dimensions.width/dimensions.height;
  return ratios.reduce((best,value)=>Math.abs(Number(value.split(':')[0])/Number(value.split(':')[1])-actual)<Math.abs(Number(best.split(':')[0])/Number(best.split(':')[1])-actual)?value:best,ratios[0]);
}

export async function uploadReference(apiKey,reference){
  const bytes=await readFile(reference.path);if(bytes.length===0||bytes.length>(reference.kind==='audio'?20:30)*1024*1024||createHash('sha256').update(bytes).digest('hex')!==reference.sha256)throw Error('Reference file changed after it was prepared.');
  const form=new FormData();form.append('apiKey',apiKey);form.append('fileType','input');form.append('file',new Blob([bytes],{type:reference.mimeType}),reference.safeName);
  const result=await jsonRequest(`${RH_BASE}/task/openapi/upload`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form},120000);
  const fileName=object(result.data).fileName;if(Number(result.code)!==0||typeof fileName!=='string'||!fileName)throw Error('RunningHub did not accept a reference upload.');
  return fileName;
}
function ratioChoice(schema,aspect){
  const field=schema.byKey.get('115.aspect_ratio');const choices=field.options?.flatMap(item=>Array.isArray(object(item).options)?object(item).options:[])??[];
  const selected=choices.find(value=>String(value).split(/\s+/)[0]===aspect);if(selected===undefined)throw Error(`The H3 app does not currently offer ${aspect}.`);return selected;
}
function setValue(values,key,value){values[key]=value;}
export function buildNodeInfo(schema,input,uploadedNames){
  const p=input.parameters,values=Object.create(null);
  setValue(values,'150.value',input.prompt);setValue(values,'186.value',p.durationSeconds);setValue(values,'115.aspect_ratio',ratioChoice(schema,p.aspectRatio));
  const imageSlots=['141.image','142.image','143.image','161.image','175.image','176.image'];
  const audioSlots=['144.audio','160.audio','189.audio'];
  imageSlots.forEach((key,i)=>setValue(values,key,uploadedNames.images[i]??'None'));
  audioSlots.forEach((key,i)=>setValue(values,key,uploadedNames.audios[i]??'None'));
  setValue(values,'164.video',uploadedNames.video??schema.byKey.get('164.video').defaultValue);
  setValue(values,'163.value',Boolean(uploadedNames.video));
  setValue(values,'147.value',p.megapixels);setValue(values,'192.value',p.steps);setValue(values,'185.value',p.promptOptimization);setValue(values,'171.value',p.highestConsistency);setValue(values,'169.value',p.interpolation);setValue(values,'158.value',p.zipOnly);setValue(values,'159.strength_model',p.loraStrength);setValue(values,'159.lora_name',schema.byKey.get('159.lora_name').defaultValue);
  const required=new Set(['150.value','186.value','115.aspect_ratio']);
  return SLOT_KEYS.flatMap(key=>{
    const [nodeId,fieldName]=key.split('.');const value=values[key];if(value===undefined||value===null||value===''){if(required.has(key))throw Error(`Missing H3 parameter ${key}.`);return [];}
    if(typeof value==='number')for(const option of schema.byKey.get(key).options??[]){const bound=object(option);if((typeof bound.min==='number'&&value<bound.min)||(typeof bound.max==='number'&&value>bound.max))throw Error(`H3 parameter ${key} is outside the live schema bounds.`);}
    return [{nodeId,fieldName,fieldValue:typeof value==='string'?value:JSON.stringify(value)}];
  });
}

export async function submitH3(apiKey,nodeInfoList){
  // The caller has already durably written status=submitting. This request is never automatically retried.
  let response;
  try{response=await fetch(`${RH_BASE}/task/openapi/ai-app/run`,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({apiKey,webappId:APP_ID,nodeInfoList}),signal:timeoutSignal(120000)});}
  catch{return {status:'submission_unknown',error:'RunningHub acceptance could not be confirmed. Do not submit this operation again.'};}
  if(!response.ok){await response.body?.cancel();return {status:'submission_unknown',error:`RunningHub acceptance could not be confirmed (HTTP ${response.status}). Do not submit this operation again.`};}
  let body;try{body=await response.json();}catch{return {status:'submission_unknown',error:'RunningHub returned an unreadable response after submit. Do not submit this operation again.'};}
  if(body.code===undefined||!Number.isFinite(Number(body.code)))return {status:'submission_unknown',error:'RunningHub returned no acceptance code. Do not submit this operation again.'};
  if(Number(body.code)!==0)return {status:'failed',error:`RunningHub rejected the submission (code ${String(body.code)}).`};
  const taskId=object(body.data).taskId;if(typeof taskId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(taskId))return {status:'submission_unknown',error:'RunningHub accepted the request but returned no usable task ID. Do not submit this operation again.'};
  return {status:'submitted',taskId,usage:extractUsage(body)};
}
export async function queryTask(apiKey,taskId){
  const body=await jsonRequest(`${RH_BASE}/task/openapi/outputs`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({apiKey,taskId})});
  const code=Number(body.code),usage=extractUsage(body);
  if(code===804)return {status:'running',usage};if(code===813)return {status:'queued',usage};if(code===805)return {status:'failed',error:'RunningHub task failed.',usage};
  if(code!==0)throw Error('RunningHub task state is not confirmed.');
  const records=Array.isArray(body.data)?body.data:[object(body.data)];const outputs=records.flatMap(item=>typeof item.fileUrl==='string'?[safeOutput(item)]:[]);
  if(!outputs.length)throw Error('RunningHub returned success without a downloadable output.');
  return {status:'succeeded',outputs,usage};
}
export async function downloadTaskOutput(apiKey,taskId,index){
  if(!Number.isInteger(index)||index<0||index>9)throw Error('Output index is invalid.');
  const body=await jsonRequest(`${RH_BASE}/task/openapi/outputs`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({apiKey,taskId})});
  if(Number(body.code)!==0)throw Error('RunningHub output is not ready.');
  const records=Array.isArray(body.data)?body.data:[object(body.data)],item=records[index];
  if(typeof item?.fileUrl!=='string')throw Error('RunningHub output was not found.');
  let target;try{target=new URL(item.fileUrl);}catch{throw Error('RunningHub output URL is invalid.');}
  if(target.protocol!=='https:'||target.username||target.password)throw Error('RunningHub output must use a safe HTTPS URL.');
  const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(360000)});
  if(!response.ok){await response.body?.cancel();throw Error('RunningHub output download failed.');}
  return response;
}
function safeOutput(item){
  let url=null,requiresRunningHubAccount=false;
  try{
    const parsed=new URL(item.fileUrl);const sensitive=['rh-comfy-auth','rh-identify','token','access_token','signature','sig','auth','authorization','apikey','api_key'];
    if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password){
      const host=parsed.hostname.toLowerCase(),trusted=host==='runninghub.ai'||host.endsWith('.runninghub.ai')||host==='xiaoyaoyou.com'||host.endsWith('.xiaoyaoyou.com');
      if(!trusted||[...parsed.searchParams.keys()].some(key=>{const name=key.toLowerCase();return sensitive.includes(name)||/^(x-amz-|x-goog-|x-oss-)/.test(name)||['awsaccesskeyid','googleaccessid','ossaccesskeyid','key-pair-id','policy'].includes(name);}))requiresRunningHubAccount=true;
      else url=parsed.toString();
    }else requiresRunningHubAccount=true;
  }catch{requiresRunningHubAccount=true;}
  return {url,requiresRunningHubAccount,mimeType:typeof item.mimeType==='string'?item.mimeType:null,fileType:typeof item.fileType==='string'?item.fileType:null};
}
function extractUsage(body){
  const dataRecords=Array.isArray(body.data)?body.data.map(object):[object(body.data)];
  const records=[object(body.usage),...dataRecords,object(body)].filter(record=>['consumeCoins','consumeMoney','thirdPartyConsumeMoney','currency'].some(key=>record[key]!==undefined));
  const unique=(key,convert)=>{const values=records.filter(record=>record[key]!==undefined).map(record=>convert(record[key]));if(!values.length||values.some(value=>value===null)||new Set(values.map(value=>JSON.stringify(value))).size!==1)return null;return values[0];};
  return {rhCoins:unique('consumeCoins',numberOrNull),walletAmount:unique('consumeMoney',numberOrNull),thirdPartyAmount:unique('thirdPartyConsumeMoney',numberOrNull),currency:unique('currency',value=>typeof value==='string'?value:null)};
}
