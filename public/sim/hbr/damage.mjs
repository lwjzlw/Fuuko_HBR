// 伤害计算：按社区计算器 hbr-calculator.com 的 Calculator 模块逐步重写（对应原函数 M0/R0/U0/ni/K0）。
// 输入是“已经按槽位规则选好、并算出效果量（%）”的增益/减益合计；效果量的计算见 effects.mjs。
// 与原实现的固定对照测试：tests/planner.test.mjs，样例见 tests/fixtures/community-cases.json。
import * as R from './rules.mjs';

const floor2=x=>Math.floor(x*100)/100;
const softCap=x=>x<=R.SOFT_CAP?x:R.SOFT_CAP*(2-Math.exp(0.7*(1-x/R.SOFT_CAP)));
export {softCap};
/** EX 打分的伤害衰减（HBR Toolbox「ex衰减」）：1000 万以上按对数压缩，超过 10 亿再套普通软上限。 */
export const exAttenuation=x=>{
  if(x<=R.EX_ATT_START)return x;
  const r=R.EX_ATT_START+R.EX_ATT_SCALE*Math.log(1+R.EX_ATT_K*(x-R.EX_ATT_START)/R.EX_ATT_START);
  return softCap(r);
};
/** 一次攻击总伤害的封顶（普通：10 亿软上限；ex=true：EX 打分衰减）。 */
export const capAttack=(x,ex=false)=>ex?exAttenuation(x):softCap(x);

/** 加权能力（参数权重为 0 时取力量与灵巧的平均）。 */
export function weightedStat(params,stats){
  const p=params||{},s=R.STATS.reduce((a,k)=>a+(p[k]||0),0);
  if(!(s>0))return (stats.str+stats.dex)/2;
  return R.STATS.reduce((a,k)=>a+(stats[k]||0)*(p[k]||0),0)/s;
}

/** 攻击技能基础威力（qa）：diff = 能力 − 基准，limit = 参数上限。 */
export function basePower(min,max,diff,limit){
  if(limit<=0)return max;
  if(diff>limit)return max+(diff-limit)*R.OVER_LIMIT_SLOPE*max;
  if(diff>=0)return min+(max-min)*(diff/limit);
  return Math.max(1,min*((diff+limit)/limit));
}

/** 自身 DP 比例倍率（AttackByOwnDpRate，按折线插值）。 */
function ownDpRateMultiplier(skill,dpPercent){
  const o=skill.ownDpRate;if(!o)return 1;
  const r=Math.max(0,Math.min(150,dpPercent)),pts=[...o.points].sort((a,b)=>a.dp-b.dp);
  if(!pts.length)return 1;
  if(r<=pts[0].dp)return pts[0].multiplier;
  if(r>=pts[pts.length-1].dp)return pts[pts.length-1].multiplier;
  for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i];if(r>b.dp)continue;if(b.dp===a.dp)return b.multiplier;return a.multiplier+(b.multiplier-a.multiplier)*(r-a.dp)/(b.dp-a.dp);}
  return pts[pts.length-1].multiplier;
}
function spRateMultiplier(skill,sp){const m=skill.spMax;return typeof m!=='number'||m<=0?1:1+Math.max(0,Math.min(m,sp))/m;}

/** hit 分配（%）：缺省均分，不足 100 的补齐，合计不为 100 时按比例归一。 */
export function hitDistribution(dist,n){
  if(!dist||!dist.length)return Array(n).fill(100/n);
  let a=dist.slice(0,n);
  if(a.length<n){const s=a.reduce((x,y)=>x+y,0),rest=Math.max(0,100-s),k=n-a.length;a=a.concat(Array(k).fill(k>0?rest/k:0));}
  const s=a.reduce((x,y)=>x+y,0);
  if(s<=0)return Array(n).fill(100/n);
  return Math.abs(s-100)>1e-4?a.map(x=>x/s*100):a;
}

/** 耳环加成（%）：按 hit 数取表；reverse=true 为破坏耳环。 */
export function earringBonus(earring,hitCount,reverse=false){
  const t=R.EARRING_TABLE[earring?.bonus];if(!t)return 0;
  const n=Math.min(9,Math.max(1,hitCount)-1);
  return t[reverse?9-n:n]??0;
}

