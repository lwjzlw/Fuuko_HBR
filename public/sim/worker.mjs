// 排轴搜索 Worker：主线程传入已组装的 party / enemy（纯数据），这里只跑搜索。
import {search} from './search.mjs';

self.onmessage=ev=>{
  const {party,enemy,statusTypes,options}=ev.data;
  try{
    const result=search({party,enemy,statusTypes},options,p=>self.postMessage({stage:'progress',...p}));
    self.postMessage({stage:'done',result});
  }catch(err){
    self.postMessage({stage:'error',message:err?.message||String(err)});
  }
};
