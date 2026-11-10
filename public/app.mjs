import {emptyArchive,validateArchive,mergeArchive,migrateArchive} from './storage.mjs';
import {loadCatalog,ownedStyles} from './catalog.mjs';
import {createCatalogUI} from './catalog-ui.mjs';
import {createBoxUI} from './box-ui.mjs';
import {createBossUI} from './boss-ui.mjs';
import {createPlannerUI} from './planner-ui.mjs';
import {createStore,readLocalArchive} from './persist.mjs';
import {syncCacheArchive} from './cache-sync.mjs';
const catalog=await loadCatalog().catch(error=>{document.getElementById('content').textContent='数据库加载失败：'+error.message;throw error;});
const equipment=await fetch('/data/equipment.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('装备目录加载失败');return r.json();});
const $=s=>document.querySelector(s);
const e=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=x=>Number(x).toLocaleString('zh-CN',{maximumFractionDigits:1});
const TABS=['box','planner','boss'];
const TAB_ALIASES={roster:'box',team:'box',equipment:'box',lab:'box',design:'box'};// 旧书签
let archive=emptyArchive(catalog),tab='box',pendingImport=null;
// 档案存在本机服务端 archive.json；浏览器 localStorage 只读旧版数据，迁移后不删除
const MIGRATED_KEY='hbr-axis-migrated-to-server';
const timeText=()=>new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
const store=createStore({onStatus:(state,detail)=>{const s=$('#save-status');if(!s)return;s.dataset.state=state;s.textContent=state==='saving'?'保存中…':state==='saved'?'已保存 '+timeText():'保存失败 · 重试';if(state==='error')notice('保存到本机档案失败：'+detail+'。改动仍在本页，点右上角“保存失败 · 重试”，或先导出备份。',true);}});
let loadFailed=null,migrated=false,localOffer=null,dataDir='';
try{
  const server=await store.load();dataDir=server.data_dir||'';
  let local=null;try{local=readLocalArchive();}catch{local=null;}
  if(server.archive){archive=migrateArchive(server.archive,catalog);let done=null;try{done=localStorage.getItem(MIGRATED_KEY);}catch{}if(local&&!done)localOffer=local;}
  else if(local){archive=migrateArchive(local.value,catalog);migrated=true;}
}catch(error){loadFailed=error;}

// 顶部提示条：普通提示 12 秒后自动收起，出错的提示要手动关
let noticeTimer=null;
function notice(message,sticky=false){
  const bar=$('#notice');clearTimeout(noticeTimer);
  if(!message){bar.hidden=true;return;}
  bar.querySelector('span').textContent=message;bar.hidden=false;bar.classList.toggle('is-error',sticky);
  if(!sticky)noticeTimer=setTimeout(()=>{bar.hidden=true;},12000);
}
$('#notice button').onclick=()=>notice('');
function save(){if(loadFailed){notice('本机档案读取失败，为免覆盖已暂停保存：'+loadFailed.message,true);return false;}return store.save(archive);}
function markMigrated(){try{localStorage.setItem(MIGRATED_KEY,new Date().toISOString());}catch{}}
function download(name,data){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function backup(){download('hbr-养成档案-'+new Date().toISOString().slice(0,10)+'.json',archive);notice('已导出备份 JSON。');}
function input(label,name,value='',type='text',extra=''){return `<label>${label}<input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;}
function area(label,name,value='',extra=''){return `<label class="full">${label}<textarea name="${name}" ${extra}>${e(value)}</textarea></label>`;}
function select(label,name,value,list){return `<label>${label}<select name="${name}" aria-label="${e(label)}">${list.map(x=>{const [v,t]=Array.isArray(x)?x:[x,x];return `<option value="${e(v)}" ${v===value?'selected':''}>${e(t)}</option>`;}).join('')}</select></label>`;}
function openDialog(title,body,onSubmit,okLabel='保存'){
  $('#dialog-content').innerHTML=`<form id="edit-form"><div class="dialog-head"><h2>${e(title)}</h2><button type="button" id="dialog-close" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div><p id="dialog-error" class="pill-error compact" role="alert"></p><div class="dialog-actions"><button type="button" id="dialog-cancel">取消</button><button class="primary" type="submit">${e(okLabel)}</button></div></form>`;
  $('#dialog-close').onclick=$('#dialog-cancel').onclick=()=>$('#editor').close();
  $('#edit-form').onsubmit=event=>{event.preventDefault();try{const data=new FormData(event.target);onSubmit(data,event.target);$('#editor').close();render();}catch(error){$('#dialog-error').textContent=error.message;}};
  $('#editor').showModal();
}
function readNum(data,name){const value=data.get(name)?.trim();return value===''?null:Number(value);}
function render(){
  $('#roster-count').textContent=ownedStyles(catalog,archive).length;
  document.querySelectorAll('[data-tab]').forEach(b=>{const on=b.dataset.tab===tab;b.classList.toggle('active',on);b.setAttribute('aria-current',on?'page':'false');});
  document.body.dataset.tab=tab;
  ({box:renderBox,planner:renderPlanner,boss:renderBoss})[tab]();
}
const {editStyle,editCharacter}=createCatalogUI({catalog,getArchive:()=>archive,setArchive:value=>{archive=value;},save,notice,openDialog,e,input,select,area,readNum,render,download});
const boxUI=createBoxUI({catalog,getArchive:()=>archive,e,editStyle,editCharacter,notice});
function mount(ui){const host=document.createElement('div');$('#content').replaceChildren(host);ui.mount(host);}
function renderBox(){mount(boxUI);}
const bossUI=createBossUI({e,n,notice});
function renderBoss(){mount(bossUI);}
const plannerUI=createPlannerUI({e,n,notice,catalog,equipment,getArchive:()=>archive,save,cacheDecks:()=>store.cacheDecks()});
function renderPlanner(){mount(plannerUI);}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;history.replaceState(null,'','#'+tab);render();scrollTo({top:0});});
$('.hbr-brand').onclick=ev=>{ev.preventDefault();tab='box';history.replaceState(null,'','#box');render();};

function commitImport(incoming,mode){
  const next=mode==='replace'?incoming:mergeArchive(archive,incoming,catalog);
  store.snapshot(archive,mode==='replace'?'before-replace':'before-merge').catch(error=>notice('导入前快照失败：'+error.message,true));
  if(mode==='replace')backup();
  const previous=archive;archive=structuredClone(next);
  if(!save()){archive=previous;throw Error('导入未保存，请先导出备份后重试。');}
  notice('备份已导入。');
}
async function syncFromGame(){
  if(loadFailed){notice('本机档案读取失败，暂停同步：'+loadFailed.message,true);return;}
  const button=$('#cache-sync');button.disabled=true;button.textContent='读取中…';
  try{
    const result=await syncCacheArchive({
      getArchive:()=>archive,
      getPreview:value=>store.cachePreview(value),
      snapshot:value=>store.snapshot(value,'before-game-sync'),
      validate:value=>validateArchive(value,catalog),
      commit:value=>{const previous=archive;archive=value;if(!save()){archive=previous;throw Error('同步未排队保存');}},
    });
    render();
    notice(`${result.applied.length?`已从游戏更新 ${result.applied.length} 项`:'游戏里没有新的变化'}${result.skipped.length?`；${result.skipped.length} 项数据不完整，保持原值`:''}${result.warnings.length?'；'+result.warnings.join('；'):''}。`);
  }catch(error){notice('从游戏同步失败，档案没有改动：'+error.message,true);}
  finally{button.disabled=false;button.textContent='从游戏同步';}
}
$('#cache-sync').onclick=syncFromGame;

// “更多”菜单：导入/导出备份、数据目录、主题
const moreMenu=$('#more-menu'),moreToggle=$('#more-toggle');
function setMore(open){moreMenu.hidden=!open;moreToggle.setAttribute('aria-expanded',String(open));if(open)moreMenu.querySelector('button').focus();}
moreToggle.onclick=()=>setMore(moreMenu.hidden);
document.addEventListener('pointerdown',ev=>{if(!moreMenu.hidden&&!ev.target.closest('.more'))setMore(false);});
moreMenu.addEventListener('keydown',ev=>{
  const items=[...moreMenu.querySelectorAll('button')],i=items.indexOf(document.activeElement),step={ArrowDown:1,ArrowUp:-1}[ev.key];
  if(step){ev.preventDefault();items[(i+step+items.length)%items.length].focus();}
  if(ev.key==='Escape'){setMore(false);moreToggle.focus();}
});
moreMenu.addEventListener('click',ev=>{if(ev.target.closest('button'))setMore(false);});
$('#export').onclick=backup;
$('#open-data').onclick=()=>store.openDataDir().catch(error=>notice('打开数据目录失败：'+error.message,true));
$('#theme-toggle').onclick=()=>window.hbrToggleTheme?.();
$('#import-open').onclick=()=>{$('#import-file').value='';$('#import-file').click();};
$('#import-file').onchange=async ev=>{
  const file=ev.target.files[0];if(!file)return;
  try{
    if(file.size>10*1024*1024)throw Error('备份超过 10 MB，请先检查文件。');pendingImport=migrateArchive(JSON.parse(await file.text()),catalog);
    openDialog('导入备份',`<p>文件里有 ${Object.values(pendingImport.styles).filter(p=>p.owned).length} 张已拥有的卡面。</p>${select('导入方式','mode','merge',[['merge','合并：只补新增和提升，不降低现有记录'],['replace','替换：先下载当前备份，再整份换成文件内容']])}<p class="subtle">合并按数据库 ID 对应，突破、等级等取较高值，空值不覆盖。导入前会自动快照当前档案。</p>`,data=>{
      commitImport(pendingImport,data.get('mode'));pendingImport=null;
    },'导入');
  }catch(error){notice('导入失败，当前档案没有改动：'+error.message,true);}
};
$('#save-status').onclick=()=>store.retry();

const hash=location.hash.slice(1);
if(TABS.includes(hash))tab=hash;else if(TAB_ALIASES[hash])tab=TAB_ALIASES[hash];
render();
if(loadFailed)notice('本机档案读取失败，已暂停保存，避免覆盖：'+loadFailed.message+'。请检查数据目录。',true);
else if(migrated){store.snapshot(archive,'migrate-from-browser').catch(()=>{});save();markMigrated();notice('已把这个浏览器里的旧版档案迁入本机档案（'+(dataDir||'数据目录')+'）；浏览器原始数据保留未删。');}
else if(localOffer){
  let incoming=null;try{incoming=migrateArchive(localOffer.value,catalog);}catch(error){notice('浏览器里有旧版档案但无法读取：'+error.message+'。原数据保留未动。',true);}
  if(incoming)openDialog('发现浏览器里的旧版档案',`<p>这个浏览器还存着 v0.5 及以前的档案（${Object.values(incoming.styles).filter(p=>p.owned).length} 张已拥有卡面）。本机档案已存在，可以把它合并进来。</p>${select('处理方式','mode','merge',[['merge','合并：只补新增与提升，不降低现有数据'],['skip','不合并，以后不再提示']])}<p class="subtle">合并前会自动快照当前本机档案；浏览器里的原始数据不会被删除。</p>`,data=>{if(data.get('mode')==='merge')commitImport(incoming,'merge');markMigrated();},'确定');
}
if(location.hash==='#sync'&&!loadFailed&&!migrated&&!localOffer)syncFromGame();
if(!loadFailed&&$('#save-status').textContent==='读取中…'){$('#save-status').dataset.state='saved';$('#save-status').textContent=migrated?'迁移中…':'已同步';}
setInterval(()=>fetch('/api/health',{cache:'no-store'}).catch(()=>{}),60000);
addEventListener('beforeunload',event=>{if(store.dirty){event.preventDefault();event.returnValue='';}});
