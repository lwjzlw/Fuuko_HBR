// Boss / scene data helpers built on hbr.quest public master data.
// Score formula follows the hbr.quest calculator (third-party implementation);
// action order and rule timing are inferences that still need in-game checks.

export const ELEMENTS=['fire','ice','thunder','light','dark','nonelement'];
export const ATTACK_TYPES=['slash','stab','strike'];
export const ELEMENT_LABEL={fire:'火',ice:'冰',thunder:'雷',light:'光',dark:'暗',nonelement:'无',slash:'斩',stab:'突',strike:'打'};
export const DEBUFF_LABEL={stun:'眩晕',bind:'束缚',fragile:'脆弱',confusion:'混乱',imprison:'禁锢',virus:'病毒',illusion:'幻惑',recoil:'反冲'};

const trunc=Math.trunc;
const round2=x=>Math.round(x*100)/100;

/** Rule score multiplier: 1 + Σ grade/100 for the selected rules. */
export function ruleMultiplier(rules=[]){return rules.reduce((m,r)=>m+(Number(r?.grade)||0)/100,1);}

export function turnLimit(calc,stage){return (calc?.calc_ver||0)>0?(stage?.turnLimit||0):(calc?.etc||0);}

/** Turn multiplier used by calc_ver ≥ 2 (piecewise linear, rounded to 0.01). */
export function turnMultiplier(calc,stage,turns){
  const s=calc.btr,t=calc.btcfr,e=calc.min_tr,a=calc.max_tr,limit=turnLimit(calc,stage);
  if(!(turns>1))return round2(a/1e4);
  if(turns<=t)return round2((t-turns)*((a-s)/(1e4*(t-1)))+s/1e4);
  return round2((limit-turns)*((s-e)/(1e4*(limit-t)))+e/1e4);
}

/** Damage part: linear up to the cap, logarithmic beyond it. `damage` = the scored damage (max single turn). */
export function damageScore(calc,stage,damage){
  const cap=stage?.damageCap||0,d=Math.max(0,Number(damage)||0);
  if(cap>0)return trunc(Math.min(d,cap)*(1+Math.log(Math.max(d,cap)/cap))*calc.tmdc);
  return trunc(d*calc.tmdc);
}

/** Full score breakdown. Inputs are what the planner predicts; nothing here is a verified game value. */
export function scoreAttackScore({calc,stage,rules=[],turns=1,damage=0,noBreak=true}){
  if(!calc||!stage)throw Error('缺少计分参数或难度');
  const ver=calc.calc_ver||0,limit=turnLimit(calc,stage);
  if(!(turns>=1)||(limit&&turns>limit))return {valid:false,reason:`回合数应在 1–${limit||'?'} 之间`,total:0};
  const base=stage.baseScore||0,dmg=damageScore(calc,stage,damage);
  const nb=noBreak?(ver>0?(stage.noBreakBonus||0):(calc.sbnb||0)*(stage.difficulty||0)):0;
  const mult=ruleMultiplier(rules);
  if(ver>1){
    const tm=turnMultiplier(calc,stage,turns);
    return {valid:true,version:ver,base,damage:dmg,noBreak:nb,turnMultiplier:tm,turnScore:null,ruleMultiplier:mult,total:trunc((base+dmg+nb)*tm*mult)};
  }
  const turnScore=ver>0?trunc((limit-turns)/(limit-1)*(stage.maxTurnBonus||0)):trunc(base*(calc.sbtr*0.01)*(limit-turns));
  return {valid:true,version:ver,base,damage:dmg,noBreak:nb,turnMultiplier:null,turnScore,ruleMultiplier:mult,total:trunc((base+dmg+turnScore+nb)*mult)};
}

/**
 * Smallest scored damage needed to reach `target` for a given turn count (binary search on the
 * monotone damage curve). Returns null when even a huge damage value cannot reach the target.
 */
