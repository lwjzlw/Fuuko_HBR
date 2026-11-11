// 排轴搜索（束搜索），建在 hbr/battle.mjs（社区计算器的回合与伤害规则）之上。
// 每个行动轮分三步展开：第一步同时决定“前排三人 + 第一个行动者与技能”，之后两步决定其余两人；完全相同的状态合并。
// OD 有两个发动时机（同 Planner）：回合开始（先 OD 轮再普通轮）或回合结束（普通轮后接 OD 轮，再敌方行动）。
// 追加回合：获得追加回合的成员单独再行动一轮（不加 SP）。最终排名用真实评价（积分挑战用计分公式）。
import {setPhase,initialState,cloneState,startTurn,odCost,startOverdrive,endOdRound,endPlayerTurn,startExtraTurn,endExtraTurn,pendingExtra,availableCommands,useCommand,usableSkills,act,bestTurnDamage,stateKey,NORMAL} from './hbr/battle.mjs';
import {scoreAttackScore,waveDamageScore} from '../boss-model.mjs';

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
const useWeights=new WeakMap();
function limitedUseWeights(skills){
  if(useWeights.has(skills))return useWeights.get(skills);
  const weights=new Map();
  for(const skill of skills){
    const uses=Array.isArray(skill.uses)?Math.max(...skill.uses.map(Math.abs)):skill.uses;
    if(uses>0)weights.set(skill.label,1/uses);
  }
  useWeights.set(skills,weights);
  return weights;
}
/** 跨阶段候选的资源比较：使用有限技能扣除其基础次数的相应比例，另比较 SP、OD 及队员血盾。 */
export function carryoverValue(st){
  let spent=0,sp=0,vitals=0,lowest=1;
  for(const u of st.units){
    const member=st.ctx.party[u.i],weights=limitedUseWeights(member.skills);
    for(const [label,count] of Object.entries(u.uses))spent+=count*(weights.get(label)||0);
    if(u.commandSkill)spent+=(3-(u.commandRemaining||0))/3;
    sp+=u.sp/20;
    const maximum=member.dpMax+member.hpMax;
    const health=maximum>0?(u.dp+u.hp)/maximum:1;
    vitals+=health;lowest=Math.min(lowest,health);
  }
  const count=st.units.length||1;
  return -spent+0.5*sp/count+0.5*st.od/300+0.25*vitals/count+0.25*lowest;
}
export function progress(st){
  let total=0,remaining=0;
  for(const {enemy,state,dead} of st.queue||[{enemy:st.ctx.enemy,state:st.enemy}]){
    total+=(enemy.maxDp??enemy.dp.reduce((a,b)=>a+b,0))+(enemy.maxHp??enemy.hp);
    if(!dead)remaining+=state.hp+state.dp.reduce((a,b)=>a+b,0);
  }
  return total?(total-remaining)/total:0;
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
function searchStateKey(s){
  // Equal attack resources do not imply equal survival, remaining enemies or extra actions.
  const vitals=s.units.map(u=>[u.dp,u.hp,u.dpBroken]);
  const enemies=s.queue?.map(q=>{
    if(q.dead)return 'dead';
    const x=q.state;
    // Effect sequence IDs vary between otherwise equivalent copies.
    const effects=x===s.enemy?null:x.effects.map(({id,...effect})=>effect);
    return [x.hp,x.dp,x.dr,x.ptr,x.once,effects];
  });
  return stateKey(s)+'|'+JSON.stringify([s.odWindow,s.extraActed||0,vitals,enemies]);
}
function prune(list,o,width){
  // waveScore：已击破与未击破的分开各留 width 个，免得已击破的占满束宽、没人继续多打一回合
  if(o.objective==='waveScore'&&!o._split){const k=list.filter(s=>s.killedTurn),a=list.filter(s=>!s.killedTurn);
    if(k.length&&a.length){const q={...o,_split:true};return [...prune(k,q,width),...prune(a,q,width)];}}
  for(const s of list)s.h??=heuristic(s,o);
  const sorted=list.slice().sort((a,b)=>b.h-a.h);
  const seen=new Set(),out=[];
  for(const s of sorted){const k=searchStateKey(s);if(seen.has(k))continue;seen.add(k);out.push(s);if(out.length>=width)break;}
  if(o.reserveResources&&sorted.length>out.length){
    let reserve=null,best=-Infinity;
    for(const s of sorted){
      // A resource branch still needs to advance this stage, e.g. spend SP to
      // clear it without using up a once-per-encounter skill.
      const value=carryoverValue(s)+0.5*progress(s);
      if(value>best){reserve=s;best=value;}
    }
    if(reserve){const k=searchStateKey(reserve);if(!seen.has(k)){out.push(reserve);seen.add(k);}}
  }
  if(o.servantFinisher&&sorted.length>out.length){
    const {actor,skill}=o.servantFinisher;
    let reserve=null,best=-1;
    for(const s of sorted){
      if(s.killedTurn||s.wiped)continue;
      const count=s.units.filter(u=>u.effects.some(e=>e.type==='yamawakiMinion')).length;
      if(!count)continue;
      const user=s.units[actor];
      const ready=count===6&&usableSkills(s,actor).includes(skill);
      const nextAction=user.extra>0||user.front&&!(s.acted&1<<actor);
      const value=count*4+Number(ready)*2+Number(nextAction);
      if(value>best){reserve=s;best=value;}
    }
    if(reserve&&!seen.has(searchStateKey(reserve)))out.push(reserve);
  }
  return out;
}
/** An ally-targeted setup has yet to deal its damage. Give each front member
 * one chance to act on their best setup before comparing completed rounds. */
function pruneMidRound(list,o){
  const beam=prune(list,o,o.beam),prepared=new Map();
  for(const s of list){
    const target=s.plan.at(-1)?.target;
    if(target==null||s.killedTurn||!s.units[target].front||(s.acted&1<<target))continue;
    const best=prepared.get(target);
    if(!best||s.h>best.h)prepared.set(target,s);
  }
  if(prepared.size){
    const keys=new Set(beam.map(searchStateKey));
    for(const s of prepared.values()){
      const k=searchStateKey(s);
      if(!keys.has(k)){beam.push(s);keys.add(k);}
    }
  }
  return beam;
}
function child(s,entry){const c=cloneState(s);c.plan=s.plan.concat([entry]);c.h=undefined;return c;}

/** 行动选择界面的独立指令可连续使用，同一出击的剩余次数限制了展开深度。 */
function commandPrefixes(state,stats,beforeOd=false){
  const choices=[state];
  for(let i=0;i<choices.length;i++){
    const parent=choices[i];
    for(const {u,s} of availableCommands(parent)){
      const entry={k:'command',u,s};
      if(beforeOd)entry.beforeOd=true;
      const next=child(parent,entry);
      useCommand(next,u,s);
      choices.push(next);stats.expanded++;
    }
  }
  return choices;
}

const targetModeCache=new WeakMap();
function allyTargetMode(skill){
  if(!skill)return 0;
  if(targetModeCache.has(skill))return targetModeCache.get(skill);
  let mode=0;
  for(const p of skill.parts||[]){
    if(p.targetType==='AllySingleWithoutSelf')mode=2;
    if(p.targetType==='AllySingle'&&!mode)mode=1;
    for(const branch of p.branches||[])mode=Math.max(mode,allyTargetMode(branch));
  }
  targetModeCache.set(skill,mode);
  return mode;
}
/** Party slot indices eligible for the single ally selected on a skill. */
export function selectableAllyTargets(skill,actor,members){
  const mode=allyTargetMode(skill);
  if(!mode)return [];
  return members.flatMap((member,index)=>{
    const slot=member.i??index;
    return member.down||(mode===2&&slot===actor)?[]:[slot];
  });
}
function appendActions(next,state,actors,kind,stats){
  for(const u of actors)for(const k of usableSkills(state,u)){
    const skill=state.ctx.party[u].skills[k];
    const targets=allyTargetMode(skill)?selectableAllyTargets(skill,u,state.units):[undefined];
    for(const target of targets){
      const entry={k:kind,u,s:k};
      if(target!==undefined)entry.target=target;
      const c=child(state,entry);
      act(c,u,k,target);
      if(kind==='extra')c.extraActed=(c.extraActed||0)|1<<u;
      else c.acted|=1<<u;
      stats.expanded++;next.push(c);
    }
  }
}

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
      if(!o.hasCommands)appendActions(next,base,set,'act',stats);
      else for(const prefix of commandPrefixes(base,stats)){
        if(prefix.killedTurn)next.push(prefix);
        else appendActions(next,prefix,set,'act',stats);
      }
    }
  }
  beam=pruneMidRound(next,o);
  for(let step=1;step<3;step++){
    next=[];
    for(const s of beam){
      if(s.killedTurn){next.push(s);continue;}
      const front=s.units.filter(u=>u.front&&!(s.acted&1<<u.i)).map(u=>u.i);
      if(!front.length){next.push(s);continue;}
      appendActions(next,s,front,'act',stats);
    }
    beam=step===1?pruneMidRound(next,o):prune(next,o,o.beam);
  }
  return beam;
}

