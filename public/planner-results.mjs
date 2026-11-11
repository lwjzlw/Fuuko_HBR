// Persistent, bounded result snapshots. Only the latest search batch is retained;
// adopted teams and axes remain in the archive's existing per-event records.
import {normalizeMinSuccess,normalizeSuccessBasis} from './sim/optimizer-options.mjs';
export const TEAM_ELEMENTS = ['', 'ice', 'fire', 'thunder', 'light', 'dark', 'nonelemental'];

export function normalizeResultSettings(settings = {}) {
  const count = Number(settings.top);
  return {
    teamElement: TEAM_ELEMENTS.includes(settings.teamElement) ? settings.teamElement : '',
    top: [5, 10, 20].includes(count) ? count : 10,
    minSuccess: normalizeMinSuccess(settings.minSuccess),
    minSuccessBasis: normalizeSuccessBasis(settings.minSuccessBasis),
  };
}

export function packOptimizationResult(targetKey, result, settings, selected = 0) {
  const normalized = normalizeResultSettings(settings);
  // Explicit fields keep worker diagnostics and internal search states out of
  // persistent archives. Member raw data is required for further local searches.
  const top = (result.top || []).slice(0, normalized.top).map(t => {
    const out = {};
    for (const key of ['label', 'newTeam', 'team', 'ruleIds', 'ruleNames', 'turns',
      'mc', 'design', 'cards', 'loadout', 'members', 'teamElement', 'elementShare', 'elementDamage']) {
      if (t[key] !== undefined) out[key] = t[key];
    }
    return out;
  });
  return structuredClone({
    targetKey, at: Date.now(), selected: Math.max(0, Math.min(selected, top.length - 1)),
    teamElement: normalized.teamElement, requested: normalized.top,
    minSuccess: normalized.minSuccess, minSuccessBasis: normalized.minSuccessBasis,
    battleVersion: settings.battleVersion||null, enemyContextKey: settings.enemyContextKey||null,
    rejectedBySuccess: result.rejectedBySuccess, qualifiedCandidates: result.qualifiedCandidates, resultCandidates: result.resultCandidates, attempt:result.attempt||null,
    goal: result.goal || settings.goal || 'score', elapsed: result.elapsed,
    evaluated: result.evaluated, screened: result.screened, threads: result.threads,
    scopeKey: settings.scopeKey || null, searchVersion: result.searchVersion || null,
    iterations: result.iterations, searchBudget: result.searchBudget, incumbents: result.incumbents,
    longSearch:result.longSearch,errorCount:result.errorCount??result.errors?.length??0,top,
  });
}

/** Keep the original indices so filtering never adopts a different saved axis. */
export function visibleCandidates(result,settings={}){
  const {minSuccess,minSuccessBasis}=normalizeResultSettings(settings);
  return (result?.top||[]).map((candidate,index)=>({candidate,index})).filter(({candidate})=>
    minSuccess===0||(Number.isFinite(candidate.mc?.[minSuccessBasis])&&candidate.mc[minSuccessBasis]>=minSuccess));
}

/** Old means included zero-score failures. Recover the successful mean only;
 * their successful P10 cannot be recovered from the old aggregate. */
export function successfulScores(mc = {}) {
  const successes=Number.isInteger(mc.successes)?mc.successes:
    Number.isFinite(mc.n)&&Number.isFinite(mc.success)?Math.round(mc.n*mc.success):null;
  const current=mc.scoreBasis==='successful';
  const mean=Number.isFinite(mc.scoreMean)?(current?mc.scoreMean:mc.success>0?mc.scoreMean/mc.success:null):null;
  const p10=Number.isFinite(mc.scoreP10)&&(current||mc.success===1)?mc.scoreP10:null;
  return {mean,p10,successes,samples:current?(mc.scoreSamples??successes):successes,converted:!current};
}

function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
  return value;
}

function signature(text){
  let a=2166136261,b=5381;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,16777619);b=(Math.imul(b,33)^c)>>>0;}
  return `v1:${text.length}:${(a>>>0).toString(16)}:${b.toString(16)}`;
}

export const partyContextKey=members=>signature(JSON.stringify(canonical(members)));

/** Action indices refer to positions in this particular ordered party. */
export function setPlannerMembers(planner,members){
  const roster=team=>JSON.stringify((team||[]).map(m=>m?.styleId||''));
  const old=roster(planner.members),next=roster(members);
  if(old!==next){
    const saved=planner.partyDesigns??={};
    if(Object.keys(planner.designs||{}).length||Object.keys(planner.best||{}).length){
      saved[old]={designs:planner.designs||{},best:planner.best||{}};
    }
    planner.designs=saved[next]?.designs||{};
    planner.best=saved[next]?.best||{};
    delete saved[next];
  }
  planner.members=members;
}

/** A local cache key, not a security hash. Search depth, thread count and the
 * automatically adopted base team do not invalidate otherwise reusable axes. */
export function optimizationScope(targetKey,input){
  const {target,opts,archive={},cache={},data={}}=input;
  const choices=target.ruleOptions?.length?target.ruleOptions:[{ids:(target.rules||[]).map(r=>r.id),rules:target.rules||[],phases:target.phases}];
  const text=JSON.stringify(canonical({targetKey,kind:target.kind,choices:choices.slice().sort((a,b)=>JSON.stringify(a.ids).localeCompare(JSON.stringify(b.ids))),
    difficulty:target.difficulty,international:target.international,overkill:opts.overkill,allOrbs:opts.allOrbs,
    optimizeCards:opts.optimizeCards,cards:opts.optimizeCards===false?target.cards:null,
    dataVersions:Object.fromEntries(['catalog','skills','stats','equipment'].map(k=>[k,{schema:data[k]?.schemaVersion,version:data[k]?.version,generatedAt:data[k]?.generatedAt}])),
    styles:archive.styles,characters:archive.characters,inventory:archive.gameInventory,moduleCounts:cache.moduleCounts,cardsOwned:cache.cards,accessories:cache.accessories}));
  return signature(text);
}

export function reusableCandidates(saved,targetKey,scopeKey,current=null){
  const list=saved?.targetKey===targetKey&&(!saved.scopeKey||saved.scopeKey===scopeKey)?saved.top||[]:[];
  const out=[],seen=new Set();
  for(const t of [current,...list]){
    if(!t?.members?.length||!t.design?.phases?.some(p=>p.turns?.some(r=>r.actions?.some(a=>a.s)||r.odStart||r.odEnd)))continue;
    const value={members:t.members,design:t.design,ruleIds:t.ruleIds||[],label:t.label||'已有方案'};
    const key=JSON.stringify([value.members,value.design,value.ruleIds]);if(seen.has(key))continue;seen.add(key);out.push(value);
    if(out.length>=21)break;
  }
  return structuredClone(out);
}

export function scoreGap(best, candidate) {
  if (!Number.isFinite(best) || !Number.isFinite(candidate)) return null;
  return Math.max(0, best - candidate);
}

// A score bonus does not guarantee a better final score: a difficult rule may
// cost more turns or cause failures. Include every legal subset, including none.
export function ruleCombinations(rules = [], maximum = 1) {
  const limit = Math.max(0, Math.min(rules.length, Math.trunc(Number(maximum) || 0)));
  const out = [];
  function visit(start, chosen) {
    out.push(chosen.slice());
    if (chosen.length === limit) return;
    for (let i = start; i < rules.length; i++) {
      chosen.push(rules[i]); visit(i + 1, chosen); chosen.pop();
    }
  }
  visit(0, []);
  return out;
}
