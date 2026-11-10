import {validateSoulEnhancement} from './soul.mjs';
export const statNames={dp:'DP',str:'力量',dex:'灵巧',con:'体力',spr:'精神',wis:'智慧',luk:'幸运',sp:'初始 SP'};
export const socketStatKeys=['str','dex','con','spr','wis','luk'];
export const socketSlots=['ring','earring','bracelet','necklace','soul'];
export const slotNames={ring:'戒指',earring:'耳环',bracelet:'手镯',necklace:'项链',charm:'吊饰',orb:'宝玉',soul:'灵魂书',booster:'强化器',chip:'芯片',other:'其他'};
const statTypes={Dp:'dp',Power:'str',Dexterity:'dex',Toughness:'con',Spirit:'spr',Wisdom:'wis',Luck:'luk',Sp:'sp'};
export function describeEffect(e){return e.skill?.description||`${statNames[statTypes[e.type]]||e.type} ${e.value?.[0]>=0?'+':''}${e.value?.[0]??'？'}${e.valueType==='Ratio'?'%':''}`;}
export function defaultEquipment(entry){
  return {catalogId:entry.id,rollSelections:entry.rollGroups.map(g=>{
    if(!g.length||new Set(g.map(e=>e.type)).size!==1)return null;
    return g.reduce((best,e,i)=>((e.skill?(e.qualityTier??-1):e.value[0])>(g[best].skill?(g[best].qualityTier??-1):g[best].value[0]))?i:best,0);
  }),extraStats:{},socketStat:null,soulEnhancement:null};
}
export function evaluateEquipment(entry,selection){
  const stats=Object.fromEntries(Object.keys(statNames).map(k=>[k,0])),effects=[],missing=[];
  const add=e=>{const key=statTypes[e.type];if(key&&e.valueType==='RealNumber'&&!e.condition)stats[key]+=e.value[0];else if(e.skill)effects.push(describeEffect(e));else missing.push('未结算属性：'+describeEffect(e));};
  entry.effects.forEach(add);
  for(let i=0;i<entry.rollGroups.length;i++){const pick=selection.rollSelections?.[i];if(pick==null){missing.push('随机属性组 '+(i+1)+' 待选择');continue;}if(!Number.isInteger(pick)||!entry.rollGroups[i][pick])throw Error('饰品属性选项超出数据库范围');add(entry.rollGroups[i][pick]);}
  for(const [key,v] of Object.entries(selection.extraStats||{})){if(!(key in statNames)||!Number.isInteger(v)||v<0||v>999999)throw Error('附加属性应为非负整数');stats[key]+=v;}
  if(selection.socketStat!=null){
    if(!socketSlots.includes(entry.slot)||!socketStatKeys.includes(selection.socketStat))throw Error('开孔应选择一项六维属性');
    if(Object.values(selection.extraStats||{}).some(v=>v))throw Error('单项 +9 与手填孔位合计不能同时使用');
    stats[selection.socketStat]+=9;
  }
  if(Object.keys(selection.extraStats||{}).length)missing.push('附加孔位合计为手填值，尚未校验孔位分配');
  if(entry.slot==='soul'){
    validateSoulEnhancement(selection.soulEnhancement);for(const key of ['str','dex','con','spr','wis','luk'])stats[key]+=5;
    if(selection.soulEnhancement==null)missing.push('灵魂书强化值待填，仅计入原始说明中的基础全能力 +5');
    else if(selection.soulEnhancement>0)missing.push('灵魂书 +'+selection.soulEnhancement+' 强化增量表尚未接入，仅计基础全能力 +5');
  }
  return {stats,effects,missing,complete:missing.length===0};
}
export function evaluateLoadout(catalog,loadout,styles){
  const stats=Object.fromEntries(Object.keys(statNames).map(k=>[k,0])),effects=[],missing=[],rows=[];const slots=new Set();let booster=null,chipCount=0;
  for(const [selectionIndex,pick] of (loadout.equipment||[]).entries()){const entry=catalog.entries.find(x=>x.id===pick.catalogId);if(!entry){missing.push('目录缺失：'+pick.catalogId);continue;}
    if(entry.slot!=='chip'&&slots.has(entry.slot))missing.push('重复部位：'+slotNames[entry.slot]);slots.add(entry.slot);
    if(entry.slot==='booster')booster=entry;if(entry.slot==='chip')chipCount++;
    const resolved=styles&&entry.slot==='soul'?{...pick,soulEnhancement:styles[entry.styleId]?.soulBookLevel??null}:pick;
    const result=evaluateEquipment(entry,resolved);rows.push({entry,selection:resolved,selectionIndex,...result});for(const key in stats)stats[key]+=result.stats[key];effects.push(...result.effects);missing.push(...result.missing.map(x=>entry.name+'：'+x));
  }
  if(chipCount&&(!booster||chipCount>booster.chipSlots))missing.push('芯片数量超出所选强化器的槽位');
  return {stats,effects,missing,rows,complete:missing.length===0};
}
