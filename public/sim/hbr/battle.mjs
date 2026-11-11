// 回合模拟 v2：回合规则按社区计算器 Planner 模块（SP、OD、持续时间、追加回合、被动时机），
// 伤害按 Calculator 模块（damage.mjs），效果量按 effects.mjs。所有数据来自公开主数据（skills.json）。
// 模拟是确定性的；暴击按 critMode 取期望/不暴击/全暴击，浮动取 1.0（min/max 的中点）。
import * as R from './rules.mjs';
import {computeAttack,earringBonus,capAttack} from './damage.mjs';
import {buffSize,debuffSize,isStrengthenableDebuff,isDefenseDebuff,isAttackBuff} from './effects.mjs';
import {attackModel,effectModel,elementOf,ATTACK_PART_TYPES} from './model.mjs';
import {evaluate,UnsupportedCondition} from '../expr.mjs';
import {resolveEnemyParameters} from '../../boss-model.mjs';

export const NORMAL=-1;
const ELEM_TITLE={fire:'Fire',ice:'Ice',thunder:'Thunder',light:'Light',dark:'Dark'};
const RES_KEY={fire:'fire',ice:'ice',thunder:'thunder',light:'light',dark:'dark',nonelemental:'nonelement',slash:'slash',stab:'stab',strike:'strike'};

// ---------------------------------------------------------------- 构建

/**
 * members[i] = {styleId, stats{str..luk}, front, limitBreak, skillLevels{label:lv}, extraStyleIds[], initialSp, tearLevel,
 *               equipment:{earring:{type,bonus}|null, odEarringBonus, necklaceAttack, ringElement, ringLevel}}
 */
/** 宝玉（宝珠）技能 ID：4630xxxx 主动、4645xxxx 饰品被动。 */
export const isOrbSkillId=id=>/^46(30|45)\d{4}$/.test(String(id));
const ROOT_LABEL=s=>s.rootLabel||s.label;
// Tested attacks that deal damage without raising an enemy's talisman level.
const TALISMAN_EXCEPTIONS=new Set(['NiOhshimaSkill02','MYanagiSkill02','HOgasawaraSkill07','MNikaidoSkill06','MNikaidoSkill01','TTojoSkill51Ev1','LShanhuaSkill53']);
const MODE_ELEMENT={Fire:'火',Ice:'冰',Thunder:'雷',Light:'光',Dark:'暗'};
// A/B are player choices. They occupy one equipped skill ID and share one use limit.
function battleSkillModes(skill){
  const part=skill.parts?.find(p=>p.skillType==='SkillSwitch'&&p.switchModes);
  if(!part)return [skill];
  const modes=Object.entries(part.switchModes).map(([side,indices])=>{
    const branches=indices.map(i=>part.branches[i]);
    const elements=new Set(branches.flatMap(b=>b.parts.flatMap(q=>q.elements||[])));
    const name=[...elements].map(e=>MODE_ELEMENT[e]||e).join('/');
    const selected={...part,branches,branchConditions:indices.map(i=>part.branchConditions?.[i]||null),modeSelected:true};
    return {side,branches,name,parts:skill.parts.map(p=>p===part?selected:p)};
  });
  return modes.map(m=>{
    const title=modes.every(other=>other===m||other.name!==m.name)?m.name:`${m.name} · ${m.branches[0].hitCount}连击`;
    return {...skill,parts:m.parts,hitCount:m.branches[0].hitCount,hits:m.branches[0].hits||skill.hits,rootLabel:skill.label,rootName:skill.name,
      label:m.side==='a'?skill.label:skill.label+'@'+m.side,name:`${skill.name}（${title}）`};
  });
}
export function buildParty(members,data){
  const styleById=new Map(data.catalog.styles.map(s=>[s.id,s]));
  const charById=new Map(data.catalog.characters.map(c=>[c.id,c]));
  return members.map((m,i)=>{
    const style=styleById.get(m.styleId);
    if(!style)throw Error(`第 ${i+1} 位：找不到卡面 ${m.styleId}`);
    const char=charById.get(style.characterId);
    const own=data.skills.styles[m.styleId]||{skills:[],passives:[]};
    const pool=[...own.skills.map(s=>({...s,ownStyle:true}))],seen=new Set(pool.map(s=>s.label));
    for(const sid of m.extraStyleIds||char?.styleIds||[]){
      if(sid===m.styleId)continue;
      for(const s of data.skills.styles[sid]?.skills||[])if(!s.restricted&&!seen.has(s.label)){seen.add(s.label);pool.push(s);}
    }
    const lb=Number(m.limitBreak)||0;
    // 编队里实际装备的技能（缓存 _masterSkillIds）：有就只用这些；对不上时退回全部可用技能
    let usable=pool;
    const exploring=!!m.exploreSkillIds?.length;
    const equipped=new Set(exploring?m.exploreSkillIds:m.deckSkillIds||[]);
    if(equipped.size||m.strictDeckSkills){
      // 编队技能表是游戏里实际装备的（含通用化的其他卡面 EX 技能），以它为准
      const all=new Map();
      for(const sid of [m.styleId,...(char?.styleIds||[])])for(const s of data.skills.styles[sid]?.skills||[])if(equipped.has(s.id)&&!all.has(s.id))all.set(s.id,{...s,ownStyle:sid===m.styleId});
      // 宝珠技能、大师技能等非卡面技能（stats.json extraSkills）
      for(const id of equipped){const x=data.stats?.extraSkills?.[String(id)];if(x&&!all.has(id))all.set(id,{...x,extra:true});}
      if(exploring)usable=[...pool,...Array.from(all.values()).filter(s=>!seen.has(s.label))];
      else if(all.size||m.strictDeckSkills)usable=[...all.values()];
    }
    // m.allOrbSkills：宝玉（宝珠）技能可随时换装，视为全部可用（4630xxxx 主动、4645xxxx 饰品被动；大师技能 465xxxxx 与角色绑定，不在此列）
    if(m.allOrbSkills&&data.stats?.extraSkills){
      const have=new Set(usable.map(s=>s.id));
      const orbs=Object.entries(data.stats.extraSkills).filter(([id])=>isOrbSkillId(id)&&!have.has(Number(id))).map(([id,x])=>({...x,id:Number(id),extra:true,orb:true}));
      if(orbs.length)usable=[...usable,...orbs];
    }
    // ADMIRAL：不能普攻，改为“指揮行動”（RKayamoriCommandBuff 等，0 SP）。编队技能表里没有它，按卡面补上
    const command=own.skills.find(s=>/CommandBuff$/.test(s.label||''));
    if(command&&!usable.some(s=>s.label===command.label))usable=[...usable,{...command,ownStyle:true}];
    // 「無念無想」：行动选择时可选【沉浸】（雷/光/暗三选一），作为 0 SP 的特殊行动
    if(own.immersion)usable=[...usable,...['thunder','light','dark'].map(el=>({id:-1,label:'Immersion:'+el,name:'沉浸（'+{thunder:'雷',light:'光',dark:'暗'}[el]+'）',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[],special:'immersion',element:el}))];
    return {
      i,styleId:m.styleId,charId:style.characterId,name:char?.name||style.characterId,styleName:style.name,
      team:style.team,role:style.role,elements:(style.elements||[]).map(x=>String(x).toLowerCase()),attackType:style.attackType,
      tearType:own.tearType||null,tearLevel:Number(m.tearLevel)||0,transcend:own.transcend||null,weapon:own.weapon||null,followUpHits:own.followUpHits||0,
      stats:Object.fromEntries(R.STATS.map(k=>[k,Number(m.stats?.[k])||R.DEFAULT_STATS[k]])),
      skills:usable.flatMap(s=>battleSkillModes({...s,level:Math.max(1,m.skillLevels?.[s.label]??s.maxLevel??1)})),deckFiltered:usable!==pool,
      passives:[...(own.passives||[]).filter(p=>p.step==null||p.step<=lb),
        ...(m.equipment?.enemyTurnDefense?[m.equipment.enemyTurnDefense]:[]),
        // 编队装备的潜在能力（普通潜在为被动技能；固有潜在只加面板，已在面板推算里）
        ...(m.latentIds||[]).flatMap(id=>data.stats?.latents?.[String(id)]?.passives||[]),
        // 大师技能里的被动（编队技能表含其 ID 时）；保留来源技能，供 OverwriteSp 定点覆写
        ...usable.filter(s=>s.extra&&s.passive).map(s=>({...s.passive,skillLabel:s.label})),
        // 编队技能表里的被动技能（含通用化的其他卡面被动，如東城「日蔭下的午休」开场前卫 OD+10%）
        ...usable.filter(s=>!s.extra&&s.passive&&(equipped.has(s.id)||s.ownStyle)).map(s=>({...s.passive,label:s.passive.label||s.label,name:s.passive.name||s.name,
          parts:s.passive.parts?.length?s.passive.parts:s.parts,source:'deckPassive',skillLabel:s.label}))
          .filter(p=>!(own.passives||[]).some(q=>q.label===p.label||q.name===p.name)),
        // 支援卡的共鸣特性（按支援卡突破数取档）
        ...supportPassives(m,data)].filter((p,_,all)=>!superseded(p,all)),
      front:!!m.front,initialSp:Number(m.initialSp)||0,noNormal:!!command,immersion:!!own.immersion,
      damageLimiter:(m.deckSkillIds||[]).some(id=>data.stats?.extraSkills?.[id]?.parts?.some(p=>p.skillType==='ForceOneDamageByHit')),
      // 我方 DP/HP（面板推算或手填；0 = 未知，此成员不承受伤害）
      dpMax:Number(m.vitals?.dp)||0,hpMax:Number(m.vitals?.hp)||0,
      equipment:{earring:m.equipment?.earring||null,odEarringBonus:m.equipment?.odEarringBonus||0,necklaceAttack:!!m.equipment?.necklaceAttack,
        ringElement:m.equipment?.ringElement||null,ringLevel:m.equipment?.ringLevel??null,skillCountUp:m.equipment?.skillCountUp||{},
        normalAttackUp:Number(m.equipment?.normalAttackUp)||0,normalElement:m.equipment?.normalElement||null},
    };
  });
}
/** 「X[特性強化]」取代同名的「X（小）」/「X」（2026-11-09 成瀨「勢如破竹」两档同时出现）。 */
function superseded(p,all){
  const base=n=>String(n||'').replace(/[（(][小中大][）)]$/,'').replace(/\[特性強化\]$/,'').trim();
  return !/\[特性強化\]$/.test(p.name||'')&&all.some(q=>q!==p&&/\[特性強化\]$/.test(q.name||'')&&base(q.name)===base(p.name));
}
/** 支援卡共鸣特性：stats.styles[支援卡].resonance → stats.supportSkills[组] 中 lb ≤ 支援卡突破数 的最高档。 */
function supportPassives(m,data){
  const sid=m.supportStyleId;if(!sid)return [];
  const group=data.stats?.styles?.[sid]?.resonance,list=data.stats?.supportSkills?.[group];
  if(!list?.length)return [];
  const lb=Number(m.supportLimitBreak)||0;
  const hit=list.filter(e=>e.lb<=lb).sort((a,b)=>b.lb-a.lb)[0];
  return hit?[{...hit.passive,source:'support:'+sid}]:[];
}

/** 敌人：弱点% = 100 − 主数据抗性值；DP 为一条槽（额外量表另记 flag）。 */
export function buildEnemy(event,stage,{enemyLabel,rules=[],parameterOverride={}}={}){
  const list=(stage.enemies||[]).filter(e=>e?.label);
  const pick=list.find(e=>e.label===enemyLabel)||list.find(e=>event.enemies?.[e.label]?.flags?.is_boss)||list[0];
  if(!pick)throw Error('这一档没有敌人数据');
  const params=resolveEnemyParameters(event,stage,pick,{override:parameterOverride});
  if(params.dp===null||params.hp===null||params.border===null)throw Error('敌人 DP、HP 或状态值缺失，请先核对参数');
  const d=event.enemies?.[pick.label]||{};
  const el=d.resist?.element||{};
  const pct=k=>100-(Number(el[RES_KEY[k]])||0);
  const [dRate,maxDr]=pick.destruction||[d.base?.d_rate||0,d.base?.max_d_rate||999];
  return {
    label:pick.label,name:pick.name||d.name||pick.label,
    border:params.border,atkRate:d.base?.atk_rate??100,parameterSource:params.parameterSource,breakDownSetting:d.base?.break_down_turn,
    // 敌方 OD 率：主数据 od_rate 万分比（遭遇战 #8 为 5000 = 50%）；0 视为 100%
    odRate:(d.base?.od_rate||10000)/10000,hp:params.hp,dp:params.dp>0?[params.dp]:[],maxHp:params.hp,maxDp:params.dp,
    destruction:dRate||0,destructionLimit:maxDr||999,initialDestruction:Math.max(100,d.base?.ini_d_rate||0)/100,
    weaknesses:{physical:{slash:pct('slash'),stab:pct('stab'),strike:pct('strike')},element:{fire:pct('fire'),ice:pct('ice'),thunder:pct('thunder'),light:pct('light'),dark:pct('dark'),nonelemental:pct('nonelemental')}},
    pattern:d.pattern||{},skills:d.skills||[],others:list.length-1,extraGauge:(stage.extraGauge||[]).length>0,rules,
  };
}

// ---------------------------------------------------------------- 状态

let effSeq=0;
export function initialState(party,enemy,opt={}){
  const st={
    turn:0,round:'start',odLevel:0,odRounds:0,odWindow:null,od:0,
    units:party.map(u=>({i:u.i,sp:R.SP_INITIAL+u.initialSp,ep:0,uses:{},playedSkills:{},effects:[],morale:0,tokens:0,extra:0,front:u.front,played:0,reinforced:null,immPending:null,dp:u.dpMax||0,hp:u.hpMax||0,dpBroken:false,down:false})),
    enemy:freshEnemyState(enemy),
    field:null,territory:null,turnDamage:[0],totalDamage:0,log:opt.trace?[]:null,
    skillDamageByElement:opt.trackElements||opt.teamElement?{}:null,
    acted:0,killedTurn:0,passiveCount:{},shownDamage:0,phaseShownStart:0,phaseDamageStart:0, // shownDamage：画面显示的伤害（含溢出），遭遇战伤害分用
    mods:{drGain:0,odGain:0,minOd:1,attackUpRule:0,spDamageFront:null},
    flags:opt.flags||{unsupported:{},approx:{}},
  };
  st.ctx={party,enemy,opt,statusTypes:opt.statusTypes||{}};
  st.trans=initialTranscend(party,opt);
  for(const r of enemy.rules||[])if(r.type==='LimitMinOverDriveLv')st.mods.minOd=Number(r.arg)||1;
  applyRules(st,'OnBattleStart');
  st.odGainMult=1+(st.mods.odGain||0);
  firePassives(st,'battleStart');
  return st;
}

export function cloneState(s){
  return {
    ...s,
    skillDamageByElement:s.skillDamageByElement?{...s.skillDamageByElement}:null,
    units:s.units.map(u=>({...u,uses:{...u.uses},playedSkills:{...u.playedSkills},effects:u.effects.map(e=>({...e}))})),
    enemy:{...s.enemy,dp:s.enemy.dp.slice(),effects:s.enemy.effects.map(e=>({...e})),ptr:{...s.enemy.ptr},once:{...s.enemy.once}},
    field:s.field?{...s.field}:null,territory:s.territory?{...s.territory}:null,trans:s.trans?{...s.trans}:null,turnDamage:s.turnDamage.slice(),log:s.log?s.log.slice():null,
    passiveCount:{...s.passiveCount},mods:{...s.mods},flags:s.flags,ctx:s.ctx,cards:s.cards?new Set(s.cards):undefined,
    ...cloneQueue(s),
  };
}
function cloneQueue(s){
  if(!s.queue)return {};
  const queue=s.queue.map(q=>({...q,state:q.state===s.enemy?null:cloneEnemyState(q.state)}));
  const enemy=cloneEnemyState(s.enemy);queue[s.qi].state=enemy;
  return {queue,enemy};
}
function cloneEnemyState(e){return {...e,dp:e.dp.slice(),effects:e.effects.map(x=>({...x})),ptr:{...e.ptr},once:{...e.once}};}

function flag(st,kind,key){const b=st.flags[kind];b[key]=(b[key]||0)+1;}

// ---------------------------------------------------------------- 超越ゲージ / 属性の印 / OD 取整

const round2=x=>Math.round(x*100)/100;
// 截到 0.01%（社区 Planner Cs/xs 的 floor(x×100)/100；加 1e-7 防浮点把 3.00 截成 2.99）
const floorOd=x=>Math.floor(x*100+1e-7)/100;
// 直充 OD（技能/被动的 OverDrivePointUp）：比例×系数×10000 后四舍六入五成双（OD与破坏率计算表 261011 的 ODPOINTBYRATE）
const roundEven=x=>{const n=Math.floor(x),f=x-n;return f<0.5-1e-9?n:f>0.5+1e-9?n+1:(n%2===0?n:n+1);};
const directOd=x=>roundEven(x*100)/100;
/** OD 量表增减：结果保留 0.01%（社区 Planner 每次增量都截到 0.01），上限 300。 */
function addOd(st,v){st.od=Math.max(0,Math.min(R.OD_MAX,round2(st.od+v)));}
// 虚属性（Void，成瀨光〈泰然自若的獵人〉）视同拥有火冰雷光暗 5 种属性（用户 2026-11-09 确认）
const ELEMENTS5=['fire','ice','thunder','light','dark'];
export const hasElement=(m,el)=>m.elements.includes(el)||(ELEMENTS5.includes(el)&&m.elements.includes('void'));
const elementCount=(party,el)=>party.filter(p=>hasElement(p,el)).length;

