// 排轴设计器：把用户逐回合手排的行动编译成引擎步骤并重放，输出逐行动的状态与问题。
//
// design = {phases:[{turns:[turn…]}…]}（普通关卡只有 1 个 phase；遭遇战每阶段一个 phase，状态跨阶段继承）
// turn = {front:[i,i,i]|null,                      普通行动轮的前卫（null = 不换）
//         odStart / odEnd:{level:1–3, rounds:[{front,actions,extra}…]}|null   回合开始 / 回合结束发动的 OD（同一回合可两次），每轮可单独换前卫
//         actions:[{u, s, target}…],               普通行动轮（按顺序，最多 3 个）
//         extra:[{u, s, target}…]}                 追加回合
// action.s：技能 label；'normal' = 普攻（ADMIRAL 为指揮行動）；'' = 不行动
import {initialState,startTurn,startOverdrive,endOdRound,endPlayerTurn,startExtraTurn,endExtraTurn,pendingExtra,
  usableSkills,act,effectiveCost,setPhase,NORMAL} from './hbr/battle.mjs';
import {OD_COST} from './hbr/rules.mjs';
import {applyCard,cardById} from './cards.mjs';

export const emptyTurn=()=>({front:null,odStart:null,odEnd:null,actions:[],extra:[]});
export const emptyDesign=(phases=1)=>({phases:Array.from({length:phases},()=>({turns:[emptyTurn()]}))});

/** 把动作的技能 label 解析成引擎下标；返回 {k, skill} 或 {error}。 */
function resolve(st,u,s){
  const meta=st.ctx.party[u];
  if(!meta)return {error:'成员不存在'};
  if(s==='normal'){
    if(meta.noNormal){const k=meta.skills.findIndex(x=>/CommandBuff$/.test(x.label||''));return k>=0?{k,skill:meta.skills[k]}:{error:'ADMIRAL 不能普攻'};}
    return {k:NORMAL,skill:{name:'普通攻击',label:'normal',sp:0}};
  }
  const k=meta.skills.findIndex(x=>x.label===s);
  return k>=0?{k,skill:meta.skills[k]}:{error:'技能不在编队技能表：'+s};
}

const snapshot=st=>({
  sp:st.units.map(u=>u.sp),ep:st.units.map(u=>u.ep||0),od:Math.round(st.od*100)/100,
  allies:st.units.map((u,i)=>({dp:Math.round(u.dp||0),hp:Math.round(u.hp||0),dpMax:st.ctx.party[i].dpMax,hpMax:st.ctx.party[i].hpMax,broken:!!u.dpBroken,down:!!u.down,front:u.front})),
  enemy:{name:st.ctx.enemy.name,dp:Math.round(st.enemy.dp.reduce((a,b)=>a+b,0)),hp:Math.round(st.enemy.hp),dr:Math.round(st.enemy.dr*1000)/10},
  trans:st.trans?st.trans.gauge:null,
});

/**
 * 重放一份设计。ctx = {party, phases:[{enemies:[enemy…]}…], statusTypes}；o = 引擎选项（critMode 等）。
 * 返回 {rows, issues, phases:[{damage,turns,cleared}], turns, failed, final}
 */
