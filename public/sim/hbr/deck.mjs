import {computePanel,STAT_KEYS,titleRank} from './stats.mjs';
import {canEquip} from '../../equipment.mjs';
// 游戏缓存编队 → 排轴器成员。饰品按 equipment.json 解释（固定效果 + 主词条选择），对应社区计算器的
// 耳环（类型/档位）、古代项链（技能攻击+10%/破坏率+10%）、属性戒指（等级）与初期 SP。
// 主词条 ID 规则：末两位 = 组号（0 起）+ 选项序号（1 起），如 42600203 = 第 0 组第 3 项。

const ROLE_COND={Attacker:'IsAttacker()',Breaker:'IsBreaker()',Blaster:'IsBlaster()',Healer:'IsHealer()',Buffer:'IsBuffer()',Debuffer:'IsDebuffer()',Defender:'IsDefender()',Admiral:'IsAdmiral()'};
const RING_LEVELS=[2,4,6,8,10];

/**
 * 解出一件饰品实际生效的效果列表（固定效果 + 随机词条）。
 * 主词条 ID 末两位 = 摊平后的选项序号；解不出时退回：单组按末位，多组按 +6 满强化取每组最大值
 * （2026-11-08 截图核对：耳环 DP1200/智力48、手环体力45/精神45；新解码给出同样结果）。
 */
export function accessoryEffects(entry,mainIds=[]){
  if(!entry)return [];
  const out=[...(entry.effects||[])],groups=entry.rollGroups||[];
  if(!groups.length)return out;
  // 主词条 ID 末两位 = 所有词条组摊平后的选项序号（1 起）（2026-11-09 用 20 套编队的项链“某职能初期 SP+3”与职能对照得出，
  // 并复现了截图核对过的耳环/手环数值）。每组恰好解出一个选项时以此为准
  const flat=groups.flatMap((g,gi)=>g.map(o=>({o,gi})));
  const ids=(mainIds||[]).map(id=>flat[Number(id)%100-1]).filter(Boolean);
  if(ids.length===groups.length&&new Set(ids.map(x=>x.gi)).size===groups.length){for(const x of ids)out.push(x.o);return out;}
  if(groups.length===1){
    const id=(mainIds||[])[0];const o=id?Number(id)%10:groups[0].length;
    const opt=groups[0][Math.max(0,Math.min(groups[0].length,o||groups[0].length)-1)];if(opt)out.push(opt);
    return out;
  }
  if(!(mainIds||[]).length)return out;
  for(const g of groups){
    // 数值词条比 value；被动词条（如手环“普通攻击攻击力 +100/150/200%”）value 为 0，比部件 power
    const size=o=>(Number(o.value?.[0])||0)||Math.max(0,...(o.skill?.parts||[]).map(p=>Number(p.power?.[0])||0));
    const best=g.reduce((a,b)=>(size(b)>=size(a)?b:a),g[0]);
    if(best)out.push(best);
  }
  return out;
}

/** 由饰品效果得到计算器装备参数与初期 SP。role 用于“[ATK/BRK…]任一的初期SP+3”类条件。 */
export function equipmentFrom(accessories,equipmentById,role,member){
  const eq={earring:null,odEarringBonus:0,necklaceAttack:false,necklaceDestruction:false,ringElement:null,ringLevel:null,initialSp:0,skillCountUp:{},normalAttackUp:0,normalElement:null,unknown:[]};
  for(const [slot,a] of Object.entries(accessories||{})){
    const entry=equipmentById.get(a.masterId);
    if(!entry){eq.unknown.push(`${slot}:${a.masterId}`);continue;}
    if(member&&!canEquip(entry,member)){eq.unknown.push(`${slot}:${a.masterId} 专属限制`);continue;}
    for(const f of accessoryEffects(entry,a.main)){
      if(f.type==='Sp'){if(!f.condition||f.condition===ROLE_COND[role])eq.initialSp+=Number(f.value?.[0])||0;continue;}
      if(f.type!=='PassiveSkill'||!f.skill)continue;
      const d=f.skill.description||'',parts=f.skill.parts||[];
      let m;
      if((m=/對HP技能攻擊力最大\+(\d+)%/.exec(d)))eq.earring={type:'attacking',bonus:Number(m[1])};
      else if((m=/對DP技能攻擊力最大\+(\d+)%/.exec(d)))eq.earring={type:'breaking',bonus:Number(m[1])};
      else if((m=/破壞率上升量最大\+(\d+)%/.exec(d)))eq.earring={type:'devastating',bonus:Number(m[1])};
      else if((m=/OD量表上升量最大\+(\d+)%/.exec(d)))eq.odEarringBonus=Number(m[1]);
      for(const p of parts){
        const pw=Math.round((p.power?.[0]||0)*100),el=(p.elements||[])[0];
        if(p.skill_type==='AttackUp'&&slot==='ring'&&el){const lv=RING_LEVELS.indexOf(pw);eq.ringElement=el.toLowerCase();eq.ringLevel=lv>=0?lv:RING_LEVELS.length-1;}
        else if(p.skill_type==='AttackUp'&&slot==='necklace'&&!el&&pw===10)eq.necklaceAttack=true;
        else if(p.skill_type==='DamageRateUp'&&slot==='necklace'&&pw===10)eq.necklaceDestruction=true;
        else if(slot==='necklace'&&p.skill_type==='DefenseUp'&&f.skill.timing==='OnEnemyTurnStart'&&p.target_type==='Self'&&p.effect?.exitCond==='EnemyTurnEnd'){
          eq.enemyTurnDefense={label:f.skill.id,name:f.skill.name,timing:f.skill.timing,condition:f.skill.condition,
            parts:[{skillType:p.skill_type,targetType:p.target_type,cond:p.cond,power:p.power,limitType:p.effect.limitType,
              exit:{cond:p.effect.exitCond,value:p.effect.exitVal}}]};
        }
        // 手环：普通攻击攻击力 +N%（每回合）、普通攻击变为某属性
        else if(p.skill_type==='AttackUpOnlyNormal')eq.normalAttackUp+=pw;
        else if(p.skill_type==='AdditionalElementOnlyNormal'&&el)eq.normalElement=el.toLowerCase();
        else if(p.skill_type==='SkillLimitCountUp'&&el)eq.skillCountUp[el.toLowerCase()]=(eq.skillCountUp[el.toLowerCase()]||0)+(p.power?.[0]||0);
      }
    }
  }
  return eq;
}

