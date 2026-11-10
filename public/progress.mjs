// User-authorized inexpensive upgrades are stored as ordinary progression.
import {validateSoulEnhancement} from './soul.mjs';
export const STYLE_LEVEL_CAP=20;
export const maxBreak=style=>Math.max(...style.limitBreakSteps.map(x=>x.step));
export function applyDefaultProgress(current,catalog){
  const a=structuredClone(current);
  for(const c of catalog.characters){
    a.characters[c.id]={...a.characters[c.id],latentPoolMode:a.characters[c.id]?.latentPoolMode||'unknown'};
  }
  for(const s of catalog.styles){
    const previous=a.styles[s.id];let p=previous?{...previous}:null;
    if(['A','S'].includes(s.tier))p={...p,owned:true,limitBreak:maxBreak(s),bloomed:p?.bloomed??false};
    if(s.soulBook)p={owned:false,...p,soulBook:true};
    if(p)a.styles[s.id]=p;
  }
  return recordMaxLevels(a,catalog);
}
export function recordMaxLevels(current,catalog){
  const a=structuredClone(current);delete a.progressDefaults;
  for(const p of Object.values(a.characters))delete p.levelMode;
  for(const s of catalog.styles){
    const p=a.styles[s.id];if(!p)continue;
    delete p.cardLevelMode;delete p.skillLevelMode;
    if(p.owned){p.cardLevel=Math.max(p.cardLevel??0,STYLE_LEVEL_CAP);p.skillLevels={...p.skillLevels};for(const sk of s.skills)p.skillLevels[sk.id]=Math.max(p.skillLevels[sk.id]??0,sk.maxLevel);}
  }
  return a;
}
export function advanceStyles(current,catalog,ids,patch){
  let a=structuredClone(current);
  for(const id of new Set(ids)){
    const s=catalog.styles.find(x=>x.id===id);if(!s)throw Error('找不到卡面 '+id);
    const p=a.styles[id]||{owned:false},next={};
    for(const [key,value] of Object.entries(patch)){
      if(value==null)continue;
      if(['owned','bloomed','soulBook'].includes(key))next[key]=p[key]===true||value===true;
      else if(['limitBreak','cardLevel','soulBookLevel'].includes(key))next[key]=Math.max(p[key]??0,value==='max'?maxBreak(s):value);
      else throw Error('快捷更新不支持此字段');
    }
    a=patchStyles(a,catalog,[id],next);
    if(!p.owned&&next.owned){const added=a.styles[id];added.cardLevel=Math.max(added.cardLevel??0,STYLE_LEVEL_CAP);added.skillLevels={...added.skillLevels};for(const sk of s.skills)added.skillLevels[sk.id]=sk.maxLevel;}
  }
  return a;
}
export function clearAssumedSoulLevels(current){
  const a=structuredClone(current);
  for(const p of Object.values(a.styles))if(p.soulBookLevelMode==='max'){
    p.soulBookLevel=null;p.soulBookLevelMode='recorded';
  }
  return a;
}
export function availableLatents(catalog,a,characterId){
  const p=a.characters[characterId]||{},eligible=catalog.latentAbilities.filter(l=>!l.characterId||l.characterId===characterId);
  return p.latentPoolMode==='all'?eligible:p.latentPoolMode==='selected'?eligible.filter(l=>(p.availableLatentIds||[]).includes(l.id)):[];
}
export function validateCharacterLatents(catalog,characterId,p){
  const eligible=new Set(catalog.latentAbilities.filter(l=>!l.characterId||l.characterId===characterId).map(l=>l.id));
  for(const id of p.availableLatentIds||[])if(!eligible.has(id))throw Error('潜在词条不适用于此角色');
  // Mutually exclusive variants may both be owned; exclusions apply when equipping.
}
export function patchStyles(a,catalog,ids,patch){
  const next=structuredClone(a);
  for(const id of new Set(ids)){
    const s=catalog.styles.find(x=>x.id===id);if(!s)throw Error('找不到卡面 '+id);
    const actual={...patch};if(actual.limitBreak==='max')actual.limitBreak=maxBreak(s);
    if(actual.limitBreak!=null&&(!Number.isInteger(actual.limitBreak)||actual.limitBreak<0||actual.limitBreak>maxBreak(s)))throw Error('突破阶段超出该卡面的范围');
    if(actual.soulBookLevel!=null){if(!s.soulBook)throw Error('该卡面没有灵魂书记录');validateSoulEnhancement(actual.soulBookLevel);}
    next.styles[id]={owned:false,...next.styles[id],...actual};
  }
  return next;
}
