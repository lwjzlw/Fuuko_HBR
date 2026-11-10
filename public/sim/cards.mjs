// 遭遇战（セラフ遭遇戦演習 #08）战术卡：每阶段结束后三选一（可重抽 5 次），选中的卡从下一阶段起生效并一直保留。
// 来源：用户 2026-11-09 提供的本期全部 28 张卡面截图（繁中原文照录在 desc）。
// 生效方式：
//   apply(st)      选卡时立即执行一次（“下次戰鬥開始時…”类）
//   hook:true      常驻，由引擎在对应时点检查 st.cards（Set）：
//                  battleStart（setPhase）/ turnStart / actionStart（collectMods）/ enemyAttack / fieldSet / break / EX 使用后
//   nextBattle     只影响下一阶段敌人的修正（能力值下降）
// tags 供配置优化挑卡：zone=冰光暗领域，dp=DP 溢出，breaker/breaker2=Breaker 1/2 名以上，heal=Healer/Defender，generic=通用。

const push=(u,eff)=>u.effects.push({uses:null,turns:null,currentOnly:false,...eff});

export const CARDS=[
  // ---- 泛用戰術
  {id:'dpRevive',cat:'泛用戰術',tags:['generic'],name:'DP 复活并回复 100%',desc:'下次戰鬥開始時 復活我方全體DP並回復100%',
    apply(st){st.units.forEach((u,i)=>{const m=st.ctx.party[i];if(m.dpMax>0&&!u.down){u.dpBroken=false;u.dp=Math.max(u.dp,m.dpMax);}});}},
  {id:'sp5',cat:'泛用戰術',tags:['generic'],name:'全体 SP+5',desc:'下次戰鬥開始時 我方全體SP+5',apply(st){for(const u of st.units)u.sp+=5;}},
  {id:'skillCount1',cat:'泛用戰術',tags:['generic'],name:'技能使用次数回复 1',desc:'下次戰鬥開始時 回復我方全體的技能使用次數1次',
    apply(st){for(const u of st.units)for(const k of Object.keys(u.uses))u.uses[k]=Math.max(0,u.uses[k]-1);}},
  {id:'enemyStat100',cat:'泛用戰術',tags:['generic'],name:'敌方能力值 −100',desc:'下次戰鬥 敵人狀態值減少100',nextBattle:{borderDown:100}},
  {id:'critRate100',cat:'泛用戰術',tags:['generic'],name:'暴击率 +100%',desc:'行動開始時 我方全體暴擊率+100%',hook:true},
  {id:'def50x2',cat:'泛用戰術',tags:['generic'],name:'防御力 +50%（2 次）',desc:'下次戰鬥開始時 賦予我方全體防禦力+50%（2次）',
    apply(st){for(const u of st.units)push(u,{type:'defenseUp',size:50,uses:2,src:'card:def50x2',hitUses:true});}},
  {id:'shredding5',cat:'泛用戰術',tags:['generic'],name:'速弹 5 回合',desc:'下次戰鬥開始時 賦予我方全體速彈狀態（5回合）',
    apply(st){for(const u of st.units)push(u,{type:'status',status:'Shredding',size:0,turns:5,src:'card'});}},
  // ---- 空間
  {id:'zoneEternal300',cat:'空間',tags:['zone'],name:'领域效果量 +300% 且永续',desc:'以主動技能展開的屬性空間 效果量+300% 並且變為回合永久',
    apply(st){st.mods={...st.mods,zoneRule:(st.mods.zoneRule||0)+300};if(st.field)st.field={...st.field,turns:null};}}, // 与场景规则“领域效果量 +100% 且永续”同一机制，效果量相加
  {id:'fieldSp3',cat:'空間',tags:['zone'],name:'冰光暗领域中 回合开始 SP+3',desc:'若回合開始時 冰/光/闇其中任一屬性空間展開中 我方全體SP+3',hook:true},
  {id:'zoneAtk300',cat:'空間',tags:['zone'],name:'冰光暗领域中 同属性技能攻击 +300%',desc:'若行動開始時 冰/光/闇其中任一屬性空間展開中 和空間相同屬性的技能攻擊力+300%',hook:true},
  {id:'zoneCrit100',cat:'空間',tags:['zone'],name:'冰光暗领域中 同属性暴伤 +100%',desc:'若行動開始時 冰/光/闇其中任一屬性空間展開中 和空間相同屬性的暴擊傷害值+100%',hook:true},
  {id:'zoneDef30',cat:'空間',tags:['zone'],name:'冰光暗领域中 敌方行动时防御 +30%',desc:'若敵人行動開始時 冰/光/闇其中任一屬性空間展開中 賦予我方全體防禦力上升30%（1回合）',hook:true},
  {id:'fieldMorale3',cat:'空間',tags:['zoneAny'],name:'展开领域时 全体士气 +3',desc:'以我方的主動技能展開屬性空間時 我方全體的士氣等級+3',hook:true},
  {id:'fieldOd30',cat:'空間',tags:['zoneAny'],name:'展开领域时 OD+30%',desc:'以我方的主動技能展開屬性空間時 OD量表+30%',hook:true},
  // ---- DP
  {id:'healerEx20',cat:'DP',tags:['heal'],name:'Healer/Defender EX → 全体 DP 回复 20%',desc:'Healer或是Defender使用EX技能時 我方全體DP回復20%（可突破上限至150%）',hook:true},
  {id:'dpOverAtk500',cat:'DP',tags:['dp'],name:'DP 溢出者技能攻击 +500%',desc:'行動開始時 DP突破上限的我方技能攻擊力+500%',hook:true},
  {id:'dpOverSp5',cat:'DP',tags:['dp'],name:'DP 溢出者回合开始 SP+5',desc:'回合開始時 DP突破上限的我方SP+5',hook:true},
  {id:'dpOverOd10',cat:'DP',tags:['dp'],name:'战斗开始 每名 DP 溢出者 OD+10%',desc:'戰鬥開始時 每存在1名DP突破上限的我方 OD量表+10%',hook:true},
  {id:'dp120All50',cat:'DP',tags:['dp'],name:'4 名以上 DP≥120% → 全能力 +50',desc:'若戰鬥開始時 DP在120%以上的我方在4名以上 我方全體全能力+50',hook:true},
  {id:'dp120Disaster2',cat:'DP',tags:['dp'],name:'每名 DP≥120% → 敌全体禍 +2',desc:'回合開始時 每存在1名DP在120%以上的我方 全體敵人的禍等級+2',hook:true},
  {id:'dp150Atk200',cat:'DP',tags:['dp'],name:'每名 DP≥150% → 全体技能攻击 +200%',desc:'行動開始時 每存在1名DP在150%以上的我方 我方全體技能攻擊力+200%',hook:true},
  // ---- Breaker
  {id:'breakerSp3',cat:'Breaker',tags:['breaker2'],name:'2 名以上 Breaker → 回合开始 SP+3',desc:'若回合開始時 有2名以上Breaker 我方全體SP+3',hook:true},
  {id:'breakerUndermine',cat:'Breaker',tags:['breaker2'],name:'2 名以上 Breaker → 敌全体蝕（永久）',desc:'若戰鬥開始時 有2名以上Breaker 賦予全體敵人蝕狀態（永久）',hook:true},
  {id:'breakerBreakDef50',cat:'Breaker',tags:['breaker'],name:'Breaker 破盾 → 敌全体防御 −50%（永久）',desc:'Breaker將敵人BREAK時 賦予全體敵人防禦力下降50%（永久）',hook:true},
  {id:'breakerBreakDp30',cat:'Breaker',tags:['breaker'],name:'Breaker 破盾 → 全体 DP 回复 30%',desc:'Breaker將敵人BREAK時 我方全體DP回復30%（可突破上限至180%）',hook:true},
  {id:'breakerOd30',cat:'Breaker',tags:['breaker'],name:'Breaker 破盾 → OD+30%',desc:'Breaker將敵人BREAK時 OD量表+30%',hook:true},
  {id:'breakerAtk200',cat:'Breaker',tags:['breaker'],name:'Breaker SP≥12 EX → 全体技能攻击 +200%',desc:'Breaker使用消耗SP12以上的EX技能時 我方全體技能攻擊力+200%（最多5次）',hook:true},
  {id:'breakerCrit100',cat:'Breaker',tags:['breaker'],name:'Breaker SP≥12 EX → 全体暴伤 +100%',desc:'Breaker使用消耗SP12以上的EX技能時 我方全體暴擊傷害值+100%（最多5次）',hook:true},
];
export const cardById=id=>CARDS.find(c=>c.id===id);
export const ZONE_ELEMENTS=['ice','light','dark'];

