import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseFlags} from './keyPool.mjs';
import {runDirect,probe} from './directH3.mjs';
import {RHError} from './runninghubApi.mjs';

export async function run(args){
  const [action,...rest]=args,f=parseFlags(rest,['manifest','journal','poolDirectory','keyId','taskId','confirm']);
  if(action==='probe')return probe(f.poolDirectory);
  return runDirect(action,f);
}
export function safeError(e){
  if(e instanceof RHError)return {error:e.kind,code:e.code??null,notice:'未输出平台响应、URL 或凭据；提交异常时查询同一 journal，不自动重提'};
  if(['pool_busy','pool_exhausted','account_busy','balance_checks_exhausted'].includes(e?.code))return {error:e.code};
  return {error:'local_operation_failed',notice:'核对参数、私有目录、journal 和本地锁；不自动重提远端任务'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify(safeError(e)));process.exitCode=1;});