/**
 * 计算一次技能攻击。
 * @param {object} a
 *  skill   攻击技能模型（model.mjs attackModel 的输出）
 *  level   技能等级
 *  stats   攻击者能力（已含士气 ×5、全能力被动、积分挑战编成加成）
 *  enemy   {border, hp, dp:[槽…], destruction, destructionLimit, weaknesses:{physical,element}, damageReductionPercent?, devastationResistancePercent?}
 *  mods    见下方解构；都是 %（未提供即 0）
 *  state   {destructionRate(倍率,1=100%), hp, dp:[剩余…]}
 * @returns {object} 与原 K0 同构的结果：perHit / perHitCrit（各段 min/max）、total、critRate、破坏率逐段
 */
export function computeAttack(a){
  const {skill,level=1,stats,enemy,mods={},state={}}=a;
  const misfortune=mods.misfortune||0,superBreak=(mods.superBreak||0)+(mods.superDown||0);
  const border=Math.max(0,enemy.border-misfortune);
  const destructionLimit=superBreak>0?Math.max(100,enemy.destructionLimit+superBreak):enemy.destructionLimit;
  const S=weightedStat(skill.parameters,stats);
  const statDiff=S-border,critStatDiff=S-(enemy.border-Math.max(R.CRIT_BORDER_DOWN,misfortune));
  const limit=skill.paramLimit??1;
  const top=Math.max(0,Math.min(skill.maxLevel,skill.powers.min.length,skill.powers.max.length)-1);
  const li=Math.max(0,Math.min(top,level-1));
  const pmin=skill.powers.min[li],pmax=skill.powers.max[li];
  const tear=tearBonus(skill,mods,statDiff,limit),tearCr=tearBonus(skill,mods,critStatDiff,limit);
  const base=floor2(basePower(pmin,pmax,statDiff,limit)+tear),baseCr=floor2(basePower(pmin,pmax,critStatDiff,limit)+tearCr);
  const ownDp=ownDpRateMultiplier(skill,mods.dpPercent??100),spRate=spRateMultiplier(skill,mods.spValue??30);
  const dpBonus=typeof skill.dpBonus==='number'?1+skill.dpBonus/100:1,hpBonus=typeof skill.hpBonus==='number'?1+skill.hpBonus/100:1;
  const pen=!!skill.isPenetration;

  // ---- 攻击组（R0）
  const morale=Math.max(0,Math.min(10,mods.morale||0))*R.MORALE_ATTACK;
  const necklace=mods.necklace?R.NECKLACE_ATTACK:0;
  const ring=skill.element!=='nonelemental'&&mods.ringLevel!=null?R.RING_BY_LEVEL[Math.max(0,Math.min(R.RING_BY_LEVEL.length-1,mods.ringLevel))]:0;
  const shadow=Math.max(mods.passiveShadowClone||0,mods.shadowClone||0);
  const earr=earringBonus(mods.earring,skill.hitCount,false);
  const general=(mods.attackUp||0)+(mods.passiveAttackUp||0)+shadow+ring+necklace+(mods.chargeAttackUp||0)+(mods.cherry||0)+(mods.babied||0)
    +(mods.astrariumAttackUp||0)+(mods.scoreAttackAttackUp||0)+(mods.eternalOath||0)+morale;
  const atkHp=general+(mods.earring?.type==='attacking'?earr:0);
  const atkDp=general+(mods.earring?.type==='breaking'?earr:0);
  const elemAtk=(mods.elementAttackUp||0)+(mods.passiveElementAttackUp||0)+(mods.scoreAttackElementAttackUp||0);
  const field=mods.field||0;
  // ---- 弱点
  const overwrite=!!mods.resistanceOverwrite&&skill.element!=='nonelemental';
  const baseElem=overwrite?Math.max(100,enemy.weaknesses.element[skill.element]):enemy.weaknesses.element[skill.element];
  const resDown=skill.element!=='nonelemental'?(mods.resistanceDown||0):0;
  const ignoreElem=pen&&skill.element==='nonelemental';
  const elemMult=ignoreElem?1:Math.max(0,baseElem+resDown)/100;
  const physMult=Math.max(0,pen?(skill.penetrationPhysicalWeakness??R.PENETRATION_PHYSICAL):enemy.weaknesses.physical[skill.physicalType])/100;
  const weak=physMult*elemMult>1;
  const mind=weak?(mods.mindsEye||0):0,yama=weak?Math.max(mods.passiveYamawaki||0,mods.yamawaki||0):0;
  const hpPct=atkHp+field+mind+yama,dpPct=atkDp+field+mind+yama;
  const attack={hp:1+(hpPct+elemAtk)/100,dp:1+(dpPct+elemAtk)/100};
  // ---- 标记 / OD
  const token=skill.tokenPowerUp>0?Math.min(R.TOKEN_CAP,1+(mods.tokens||0)*R.TOKEN_PER):1;
  // damageUp：社区计算器没有的“与ダメージ+%”独立乘区（属性の印 Lv1 等，乘区归属待训练场核对）
  const od=(mods.overdrivePercent??100)/100*(1+(mods.damageUp||0)/100);
  // ---- 防御组
  const elemDef=skill.element!=='nonelemental'?(mods.elementDefenseDown||0)+(mods.passiveElementDefenseDown||0)+(mods.permanentElementDefenseDown||0):0;
  const def=(mods.defenseDown||0)+(mods.passiveDefenseDown||0)+(mods.permanentDefenseDown||0)+elemDef+(weak?(mods.fragile||0):0);
  const defense={hp:1+def/100,dp:1+(def+(mods.dpDefenseDown||0))/100};
  const reduction=Math.max(0,1-(enemy.damageReductionPercent||0)/100);
  // ---- 暴击
  const baseRate=pen?100:Math.min(R.CRIT_BASE_CAP,Math.max(0,R.CRIT_BASE+(stats.luk-border)*R.CRIT_LUK));
  const elemCritRate=skill.element!=='nonelemental'?(mods.elementCritRateUp||0)+(mods.passiveElementCritRateUp||0):0;
  const buffRate=(mods.critRateUp||0)+(mods.passiveCritRateUp||0)+(mods.chargeCritRate||0)+((mods.eternalOath||0)>0?100:0)+elemCritRate;
  // forceCrit：超越ゲージ 100% 后该属性攻击“确定暴击”（バースト状态）
  const critRate=pen||mods.forceCrit?100:Math.min(100,baseRate+buffRate);
  const elemCritDmg=skill.element!=='nonelemental'?(mods.elementCritDamageUp||0):0;
  const critDmg=(mods.critDamageUp||0)+elemCritDmg+(mods.passiveCritDamageUp||0)+(mods.passiveElementCritDamageUp||0)+(mods.astrariumCritDamageUp||0);
  // ---- 破坏率
  const destUp=(mods.destructionRateUp||0)+(mods.astrariumDestructionRateUp||0)+(mods.passiveDamageRateUp||0)
    +(mods.earring?.type==='devastating'?earringBonus(mods.earring,skill.hitCount,true):0)+(mods.necklace?R.NECKLACE_DESTRUCTION:0);
  const drBonus=(weak&&typeof skill.weakHitDestructionRate==='number'?skill.weakHitDestructionRate:skill.destructionRateBonus)??0;
  const destructionRateBonus=drBonus*(1+destUp/100);
  const weakPower=weak&&typeof skill.weakHitPowerMultiplier==='number'?skill.weakHitPowerMultiplier:1;

  // ---- 分段（U0）
  const n=Math.max(1,skill.hitCount),dist=hitDistribution(skill.hitDistribution,n),extra=mods.funnel||[];
  const k=ownDp*spRate*weakPower;
  const per=(lo,hi)=>dist.map(d=>({min:lo*d/100,max:hi*d/100})).concat(extra.map(x=>({min:lo*x,max:hi*x})));
  const normal={perHitBase:per(base*k*R.VARIANCE[0],base*k*R.VARIANCE[1]),crit:1};
  const crit={perHitBase:per(baseCr*k*R.VARIANCE[0],baseCr*k*R.VARIANCE[1]),crit:R.CRIT_BASE_MULT+critDmg/100};
  const common={dist,attack,physMult,elemMult,token,od,defense,reduction,dpBonus,hpBonus,enemy:{...enemy,destructionLimit},
    destructionRateBonus,hitCount:n,extra,state,forceOne:mods.forceOneDamage===true};
  const resN=simulate(common,normal),resC=simulate(common,crit);
  const sum=list=>list.reduce((s,h)=>({min:s.min+h.min,max:s.max+h.max}),{min:0,max:0});
  const tn=sum(resN.perHit),tc=sum(resC.perHit);
  return {
    perHit:resN.perHit,perHitCrit:resC.perHit,
    total:{min:softCap(tn.min),max:softCap(tn.max),critMin:softCap(tc.min),critMax:softCap(tc.max),minRaw:tn.min,maxRaw:tn.max,critMinRaw:tc.min,critMaxRaw:tc.max},
    critRate:{base:baseRate,buffs:pen?0:buffRate,total:critRate},
    destructionPerHit:resN.destructionMin,destructionPerHitMax:resN.destructionMax,
    consecutiveHitStartIndex:n,consecutiveHitCount:extra.length,
    meta:{statDiff,critStatDiff,basePower:base,critBasePower:baseCr,weak,attack,defense,elemMult,physMult,critMultiplier:crit.crit,destructionRateBonus,border},
  };
}

