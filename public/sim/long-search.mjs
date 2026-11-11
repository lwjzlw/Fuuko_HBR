import {waveScore} from '../boss-model.mjs';
import {partyContextKey,optimizationScope} from '../planner-results.mjs';
import {normalizeMinSuccess,normalizeSuccessBasis,resultLimit,rawIdentity} from './optimizer-options.mjs';

export const LONG_SEARCH_VERSION='joint-1';
export const longMinutes=value=>Math.max(1,Math.min(720,Math.trunc(Number(value)||60)));
const phaseNames={baseline:'复评起始轴',transfer:'沿同一轴换装与换人',axis:'改进已有行动轴',explore:'搜索阵容与排轴',validate:'独立复核入围轴'};

export function longSearchKey(input){
  const {opts,base}=input;
  const party=opts.fixedTeam&&opts.keepLoadout?base:base.filter(m=>opts.fixedTeam||m.statsManual?.length)
    .map(m=>[m.styleId,(m.statsManual||[]).map(k=>[k,m.stats?.[k]])]);
  return partyContextKey([LONG_SEARCH_VERSION,opts.battleVersion,opts.scopeKey||optimizationScope('',input),
    party,input.cache.decks,opts.goal,opts.fixedTeam,opts.keepLoadout,opts.broad,opts.teamElement,
    opts.minSuccess,opts.minSuccessBasis,opts.maxTurns,opts.optimizeCards,opts.searchRules,opts.seed,
    opts.mcRuns,opts.axisTrials,opts.beam,opts.screenBeam,opts.searchEvals,opts.searchBatch,opts.randomSeeds,
    opts.finalists,opts.transferTrials,opts.validationRuns,opts.validationSeed,opts.top]);
}

// Clearing a wave consumes at least one counted turn per phase. The damage
// contribution saturates at 6 billion per phase in this scoring model.
export function waveScoreCeiling(target){
  if(target.kind!=='wave'||!target.phases?.length)return null;
  const sets=target.ruleOptions?.length?target.ruleOptions:[target];
  return Math.max(...sets.map(s=>waveScore({damages:s.phases.map(()=>6e9),turns:s.phases.length,
    difficulty:target.difficulty??40,rules:s.rules||[],international:target.international!==false}).total));
}

const identityCache=new WeakMap();
function identity(candidate){
  if(!identityCache.has(candidate)){
    const members=candidate.members.map(m=>[rawIdentity(m.raw),m.deckSkillIds,m.statsManual,m.stats,m.front]);
    identityCache.set(candidate,partyContextKey([members,candidate.design,candidate.ruleIds]));
  }
  return identityCache.get(candidate);
}

function compare(a,b,goal,basis,isWave){
  const rate=t=>t.mc[basis]??0,mean=t=>t.mc.scoreMean??-Infinity,turns=t=>t.mc.turnsMedian??Infinity;
  let delta;
  if(goal==='fast')delta=turns(a)-turns(b)||rate(b)-rate(a)||mean(b)-mean(a);
  else if(goal==='stable'||!isWave)delta=b.mc.success-a.mc.success||rate(b)-rate(a)||mean(b)-mean(a)||turns(a)-turns(b);
  else delta=mean(b)-mean(a)||rate(b)-rate(a)||b.mc.success-a.mc.success;
  return delta||identity(a).localeCompare(identity(b));
}

function selectBank(all,opts,isWave){
  const basis=normalizeSuccessBasis(opts.minSuccessBasis),threshold=normalizeMinSuccess(opts.minSuccess);
  const unique=[...new Map(all.map(t=>[identity(t),t])).values()];
  const ranked=unique.sort((a,b)=>compare(a,b,opts.goal,basis,isWave));
  const qualified=ranked.filter(t=>t.mc[basis]>=threshold);
  const byRate=ranked.slice().sort((a,b)=>b.mc[basis]-a.mc[basis]||b.cleared-a.cleared||compare(a,b,opts.goal,basis,isWave));
  const variety=[],seen=new Set();
  for(const t of [...qualified,...ranked]){
    const k=t.members.map(m=>m.styleId).sort().join('|');
    if(!seen.has(k)){seen.add(k);variety.push(t);}
  }
  const take=resultLimit(opts.top);
  return {bank:[...new Set([...qualified.slice(0,take),...byRate.slice(0,4),...variety.slice(0,6),...ranked.slice(0,4)])],
    top:qualified.slice(0,take),qualifying:qualified.length,rejected:ranked.length-qualified.length,attempt:byRate[0]};
}

function parentsFor(bank,original,round,limit){
  if(!bank.length)return original.slice(0,limit);
  const rotated=bank.map((_,i)=>bank[(round+i)%bank.length]);
  return [...new Set([bank[0],...rotated.slice(0,Math.max(1,limit-2)),original[round%Math.max(1,original.length)],...rotated])].filter(Boolean).slice(0,limit);
}

