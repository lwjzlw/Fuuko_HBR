const DATABASE='hbr-planner-search',STORE='checkpoints';
let connection;
function database(){
  if(!connection)connection=new Promise((resolve,reject)=>{
    const open=indexedDB.open(DATABASE,1);
    open.onupgradeneeded=()=>open.result.createObjectStore(STORE);
    open.onsuccess=()=>resolve(open.result);
    open.onerror=()=>reject(open.error);
  });
  return connection;
}
export async function readCheckpoint(key){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const request=db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess=()=>resolve(request.result||null);
    request.onerror=()=>reject(request.error);
  });
}
export async function writeCheckpoint(record){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
    const current=store.get(record.key);
    current.onsuccess=()=>{
      if((current.result?.rounds||0)<=record.rounds)store.put(record,record.key);
    };
    tx.oncomplete=()=>resolve();
    tx.onabort=tx.onerror=()=>reject(tx.error||Error('搜索进度保存失败'));
  });
}
