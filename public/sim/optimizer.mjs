// 排轴配置优化：在“全部已持有卡面 + 饰品库存”范围内搜索队伍、技能、饰品与遭遇战战术卡。
// 流程：
//   1. 种子：当前队伍、游戏里的 6 人编队、同角色换卡面；再按权重随机组若干支全新队伍（不看职能）。
//   2. 评估：粗筛（全部技能可用、按阶段串联搜索，SP/OD/DP 跨阶段继承）；不差于精英末位的再补完——
//      按“技能格上限”挑技能（保留实际用到的、余格补通用被动）后重排。
//   3. 进化搜索（固定评估预算、确定性批次）：从精英队伍出发，按模拟里的实际贡献挑最闲的人换掉 / 换两人 / 与另一支精英交叉 / 换耳环；
//      卡面抽取权重 = 先验（属性契合、养成）×（1 + 在精英队伍里出现的频率），停滞时注入随机新队。
//   4. 入围队伍逐阶段贪心挑战术卡（每个阶段试全部可能有用的卡），再用更宽的搜索重排。
//   5. 蒙特卡洛：旧轴/宽束/挑卡轴用共同随机种子复排，保留最多 20 个不同方案；另给无卡成功率。
import {buildParty,initialState,cloneState,NORMAL,isOrbSkillId} from './hbr/battle.mjs';
import {membersFromDeck,equipmentFrom,skillSlotCap} from './hbr/deck.mjs';
import {membersFrom} from './party.mjs';
import {search,replay} from './search.mjs';
import {simulateDesign,designFromPlan,monteCarlo,emptyTurn,mulberry32} from './designer.mjs';
import {applyCard,relevantCards,cardById} from './cards.mjs';
import {waveScore,waveRoundScore} from '../boss-model.mjs';
import {normalizeTeamElement,normalizeMinSuccess,normalizeSuccessBasis,resultLimit,rawIdentity,candidateIdentity,attackElements,elementSummary,searchBudget} from './optimizer-options.mjs';

const lc=x=>String(x||'').toLowerCase();
const EAR_LABEL={attacking:'进攻耳環',breaking:'BREAK耳環',drive:'DRIVE耳環',devastating:'破坏率耳環'};
// 遭遇战：每次 3 选 1、可重抽 5 次 → 共看到 6 组；按 28 张卡等概率不重复抽 3 张估算（推定）
const CARD_POOL=28,CARD_DRAWS=6;
const choose=(n,k)=>{let r=1;for(let i=0;i<k;i++)r=r*(n-i)/(i+1);return r;};
export const cardSeenProb=k=>1-Math.pow(choose(CARD_POOL-k,3)/choose(CARD_POOL,3),CARD_DRAWS);
// 通用化被动的粗略价值（补余格用）
const PASSIVE_VALUE={OverDrivePointUp:3,HealSp:3,HealSkillUsedCount:2,DamageRateUp:2,AttackUp:2,CriticalDamageUp:2,CriticalRateUp:1.5,Morale:1.5,
  GiveDefenseDebuffUp:2,ZoneUpEternal:2,DefenseDown:1,HighBoost:1,SpLimitOverwrite:1,DefenseUp:0.5,HealDpRate:0.5};
const DEFAULT_CARDS=[null,'critRate100','sp5','skillCount1','dpRevive'];

/** 饰品库存：每种耳环（进攻/BREAK/DRIVE）效果最大的一件；每种属性等级最高的戒指。 */
function inventoryBest(inv,byId){
  const ear={},ring={};
  for(const a of inv){
    const e=byId.get(a.masterId);if(!e)continue;
    const inst={masterId:a.masterId,main:a.main,expansion:a.expansion,plus:a.plus};
    if(e.slot==='earring'){
      const eq=equipmentFrom({earring:a},byId,null);
      const type=eq.earring?.type||(eq.odEarringBonus?'drive':null);if(!type)continue;
      const v=eq.earring?.bonus||eq.odEarringBonus||0;
      if(!ear[type]||v>ear[type].v)ear[type]={v,inst};
    }else if(e.slot==='ring'){
      const eq=equipmentFrom({ring:a},byId,null);if(!eq.ringElement)continue;
      if(!ring[eq.ringElement]||eq.ringLevel>ring[eq.ringElement].v)ring[eq.ringElement]={v:eq.ringLevel,inst};
    }
  }
  return {ear,ring};
}

/**
 * input = {data:{catalog,skills,stats,equipment}, archive, cache:{decks,cards,accessories}, base:[planner 成员×6],
 *          target:{kind, ev, rules, phases:[{enemies}], cards:[每阶段卡|null], difficulty, international},
 *          ruleOptions:[{ids,rules,phases}]（可选：要搜索的规则组合，每项带该规则下构建的阶段敌人）, ruleIndex（当前所选规则在其中的位置）},
 *          opts:{goal:'score'|'stable'|'fast', teamElement:''|'ice'|'fire'|'thunder'|'light'|'dark'|'nonelemental',
 *                beam, screenBeam, maxTurns, mcRuns, searchEvals, searchBatch, randomSeeds, top:1..20, minSuccess:0..1, minSuccessBasis:'onPlan'|'success', optimizeCards, broad, fixedTeam, allOrbs, threads},
 *          incumbents:[{members,design,ruleIds,label}]（同任务的旧轴，重新模拟，不复用旧评分）}
 */
export async function optimize(input,onProgress=()=>{},runner=null){
  const S=setup(input,onProgress);
  return S.coordinate(runner||inlineRunner(S));
}
/** 同线程执行（测试 / 不支持嵌套 Worker 时的回退）。 */
export function inlineRunner(S){return {size:1,run:task=>Promise.resolve().then(()=>S.handle(task)),close(){}};}
/** 子 Worker 用：建立一份只用于计算的上下文，返回任务处理函数。 */
export function createTaskHandler(input){const S=setup(input,()=>{});return task=>S.handle(task);}

