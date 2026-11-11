// 把公开主数据（public/data/skills.json 的部件）转换成社区计算器使用的技能/效果模型。
// 字段与 hbr-calculator.com 的技能表一致；固定对照样例见 tests/planner.test.mjs 和 tests/fixtures/community-cases.json。
import {PENETRATION_PHYSICAL} from './rules.mjs';

export const ATTACK_PART_TYPES=new Set(['AttackSkill','TokenAttack','PenetrationCriticalAttack','AttackByOwnDpRate','AttackBySp','DamageRateChangeAttackSkill','AttackNormal','FixedHpDamageRateAttack']);

const lower=x=>x?String(x).toLowerCase():x;
export const elementOf=part=>{const e=(part?.elements||[]).find(x=>x&&x!=='None');return e?lower(e):'nonelemental';};
export const physicalOf=part=>({Slash:'slash',Stab:'stab',Strike:'strike'})[part?.attackType]||null;

/** 技能等级成长：power[i]×(1+growth[i]×(Lv−1))，1..maxLevel。 */
export const LEVEL_TABLE_SIZE=20; // 社区计算器的 EX 技能可到 Lv13/15；按同一成长式延伸到 20 级
export function powersByLevel(part,maxLevel){
  const p=part.power||[0,0],g=part.growth||[0,0],n=Math.max(1,maxLevel||1);
  const min=[],max=[];
  for(let lv=1;lv<=n;lv++){min.push(p[0]*(1+(g[0]||0)*(lv-1)));max.push(p[1]*(1+(g[1]||0)*(lv-1)));}
  return {min,max};
}

/** 攻击部件 → 计算器攻击技能模型。skill 为 skills.json 的技能（含 hits），part 为其攻击部件。 */
export function attackModel(skill,part,meta={}){
  const mult=part.multipliers||{};
  const ratios=(part.hits?.some(h=>h.type==='Main')?part.hits.filter(h=>h.type==='Main'):(skill.hits||[]).filter(h=>h.type!=='Before')).map(h=>h.ratio);
  const hitCount=Math.max(1,skill.hitCount>0?skill.hitCount:ratios.length||1);
  const m={
    id:skill.id,label:skill.label,name:skill.name,characterId:meta.characterId,styleId:meta.styleId,
    element:elementOf(part),physicalType:physicalOf(part)||meta.physicalType||'slash',
    targetType:part.targetType,hitCount,maxLevel:skill.maxLevel||1,
    powers:powersByLevel(part,Math.max(skill.maxLevel||1,LEVEL_TABLE_SIZE)),
    paramLimit:part.diffForMax||0,parameters:{str:0,dex:0,con:0,wis:0,spr:0,luk:0,...(part.parameters||{})},
    destructionRateBonus:mult.dr??0,
    skillType:part.skillType,
  };
  if(mult.dp!=null&&mult.dp!==1)m.dpBonus=Math.round((mult.dp-1)*1000)/10;
  if(mult.hp!=null&&mult.hp!==1)m.hpBonus=Math.round((mult.hp-1)*1000)/10;
  if(ratios.length===hitCount&&ratios.some(r=>Math.abs(r-ratios[0])>1e-9))m.hitDistribution=ratios.map(r=>Math.round(r*10000)/100);
  const v=part.value||[0,0];
  switch(part.skillType){
    case 'PenetrationCriticalAttack':m.isPenetration=true;m.penetrationPhysicalWeakness=v[0]>0?(1+v[0])*100:PENETRATION_PHYSICAL;break;
    case 'TokenAttack':m.tokenPowerUp=1;m.tokenPer=v[0]||0.16;break;
    case 'AttackByOwnDpRate':
      // 递减型（低 DP 威力高）：0%→value[0]，100% 起→value[1]；递增型采用社区实测折线（DP≤60% ×0.8、100% ×1、150% ×1.25）
      m.ownDpRate=(v[1]||1)>=(v[0]||1)
        ?{points:[{dp:0,multiplier:0.8},{dp:60,multiplier:0.8},{dp:100,multiplier:1},{dp:150,multiplier:1.25}]}
        :{points:[{dp:0,multiplier:v[0]||1},{dp:100,multiplier:v[1]||1},{dp:150,multiplier:v[1]||1}]};
      break;
    case 'AttackBySp':if(v[0]>0)m.spMax=v[0];break;
    case 'DamageRateChangeAttackSkill':
      // 条件 IsHitWeak()：命中弱点时改用 value[0] 破坏倍率、威力×value[1]；TargetBreakDownTurn()：对倒下回合中的敌人（另存，由回合模拟判断）
      if(/TargetBreakDownTurn/.test(part.cond||'')){m.downTurnDestructionRate=v[0];m.downTurnPowerMultiplier=v[1];}
      else{m.weakHitDestructionRate=v[0];if(v[1]&&v[1]!==1)m.weakHitPowerMultiplier=v[1];}
      break;
  }
  if(skill.cond)m.condition=skill.cond;
  if(part.cond)m.partCondition=part.cond;
  return m;
}