// One resume unit is a completed search pass. Starting a further run adds
// the selected duration to the saved work and advances the deterministic seed.
export async function runLongSearch(input,{runPass,onProgress=()=>{},onCheckpoint=()=>{},checkpoint=null,
  now=Date.now,maxPasses=Infinity}={}){
  const opts=input.opts,key=longSearchKey(input),prior=checkpoint?.key===key&&checkpoint.version===LONG_SEARCH_VERSION?checkpoint:null;
  const original=input.incumbents||[],began=now(),limit=longMinutes(opts.longMinutes)*60000;
  const past=prior?.elapsed||0,ceiling=waveScoreCeiling(input.target),isWave=input.target.kind==='wave';
  let rounds=prior?.rounds||0,bank=prior?.bank||[],stats={screened:0,evaluated:0,iterations:0,resultCandidates:0,phaseSearches:0,expandedStates:0,axisEdits:0,...prior?.stats};
  let counts={...prior?.counts},moves={...prior?.moves},elapsed=()=>past+Math.max(0,now()-began);
  let errors=prior?.errors||[],errorCount=prior?.errorCount||0,lanes=prior?.threads||1;
  const validationSeed=()=>opts.validationSeed??((Math.imul(rounds^(opts.seed??97),0x85ebca6b)^0x2418abcd)>>>0);
  const selected=(list=bank)=>selectBank(list,opts,isWave);
  const summary=(s,validated)=>({top:s.top,goal:opts.goal,teamElement:opts.teamElement,
    searchVersion:LONG_SEARCH_VERSION,...stats,threads:lanes,elapsed:elapsed(),errors,errorCount,
    rejectedBySuccess:s.rejected,qualifiedCandidates:s.qualifying,minSuccess:opts.minSuccess,minSuccessBasis:opts.minSuccessBasis,
    attempt:s.attempt?{mc:s.attempt.mc,cleared:s.attempt.cleared,phases:input.target.phases.length}:null,
    longSearch:{rounds,counts:{...counts},moves:{...moves},phaseSearches:stats.phaseSearches,expandedStates:stats.expandedStates,
      axisEdits:stats.axisEdits,ceiling,validated,validationSeed:validated?validationSeed():null}});
  const exec=async(kind,parents)=>{
    const seed=((opts.seed??97)+Math.imul(rounds,0x9e3779b9))>>>0;
    const pass={...input,incumbents:parents,opts:{...opts,longSearch:true,longPassKind:kind,longPassIndex:rounds,seed,
      top:20,minSuccess:0,searchThreshold:opts.minSuccess,...(kind==='validate'?{mcSeed:validationSeed(),mcRuns:Math.max(opts.mcRuns||40,opts.validationRuns||96)}:{})}};
    const best=bank.find(t=>t.mc[normalizeSuccessBasis(opts.minSuccessBasis)]>=normalizeMinSuccess(opts.minSuccess));
    const announce=p=>onProgress({...p,step:p.step||kind,pass:rounds+1,passName:phaseNames[kind],
      best:best?.mc.scoreMean,elapsed:elapsed(),label:p.label||phaseNames[kind]});
    announce({done:0,total:0});
    const r=await runPass(pass,announce);
    if(!r||!Array.isArray(r.top))throw Error('本轮搜索没有返回可读取的结果');
    lanes=Math.max(lanes,r.threads||1);
    errorCount+=r.errors?.length||0;errors=[...errors,...(r.errors||[])].slice(-8);
    if(!r.top.length&&r.errors?.length&&!r.resultCandidates)throw Error(r.errors[0].error||'本轮候选评估失败');
    return r;
  };
  const cycle=['transfer','explore','axis','transfer','explore','axis'];
  const first=rounds;
  do{
    const kind=rounds===0?(original.length?'baseline':'explore'):cycle[(rounds-1)%cycle.length];
    const next=kind==='baseline'?original.slice(0,21):parentsFor(bank,original,rounds,kind==='explore'?3:4);
    let actual=kind;
    if(kind!=='baseline'&&!bank.length)actual='explore';
    else if(kind==='transfer'&&opts.fixedTeam&&opts.keepLoadout)actual='axis';
    const r=await exec(actual,next);
    counts[actual]=(counts[actual]||0)+1;
    for(const [k,v] of Object.entries(r.moves||{}))moves[k]=(moves[k]||0)+v;
    for(const k of Object.keys(stats))stats[k]+=Number(r[k])||0;
    const s=selectBank([...bank,...(r.frontier||r.top)],opts,isWave);bank=s.bank;rounds++;
    const result=summary(s,false);
    await onCheckpoint({key,version:LONG_SEARCH_VERSION,rounds,elapsed:result.elapsed,counts:{...counts},moves:{...moves},
      stats:{...stats},threads:lanes,errorCount,errors,bank,result});
  }while(rounds-first<maxPasses&&now()-began<limit);
  if(!bank.length)return summary(selected(),false);
  // Holdout numbers replace the search-sample scores. They never select
  // mutations or enter the population persisted for another run.
  const validation=[];
  for(let i=0;i<bank.length;i+=16){
    const r=await exec('validate',bank.slice(i,i+16));
    validation.push(...r.top);
  }
  return summary(selected(validation),true);
}