export function simulateDesign(ctx,o,design){
  const phasesIn=ctx.phases?.length?ctx.phases:[{enemies:[ctx.enemy]}];
  const first=phasesIn[0].enemies[0];
  const trace=o.trace!==false;
  const st=initialState(ctx.party,first,{...o,statusTypes:ctx.statusTypes,trace,trackElements:trace||!!o.teamElement});
  const rows=[],issues=[],phaseOut=[];
  let turnNo=0,failed=0,roundNo=0;
  const add=(r)=>{if(trace)rows.push({...r,...snapshot(st)});};
  const issue=(turn,msg,level='error')=>issues.push({turn,msg,level});

  for(let p=0;p<phasesIn.length&&!failed;p++){
    let enemies=phasesIn[p].enemies;
    // 遭遇战：上一阶段结束后选的战术卡（design.phases[p].card）在本阶段开始前生效
    const cardId=p>0?design.phases?.[p]?.card:null;
    if(cardId){const nb=applyCard(st,cardId);
      if(nb.borderDown)enemies=enemies.map(e=>({...e,border:Math.max(0,e.border-nb.borderDown)}));
      add({kind:'card',phase:p,turn:turnNo,label:`战术卡：${cardById(cardId)?.name||cardId}`});}
    // 同阶段多敌：交给引擎队列（setPhase）——依次作为目标、其余存活敌人照常行动、全体攻击溅射
    if(enemies.length>1||p>0)setPhase(st,enemies);
    const startDamage=st.totalDamage,startShown=st.shownDamage||0,startTurnNo=turnNo;
    let logSeen=st.log?.length||0;
    const advance=(meta,enemyName)=>{ // 事件绑定触发它的行动轮
      if(!trace)return st.killedTurn>0;
      for(const l of st.log.slice(logSeen)){
        if(l.t==='kill')add({...meta,kind:'kill',label:`击杀 ${l.name}`});
        else if(l.t==='break')add({...meta,kind:'break',label:`破盾 ${l.name||enemyName}`});
        else if(l.t==='transcend')add({...meta,kind:'transcend',label:'超越发动'});
      }
      logSeen=st.log.length;
      if(st.killedTurn&&!st.queue)add({...meta,kind:'kill',label:`击杀 ${st.ctx.enemy.name}`});
      return st.killedTurn>0;
    };
    const design_=design.phases?.[p]||{turns:[]};
    const setFront=(front,turn)=>{
      if(!front?.length)return;
      const set=front.filter(i=>Number.isInteger(i)&&i>=0&&i<st.units.length);
      const need=Math.min(3,st.units.length);
      if(set.length!==need||new Set(set).size!==set.length){if(set.length)issue(turn,`前卫需要选满 ${need} 名不同成员（未换人）`,'warn');return;}
      for(const u of st.units)u.front=set.includes(u.i);
    };
    let cleared=false;
    const runActions=(list,round,turn,context={})=>{
      const roundId=trace?++roundNo:0;
      if(trace)add({kind:'round',phase:p,turn,round,roundId,...context,
        actors:context.actors||st.units.filter(u=>u.front).map(u=>u.i),
        planned:(list||[]).filter(a=>a.s).map(a=>({unit:a.u,skill:resolve(st,a.u,a.s).skill?.name||a.s}))});
      const done=new Set();
      for(const a of list||[]){
        if(a.s&&done.has(a.u)){issue(turn,`${ctx.party[a.u]?.name} 本轮已经行动过`);continue;}
        if(cleared||failed)return;
        if(a.s==='')continue;
        const r=resolve(st,a.u,a.s);
        if(r.error){issue(turn,`${ctx.party[a.u]?.name||'#'+a.u}：${r.error}`);continue;}
        const u=st.units[a.u];
        if(!u.front&&round!=='extra'){issue(turn,`${ctx.party[a.u].name} 不在前卫，不能行动`);continue;}
        const usable=usableSkills(st,a.u);
        if(!usable.includes(r.k)){
          const cost=r.k===NORMAL?0:effectiveCost(st,a.u,r.skill);
          issue(turn,`${ctx.party[a.u].name}「${r.skill.name}」不可用（SP ${Math.round(u.sp*10)/10} / 需要 ${cost}${u.uses?.[r.skill.label]?'；次数可能已用完':''}）`);
          continue;
        }
        const before=st.totalDamage,enemyName=st.ctx.enemy.name;
        act(st,a.u,r.k,a.target);done.add(a.u);
        add({kind:'act',phase:p,turn,round,roundId,unit:a.u,skill:r.skill.name||r.skill.label,cost:r.k===NORMAL?0:effectiveCost(st,a.u,r.skill),damage:Math.round(st.totalDamage-before)});
        if(advance({phase:p,turn,round,roundId,unit:a.u},enemyName)){cleared=true;return;}
      }
    };
    const runExtra=(extra,turn,context={})=>{
      const who=pendingExtra(st);
      if(!who.length){if(extra?.some(a=>a.s))issue(turn,'没有获得追加回合，追加行动被忽略','warn');return;}
      startExtraTurn(st);
      const planned=(extra||[]).filter(a=>a.s&&who.includes(a.u));
      if(!planned.length)issue(turn,`有追加回合（${who.map(i=>ctx.party[i].name).join('、')}）但没有安排行动`,'warn');
      runActions(planned,'extra',turn,{...context,actors:who});
      endExtraTurn(st,who);
    };
    const runOd=(od,turn,odWindow)=>{
      for(let r=0;st.odRounds>0&&!cleared&&!failed;r++){
        const round=od.rounds?.[r]||{actions:[],extra:[]};
        setFront(round.front,turn);st.acted=0;
        runActions(round.actions,'od'+(r+1),turn,{odWindow,odLevel:od.level});
        if(!cleared)runExtra(round.extra,turn,{odWindow,odLevel:od.level,parentRound:'od'+(r+1)});
        endOdRound(st);
      }
    };
    // o.extendTurns：设计回合用完仍未清阶段时，重复最后一回合的行动（不含 OD）最多 N 回合（蒙特卡洛模拟“多打几回合”）
    const lastT=design_.turns.at(-1)||emptyTurn();
    const extra=Array.from({length:o.extendTurns||0},()=>({front:lastT.front,actions:lastT.actions,extra:lastT.extra,odStart:null,odEnd:null,extended:true}));
    let extended=0;
    for(const t of [...design_.turns,...extra]){
      if(cleared||failed)break;
      if(t.extended)extended++;
      turnNo++;
      startTurn(st);
      add({kind:'turn',phase:p,turn:turnNo,label:`第 ${turnNo} 回合${phasesIn.length>1?`（第 ${p+1} 阶段）`:''}`});
      const odS=t.odStart||(t.od?.window==='turnStart'?t.od:null),odE=t.odEnd||(t.od?.window==='turnEnd'?t.od:null);
      if(odS?.level){
        if(!startOverdrive(st,odS.level,'turnStart'))issue(turnNo,`OD${odS.level} 发动失败（量表 ${Math.round(st.od)}%，需要 ${OD_COST[odS.level]}%）`);
        else{add({kind:'od',phase:p,turn:turnNo,window:'turnStart',level:odS.level,label:`前开 OD Lv.${odS.level}`});runOd(odS,turnNo,'turnStart');}
      }
      if(!cleared){setFront(t.front,turnNo);st.acted=0;runActions(t.actions,'main',turnNo);}
      if(!cleared)runExtra(t.extra,turnNo);
      let skipTick=false;
      if(!cleared&&odE?.level){
        if(!startOverdrive(st,odE.level,'turnEnd'))issue(turnNo,`OD${odE.level} 发动失败（量表 ${Math.round(st.od)}%，需要 ${OD_COST[odE.level]}%）`);
        else{add({kind:'od',phase:p,turn:turnNo,window:'turnEnd',level:odE.level,label:`后开 OD Lv.${odE.level}`});runOd(odE,turnNo,'turnEnd');skipTick=true;}
      }
      if(cleared)break;
      const hurtFrom=st.log?.length||0;
      endPlayerTurn(st,{skipTick});logSeen=st.log?.length||0;
      const hurt=trace?st.log.slice(hurtFrom).filter(l=>l.t==='hurt'||l.t==='enemy'||l.t==='dpBreak'):[];
      add({kind:'enemy',phase:p,turn:turnNo,label:'敌方行动',events:hurt});
      if(st.wiped){failed=turnNo;issue(turnNo,'有成员 HP 清零：战斗失败');}
    }
    phaseOut.push({phase:p,damage:Math.round(st.totalDamage-startDamage),shown:Math.round((st.shownDamage||0)-startShown),turns:turnNo-startTurnNo,cleared,extended});
    if(!cleared&&!failed){issue(turnNo,`第 ${p+1} 阶段在设计的回合内没有击破全部敌人`,'warn');break;}
  }
  return {rows,issues,phases:phaseOut,turns:turnNo,failed,final:snapshot(st),flags:st.flags,elementDamage:{...st.skillDamageByElement}};
}