/** 进入下一阶段前施加选中的卡。返回下一阶段敌人的修正（如能力值下降）。 */
export function applyCard(st,id){
  const c=cardById(id);if(!c)return {};
  st.cards=new Set(st.cards||[]); // 复制：搜索里克隆出的状态共用同一个 Set
  if(c.hook)st.cards.add(c.id);
  c.apply?.(st);
  return c.nextBattle||{};
}

const zoneElems=u=>(u.skills||[]).flatMap(s=>(s.parts||[]).filter(p=>p.skillType==='Zone').flatMap(p=>(p.elements||[]).map(x=>String(x).toLowerCase())));
/**
 * 按队伍构成筛出可能有用的卡（配置优化挑卡用）。
 * 依据：Breaker 人数、Healer/Defender、主动领域技能（冰光暗）、可突破上限的 DP 回复。
 */
export function relevantCards(party){
  const roles=party.map(u=>u.role);
  const breakers=roles.filter(r=>r==='Breaker').length;
  const healers=roles.filter(r=>r==='Healer'||r==='Defender').length;
  const zones=party.flatMap(zoneElems);
  const zone=zones.some(x=>ZONE_ELEMENTS.includes(x));
  const overheal=party.some(u=>(u.skills||[]).some(s=>(s.parts||[]).some(p=>/^HealDp/.test(p.skillType||'')&&p.value?.[0]>1)));
  const ok=c=>c.tags.includes('generic')||(c.tags.includes('zone')&&zone)||(c.tags.includes('zoneAny')&&zones.length>0)
    ||(c.tags.includes('breaker')&&breakers>=1)||(c.tags.includes('breaker2')&&breakers>=2)
    ||(c.tags.includes('heal')&&healers>=1)||(c.tags.includes('dp')&&(overheal||healers>=1||breakers>=1));
  return CARDS.filter(ok).map(c=>c.id);
}