export function damageNeeded({calc,stage,rules=[],turns,noBreak=true,target}){
  const at=d=>scoreAttackScore({calc,stage,rules,turns,damage:d,noBreak}).total;
  if(at(0)>=target)return 0;
  let lo=0,hi=Math.max(1,stage.damageCap||1e6);
  for(let i=0;i<80&&at(hi)<target;i++)hi*=2;
  if(at(hi)<target)return null;
  for(let i=0;i<100&&hi-lo>1;i++){const mid=Math.floor((lo+hi)/2);if(at(mid)>=target)hi=mid;else lo=mid;}
  return hi;
}

/** Score table across turn counts for one damage value — used to show the turn/damage trade-off. */
export function scoreCurve({calc,stage,rules=[],damage,noBreak=true,maxTurns}){
  const limit=turnLimit(calc,stage)||maxTurns||30,rows=[];
  for(let t=1;t<=Math.min(limit,maxTurns||limit);t++)rows.push({turns:t,...scoreAttackScore({calc,stage,rules,turns:t,damage,noBreak})});
  return rows;
}

/* ------------------------------------------------------------------ resistances */

/** Classify element / attack-type resistances. Negative = takes more damage (weak). */
export function weaknessSummary(enemy){
  const el=enemy?.resist?.element||{},rows=[];
  for(const k of [...ATTACK_TYPES,...ELEMENTS]){
    const v=el[k];if(typeof v!=='number')continue;
    rows.push({key:k,label:ELEMENT_LABEL[k],value:v,kind:v<0?'weak':v>0?'resist':'neutral'});
  }
  const absorb=el.absorb_element_list||[];
  return {rows,weak:rows.filter(r=>r.kind==='weak').map(r=>r.key),resist:rows.filter(r=>r.kind==='resist').map(r=>r.key),absorb,ignorePenetration:!!el.ignore_penetration};
}

export function debuffSummary(enemy){
  const d=enemy?.resist?.debuff;if(!d)return [];
  return Object.entries(d).map(([k,v])=>({key:k,label:DEBUFF_LABEL[k]||k,value:v}));
}

/* ------------------------------------------------------------------ action pattern */

/**
 * Predict the enemy's action sequence for one gauge phase (e.g. "dp" before break, "hp" after).
 * Assumption (unverified): entries run in `order`, cycling; `once` entries drop out after use;
 * preemptive entries act before turn 1. Entries with a non-empty condition are kept but flagged.
 */
export function predictActions(enemy,phase,turns=8){
  const block=enemy?.pattern?.[phase];if(!block||!block.entries?.length)return {phase,known:false,steps:[]};
  const skills=new Map((enemy.skills||[]).map(s=>[s.id,s]));
  const pre=block.entries.filter(e=>e.preemptive),loop=block.entries.filter(e=>!e.preemptive);
  const steps=[],used=new Set();
  for(const e of pre)steps.push(step(e,0,skills));
  let i=0,guard=0;
  while(steps.filter(s=>s.turn>0).length<turns&&loop.length&&guard++<turns*loop.length*2){
    const e=loop[i%loop.length];i++;
    if(e.once&&used.has(e))continue;
    used.add(e);steps.push(step(e,steps.filter(s=>s.turn>0).length+1,skills));
    if(loop.every(x=>x.once&&used.has(x)))break;
  }
  const weighted=new Set(block.entries.map(e=>e.weight)).size>1;
  return {phase,label:block.label,known:true,uncertain:weighted||block.entries.some(e=>e.condition),steps};
}
function step(e,turn,skills){
  return {turn,order:e.order,preemptive:e.preemptive,once:e.once,condition:e.condition,weight:e.weight,
    skills:e.skills.map(id=>skills.get(id)||{id,name:`#${id}`,parts:[]})};
}