/** 给 UI 用：某成员在某状态下可选的技能（label、名称、SP）。 */
export function skillChoices(member){
  const out=[{s:'',name:'—'},{s:'normal',name:member.noNormal?'指揮行動':'普通攻击',sp:0}];
  for(const s of member.skills){if(s.passive||/CommandBuff$/.test(s.label||''))continue;if(s.consume&&s.consume!=='Sp'&&s.consume!=='Ep')continue;out.push({s:s.label,name:s.name||s.label,sp:s.sp||0});}
  return out;
}

/** 把搜索结果的 plan（引擎步骤）转成可编辑的设计（单阶段）。 */
export function designFromPlan(plan,party){
  const turns=[];let t=null,odRound=null,odLeft=0,extraTarget=null,cur=null;
  const label=(u,k)=>k===NORMAL?'normal':party[u].skills[k]?.label||'';
  for(const p of plan){
    switch(p.k){
      case 'turn':t=emptyTurn();turns.push(t);odRound=null;odLeft=0;break;
      case 'od':cur={level:p.level,rounds:[]};if(p.window==='turnStart')t.odStart=cur;else t.odEnd=cur;odLeft=p.level;break;
      case 'front':
        if(odLeft>0){odRound={front:p.units,actions:[],extra:[]};cur.rounds.push(odRound);}
        else{odRound=null;t.front=p.units;}
        break;
      case 'act':(odRound?odRound.actions:t.actions).push({u:p.u,s:label(p.u,p.s)});break;
      case 'extraStart':extraTarget=odRound?odRound.extra:t.extra;break;
      case 'extra':extraTarget.push({u:p.u,s:label(p.u,p.s)});break;
      case 'odEnd':odRound=null;odLeft--;break;
    }
  }
  return {phases:[{turns}]};
}