/** 有 ADMIRAL「X の律動」时建超越量表：初期 = 该属性人数 ×15%（≤90%）。opt.transcendInitial 可覆盖。 */
function initialTranscend(party,opt){
  const holder=party.find(p=>p.transcend);
  if(!holder)return null;
  const el=holder.transcend;
  const g=opt.transcendInitial??Math.min(R.TRANSCEND_INITIAL_MAX,elementCount(party,el)*R.TRANSCEND_PER_MEMBER);
  return {element:el,gauge:g,active:g>=100,holder:holder.i,activatedTurn:g>=100?0:null};
}
/** 该属性卡面行动一次：+4%；到 100% 发动（OD +100%，仅一次），之后整场生效。 */
function chargeTranscend(st,i){
  const T=st.trans;
  if(!T||T.active||!hasElement(st.ctx.party[i],T.element))return;
  T.gauge=Math.min(100,T.gauge+R.TRANSCEND_PER_ACTION);
  if(T.gauge>=100){
    T.active=true;T.activatedTurn=st.turn;addOd(st,R.TRANSCEND_EFFECT.od);
    // 到 100% 的那次行动本身不吃超越效果，下一次行动起生效（用户经验 2026-11-09）
    if(st.log)st.log.push({t:'transcend',turn:st.turn,element:T.element});
  }
}
/** 成员 i 是否受超越效果（量表已发动且是该属性卡面）。 */
const transcendFor=(st,i)=>!!(st.trans?.active&&hasElement(st.ctx.party[i],st.trans.element));
/** 成员 i 身上属性の印的等级（印只给该属性卡面；等级 = 部队里该属性人数）。返回 {element,level}|null */
function markOf(st,i){
  const mk=st.units[i].effects.find(e=>e.type==='mark');
  return mk?{element:mk.element,level:mk.level}:null;
}

// ---------------------------------------------------------------- 条件

const STATUS_BY_TYPE={AdditionalTurn:'extra',BuffCharge:'charge',Funnel:'consecutiveHit',Zone:'field',MindEye:'mindsEye',AttackUp:'attackUp',
  Provoke:'provoke',Cover:'cover',Misfortune:'misfortune',SuperBreakDown:'superDown',EAGuard:'eaGuard',Dodge:'dodge',Invincible:'invincible',
  DefenseDown:'defenseDown',Fragile:'fragile',ShadowClone:'shadowClone',EternalOath:'eternalOath',BIYamawakiServant:'yamawakiMinion',YamawakiMinion:'yamawakiMinion',CriticalRateUp:'critRateUp',CriticalDamageUp:'critDamageUp',ResistDown:'resistanceDown'};

// 以“状态”形式记录、供条件判断的部件类型（数值效果另行处理或未建模）
const STATUS_PARTS=new Set(['Diva','FightingSpirit','Makeup','NegativeMind','Mocktail','DimSum','Curry','Gelato','Shchi','Sprightly','Disaster','Inscription','Infantilized','Venom','Steak','Tea','Shredding','Talisman','BIYamawakiServant','ShadowClone','EternalOath','Undermine','FearOfDevil','RiceFieldZone']);
const KNOWN_STATUS=new Set([...STATUS_PARTS,'Motivation','Revenge','IceMark','FireMark','ThunderMark','LightMark','DarkMark']);
// Direct condition IDs from the public skill table, also used by standalone battle callers.
const CONDITION_STATUS_IDS={3:'DefenseDown',12:'Provoke',20:'AdditionalTurn',22:'Fragile',25:'BuffCharge',57:'Cover',58:'Misfortune',78:'MindEye',79:'Restraint',122:'Dodge',124:'EternalOath',125:'ShadowClone',144:'Diva',146:'NegativeMind',155:'BIYamawakiServant',164:'Makeup',172:'SuperBreakDown',211:'EAGuard',223:'Inscription'};
const enemyStatus=(st,name)=>st.enemy.effects.find(e=>e.status===name);
// 条件函数表只建一次（原先每次条件判断都新建约 50 个闭包，占搜索 ~14% 时间）；当前状态经 CF_st / CF_extra 传入，check() 负责设置与恢复
let CF_st=null,CF_extra={};
const CF_WRAP=(()=>{
  const U=e=>e.side==='enemy'?null:CF_st.units[e.i],M=e=>e.side==='enemy'?null:CF_st.ctx.party[e.i];
  const enemy=e=>e.enemy||CF_st.enemy;
  const level=(e,name)=>U(e)?.effects.find(x=>x.status===name)?.level||0;
  const statusCount=(e,type)=>{
    const name=String(CF_st.ctx.statusTypes?.[type]||CONDITION_STATUS_IDS[type]||type);
    if(name==='AdditionalTurn')return U(e)?.extra||0;
    if(name==='Zone')return CF_st.field?1:0;
    const t=STATUS_BY_TYPE[name];
    if(!t&&!KNOWN_STATUS.has(name))throw new UnsupportedCondition('状态:'+name,String(type));
    return (U(e)||enemy(e)).effects.filter(x=>x.status===name||(t&&x.type===t)).length;
  };
  const f={
    IsFront:e=>e.side!=='enemy'&&U(e).front,IsPlayer:e=>e.side!=='enemy',IsDead:e=>e.side==='enemy'?enemy(e).hp<=0:U(e).down,
    IsCharacter:(e,A)=>e.side!=='enemy'&&M(e).charId===A.val(0),IsTeam:(e,A)=>e.side!=='enemy'&&M(e).team===String(A.val(0)),
    IsRole:(e,A)=>e.side!=='enemy'&&String(M(e).role).toLowerCase()===String(A.val(0)).toLowerCase(),
    IsNatureElement:(e,A)=>e.side!=='enemy'&&hasElement(M(e),String(A.val(0)).toLowerCase()),
    IsWeakElement:(e,A)=>((e.model||CF_st.ctx.enemy).weaknesses.element[String(A.val(0)).toLowerCase()]??100)>100,
    IsTargetWeakNatureElement:(e,A)=>(CF_st.ctx.enemy.weaknesses.element[String(A.val(0)).toLowerCase()]??100)>100,
    DpRate:e=>e.side==='ally'&&M(e).dpMax>0?U(e).dp/M(e).dpMax:1,
    Sp:e=>e.side==='enemy'?0:U(e).sp,Ep:e=>e.side==='enemy'?0:U(e).ep,Token:e=>e.side==='enemy'?0:U(e).tokens,
    MoraleLevel:e=>e.side==='enemy'?0:U(e).morale,
    MotivationLevel:e=>{const m=U(e)?.effects.find(x=>x.status==='Motivation');if(m&&m.level==null)throw new UnsupportedCondition('幹勁开场随机等级','MotivationLevel');return m?.level||0;},
    RevengeLevel:e=>level(e,'Revenge'),TalismanLevel:e=>enemy(e).effects.find(x=>x.status==='Talisman')?.level||0,
    SpecialStatusCountByType:(e,A)=>statusCount(e,A.val(0)),
    CountBC:(e,A)=>{
      let n=0;for(const u of CF_st.units)if(A.ev(A.raw[0],{side:'ally',i:u.i}))n++;
      if(CF_st.queue){for(const q of CF_st.queue)if(A.ev(A.raw[0],{side:'enemy',enemy:q.state,model:q.enemy}))n++;}
      else if(A.ev(A.raw[0],{side:'enemy',enemy:CF_st.enemy,model:CF_st.ctx.enemy}))n++;
      return n;
    },
    IsOverDrive:()=>CF_st.odRounds>0,OverDriveGauge:()=>CF_st.od,IsBroken:e=>e.side==='enemy'?enemy(e).broken:U(e).dpBroken,
    BreakDownTurn:e=>e.side==='enemy'?enemy(e).breakDownTurns||0:0,TargetBreakDownTurn:()=>CF_st.enemy.breakDownTurns||0,
    IsZone:(e,A)=>{const z=String(A.val(0)).toLowerCase();return z==='none'?!CF_st.field:CF_st.field?.element===z;},
    IsTerritory:(e,A)=>CF_st.territory?.name===String(A.val(0)),IsCharging:e=>e.side!=='enemy'&&U(e).effects.some(x=>x.type==='charge'),Turn:()=>CF_st.turn,
    DamageRate:e=>enemy(e).dr*100,IsHitWeak:()=>!!CF_extra.weak,BreakHitCount:()=>CF_extra.breakHits||0,IsAttackNormal:()=>!!CF_extra.normal,
    ConsumeSp:()=>CF_extra.sp??0,RemoveDebuffCount:()=>CF_extra.removeDebuffCount||0,
    AdditionalHitCount:(e,A)=>e.side==='enemy'?0:(CF_st.passiveCount[String(A.val(0))+':'+e.i]||0),
    ConquestBikeLevel:()=>Number(CF_st.ctx.opt.conquestBikeLevel)||0,InfantilizedLevel:()=>enemyStatus(CF_st,'Infantilized')?.level||0,
    HasSkill:(e,A)=>e.side!=='enemy'&&M(e).skills.some(s=>s.label===String(A.val(0))),
    // 成瀨可选择雷、光、暗沉浸；进入后才切换技能分支。
    IsReinforcedMode:e=>e.side!=='enemy'&&!!U(e).reinforced,
    IceMarkLevel:e=>markLevel(CF_st,e,'IceMark'),FireMarkLevel:e=>markLevel(CF_st,e,'FireMark'),ThunderMarkLevel:e=>markLevel(CF_st,e,'ThunderMark'),
    LightMarkLevel:e=>markLevel(CF_st,e,'LightMark'),DarkMarkLevel:e=>markLevel(CF_st,e,'DarkMark'),
    PlayedSkillCount:(e,A)=>e.side==='enemy'?0:(U(e).playedSkills?.[String(A.val(0))]||0),
    IsAdditionalTurn:()=>CF_st.round==='extra',Random:()=>{
      if(!CF_extra.sampleRandom)return 0.5;
      if(CF_st.ctx.opt.rng)return CF_st.ctx.opt.rng();
      flag(CF_st,'approx','随机条件在确定性回放中取中位数');return 0.5;
    },
  };
  const wrap={};
  for(const [k,fn] of Object.entries(f))wrap[k]=(env,args,ev)=>fn(env,{raw:args,ev,val:i=>{const n=args[i];return !n?undefined:n.k==='id'?n.v:ev(n,env);}});
  return wrap;
})();
function markLevel(st,e,type){const u=e.side==='enemy'?null:st.units[e.i];const m=u?.effects.find(x=>x.status===type);return m?m.level||0:0;}
function check(st,expr,i,extra,env){
  if(!expr||expr==='Equipped')return true;
  const ps=CF_st,pe=CF_extra;CF_st=st;CF_extra=extra||{};
  try{return evaluate(expr,env||{side:'ally',i},CF_WRAP);}
  catch(err){flag(st,'unsupported',err instanceof UnsupportedCondition?'条件:'+err.fn:'条件语法');return false;}
  finally{CF_st=ps;CF_extra=pe;}
}

// ---------------------------------------------------------------- 目标

function targetsOf(st,actor,part,chosen){
  const t=part.targetType||'Self',front=st.units.filter(u=>u.front).map(u=>u.i);
  switch(t){
    case 'Self':case 'None':return [actor];
    case 'AllyAll':return st.units.map(u=>u.i);
    case 'AllyAllWithoutSelf':return st.units.map(u=>u.i).filter(i=>i!==actor);
    case 'AllyFront':return front;
    case 'AllyFrontWithoutSelf':return front.filter(i=>i!==actor);
    case 'AllySub':return st.units.filter(u=>!u.front).map(u=>u.i);
    case 'AllySingle':case 'AllySingleWithoutSelf':{
      if(chosen!=null&&(t==='AllySingle'||chosen!==actor))return [chosen];
      const pool=front.filter(i=>t==='AllySingle'||i!==actor);
      return pool.length?[pool.sort((a,b)=>attackPotential(st,b)-attackPotential(st,a))[0]]:[];
    }
    case 'Field':return ['field'];
    default:return ['enemy'];
  }
}
function attackPotential(st,i){
  return Math.max(0,...st.ctx.party[i].skills.map(s=>(s.parts||[]).filter(p=>ATTACK_PART_TYPES.has(p.skillType)).reduce((m,p)=>Math.max(m,(p.power?.[1]||0)),0)));
}

// ---------------------------------------------------------------- 效果实例

// 持续：Count = 次数；PlayerTurnEnd/EnemyTurnEnd = 回合数；Eternal = 永久；其它 = 仅本行动轮（同 Planner Un/na）
function duration(part){
  const e=part.exit||{cond:'None',value:[0,0]};
  if(e.cond==='Eternal')return {uses:null,turns:null,currentOnly:false};
  const n=Math.max(1,Math.ceil(Number(e.value?.[0])||1));
  if(e.cond==='Count')return {uses:n,turns:null,currentOnly:false};
  if(e.cond==='PlayerTurnEnd'||e.cond==='EnemyTurnEnd')return {uses:null,turns:n,currentOnly:false,enemyEnd:e.cond==='EnemyTurnEnd'};
  if(e.cond==='OverDriveEnd')return {uses:null,turns:null,currentOnly:false,odEnd:true};
  return {uses:null,turns:null,currentOnly:true};
}

function addEffect(list,eff){
  eff.id=++effSeq;
  // 同一来源的 Only 效果覆盖；领域只留最新（Planner Ml）
  if(eff.limitType==='Once'||eff.only)for(let k=list.length-1;k>=0;k--)if(list[k].src===eff.src&&list[k].type===eff.type)list.splice(k,1);
  list.push(eff);
  return eff;
}

/** 按增益槽规则取生效的实例：同组容量 2（[单独发动] 占 2），其余 1；被动不占槽。 */
function slotSelect(list,type,capacity){
  const c=capacity??(R.DOUBLE_SLOT_BUFFS.includes(type)||R.DOUBLE_SLOT_DEBUFFS.includes(type)?2:1);
  const items=list.filter(e=>e.type===type&&!e.passive).sort((a,b)=>b.size-a.size);
  const out=[];let used=0;
  for(const e of items){const cost=e.limitType==='Once'?c:1;if(used+cost>c)continue;out.push(e);used+=cost;if(used>=c)break;}
  return out;
}
const sumSize=list=>list.reduce((s,e)=>s+e.size,0);

// ---------------------------------------------------------------- 被动