/** One-line description of an enemy skill for tables. */
export function describeSkill(s){
  const atk=(s.parts||[]).find(p=>p.skillType==='AttackSkill');
  const bits=[];
  if(atk){
    bits.push(`${s.targetType==='All'?'全体':s.targetType==='Single'?'单体':s.targetType||''}${s.hitCount?` ${s.hitCount}hit`:''}`);
    const el=[atk.attackType&&ELEMENT_LABEL[atk.attackType.toLowerCase()],...(atk.elements||[]).map(x=>ELEMENT_LABEL[String(x).toLowerCase()]||x)].filter(Boolean);
    if(el.length)bits.push(el.join('/'));
    if(Array.isArray(atk.power))bits.push(`威力 ${atk.power[0]}–${atk.power[1]}`);
  }
  for(const p of s.parts||[]){
    if(p===atk)continue;
    const dur=p.exit?.cond&&p.exit.cond!=='None'?`（${exitText(p.exit)}）`:'';
    bits.push(`${p.skillType}${dur}`);
  }
  return bits.join(' · ');
}
export function exitText(exit){
  if(!exit?.cond||exit.cond==='None')return '';
  if(exit.cond==='Eternal')return '永续';
  const n=Array.isArray(exit.value)?exit.value[0]:exit.value;
  const map={EnemyTurnEnd:'敌方回合结束',PlayerTurnEnd:'我方回合结束',Count:'次数'};
  return `${map[exit.cond]||exit.cond} ×${n}`;
}

/* ------------------------------------------------------------------ scene rules */

/**
 * Turns on which a rule fires within `limit` turns. Assumption (unverified):
 * OnBattleStart fires once at turn 1; OnEveryTurn fires every `interval` turns starting
 * from `interval` (interval 1 → every turn), at most `term` times.
 */
export function ruleSchedule(rule,limit=30){
  const timing=rule?.timing||[],out=new Set();
  if(timing.includes('OnBattleStart')||timing.includes('OnFirstBattleStart'))out.add(1);
  if(timing.includes('OnEveryTurn')){
    const iv=Math.max(1,rule.interval||1),term=rule.term>0?rule.term:Infinity;
    let k=0;for(let t=iv===1?1:iv;t<=limit&&k<term;t+=iv,k++)out.add(t);
  }
  return [...out].sort((a,b)=>a-b);
}

/** Rules active in a given week (by date) — score-attack rules rotate. */
export function rulesOn(event,date){
  const t=date instanceof Date?date.getTime():Date.parse(date);
  return (event?.rules||[]).filter(r=>(!r.inDate||Date.parse(r.inDate)<=t)&&(!r.outDate||t<=Date.parse(r.outDate)));
}

/** Group rules by their active window so the UI can show "week 1 / week 2". */
export function ruleWeeks(event){
  const map=new Map();
  for(const r of event?.rules||[]){const k=`${r.inDate||''}|${r.outDate||''}`;if(!map.has(k))map.set(k,{inDate:r.inDate,outDate:r.outDate,rules:[]});map.get(k).rules.push(r);}
  return [...map.values()].sort((a,b)=>String(a.inDate).localeCompare(String(b.inDate)));
}

/** Enemy-side view of one difficulty: stats from the stage, skills/pattern from the enemy detail. */
export function stageEnemies(event,stage){
  // 主数据的编队槽里有空位（label 为空、数值全 0），不是敌人，去掉
  return (stage?.enemies||[]).filter(e=>e?.label).map(e=>({...e,detail:event?.enemies?.[e.label]||null}));
}

/** Resolve the exact numbers used by every simulator/view. Public enemy base
 * parameters are not evidence of a wave difficulty multiplier; keep provenance
 * and explicit local overrides without inventing a scaling curve. */
