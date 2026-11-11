// 排轴器的队伍配置：档案（突破、技能等级、同角色已持有卡面）+ 用户填写的最终面板。
import {STATS} from './hbr/rules.mjs';

export const STAT_LABEL={str:'力量',dex:'灵巧',con:'体力',spr:'精神',wis:'智慧',luk:'运气'};

export function emptyPlanner(){
  return {members:Array.from({length:6},(_,i)=>({styleId:'',stats:{},front:i<3})),settings:{}};
}

/** 档案里的 planner 字段校验（可选字段；不合法时抛错，由 validateArchive 调用）。 */
export function validatePlanner(p){
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  if(!object(p)||!Array.isArray(p.members)||p.members.length!==6)throw Error('排轴器配置需要六个位置');
  for(const m of p.members){
    if(!object(m)||typeof m.styleId!=='string')throw Error('排轴器成员格式无效');
    if(m.stats!==undefined){
      if(!object(m.stats))throw Error('排轴器面板格式无效');
      for(const [k,v] of Object.entries(m.stats)){if(!STATS.includes(k))throw Error('未知面板属性 '+k);if(v!==null&&(!Number.isInteger(v)||v<0||v>99999))throw Error('面板数值应为 0–99999 的整数');}
    }
    if(m.front!==undefined&&typeof m.front!=='boolean')throw Error('排轴器前后排格式无效');
    if(m.initialSp!==undefined&&(!Number.isFinite(m.initialSp)||m.initialSp<0||m.initialSp>99))throw Error('初期 SP 无效');
    if(m.equipment!==undefined&&(m.equipment===null||typeof m.equipment!=='object'||Array.isArray(m.equipment)))throw Error('装备格式无效');
    if(m.statsManual!==undefined&&(!Array.isArray(m.statsManual)||m.statsManual.some(k=>!STATS.includes(k))))throw Error('面板手改记录无效');
    if(m.raw!==undefined&&(m.raw===null||typeof m.raw!=='object'||Array.isArray(m.raw)))throw Error('编队原始数据无效');
    if(m.vitals!=null&&(typeof m.vitals!=='object'||Array.isArray(m.vitals)))throw Error('DP/HP 格式无效');
    if(m.deckSkillIds!==undefined&&(!Array.isArray(m.deckSkillIds)||m.deckSkillIds.some(x=>!Number.isInteger(x))))throw Error('编队技能格式无效');
  }
  if(p.settings!==undefined&&!object(p.settings))throw Error('排轴器设置格式无效');
  function validateDesigns(designs){
    if(designs!==undefined&&!object(designs))throw Error('排轴设计格式无效');
    for(const d of Object.values(designs||{}))if(!object(d)||!Array.isArray(d.phases))throw Error('排轴设计格式无效');
  }
  validateDesigns(p.designs);
  if(p.partyDesigns!==undefined){
    if(!object(p.partyDesigns))throw Error('配队排轴记录格式无效');
    for(const saved of Object.values(p.partyDesigns)){
      if(!object(saved)||!object(saved.best))throw Error('配队排轴记录格式无效');
      validateDesigns(saved.designs);
    }
  }
  return p;
}

/** 由角色等级线性估算的基础面板（未含装备、能力树、潜在、宝珠），只作占位。 */
export function estimateStats(catalog,styleId,archive){
  const style=catalog.styles.find(s=>s.id===styleId);if(!style)return {};
  const char=catalog.characters.find(c=>c.id===style.characterId);
  const lv=archive?.characters?.[style.characterId]?.level||char?.baseParameters?.level?.[1]||1;
  const [l0,l1]=char?.baseParameters?.level||[1,200];
  const t=l1>l0?(lv-l0)/(l1-l0):1;
  const out={};
  for(const k of STATS){
    const r=char?.baseParameters?.[k]||[0,0];
    out[k]=Math.round(r[0]+(r[1]-r[0])*Math.max(0,Math.min(1,t))+(style.baseParameters?.[k]||0));
  }
  return out;
}

/** planner 配置 → buildParty 所需的 members。返回 {members, issues}。 */
export function membersFrom(planner,archive,catalog){
  const issues=[];
  const styles=archive?.styles||{};
  const members=planner.members.map((m,i)=>{
    if(!m.styleId){issues.push(`第 ${i+1} 位未选卡面`);return null;}
    const style=catalog.styles.find(s=>s.id===m.styleId);
    if(!style){issues.push(`第 ${i+1} 位卡面不在目录里`);return null;}
    const char=catalog.characters.find(c=>c.id===style.characterId);
    const sameChar=char?.styleIds||[];
    const owned=sameChar.filter(id=>styles[id]?.owned);
    // 技能等级：同角色各卡记录的最大值；没有记录时用技能满级
    const skillLevels={};
    for(const id of sameChar)for(const [label,lv] of Object.entries(styles[id]?.skillLevels||{}))skillLevels[label]=Math.max(skillLevels[label]||0,lv);
    const filled=STATS.filter(k=>Number.isInteger(m.stats?.[k]));
    if(filled.length<STATS.length)issues.push(`第 ${i+1} 位 ${char?.name||''} 面板未填全（${STATS.length-filled.length} 项用等级粗估，偏低；建议从游戏编队导入以推算面板）`);
    const est=filled.length<STATS.length?estimateStats(catalog,m.styleId,archive):{};
    return {
      styleId:m.styleId,front:!!m.front,resonanceShift:m.raw?.card?.resonanceShift===true,
      limitBreak:m.limitBreak??styles[m.styleId]?.limitBreak??0,
      stats:Object.fromEntries(STATS.map(k=>[k,Number.isInteger(m.stats?.[k])?m.stats[k]:est[k]||0])),
      skillLevels,
      extraStyleIds:owned.length?owned:sameChar,
      // 来自游戏编队（membersFromDeck）的装备、初期 SP、泪、编队技能；手动配队时为空
      initialSp:Number(m.initialSp)||0,tearLevel:Number(m.tearLevel)||0,equipment:m.equipment||{},deckSkillIds:m.deckSkillIds||[],strictDeckSkills:!!m.strictDeckSkills,allOrbSkills:!!m.allOrbSkills,latentIds:m.raw?.latentIds||[],
      vitals:m.vitals||null,supportStyleId:m.supportStyleId||m.raw?.supportStyleId||null,supportLimitBreak:m.supportLimitBreak??m.raw?.supportLimitBreak??null,
    };
  });
  const fronts=planner.members.filter(m=>m.styleId&&m.front).length;
  if(fronts!==3&&members.every(Boolean))issues.push(`开场前排需要 3 人（当前 ${fronts} 人），影响“开场时位于前卫”类被动`);
  const chars=members.filter(Boolean).map(m=>catalog.styles.find(s=>s.id===m.styleId)?.characterId);
  if(new Set(chars).size!==chars.length)issues.push('同一角色出现了两次');
  return {members,issues,ready:members.every(Boolean)&&new Set(chars).size===chars.length};
}
