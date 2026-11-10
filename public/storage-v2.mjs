import {emptyArchive as emptyV1,validateArchive as validateV1} from './legacy-storage.mjs';
import {styleProgress,validateStyleProgress} from './catalog.mjs';
import {validatePlanner} from './sim/party.mjs';
export const SCHEMA=2;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const unsafe=k=>['__proto__','constructor','prototype'].includes(k);
function numeric(v,label,min=0){if(v!==undefined&&v!==null&&(!Number.isInteger(v)||v<min||v>999999))throw Error(`${label} 应为整数或留空`);}
function mode(v,values,label){if(v!==undefined&&v!==null&&!values.includes(v))throw Error(label+' 无效');}
export function emptyArchive(catalog={version:'unknown'}){
  const base=emptyV1();delete base.roster;
  return {...base,schemaVersion:2,catalogVersion:catalog.version,characters:{},styles:{},legacyRecords:[],legacySnapshots:[],importHistory:[]};
}
export function validateArchive(a,catalog){
  if(!object(a)||a.schemaVersion!==SCHEMA)throw Error('备份版本不支持');
  if(a.progressDefaults!==undefined){
    if(!object(a.progressDefaults))throw Error('默认养成格式无效');
    for(const k of ['characterLevelMode','cardLevelMode','skillLevelMode'])mode(a.progressDefaults[k],['max','recorded'],'等级模式');
    mode(a.progressDefaults.latentSelectionMode,['optimize','fixed'],'潜在词条选择模式');
  }
  for(const key of ['characters','styles'])if(!object(a[key])||Object.keys(a[key]).length>5000||Object.keys(a[key]).some(unsafe))throw Error(`${key} 格式无效`);
  for(const [id,p] of Object.entries(a.characters)){
    if(!object(p))throw Error('角色养成格式错误');
    for(const k of ['level','reincarnation','rank','latentLevel'])numeric(p[k],`${id} ${k}`,k==='level'?1:0);
    if(p.masterSkillUnlocked!==undefined&&p.masterSkillUnlocked!==null&&typeof p.masterSkillUnlocked!=='boolean')throw Error('角色精通状态无效');
    mode(p.levelMode,['max','recorded'],'角色等级模式');mode(p.latentPoolMode,['unknown','all','selected'],'潜在词条池');
    if(p.availableLatentIds!==undefined&&(!Array.isArray(p.availableLatentIds)||p.availableLatentIds.some(x=>typeof x!=='string')||new Set(p.availableLatentIds).size!==p.availableLatentIds.length))throw Error('角色潜在词条池无效');
  }
  for(const [id,p] of Object.entries(a.styles)){
    if(!object(p)||typeof p.owned!=='boolean')throw Error('卡面拥有状态无效');
    numeric(p.cardLevel,'卡面等级',0);numeric(p.limitBreak,'突破');
    if(p.latentStats!==undefined){if(!object(p.latentStats))throw Error('潜在数值格式无效');for(const [k,v] of Object.entries(p.latentStats)){if(!['dp','str','dex','con','spr','wis','luk'].includes(k))throw Error('未知潜在数值属性');numeric(v,'潜在数值 '+k);}}
    if(p.latentPanels!==undefined){if(!object(p.latentPanels))throw Error('潜在面板节点格式无效');for(const [k,v] of Object.entries(p.latentPanels)){if(!['str','dex','con','spr','wis','luk'].includes(k))throw Error('未知潜在面板属性');numeric(v,'潜在面板节点 '+k);}}
    numeric(p.soulBookLevel,'灵魂书强化',0);
    for(const k of ['cardLevelMode','skillLevelMode','soulBookLevelMode'])mode(p[k],['max','recorded'],'等级模式');
    for(const k of ['bloomed','soulBook'])if(p[k]!==undefined&&p[k]!==null&&typeof p[k]!=='boolean')throw Error(`${k} 状态无效`);
    if(p.latentSlots!==undefined&&(!Array.isArray(p.latentSlots)||p.latentSlots.length!==3||p.latentSlots.some(x=>x!==null&&typeof x!=='string')))throw Error('潜在能力应包含三个槽位');
    if(p.skillLevels!==undefined&&!object(p.skillLevels))throw Error('技能等级格式错误');
    for(const v of Object.values(p.skillLevels||{}))numeric(v,'技能等级',1);
    if(p.training!==undefined&&!object(p.training))throw Error('强化状态格式错误');
    for(const v of Object.values(p.training||{}))if(v!==null&&(!Array.isArray(v)||v.some(x=>typeof x!=='string')||new Set(v).size!==v.length))throw Error('强化节点记录格式错误');
    // Catalog changes must not make a previously saved archive unreadable.
    // Current catalog eligibility is checked when editing a style, not when loading it.
  }
  for(const key of ['items','loadouts']){
    if(!Array.isArray(a[key])||a[key].length>5000)throw Error(`${key} 格式无效`);
    const ids=new Set();for(const x of a[key]){if(!object(x)||typeof x.id!=='string'||!x.id||unsafe(x.id)||ids.has(x.id)||typeof x.name!=='string')throw Error(`${key} 存在无效或重复 ID`);ids.add(x.id);}
  }
  for(const x of a.items)if(!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>999)throw Error('装备数量无效');
  const itemIds=new Set(a.items.map(x=>x.id)),loadoutIds=new Set(a.loadouts.map(x=>x.id));
  for(const l of a.loadouts)if(!Array.isArray(l.itemIds)||l.itemIds.some(x=>!itemIds.has(x))||new Set(l.itemIds).size!==l.itemIds.length)throw Error('配装引用了无效或重复装备');
  for(const l of a.loadouts)if(l.equipment!==undefined){
    if(!Array.isArray(l.equipment)||l.equipment.length>20)throw Error('具体装备格式无效');
    for(const p of l.equipment){if(!object(p)||typeof p.catalogId!=='string'||!p.catalogId||!Array.isArray(p.rollSelections)||p.rollSelections.some(x=>x!==null&&(!Number.isInteger(x)||x<0)))throw Error('具体装备属性选项无效');if(p.extraStats!==undefined){if(!object(p.extraStats))throw Error('装备附加属性格式无效');for(const [k,v]of Object.entries(p.extraStats)){if(!['dp','str','dex','con','spr','wis','luk','sp'].includes(k))throw Error('未知装备属性');numeric(v,'装备附加属性');}}numeric(p.soulEnhancement,'灵魂强化',0);if(p.socketStat!=null&&!['str','dex','con','spr','wis','luk'].includes(p.socketStat))throw Error('开孔属性无效');}
  }
  if(!Array.isArray(a.team)||a.team.length!==6)throw Error('队伍需要六个位置');
  for(const t of a.team)if(!object(t)||typeof t.styleId!=='string'||typeof t.loadoutId!=='string'||(t.styleId&&!a.styles[t.styleId])||(t.loadoutId&&!loadoutIds.has(t.loadoutId)))throw Error('队伍引用不存在');
  for(const t of a.team)if(t.supportStyleId!==undefined&&(typeof t.supportStyleId!=='string'||(t.supportStyleId&&!a.styles[t.supportStyleId])))throw Error('支援引用不存在');
  if(a.teamReference!==undefined){const r=a.teamReference;if(!object(r)||!Array.isArray(r.members)||r.members.length!==6||!Number.isInteger(r.totalPower)||r.totalPower<0)throw Error('截图核对记录无效');for(const m of r.members){if(!object(m)||typeof m.styleId!=='string'||typeof m.supportStyleId!=='string')throw Error('截图成员无效');for(const k of ['power','supportPower','level','limitBreak','reincarnation'])if(!Number.isInteger(m[k])||m[k]<0)throw Error('截图数值无效');}}
  if(a.planner!==undefined)validatePlanner(a.planner);
  for(const key of ['legacyRecords','legacySnapshots','importHistory'])if(a[key]!==undefined&&!Array.isArray(a[key]))throw Error('历史数据格式无效');
  for(const r of a.legacyRecords||[])if(!object(r)||typeof r.id!=='string'||!object(r.data)||typeof r.data.character!=='string'||typeof r.data.name!=='string')throw Error('旧版记录格式无效');
  for(const h of a.importHistory||[])if(!object(h)||!Array.isArray(h.conflicts)||h.conflicts.some(x=>typeof x!=='string'))throw Error('合并历史格式无效');
  return a;
}
export function migrateArchive(old,catalog){
  if(old.schemaVersion===2){const a=structuredClone(old);for(const k of ['legacyRecords','legacySnapshots','importHistory'])a[k]??=[];return validateArchive(a,catalog);}
  validateV1(old);const a=emptyArchive(catalog),snapshotId=crypto.randomUUID();
  a.assumptions={...a.assumptions,...old.assumptions};a.items=structuredClone(old.items);a.loadouts=structuredClone(old.loadouts);a.notes=old.notes||'';
  a.legacySnapshots=[{id:snapshotId,kind:'v1',payload:structuredClone(old)}];
  a.legacyRecords=old.roster.map(record=>({id:crypto.randomUUID(),snapshotId,originalId:record.id,data:structuredClone(record),linkedStyleId:null}));
  return validateArchive(a,catalog);
}
export function linkLegacy(a,recordId,styleId,catalog){
  const next=structuredClone(a),record=next.legacyRecords.find(x=>x.id===recordId),style=catalog.styles.find(x=>x.id===styleId);
  if(!record||!style)throw Error('旧记录或目标卡面不存在');
  const p=styleProgress(next,styleId);p.owned=true;
  if(p.limitBreak==null&&record.data.limitBreak!=null&&record.data.limitBreak<=Math.max(...style.limitBreakSteps.map(x=>x.step)))p.limitBreak=record.data.limitBreak;
  p.legacyRecordIds=[...new Set([...(p.legacyRecordIds||[]),recordId])];next.styles[styleId]=p;record.linkedStyleId=styleId;
  const source=next.legacySnapshots.find(x=>x.id===record.snapshotId);
  if(source?.payload.team.some(slot=>slot.styleId===record.originalId))record.wasInLegacyTeam=true;
  return validateArchive(next,catalog);
}
export function checkTeam(a,catalog){
  const issues=[],seen=new Set(),used=new Map();
  a.team.forEach((slot,i)=>{
    const style=catalog.styles.find(x=>x.id===slot.styleId);
    if(!style){issues.push(`位置 ${i+1} 尚未选择有效卡面`);return;}
    if(!a.styles[style.id]?.owned)issues.push(`「${style.name}」未标记拥有`);
    const character=catalog.characters.find(x=>x.id===style.characterId);
    if(seen.has(style.characterId))issues.push(`角色「${character.name}」重复出场`);seen.add(style.characterId);
    for(const id of a.loadouts.find(x=>x.id===slot.loadoutId)?.itemIds||[])used.set(id,(used.get(id)||0)+1);
  });
  if(a.assumptions?.checkEquipmentInventory)for(const [id,count] of used){const item=a.items.find(x=>x.id===id);if(item&&count>item.quantity)issues.push(`「${item.name}」需 ${count} 件，只有 ${item.quantity} 件`);}
  return issues;
}
export function mergeArchive(current,incoming,catalog){
  validateArchive(incoming,catalog);const out=structuredClone(current),conflicts=[];
  const merge=(a,b,path)=>{
    if(b===null||b===undefined)return a;
    if(a===null||a===undefined)return structuredClone(b);
    if(JSON.stringify(a)===JSON.stringify(b))return a;
    const numericProgress=/^characters\.[^.]+\.(level|reincarnation|rank|latentLevel)$/.test(path)||/^styles\.[^.]+\.(cardLevel|limitBreak|soulBookLevel|skillLevels\..+|(?:latentStats|latentPanels)\.[^.]+)$/.test(path);
    if(numericProgress&&typeof a==='number'&&typeof b==='number'){conflicts.push(path);return Math.max(a,b);}
    if(/^characters\.[^.]+\.masterSkillUnlocked$/.test(path)||/^styles\.[^.]+\.(owned|bloomed|soulBook)$/.test(path)){conflicts.push(path);return a===true||b===true;}
    if((/^characters\.[^.]+\.availableLatentIds$/.test(path)||/^styles\.[^.]+\.training\..+$/.test(path))&&Array.isArray(a)&&Array.isArray(b))return [...new Set([...a,...b])];
    if(/^characters\.[^.]+\.latentPoolMode$/.test(path)&&a==='unknown')return b;
    if(object(a)&&object(b)){const r={...a};for(const [k,v] of Object.entries(b)){if(unsafe(k))throw Error('不安全的备份字段');r[k]=merge(a[k],v,path+'.'+k);}return r;}
    conflicts.push(path);return a;
  };
  for(const [id,p] of Object.entries(incoming.characters))out.characters[id]=merge(out.characters[id],p,'characters.'+id);
  if(incoming.progressDefaults)out.progressDefaults=merge(out.progressDefaults,incoming.progressDefaults,'progressDefaults');
  for(const [id,p] of Object.entries(incoming.styles)){
    const owned=!!(out.styles[id]?.owned||p.owned);out.styles[id]=merge(out.styles[id],p,'styles.'+id);out.styles[id].owned=owned;
  }
  const maps={};for(const key of ['items','loadouts']){maps[key]=new Map();for(const item of incoming[key]){
    const mapped=key==='loadouts'?{...structuredClone(item),itemIds:item.itemIds.map(x=>maps.items.get(x))}:structuredClone(item);
    const existing=out[key].find(x=>x.id===item.id);
    if(existing&&JSON.stringify(existing)===JSON.stringify(mapped)){maps[key].set(item.id,item.id);continue;}
    const id=existing?crypto.randomUUID():item.id;maps[key].set(item.id,id);out[key].push({...mapped,id});
  }}
  const legacyIds=new Map();for(const snapshot of incoming.legacySnapshots||[]){const id=crypto.randomUUID();legacyIds.set(snapshot.id,id);out.legacySnapshots.push({...structuredClone(snapshot),id});}
  const recordIds=new Map();for(const record of incoming.legacyRecords||[]){const id=crypto.randomUUID();recordIds.set(record.id,id);out.legacyRecords.push({...structuredClone(record),id,snapshotId:legacyIds.get(record.snapshotId)||record.snapshotId});}
  for(const [styleId,p] of Object.entries(incoming.styles))if(p.legacyRecordIds)out.styles[styleId].legacyRecordIds=[...new Set([...(current.styles[styleId]?.legacyRecordIds||[]),...p.legacyRecordIds.map(id=>recordIds.get(id)||id)])];
  out.importHistory.push({at:new Date().toISOString(),conflicts,payload:structuredClone(incoming)});
  return validateArchive(out,catalog);
}