const TIMING={
  battleStart:t=>t==='OnBattleStart'||t==='OnFirstBattleStart',
  normalTurnStart:t=>t==='OnPlayerTurnStart'||t==='OnEveryTurnIncludeSpecial'||t==='OnEveryTurn',
  playerTurnStart:t=>t==='OnPlayerTurnStart'||t==='OnEveryTurnIncludeSpecial',
  enemyTurnStart:t=>t==='OnEnemyTurnStart',
  overdriveStart:t=>t==='OnOverdriveStart',
  additionalTurnStart:t=>t==='OnAdditionalTurnStart',
};
// 被动里会触发的“额外命中”类：由动作事件触发，不按时机触发
const EVENT_PASSIVE=/^AdditionalHitOn/;
const ACTION_CONDITION=/\b(?:ConsumeSp|IsAttackNormal)\s*\(/;
const actionPassivesByParty=new WeakMap();
function actionPassives(st){
  const party=st.ctx.party;
  if(actionPassivesByParty.has(party))return actionPassivesByParty.get(party);
  const sources=new Map();
  for(const m of party)for(const p of m.passives){
    const parts=p.parts||[];
    if(p.timing!=='OnPlayerTurnStart'||parts.some(q=>EVENT_PASSIVE.test(q.skillType)))continue;
    if(ACTION_CONDITION.test(p.condition)||parts.some(q=>ACTION_CONDITION.test(q.targetCondition))){
      if(!duplicatePassive(st,m.i,p)){
        if(!sources.has(p))sources.set(p,[]);
        sources.get(p).push(m.i);
      }
    }
  }
  actionPassivesByParty.set(party,sources);
  return sources;
}
/** 消耗 SP / 是否普攻属于本次行动；不能用回合开头尚未选技时的 0 SP 代替。 */
function actionPassiveAmount(st,actor,type,info){
  if(!Number.isFinite(info?.sp)||info.normal||info.passive||info.eventPassive||info.followUp)return 0;
  let amount=0;
  for(const [p,owners] of actionPassives(st))for(const owner of owners)for(const part of p.parts){
    if(part.skillType!==type||!targetsOf(st,owner,part).includes(actor))continue;
    if(p.condition&&!check(st,p.condition,owner,info))continue;
    if(part.targetCondition&&!check(st,part.targetCondition,actor,info))continue;
    amount+=(part.power?.[0]||0)*100;
  }
  return amount;
}

// 同一被动（同 label）由多名成员携带、且作用于他人时只生效一次（2026-11-09 训练场：立華奏、小笠原两份「冰之波動」按一份才吻合，推定）
function duplicatePassive(st,i,p){
  if(!R.DEDUPE_SHARED_PASSIVES||!p.label||(p.parts||[]).every(x=>!x.targetType||x.targetType==='Self'))return false;
  return st.ctx.party.some(u=>u.i<i&&u.passives.some(q=>q.label===p.label));
}
function firePassives(st,when,filter){
  for(const u of st.ctx.party){
    for(const p of u.passives){
      if(!TIMING[when](p.timing))continue;
      if(duplicatePassive(st,u.i,p))continue;
      if((p.parts||[]).some(x=>EVENT_PASSIVE.test(x.skillType)))continue;
      if(actionPassives(st).has(p))continue;
      if(filter&&!filter(p,u))continue;
      firePassive(st,u.i,p);
    }
  }
}
function firePassive(st,i,p,extra={}){
  if(p.limit>0&&(st.passiveCount[p.label+':'+i]||0)>=p.limit)return false;
  if(p.condition&&!check(st,p.condition,i,p.condition.includes('Random(')?{...extra,sampleRandom:true}:extra))return false;
  if(p.rate&&p.rate<100)flag(st,'approx','概率被动按必定触发');
  st.passiveCount[p.label+':'+i]=(st.passiveCount[p.label+':'+i]||0)+1;
  for(const part of p.parts||[])applyPart(st,i,{label:p.label,name:p.name,skillLabel:p.skillLabel,level:1,maxLevel:1,parts:p.parts},part,{...extra,passive:true});
  return true;
}

// ---------------------------------------------------------------- 部件解释

function casterOpts(st,actor,model,info){
  const u=st.ctx.party[actor],pb=passiveBonus(st,actor);
  const tear=(t)=>u.tearType===t?u.tearLevel:0;
  // 超越ゲージ 100%：该属性卡面施放的 攻击力アップ类效果量 +20%、减益效果量 +20%（按被动强化同组相加，推定）
  const tr=transcendFor(st,actor);
  if(model.kind==='buff')return {tearBuffUp:tear('BuffUp'),tearCritRateUp:tear('CriticalRateUp'),passiveStrengthen:isAttackBuff(model.type)?pb.attackBuffUp+(tr?R.TRANSCEND_EFFECT.attackBuffUp:0):0,
    supportStrengthen:isAttackBuff(model.type)?activeStrengthen(st,actor):0};
  const defenseStrength=isDefenseDebuff(model.type)?pb.defenseDebuffUp+actionPassiveAmount(st,actor,'GiveDefenseDebuffUp',info):0;
  return {tearDebuffUp:tear('DebuffUp'),passiveStrengthen:(isStrengthenableDebuff(model.type)?pb.debuffUp+(tr?R.TRANSCEND_EFFECT.debuffUp:0):0)+defenseStrength};
}

function randomBranch(st,actor,skill,part,preview=false){
  const branches=part.branches||[];
  let weights=part.branchWeights;
  if(!weights&&branches.length===2){
    const [low,high]=part.power||[];
    if(Number.isFinite(low)&&low>=0&&low<=1){
      let chance=low;
      if(high>0&&part.diffForMax>0&&part.parameters?.luk){
        const difference=memberStats(st,actor).luk-st.ctx.enemy.border;
        chance=low+(high-low)*Math.max(0,Math.min(1,difference/part.diffForMax));
        flag(st,'approx','随机分支概率按公开端点与幸运差插值，曲线未校准:'+skill.label);
      }
      weights=[chance,1-chance];
    }
  }
  if(!weights||weights.length!==branches.length){
    flag(st,'unsupported','随机分支缺少各叶概率:'+skill.label);return null;
  }
  if(preview||st.ctx.opt.critMode!=='random'||!st.ctx.opt.rng){
    flag(st,'approx','确定性预测取最高概率分支:'+skill.label);
    return branches[weights.indexOf(Math.max(...weights))];
  }
  let draw=st.ctx.opt.rng();
  for(let i=0;i<weights.length;i++){draw-=weights[i];if(draw<0)return branches[i];}
  return branches.at(-1);
}

function selectedBranch(st,actor,skill,part,info){
  const br=part.branches||[];
  if(part.skillType==='SkillSwitch'&&!part.modeSelected&&br.length>1&&!part.cond){
    flag(st,'unsupported','未选择技能模式:'+skill.label);return null;
  }
  if(br.length===1)return br[0];
  if(part.branchConditions){
    const i=part.branchConditions.findIndex(c=>c&&check(st,c,actor,info));
    return i<0?null:br[i];
  }
  if(br.length>2){flag(st,'unsupported','多分支缺少选择条件:'+skill.label);return null;}
  return check(st,part.cond||skill.cond,actor,info)?br[0]:br[1];
}

function applyPart(st,actor,skill,part,info){
  const type=part.skillType;
  // The condition governs a later turn start, not the grant at battle start.
  if(type==='ExecuteSkillOnPreTurn'){
    const triggered=part.triggeredSkill;
    if(!triggered?.parts?.length){flag(st,'unsupported','回合开始派生技能缺数据:'+skill.label);return;}
    st.hasPreTurnSkills=true;
    for(const t of targetsOf(st,actor,part))if(typeof t==='number'){
      addEffect(st.units[t].effects,{type:'preTurnSkill',src:skill.label,skillLabel:triggered.label,
        triggered,condition:part.cond,grantedTurn:st.turn,only:true,...duration(part)});
    }
    return;
  }
  // DamageRateChangeAttackSkill 的 cond（IsHitWeak()）是“命中弱点时威力/破坏率变化”的条件，由伤害模型处理，不是发动条件
  if(part.cond&&type!=='SkillCondition'&&type!=='SkillSwitch'&&type!=='DamageRateChangeAttackSkill'&&!check(st,part.cond,actor,info))return;
  // Graviton counts as one attack on the marked enemy even when its HP-damage condition fails.
  if(type==='FixedHpDamageRate'&&skill.label?.startsWith('AccessorySkillFixedDamageRate')){
    const seal=enemyStatus(st,'Talisman');if(seal)seal.level=Math.min(10,seal.level+1);
  }
  if(part.hitCondition&&!check(st,part.hitCondition,actor,info))return;
  if(type==='SkillCondition'||type==='SkillSwitch'){
    const pick=selectedBranch(st,actor,skill,part,info);
    if(!pick)return;
    runParts(st,actor,{...pick,level:skill.level,hits:pick.hits||skill.hits,maxLevel:pick.maxLevel||skill.maxLevel},info);
    return;
  }
  if(type==='SkillRandom'){
    const br=randomBranch(st,actor,skill,part);
    if(br){
      runParts(st,actor,{...br,level:skill.level,hits:br.hits||skill.hits},info);
      if(st.log)st.log.push({t:'skillRandom',unit:actor,skill:skill.label,branch:br.label,name:br.desc||br.name});
    }
    return;
  }
  if(ATTACK_PART_TYPES.has(type)){doAttack(st,actor,skill,part,info);return;}
  const model=effectModel(skill,part);
  const meta=st.ctx.party[actor];
  if(model){
    const dur=duration(part),level=Math.min(skill.level||1,model.effects.min.length);
    if(model.kind==='buff'){
      if(model.type==='elementField'){
        const fromActiveSkill=!(info.passive||info.eventPassive||info.followUp);
        st.field={element:model.element,size:model.effects.max[0],owner:actor,fromActiveSkill,
          turns:fromActiveSkill&&st.mods.zoneRule?null:dur.turns,src:skill.label};
        if(fromActiveSkill)cardFieldSet(st);
        return;
      }
      for(const t of targetsOf(st,actor,part,info.target)){
        if(typeof t!=='number')continue;
        if(part.targetCondition&&!check(st,part.targetCondition,t,info))continue;
        const sz=buffSize(model,level,meta.stats,casterOpts(st,actor,model,info));
        const eff={type:model.type,element:model.element,size:sz.total,limitType:model.limitType,src:skill.label,owner:actor,passive:!!info.passive,includeNormal:!!model.includeNormal,...dur};
        if(model.type==='consecutiveHit')eff.ratios=model.effects.max.map(x=>x/100);
        if(model.type==='charge')eff.critRate=model.chargeCritRate?.[Math.max(0,Math.min(model.chargeCritRate.length-1,level-1))]||0;
        addEffect(st.units[t].effects,eff);
      }
    }else{
      const apply=(enemy,definition)=>{
        if(part.targetCondition&&!check(st,part.targetCondition,actor,info,{side:'enemy',enemy,model:definition}))return;
        if(type==='SuperBreakDown'&&!(enemy.breakDownTurns>0))return;
        const sz=debuffSize(model,level,meta.stats,definition.border,casterOpts(st,actor,model,info));
        const dt={...dur};
        if(type==='Misfortune')dt.turns=part.power[0];
        if(type==='SuperBreakDown')Object.assign(dt,{currentOnly:false,enemyEnd:true,turns:enemy.breakDownTurns});
        if(!info.passive&&dt.turns!=null&&type!=='SuperBreakDown')dt.turns+=passiveBonus(st,actor).debuffTurnUp;
        addEffect(enemy.effects,{type:model.type,element:model.element,size:type==='Misfortune'?(part.dv??sz.total):sz.total,limitType:model.limitType,src:skill.label,owner:actor,
          openingAll:part.targetType==='All'&&!part.targetCondition,passive:!!info.passive,permanent:!!model.isPermanent,...dt});
      };
      if(part.targetType==='All'&&st.queue){for(const q of st.queue)if(!q.dead)apply(q.state,q.enemy);}
      else apply(st.enemy,st.ctx.enemy);
    }
    return;
  }
  switch(type){
    case 'HealSp':{
      const v=part.power?.[0]||0;
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'&&(!part.targetCondition||check(st,part.targetCondition,t,info))){
        healSp(st,t,v,info.passive||info.eventPassive?null:actor,part.value?.[0]);
      }
      return;
    }
    case 'BreakDownTurnUp':return; // Evaluated against each enemy that actually lost its last shield.
    case 'HealEp':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')healEp(st,t,part.power?.[0]||0);
      return;
    case 'EpLimitOverwrite':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'epLimit',size:part.power?.[0]||10,src:skill.label,owner:actor,...duration(part)});
      return;
    case 'OverwriteSp':{
      const skillLabel=overwriteSkillLabel(st,actor,skill);
      if(!skillLabel)return;
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'overwriteSp',skillLabel,size:part.power?.[0]||0,src:skill.label,owner:actor,...duration(part)});
      return;
    }
    case 'HealDp':{
      // DP 回复（回復能力按施放者能力插值）；主动回复另触发：幼儿回归 +1、受回复者得象征。
      {const amt=healAmount(st,actor,skill,part,info);for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')healDp(st,t,amt,part);}
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'&&!info.passive){
        for(const p of st.ctx.party[t].passives)for(const q of p.parts||[])if(q.skillType==='TokenSetByHealedDp')
          st.units[t].tokens=Math.min(R.MORALE_TOKEN_STACK_MAX,st.units[t].tokens+(q.power?.[0]||1));
      }
      if(!info.passive&&enemyStatus(st,'Infantilized'))raiseEnemyLevel(st,'Infantilized',1,20,skill,part);
      return;
    }
    case 'HealDpByDamage':{
      const damage=(info.damage||0)-(info.damageBeforeSkill||0),amount=damage*(part.power?.[0]||0);
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')healDp(st,t,amount,part);
      return;
    }
    case 'HealDpRate':for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')healDp(st,t,(part.power?.[0]||0)*st.ctx.party[t].dpMax,part);return;
    case 'RegenerationDp':{const amt=healAmount(st,actor,skill,part,info),d=duration(part);
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'regen',size:amt,src:skill.label,owner:actor,...d});return;}
    case 'ReviveDp':case 'ReviveDpRate':{
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'){
        const u=st.units[t],m=st.ctx.party[t],amt=type==='ReviveDpRate'?(part.power?.[0]||0)*m.dpMax:healAmount(st,actor,skill,part,info);
        if(u.down)continue;
        if(u.dpBroken){u.dpBroken=false;u.dp=0;if(st.log)st.log.push({t:'revive',turn:st.turn,unit:t});}
        healDp(st,t,amt,part);
      }
      return;}
    case 'DefenseUp':{
      const d=duration(part),size=defenseSize(st,actor,skill,part);
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')
        addEffect(st.units[t].effects,{type:'defenseUp',size,src:skill.label,owner:actor,passive:!!info.passive&&part.exit?.cond==='Eternal',limitType:part.limitType,enemyEnd:part.exit?.cond==='EnemyTurnEnd',...d});
      return;}
    case 'Provoke':case 'Cover':{
      const apply=enemy=>{
        const t=STATUS_BY_TYPE[type];enemy.effects=enemy.effects.filter(e=>e.type!==t);
        addEffect(enemy.effects,{type:t,size:0,src:skill.label,owner:actor,openingAll:part.targetType==='All',enemyEnd:true,turns:part.power?.[0]||1});
      };
      if(part.targetType==='All')forEachEnemy(st,apply);else apply(st.enemy);
      if(part.power?.[1]>part.power?.[0])flag(st,'approx','挑衅或注目时长取公开范围下限');
      return;}
    case 'Motivation':case 'Revenge':case 'ToughnessUpValuePerRevengeLevel':{
      for(const i of targetsOf(st,actor,part,info.target))if(typeof i==='number'){
        const u=st.units[i],old=u.effects.find(e=>e.status===type);
        if(type==='Revenge'&&part.value?.[0]){if(old)old.level=Math.min(10,old.level+(part.power?.[0]||0));continue;}
        const level=type==='Motivation'?(part.value?.[0]||null):0;
        if(old){if(type==='Motivation')old.level=level;continue;}
        addEffect(u.effects,{type:'status',status:type,size:part.power?.[0]||0,src:skill.label,owner:actor,level,...duration(part)});
      }
      return;}
    case 'Invincible':case 'EAGuard':case 'Dodge':{
      const t=STATUS_BY_TYPE[type];
      for(const i of targetsOf(st,actor,part,info.target))if(typeof i==='number'){
        const u=st.units[i];u.effects=u.effects.filter(e=>e.type!==t);
        addEffect(u.effects,{type:t,src:skill.label,owner:actor,size:part.power?.[0]||0,uses:part.exit?.value?.[0]||part.power?.[0]||1,turns:null});
      }
      return;}
    case 'Makeup':
      for(const i of targetsOf(st,actor,part,info.target))if(typeof i==='number')addEffect(st.units[i].effects,{type:'status',status:type,size:part.power[0],cap:part.value[0],src:skill.label,owner:actor,only:true,...duration(part)});
      return;
    case 'RemoveDebuff':{
      let left=part.power?.[0]>0?Math.floor(part.power[0]):Infinity;
      for(const t of targetsOf(st,actor,part,info.target)){
        if(typeof t!=='number')continue;
        const keep=[];
        for(const e of st.units[t].effects){
          if(left>0&&isAllyDebuff(e)){left--;info.removeDebuffCount=(info.removeDebuffCount||0)+1;}
          else keep.push(e);
        }
        st.units[t].effects=keep;
      }
      return;
    }
    case 'Infantilized':raiseEnemyLevel(st,'Infantilized',part.power?.[0]||0,20,skill,part);return;
    case 'Disaster':raiseEnemyLevel(st,'Disaster',part.power?.[0]||0,99,skill,part);return;
    case 'Venom':{
      const old=enemyStatus(st,'Venom'),d=duration(part);
      if(old){old.level=Math.min(10,(old.level||0)+(part.power?.[0]||0));Object.assign(old,d);}
      else addEffect(st.enemy.effects,{type:'status',status:'Venom',level:Math.min(10,part.power?.[0]||0),statDown:0,bornTurn:st.turn,size:0,src:skill.label,owner:actor,...d});
      return;
    }
    case 'SelfDamage':{
      const fraction=part.power?.[0]||0;
      for(const target of targetsOf(st,actor,part,info.target)){
        const ally=st.units[target];
        if(ally&&!ally.down&&!ally.dpBroken&&ally.dp>0)ally.dp=Math.max(1,Math.ceil(ally.dp*(1-fraction)));
      }
      return;
    }
    case 'Undermine':{
      const apply=es=>addEffect(es.effects,{type:'status',status:type,size:part.dv||100,src:skill.label,owner:actor,...duration(part)});
      if(part.targetType==='All')forEachEnemy(st,apply);else apply(st.enemy);
      return;
    }
    case 'Talisman':{
      const increase=part.power?.[0]||0;
      forEachEnemy(st,es=>{
        const seal=es.effects.find(e=>e.status==='Talisman');
        if(seal)seal.level=Math.min(10,seal.level+increase);
        else if(increase===0)addEffect(es.effects,{type:'status',status:'Talisman',level:0,size:0,src:skill.label,owner:actor,openingAll:part.targetType==='All',...duration(part)});
      });
      return;
    }
    case 'Inscription':
      if(!enemyStatus(st,'Inscription'))addEffect(st.enemy.effects,{type:'status',status:'Inscription',damage:0,size:0,src:skill.label,owner:actor,...duration(part)});
      return;
    case 'InscriptionAttack':releaseInscription(st,skill,info);return;
    case 'ByakkoDoubleActionAttackSkill':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'byakkoDoubleAction',size:0,src:skill.label,owner:actor,...duration(part)});
      return;
    case 'ForceOneDamageByHit':return; // 装备解锁个人开关，每次行动读取排轴中的选择。
    case 'ReplaceNormalSkill':case 'ReplacePursuit':case 'TokenSetByHealedDp':return; // 由普攻、追击、DP 回复事件直接读取被动
    case 'Diva':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'){
        st.units[t].effects=st.units[t].effects.filter(e=>e.status!==type);
        addEffect(st.units[t].effects,{type:'status',status:type,drain:part.power?.[0]||0,size:0,src:skill.label,owner:actor,...duration(part)});
      }
      return;
    case 'Steak':case 'Tea':case 'Curry':case 'Shchi':case 'Gelato':case 'DimSum':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'){
        st.units[t].effects=st.units[t].effects.filter(e=>e.status!==type);
        addEffect(st.units[t].effects,{type:'foodAttack',status:type,size:(part.power?.[0]||0)*100,drain:part.value?.[0]||0,src:skill.label,owner:actor,passive:true,...duration(part)});
      }
      return;
    case 'Shredding':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'status',status:'Shredding',size:0,src:skill.label,owner:actor,...duration(part)});
      return;
    case 'SummersEndTerritory':{
      const existed=st.territory?.name==='SummersEndTerritory';info.summersOpened=!existed;
      if(!existed)st.territory={name:'SummersEndTerritory',active:false,owner:actor,src:skill.label};
      return;
    }
    case 'AttackUpRangeByAllDamageRate':{
      if(info.summersOpened||st.territory?.name!=='SummersEndTerritory')return;
      st.territory.active=true;
      // 公开资料只确认 50%～250% 与破坏率相关；精确分段尚未取得，暂以 100%→50、500%→250 线性近似。
      const size=Math.max(50,Math.min(250,50+50*(st.enemy.dr-1)));
      flag(st,'approx','晚夏之阵攻击增益按破坏率线性近似');
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'){
        st.units[t].effects=st.units[t].effects.filter(e=>e.type!=='summerAttack');
        addEffect(st.units[t].effects,{type:'summerAttack',size,src:skill.label,owner:actor,passive:true,uses:null,turns:3,currentOnly:false});
      }
      return;
    }
    case 'HealSpRandom':{const p=Math.min(1,part.power?.[1]?(part.power[0]+part.power[1])/2:part.power?.[0]||0),v=part.value?.[0]||0;flag(st,'approx','HealSpRandom 按期望值');
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')healSp(st,t,p*v,null);return;}
    case 'OverDrivePointUp':{const mult=info.odMult||1;addOd(st,directOd((part.power?.[0]||0)*100*mult));return;}
    case 'OverDrivePointDown':addOd(st,-(part.power?.[0]||0)*100);return;
    case 'AdditionalTurn':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'&&(!part.targetCondition||check(st,part.targetCondition,t,info)))st.units[t].extra=1;
      return;
    case 'TokenSet':for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')st.units[t].tokens=Math.min(R.MORALE_TOKEN_STACK_MAX,st.units[t].tokens+Math.max(1,Math.round(part.power?.[0]||1)));return;
    case 'Morale':for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')st.units[t].morale=Math.min(R.MORALE_TOKEN_STACK_MAX,st.units[t].morale+(part.power?.[0]||0));return;
    case 'ZoneUpEternal':if(st.field&&st.field.owner===actor){st.field.size+=(part.power?.[0]||0)*100;st.field.turns=null;}else st.mods.zoneUp=(st.mods.zoneUp||0)+(part.power?.[0]||0)*100;return;
    case 'DamageUpByOverDrive':for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'odDamage',size:(part.power?.[0]||0)*100,src:skill.label,owner:actor,passive:true,...duration(part)});return;
    case 'PowerUpValue':case 'DexterityUpValue':case 'ToughnessUpValue':case 'SpiritUpValue':case 'WisdomUpValue':case 'LuckUpValue':case 'AllStatusUpValue':{
      const stat={PowerUpValue:'str',DexterityUpValue:'dex',ToughnessUpValue:'con',SpiritUpValue:'spr',WisdomUpValue:'wis',LuckUpValue:'luk',AllStatusUpValue:'all'}[type];
      const d=duration(part);if(d.uses==null&&d.turns==null&&!d.currentOnly&&part.exit?.cond==='Eternal'&&info.passive)return; // 常驻型已在 passiveBonus
      const m={effects:powerTable(part,skill),paramLimit:part.diffForMax||0,parameters:part.parameters||{}};
      const v=part.diffForMax?buffSize({...m,type:'statUp',maxLevel:skill.maxLevel||1},skill.level||1,meta.stats,{}).total:(part.power?.[0]||0);
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'statUp',stat,size:v,src:skill.label,owner:actor,passive:!!info.passive,...d});
      return;}
    case 'FightingSpirit':{ // 斗志：全能力 +dv，持续 power[0] 回合（Planner/计算器未建模；按说明“激發鬥志N回合”）
      const turns=Math.max(1,Math.round(part.power?.[0]||1));
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'statUp',stat:'all',status:'FightingSpirit',size:part.dv||20,src:skill.label,owner:actor,uses:null,turns,currentOnly:false});
      flag(st,'approx','斗志按 全能力+'+(part.dv||20)+' 计');return;}
    case 'AttackUpPerToken':case 'DamageRateUpPerToken':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:type==='AttackUpPerToken'?'attackUp':'destructionRateUp',perToken:true,size:(part.power?.[0]||0)*100,src:skill.label,owner:actor,passive:true,...duration(part)});
      return;
    case 'IceMark':case 'FireMark':case 'ThunderMark':case 'LightMark':case 'DarkMark':
      for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'&&(!part.targetCondition||check(st,part.targetCondition,t,info))&&!st.units[t].effects.some(e=>e.status===type))
      {const el=type.replace('Mark','').toLowerCase();
        // 印只给该属性卡面；等级 = 部队里该属性卡面数（Game8 756880 / katorasublog 4458）
        if(!hasElement(st.ctx.party[t],el))continue;
        addEffect(st.units[t].effects,{type:'mark',status:type,element:el,level:elementCount(st.ctx.party,el),size:0,src:skill.label,owner:actor,uses:null,turns:null,currentOnly:false});}
      return;
    case 'OverDrivePointUpRandom':addOd(st,(part.power?.[0]||0)*(part.value?.[0]||0)*100);flag(st,'approx','概率 OD 上升按期望值');return;
    case 'TokenSetByAttacking':case 'ZoneUp':case 'GiveDebuffTurnUp':return; // 由 passiveBonus / 攻击事件处理
    case 'FixedHpDamageRate':{
      if(st.enemy.dp.some(g=>g>0))return;
      const d=Math.min(part.value?.[0]||Infinity,(part.power?.[0]||0)*st.enemy.hp);
      st.enemy.hp-=d;st.turnDamage[st.turn]=(st.turnDamage[st.turn]||0)+d;st.totalDamage+=d;st.shownDamage=(st.shownDamage||0)+d;info.damage=(info.damage||0)+d;
      if(st.enemy.hp<=0&&!st.killedTurn){st.enemy.hp=0;st.killedTurn=st.turn;}
      return;}
    case 'DoubleActionExtraSkill':{const d=duration(part);for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'doubleAction',size:0,src:skill.label,owner:actor,...d});return;}
    case 'DamageSp':for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')st.units[t].sp=Math.max(0,st.units[t].sp-(part.power?.[0]||0));return;
    case 'SpecifySp':for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')st.units[t].spSetNext=Math.max(st.units[t].spSetNext??0,part.power?.[0]||0);return;
    case 'OverDrivePointUpByToken':{const n=st.units[actor].tokens||0;addOd(st,directOd(n*(part.power?.[0]||0)*100*(info.odMult||1)));info.consumeTokens=true;return;}
    case 'HealSpByToken':{const n=st.units[actor].tokens||0,cap=part.value?.[0]||R.SP_CAP;for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')st.units[t].sp=Math.max(st.units[t].sp,Math.min(cap,st.units[t].sp+n*(part.power?.[0]||0)));info.consumeTokens=true;return;}
    case 'AttackUpByToken':{const n=st.units[actor].tokens||0;if(n>0)for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number')addEffect(st.units[t].effects,{type:'attackUp',size:n*(part.power?.[0]||0)*100,src:skill.label,owner:actor,...duration(part)});info.consumeTokens=true;return;}
    case 'SkillLimitCountUp':case 'ReduceConsumeOverDrive':return; // 在 usableSkills / startOverdrive 里按被动汇总
    case 'SpecialCommandCountUp':{
      const command=part.branches?.find(b=>b.label==='BIYamawakiSkill55b');
      if(!command){flag(st,'unsupported','特殊指令未建模:'+skill.label);return;}
      const u=st.units[actor];
      u.commandSkill={...command,name:skill.name||command.name};
      u.commandRemaining=(u.commandRemaining||0)+(part.power?.[0]||0);
      return;
    }
    case 'FearOfDevil':{
      forEachEnemy(st,es=>{
        const old=es.effects.find(e=>e.status===type),turns=part.exit?.value?.[0]||1;
        if(old){old.turns=Math.max(old.turns,turns);return;}
        addEffect(es.effects,{type:'status',status:type,size:part.dv,src:skill.label,owner:actor,uses:null,turns,enemyEnd:true});
      });
      return;
    }
    case 'ReduceSp':case 'HighBoost':return; // 消耗减少在 effectiveCost 里按被动统一计算
    case 'GiveAttackBuffUp':case 'GiveDebuffUp':case 'GiveDefenseDebuffUp':case 'AllStatusUpValue':case 'MemorySpirit':case 'SpLimitOverwrite':return; // 被动常驻量在 passiveBonus 里汇总
  }
  if(type==='Nothing')return;
  if(STATUS_PARTS.has(type)){
    for(const t of targetsOf(st,actor,part,info.target))if(typeof t==='number'&&(!part.targetCondition||check(st,part.targetCondition,t,info)))
      addEffect(st.units[t].effects,{type:'status',status:type,size:0,src:skill.label,owner:actor,limitType:'Once',...duration(part)});
    if(!['Diva','BIYamawakiServant'].includes(type))flag(st,'approx','状态只记录、数值效果未建模:'+type);
    return;
  }
  if(/^AdditionalHitOn/.test(type))return; // 事件被动的触发标记，见 firePassiveEvents
  flag(st,'unsupported','效果:'+type);
}