function setup(input,onProgress=()=>{}){
  const {data,archive,cache,base,target,opts}=input;
  const {catalog,skills,stats,equipment}=data;
  const t0=Date.now();
  const styleById=new Map(catalog.styles.map(s=>[s.id,s]));
  const charName=new Map(catalog.characters.map(c=>[c.id,c.name]));
  const byEq=new Map((equipment.entries||[]).map(e=>[e.sourceId,e]));
  const name=id=>{const s=styleById.get(id);return `${charName.get(s?.characterId)||''}〈${s?.name||id}〉`;};
  const roleOf=id=>styleById.get(id)?.role;
  const isWave=target.kind==='wave';
  const phases=target.phases.map(p=>p.enemies);
  const nPhases=phases.length;
  // 规则组合：每个候选带一个规则编号（party._ri），模拟用该规则下的敌人、计分用该规则的倍率
  const ruleOpts=(target.ruleOptions?.length?target.ruleOptions:[{ids:(target.rules||[]).map(r=>r.id),rules:target.rules||[],phases:target.phases}])
    .map(o=>({...o,enemies:o.phases.map(p=>p.enemies),names:(o.rules||[]).map(r=>r.name)}));
  const ruleBase=Math.min(ruleOpts.length-1,Math.max(0,target.ruleIndex||0));
  const RO=party=>ruleOpts[party?._ri??ruleBase]||ruleOpts[0];
  // 目标：score = 通关样本均分最高（遭遇战）；stable = 成功率优先；fast = 回合最少
  const goal=opts.goal||(isWave?'score':'stable');
  const teamElement=normalizeTeamElement(opts.teamElement),topLimit=resultLimit(opts.top);
  const minSuccess=normalizeMinSuccess(opts.minSuccess);
  const minSuccessBasis=normalizeSuccessBasis(opts.minSuccessBasis);
  const userCards=(target.cards||[]).some(Boolean)?target.cards:null;
  const progress=(step,done,total,label)=>onProgress({step,done,total,label,elapsed:Date.now()-t0});

  // ---------------------------------------------------------------- 目标属性（敌人弱点，按 DP+HP 加权）
  const weak={};let wsum=0;
  for(const list of phases)for(const e of list){const w=(e.maxDp||0)+(e.maxHp||0)||1;wsum+=w;
    for(const [k,v] of Object.entries(e.weaknesses?.element||{}))if(k!=='nonelemental')weak[k]=(weak[k]||0)+v*w;}
  for(const k of Object.keys(weak))weak[k]/=wsum||1;
  const evEls=(target.ev?.elements||[]).map(lc);
  const goodEls=Object.entries(weak).filter(([k,v])=>v>100||evEls.includes(k)).sort((a,b)=>b[1]-a[1]).map(([k])=>k);
  const fitOf=s=>{const els=(s?.elements||[]).map(lc);if(!els.length)return 0.3;return Math.max(...els.map(x=>goodEls.includes(x)?1:(weak[x]||100)>=100?0.4:0.1));};

  // ---------------------------------------------------------------- 候选
  const inv=inventoryBest(cache.accessories||[],byEq);
  const cands=[];const seen=new Set();
  const valid=raws=>{
    if(raws.length!==6||raws.some(r=>!r?.styleId||!styleById.has(r.styleId)))return false;
    const chars=raws.map(r=>styleById.get(r.styleId).characterId);
    if(new Set(chars).size!==6)return false;
    return raws.filter(r=>roleOf(r.styleId)==='Admiral').length<=1;
  };
  const add=(label,raws,front,origin,rule=ruleBase)=>{
    if(!valid(raws))return null;
    const k=candidateIdentity(raws,front,rule);if(seen.has(k))return null;seen.add(k);
    const c={label,raws,front:front||raws.map((_,i)=>i<3),origin,rule};cands.push(c);return c;
  };
  const decks=(cache.decks||[]).filter(d=>d.members.filter(Boolean).length===6);
  const baseRaws=base.map(m=>m.raw).filter(Boolean);
  const baseOk=baseRaws.length===6;
  const baseFront=base.map(m=>!!m.front);
  const sameRules=(a,b)=>JSON.stringify([...(a||[])].map(String).sort())===JSON.stringify([...(b||[])].map(String).sort());
  const incumbentRule=x=>x.ruleIds==null?ruleBase:ruleOpts.findIndex(r=>sameRules(r.ids,x.ruleIds));
  const ownedStyles=new Set([...(cache.cards||[]).map(c=>c.styleId),...base.map(m=>m.styleId),
    ...decks.flatMap(d=>d.members.map(m=>m.styleId)),...Object.keys(archive?.styles||{}).filter(id=>archive.styles[id].owned)]);
  /** 旧结果只提供配置与轴；重新派生面板/饰品/支援效果并验证本次的约束，不能作为绕过入口。 */
  function normalizeIncumbent(x){
    if(x?.members?.length!==6||x.design?.phases?.length!==nPhases||incumbentRule(x)<0)return null;
    if(!valid(x.members.map(m=>m.raw))||x.members.some(m=>m.styleId!==m.raw.styleId||!ownedStyles.has(m.styleId)))return null;
    if(opts.fixedTeam&&x.members.some((m,i)=>m.styleId!==base[i]?.styleId))return null;
    if(x.members.filter(m=>m.front).length!==3)return null;
    const cards=x.design.phases.map(p=>p.card||null);
    if(cards[0]||cards.some(c=>c&&!cardById(c))||new Set(cards.filter(Boolean)).size!==cards.filter(Boolean).length)return null;
    if(opts.optimizeCards===false&&cards.some((c,p)=>c!==(p>0?target.cards?.[p]||null:null)))return null;
    const raws=x.members.map(m=>structuredClone(m.raw));
    if(raws.some(r=>r.supportStyleId&&!ownedStyles.has(r.supportStyleId)))return null;
    const ms=membersFromDeck({index:-1,name:'',members:raws},{catalog,equipment,stats,previous:x.members});
    const declared=x.members.map(m=>m.deckSkillIds?.length?m.deckSkillIds:m.raw.skillIds||[]);
    for(let i=0;i<ms.length;i++){
      const ids=declared[i],raw=raws[i],cap=skillSlotCap(raw,roleOf(raw.styleId));
      if(!Array.isArray(ids)||ids.some(id=>!Number.isInteger(id))||new Set(ids).size!==ids.length||ids.length>cap)return null;
      const character=catalog.characters.find(c=>c.id===styleById.get(raw.styleId)?.characterId);
      const available=new Set((character?.styleIds||[]).filter(id=>ownedStyles.has(id)).flatMap(id=>(skills.styles[id]?.skills||[]).map(s=>s.id)));
      for(const id of ids){
        if(stats?.extraSkills?.[String(id)]){
          if(!(raw.skillIds||[]).includes(id)&&!(opts.allOrbs!==false&&isOrbSkillId(id)))return null;
        }else if(!available.has(id)&&!(raw.skillIds||[]).includes(id))return null;
      }
      ms[i].front=!!x.members[i].front;ms[i].deckSkillIds=ids.slice();ms[i].allOrbSkills=false;
    }
    const converted=membersFrom({members:ms},archive,catalog);if(!converted.ready)return null;
    const party=buildParty(converted.members,{skills,catalog,stats});
    const used=ms.map(()=>new Set());
    for(const p of x.design.phases)for(const t of p.turns||[]){
      const rounds=[t,...(t.odStart?.rounds||[]),...(t.odEnd?.rounds||[])];
      for(const r of rounds)for(const a of [...(r.actions||[]),...(r.extra||[])]){
        if(!a.s||a.s==='normal')continue;
        const sk=party[a.u]?.skills.find(s=>s.label===a.s);if(!sk)return null;
        if(sk.id>0&&!/CommandBuff$/.test(sk.label||''))used[a.u].add(sk.id);
      }
    }
    for(let i=0;i<ms.length;i++)if(!declared[i].length){
      // 手排未指定技能列表时，从实际动作补齐配置；本卡被动也占据技能格。
      const ids=new Set([...used[i],...party[i].skills.filter(s=>s.ownStyle&&s.passive&&s.id>0).map(s=>s.id)]);
      if(ids.size>skillSlotCap(raws[i],party[i].role))return null;
      ms[i].deckSkillIds=[...ids];
    }
    return {...x,members:ms,design:structuredClone(x.design)};
  }
  const incumbentInputs=(input.incumbents||[]).slice(0,21).map(normalizeIncumbent).filter(Boolean);
  // 新成员用的“位置模板”（饰品其余槽、支援卡、宝珠沿用这个位置的）
  const tplRaws=baseOk?baseRaws:(decks.find(d=>d.current)||decks[0])?.members||[];
  /** 换卡沿用该位置的耳环/其余槽/支援/宝珠；戒指按属性挑选，潜在清空（角色专属）。 */
  const placeCard=(tpl,card)=>{
    const s=styleById.get(card.styleId);
    const acc={...(tpl?.accessories||{})};const changes=[];
    // Role labels do not predict the actual job. Keep this slot's earring;
    // mutations explore every available type and let simulated results decide.
    const el=lc((s?.elements||[])[0]),ring=inv.ring[el];
    if(ring&&acc.ring?.masterId!==ring.inst.masterId){acc.ring=ring.inst;changes.push(`${el} 戒指`);}
    return {...(tpl||{}),styleId:card.styleId,cardSourceId:card.cardSourceId,characterId:card.characterId,limitBreak:card.limitBreak,tearLevel:card.tearLevel,
      card:card.card,character:card.character,characterCards:card.characterCards,skillIds:[],latentIds:[],accessories:acc,_new:true,_changes:changes,_earNote:undefined};
  };

  if(baseOk)add('当前队伍',baseRaws,baseFront,'base');
  for(const x of incumbentInputs)add(x.label||'已有高分方案',x.members.map(m=>m.raw),x.members.map(m=>!!m.front),'incumbent',incumbentRule(x));
  for(const d of decks)add(`编队 ${d.index}「${d.name}」`,d.members,null,'deck');
  if(baseOk){
    baseRaws.forEach((r,i)=>{
      const alts=(cache.cards||[]).filter(c=>c.characterId===r.characterId&&c.styleId!==r.styleId)
        .sort((a,b)=>(b.limitBreak||0)-(a.limitBreak||0)).slice(0,2);
      for(const c of alts){const raws=baseRaws.slice();raws[i]=placeCard(r,c);add(`当前队伍第 ${i+1} 位换成 ${name(c.styleId)}`,raws,baseFront,'swap');}
    });
    // 换耳环不再作为种子逐个枚举，改由进化搜索里的“换耳环”变异探索
  }
  // 规则：当前队伍与各编队在其他规则下也各评估一次
  if(ruleOpts.length>1&&opts.searchRules!==false){
    const base_=cands.filter(c=>c.origin==='base'||c.origin==='deck');
    for(const c of base_)for(let ri=0;ri<ruleOpts.length;ri++)if(ri!==c.rule)add(c.label,c.raws,c.front,c.origin,ri);
  }

  // 全新队伍的卡面池：全部已持有 SS/SSR 卡面。不看职能——先验只看属性契合与养成度，
  // 搜索中再按“精英队伍里出现的频率”自适应加权（交叉熵式），让模拟结果决定谁值得上场。
  const pool=(cache.cards||[]).map(c=>({c,s:styleById.get(c.styleId)})).filter(x=>x.s&&['SS','SSR'].includes(x.s.tier));
  const capability=new Map();
  const elementsOf=c=>{
    if(capability.has(c.styleId))return capability.get(c.styleId);
    const character=catalog.characters.find(x=>x.id===styleById.get(c.styleId)?.characterId);
    const owned=(character?.styleIds||[]).filter(id=>id===c.styleId||archive?.styles?.[id]?.owned||(cache.cards||[]).some(x=>x.styleId===id));
    const active=owned.flatMap(id=>(skills.styles[id]?.skills||[]).filter(s=>id===c.styleId||!s.restricted));
    const els=attackElements(active);
    if(owned.some(id=>skills.styles[id]?.immersion))for(const el of ['thunder','light','dark'])els.add(el);
    capability.set(c.styleId,els);return els;
  };
  for(const x of pool){
    const {c,s}=x,cap=skillSlotCap(c,s.role);
    x.prior=(teamElement?(elementsOf(c).has(teamElement)?1:0.4):fitOf(s))*1.5+(c.limitBreak||0)*0.08+(c.card?.daphne?0.3:0)+Math.min(20,c.character?.reincarnation||0)*0.02+cap*0.05+(s.tier==='SSR'?0.15:0);
    x.elite=0;
  }
  pool.sort((a,b)=>b.prior-a.prior);
  const rng=mulberry32(opts.seed??97);
  const weightOf=x=>Math.max(0.05,x.prior)*(1+3*x.elite);
  const wpick=(list,w)=>{let tot=0;for(const x of list)tot+=w(x);let r=rng()*tot;for(const x of list){r-=w(x);if(r<=0)return x;}return list.at(-1)||null;};
  const isAdm=styleId=>roleOf(styleId)==='Admiral';
  /** 第 i 位可换上的卡面（角色不重复、ADMIRAL 至多 1 名）。 */
  const optionsFor=(raws,i)=>{
    const chars=new Set(raws.filter((_,j)=>j!==i).map(r=>r.characterId));
    const adm=raws.some((r,j)=>j!==i&&isAdm(r.styleId));
    return pool.filter(x=>!chars.has(x.c.characterId)&&!(adm&&x.s.role==='Admiral')&&x.c.styleId!==raws[i]?.styleId);
  };
  /** 随机组一支新队：按权重抽 6 张；el 给定时偏向该属性（×3）。 */
  const sampleTeam=el=>{
    const raws=[];
    for(let i=0;i<6;i++){
      let list=optionsFor([...raws,{}],raws.length);
      // Reserve one actual attack-skill anchor; the other five slots stay open.
      if(i===0&&teamElement)list=list.filter(x=>elementsOf(x.c).has(teamElement));
      const pick=wpick(list,x=>weightOf(x)*(el&&elementsOf(x.c).has(el)?3:1));
      if(!pick)return null;
      raws.push(placeCard(tplRaws[i],pick.c));
    }
    return raws;
  };
  let randomNo=0;
  const addRandom=el=>{const raws=sampleTeam(el);if(!raws)return null;randomNo++;
    const c=add(`全新队伍 #${randomNo}（${el?el+' 偏向':'不限属性'}起点）`,raws,null,'random',ruleOpts.length>1&&opts.searchRules!==false?Math.floor(rng()*ruleOpts.length):ruleBase);if(c){c.root=c.label;c.rootRaws=raws;c.island=true;}return c;};
  // 固定配队：只评估当前队伍（各规则组合），不换人、不组新队、不做进化搜索
  if(opts.fixedTeam)for(let i=cands.length-1;i>=0;i--)if(!['base','incumbent'].includes(cands[i].origin))cands.splice(i,1);
  const broad=opts.broad!==false&&!opts.fixedTeam;
  if(broad){
    const seedsN=opts.randomSeeds??8;
    const els=teamElement?[teamElement]:[...goodEls.slice(0,3),null];
    for(let k=0;k<seedsN;k++)addRandom(els[k%els.length]);
  }
  for(const c of cands)if(!c.root){c.root=c.label;c.rootRaws=c.raws;}

  // ---------------------------------------------------------------- 评估
  const allOrbs=opts.allOrbs!==false;
  const partyCache=new Map();
  const partyOf=(raws,front,ri=ruleBase)=>{
    const cacheKey=JSON.stringify([candidateIdentity(raws,front,ri),raws.map(r=>r._skills)]);
    if(partyCache.has(cacheKey)){const old=partyCache.get(cacheKey);return {...old,party:old.party.slice()};}
    const ms=membersFromDeck({index:-1,name:'',members:raws},{catalog,equipment,stats});
    // _skills 未定 = 第一遍：用该角色全部可用技能；之后按技能格挑出的列表。宝玉技能可随时换装：默认全部可用（仍占技能格）
    ms.forEach((m,i)=>{m.front=!!front[i];m.deckSkillIds=raws[i]._skills?raws[i]._skills.slice():[];if(allOrbs&&!raws[i]._skills)m.allOrbSkills=true;});
    const {members,ready,issues}=membersFrom({members:ms},archive,catalog);
    if(!ready)throw Error(issues.join('；'));
    const built={party:buildParty(members,{skills,catalog,stats}),members:ms};
    if(partyCache.size>=128)partyCache.delete(partyCache.keys().next().value);
    partyCache.set(cacheKey,built);return {...built,party:built.party.slice()};
  };
  // 遭遇战伤害分是否计溢出伤害（推定：画面显示整次攻击伤害，社区 15 万分实例只有计溢出才解释得通）
  const overkill=isWave&&opts.overkill!==false;
  // 目标“最高分”（遭遇战）：每阶段搜索权衡“多打一回合”的伤害分增量与回合分损失（turnCost = 总回合从 N 到 N+1 的回合分差，N = 阶段数）
  const diff=target.difficulty||40,intl=target.international!==false;
  const turnCost=waveRoundScore(nPhases,diff,intl)-waveRoundScore(nPhases+1,diff,intl);
  // 最快路线的分数不是高分路线的上界；高分目标从粗筛起就搜索分数，避免误删蓄力路线。
  const so=(b,quick=false)=>({objective:goal==='score'&&isWave?'waveScore':'minTurns',turnCost,extraTurns:opts.extraTurns??2,maxTurns:opts.maxTurns||6,beam:b,critMode:'expected',allowOd:true,odWindows:['turnStart','turnEnd'],damageNorm:1e6,overkill,teamElement,top:1,trace:false});
  const scoreOf=(res,party)=>isWave?waveScore({damages:res.phases.map(x=>overkill?x.shown??x.damage:x.damage),turns:res.turns,difficulty:diff,rules:RO(party).rules||[],international:intl}).total:null;

  /** 从第 p0 阶段（该阶段选卡前的状态 st0）起串联搜索到最后。返回各阶段计划与选卡前状态。 */
  function chain(party,cards,beam,p0=0,st0=null,quick=false){
    const phases=RO(party).enemies;
    let st=st0||initialState(party,phases[0][0],{critMode:'expected',statusTypes:skills.statusTypes,teamElement});
    const plans=[],states=[];
    for(let p=p0;p<nPhases;p++){
      states[p]=st;
      let enemies=phases[p],root=st;
      const card=p>0?cards[p]:null;
      if(card){root=cloneState(st);const nb=applyCard(root,card);if(nb.borderDown)enemies=enemies.map(e=>({...e,border:Math.max(0,e.border-nb.borderDown)}));}
      const ctx={party,enemy:enemies[0],phaseEnemies:nPhases>1||enemies.length>1?enemies:null,statusTypes:skills.statusTypes};
      const rootState=p>0||ctx.phaseEnemies?root:null;
      const r=search(ctx,{...so(beam,quick),rootState});
      const plan=r.plans[0]?.plan;
      if(!plan){plans[p]={plan:(r.unfinished||{plan:[]}).plan,ok:false};break;}
      plans[p]={plan,ok:true};
      st=replay(ctx,{...so(beam,quick),rootState},plan);
    }
    return {plans,states};
  }
  /** 计划 → 设计 → 重放（期望暴击），给出排名键。 */
  /** 稳定目标用少量共同随机样本辅助粗评；高分目标保留计划分排序，入围后再比较通关样本均分。 */
  const MCJ=opts.mcJudge??3;
  function judge(party,cards,plans,mcN=0){
    const design={phases:Array.from({length:nPhases},(_,p)=>({card:p>0?cards[p]||null:null,
      turns:plans[p]?designFromPlan(plans[p].plan,party).phases[0].turns:[emptyTurn()]}))};
    return judgeDesign(party,design,mcN);
  }
  function judgeDesign(party,design,mcN=0){
    const sctx={party,phases:RO(party).phases,statusTypes:skills.statusTypes};
    const res=simulateDesign(sctx,{critMode:'expected'},design);
    const cleared=res.phases.filter(x=>x.cleared).length;
    const damage=res.phases.reduce((a,x)=>a+(x.shown??x.damage),0);
    const score=isWave?scoreOf(res,party):null;
    const invalid=res.issues.some(x=>x.level==='error');
    // 稳健性：同一份排轴全不暴击时能否照样打完（不顺延回合）
    const nc=simulateDesign(sctx,{critMode:'none'},design);
    const robust=nc.phases.filter(x=>x.cleared).length+(nc.failed||nc.issues.some(x=>x.level==='error')?0:0.5);
    // 高分候选探索看确定性计划分，3次偶发失败不能在粗筛阶段淘汰一条高分轴。
    const mc=mcN>0&&goal==='stable'?monteCarlo(sctx,{},design,{n:mcN,seed:11,scoreOf:isWave?r=>scoreOf(r,party):null}):null;
    // 未做粗评 MC 时用计划分，成功率暂按 1 计；这是搜索启发式，不是全局最优保证。
    const expScore=mc&&isWave?(Number.isFinite(mc.scoreMean)?Math.round(mc.scoreMean):-Infinity):score||0,expOk=mc?mc.success:1;
    const element=elementSummary(res.elementDamage,teamElement);
    const key=goal==='stable'?[cleared,res.failed||invalid?0:1,expOk,robust,isWave?expScore:-res.turns,-res.turns,damage]
        :goal==='fast'?[cleared,res.failed||invalid?0:1,-res.turns,robust,isWave?score||0:0,damage]
        :[cleared,res.failed||invalid?0:1,isWave?expScore:-res.turns,expOk,robust,-res.turns,damage];
    if(teamElement)key.unshift(element.elementMatch?1:0);
    return {design,sctx,res,cleared,failed:res.failed,invalid,turns:res.turns,score,damage,robust,expScore,expOk,...element,key};
  }
  const better=(a,b)=>{if(!b)return true;for(let k=0;k<a.key.length;k++)if(a.key[k]!==b.key[k])return a.key[k]>b.key[k];return false;};
  /** 技能格：按计划里实际用到的次数保留，余格补通用被动；返回每人选中的技能 id（null = 不需要限制）。 */
  function pickSkills(party,raws,plans){
    const used=party.map(()=>new Map());
    for(const pl of plans)for(const x of pl?.plan||[])if((x.k==='act'||x.k==='extra')&&x.s!==NORMAL){
      const sk=party[x.u]?.skills[x.s];if(!sk||!(sk.id>0)||/CommandBuff$/.test(sk.label||''))continue;
      used[x.u].set(sk.id,(used[x.u].get(sk.id)||0)+1);
    }
    let need=false;
    const out=party.map((u,i)=>{
      const raw=raws[i],cap=skillSlotCap(raw,u.role);
      // 大师技能（与角色绑定）：原编队装了就保留，占格。宝玉技能可随时换装（allOrbs）：和其他技能一样按使用情况挑
      const extras=(raw.skillIds||[]).filter(id=>stats?.extraSkills?.[String(id)]&&!(allOrbs&&isOrbSkillId(id)));
      const room=Math.max(0,cap-extras.length);
      const actives=[...used[i]].sort((a,b)=>b[1]-a[1]).map(([id])=>id);
      if(actives.length>room)need=true;
      const pick=actives.slice(0,room);
      // 原编队装备过的、价值高的通用被动优先；再按价值补
      const passives=u.skills.filter(s=>s.passive&&s.id>0&&!s.ownStyle&&!pick.includes(s.id))
        .map(s=>({s,v:((s.passive.parts?.length?s.passive.parts:s.parts)||[]).reduce((a,p)=>a+(PASSIVE_VALUE[p.skillType]||0),0)+((raw.skillIds||[]).includes(s.id)?0.5:0)}))
        .filter(x=>x.v>0).sort((a,b)=>b.v-a.v);
      for(const {s} of passives){if(pick.length>=room)break;pick.push(s.id);need=true;}
      // 余格：原编队装备过的其他技能（不影响模拟，只为让装备列表完整）
      for(const id of raw.skillIds||[]){if(pick.length>=room)break;if(!pick.includes(id)&&!extras.includes(id)&&u.skills.some(s=>s.id===id))pick.push(id);}
      // 仍有空格：本卡面的主动技能、再其他卡面的（SP 高的优先）。保证列表非空（空列表会被引擎当作“不限制”）
      const rest=u.skills.filter(s=>s.id>0&&!s.passive&&!pick.includes(s.id)&&!/CommandBuff$/.test(s.label||''))
        .sort((a,b)=>(b.ownStyle?1:0)-(a.ownStyle?1:0)||(b.sp||0)-(a.sp||0));
      for(const s of rest){if(pick.length>=room)break;pick.push(s.id);}
      return {ids:[...extras,...pick],cap,usedCount:actives.length};
    });
    return {need,out};
  }
  /** 完整评估：全技能排一遍 → 按技能格挑技能 → 重排。 */
  function evaluate(c,cards,beam){
    return finish(screen(c,cards,beam),cards,beam);
  }
  /** 粗筛：不限技能格（全部技能可用，偏乐观）排一遍。成本约为完整评估的一半。 */
  function screen(c,cards,beam){
    const raws=c.raws.map(r=>({...r,_skills:undefined}));
    const {party,members}=partyOf(raws,c.front);party._ri=c.rule??ruleBase;
    const run=chain(party,cards,beam,0,null,true);
    const j=judge(party,cards,run.plans);
    return {...c,raws,party,members,plans:run.plans,states:run.states,cards:cards.slice(),slots:null,screenOnly:true,...j,contrib:contribOf(j.res,party.length)};
  }
  /** 补完：按技能格挑技能后重排（第一遍沿用粗筛结果）。 */
  function finish(s,cards,beam){
    const sel=pickSkills(s.party,s.raws,s.plans);
    const raws=s.raws.map((r,i)=>({...r,_skills:sel.out[i].ids}));
    const {party,members}=partyOf(raws,s.front);party._ri=s.rule??ruleBase;
    const run=chain(party,cards,beam);
    const j=judge(party,cards,run.plans,MCJ);
    return {...s,raws,party,members,plans:run.plans,states:run.states,cards:cards.slice(),slots:sel.out,screenOnly:false,...j,contrib:contribOf(j.res,party.length)};
  }
  /** 每名成员在排轴里的实际贡献：主动技能次数（普攻按 0.3）+ 伤害占比 ×6。不看职能，只看模拟里做了什么。 */
  function contribOf(res,n){
    const act=Array(n).fill(0),dmg=Array(n).fill(0);
    for(const r of res?.rows||[])if(r.kind==='act'&&r.unit>=0&&r.unit<n){act[r.unit]+=r.cost>0||r.skill!=='普通攻击'?1:0.3;dmg[r.unit]+=Math.max(0,r.damage||0);}
    const tot=dmg.reduce((a,b)=>a+b,0)||1;
    return act.map((a,i)=>a+6*dmg[i]/tot);
  }
  const safe=(f,label)=>{try{return f();}catch(err){errors.push({label,error:err.message});return null;}};
  const errors=[];
  const screenCards=userCards||(opts.optimizeCards===false?Array(nPhases).fill(null):DEFAULT_CARDS.slice(0,nPhases));
  const screenBeam=opts.screenBeam||Math.min(4,opts.beam||6);
  const rankIds=new WeakMap();
  const rankId=x=>{if(!rankIds.has(x))rankIds.set(x,candidateIdentity(x.raws||x.members.map(m=>m.raw),x.front||x.members?.map(m=>m.front),x.rule)+'|'+JSON.stringify(x.design||{}));return rankIds.get(x);};
  const tie=(a,b)=>{const x=rankId(a),y=rankId(b);return x<y?-1:x>y?1:0;};
  const sortRes=list=>list.sort((a,b)=>better(a,b)?-1:better(b,a)?1:tie(a,b));
  const teamKey=r=>r.raws.map(x=>x.styleId).sort().join('|');
  const results=[];   // 完整评估过的
  let screened=0,promoted=0;
  const ELITE=Math.max(opts.elite||24,topLimit);
  let elites=[];
  const refreshElites=()=>{
    sortRes(results);elites=[];const seenT=new Set();
    for(const r of results){const k=teamKey(r);if(seenT.has(k))continue;seenT.add(k);elites.push(r);if(elites.length>=ELITE)break;}
    // 自适应采样权重：卡面在精英队伍里出现的比例（名次越前权重越大）
    for(const x of pool)x.elite=0;
    const byStyle=new Map(pool.map(x=>[x.c.styleId,x]));
    elites.forEach((r,k)=>{for(const m of r.raws){const x=byStyle.get(m.styleId);if(x)x.elite+=(ELITE-k)/ELITE/ELITE*2;}});
  };
  // “新队伍岛”：从随机起点衍生的队伍单独保留前几名（含只粗筛过的），让全新阵容有机会长起来，不被现有编队压住
  let island=[];
  const ISLAND=opts.island||5;
  const pushIsland=r=>{if(!r?.island)return;
    const k=teamKey(r),old=island.find(x=>teamKey(x)===k);
    if(old){if(!better(r,old))return;island=island.filter(x=>x!==old);}
    island.push(r);sortRes(island);island=island.slice(0,ISLAND);};

  // ================================================================ 子 Worker 侧：任务处理
  /** 回传给协调者的轻量结果（可结构化克隆；不含 party/状态/日志）。 */
  const light=r=>({label:r.label,raws:r.raws,front:r.front,origin:r.origin,rule:r.rule,root:r.root,rootRaws:r.rootRaws,island:!!r.island,kind:r.kind,
    key:r.key,contrib:r.contrib,slots:r.slots,screenOnly:r.screenOnly,score:r.score,turns:r.turns,cleared:r.cleared,failed:r.failed,invalid:r.invalid,damage:r.damage,robust:r.robust,elementMatch:r.elementMatch});
  /** eval：粗筛 → 若不比 worst（当前第 ELITE 名的排名键）差，再补完。final：入围方案挑战术卡 + 蒙特卡洛。 */
  function handle(task){
    const e0=errors.length;
    let out=null;
    if(task.type==='eval'){
      const c=task.cand;
      const s=safe(()=>screen(c,screenCards,screenBeam),c.label);
      if(s){
        if(task.worst&&!better(s,{key:task.worst}))out=light(s);
        else{const f=safe(()=>finish(s,screenCards,screenBeam),c.label);out=light(f||s);}
      }
    }else if(task.type==='final')out=safe(()=>finalize(task.f,task.fi),task.f.label);
    else if(task.type==='incumbent')out=safe(()=>rateIncumbent(task.incumbent),task.incumbent.label||'已有方案');
    return {r:out,errors:errors.splice(e0)};
  }

  /** 入围方案：（粗筛结果先补完，完整结果按已挑技能重建）→ 逐阶段挑战术卡 → 宽束重排 → 蒙特卡洛。 */
  function finalize(f0,fi){
    const beam=opts.beam||6;
    let f;
    if(f0.screenOnly)f=finish(screen(f0,screenCards,screenBeam),screenCards,screenBeam);
    else{
      const {party,members}=partyOf(f0.raws,f0.front);party._ri=f0.rule??ruleBase;
      const run=chain(party,screenCards,screenBeam);
      f={...f0,party,members,plans:run.plans,states:run.states,cards:screenCards.slice(),...judge(party,screenCards,run.plans,MCJ)};
    }
    const party=f.party;
    let cards=f.cards.slice(),cur=f;
    const variants=[f];
    const cardRank=[];
    const pickCards=isWave&&opts.optimizeCards!==false&&nPhases>1;
    // 宽束不一定更好（束搜索非单调）：宽束重排的结果只在更好时采用
    if(!pickCards){const full=safe(()=>judge(party,cards,chain(party,cards,beam).plans,MCJ),f.label);if(full){variants.push({...f,...full});if(better(full,f))cur={...f,...full};}}
    if(pickCards){
      const pool_=relevantCards(party);
      let base_=chain(party,cards,screenBeam);
      for(let p=1;p<nPhases;p++){
        if(!base_.states[p])break;
        const tried=[];
        for(const id of new Set([cards[p]||null,null,...pool_])){
          if(id&&cards.some((c,q)=>q!==p&&c===id))continue;
          const trial=cards.slice();trial[p]=id;
          const part=safe(()=>chain(party,trial,screenBeam,p,base_.states[p]),f.label);if(!part)continue;
          const plans=base_.plans.slice(0,p).concat(part.plans.slice(p));
          tried.push({id,j:judge(party,trial,plans,MCJ),run:part});
        }
        tried.sort((a,b)=>better(a.j,b.j)?-1:better(b.j,a.j)?1:0);
        if(tried.length){
          cards[p]=tried[0].id;
          base_={plans:base_.plans.slice(0,p).concat(tried[0].run.plans.slice(p)),states:base_.states.slice(0,p).concat(tried[0].run.states.slice(p))};
        }
        cardRank[p]=tried.slice(0,4).map(t=>({id:t.id,name:cardById(t.id)?.name||t.id,turns:t.j.turns,score:t.j.score,cleared:t.j.cleared,failed:t.j.failed,robust:t.j.robust,damage:Math.round(t.j.damage)}));
      }
      const picked=judge(party,cards,base_.plans,MCJ);
      const full=safe(()=>judge(party,cards,chain(party,cards,beam).plans,MCJ),f.label);
      variants.push({...f,...picked});if(full)variants.push({...f,...full});
      const improved=full&&better(full,picked)?full:picked;
      if(better(improved,f))cur={...f,...improved};
    }
    const mcRuns=opts.mcRuns||32;
    const seenDesign=new Set();
    const rated=variants.filter(v=>{
      const k=JSON.stringify(v.design);if(seenDesign.has(k)||!v.elementMatch||v.invalid)return false;seenDesign.add(k);return true;
    }).map(v=>({...v,mc:monteCarlo(v.sctx,{},v.design,{n:mcRuns,seed:7,scoreOf:isWave?res=>scoreOf(res,party):null})}));
    if(!rated.length)return null;
    rated.sort(compareFinal);
    cur=rated[0];cards=cur.design.phases.map(p=>p.card||null);
    // 保底：一张战术卡都拿不到时，重新排一份轴再模拟（不是把带卡的轴硬套）
    let mcNoCards=null;
    if(isWave&&cards.some(Boolean)){
      const none=cards.map(()=>null);
      const j=safe(()=>judge(party,none,chain(party,none,screenBeam).plans),f.label);
      if(j)mcNoCards={...monteCarlo(j.sctx,{},j.design,{n:Math.max(8,Math.round(mcRuns/2)),seed:70,scoreOf:res=>scoreOf(res,party)}),turns:j.turns,score:j.score};
    }
    // 装备说明（相对原卡面所在位置）
    const loadout=cur.raws.map((r,i)=>{
      const u=party[i],ids=new Set(cur.slots?.[i]?.ids||[]);
      const sk=u.skills.filter(s=>ids.has(s.id)&&!s.extra).map(s=>s.name);
      const extra=[...ids].filter(id=>stats?.extraSkills?.[String(id)]).map(id=>stats.extraSkills[String(id)].name||String(id));
      return {name:`${u.name}〈${u.styleName}〉`,role:u.role,front:!!cur.front[i],isNew:!!r._new,cap:cur.slots?.[i]?.cap??null,
        skills:[...sk,...extra],changes:r._changes||[],skillsChanged:!!r._new||JSON.stringify([...(r.skillIds||[])].sort())!==JSON.stringify([...(cur.slots?.[i]?.ids||[])].sort())};
    });
    const ro=RO(party);
    const publicResult=(v,index)=>({label:v.label+(index?' · 备选排轴':''),origin:v.origin,newTeam:!!v.island,rule:party._ri,ruleIds:ro.ids,ruleNames:ro.names,cleared:v.cleared,phases:nPhases,failed:v.failed,turns:v.turns,score:v.cleared===nPhases&&!v.failed?v.score:null,damage:Math.round(v.damage),robust:v.robust,
      teamElement:v.teamElement,elementDamage:v.elementDamage,elementShare:v.elementShare,
      mc:v.mc,mcNoCards,design:v.design,cards:v.design.phases.map(p=>p.card||null),cardRank,loadout,
      members:v.members.map(m=>({...m})),team:party.map(u=>`${u.name}〈${u.styleName}〉`)});
    const output=rated.map(publicResult);return {...output[0],alternatives:output.slice(1)};
  }

  function rateIncumbent(x){
    x=normalizeIncumbent(x);if(!x)return null;
    const ms=structuredClone(x.members),{members,ready}=membersFrom({members:ms},archive,catalog);
    if(!ready)return null;
    const party=buildParty(members,{skills,catalog,stats});party._ri=incumbentRule(x);
    const j=judgeDesign(party,structuredClone(x.design));
    if(j.invalid||!j.elementMatch)return null;
    const mc=monteCarlo(j.sctx,{},j.design,{n:opts.mcRuns||32,seed:7,scoreOf:isWave?res=>scoreOf(res,party):null});
    const ro=RO(party);
    return {label:x.label||'已有方案（重新评估）',origin:'incumbent',newTeam:false,rule:party._ri,ruleIds:ro.ids,ruleNames:ro.names,
      cleared:j.cleared,phases:nPhases,failed:j.failed,turns:j.turns,score:j.cleared===nPhases&&!j.failed?j.score:null,damage:Math.round(j.damage),robust:j.robust,
      teamElement:j.teamElement,elementDamage:j.elementDamage,elementShare:j.elementShare,mc,mcNoCards:null,design:j.design,cards:j.design.phases.map(p=>p.card||null),cardRank:[],
      loadout:party.map((u,i)=>({name:`${u.name}〈${u.styleName}〉`,front:!!ms[i].front,isNew:false,cap:skillSlotCap(ms[i].raw,u.role),skills:u.skills.filter(s=>!s.passive).map(s=>s.name||s.label),changes:[],skillsChanged:false})),
      members:ms,team:party.map(u=>`${u.name}〈${u.styleName}〉`)};
  }

  const mean=t=>Number.isFinite(t.mc.scoreMean)?t.mc.scoreMean:-Infinity;
  function compareFinal(a,b){return (goal==='stable'?(b.mc.success-a.mc.success)||(isWave?mean(b)-mean(a):a.turns-b.turns)
    :goal==='fast'?((a.mc.turnsMedian??99)-(b.mc.turnsMedian??99))||(b.mc.success-a.mc.success)||(mean(b)-mean(a))
    :isWave?(mean(b)-mean(a))||(b.mc.success-a.mc.success):(b.mc.success-a.mc.success)||(a.turns-b.turns))||tie(a,b);}

  // ================================================================ 协调者
  async function coordinate(runner){
  const lanes=Math.max(1,runner.size||1);
  const budget=searchBudget(opts);
  /** 同一批次使用同一筛选门槛，结果按提交顺序归并，完成先后不影响后续采样。 */
  const submitBatch=async list=>{
    const worst=elites.length>=ELITE?elites[ELITE-1].key:null;
    const settled=await Promise.all(list.map(c=>{
      const task={type:'eval',cand:{label:c.label,raws:c.raws,front:c.front,origin:c.origin,rule:c.rule,root:c.root,rootRaws:c.rootRaws,island:!!c.island,kind:c.kind},worst};
      return runner.run(task).catch(err=>({errors:[{label:c.label,error:String(err?.message||err)}]}));
    }));
    for(const m of settled){
      errors.push(...(m?.errors||[]));
      const r=m?.r;if(!r)continue;
      screened++;
      if(!r.screenOnly){promoted++;results.push(r);}
      pushIsland(r);
    }
    refreshElites();
  };
  // 种子也按固定批次归并；批大小独立于硬件并发数。
  {const list=cands.slice();
    for(let i=0;i<list.length;i+=budget.batch){const batch=list.slice(i,i+budget.batch);await submitBatch(batch);progress('evaluate',i+batch.length,list.length,batch.at(-1).label);}}

  // ---------------------------------------------------------------- 进化搜索（不按职能配队）
  // 变异：按实际贡献挑最闲的位置换人（主）、一次换两人、与另一支精英队交叉、换耳环；
  // 多次没有进步就注入一支随机新队。按完成的候选数结束，机器负载不改变搜索覆盖。
  const maxIter=broad?budget.evaluations:0;
  const labelOf=(root,rootRaws,raws,isl)=>{
    if(isl)return root.replace(/（.*）$/,''); // 全新队伍：起点只是随机种子，阵容看成员列表
    const before=new Set(rootRaws.map(r=>r.styleId)),after=new Set(raws.map(r=>r.styleId));
    const out=rootRaws.filter(r=>!after.has(r.styleId)).map(r=>name(r.styleId)),inn=raws.filter(r=>!before.has(r.styleId)).map(r=>name(r.styleId));
    const ear=raws.filter((r,i)=>r._earNote&&before.has(r.styleId)).map(r=>r._earNote);
    const parts=[];
    if(inn.length)parts.push(inn.length<=2?`${out.join('、')} → ${inn.join('、')}`:`换 ${inn.length} 人`);
    if(ear.length)parts.push(ear.length<=2?ear.join('、'):`换 ${ear.length} 个耳环`);
    return parts.length?`${root}（${parts.join('；')}）`:root;
  };
  const rankPick=list=>{const w=list.map((_,k)=>1/(k+1));let r=rng()*w.reduce((a,b)=>a+b,0);for(let k=0;k<list.length;k++){r-=w[k];if(r<=0)return list[k];}return list[0];};
  const islandShare=opts.islandShare??0.4;
  const pickParent=()=>island.length&&rng()<islandShare?rankPick(island):rankPick(elites);
  const replaceAt=(raws,i)=>{const pick=wpick(optionsFor(raws,i),weightOf);if(!pick)return false;raws[i]=placeCard(raws[i],pick.c);return true;};
  const lazyIndex=p=>{ // 贡献越低越可能被换
    const c=p.contrib||Array(6).fill(1);const w=c.map(x=>1/(0.4+x));
    let r=rng()*w.reduce((a,b)=>a+b,0);for(let i=0;i<w.length;i++){r-=w[i];if(r<=0)return i;}return 5;
  };
  function mutate(p){
    const raws=p.raws.map(x=>({...x,_skills:undefined}));
    const front=p.front.slice();
    const u=rng();let kind;
    if(u<0.5){kind='swap';if(!replaceAt(raws,lazyIndex(p)))return null;}
    else if(u<0.68){kind='swap2';const i=lazyIndex(p);let j=lazyIndex(p);if(j===i)j=(i+1+Math.floor(rng()*5))%6;if(!replaceAt(raws,i)||!replaceAt(raws,j))return null;}
    else if(ruleOpts.length>1&&opts.searchRules!==false&&u<0.78){kind='rule';
      let ri=Math.floor(rng()*(ruleOpts.length-1));if(ri>=(p.rule??ruleBase))ri++;
      const c=add(`${labelOf(p.root,p.rootRaws,raws,p.island)}`,raws,p.front,'evolve',ri);
      if(c){c.root=p.root;c.rootRaws=p.rootRaws;c.kind=kind;c.island=!!p.island;}
      return c;
    }
    else if(u<0.92&&elites.length>1){kind='cross';
      const q=elites.filter(x=>x!==p)[Math.floor(rng()*(elites.length-1))];
      // 父本保留贡献高的 3–4 人，其余位置依次从母本里取不冲突的成员
      const order=[...raws.keys()].sort((a,b)=>(p.contrib?.[a]||0)-(p.contrib?.[b]||0));
      const k=2+Math.floor(rng()*2);
      for(const i of order.slice(0,k)){
        const cand=q.raws.filter(m=>!raws.some((r,j)=>j!==i&&r.characterId===m.characterId)&&!(isAdm(m.styleId)&&raws.some((r,j)=>j!==i&&isAdm(r.styleId))));
        if(cand.length)raws[i]={...cand[Math.floor(rng()*cand.length)],_skills:undefined};
      }
    }else if(u<0.96){kind='ear';
      const i=Math.floor(rng()*6),types=Object.keys(inv.ear).filter(t=>inv.ear[t].inst.masterId!==raws[i].accessories?.earring?.masterId);
      if(!types.length)return null;const t=types[Math.floor(rng()*types.length)];
      raws[i]={...raws[i],accessories:{...raws[i].accessories,earring:inv.ear[t].inst},_earNote:`${name(raws[i].styleId)} 换${EAR_LABEL[t]}`};
      if(raws[i]._new)raws[i]._changes=[...(raws[i]._changes||[]).filter(x=>!/耳環/.test(x)),`${EAR_LABEL[t]} ${inv.ear[t].v}%`];
    }else{kind='front';
      const a=front.map((v,i)=>v?i:null).filter(x=>x!==null),b=front.map((v,i)=>!v?i:null).filter(x=>x!==null);
      if(!a.length||!b.length)return null;
      front[a[Math.floor(rng()*a.length)]]=false;front[b[Math.floor(rng()*b.length)]]=true;
    }
    const c=add(labelOf(p.root,p.rootRaws,raws,p.island),raws,front,'evolve',p.rule??ruleBase);
    if(c){c.root=p.root;c.rootRaws=p.rootRaws;c.kind=kind;c.island=!!p.island;}
    return c;
  }
  let iter=0,stale=0,miss=0;
  const restartAfter=opts.restartAfter||10;
  // 先冻结父本池生成整批，再并行计算、依次归并；随机数消耗顺序不依赖回包顺序。
  while(elites.length&&iter<maxIter&&miss<200){
    const top=elites[0],batch=[];
    while(batch.length<Math.min(budget.batch,maxIter-iter)&&miss<200){
      const c=stale>=restartAfter?(stale=0,addRandom(teamElement||goodEls[Math.floor(rng()*Math.max(1,goodEls.length))]||null)):mutate(pickParent());
      if(!c){miss++;continue;}
      miss=0;batch.push(c);
    }
    if(!batch.length)break;
    await submitBatch(batch);iter+=batch.length;
    if(better(elites[0],top))stale=0;else stale+=batch.length;
    progress('evolve',iter,maxIter,batch.at(-1).label);
  }
  sortRes(results);

  // ---------------------------------------------------------------- 入围：挑战术卡 + 宽搜索重排 + 蒙特卡洛
  // 入围按评价排序，保留同队不同规则/配装/开场前卫；不以阵容相似为由删掉次高分。
  const finalistLimit=Math.max(topLimit,Math.min(48,opts.finalists||12));
  const finalists=[];const seenFinalist=new Set();
  for(const r of results){if(teamElement&&!r.elementMatch)continue;
    const k=JSON.stringify([candidateIdentity(r.raws,r.front,r.rule),r.raws.map(x=>x._skills)]);
    if(seenFinalist.has(k))continue;seenFinalist.add(k);finalists.push(r);if(finalists.length>=finalistLimit)break;}
  // 全新队伍只补空缺，不能挤掉已搜索到的更高分。
  if(broad&&island.length&&finalists.length<finalistLimit&&!finalists.some(f=>f.island)&&island[0].cleared===nPhases&&!island[0].failed&&island[0].elementMatch){
    finalists.push(island[0]);
  }
  let fdone=0;
  const tasks=[...finalists.map((f,fi)=>({type:'final',f,fi})),...incumbentInputs.map(incumbent=>({type:'incumbent',incumbent}))];
  progress('final',0,tasks.length,finalists.map(f=>f.label).join(' / '));
  const messages=await Promise.all(tasks.map(task=>runner.run(task).then(m=>{
    progress('final',++fdone,tasks.length,(task.f||task.incumbent).label);return m;
  },err=>({errors:[{label:(task.f||task.incumbent).label,error:String(err?.message||err)}]}))));
  const outs=messages.map(m=>{errors.push(...(m?.errors||[]));return m?.r||null;});
  const seenOutput=new Set();
  const out=outs.filter(Boolean).flatMap(r=>{const {alternatives=[],...best}=r;return [best,...alternatives];}).filter(r=>{
    const k=JSON.stringify([r.members.map(m=>[rawIdentity(m.raw),m.deckSkillIds,m.front]),r.rule,r.design]);
    if(seenOutput.has(k))return false;seenOutput.add(k);return true;
  });

  // 最终排名：最高分 = 成功样本条件均分；失败率独立保留；零成功样本没有均分。
  out.sort(compareFinal);
  // 按轴完成率 / 含续打通关率可单独划线；先筛全部重评结果再取前 N，低于线的高分不占名额。
  const qualified=out.filter(r=>Number.isFinite(r.mc?.[minSuccessBasis])&&r.mc[minSuccessBasis]>=minSuccess);
  return {elapsed:Date.now()-t0,evaluated:results.length,screened,promoted,iterations:iter,searchBudget:{evaluations:maxIter,batch:budget.batch,seed:opts.seed??97},incumbents:incumbentInputs.length,
    minSuccess,minSuccessBasis,rejectedBySuccess:out.length-qualified.length,qualifiedCandidates:qualified.length,resultCandidates:out.length,
    candidates:{seeds:cands.filter(c=>['base','deck','swap'].includes(c.origin)).length,random:cands.filter(c=>c.origin==='random').length,
      evolve:cands.filter(c=>c.origin==='evolve').length,pool:pool.length},
    topCards:pool.filter(x=>x.elite>0).sort((a,b)=>b.elite-a.elite).slice(0,12).map(x=>({name:name(x.c.styleId),role:x.s.role,elite:Math.round(x.elite*100)/100})),
    goodElements:goodEls,teamElement,requested:topLimit,overkill,cardProb:{top1:cardSeenProb(1),top3:cardSeenProb(3)},errors,threads:lanes,goal,rules:ruleOpts.map(o=>o.names.join('、')||'无'),top:qualified.slice(0,topLimit)};
  }
  return {coordinate,handle};
}
