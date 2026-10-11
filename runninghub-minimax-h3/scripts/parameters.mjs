import {resolve} from 'node:path';
import {readLimited} from './privateStore.mjs';

const slots={image:['141','142','143','161','175','176'],audio:['144','160','189'],video:['164']};
const mappings={prompt:['150','value'],durationSeconds:['186','value'],aspectRatio:['115','aspect_ratio'],megapixels:['147','value'],steps:['192','value'],promptOptimization:['185','value'],highestConsistency:['171','value'],interpolation:['169','value'],zipOnly:['158','value'],loraStrength:['159','strength_model']};
const roles={image:['reference','first-frame','last-frame','character','scene'],audio:['reference','voice','sound','music'],video:['reference','motion']};
function number(value,min,max,integer=false){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))throw Error('视频参数数值超出范围');return value;}
export async function manifest(path) {
  const raw=JSON.parse((await readLimited(path,1024*1024)).toString('utf8'));
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('manifest 无效');
  if((typeof raw.prompt==='string')===Boolean(raw.promptFile))throw Error('只能指定 prompt 或 promptFile 其中之一');
  const prompt=raw.prompt??(await readLimited(resolve(raw.promptFile),512*1024)).toString('utf8');
  if(!prompt.trim()||prompt.length>100000)throw Error('提示词为空或过长');
  const refs=raw.references??[];if(!Array.isArray(refs))throw Error('references 必须是数组');
  const counts={image:0,audio:0,video:0};
  const references=refs.map(r=>{
    if(!r||!Object.hasOwn(slots,r.kind)||!r.path||r.assetId||!roles[r.kind].includes(r.role??'reference'))throw Error('直接模式素材需 path、kind 与匹配 role；不支持 Manju assetId');
    if(++counts[r.kind]>slots[r.kind].length)throw Error('最多六图、三音频、一视频');
    return {path:resolve(r.path),kind:r.kind,role:r.role??'reference'};
  });
  for(const m of prompt.matchAll(/(?:@图片|@Image|@音频|@Audio|@视频|@Video)\s*(\d+)/gi)){
    const k=/图片|image/i.test(m[0])?'image':/音频|audio/i.test(m[0])?'audio':'video';
    if(Number(m[1])<1||Number(m[1])>counts[k])throw Error('提示词引用了缺失的素材编号');
  }
  const p=raw.parameters??{};if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!Object.hasOwn(mappings,k)||k==='prompt'))throw Error('未知 parameters 字段');
  const endpoints=[...prompt.matchAll(/(?:\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—~至]\s*)(\d+(?:\.\d+)?)\s*(?:s|秒)/gi)].map(m=>Number(m[1]));
  const inferred=endpoints.length?Math.max(...endpoints):10;
  const durationSeconds=number(p.durationSeconds??inferred,5,15,true);
  if(p.durationSeconds!==undefined&&endpoints.some(e=>e>durationSeconds))throw Error('时长小于提示词时间轴终点，不能静默截短');
  if(!p.aspectRatio&&references.some(r=>r.role==='first-frame'))throw Error('首帧素材请显式指定 aspectRatio，避免猜测尺寸');
  const aspectRatio=p.aspectRatio??'16:9';if(typeof aspectRatio!=='string'||!/^\d{1,2}:\d{1,2}$/.test(aspectRatio))throw Error('比例格式无效');
  const parameters={durationSeconds,aspectRatio,megapixels:number(p.megapixels??0.4,0.4,0.9),steps:number(p.steps??8,1,100,true),loraStrength:number(p.loraStrength??0,0,2)};
  for(const k of ['promptOptimization','highestConsistency','interpolation','zipOnly']){if(p[k]!==undefined&&typeof p[k]!=='boolean')throw Error('开关必须是 boolean');parameters[k]=p[k]??false;}
  const minCredits=raw.minCredits===undefined?undefined:number(raw.minCredits,0.001,1e12);
  return {prompt,references,parameters,minCredits};
}
export function buildNodes(app,input,uploaded) {
  const nodes=app.nodes.map(n=>({nodeId:n.nodeId,fieldName:n.fieldName,fieldValue:n.fieldValue}));
  function get(id,field){const n=app.nodes.find(n=>n.nodeId===id&&n.fieldName===field);if(!n)throw Error('实时应用输入槽已改变，停止生成');return n;}
  function set(id,field,value){get(id,field);nodes.find(n=>n.nodeId===id&&n.fieldName===field).fieldValue=String(value);}
  for(const [key,[id,field]] of Object.entries(mappings)){
    let value=key==='prompt'?input.prompt:input.parameters[key];
    if(key==='aspectRatio'){
      const n=get(id,field),options=[];
      function scan(x){if(Array.isArray(x))x.forEach(scan);else if(typeof x==='string')options.push(x);else if(x&&typeof x==='object'){if(typeof x.index==='string')options.push(x.index);if(Array.isArray(x.options))scan(x.options);}}
      scan(n.fieldData);const matches=[...new Set(options)].filter(x=>x===value||new RegExp('^'+value+'(?:\\s|[（(])').test(x));
      if(matches.length!==1)throw Error('比例无法唯一匹配实时枚举标签');value=matches[0];
    }
    // Numeric fieldData bounds are checked when present, as well as local conservative limits.
    const node=get(id,field),constraints=Array.isArray(node.fieldData)?node.fieldData.find(x=>x&&typeof x==='object'&&!Array.isArray(x)):null;
    if(typeof value==='number'&&constraints&&((typeof constraints.min==='number'&&value<constraints.min)||(typeof constraints.max==='number'&&value>constraints.max)))throw Error('参数超出实时 schema 范围');
    set(id,field,value);
  }
  get('159','lora_name'); // Preserve the app's default model name, never silently replace it.
  for(const [kind,ids] of Object.entries(slots)){
    const files=uploaded.filter(r=>r.kind===kind);
    ids.forEach((id,i)=>{const field=kind==='video'?'video':kind;get(id,field);if(kind!=='video'||files[i])set(id,field,files[i]?.fileName??'None');});
  }
  set('163','value',uploaded.some(r=>r.kind==='video'));
  return nodes;
}