function overwriteSkillLabel(st,actor,skill){
  const meta=st.ctx.party[actor],p=meta.passives.find(x=>x.label===skill.label),source=skill.skillLabel||p?.skillLabel;
  // 嵌入被动的来源技能可能就是目标；若来源本身是 PassiveSkill，则继续按唯一限定 EX 推断。
  if(source&&meta.skills.some(s=>s.label===source&&!s.passive))return source;
  // 纯被动没有目标字段：仅在该卡面唯一限定 EX 时推断；多 EX 时宁可不套用，也不覆写全部技能。
  const candidates=meta.skills.filter(s=>s.ownStyle&&s.restricted&&!s.passive);
  if(candidates.length===1)return candidates[0].label;
  flag(st,'approx','OverwriteSp 目标无法唯一推断:'+skill.label);
  return null;
}
function isAllyDebuff(e){
  return e.debuff===true||['attackDown','defenseDown','critRateDown','critDamageDown','resistanceDown','statDown'].includes(e.type)
    ||['NegativeMind','Undermine','FearOfDevil','Stun','Confusion','Imprison','Recoil'].includes(e.status);
}
function raiseEnemyLevel(st,name,delta,cap,skill,part){
  if(!(delta>0))return;
  let e=enemyStatus(st,name);
  if(!e)e=addEffect(st.enemy.effects,{type:'status',status:name,level:0,size:0,src:skill.label,owner:skill.owner??0,...duration(part)});
  e.level=Math.min(cap,(e.level||0)+delta);e.size=e.level;
}
function epLimit(st,t){
  return Math.max(10,...st.units[t].effects.filter(e=>e.type==='epLimit').map(e=>e.size||10));
}
function healEp(st,t,v){
  const u=st.units[t];u.ep=Math.max(0,Math.min(epLimit(st,t),u.ep+v));
}
/** 固定伤害：先 DP 后 HP；不增 OD、不增破坏率，也不进入刻印累计。 */
function directEnemyDamage(st,amount,info={}){
  const en=st.enemy;let dealt=0;
  const idx=en.dp.findIndex(g=>g>0);
  if(idx>=0){const d=Math.min(amount,en.dp[idx]);en.dp[idx]-=d;dealt+=d;if(en.dp[idx]<=0){en.dp[idx]=0;if(!en.dp.some(g=>g>0)){onEnemyBreak(st,st.ctx.enemy,en);info.breakHits=(info.breakHits||0)+1;}}}
  else{const d=Math.min(amount,en.hp);en.hp-=d;dealt+=d;}
  if(en.hp<=0&&!st.killedTurn){en.hp=0;st.killedTurn=st.turn;}
  st.turnDamage[st.turn]=(st.turnDamage[st.turn]||0)+dealt;st.totalDamage+=dealt;st.shownDamage=(st.shownDamage||0)+amount;info.damage=(info.damage||0)+dealt;
  return dealt;
}
function releaseInscription(st,skill,info){
  const mark=enemyStatus(st,'Inscription');if(!mark)return;
  const amount=Math.min(2e9,Math.max(0,mark.damage||0)),hits=skill.hits?.length?skill.hits:Array.from({length:8},(_,i)=>({ratio:i===7?0.65:0.05}));
  st.enemy.effects=st.enemy.effects.filter(e=>e!==mark);
  for(const h of hits){if(st.enemy.hp<=0)break;directEnemyDamage(st,amount*(h.ratio||0),info);}
  info.attacked=true;info.inscriptionReleased=amount;
}

/** 事件被动（AdditionalHitOn*）：破盾、命中弱点、使用指定技能、EX 技能、击倒 → 触发同一被动里的其余部件。 */
const EVENT_TESTS={
  AdditionalHitOnBreaking:(st,i,skill,info)=>(info.breakHits||0)>0,
  AdditionalHitOnWeak:(st,i,skill,info)=>!info.normal&&info.attacked&&info.weak,
  AdditionalHitOnSpecifiedSkill:(st,i,skill,info,part)=>{
    const labels=[...(part.strval||[]).filter(x=>typeof x==='string'),...(part.branches||[]).map(x=>x.label)];
    return labels.some(lab=>skill.label===lab||String(skill.label).startsWith(lab));
  },
  AdditionalHitOnExtraSkill:(st,i,skill,info)=>!info.normal&&isEX(skill),
  AdditionalHitOnKill:(st,i,skill,info)=>info.attacked&&st.killedTurn===st.turn&&st.enemy.hp<=0,
  AdditionalHitOnKillCount:(st,i,skill,info)=>info.attacked&&st.killedTurn===st.turn&&st.enemy.hp<=0,
};
function firePassiveEvents(st,i,skill,info){
  const meta=st.ctx.party[i];
  for(const p of meta.passives){
    const trig=(p.parts||[]).find(x=>/^AdditionalHitOn/.test(x.skillType));
    if(!trig||trig.skillType==='AdditionalHitOnHealedSpWithoutSelfHeal')continue;
    const test=EVENT_TESTS[trig.skillType];
    if(!test){
      const note=`${meta.name}已装备「${p.name||p.label}」，触发条件未建模（${trig.skillType}）`;
      if(!st.flags.approx[note])flag(st,'approx',note);
      continue;
    }
    if(!test(st,i,skill,info,trig))continue;
    if(trig.cond&&!check(st,trig.cond,i,info))continue;
    if(p.limit>0&&(st.passiveCount[p.label+':'+i]||0)>=p.limit)continue;
    if(p.condition&&!check(st,p.condition,i,info))continue;
    st.passiveCount[p.label+':'+i]=(st.passiveCount[p.label+':'+i]||0)+1;
    for(const part of p.parts){
      if(/^AdditionalHitOn/.test(part.skillType))continue;
      if(part.skillType==='AdditionalTurn'&&st.round==='extra')continue; // 追加回合内除外
      applyPart(st,i,{label:p.label,name:p.name,skillLabel:p.skillLabel,level:1,maxLevel:1,parts:p.parts},part,{...info,passive:false,eventPassive:true});
    }
  }
}

function healSp(st,t,v,byAlly,maximum){
  const u=st.units[t],memberCap=spLimit(st,t),cap=maximum>0?Math.min(maximum,memberCap??maximum):memberCap;
  u.sp=cap==null?u.sp+v:Math.max(u.sp,Math.min(cap,u.sp+v));
  // “被他人主动技能回复 SP 时”类被动（AdditionalHitOnHealedSpWithoutSelfHeal）
  if(byAlly!=null&&byAlly!==t)for(const p of st.ctx.party[t].passives)if((p.parts||[]).some(x=>x.skillType==='AdditionalHitOnHealedSpWithoutSelfHeal')){
    for(const part of p.parts)if(part.skillType==='HealSp')for(const k of targetsOf(st,t,part)){if(typeof k==='number'){const c=spLimit(st,k);st.units[k].sp=c==null?st.units[k].sp+(part.power?.[0]||0):Math.min(Math.max(c,st.units[k].sp),st.units[k].sp+(part.power?.[0]||0));}}
  }
}
function spLimit(st,t){
  let cap=null;
  for(const p of st.ctx.party[t].passives)for(const part of p.parts||[])if(part.skillType==='SpLimitOverwrite'&&part.exit?.cond==='Eternal')cap=Math.max(cap||0,part.power?.[0]||0);
  return cap;
}

// 常驻被动汇总（攻击增益强化、减益强化、全能力 +N）：只看已满足条件的 Eternal 类被动
function passiveBonus(st,i){
  const out={attackBuffUp:0,debuffUp:0,defenseDebuffUp:0,allStat:0,zoneUp:0,debuffTurnUp:0};
  for(const u of st.ctx.party)for(const p of u.passives){if(duplicatePassive(st,u.i,p)||actionPassives(st).has(p))continue;for(const part of p.parts||[]){
    const k={GiveAttackBuffUp:'attackBuffUp',GiveDebuffUp:'debuffUp',GiveDefenseDebuffUp:'defenseDebuffUp',AllStatusUpValue:'allStat',MemorySpirit:'allStat',ZoneUp:'zoneUp',GiveDebuffTurnUp:'debuffTurnUp'}[part.skillType];
    if(!k)continue;
    if(!targetsOf(st,u.i,part).includes(i))continue;
    if(p.condition&&!check(st,p.condition,u.i,{}))continue;
    // MemorySpirit（大师技能“紡がれた記憶”等）：按记忆修复人数最多 +dv，按满值计（近似）
    // MemorySpirit（大师技能“紡がれた記憶”）：只在战斗中生效、不进显示面板；缺 dv 时沿用模型的满级假定 +20。
    out[k]+=part.skillType==='MemorySpirit'?(part.dv||20):(k==='allStat'||k==='debuffTurnUp')?(part.power?.[0]||0):(part.power?.[0]||0)*100;
  }}
  return out;
}
// 技能给予的“攻击增益效果量上升”（GiveAttackBuffUp 主动部件）：施放者身上的有效值
function activeStrengthen(st,actor){return st.units[actor].effects.filter(e=>e.type==='giveAttackBuffUp').reduce((s,e)=>s+e.size,0);}

// ---------------------------------------------------------------- 攻击

export function memberStats(st,i){
  const m=st.ctx.party[i],u=st.units[i],add=Math.min(10,u.morale||0)*R.MORALE_STAT+passiveBonus(st,i).allStat;
  const ups=u.effects.filter(e=>e.type==='statUp');
  const revenge=(u.effects.find(e=>e.status==='Revenge')?.level||0)*(u.effects.find(e=>e.status==='ToughnessUpValuePerRevengeLevel')?.size||0);
  if(!add&&!ups.length&&!revenge)return m.stats;
  return Object.fromEntries(R.STATS.map(k=>[k,m.stats[k]+add+(k==='con'?revenge:0)+ups.filter(e=>e.stat==='all'||e.stat===k).reduce((s,e)=>s+e.size,0)]));
}

function enemyParamDown(st){
  const effects=st.enemy.effects,other=Math.max(0,...effects.filter(e=>e.type==='misfortune').map(e=>e.size))
    +(enemyStatus(st,'Disaster')?.level||0)*7+(enemyStatus(st,'Venom')?.statDown||0);
  return Math.max(other,enemyStatus(st,'FearOfDevil')?.size||0,10*(enemyStatus(st,'Talisman')?.level||0),
    ...effects.filter(e=>e.status==='Undermine').map(e=>e.size));
}

