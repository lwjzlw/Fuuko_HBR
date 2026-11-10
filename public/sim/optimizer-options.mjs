import {ATTACK_PART_TYPES,elementOf} from './hbr/model.mjs';

export const TEAM_ELEMENTS=['ice','fire','thunder','light','dark','nonelemental'];
export function normalizeTeamElement(value){
  const el=String(value||'').toLowerCase();
  if(!el||el==='any')return '';
  if(!TEAM_ELEMENTS.includes(el))throw new Error('未知队伍输出属性：'+el);
  return el;
}
export const resultLimit=value=>Math.max(1,Math.min(20,Math.trunc(Number(value)||10)));
/** Minimum simulated rate; the separately selected basis defines what counts. */
export function normalizeMinSuccess(value){
  const n=Number(value);
  return Number.isFinite(n)?Math.max(0,Math.min(1,n)):0;
}
export const normalizeSuccessBasis=value=>value==='success'?'success':'onPlan';

// Budget describes completed work, not wall-clock time. A slow machine or a
// busy Worker must not silently explore a different set of candidates.
export const SEARCH_PRESETS={
  quick:{label:'快',searchEvals:48,searchBatch:12,randomSeeds:12,screenBeam:4,beam:8,finalists:12,mcJudge:3,mcRuns:24,seed:97},
  standard:{label:'标准',searchEvals:144,searchBatch:12,randomSeeds:24,screenBeam:4,beam:12,finalists:18,mcJudge:3,mcRuns:32,seed:97},
  deep:{label:'深入',searchEvals:360,searchBatch:12,randomSeeds:36,screenBeam:5,beam:18,finalists:24,mcJudge:3,mcRuns:40,seed:97},
};
export function searchBudget(opts={}){
  const legacy=opts.searchMs==null?144:opts.searchMs<=0?0:Math.ceil(opts.searchMs/1000*2.4);
  const count=Number(opts.searchEvals??legacy);
  return {evaluations:Math.max(0,Math.min(5000,Number.isFinite(count)?Math.trunc(count):144)),
    batch:Math.max(1,Math.min(48,Math.trunc(Number(opts.searchBatch)||12)))};
}

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