function tearBonus(skill,mods,diff,limit){
  const lv=Math.max(0,Math.min(5,mods.tearLevel||0));
  if(lv<=0||skill.tearEnhancementType!=='AttackUp')return 0;
  return basePower(skill.powers.min[0],skill.powers.max[0],diff,limit+lv*R.TEAR_STEP)*R.TEAR_RATE*lv;
}

// 逐段结算（ni/ri/J0）：DP 槽按顺序扣；破盾那一下和打 HP 的每一下都累计破坏率
function simulate(c,variant){
  const st=c.state,enemy=c.enemy;
  const hp0=Math.max(0,Math.min(st.hp??enemy.hp,enemy.hp));
  const gauges0=(enemy.dp||[]).map((g,i)=>Math.max(0,Math.min(st.dp?.[i]??g,g)));
  const fresh=()=>({gauges:gauges0.slice(),index:0,hasBroken:false,hp:hp0,dr:Math.max(1,st.destructionRate??1)});
  const A=fresh(),B=fresh();
  const limit=enemy.destructionLimit/100,resist=Math.max(0,1-(enemy.devastationResistancePercent||0)/100);
  const te=c.destructionRateBonus*enemy.destruction/100*resist,perMain=c.hitCount>0?te/c.hitCount:0;
  const G=variant.crit;
  const hpChain=c.attack.hp*c.physMult*c.elemMult*c.token*c.od*G*c.defense.hp*c.reduction;
  const dpChain=c.attack.dp*c.physMult*c.elemMult*c.token*c.od*G*c.defense.dp*c.reduction;
  const perHit=[],dMin=[],dMax=[];
  variant.perHitBase.forEach((h,i)=>{
    const isExtra=i>=c.hitCount,gain=isExtra?te*(c.extra[i-c.hitCount]??0):perMain;
    const lo=c.forceOne?hitOnce(A,1,1,gain,limit,()=>1):hitOnce(A,h.min*c.dpBonus*dpChain,h.min*c.hpBonus*A.dr*hpChain,gain,limit,(x)=>h.min*c.hpBonus*x*hpChain);
    const hi=c.forceOne?hitOnce(B,1,1,gain,limit,()=>1):hitOnce(B,h.max*c.dpBonus*dpChain,h.max*c.hpBonus*B.dr*hpChain,gain,limit,(x)=>h.max*c.hpBonus*x*hpChain);
    dMin.push(lo.before);dMax.push(hi.before);
    perHit.push({min:lo.damage,max:hi.damage,dp:lo.dp,before:lo.before,after:lo.after});
  });
  return {perHit,destructionMin:dMin,destructionMax:dMax};
}

