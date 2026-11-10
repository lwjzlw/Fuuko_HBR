// 排轴搜索（束搜索），建在 hbr/battle.mjs（社区计算器的回合与伤害规则）之上。
// 每个行动轮分三步展开：第一步同时决定“前排三人 + 第一个行动者与技能”，之后两步决定其余两人；完全相同的状态合并。
// OD 有两个发动时机（同 Planner）：回合开始（先 OD 轮再普通轮）或回合结束（普通轮后接 OD 轮，再敌方行动）。
// 追加回合：获得追加回合的成员单独再行动一轮（不加 SP）。最终排名用真实评价（积分挑战用计分公式）。
import {setPhase,initialState,cloneState,startTurn,startOverdrive,endOdRound,endPlayerTurn,startExtraTurn,endExtraTurn,pendingExtra,usableSkills,act,bestTurnDamage,stateKey,NORMAL} from './hbr/battle.mjs';
import {scoreAttackScore,waveDamageScore} from '../boss-model.mjs';
import {OD_COST} from './hbr/rules.mjs';

export const OBJECTIVES={score:'积分挑战高分',minTurns:'最少回合击破',maxDamage:'单回合最大伤害'};
// waveScore（遭遇战最高分，配置优化 / 设计器内部用）：本阶段伤害分 − 击破回合 × turnCost；首次击破后再多搜 extraTurns 回合，比较多打一回合是否更划算

const combinationCache=new Map();
function combos(n,k){const key=n+':'+k;if(combinationCache.has(key))return combinationCache.get(key);const out=[];const rec=(s,acc)=>{if(acc.length===k){out.push(acc.slice());return;}for(let i=s;i<n;i++){acc.push(i);rec(i+1,acc);acc.pop();}};rec(0,[]);combinationCache.set(key,out);return out;}
function setFront(st,set){for(const u of st.units)u.front=set.includes(u.i);}

// ---------------------------------------------------------------- 评价

const ATK_TYPES=new Set(['attackUp','elementAttackUp','mindsEye','critDamageUp','elementCritDamageUp','consecutiveHit','charge']);
const DEF_TYPES=new Set(['defenseDown','elementDefenseDown','fragile','resistanceDown','dpDefenseDown']);
function resources(st){
  const sp=st.units.reduce((s,u)=>s+Math.min(u.sp,20),0)/(st.units.length*20);
  const buffs=st.units.reduce((s,u)=>s+u.effects.reduce((t,e)=>t+(ATK_TYPES.has(e.type)?e.size/100:0),0),0);
  const debuffs=st.enemy.effects.reduce((s,e)=>s+(DEF_TYPES.has(e.type)?e.size/100:0),0);
  const E=st.ctx.enemy;
  const dr=E.destructionLimit>100?(st.enemy.dr*100-100)/(E.destructionLimit-100):0;
  return sp*0.5+st.od/300*0.3+Math.min(buffs,6)*0.06+Math.min(debuffs,4)*0.08+dr*0.6+(st.field?0.1:0);
}
export function progress(st){
  const E=st.ctx.enemy,total=(E.maxDp||0)+(E.maxHp||0);
  const dp=st.enemy.dp.reduce((a,b)=>a+b,0);
  return total?((E.maxDp-dp)+(E.maxHp-st.enemy.hp))/total:0;
}
function baseHeuristic(st,o){
  const D=bestTurnDamage(st),norm=o.damageNorm||1,r=resources(st);
  if(o.objective==='maxDamage')return D/norm+0.25*r;
  if(st.killedTurn){
    if(o.objective==='minTurns')return 100-st.killedTurn+D/norm*0.01+overkillBonus(st,o);
    if(o.objective==='waveScore')return 100+finalScore(st,o)/1e4;
    return 50+finalScore(st,o)/1e6;
  }
  if(o.objective==='minTurns')return progress(st)*3+0.2*r;
  if(o.objective==='waveScore')return progress(st)*3+0.2*r+phaseDamageScore(st,o)/1e4;
  return progress(st)*2+Math.log1p(D/norm)*0.6+0.2*r;
}
function heuristic(st,o){
  const values=st.skillDamageByElement||{},total=Object.values(values).reduce((a,b)=>a+b,0);
  // A search preference, not a damage multiplier or a role-based party filter.
  return baseHeuristic(st,o)+(o.teamElement&&total?3*(values[o.teamElement]||0)/total:0);
}
/** 本阶段伤害分（遭遇战）：o.overkill 时按显示伤害（含溢出）。 */
function phaseDamageScore(st,o){return waveDamageScore(o.overkill?(st.shownDamage||0)-(st.phaseShownStart||0):(st.totalDamage||0)-(st.phaseDamageStart||0));}
/** 遭遇战（o.overkill）：同样回合数时，本阶段显示伤害（含溢出）越高越好；换算成伤害分 /1e4（< 1，不压过回合数）。 */
function overkillBonus(st,o){return o.overkill?waveDamageScore((st.shownDamage||0)-(st.phaseShownStart||0))/1e4:0;}
export function finalScore(st,o){
  if(o.objective==='maxDamage')return bestTurnDamage(st);
  if(o.objective==='minTurns')return st.killedTurn?-st.killedTurn+overkillBonus(st,o):-Infinity;
  if(o.objective==='waveScore')return st.killedTurn?phaseDamageScore(st,o)-st.killedTurn*(o.turnCost??4000):-Infinity;
  if(!st.killedTurn||!o.score)return -Infinity;
  const r=scoreAttackScore({...o.score,turns:st.killedTurn,damage:bestTurnDamage(st)});
  return r.valid?r.total:-Infinity;
}