/** 收集攻击者当前的增益/减益合计（%），交给 computeAttack。 */
export function collectMods(st,actor,model,info={}){
  const u=st.units[actor],m=st.ctx.party[actor],eff=u.effects,en=st.enemy.effects,el=model.element;
  const pick=(list,type)=>sumSize(slotSelect(list,type));
  const passive=(list,type,f=()=>true)=>list.filter(e=>e.passive&&e.type===type&&f(e)).reduce((s,e)=>s+(e.perToken?e.size*(st.units[actor].tokens||0):e.size),0);
  const elemMatch=e=>!e.element||e.element===el;
  const normalOk=e=>!info.normal||e.includeNormal;
  const tok=e=>e.perToken?e.size*(u.tokens||0):e.size;
  const atkBuffs=eff.filter(e=>e.type==='attackUp'&&!e.passive&&normalOk(e));
  const charge=info.normal?null:slotSelect(eff,'charge',1)[0];
  const activeFieldBonus=st.field?.fromActiveSkill?st.mods.zoneRule||0:0;
  const field=st.field&&st.field.element===el?(st.field.size*(1+passiveBonus(st,st.field.owner).zoneUp/100)+(st.mods.zoneUp||0))*(1+activeFieldBonus/100):0;
  const eq=m.equipment;
  const mods={
    attackUp:sumSize(slotSelect(atkBuffs,'attackUp')),passiveAttackUp:passive(eff,'attackUp',normalOk)+actionPassiveAmount(st,actor,'AttackUp',info),
    elementAttackUp:sumSize(slotSelect(eff.filter(e=>e.type==='elementAttackUp'&&e.element===el),'elementAttackUp')),
    passiveElementAttackUp:passive(eff,'elementAttackUp',e=>e.element===el),
    mindsEye:pick(eff,'mindsEye')+passive(eff,'mindsEye'),
    critRateUp:pick(eff,'critRateUp'),passiveCritRateUp:passive(eff,'critRateUp'),
    elementCritRateUp:sumSize(slotSelect(eff.filter(e=>e.type==='elementCritRateUp'&&e.element===el),'elementCritRateUp'))+passive(eff,'elementCritRateUp',e=>e.element===el),
    critDamageUp:pick(eff,'critDamageUp'),passiveCritDamageUp:passive(eff,'critDamageUp'),
    elementCritDamageUp:sumSize(slotSelect(eff.filter(e=>e.type==='elementCritDamageUp'&&e.element===el),'elementCritDamageUp'))+passive(eff,'elementCritDamageUp',e=>e.element===el),
    chargeAttackUp:charge?charge.size:0,chargeCritRate:charge?charge.critRate:0,
    shadowClone:pick(eff,'shadowClone'),passiveShadowClone:passive(eff,'shadowClone'),
    yamawaki:pick(eff,'yamawakiMinion'),passiveYamawaki:passive(eff,'yamawakiMinion'),
    eternalOath:pick(eff,'eternalOath'),cherry:pick(eff,'arrowCherryBlossoms'),
    destructionRateUp:pick(eff,'destructionRateUp'),passiveDamageRateUp:passive(eff,'destructionRateUp'),
    funnel:[...slotSelect(eff,'consecutiveHit').flatMap(e=>e.ratios||[]),...eff.filter(e=>e.passive&&e.type==='consecutiveHit').flatMap(e=>e.ratios||[])],
    morale:u.morale,tokens:u.tokens,field,
    defenseDown:sumSize(slotSelect(en.filter(e=>!e.permanent),'defenseDown')),passiveDefenseDown:passive(en,'defenseDown',e=>!e.permanent),
    permanentDefenseDown:sumSize(slotSelect(en.filter(e=>e.permanent&&e.type==='defenseDown'),'defenseDown')),
    elementDefenseDown:sumSize(slotSelect(en.filter(e=>!e.permanent&&e.type==='elementDefenseDown'&&elemMatch(e)),'elementDefenseDown')),
    permanentElementDefenseDown:sumSize(slotSelect(en.filter(e=>e.permanent&&e.type==='elementDefenseDown'&&elemMatch(e)),'elementDefenseDown')),
    dpDefenseDown:pick(en,'dpDefenseDown'),fragile:pick(en,'fragile'),
    resistanceDown:sumSize(slotSelect(en.filter(e=>e.type==='resistanceDown'&&elemMatch(e)),'resistanceDown')),
    resistanceOverwrite:en.some(e=>e.type==='resistanceDownOverwrite'&&elemMatch(e)),
    misfortune:enemyParamDown(st),
    babied:(()=>{const lv=enemyStatus(st,'Infantilized')?.level||0;return 3*lv+(lv>=20?30:0);})(),
    superBreak:Math.max(0,...en.filter(e=>e.type==='superBreak').map(e=>e.size)),superDown:Math.max(0,...en.filter(e=>e.type==='superDown').map(e=>e.size)),
    necklace:!!eq.necklaceAttack,ringLevel:eq.ringElement&&eq.ringElement===el?eq.ringLevel:null,earring:eq.earring||{type:null,bonus:10},
    overdrivePercent:st.odRounds>0?100+eff.filter(e=>e.type==='odDamage').reduce((s,e)=>s+e.size,0)*(st.odLevel||1):100, /* 2025-07 ver5.11 起 OD1/2/3 = ×1.1/1.2/1.3（社区计算器同） */tearLevel:m.tearType==='AttackUp'?m.tearLevel:0,dpPercent:m.dpMax?100*u.dp/m.dpMax:100,spValue:model.spMax?(info.sp??u.sp):u.sp,
    scoreAttackAttackUp:st.mods.attackUpRule||0,
  };
  // 禍每级 −7 能力值、幼儿回归每级攻击 +3%（Lv20 再 +30%）：游戏内说明（用户 2026-11-09 确认可信）
  // 料理与晚夏之阵都是独立技能攻击增益，不占普通两个攻击增益槽；普攻不吃。
  if(!info.normal)mods.passiveAttackUp+=sumSize(eff.filter(e=>e.type==='foodAttack'||e.type==='summerAttack'));
  // 手环“普通攻击攻击力 +N%”（每回合开始给予，按与攻击力同组相加；2026-11-09 训练场普攻读数吻合）
  if(info.normal&&eq.normalAttackUp)mods.passiveAttackUp+=eq.normalAttackUp;
  // 古代项链“技能攻击 +10%”、进攻/破坏耳环“技能攻击力”只对技能
  if(info.normal){mods.necklace=false;mods.earring={type:null,bonus:10};}
  if(st.cards?.size)cardMods(st,actor,el,info,mods);
  // 属性の印（持有者 = 该属性卡面；等级 = 部队该属性人数）：Lv1 技能攻击与ダメージ+30%（乘区待核对，暂按独立乘区）、
  // Lv3 技能攻击破坏率上升量+10%、Lv4 暴击率+30%、Lv5 暴击伤害+30%
  const mk=markOf(st,actor);
  // 属性の印（2026-11-09 训练场三轮 + N1 定案）：
  //   Lv1“技能攻击时伤害 +30%”：只对该属性的技能，并入攻击力组相加（冰凍瞬間超越前后 5 组读数吻合；火技能无）
  //   Lv3“技能攻击时破坏率 +10%”：同 Lv1 范围（推定）
  //   Lv4/Lv5“攻击时暴击率/暴伤 +30%”：持有者的所有攻击（含普攻，蒼井暗属性普攻暴击倍率 ≈2.1）
  if(mk){
    const V=R.MARK_VALUES,L=R.MARK_EFFECT,same=el===mk.element;
    if(!info.normal&&same&&mk.level>=L.damageUp)mods.passiveAttackUp+=V.damageUp;
    if(!info.normal&&same&&mk.level>=L.destructionRateUp)mods.passiveDamageRateUp+=V.destructionRateUp;
    if(mk.level>=L.critRate)mods.passiveCritRateUp+=V.critRate;
    if(mk.level>=L.critDamage)mods.passiveCritDamageUp+=V.critDamage;
  }
  // 超越ゲージ 100%：该属性卡面 攻击力+300%（与技能攻击力アップ同组，Game8 实测）、破坏率上升量+10%；
  // 该属性攻击 バースト：确定暴击、暴击伤害+100%（单独发动：与技能的单独发动暴伤取高者）、破坏率上限 +300%（不与超ダウン/強ブレイク叠加）
  if(transcendFor(st,actor)){
    const X=R.TRANSCEND_EFFECT;
    mods.passiveAttackUp+=X.attackUp;mods.passiveDamageRateUp+=X.destructionRateUp;
    if(el===st.trans.element){
      mods.forceCrit=true;
      const cd=eff.filter(e=>e.type==='critDamageUp').concat([{type:'critDamageUp',size:X.critDamage,limitType:'Once'}]);
      mods.critDamageUp=sumSize(slotSelect(cd,'critDamageUp'));
      const cap=Math.max(mods.superBreak,mods.superDown);
      mods.superBreak=Math.max(cap,X.destructionLimit);mods.superDown=0;
      // 推定 D：超越的单独发动暴伤生效时，被动暴伤（冰之轟鳴、印 Lv5 等）不再叠加（冰凍瞬間实测比叠加低约 20%）
      if(R.TRANSCEND_CRIT_EXCLUSIVE){mods.passiveCritDamageUp=0;flag(st,'approx','超越暴伤与被动暴伤不叠加（推定 D）');}
    }
  }
  return mods;
}

function doAttack(st,actor,skill,part,info){
  const shownBefore=st.shownDamage||0;
  const m=st.ctx.party[actor],u=st.units[actor],E=st.ctx.enemy,en=st.enemy;
  const model=info.normal?(info.normalPart?{...attackModel(info.normalSkill,info.normalPart,{characterId:m.charId,styleId:m.styleId,physicalType:String(m.attackType||'slash').toLowerCase()}),tearEnhancementType:m.tearType}:normalAttackModel(m))
    :{...attackModel(skill,part,{characterId:m.charId,styleId:m.styleId,physicalType:String(m.attackType||'slash').toLowerCase()}),tearEnhancementType:m.tearType};
  // 沉浸状态：攻击技能带所选属性（普攻、追击不在对象内）
  if(!info.normal&&!info.command&&u.reinforced)model.element=u.reinforced;
  const mode=info.command&&st.ctx.opt.critMode!=='random'?'all':st.ctx.opt.critMode||'expected',rng=st.ctx.opt.rng;
  // 全体攻击也按各目标的状态值、抗性、DP/HP、减益及破坏率计算。
  // 先冻结本次攻击的增益，再逐目标结算，避免第一个目标触发的效果影响同次攻击的旁敌。
  const targets=part.targetType==='All'&&st.queue?st.queue.filter(q=>!q.dead&&q.state.hp>0):[st.queue?.find(q=>q.state===en)||{enemy:E,state:en}];
  const attacks=targets.map(q=>{
    const view={...st,ctx:{...st.ctx,enemy:q.enemy},enemy:q.state};
    const mods=info.command?commandDamageMods(view):collectMods(view,actor,model,info);
    if(info.limiter&&!info.normal&&!info.command&&!info.passive&&!info.eventPassive&&!info.followUp&&limitablePart(part))
      mods.forceOneDamage=true;
    const targetModel=info.command?{...model,penetrationPhysicalWeakness:Math.max(part.value[0]*100,q.enemy.weaknesses.physical[model.physicalType]||100)}:model;
    const res=computeAttack({skill:targetModel,level:skill.level||1,stats:info.commandStats||memberStats(view,actor),enemy:q.enemy,mods,
      state:{destructionRate:q.state.dr,hp:q.state.hp,dp:q.state.dp}});
    const rate=res.critRate.total/100,w=mode==='all'?1:mode==='none'?0:rate;
    // 沿用主目标的逐段期望/随机取样路径；随机破盾分支仍与 computeAttack 的区间路径近似一致。
    const hits=res.perHit.map((h,k)=>{const c=res.perHitCrit[k];
      if(mode==='random'&&rng){const v=rng()<rate?c:h;return {dmg:v.min+(v.max-v.min)*rng(),after:v.after};}
      return {dmg:((h.min+h.max)/2)*(1-w)+((c.min+c.max)/2)*w,after:mode==='all'?c.after:h.after};});
    const total=hits.reduce((sum,h)=>sum+h.dmg,0),cap=capAttack(total,!!st.ctx.opt.exAttenuation);
    if(total>0&&cap<total)for(const h of hits)h.dmg*=cap/total;
    return {q,view,mods,res,rate,hits};
  });
  const rate=attacks.find(a=>a.q.state===en)?.rate??attacks[0]?.rate??0;
  let dealt=0;
  for(const {q,view,mods,res,hits} of attacks){
    const es=q.state,enemy=q.enemy;let targetDealt=0;
    info.weak=info.weak||res.meta.weak;
    st.shownDamage=(st.shownDamage||0)+hits.reduce((sum,h)=>sum+h.dmg,0);
    for(const h of hits){
      if(es.hp<=0)break;
      const gauge=es.dp.findIndex(g=>g>0);
      if(gauge>=0){
        // 破盾的一段只扣当前盾；该段的多余伤害不能直接进入 HP。
        const d=Math.min(h.dmg,es.dp[gauge]);es.dp[gauge]-=d;targetDealt+=d;
        if(es.dp[gauge]<=0){es.dp[gauge]=0;
          if(!es.dp.some(g=>g>0)){onEnemyBreak(st,enemy,es);info.breakHits=(info.breakHits||0)+1;
            const superDown=skill.parts?.find(p=>p.skillType==='SuperBreakDown');
            if(superDown&&es.breakDownTurns>0)applyPart(view,actor,skill,superDown,info);
            if(st.log)st.log.push({t:'break',turn:st.turn,name:enemy.name});
            if(!info.command&&m.role==='Breaker')cardBreak(st);}
          es.dr=Math.max(es.dr,h.after);
        }
      }else{const d=Math.min(h.dmg,es.hp);es.hp-=d;targetDealt+=d;es.dr=Math.max(es.dr,h.after);}
    }
    if(es.hp<=0){es.hp=0;
      if(es===en&&!st.killedTurn)st.killedTurn=st.turn;
      if(st.queue&&!q.dead){q.dead=true;if(st.log)st.log.push({t:'kill',turn:st.turn,name:enemy.name});}}
    dealt+=targetDealt;
    const seal=enemyStatus(view,'Talisman');
    if(seal&&!info.command&&!info.followUp&&!info.eventPassive&&!info.passive&&!TALISMAN_EXCEPTIONS.has(skill.label)){
      const touched=info.talismanTargets??=new Set();
      if(!touched.has(es)){
        touched.add(es);
        // Some support/healing attacks deal damage but do not advance the talisman.
        if(!info.normal&&skill.parts?.some(p=>p.skillType==='HealDpByDamage')){
          flag(st,'approx','带吸收的攻击是否增加灵符因技能而异，未计该攻击的层数');
        }else seal.level=Math.min(10,seal.level+1);
      }
    }
    const inscription=enemyStatus(view,'Inscription');if(inscription&&targetDealt>0)inscription.damage=(inscription.damage||0)+targetDealt;
    // 只给实际参与本次攻击且不被抗的目标计 OD，不再乘静态敌人数。
    const resisted=model.physicalType&&enemy.weaknesses.physical[model.physicalType]<100||enemy.weaknesses.element[model.element]<100;
    if(!info.normal&&(info.command||!resisted)){
      const bonus=info.command?0:odEarring(m.equipment.odEarringBonus,model.hitCount);
      const per=floorOd(Math.floor(R.OD_PER_HIT*100*(enemy.odRate??1))/100*(1+bonus/100));
      // 单敌搜索旧接口可能只有数量摘要，没有旁敌状态；保持其 OD 估算。
      const count=!st.queue&&part.targetType==='All'?1+Math.max(0,enemy.others||0):1;
      if(count>1)flag(st,'approx','全体攻击缺少旁敌状态，仅按目标数估算 OD');
      addOd(st,(model.hitCount+mods.funnel.length)*per*st.odGainMult*count);
    }
  }
  st.turnDamage[st.turn]=(st.turnDamage[st.turn]||0)+dealt;
  st.totalDamage+=dealt;
  if(!info.normal&&st.skillDamageByElement){const el=model.element||'nonelemental';
    st.skillDamageByElement[el]=(st.skillDamageByElement[el]||0)+(st.shownDamage-shownBefore);}
  info.damage=(info.damage||0)+dealt;info.attacked=true;info.crit=rate;
  if(info.command)return;
  for(const effect of u.effects)if(effect.drain>0&&dealt>0)healDp(st,actor,dealt*effect.drain,null);
  if(!info.normal){
    // 攻击得标记（TokenSetByAttacking：每对 1 个敌人造成伤害 +1）
    for(const p of m.passives)for(const part of p.parts||[])if(part.skillType==='TokenSetByAttacking')u.tokens=Math.min(R.MORALE_TOKEN_STACK_MAX,u.tokens+(part.power?.[0]||1));
  }
  if(!info.normal){
    // 攻击后：消耗“下次攻击”类（Count）攻击侧增益；连击按次数
    for(const e of u.effects)if(e.uses!=null&&['attackUp','elementAttackUp','mindsEye','critRateUp','critDamageUp','elementCritRateUp','elementCritDamageUp','consecutiveHit','charge','destructionRateUp','arrowCherryBlossoms','shadowClone'].includes(e.type)&&(e.type!=='elementAttackUp'||e.element===model.element||!e.element))e.uses--;
    u.effects=u.effects.filter(e=>e.uses==null||e.uses>0);
  }
}

// 骑兵使用全队原始面板，不继承角色增益、连击、装备与角色行动触发。
// 目标已经受到的减益及目标自身的破坏率沿用普通伤害结算。
function commandDamageMods(st){
  const en=st.enemy.effects,def=en.filter(e=>e.type==='defenseDown');
  return {funnel:[],misfortune:enemyParamDown(st),
    defenseDown:sumSize(slotSelect(def.filter(e=>!e.permanent),'defenseDown')),
    passiveDefenseDown:sumSize(def.filter(e=>e.passive&&!e.permanent)),
    permanentDefenseDown:sumSize(slotSelect(def.filter(e=>e.permanent),'defenseDown')),
    dpDefenseDown:sumSize(slotSelect(en,'dpDefenseDown')),fragile:sumSize(slotSelect(en,'fragile')),
    superBreak:Math.max(0,...en.filter(e=>e.type==='superBreak').map(e=>e.size)),
    superDown:Math.max(0,...en.filter(e=>e.type==='superDown').map(e=>e.size))};
}

/** 行动选择画面上的独立按钮。成员的技能格、行动顺序和前后排不影响按钮。 */
export function availableCommands(st){
  if(st.wiped||st.killedTurn||!['main','od','extra'].includes(st.round))return [];
  return st.units.filter(u=>u.commandRemaining>0&&u.commandSkill&&!u.down)
    .map(u=>({u:u.i,s:u.commandSkill.label,name:u.commandSkill.name,remaining:u.commandRemaining}));
}

export function useCommand(st,i,label){
  if(!availableCommands(st).some(c=>c.u===i&&c.s===label))return null;
  const u=st.units[i],skill=u.commandSkill,party=st.ctx.party;
  const commandStats=Object.fromEntries(R.STATS.map(k=>[k,party.reduce((sum,m)=>sum+m.stats[k],0)/party.length]));
  const info={command:true,commandStats};
  u.commandRemaining--;
  runParts(st,i,skill,info);
  advanceTarget(st);
  if(st.ctx.enemy.extraGauge)flag(st,'approx','魔界骑兵无视属性削减 E 护盾的计数尚未建模');
  const result={damage:info.damage||0,name:skill.name,label,od:st.od,remaining:u.commandRemaining};
  if(st.log)st.log.push({t:'command',turn:st.turn,round:st.round,unit:i,skill:skill.name,...result});
  return result;
}

// OD 耳环（Planner Ss/aa）：bonus 为 10/12/15；hit 越多加成越高
function odEarring(bonus,hits){
  if(!bonus)return 0;
  const i=Number.isFinite(hits)?Math.min(Math.max(Math.ceil(hits),1),10):1;
  return bonus-(bonus-5)/9*(10-i);
}