/**
 * 增益/减益部件 → 计算器效果模型 {type, element, effects{min[],max[]}（单位 %）, paramLimit, parameters, limitType, kind}。
 * 不在计算器伤害模型里的类型返回 null（由回合模拟另行处理，如 HealSp、OverDrivePointUp）。
 */
export function effectModel(skill,part){
  const t=part.skillType,el=elementOf(part),hasEl=el!=='nonelemental';
  const lv=skill?.maxLevel||1;
  // power[1]=0 表示固定值（max=min）
  const pct=()=>{const p=powersByLevel(part,lv),fixedV=!(part.power?.[1]);return {min:p.min.map(x=>round1(x*100)),max:(fixedV?p.min:p.max).map(x=>round1(x*100))};};
  const fixed=x=>({min:[x],max:[x]});
  const base={sourceSkillId:skill?.id,label:skill?.label,element:hasEl?el:undefined,paramLimit:part.diffForMax||0,
    parameters:{str:0,dex:0,con:0,wis:0,spr:0,luk:0,...(part.parameters||{})},limitType:part.limitType==='Only'?'Once':part.limitType||'Default',
    exit:part.exit||{cond:'None',value:[0,0]},targetType:part.targetType,targetCondition:part.targetCondition||'',maxLevel:lv};
  const permanent=part.exit?.cond==='Eternal';
  switch(t){
    case 'AttackUp':case 'AttackUpIncludeNormal':return {...base,type:hasEl?'elementAttackUp':'attackUp',kind:'buff',effects:pct(),includeNormal:t==='AttackUpIncludeNormal'};
    case 'MindEye':return {...base,type:'mindsEye',kind:'buff',effects:pct()};
    case 'CriticalRateUp':return {...base,type:hasEl?'elementCritRateUp':'critRateUp',kind:'buff',effects:pct()};
    case 'CriticalDamageUp':return {...base,type:hasEl?'elementCritDamageUp':'critDamageUp',kind:'buff',effects:pct()};
    case 'Funnel':{const n=Math.max(0,Math.round(Math.max(part.power?.[0]||0,part.power?.[1]||0))),// 次数为区间（如 2～3）时取上限，同社区计算器
      r=round1((part.value?.[0]||0)*100);return {...base,type:'consecutiveHit',kind:'buff',paramLimit:0,effects:{min:Array(n).fill(r),max:Array(n).fill(r)}};}
    case 'BuffCharge':{const c=powersByLevel({power:[part.value?.[0]||0,0],growth:[0,0]},lv).min.map(x=>round1(x*100));return {...base,type:'charge',kind:'buff',effects:pct(),chargeCritRate:c};}
    case 'Zone':{const p=part.power?.[0]||0;return {...base,type:'elementField',kind:'buff',paramLimit:0,effects:fixed(round1((p>1?p-1:p)*100))};}
    case 'ShadowClone':return {...base,type:'shadowClone',kind:'buff',paramLimit:0,effects:fixed(round1((part.power?.[0]||0)*100))};
    case 'BIYamawakiServant':return {...base,type:'yamawakiMinion',kind:'buff',paramLimit:0,effects:fixed(round1((part.power?.[0]||0)*100))};
    case 'EternalOath':return {...base,type:'eternalOath',kind:'buff',effects:pct()};
    case 'ArrowCherryBlossoms':return {...base,type:'arrowCherryBlossoms',kind:'buff',effects:pct()};
    case 'DamageRateUp':return {...base,type:'destructionRateUp',kind:'buff',effects:pct()};
    case 'DefenseDown':{
      const dpOnly=part.multipliers&&part.multipliers.hp===0&&part.multipliers.dp>0;
      return {...base,type:dpOnly?'dpDefenseDown':hasEl?'elementDefenseDown':'defenseDown',kind:'debuff',isPermanent:permanent&&!dpOnly,effects:pct()};
    }
    case 'Fragile':return {...base,type:'fragile',kind:'debuff',effects:pct()};
    case 'ResistDown':return {...base,type:'resistanceDown',kind:'debuff',isPermanent:permanent,effects:pct()};
    case 'ResistDownOverwrite':return {...base,type:'resistanceDownOverwrite',kind:'debuff',isPermanent:true,limitType:'Once',effects:fixed(0)};
    case 'Hacking':return {...base,type:'misfortune',kind:'debuff',paramLimit:0,effects:fixed(100)};      // 骇入：基准 −100
    case 'Misfortune':return {...base,type:'misfortune',kind:'debuff',paramLimit:0,effects:fixed((part.power?.[0]||0)*10)}; // 灾厄：每级基准 −10
    case 'SuperBreak':return {...base,type:'superBreak',kind:'debuff',paramLimit:0,effects:fixed(part.power?.[0]||0)};
    case 'SuperBreakDown':return {...base,type:'superDown',kind:'debuff',paramLimit:0,effects:fixed(part.power?.[0]||0)};
  }
  return null;
}

function round1(x){return Math.round(x*10)/10;}
export const hasSupportResonance=(style,shift)=>style?.tier==='SSR'||(style?.tier==='SS'&&shift===true);
