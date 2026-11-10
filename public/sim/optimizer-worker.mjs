// 配置优化 Worker（协调者）：生成候选、维护精英，把评估 / 挑卡 / 模拟分给多个计算子 Worker 并行。
// 主线程传入纯数据；opts.threads 指定子 Worker 数（默认 = 逻辑核数 − 2，上限 12）。不支持嵌套 Worker 时回退单线程。
import {optimize} from './optimizer.mjs';

function workerPool(input,n){
  const workers=[],idle=[],queue=[],jobs=new Map();let seq=0;
  const pump=()=>{while(idle.length&&queue.length){const w=idle.pop(),j=queue.shift();w._job=j.id;jobs.set(j.id,j);w.postMessage({id:j.id,task:j.task});}};
  for(let i=0;i<n;i++){
    const w=new Worker(new URL('./optimizer-sub.mjs',import.meta.url),{type:'module'});
    w.onmessage=ev=>{const {id,result,error}=ev.data;const j=jobs.get(id);jobs.delete(id);w._job=null;idle.push(w);
      if(j){error?j.reject(new Error(error)):j.resolve(result);}pump();};
    w.onerror=ev=>{ev.preventDefault?.();const j=jobs.get(w._job);if(j){jobs.delete(w._job);j.reject(new Error(ev.message||'子 Worker 出错'));}w._job=null;idle.push(w);pump();};
    w.postMessage({init:input});
    workers.push(w);idle.push(w);
  }
  return {size:n,run:task=>new Promise((resolve,reject)=>{queue.push({id:++seq,task,resolve,reject});pump();}),close(){for(const w of workers)w.terminate();}};
}

self.onmessage=async ev=>{
  const input=ev.data;
  const hc=self.navigator?.hardwareConcurrency||4;
  const n=Math.max(1,Math.min(12,input.opts?.threads||hc-2));
  let pool=null;
  try{
    if(n>1&&typeof Worker!=='undefined')pool=workerPool(input,n);
    const result=await optimize(input,p=>self.postMessage({stage:'progress',...p}),pool);
    self.postMessage({stage:'done',result});
  }catch(err){self.postMessage({stage:'error',message:err?.message||String(err)});}
  finally{pool?.close();}
};