// 普通攻击：公开数据没有部件，沿用推定（力2灵巧1、威力 300–600、3 hit 计 OD）
export function normalAttackModel(m){
  // 手环“普通攻击变为X属性”时普攻带该属性（受该属性弱点/超越バースト影响）
  // 威力曲线按训练场拟合（R.NORMAL_ATTACK）；总威力各角色相同，按角色分成不同 hit 数（R.NORMAL_HITS，未知按 1）
  const N=R.NORMAL_ATTACK,hits=R.NORMAL_HITS_BY_CHAR[m.charId]||R.NORMAL_HITS_BY_WEAPON[m.weapon]||1;
  return {id:'normal',label:'Normal',element:m.equipment?.normalElement||'nonelemental',physicalType:String(m.attackType||'slash').toLowerCase(),hitCount:hits,maxLevel:1,
    powers:{min:[N.min],max:[N.max]},paramLimit:N.limit,parameters:{str:2,dex:1,con:0,wis:0,spr:0,luk:0},destructionRateBonus:1};
}

// ---------------------------------------------------------------- 行动

function runParts(st,actor,skill,info){
  const parts=skill.parts||[];
  const before=parts.filter(p=>p.hits?.some(h=>h.type==='Before'));
  const after=parts.filter(p=>p.hits?.some(h=>h.type==='After'));
  const main=parts.filter(p=>!before.includes(p)&&!after.includes(p));
  for(const p of [...before,...main,...after])applyPart(st,actor,skill,p,info);
}

/** 消耗：先结算技能 overwrite／OverwriteSp，再算 SP 常驻减耗；EP 不走 SP 减耗。 */
export function effectiveCost(st,i,s){
  if(s.consume==='Sp'&&s.sp===-1)return Math.max(0,st.units[i].sp);
  const label=ROOT_LABEL(s),previous=st.units[i].playedSkills?.[label]||0;
  let base=s.spPerUse?Math.min(s.spUseCap,(s.sp||0)+previous*s.spPerUse):s.sp||0;
  if(Number.isFinite(s.overwrite)&&(!s.overwriteCond||check(st,s.overwriteCond,i,{})))base=s.overwrite;
  const switched=s.parts?.find(p=>p.modeSelected);
  const leaf=switched&&selectedBranch(st,i,s,switched,{});
  if(leaf&&Number.isFinite(leaf.overwrite)&&(!leaf.overwriteCond||check(st,leaf.overwriteCond,i,{})))base=leaf.overwrite;
  const ow=st.units[i].effects.filter(e=>e.type==='overwriteSp'&&e.skillLabel===label).sort((a,b)=>(a.id||0)-(b.id||0)).at(-1);
  if(ow)base=ow.size;
  // 沉浸状态：技能消耗 SP 变为 0（消耗全部 SP 的技能除外）
  if(st.units[i].reinforced&&!(s.parts||[]).some(p=>p.skillType==='AttackBySp'))return 0;
  if(s.consume==='Ep')return Math.max(0,base);
  let red=0;
  for(const u of st.ctx.party)for(const p of u.passives){if(duplicatePassive(st,u.i,p))continue;for(const part of p.parts||[]){
    if(part.skillType!=='ReduceSp'&&part.skillType!=='HighBoost')continue;
    const eternal=part.exit?.cond==='Eternal',odEnd=part.exit?.cond==='OverDriveEnd';
    const timingOk=(eternal&&TIMING.battleStart(p.timing))||(odEnd&&st.odRounds>0&&p.timing==='OnOverdriveStart')
      ||(p.timing==='OnAdditionalTurnStart'&&st.round==='extra')||(!eternal&&!odEnd&&TIMING.playerTurnStart(p.timing));
    if(!timingOk)continue;
    if(!targetsOf(st,u.i,part).includes(i))continue;
    if(p.condition&&!check(st,p.condition,u.i,{}))continue;
    if(part.targetCondition&&!check(st,part.targetCondition,i,{}))continue;
    red+=part.skillType==='HighBoost'?-2:(part.power?.[0]||0);
  }}
  return Math.max(0,base-red);
}

function skillElement(s){const parts=(s.parts||[]).flatMap(p=>p.branches?p.branches.flatMap(b=>b.parts||[]):[p]);const p=parts.find(x=>(x.elements||[]).length);return p?elementOf(p):null;}
const isEX=s=>s.isEX??/Skill5\d/.test(s.label||'');
function powerTable(part,skill){const p=part.power||[0,0],g=part.growth||[0,0],n=Math.max(1,skill?.maxLevel||1),fixed=!p[1];const min=[],max=[];for(let lv=1;lv<=n;lv++){min.push(p[0]*(1+(g[0]||0)*(lv-1)));max.push((fixed?p[0]:p[1])*(1+(g[fixed?0:1]||0)*(lv-1)));}return {min,max};}
const zeroSpOk=s=>/Sp\(\)\s*>=\s*0/.test(s.useCond||'')||/Sp\(\)\s*>=\s*0/.test(s.cond||'');
const shredding=st=>st.units.some(u=>u.effects.some(e=>e.status==='Shredding'));
const hasAttackPart=s=>(s.parts||[]).some(p=>ATTACK_PART_TYPES.has(p.skillType)||(p.branches||[]).some(hasAttackPart));
const fixedUseLimit=s=>Array.isArray(s.uses)&&s.uses.length===1&&s.uses[0]<0;
function availableUses(st,i,s){
  const n=Array.isArray(s.uses)?Math.max(...s.uses.map(Math.abs)):s.uses;
  if(!(n>0)||fixedUseLimit(s))return n;
  const el=skillElement(s);
  return n+(el?st.ctx.party[i].equipment.skillCountUp?.[el]||0:0)+passiveCountUp(st,i);
}
const divaUse=(u,s)=>isEX(s)&&!fixedUseLimit(s)&&u.effects.some(e=>e.status==='Diva');
const limitablePart=p=>ATTACK_PART_TYPES.has(p.skillType)&&p.skillType!=='AttackNormal'&&p.skillType!=='FixedHpDamageRateAttack';
const hasLimitableAttack=s=>(s?.parts||[]).some(p=>limitablePart(p)||(p.branches||[]).some(hasLimitableAttack));
export const canLimitDamage=(member,skill)=>!!member?.damageLimiter&&!skill?.passive&&hasLimitableAttack(skill);

export function usableSkills(st,i,requested){
  const meta=st.ctx.party[i],u=st.units[i],out=[];
  if(u.down){if(requested)requested.reason='已被击倒';return out;}
  meta.skills.forEach((s,k)=>{
    const explain=requested?.k===k;
    if(s.consume&&s.consume!=='Sp'&&s.consume!=='Ep'){if(explain)requested.reason='未建模的耗费类型 '+s.consume;return;}
    if(s.passive){if(explain)requested.reason='被动技能不能作为行动选择';return;}
    if(s.special==='immersion'&&(u.reinforced||u.immPending)){if(explain)requested.reason='已选择沉浸或正在沉浸中';return;}
    const cost=effectiveCost(st,i,s),ep=s.consume==='Ep';
    if(!(cost<=(ep?u.ep:u.sp)||(!ep&&cost===0&&s.cond==='Sp()<0')||(!ep&&u.sp>=0&&(zeroSpOk(s)||shredding(st))))){
      if(explain)requested.reason=`${ep?'EP':'SP'}不足（现有 ${Math.round((ep?u.ep:u.sp)*10)/10}，需要 ${cost}）`;
      return;
    }
    const limit=availableUses(st,i,s);
    const used=u.uses[ROOT_LABEL(s)]||0;
    if(limit>0&&used>=limit&&!divaUse(u,s)&&!(s.useCond&&check(st,s.useCond,i,{}))){
      if(explain)requested.reason=`使用次数已用尽（已用 ${used} 次，上限 ${limit} 次）`;
      return;
    }
    if(s.cond&&!check(st,s.cond,i,{})){
      if(explain)requested.reason=s.cond.replace(/\s+/g,'')==='CountBC(IsPlayer()&&SpecialStatusCountByType(155)>=1)>=6'
        ?`需要 6 名山脇的小跟班，当前 ${st.units.filter(x=>x.effects.some(e=>e.status==='BIYamawakiServant')).length} 名`
        :'使用条件未满足（'+s.cond+'）';
      return;
    }
    out.push(k);
  });
  if(!meta.noNormal)out.push(NORMAL);
  return out;
}

export function act(st,i,k,target,limiter=false){
  const meta=st.ctx.party[i],u=st.units[i];
  if(limiter&&!canLimitDamage(meta,meta.skills[k]))throw Error('本次行动不具备伤害限制器开关');
  if(u.down){if(st.log)st.log.push({t:'down-skip',turn:st.turn,unit:i});return {};}
  const info={critMode:st.ctx.opt.critMode||'expected',target,limiter};
  let skill;
  if(k===NORMAL){
    skill={label:'Normal',name:'普通攻击',level:1,hitCount:1,parts:[{skillType:'AttackNormal',targetType:'Single'}]};
    info.normal=true;
    const replaced=normalReplacement(st,i),attack=replaced?.parts?.find(p=>ATTACK_PART_TYPES.has(p.skillType));
    if(attack){info.normalSkill={...replaced,level:1};info.normalPart=attack;}
    doAttack(st,i,skill,attack||skill.parts[0],info);
    addOd(st,R.NORMAL_ATTACK_HITS*Math.floor(R.OD_PER_HIT*100*(st.ctx.enemy.odRate??1))/100*st.odGainMult);
  }else if(meta.skills[k]?.special==='immersion'){
    // 选择沉浸：本次行动只做这件事，下次选择行动时进入沉浸状态（赋予的防御力上升/持续 DP 回复不影响输出，不建模）
    skill=meta.skills[k];u.immPending=skill.element;u.played++;
  }else{
    skill=meta.skills[k];
    const freeUse=(skill.useCond&&check(st,skill.useCond,i,{}))||(divaUse(u,skill)&&(u.uses[ROOT_LABEL(skill)]||0)>=availableUses(st,i,skill));
    const cost=effectiveCost(st,i,skill),ep=skill.consume==='Ep';
    if(ep)u.ep-=cost;else u.sp-=cost;
    info.sp=ep?0:cost;
    const label=ROOT_LABEL(skill);
    if(!freeUse)u.uses[label]=(u.uses[label]||0)+1;
    u.played++;
    // OD 量表技能部件吃 DRIVE 耳环（按 hit 数）
    const hitsForOd=hasAttackPart(skill)?Math.max(1,skill.hitCount||1):1;
    info.odMult=1+odEarring(meta.equipment.odEarringBonus,hitsForOd)/100;
    // EX 连发与白虎猛袭是两种状态；任一成立就执行两次，SP／EP 和使用次数只扣一次。
    const dbl=isEX(skill)&&u.effects.find(e=>e.type==='doubleAction'&&(e.uses==null||e.uses>0));
    const assault=hasAttackPart(skill)&&u.effects.some(e=>e.type==='byakkoDoubleAction');
    const reinforcedEx=u.reinforced&&(skill.parts||[]).some(p=>(p.skillType==='SkillCondition'||p.skillType==='SkillSwitch')&&/IsReinforcedMode/.test(p.cond||''));
    for(let t=0;t<(dbl||assault?2:1);t++){
      info.damageBeforeSkill=info.damage||0;
      if(info.talismanTargets)info.talismanTargets.clear();
      runParts(st,i,skill,info);
    }
    if(reinforcedEx)u.reinforced=null; // 用了在沉浸状态下性能变化的 EX 后解除沉浸
    if(info.consumeTokens)u.tokens=0; // 「消耗自己所有象徵」类
    if(st.cards?.size&&meta.role==='Breaker'&&isEX(skill)&&info.sp>=12)cardBreakerEx(st);
    // 遭遇战卡：Healer/Defender 放 EX → 全体 DP 回复 20%（可溢出至 150%）
    if(st.cards?.has('healerEx20')&&(meta.role==='Healer'||meta.role==='Defender')&&isEX(skill))
      st.units.forEach((x,k)=>healDp(st,k,0.2*st.ctx.party[k].dpMax,{value:[1.5]}));
    if(dbl){if(dbl.uses!=null)dbl.uses--;u.effects=u.effects.filter(e=>e.type!=='doubleAction'||e.uses==null||e.uses>0);}
  }
  firePassiveEvents(st,i,skill,info);
  if(k!==NORMAL&&!skill.special){
    const label=ROOT_LABEL(skill);u.playedSkills[label]=(u.playedSkills[label]||0)+1;
  }
  advanceTarget(st);
  if(!info.normal&&info.attacked&&st.units[i].front&&!(st.killedTurn&&st.enemy.hp<=0))followUp(st,i,skill,info);
  chargeTranscend(st,i);
  if(st.log)st.log.push({t:'act',turn:st.turn,round:st.round,unit:i,skill:skill.name||skill.label,label:skill.label,damage:Math.round(info.damage||0),
    sp:Math.round(u.sp*10)/10,ep:u.ep,od:Math.round(st.od*100)/100,dp:Math.round(st.enemy.dp.reduce((a,b)=>a+b,0)),hp:Math.round(st.enemy.hp),dr:Math.round(st.enemy.dr*1000)/10,
    crit:info.crit!=null?Math.round(info.crit*1000)/10:null,trans:st.trans?st.trans.gauge:null});
  return info;
}

// ---------------------------------------------------------------- 回合流程（Planner）

/**
 * 普通回合开始：全员 SP +2（已 ≥20 不加，SpLimitOverwrite 改上限）+ 回合开始被动；规则；被动 OD。
 * opt.withOd: 本回合在开始时发动 OD 的等级（turnStart 窗口）
 */
function normalReplacement(st,i){
  for(const p of st.ctx.party[i].passives){
    if(p.condition&&!check(st,p.condition,i,{}))continue;
    for(const part of p.parts||[])if(part.skillType==='ReplaceNormalSkill'&&(!part.cond||check(st,part.cond,i,{}))){
      const br=part.branches?.[0];if(br&&(!br.cond||check(st,br.cond,i,{})))return br;
    }
  }
  return null;
}
function pursuitReplacement(st,p){
  for(const passive of p.passives){
    if(passive.condition&&!check(st,passive.condition,p.i,{}))continue;
    for(const part of passive.parts||[])if(part.skillType==='ReplacePursuit'&&(!part.cond||check(st,part.cond,p.i,{}))){
      const br=part.branches?.[0];if(!br||br.cond&&!check(st,br.cond,p.i,{}))continue;
      const equipped=p.skills.find(s=>s.label===br.label);
      return {...br,level:equipped?.level||br.maxLevel||1};
    }
  }
  return null;
}
/** 追击：p=1 时完整执行替换追击；概率模式沿用期望 OD，不虚增特殊追击伤害与增益。 */
function followUp(st,actor,action,info){
  const rate=st.ctx.opt.followUpRate??R.FOLLOW_UP_RATE_DEFAULT;if(!(rate>0))return;
  const back=st.ctx.party.filter(p=>!st.units[p.i].front);
  if(rate===1)for(const p of back){
    const skill=pursuitReplacement(st,p);if(!skill)continue;
    const sub={critMode:st.ctx.opt.critMode||'expected',followUp:true,odMult:1};
    runParts(st,p.i,skill,sub);info.followUpDamage=(info.followUpDamage||0)+(sub.damage||0);
    return; // 一次行动最多一名成员追击一次
  }
  if(back.some(p=>pursuitReplacement(st,p)))flag(st,'approx','概率模式未计特殊追击伤害与增益（仅 p=1 精确）');
  const E=st.ctx.enemy,ordinary=back.filter(p=>p.followUpHits>0);if(!ordinary.length)return;
  const ok=p=>!((E.weaknesses.element.nonelemental??100)<100||(E.weaknesses.physical[String(p.attackType||'').toLowerCase()]??100)<100);
  const hits=ordinary.reduce((s,p)=>s+(ok(p)?p.followUpHits:0),0)/ordinary.length;
  addOd(st,rate*hits*R.OD_PER_HIT*(E.odRate??1)*st.odGainMult);
  flag(st,'approx','追击按期望 OD 计（概率 '+Math.round(rate*100)+'%，伤害不计）');
}
/** 被动「技能使用次数上限 +N」（SkillLimitCountUp，无属性限定的；属性版来自古代项链，见 equipment.skillCountUp）。 */
function passiveCountUp(st,i){let n=0;for(const u of st.ctx.party)for(const p of u.passives)for(const part of p.parts||[])
  if(part.skillType==='SkillLimitCountUp'&&!(part.elements||[]).length&&targetsOf(st,u.i,part).includes(i))n+=part.power?.[0]||0;return n;}
/** OD 发动消耗：被动「发动 OD 时量表消耗量 −X%」（ReduceConsumeOverDrive，取最大）。 */
export function odCost(st,level){let r=0;for(const u of st.ctx.party)for(const p of u.passives)for(const part of p.parts||[])if(part.skillType==='ReduceConsumeOverDrive')r=Math.max(r,part.power?.[0]||0);
  return R.OD_COST[level]*(1-r);}
/** 「沉浸」：选了沉浸之后的下一次选择行动时进入沉浸状态。 */
function enterImmersion(st,who){
  for(const u of st.units)if(u.immPending&&(!who||who.includes(u.i))){
    u.reinforced=u.immPending;u.immPending=null;
    flag(st,'approx','成濑已进入沉浸：防御上升与持续 DP 回复未建模');
  }
}
function firePreTurnSkills(st){
  for(const u of st.units){
    if(u.down)continue;
    for(const e of u.effects){
      if(e.type!=='preTurnSkill'||e.uses===0||e.grantedTurn>=st.turn)continue;
      if(e.condition&&!check(st,e.condition,u.i,{}))continue;
      const info={};
      if(e.uses!=null)e.uses--;
      runParts(st,u.i,e.triggered,info);
      firePassiveEvents(st,u.i,e.triggered,info);
      if(st.log)st.log.push({t:'autoSkill',turn:st.turn,unit:u.i,skill:e.triggered.name,label:e.skillLabel,remaining:e.uses});
    }
    if(u.effects.some(e=>e.type==='preTurnSkill'&&e.uses===0))u.effects=u.effects.filter(e=>e.type!=='preTurnSkill'||e.uses!==0);
  }
}