/**
 * 技能装备格数上限 = 3 + 转生（第 1/5/10/20 次各 +1）+ 才能开花 1 + 称号 Rank≥10 时 1 + ADMIRAL 1。
 * 来源：Game8 转生/称号页、katorasublog（转生 1 次 → 4 格）；ADMIRAL +1 与总式由 2026-11-09 缓存 120 名编队成员核对
 * （无一超出，79 人正好装满；二階堂 转生 10 未开花装了 8 个）。
 * raw = 缓存编队成员或已持有卡面（character.reincarnation/titleExp，card.daphne）。
 */
export function skillSlotCap(raw,role){
  const re=Number(raw?.character?.reincarnation)||0;
  return 3+[1,5,10,20].filter(k=>re>=k).length+((raw?.card?.daphne||raw?.tearLevel)?1:0)
    +(titleRank(Number(raw?.character?.titleExp)||0)>=10?1:0)+(role==='Admiral'?1:0);
}

/**
 * 编队 → planner.members（6 人，前 3 人为开场前排）。保留已有成员的面板（同一卡面时）。
 * deck: /api/cache-decks 返回的一项；archive 用于技能等级；previous: 现有 planner.members
 */
export function membersFromDeck(deck,{catalog,equipment,stats=null,previous=[]}){
  const byId=new Map((equipment.entries||[]).map(e=>[e.sourceId,e]));
  const styleById=new Map(catalog.styles.map(s=>[s.id,s]));
  const panelData={stats,equipment,catalog,equipmentById:byId};
  return Array.from({length:6},(_,i)=>{
    const m=deck.members[i];
    if(!m||!m.styleId)return {styleId:'',stats:{},front:i<3};
    const style=styleById.get(m.styleId);
    const eq=equipmentFrom(m.accessories,byId,style?.role,style&&{styleId:style.id,characterId:style.characterId});
    const prev=previous.find(p=>p.styleId===m.styleId);
    // 面板：能推算就用推算值（手动改过的项保留）；推算失败时沿用上次手填
    let computed=null;
    let vitals=prev?.vitals||null;
    if(stats){const r=computePanel(m,panelData);if(r.final){computed=Object.fromEntries(STAT_KEYS.map(k=>[k,Math.round(r.final[k])]));vitals={dp:Math.round(r.final.dp),hp:Math.round(r.final.hp)};}}
    const manual=prev?.statsManual||[];
    const merged=computed?{...computed,...Object.fromEntries(manual.filter(k=>prev?.stats?.[k]!=null).map(k=>[k,prev.stats[k]]))}:(prev?.stats||{});
    return {styleId:m.styleId,front:i<3,stats:merged,vitals,statsManual:computed?manual:[],statsSource:computed?'computed':'manual',raw:m,limitBreak:m.limitBreak??undefined,tearLevel:m.tearLevel||0,
      initialSp:eq.initialSp,equipment:{earring:eq.earring,odEarringBonus:eq.odEarringBonus,necklaceAttack:eq.necklaceAttack,enemyTurnDefense:eq.enemyTurnDefense,
        ringElement:eq.ringElement,ringLevel:eq.ringLevel,skillCountUp:eq.skillCountUp,normalAttackUp:eq.normalAttackUp,normalElement:eq.normalElement},
      deckSkillIds:m.skillIds||[],supportStyleId:m.supportStyleId||null,supportLimitBreak:m.supportLimitBreak??null,source:`cache:${deck.index}`};
  });
}

/** 旧排轴只重算由原始编队导出的数值，保留手填属性和已选择的技能、阵型及支援。 */
export function withCurrentEquipment(members,data){
  const raws=members.map(m=>m.raw?.accessories&&m.raw.styleId===m.styleId?m.raw:null);
  if(!raws.some(Boolean))return members;
  const updated=membersFromDeck({members:raws},{...data,previous:members});
  return members.map((m,i)=>{
    if(!raws[i])return m;
    const eq=updated[i],out={...m,equipment:eq.equipment,initialSp:eq.initialSp};
    const supportMatches=m.supportStyleId===undefined||m.supportStyleId===(raws[i].supportStyleId??null);
    if(eq.statsSource==='computed'&&m.statsSource!=='manual'&&raws[i].card&&supportMatches){
      out.stats=eq.stats;
      out.vitals=eq.vitals;
    }
    return out;
  });
}