// ---------------------------------------------------------------- 展开

// 先按启发分排序，再从高到低算状态键去重，凑够束宽即停：结果与“全部算键→同键取最高→排序截断”相同
// （同分时的先后可能不同），但状态键（长字符串，原先占搜索 ~35% 时间）只需算前面几十个而不是全部上千个。
function prune(list,o,width){
  // waveScore：已击破与未击破的分开各留 width 个，免得已击破的占满束宽、没人继续多打一回合
  if(o.objective==='waveScore'&&!o._split){const k=list.filter(s=>s.killedTurn),a=list.filter(s=>!s.killedTurn);
    if(k.length&&a.length){const q={...o,_split:true};return [...prune(k,q,width),...prune(a,q,width)];}}
  for(const s of list)s.h??=heuristic(s,o);
  const sorted=list.slice().sort((a,b)=>b.h-a.h);
  const seen=new Set(),out=[];
  for(const s of sorted){const k=stateKey(s);if(seen.has(k))continue;seen.add(k);out.push(s);if(out.length>=width)break;}
  return out;
}
function child(s,entry){const c=cloneState(s);c.plan=s.plan.concat([entry]);c.h=undefined;return c;}

/** 一个行动轮（普通或 OD）：前排组合 × 三个行动。 */
function expandRound(beam,o,stats){
  const n=beam[0]?.units.length||0,frontSets=combos(n,Math.min(3,n));
  let next=[];
  for(const s of beam){
    if(s.killedTurn){next.push(s);continue;}
    const alive=s.units.filter(u=>!u.down).map(u=>u.i);
    for(const set of frontSets){
      if(set.some(i=>s.units[i].down)&&alive.length>=set.length)continue; // 倒下的成员不上前卫
      const base=child(s,{k:'front',units:set});setFront(base,set);base.acted=0;
      for(const u of set)for(const k of usableSkills(base,u)){
        const c=child(base,{k:'act',u,s:k});act(c,u,k);c.acted|=1<<u;stats.expanded++;next.push(c);
      }
    }
  }
  beam=prune(next,o,o.beam);
  for(let step=1;step<3;step++){
    next=[];
    for(const s of beam){
      if(s.killedTurn){next.push(s);continue;}
      const front=s.units.filter(u=>u.front&&!(s.acted&1<<u.i)).map(u=>u.i);
      if(!front.length){next.push(s);continue;}
      for(const u of front)for(const k of usableSkills(s,u)){const c=child(s,{k:'act',u,s:k});act(c,u,k);c.acted|=1<<u;stats.expanded++;next.push(c);}
    }
    beam=prune(next,o,o.beam);
  }
  return beam;
}