export function startTurn(st){
  enterImmersion(st);
  st.turn++;st.turnDamage[st.turn]=0;st.round='main';st.odGainMult=1+(st.mods.odGain||0);
  if(st.hasPreTurnSkills)firePreTurnSkills(st);
  const venom=enemyStatus(st,'Venom');
  if(venom&&st.turn>(venom.bornTurn??0)){
    directEnemyDamage(st,187500*(venom.level||0)); // 125000～250000 的区间中点；固定突伤害
    venom.statDown=(venom.statDown||0)+2*(venom.level||0);
  }
  for(const u of st.units){
    const cap=spLimit(st,u.i)??R.SP_CAP;
    const makeup=u.effects.find(e=>e.status==='Makeup');
    if(makeup)healDp(st,u.i,makeup.size*st.ctx.party[u.i].dpMax,{value:[makeup.cap]});
    if(u.sp<cap)u.sp=Math.min(cap,u.sp+R.SP_PER_TURN);
    if(u.spSetNext!=null){u.sp=Math.max(u.sp,u.spSetNext);u.spSetNext=null;} // SpecifySp：下回合开始时 SP 回复至 N
    for(const e of u.effects)if(e.type==='regen')healDp(st,u.i,e.size,null); // 持续性 DP 回复
    cardTurnStartUnit(st,u); // 遭遇战卡：领域 SP+3、DP 溢出者 SP+5、2 名 Breaker SP+3
    // 属性の印 Lv6：回合开始时在前卫则自身 SP +1（与回合回复同受 20 上限，推定）
    const mk=markOf(st,u.i);
    if(mk&&mk.level>=R.MARK_EFFECT.spPerTurn&&u.front&&u.sp<cap){u.sp=Math.min(cap,u.sp+R.MARK_VALUES.spPerTurn);flag(st,'approx','属性の印 Lv6 SP+1 按受 20 上限');}
    if(st.territory?.name==='SummersEndTerritory'){
      healSp(st,u.i,1,null);
      healDp(st,u.i,0.07*st.ctx.party[u.i].dpMax,{value:[1.2]});
    }
  }
  if(st.cards?.has('dp120Disaster2')){const n=st.units.filter(u=>dpRatio(st,u.i)>=1.2).length;if(n)forEachEnemy(st,es=>raiseDisaster(es,2*n));}
  applyRules(st,'OnEveryTurn');
  firePassives(st,'normalTurnStart');
}

/** 发动 OD（level 1–3）：扣量表；首轮全员 SP +5/+12/+20（不受 20 上限）；OnOverdriveStart 被动。window='turnStart'|'turnEnd' */
export function startOverdrive(st,level,window='turnStart'){
  const cost=odCost(st,level);
  if(level<=0||st.od<cost||level<(st.mods.minOd||1)||st.odRounds>0)return false;
  st.od=Math.max(0,round2(st.od-cost));st.odLevel=level;st.odRounds=R.OD_ROUNDS[level];st.odWindow=window;st.round='od';
  for(const u of st.units)u.sp+=R.OD_SP[level];
  if(window==='turnEnd'){enterImmersion(st);firePassives(st,'playerTurnStart');} // 回合结束型 OD 的首轮算一次“我方回合开始”（非普通回合）
  firePassives(st,'overdriveStart');
  if(st.log)st.log.push({t:'od',turn:st.turn,level,window});
  return true;
}

function clearOverdrive(st){
  st.odRounds=0;st.odLevel=0;
  for(const u of st.units){u.effects=u.effects.filter(e=>!e.odEnd);u.ep=Math.min(u.ep,epLimit(st,u.i));}
}
/** 一个 OD 行动轮结束：回合数类效果 −1（OD 轮各算一回合，Planner Wi）；最后一轮结束清 OverDriveEnd 效果。 */
export function endOdRound(st){
  // 每个 OD 轮各算一回合；回合开始型 OD 的最后一轮不计（之后的普通轮计，Planner Wi）
  if(!(st.odRounds===1&&st.odWindow==='turnStart'))tickTurns(st,null);
  st.odRounds--;
  if(st.odRounds<=0){
    clearOverdrive(st);
    st.round=st.odWindow==='turnEnd'?'end':'main';
  }else if(!st.killedTurn){
    st.round='od';enterImmersion(st);
    firePassives(st,'playerTurnStart');
  }
}

/** 追加回合：只有获得追加回合的成员行动；不加 SP；结束时只有这些成员身上的回合数效果 −1。 */
export function pendingExtra(st){return st.units.filter(u=>u.extra>0).map(u=>u.i);}
export function startExtraTurn(st){
  enterImmersion(st,pendingExtra(st));
  st.round='extra';
  firePassives(st,'additionalTurnStart',(p,u)=>st.units[u.i].extra>0);
  firePassives(st,'playerTurnStart',(p,u)=>st.units[u.i].extra>0);
}
export function endExtraTurn(st,who){
  tickTurns(st,new Set(who));
  for(const i of who)st.units[i].extra=0;
  st.round='main';
}

/** 我方行动结束 → 敌方行动 → 回合数效果 −1、仅本轮效果清除。skipTick: 本回合后接 turnEnd 型 OD 时由 OD 轮负责计时。 */
export function endPlayerTurn(st,{skipTick=false}={}){
  if(!skipTick)tickTurns(st,null);
  if(!st.killedTurn){
    for(const u of st.units)if(u.effects.some(e=>e.type==='eaGuard'))u.guardReady=u.dp>=2;
    firePassives(st,'enemyTurnStart',(p,u)=>!st.units[u.i].down&&p.parts?.length&&p.parts.every(part=>part.skillType==='DefenseUp'));
    enemyAct(st);
  }
  if(st.queue&&!st.killedTurn)for(const q of st.queue)if(!q.dead&&q.state!==st.enemy)enemyActAs(st,q.enemy,q.state);
  // “敌方回合结束”计时的我方效果（防御上升、挑衅、敌方施加的被伤增加）在敌人行动后才扣
  st.units.forEach(endEnemyTurnEffects);
  forEachEnemy(st,es=>{
    endEnemyTurnEffects(es);
    const seal=es.effects.find(e=>e.status==='Talisman');
    if(seal)seal.level=0;
  });
  st.round='end';
}

function endEnemyTurnEffects(target){
  if(target.breakDownTurns>0)target.breakDownTurns--;
  if(!target.effects.some(e=>e.enemyEnd&&e.turns!=null))return;
  for(const e of target.effects)if(e.enemyEnd&&e.turns!=null)e.turns--;
  target.effects=target.effects.filter(e=>!e.enemyEnd||e.turns==null||e.turns>0);
}

function tickTurns(st,only){
  const tick=list=>list.filter(e=>!e.currentOnly).map(e=>{if(!e.enemyEnd&&e.turns!=null&&(!only||only.has(e.owner)||only.has(e.target)))e.turns--;return e;}).filter(e=>e.turns==null||e.turns>0);
  for(const u of st.units){
    u.effects=u.effects.filter(e=>!e.currentOnly).map(e=>{if(e.turns!=null&&!e.enemyEnd&&(!only||only.has(u.i)))e.turns--;return e;}).filter(e=>e.turns==null||e.turns>0);
  }
  if(!only){
    forEachEnemy(st,enemy=>{enemy.effects=tick(enemy.effects);});
    if(st.field&&st.field.turns!=null&&--st.field.turns<=0)st.field=null;
  }
}

// ---------------------------------------------------------------- 敌方

// ---------------------------------------------------------------- 我方 DP / HP（2026-11-09）
// 受击公式按 HBR Toolbox「受击伤害计算」：能力差 p = 敌方能力值 − 我方加权（体/精，按技能参数）；
//   p ≥ 上限 → max；0 ≤ p < 上限 → min+(max−min)·p/上限；−上限 ≤ p < 0 → min+(min−1)·p/上限；否则 1。
//   伤害 = 威力 × 攻击率 ×(1+敌方攻击上升)×(1+我方被伤增加)×(1−防御上升)×(1−被动防御)×(印 Lv2 0.9)× 浮动。DP 先扣，DP 0 后扣 HP，HP 0 战斗不能。
function enemyAttackPower(part,stats,border){
  const [mn,mx]=part.power||[0,0],lim=part.diffForMax||0;
  const w=part.parameters||{},tw=Object.values(w).reduce((a,b)=>a+(b||0),0)||1;
  const def=Object.entries(w).reduce((a,[k,v])=>a+(stats[k]||0)*(v||0),0)/tw;
  const p=border-def;
  if(!lim)return mx;
  if(p>=lim)return mx;
  if(p>=0)return mn+(mx-mn)*p/lim;
  if(p>=-lim)return Math.max(1,mn+(mn-1)*p/lim);
  return 1;
}
function enemyTargets(st,part){
  const alive=st.units.filter(u=>u.front&&!u.down);
  if(!alive.length)return [];
  const tt=part.targetType||'Single';
  const all=tt==='All'||tt==='AllyAll'||tt==='AllyFront';
  const focus=st.enemy.effects.findLast(e=>(e.type==='cover'||(!all&&e.type==='provoke'))&&alive.some(u=>u.i===e.owner));
  if(focus)return [focus.owner];
  if(all)return alive.map(u=>u.i);
  // 单体目标：游戏里随机。opt.enemyTargeting='spread' 按期望平均分摊到存活前卫；缺省 'worst' 取“剩余 DP+HP 比例最低”的前卫（保守）
  if(st.ctx.opt.enemyTargeting==='spread'){flag(st,'approx','敌方单体攻击按期望平均分摊');return alive.map(u=>u.i);}
  if(st.ctx.opt.enemyTargeting==='random'&&st.ctx.opt.rng)return [alive[Math.floor(st.ctx.opt.rng()*alive.length)].i];
  flag(st,'approx','敌方单体攻击按最危险目标（剩余比例最低）');
  const ratio=u=>{const m=st.ctx.party[u.i];return m.dpMax+m.hpMax>0?(u.dp+u.hp)/(m.dpMax+m.hpMax):1;};
  return [alive.sort((a,b)=>ratio(a)-ratio(b))[0].i];
}
const SINGLE_ENEMY_HIT=[1];
function enemyHitRatios(st,part,sk){
  const stated=sk?.hitCount,hasCount=Number.isInteger(stated)&&stated>0;
  for(const ratios of [part.hitRatios,sk?.hitRatios]){
    if(!ratios?.length||(hasCount&&ratios.length!==stated))continue;
    if(ratios.every(v=>Number.isFinite(v)&&v>=0)&&Math.abs(ratios.reduce((sum,v)=>sum+v,0)-1)<1e-6)return ratios;
  }
  if(hasCount&&stated===1)return SINGLE_ENEMY_HIT;
  if(!hasCount){flag(st,'approx','敌方攻击缺少段数，暂按单段');return SINGLE_ENEMY_HIT;}
  flag(st,'approx','敌方多段攻击缺少完整权重，按已知段数均分');
  return Array(stated).fill(1/stated);
}
function enemyAttack(st,part,sk){
  const E=st.ctx.enemy,mult=(E.atkRate??100)/100*(1+st.enemy.effects.filter(e=>e.type==='enemyAttackUp').reduce((a,e)=>a+e.size,0)/100);
  const vary=st.ctx.opt.enemyVariance==='random'&&st.ctx.opt.rng?0.9+0.2*st.ctx.opt.rng():st.ctx.opt.enemyVariance??1.1;
  const tt=part.targetType||'Single',targets=enemyTargets(st,part);
  const ratios=enemyHitRatios(st,part,sk);
  const share=st.ctx.opt.enemyTargeting==='spread'&&!(tt==='All'||tt==='AllyAll'||tt==='AllyFront')&&targets.length>1?1/targets.length:1;
  for(const i of targets){
    const u=st.units[i],m=st.ctx.party[i];if(!(m.dpMax>0)){flag(st,'approx','有成员缺 DP/HP 面板，不计受伤');continue;}
    const immunity=u.effects.find(e=>e.type==='invincible'),dodge=u.effects.find(e=>e.type==='dodge');
    if(immunity){useDefenseCharge(u,immunity);continue;}
    if(dodge){
      useDefenseCharge(u,dodge);
      if(st.ctx.opt.rng){if(st.ctx.opt.rng()<dodge.size)continue;}
      else flag(st,'approx','确定性预估按回避未触发');
    }
    const stats=memberStats(st,i);
    // 遭遇战卡「冰光暗领域中 敌方行动时全体防御 +30%（1 回合）」：按另加 30% 计（不与技能防御上升抢槽，推定）
    const zoneDef=st.cards?.has('zoneDef30')&&st.field&&CARD_ZONE.includes(st.field.element)?30:0;
    const def=Math.min(0.9,(sumSize(slotSelect(u.effects.filter(e=>!e.passive),'defenseUp',2))+zoneDef)/100);
    const pdef=Math.min(0.9,u.effects.filter(e=>e.type==='defenseUp'&&e.passive).reduce((a,e)=>a+e.size,0)/100);
    const taken=u.effects.filter(e=>e.type==='takenUp').reduce((a,e)=>a+e.size,0)/100;
    const mk=markOf(st,i),markCut=mk&&mk.level>=R.MARK_EFFECT.damageTaken?0.9:1;
    const dmg=part.skillType==='AttackFixedDamageDefinitely'?(part.power?.[0]||0)
      :enemyAttackPower(part,stats,Math.max(0,E.border-enemyParamDown(st)))*mult*(1+taken)*(1-def)*(1-pdef)*markCut*vary*share;
    const cover=targets.length===1&&['All','AllyAll','AllyFront'].includes(tt)&&st.enemy.effects.some(e=>e.type==='cover'&&e.owner===i);
    const covered=cover?st.units.filter(v=>v.front&&!v.down).length:1;
    damageAlly(st,i,dmg*covered,sk,ratios);
    // 次数型防御上升（遭遇战卡「防御力 +50%（2 次）」）：每受一次攻击消耗 1 次
    if(u.effects.some(e=>e.hitUses)){for(const e of u.effects)if(e.hitUses&&e.uses>0)e.uses--;u.effects=u.effects.filter(e=>!e.hitUses||e.uses>0);}
  }
}
function useDefenseCharge(unit,effect){
  if(--effect.uses<=0)unit.effects=unit.effects.filter(e=>e!==effect);
}
function damageAlly(st,i,amount,sk,ratios){
  const u=st.units[i];if(u.down||!(amount>0))return;
  const beforeDp=u.dp,beforeHp=u.hp;
  const guard=u.guardReady&&u.effects.find(e=>e.type==='eaGuard');
  // 我方有 DP 时本段只扣 DP；破盾后的后续段才扣 HP。固定伤害同样按段结算。
  for(const ratio of ratios){
    const hit=amount*ratio;
    if(u.dp>0){
      u.dp=Math.max(0,u.dp-hit);
      if(u.dp<1e-8){
        if(guard){u.dp=1;useDefenseCharge(u,guard);break;}
        u.dp=0;u.dpBroken=true;u.effects=u.effects.filter(e=>e.status!=='Makeup');
        if(st.log)st.log.push({t:'dpBreak',turn:st.turn,unit:i});
      }
    }else u.hp=Math.max(0,u.hp-hit);
    if(!u.hp)break;
  }
  if(u.dp<beforeDp||u.hp<beforeHp)for(const ally of st.units){
    const revenge=ally.effects.find(e=>e.status==='Revenge');
    if(revenge)revenge.level=Math.min(10,revenge.level+1);
  }
  if(st.log)st.log.push({t:'hurt',turn:st.turn,unit:i,amount:Math.round(amount),dpLost:Math.round(beforeDp-u.dp),hpLost:Math.round(beforeHp-u.hp),dp:Math.round(u.dp),hp:Math.round(u.hp),skill:sk?.name||sk?.label});
  // 失败判定：任何一名成员 HP 清零即战斗失败（用户 2026-11-09 说明）
  if(u.hp<=0){u.down=true;if(st.log)st.log.push({t:'down',turn:st.turn,unit:i});if(!st.wiped)st.wiped=st.turn;}
}
/** 回复量：回復能力 min–max 按施放者加权能力插值（与增益效果量同一曲线），技能等级成长按 powerTable。 */
function healAmount(st,actor,skill,part,info){
  const tbl=powerTable(part,skill),lv=Math.min(skill.level||1,tbl.min.length);
  const mn=tbl.min[lv-1]??0,mx=tbl.max[lv-1]??mn,lim=part.diffForMax||0;
  const multiplier=1+actionPassiveAmount(st,actor,'GiveHealUp',info)/100;
  if(!lim||!part.parameters)return mx*multiplier;
  const a=weightedStatOf(part.parameters,memberStats(st,actor));
  return (a>lim?mx+(a-lim)*R.BUFF_OVER_LIMIT_SLOPE*mx:mn+(mx-mn)*Math.max(0,a)/lim)*multiplier;
}
function weightedStatOf(p,stats){const t=Object.values(p).reduce((a,b)=>a+(b||0),0);return t?Object.entries(p).reduce((a,[k,v])=>a+(stats[k]||0)*(v||0),0)/t:0;}
function healDp(st,i,amount,part){
  const u=st.units[i],m=st.ctx.party[i];if(u.down||u.dpBroken||!(m.dpMax>0))return; // 倒下（DP 0）时普通回复无效
  const cap=m.dpMax*Math.max(1,part?.value?.[0]>1&&part.value[0]<=2?part.value[0]:1);
  amount*=1+(st.mods.healUp||0)/100;
  if(amount>0&&u.dp<cap)u.dp=Math.min(cap,u.dp+amount);
}
/** 防御上升效果量：主数据 power 为 min/max，按施放者能力插值；被动常驻值取 power[0]。 */
function defenseSize(st,actor,skill,part){
  const [mn,mx]=part.power||[0,0];
  if(!mx||!part.parameters||!part.diffForMax)return (mx||mn)*100;
  const a=weightedStatOf(part.parameters,memberStats(st,actor));
  return Math.min(mx,mn+(mx-mn)*Math.max(0,a)/part.diffForMax)*100;
}

/**
 * 设定一个阶段的敌人队列（遭遇战等多敌阶段）：依次作为目标，其余存活敌人照常行动；全体攻击溅射到其余敌人。
 * 当前目标被击破后 advanceTarget 切到下一个；全部击破时 st.killedTurn 保留（阶段完成）。
 */