/** 追加回合：获得追加回合的成员各行动一次（同一轮内），轮末只给这些成员计时。 */
function expandExtra(beam,o,stats){
  const out=[];const todo=[];
  for(const s of beam){if(s.killedTurn||!pendingExtra(s).length)out.push(s);else todo.push(s);}
  if(!todo.length)return beam;
  let cur=todo.map(s=>{const c=child(s,{k:'extraStart',who:pendingExtra(s)});c.extraWho=pendingExtra(s);startExtraTurn(c);return c;});
  if(o.hasCommands)cur=cur.flatMap(s=>commandPrefixes(s,stats));
  for(let step=0;step<3;step++){
    const next=[];
    for(const s of cur){
      const left=s.extraWho.filter(i=>!(s.extraActed&1<<i));
      if(s.killedTurn||!left.length){next.push(s);continue;}
      appendActions(next,s,left,'extra',stats);
    }
    cur=prune(next,o,o.beam);
  }
  for(const s of cur){s.plan=s.plan.concat([{k:'extraEnd',who:s.extraWho}]);endExtraTurn(s,s.extraWho);s.extraWho=null;s.extraActed=0;s.h=undefined;}
  return prune([...out,...cur],o,o.beam);
}

function odLevels(st,o){
  if(o.allowOd===false)return [];
  const out=[];
  for(let l=Math.max(1,st.mods.minOd||1);l<=3;l++)if(st.od>=odCost(st,l))out.push(l);
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
  const owner=ctx.party.find(m=>m.skills.some(s=>s.label==='BIYamawakiSkill55'));
  if(owner)o={...o,servantFinisher:{actor:owner.i,skill:owner.skills.findIndex(s=>s.label==='BIYamawakiSkill55')}};
  const t0=Date.now(),stats={expanded:0};
  const flags={unsupported:{},approx:{}};
  const root=rootOf(ctx,o,flags);
  if(root.units.some(u=>u.commandRemaining>0))o={...o,hasCommands:true};
  root.plan=[];
  let beam=[root];const finished=[],wiped=[];let firstFin=0;
  const windows=o.odWindows||['turnStart','turnEnd'];
  for(let turn=1;turn<=o.maxTurns&&beam.length;turn++){
    // 回合开始 + 回合开始型 OD 分支
    let started=[];
    for(const s of beam){
      const c=child(s,{k:'turn'});startTurn(c);started.push(c);
      if(o.allowOd!==false&&windows.includes('turnStart')){
        const prefixes=o.hasCommands?commandPrefixes(c,stats,true):[c];
        for(const prefix of prefixes){
          if(prefix.killedTurn)continue;
          for(const lv of odLevels(prefix,o)){
            const d=child(prefix,{k:'od',level:lv,window:'turnStart'});
            if(startOverdrive(d,lv,'turnStart'))started.push(d);
          }
        }
      }
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
  if(o.reserveResources&&ranked.length){
    let reserve=null,best=-Infinity;
    for(const x of ranked){
      if(!x.s.killedTurn)continue;
      const value=carryoverValue(x.s);
      if(value>best){reserve=x;best=value;}
    }
    if(reserve&&!seen.has(JSON.stringify(reserve.s.plan)))top.push(reserve);
  }
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
  if(o.rootState){st=cloneState(o.rootState);st.log=trace?[]:null;
    st.ctx={...st.ctx,opt:{...st.ctx.opt,critMode:o.critMode}};if(flags)st.flags=flags;}
  else st=initialState(ctx.party,ctx.enemy,{critMode:o.critMode,statusTypes:ctx.statusTypes,conquestBikeLevel:o.conquestBikeLevel,followUpRate:o.followUpRate,exAttenuation:o.exAttenuation,enemyVariance:o.enemyVariance,enemyTargeting:o.enemyTargeting,flags:flags||undefined,trace,teamElement:o.teamElement});
  if(ctx.phaseEnemies?.length)setPhase(st,ctx.phaseEnemies);
  else if(o.rootState)st.killedTurn=0;
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
      case 'command':useCommand(st,p.u,p.s);break;
      case 'act':act(st,p.u,p.s,p.target);st.acted|=1<<p.u;break;
      case 'extraStart':who=p.who;startExtraTurn(st);break;
      case 'extra':act(st,p.u,p.s,p.target);break;
      case 'extraEnd':endExtraTurn(st,p.who);who=null;break;
      case 'odEnd':endOdRound(st);break;
      case 'end':endPlayerTurn(st,{skipTick:p.skipTick});break;
    }
  }
  return st;
}
export {NORMAL};