/** 追加回合：获得追加回合的成员各行动一次（同一轮内），轮末只给这些成员计时。 */
function expandExtra(beam,o,stats){
  const out=[];const todo=[];
  for(const s of beam){if(s.killedTurn||!pendingExtra(s).length)out.push(s);else todo.push(s);}
  if(!todo.length)return beam;
  let cur=todo.map(s=>{const c=child(s,{k:'extraStart',who:pendingExtra(s)});c.extraWho=pendingExtra(s);startExtraTurn(c);return c;});
  for(let step=0;step<3;step++){
    const next=[];
    for(const s of cur){
      const left=s.extraWho.filter(i=>!(s.extraActed&1<<i));
      if(s.killedTurn||!left.length){next.push(s);continue;}
      for(const i of left)for(const k of usableSkills(s,i)){const c=child(s,{k:'extra',u:i,s:k});c.extraActed=(c.extraActed||0)|1<<i;act(c,i,k);stats.expanded++;next.push(c);}
    }
    cur=prune(next,o,o.beam);
  }
  for(const s of cur){s.plan=s.plan.concat([{k:'extraEnd',who:s.extraWho}]);endExtraTurn(s,s.extraWho);s.extraWho=null;s.extraActed=0;s.h=undefined;}
  return prune([...out,...cur],o,o.beam);
}

function odLevels(st,o){
  if(o.allowOd===false)return [];
  const out=[];
  for(let l=Math.max(1,st.mods.minOd||1);l<=3;l++)if(st.od>=OD_COST[l])out.push(l);
  return out;
}

/** OD 轮：每轮一个行动轮 + 追加回合，然后计时。 */
function runOd(beam,o,stats){
  for(let r=0;r<3;r++){
    const inOd=beam.filter(s=>s.odRounds>0&&!s.killedTurn),rest=beam.filter(s=>!(s.odRounds>0&&!s.killedTurn));
    if(!inOd.length)break;
    let after=expandRound(inOd,o,stats);
    after=expandExtra(after,o,stats);
    for(const s of after){s.plan=s.plan.concat([{k:'odEnd'}]);endOdRound(s);s.h=undefined;}
    beam=prune([...after,...rest],o,o.beam);
  }
  return beam;
}

// ---------------------------------------------------------------- 主入口

/**
 * ctx = {party, enemy, statusTypes}
 * o = {objective, maxTurns, beam, critMode, score:{calc,stage,rules,noBreak}, damageNorm, allowOd, odWindows:['turnStart','turnEnd']}
 */
export function search(ctx,o,onProgress=()=>{}){
  const t0=Date.now(),stats={expanded:0};
  const flags={unsupported:{},approx:{}};
  const root=rootOf(ctx,o,flags);
  root.plan=[];
  let beam=[root];const finished=[],wiped=[];let firstFin=0;
  const windows=o.odWindows||['turnStart','turnEnd'];
  for(let turn=1;turn<=o.maxTurns&&beam.length;turn++){
    // 回合开始 + 回合开始型 OD 分支
    let started=[];
    for(const s of beam){
      const c=child(s,{k:'turn'});startTurn(c);started.push(c);
      if(windows.includes('turnStart'))for(const lv of odLevels(c,o)){const d=child(c,{k:'od',level:lv,window:'turnStart'});if(startOverdrive(d,lv,'turnStart'))started.push(d);}
    }
    beam=prune(started,o,o.beam*2);
    beam=runOd(beam,o,stats);
    // 普通行动轮 + 追加回合
    beam=expandRound(beam,o,stats);
    beam=expandExtra(beam,o,stats);
    // 回合结束：可接回合结束型 OD（OD 轮后才轮到敌方）
    let ended=[];
    for(const s of beam){
      if(s.killedTurn){ended.push(s);continue;}
      ended.push(s);
      if(windows.includes('turnEnd'))for(const lv of odLevels(s,o)){const d=child(s,{k:'od',level:lv,window:'turnEnd'});if(startOverdrive(d,lv,'turnEnd'))ended.push(d);}
    }
    beam=prune(ended,o,o.beam*2);
    const odEnd=beam.filter(s=>s.odRounds>0&&!s.killedTurn),plain=beam.filter(s=>!(s.odRounds>0&&!s.killedTurn));
    let afterOd=odEnd.length?runOd(odEnd,o,stats):[];
    for(const s of [...plain,...afterOd]){
      if(!s.killedTurn){const viaOd=afterOd.includes(s)&&s.odWindow==='turnEnd';s.plan=s.plan.concat([{k:'end',skipTick:viaOd}]);endPlayerTurn(s,{skipTick:viaOd});}
      s.h=undefined;
    }
    for(const s of [...plain,...afterOd])if(s.wiped)wiped.push(s);
    beam=[...plain,...afterOd].filter(s=>!s.wiped); // 有成员 HP 清零即失败，淘汰
    for(const s of beam)if(s.killedTurn)finished.push(s);
    beam=prune(beam.filter(s=>!s.killedTurn),o,o.beam);
    onProgress({turn,maxTurns:o.maxTurns,expanded:stats.expanded,finished:finished.length,elapsed:Date.now()-t0});
    if(o.objective==='minTurns'&&finished.length)break;
    if(o.objective==='waveScore'&&finished.length){firstFin||=turn;if(turn>=firstFin+(o.extraTurns??1))break;}
  }
  const pool=o.objective==='maxDamage'?[...finished,...beam]:finished;
  const ranked=pool.map(s=>({s,value:finalScore(s,o)})).filter(x=>Number.isFinite(x.value)).sort((a,b)=>b.value-a.value);
  const seen=new Set(),top=[];
  for(const x of ranked){const k=JSON.stringify(x.s.plan);if(seen.has(k))continue;seen.add(k);top.push(x);if(top.length>=Math.max(1,Math.min(20,o.top??5)))break;}
  const fallback=!top.length?([...beam].sort((a,b)=>progress(b)-progress(a))[0]||wiped.sort((a,b)=>(b.wiped-a.wiped)||(progress(b)-progress(a)))[0]):null;
  return {elapsed:Date.now()-t0,expanded:stats.expanded,plans:top.map(x=>summarize(ctx,o,x.s,x.value)),
    unfinished:fallback?summarize(ctx,o,fallback,null):null,flags};
}

