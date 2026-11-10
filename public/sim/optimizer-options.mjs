import {ATTACK_PART_TYPES,elementOf} from './hbr/model.mjs';

export const TEAM_ELEMENTS=['ice','fire','thunder','light','dark','nonelemental'];
export function normalizeTeamElement(value){
  const el=String(value||'').toLowerCase();
  if(!el||el==='any')return '';
  if(!TEAM_ELEMENTS.includes(el))throw new Error('未知队伍输出属性：'+el);
  return el;
}
export const resultLimit=value=>Math.max(1,Math.min(20,Math.trunc(Number(value)||10)));

// Presentation metadata cannot affect a fight. All other raw fields, including
// equipment rolls, support, skills and slot order, belong to candidate identity.
const META=new Set(['_new','_changes','_earNote','_skills']);
function ordered(value){
  if(Array.isArray(value))return value.map(ordered);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,ordered(value[k])]));
  return value;
}
export function rawIdentity(raw){return JSON.stringify(ordered(Object.fromEntries(Object.entries(raw).filter(([k])=>!META.has(k)))));}
export function candidateIdentity(raws,front,rule=0){return JSON.stringify([raws.map(rawIdentity),front||raws.map((_,i)=>i<3),rule]);}

/** Attack capability, including conditional branches; never uses role labels. */
export function attackElements(skills){
  const out=new Set();
  const walk=parts=>{for(const p of parts||[]){
    if(ATTACK_PART_TYPES.has(p.skillType)&&p.skillType!=='AttackNormal')out.add(elementOf(p));
    for(const b of p.branches||[])walk(b.parts);
  }};
  for(const s of skills||[])if(!s.passive)walk(s.parts);
  return out;
}

/** Actual skill attack damage, excluding ordinary attacks and untyped DoT. */
export function elementSummary(damage={},selected=''){
  const entries=TEAM_ELEMENTS.map(e=>[e,Math.max(0,Number(damage?.[e])||0)]);
  const total=entries.reduce((n,[,v])=>n+v,0),max=Math.max(0,...entries.map(([,v])=>v));
  const dominant=entries.find(([,v])=>v>0&&v===max)?.[0]||'';
  const amount=selected?Math.max(0,Number(damage?.[selected])||0):max;
  return {teamElement:selected||dominant,elementDamage:Object.fromEntries(entries),elementShare:total?amount/total:0,
    elementMatch:!selected||(amount>0&&amount>=max)};
}
