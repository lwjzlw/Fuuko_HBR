// 增益/减益效果量（%）：按社区计算器 Oe/Bi/wl/_l 重写。
// 增益按施放者“加权能力”（不减基准）插值；减益按“能力−敌方基准”插值；再乘强化（效果量上升）并加泪强化。
import {weightedStat} from './damage.mjs';
import {BUFF_OVER_LIMIT_SLOPE,DEBUFF_OVER_LIMIT_SLOPE} from './rules.mjs';

const TEAR_BUFF_RATE=0.04,TEAR_BUFF_LIMIT=60;      // Js/Hs：BuffUp 泪（仅攻击类增益）
const TEAR_CRIT_RATE=0.02,TEAR_CRIT_LIMIT=60;      // Ks/Os：CriticalRateUp 泪
const TEAR_DEBUFF_RATE=0.02,TEAR_DEBUFF_LIMIT=20;  // Us/Ps：DebuffUp 泪
const STRENGTHENABLE_DEBUFF=new Set(['defenseDown','elementDefenseDown','dpDefenseDown','fragile','resistanceDown']);

function interp(min,max,a,limit,slope){
  if(a>limit)return max+(a-limit)*slope*max;
  if(a>=0)return min+(max-min)*(a/limit);
  const h=limit/2;return min*((a+h)/h);
}
function levelValues(model,level){
  const top=Math.max(0,Math.min(model.maxLevel??20,model.effects.min.length,model.effects.max.length)-1);
  const i=Math.max(0,Math.min(top,level-1));
  return [model.effects.min[i]??model.effects.min[0]??0,model.effects.max[i]??model.effects.max[0]??0];
}
function tearPart(min,max,a,limit,lv,rate,clampNegToMin=false){
  if(lv<=0)return 0;
  const n=rate*lv;
  if(clampNegToMin&&a<0)return min*n;
  if(limit<=0)return max*n;
  return (min+(max-min)*Math.max(0,Math.min(1,a/limit)))*n;
}

/** 增益基础量（Oe）：不含泪与强化。 */
export function buffBase(model,level,stats){
  const [min,max]=levelValues(model,level),limit=model.paramLimit??0;
  if(limit<=0)return max;
  return interp(min,max,weightedStat(model.parameters,stats),limit,BUFF_OVER_LIMIT_SLOPE);
}
/** 减益基础量（Bi）：能力低于基准时取最小值。 */
export function debuffBase(model,level,stats,border){
  const [min,max]=levelValues(model,level),limit=model.paramLimit??0;
  if(limit<=0)return max;
  const a=weightedStat(model.parameters,stats)-border;
  return a<0?min:interp(min,max,a,limit,DEBUFF_OVER_LIMIT_SLOPE);
}

/**
 * 增益最终效果量（wl）。opt: {tearBuffUp, tearCritRateUp, supportStrengthen, passiveStrengthen}（%）
 * 返回 {base, total, tear, critTear}；total = (基础+泪)×(1+强化/100) + 暴击率泪
 */
export function buffSize(model,level,stats,opt={}){
  const min0=model.effects.min[0]??0,max0=model.effects.max[0]??0,a=weightedStat(model.parameters,stats);
  const tb=opt.tearBuffUp||0,tc=(model.type==='critRateUp'||model.type==='elementCritRateUp')?(opt.tearCritRateUp||0):0;
  const tear=(model.type==='attackUp'||model.type==='elementAttackUp')?tearPart(min0,max0,a,(model.paramLimit??0)+tb*TEAR_BUFF_LIMIT,tb,TEAR_BUFF_RATE):0;
  const critTear=tearPart(min0,max0,a,(model.paramLimit??0)+tc*TEAR_CRIT_LIMIT,tc,TEAR_CRIT_RATE);
  const E=buffBase(model,level,stats)+tear;
  const s=(opt.supportStrengthen||0)+(opt.passiveStrengthen||0);
  return {base:E+critTear,total:(s?E*(1+s/100):E)+critTear,tear,critTear};
}

/** 减益最终效果量（_l）。opt: {tearDebuffUp, supportStrengthen, passiveStrengthen}（%） */
export function debuffSize(model,level,stats,border,opt={}){
  const min0=model.effects.min[0]??0,max0=model.effects.max[0]??0,lv=opt.tearDebuffUp||0;
  const a=weightedStat(model.parameters,stats)-border;
  const tear=STRENGTHENABLE_DEBUFF.has(model.type)?tearPart(min0,max0,a,(model.paramLimit??0)+lv*TEAR_DEBUFF_LIMIT,lv,TEAR_DEBUFF_RATE,true):0;
  const L=debuffBase(model,level,stats,border)+tear;
  const s=(opt.supportStrengthen||0)+(opt.passiveStrengthen||0);
  return {base:L,total:s?L*(1+s/100):L,tear};
}

/** 哪些减益吃“减益效果量上升”（GiveDebuffUp）；防御下降另吃 GiveDefenseDebuffUp。 */
export const isStrengthenableDebuff=t=>STRENGTHENABLE_DEBUFF.has(t);
export const isDefenseDebuff=t=>t==='defenseDown'||t==='elementDefenseDown';
export const isAttackBuff=t=>t==='attackUp'||t==='elementAttackUp';
