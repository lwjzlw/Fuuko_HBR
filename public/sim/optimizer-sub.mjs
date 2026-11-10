// 配置优化的计算子 Worker：先收 {init:input} 建上下文，之后逐个处理 {id,task}（eval / final），回 {id,result}。
import {createTaskHandler} from './optimizer.mjs';
let handle=null;
self.onmessage=ev=>{
  const m=ev.data;
  if(m.init){handle=createTaskHandler(m.init);return;}
  try{self.postMessage({id:m.id,result:handle(m.task)});}
  catch(err){self.postMessage({id:m.id,error:err?.message||String(err)});}
};