// ---------------------------------------------------------------- 成功期望（蒙特卡洛）
export function mulberry32(seed){let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
// 每个样本拥有独立的随机流。同一候选增加样本数时复用原样本，另一条轴提前结束也不改变后续样本。
export const monteCarloSampleSeed=(seed,index)=>(seed+Math.imul(index,0x9E3779B9))>>>0;
/**
 * 同一份设计按随机暴击（逐段）、伤害浮动 90–110%、敌方随机选单体目标与伤害浮动重放 n 次。
 * success = 全部阶段击破、无人 HP 清零且每个已执行的计划动作合法；默认允许按最后一回合续打 2 回合，onPlan 单独统计原轴内完成。
 * scoreMean / scoreP10 仅统计成功样本；失败仍计入 success / onPlan 的分母和 fails，未成功时分数为 null。
 */
export function monteCarlo(ctx,o,design,{n=100,seed=1,scoreOf=null}={}){
  if(!Number.isInteger(n)||n<1)throw new RangeError('模拟次数必须是正整数');
  if(!Number.isFinite(seed))throw new TypeError('模拟种子必须是有限数值');
  let ok=0,onPlan=0;const scores=[],fails={},turns=[];
  for(let k=0;k<n;k++){
    const rng=mulberry32(monteCarloSampleSeed(seed,k));
    const res=simulateDesign(ctx,{...o,critMode:'random',enemyTargeting:'random',enemyVariance:'random',rng,extendTurns:o.extendTurns??2,trace:false},design);
    const invalid=res.issues.some(x=>x.level==='error');
    const success=!invalid&&!res.failed&&res.phases.length===(ctx.phases?.length||1)&&res.phases.every(p=>p.cleared);
    if(success){ok++;turns.push(res.turns);if(res.phases.every(p=>!p.extended))onPlan++;}else{const key=res.failed?`第 ${res.failed} 回合失败`:invalid?'计划含不可用行动':`第 ${res.phases.findIndex(p=>!p.cleared)+1||res.phases.length+1} 阶段未清`;fails[key]=(fails[key]||0)+1;}
    if(success&&scoreOf){const score=scoreOf(res);if(!Number.isFinite(score))throw new TypeError('成功样本评分必须是有限数值');scores.push(score);}
  }
  scores.sort((a,b)=>a-b);
  turns.sort((a,b)=>a-b);
  const scoreMean=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;
  if(scoreMean!==null&&!Number.isFinite(scoreMean))throw new RangeError('成功样本平均分超出有限数值范围');
  return {n,successes:ok,success:ok/n,onPlan:onPlan/n,turnsMedian:turns.length?turns[Math.floor(turns.length/2)]:null,fails,
    scoreBasis:'successful',scoreSamples:scores.length,scoreMean,scoreP10:scores.length?scores[Math.floor(scores.length*0.1)]:null};
}