export function setPhase(st,enemies){
  const nextBattle=st.killedTurn>0;
  // Encounter battles reset first-use bonuses and progressive skills but carry remaining charges.
  if(nextBattle)for(const u of st.units)u.playedSkills={};
  if(nextBattle&&st.odRounds>0){
    // The remaining gauge carries over. Until unused rounds are verified in
    // game, a new encounter does not grant free actions, SP, or turn ticks.
    clearOverdrive(st);st.odWindow=null;st.round='start';
    flag(st,'approx','跨阶段剩余 OD 回合尚未实测，当前不额外计行动');
  }
  // On the first binding, initialState has already resolved the opener against
  // the primary enemy. Preserve its effects as well as the party's resources.
  const firstState=!nextBattle&&st.turn===0&&st.ctx.enemy.label===enemies[0].label?st.enemy:null;
  st.queue=enemies.map((e,i)=>({enemy:e,state:i===0&&firstState?firstState:freshEnemyState(e),dead:false}));
  if(firstState)for(const q of st.queue.slice(1))for(const effect of firstState.effects)if(effect.openingAll)addEffect(q.state.effects,{...effect});
  st.qi=0;st.killedTurn=0;st.phaseShownStart=st.shownDamage||0;st.phaseDamageStart=st.totalDamage||0;focusTarget(st);
  if(st.cards?.size)cardBattleStart(st);
  if(nextBattle)firePassives(st,'battleStart',p=>p.timing==='OnBattleStart');
}

// ---------------------------------------------------------------- 遭遇战战术卡钩子（卡片定义见 ../cards.mjs）
const CARD_ZONE=['ice','light','dark'];
/** DP 比例（DP 已破 = 0）。“DP 突破上限” = 比例 > 1。 */
function dpRatio(st,i){const m=st.ctx.party[i],u=st.units[i];return m.dpMax>0&&!u.dpBroken&&!u.down?u.dp/m.dpMax:0;}
/** 对阶段内全部存活敌人（无队列时只有当前目标）执行。 */
function forEachEnemy(st,f){if(st.queue){for(const q of st.queue)if(!q.dead)f(q.state);}else f(st.enemy);}
function raiseDisaster(es,delta){
  let e=es.effects.find(x=>x.status==='Disaster');
  if(!e){e={type:'status',status:'Disaster',level:0,size:0,src:'card',owner:0,uses:null,turns:null,currentOnly:false,id:++effSeq};es.effects.push(e);}
  e.level=Math.min(99,(e.level||0)+delta);e.size=e.level;
}
function cardFieldSet(st){
  if(st.cards?.has('fieldMorale3'))for(const u of st.units)u.morale=Math.min(R.MORALE_TOKEN_STACK_MAX,(u.morale||0)+3);
  if(st.cards?.has('fieldOd30'))addOd(st,30);
}
function cardTurnStartUnit(st,u){
  if(!st.cards?.size)return;
  if(st.cards.has('fieldSp3')&&st.field&&CARD_ZONE.includes(st.field.element))healSp(st,u.i,3,null);
  if(st.cards.has('dpOverSp5')&&dpRatio(st,u.i)>1)healSp(st,u.i,5,null);
  if(st.cards.has('breakerSp3')&&st.ctx.party.filter(m=>m.role==='Breaker').length>=2)healSp(st,u.i,3,null);
}
function cardBattleStart(st){
  const c=st.cards;
  if(c.has('dpOverOd10')){const n=st.units.filter(u=>dpRatio(st,u.i)>1).length;if(n)addOd(st,10*n);}
  if(c.has('dp120All50')){
    for(const u of st.units)u.effects=u.effects.filter(e=>e.src!=='card:dp120All50');
    if(st.units.filter(u=>dpRatio(st,u.i)>=1.2).length>=4)for(const u of st.units)u.effects.push({type:'statUp',stat:'all',size:50,passive:true,uses:null,turns:null,currentOnly:false,src:'card:dp120All50',id:++effSeq});
  }
  if(c.has('breakerUndermine')&&st.ctx.party.filter(m=>m.role==='Breaker').length>=2){
    forEachEnemy(st,es=>{if(!es.effects.some(e=>e.status==='Undermine'&&e.src==='card'))es.effects.push({type:'status',status:'Undermine',size:100,src:'card',owner:0,uses:null,turns:null,currentOnly:false,id:++effSeq});});
    flag(st,'approx','战术卡「敌全体蝕」只记状态，未计伤害');
  }
}
const BREAKER_EX_EFFECTS=[['breakerAtk200','attackUp',200],['breakerCrit100','critDamageUp',100]];
function cardBreakerEx(st){
  // MasterSkillPart puts the five-use limit on AdditionalHitOnExtraSkillAll.
  // Each triggered child effect is Eternal, and belongs to the whole party.
  for(const [card,type,size] of BREAKER_EX_EFFECTS){
    if(!st.cards.has(card))continue;
    const src='card:'+card,count=st.passiveCount[src]||0;
    if(count>=5)continue;
    st.passiveCount[src]=count+1;
    for(const u of st.units)u.effects.push({type,size,passive:true,uses:null,turns:null,currentOnly:false,src});
  }
}
function cardBreak(st){
  const c=st.cards;if(!c?.size)return;
  if(c.has('breakerOd30'))addOd(st,30);
  if(c.has('breakerBreakDef50'))forEachEnemy(st,es=>{if(!es.effects.some(e=>e.src==='card:breakDef50'))es.effects.push({type:'defenseDown',size:50,passive:true,permanent:true,src:'card:breakDef50',turns:null,uses:null,currentOnly:false,id:++effSeq});});
  if(c.has('breakerBreakDp30'))st.units.forEach((u,k)=>healDp(st,k,0.3*st.ctx.party[k].dpMax,{value:[1.8]}));
}
/** 行动开始时判定的卡：暴击率、领域同属性技能攻击/暴伤、DP 溢出技能攻击。 */
function cardMods(st,actor,el,info,mods){
  const c=st.cards;
  if(c.has('critRate100'))mods.passiveCritRateUp+=100;
  const zone=st.field&&CARD_ZONE.includes(st.field.element)&&st.field.element===el;
  if(zone&&c.has('zoneAtk300')&&!info.normal)mods.passiveAttackUp+=300;
  if(zone&&c.has('zoneCrit100'))mods.passiveCritDamageUp+=100;
  if(!info.normal){
    if(c.has('dpOverAtk500')&&dpRatio(st,actor)>1)mods.passiveAttackUp+=500;
    if(c.has('dp150Atk200')){const n=st.units.filter(u=>dpRatio(st,u.i)>=1.5).length;mods.passiveAttackUp+=200*n;}
  }
}
function focusTarget(st){
  const q=st.queue[st.qi],alive=st.queue.filter(x=>!x.dead).length;
  st.ctx={...st.ctx,enemy:{...q.enemy,others:Math.max(0,alive-1)}};st.enemy=q.state;
}
function advanceTarget(st){
  if(!st.queue||st.enemy.hp>0)return;
  const cur=st.queue[st.qi];if(!cur.dead){cur.dead=true;if(st.log)st.log.push({t:'kill',turn:st.turn,name:cur.enemy.name});}
  const next=st.queue.findIndex(x=>!x.dead);
  if(next<0)return; // 阶段全部击破
  st.qi=next;st.killedTurn=0;focusTarget(st);
}
/** 敌方状态（DP 槽、HP、破坏率、行动指针）。遭遇战换目标时用。 */
export function freshEnemyState(enemy){
  return {dp:enemy.dp.slice(),hp:enemy.hp,dr:enemy.initialDestruction||1,broken:!enemy.dp.some(x=>x>0),breakDownTurns:0,effects:[],ptr:{dp:0,hp:0},once:{}};
}
function onEnemyBreak(st,model,state){
  state.broken=true;
  const raw=model.breakDownSetting;
  if(!Number.isFinite(raw)||raw<0)return;
  // Standard enemies use 0 for the normal break window. Negative values suppress down.
  state.breakDownTurns=Math.max(1,raw);
  if(raw>0)flag(st,'approx','特殊敌人倒下时长按主数据正值，待对局核对');
  const extension=Math.max(0,...st.ctx.party.flatMap(m=>m.passives.flatMap(p=>{
    if(!p.parts?.some(q=>q.skillType==='AdditionalHitOnBreaking'&&q.targetType==='AllyAll'))return [];
    return p.parts.filter(q=>q.skillType==='BreakDownTurnUp').map(q=>q.power?.[0]||0);
  })));
  state.breakDownTurns+=extension;
}
/** 以另一个敌人的身份行动（遭遇战同阶段的其余存活敌人）。 */
export function enemyActAs(st,enemy,state){
  const keepE=st.ctx.enemy,keepS=st.enemy;
  st.ctx={...st.ctx,enemy};st.enemy=state;
  try{enemyAct(st);}finally{st.ctx={...st.ctx,enemy:keepE};st.enemy=keepS;}
}
function enemyAct(st){
  if(st.enemy.breakDownTurns>0)return;
  const E=st.ctx.enemy,en=st.enemy,phase=en.broken&&E.pattern.hp?'hp':'dp';
  const pat=E.pattern[phase];
  if(!pat?.entries?.length)return;
  const orders=[...new Set(pat.entries.filter(x=>!x.preemptive).map(x=>x.order))].sort((a,b)=>a-b);
  if(!orders.length)return;
  let guard=0,entry=null;
  while(guard++<orders.length*2){
    const o=orders[en.ptr[phase]%orders.length];en.ptr[phase]++;
    const cands=pat.entries.filter(x=>x.order===o&&!x.preemptive&&!(x.once&&en.once[phase+o]));
    if(!cands.length)continue;
    entry=cands.sort((a,b)=>(b.weight||0)-(a.weight||0))[0];
    if(cands.length>1||entry.condition)flag(st,'approx','敌方行动有权重/条件分支');
    if(entry.once)en.once[phase+o]=1;
    break;
  }
  if(!entry)return;
  for(const sid of entry.skills||[]){
    const sk=E.skills.find(s=>s.id===sid);if(!sk)continue;
    for(const p of sk.parts||[])enemyPart(st,p,sk);
    if(st.log)st.log.push({t:'enemy',turn:st.turn,skill:sk.name||sk.label});
  }
}
function enemyPart(st,p,sk){
  const t=p.skillType;
  if(t==='AttackSkill'||t==='AttackFixedDamageDefinitely'){enemyAttack(st,p,sk);return;}
  if(t==='AttackUp'){st.enemy.effects.push({type:'enemyAttackUp',size:(p.power?.[0]||0)*100,...duration(p)});return;}
  if(t==='DefenseDown'&&(p.targetType||'').startsWith('Single')||t==='DefenseDown'&&p.targetType==='All'){
    for(const i of enemyTargets(st,p))addEffect(st.units[i].effects,{type:'takenUp',size:(p.power?.[1]||p.power?.[0]||0)*100,src:sk?.label,owner:-1,enemyEnd:true,...duration(p)});return;}
  if(t==='DefenseUp')st.ctx.enemy.damageReductionPercent=(st.ctx.enemy.damageReductionPercent||0); // 敌方防御上升未建模为减伤（计算器需手填）
  if(t==='OverDrivePointDown')st.od=Math.max(0,st.od-(p.power?.[0]||0)*100);
  else if(t==='DamageSp'||t==='SpecifySpDamage'){for(const u of st.units.filter(x=>x.front))u.sp=t==='SpecifySpDamage'?Math.min(u.sp,p.power?.[0]||0):Math.max(0,u.sp-(p.power?.[0]||0));}
  else if(t==='DamageRateValueDown')st.enemy.dr=Math.max(1,st.enemy.dr-(p.power?.[0]||0));
  else if(t==='RemoveSpecialStatus'){/* 解除我方增益：未建模 */flag(st,'approx','敌方解除增益未模拟');}
  else if(!['AttackSkill','AttackFixedDamageDefinitely','Nothing','AttackUp','ChargeStep','Charge','HealDpRate','HealDp','DefenseUp'].includes(t))flag(st,'approx','敌方效果未模拟:'+t);
}

// ---------------------------------------------------------------- 场景规则

function applyRules(st,timing){
  for(const r of st.ctx.enemy.rules||[]){
    const timings=r.timing||[];
    if(timing==='OnBattleStart'&&!(timings.includes('OnBattleStart')||timings.includes('OnFirstBattleStart')))continue;
    if(timing==='OnEveryTurn'){
      if(!timings.includes('OnEveryTurn'))continue;
      const iv=Math.max(1,r.interval||1),term=r.term>0?r.term:99;
      const first=iv===1?1:iv;
      if(st.turn<first||(st.turn-first)%iv!==0||Math.floor((st.turn-first)/iv)>=term)continue;
    }
    // 遭遇战等“对我方成员施加技能部件”的规则（SkillPart / Member）
    if(r.type==='SkillPart'&&r.target==='Member'){
      const sk={label:'rule'+r.id,name:r.name,level:1,maxLevel:1,parts:r.parts||[]};
      for(const p of r.parts||[]){const v=p.power?.[0]||0;
        if(p.skillType==='ZoneUpEternal')st.mods.zoneRule=(st.mods.zoneRule||0)+v*100;   // 领域效果量 +X% 且永续
        else if(p.skillType==='HealUp')st.mods.healUp=(st.mods.healUp||0)+v*100;        // DP 回复量 +X%
        else applyPart(st,0,sk,p,{passive:true});}
      continue;
    }
    for(const p of r.parts||[]){
      const v=p.power?.[0]||0;
      switch(p.skillType){
        case 'DefenseDown':
          if(r.target==='Enemy'||!r.target)addEffect(st.enemy.effects,{type:'defenseDown',size:v*100,passive:true,permanent:true,src:'rule'+r.id,turns:null,uses:null});
          break;
        case 'DamageRateResistUp':st.ctx.enemy.devastationResistancePercent=(st.ctx.enemy.devastationResistancePercent||0)+v*100;break;
        case 'OverDriveRateUp':st.mods.odGain=(st.mods.odGain||0)+v;break;
        case 'SpecifySpDamage':for(const u of st.units)if(u.front)u.sp=Math.min(u.sp,v);break;
        case 'AttackUp':case 'HealDown':break;
        default:flag(st,'approx','规则效果未模拟:'+p.skillType);
      }
    }
  }
}

// ---------------------------------------------------------------- 汇总

export function bestTurnDamage(st){return Math.max(0,...st.turnDamage);}

export function stateKey(st){
  const effectKey=e=>[e.type,e.status||'',e.element||'',e.skillLabel||'',Math.round((e.size||0)*100),e.level||0,Math.round(e.damage||0),e.statDown||0,e.uses??'',e.turns??'',e.limitType||'',e.src||''].join('~');
  const counts=x=>Object.entries(x||{}).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+v).join(',');
  const uses=x=>counts(x.uses)+':'+counts(x.playedSkills);
  const u=st.units.map(x=>`${Math.round(x.sp*2)}|${x.ep}|${x.front?1:0}|${x.reinforced||''}${x.immPending||''}|${x.extra}|${x.tokens}|${x.morale}|${x.commandRemaining||0}|${uses(x)}|${x.effects.map(effectKey).sort().join(',')}`).join('/');
  const down=st.queue?st.queue.map(q=>q.state.breakDownTurns||0).join(','):st.enemy.breakDownTurns||0;
  const e=`${Math.round(st.enemy.dp.reduce((a,b)=>a+b,0)/1000)}|${Math.round(st.enemy.hp/1000)}|${Math.round(st.enemy.dr*100)}|${st.enemy.ptr.dp},${st.enemy.ptr.hp}|${down}|${st.enemy.effects.map(effectKey).sort().join(',')}`;
  const pc=Object.entries(st.passiveCount).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+v).join(',');
  const ed=st.ctx.opt.teamElement?JSON.stringify(st.skillDamageByElement):'';
  const field=st.field?[st.field.element,st.field.size,st.field.owner,st.field.turns,st.field.fromActiveSkill].join('~'):'';
  return `${st.turn}:${st.round}:${st.odLevel}:${st.odRounds}:${st.acted}:${Math.round(st.od)}:${st.trans?st.trans.gauge+(st.trans.active?'!':''):''}:${field}:${st.territory?st.territory.name+(st.territory.active?'!':''):''}:${Math.round(bestTurnDamage(st)/1000)}:${pc}:${u}:${e}:${ed}`;
}

// ---------------------------------------------------------------- 伤害计算器用

/** 只施加技能里的增益/减益等非攻击部件（伤害计算器“预先施加”用），不扣 SP、不计次数。 */
export function applyEffectsOnly(st,i,k){
  const skill=st.ctx.party[i].skills[k];if(!skill)return;
  const info={sp:skill.consume==='Ep'?0:effectiveCost(st,i,skill)};
  const flat=s=>(s.parts||[]).flatMap(p=>(p.skillType==='SkillCondition'||p.skillType==='SkillSwitch')?[p]:[p]);
  for(const p of flat(skill)){
    if(ATTACK_PART_TYPES.has(p.skillType))continue;
    if(p.skillType==='SkillCondition'||p.skillType==='SkillSwitch'||p.skillType==='SkillRandom'){
      const pick=p.skillType==='SkillRandom'?randomBranch(st,i,skill,p,true):selectedBranch(st,i,skill,p,info);
      if(pick)for(const q of pick.parts||[])if(!ATTACK_PART_TYPES.has(q.skillType))applyPart(st,i,{...pick,level:skill.level},q,info);
      continue;
    }
    applyPart(st,i,skill,p,info);
  }
}

/** 预览一次攻击：返回 computeAttack 的完整结果与所用加成（不改变状态）。 */
export function previewAttack(st,i,k,{level}={}){
  const m=st.ctx.party[i],skill=m.skills[k];
  const attacks=(skill.parts||[]).flatMap(p=>{
    if(p.skillType!=='SkillCondition'&&p.skillType!=='SkillSwitch'&&p.skillType!=='SkillRandom')return [{part:p,source:skill}];
    const branch=p.skillType==='SkillRandom'?randomBranch(st,i,skill,p,true):selectedBranch(st,i,skill,p,{});
    return (branch?.parts||[]).map(part=>({part,source:{...skill,...branch,level:skill.level,hits:branch.hits||skill.hits}}));
  });
  const attack=attacks.find(x=>ATTACK_PART_TYPES.has(x.part.skillType));
  if(!attack)return null;
  const model={...attackModel(attack.source,attack.part,{characterId:m.charId,styleId:m.styleId}),tearEnhancementType:m.tearType};
  if(st.units[i].reinforced)model.element=st.units[i].reinforced;
  const mods=collectMods(st,i,model,{sp:skill.consume==='Ep'?0:effectiveCost(st,i,skill)});
  const E=st.ctx.enemy,en=st.enemy;
  const res=computeAttack({skill:model,level:level||skill.level||1,stats:memberStats(st,i),enemy:E,mods,state:{destructionRate:en.dr,hp:en.hp,dp:en.dp}});
  return {model,mods,res,stats:memberStats(st,i)};
}