export function resolveEnemyParameters(event,stage,pick,{override={}}={}){
  if(!pick?.label)throw new Error('缺少敌人标签');
  if(!override||typeof override!=='object'||Array.isArray(override))throw new TypeError('敌人参数覆盖必须是对象');
  const base=event?.enemies?.[pick.label]?.base||{},fields={},original={},values={};
  const spec={dp:['dp','dp'],hp:['hp','hp'],border:['paramBorder','param_border']};
  for(const [key,[stageKey,baseKey]] of Object.entries(spec)){
    const stageValue=pick[stageKey],baseValue=base[baseKey];
    const hasStage=stageValue!==undefined&&stageValue!==null;
    const hasBase=baseValue!==undefined&&baseValue!==null;
    original[key]=hasStage?stageValue:hasBase?baseValue:null;
    const custom=Object.hasOwn(override,key)&&override[key]!==undefined&&override[key]!==null;
    const value=custom?override[key]:original[key];
    if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0||(key==='hp'&&value===0)))throw new RangeError(`敌人 ${key} 必须是${key==='hp'?'正':'非负'}有限数值`);
    values[key]=value;
    fields[key]=custom?'override':hasStage?'stage':hasBase?'enemy-base':'missing';
  }
  return {...values,parameterSource:{label:pick.label,stage:stage?.label||null,fields,original,
    // Legacy wave exports contain raw enemy base values, with no per-level table.
    difficultyVerified:event?.kind==='wave'?stage?.parameterSource?.difficultyVerified===true:null,
    basis:stage?.parameterSource?.kind||null}};
}

// ---------------------------------------------------------------- 遭遇战（セラフ遭遇戦演習）计分
// 依据：社区「遭遇战出分计算.xlsx」「OD与破坏率计算表 261011」第 2 表、HBR Toolbox 遭遇战出分（三者一致）。
//   每阶段伤害分（按该阶段全部伤害，不是单回合最大）：x = min(伤害,60 亿)/5000，分段斜率 1 / 0.4 / 0.2 / 0.04 / 0.01 / 0.0001
//   （拐点 x = 2000/5000/10000/15000/20000），四舍五入；五个阶段求和。
//   难度分 = Σ 各阶段 round(起点 + (终点 − 起点)/39 ×(难度 − 1))；难度 40 时合计 65000。
//   回合分 = round(50000 × 0.9^(总回合 − r −(难度 − 40)))，r：国际服 3、日服 1。
//   总分 = int((伤害分 + 回合分 + 难度分)× 规则倍率)，规则倍率 = 1 + Σ 规则等级%（每期可选 1 条，各 +30%）。
const WAVE_DIFF=[[1000,11000],[1100,12000],[1180,13000],[1270,14000],[1300,15000]];
// 分段式写法与 HBR Toolbox 一致（避免累加的浮点误差影响 .5 处的舍入）
export function waveDamageScore(damage){
  const t=Math.min(Math.max(0,damage||0),6e9);
  const v=t>1e8?(t-1e8)/5e3*1e-4+4450:t>75e6?(t-75e6)/5e3*.01+4400:t>5e7?(t-5e7)/5e3*.04+4200:t>25e6?(t-25e6)/5e3*.2+3200:t>1e7?(t-1e7)/5e3*.4+2e3:t/5e3;
  return Math.round(v);
}
export function waveDifficultyScore(difficulty,phases=5){
  return WAVE_DIFF.slice(0,phases).reduce((a,[b,m])=>a+Math.round(b+(m-b)/39*(difficulty-1)),0);
}
export function waveRoundScore(turns,difficulty,international=true){
  return Math.round(50000*0.9**(turns-(international?3:1)-(difficulty-40)));
}
export function waveScore({damages=[],turns=1,difficulty=40,rules=[],international=true}){
  const phaseScores=damages.map(waveDamageScore),damageScore=phaseScores.reduce((a,b)=>a+b,0);
  const roundScore=waveRoundScore(turns,difficulty,international),difficultyScore=waveDifficultyScore(difficulty);
  const multiplier=1+rules.reduce((a,r)=>a+(r.grade||0),0)/100;
  return {phaseScores,damageScore,roundScore,difficultyScore,multiplier,total:Math.trunc((damageScore+roundScore+difficultyScore)*multiplier)};
}