const floorFinite=x=>Number.isFinite(x)?Math.floor(x):x;
const atLeastOne=(x,empty)=>!Number.isFinite(x)||x<=0?(empty?0:1):x;
function hitOnce(s,dpRaw,_hpRaw,gain,limit,hpAt){
  while(s.index<s.gauges.length&&s.gauges[s.index]<=0)s.index++;
  const before=s.dr;
  if(s.index<s.gauges.length){
    const g=s.gauges[s.index],locked=s.hasBroken,cap=locked?Math.max(g-1,0):g;
    const dealt=atLeastOne(floorFinite(Math.min(dpRaw,cap)),cap===0);
    const left=g-dealt;s.gauges[s.index]=Math.max(0,left);
    let after=before;
    if(!locked&&left<=0){s.hasBroken=true;after=Math.min(limit,before+gain);s.dr=after;}
    // 原实现：锁定后（已破过一条 DP）剩余槽最多打到 1；破盾这一下涨破坏率
    return {damage:atLeastOne(dealt,cap===0),dp:true,before,after};
  }
  const hpRaw=hpAt(s.dr);
  const empty=s.hp<=0,dealt=atLeastOne(floorFinite(hpRaw),empty);
  s.hp-=dealt;
  let after=before;
  if(dealt>0){after=Math.min(limit,before+gain);s.dr=after;}
  return {damage:atLeastOne(dealt,empty),dp:false,before,after};
}