function summarize(ctx,o,s,value){
  const replayed=o.trace===false?s:replay(ctx,o,s.plan);
  const D=bestTurnDamage(s);
  const score=o.score&&s.killedTurn?scoreAttackScore({...o.score,turns:s.killedTurn,damage:D}):null;
  return {value,killedTurn:s.killedTurn||0,wipedTurn:s.wiped||0,vitals:replayed.units.map(u=>({dp:Math.round(u.dp),hp:Math.round(u.hp),down:u.down})),turns:s.turn,scoreDamage:D,totalDamage:s.totalDamage,progress:progress(s),score,turnDamage:s.turnDamage,plan:s.plan,log:replayed.log};
}

/**
 * 搜索/重放的起点：o.rootState（上一阶段结束时的状态，遭遇战串联用）或新开局；
 * ctx.phaseEnemies 给出本阶段的多个敌人时用引擎队列（依次击破、其余敌人照常行动）。
 */
function rootOf(ctx,o,flags,trace=false){
  let st;
  if(o.rootState){st=cloneState(o.rootState);st.killedTurn=0;st.log=trace?[]:null;
    st.ctx={...st.ctx,opt:{...st.ctx.opt,critMode:o.critMode}};if(flags)st.flags=flags;}
  else st=initialState(ctx.party,ctx.enemy,{critMode:o.critMode,statusTypes:ctx.statusTypes,conquestBikeLevel:o.conquestBikeLevel,followUpRate:o.followUpRate,exAttenuation:o.exAttenuation,enemyVariance:o.enemyVariance,enemyTargeting:o.enemyTargeting,flags:flags||undefined,trace,teamElement:o.teamElement});
  if(ctx.phaseEnemies?.length)setPhase(st,ctx.phaseEnemies);
  return st;
}
/** 按 plan 重放并记录详细日志（模拟是确定性的）。 */
export function replay(ctx,o,plan){
  const st=rootOf(ctx,o,null,o.trace!==false);
  let who=null;
  for(const p of plan){
    switch(p.k){
      case 'turn':startTurn(st);break;
      case 'od':startOverdrive(st,p.level,p.window);break;
      case 'front':setFront(st,p.units);st.acted=0;break;
      case 'act':act(st,p.u,p.s);st.acted|=1<<p.u;break;
      case 'extraStart':who=p.who;startExtraTurn(st);break;
      case 'extra':act(st,p.u,p.s);break;
      case 'extraEnd':endExtraTurn(st,p.who);who=null;break;
      case 'odEnd':endOdRound(st);break;
      case 'end':endPlayerTurn(st,{skipTick:p.skipTick});break;
    }
  }
  return st;
}
export {NORMAL};
