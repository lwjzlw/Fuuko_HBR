import {ATTACK_PART_TYPES,elementOf} from './hbr/model.mjs';

const families={
  AttackUp:'attack',AttackUpIncludeNormal:'attack',MindEye:'eye',BuffCharge:'charge',Funnel:'hits',
  CriticalRateUp:'crit',CriticalDamageUp:'critDamage',DefenseDown:'defense',DpDefenseDown:'shield',
  Fragile:'fragile',ResistDown:'resist',Zone:'field',AdditionalTurn:'extra',DoubleActionExtraSkill:'extra',
  HealSp:'sp',OverDrivePointUp:'od',SpecialCommandCountUp:'command'
};
const peak=(map,key,value)=>map.set(key,Math.max(value,map.get(key)||0));

function profile(entry,available){
  const attack=new Map(),support=new Map(),self=new Map();
  function visit(skill,weight=1){
    const cost=Math.max(0,skill.sp||0),discount=weight/(1+cost/32);
    for(const p of skill.parts||[]){
      const type=p.skillType,el=elementOf(p),power=Math.max(0,...(p.power||[]));
      if(ATTACK_PART_TYPES.has(type)&&power>0&&type!=='AttackNormal'){
        const aoe=p.targetType==='All'?1.18:1,hit=Math.min(1.16,1+(skill.hitCount||1)*.015);
        const dmg=Math.log1p(power/1000)*aoe*hit*discount;
        peak(attack,el,dmg);
      }
      const family=type==='DefenseDown'&&p.multipliers?.hp===0&&p.multipliers?.dp>0?'shield':families[type];
      if(family&&power>0){
        let strength=power;
        if(family==='hits')strength*=p.value?.[0]||0;
        if(family==='field'&&power>1)strength=power-1;
        if(family==='sp')strength/=5;
        if(family==='command')strength=Math.log1p(power);
        const shared=p.targetType!=='Self'||['od','command'].includes(family);
        const recipient=shared?support:self;
        peak(recipient,family+'|'+(el==='nonelemental'?'*':el),Math.min(3,strength)*discount);
      }
      for(const b of p.branches||[])visit(b,discount*(type==='SpecialCommandCountUp'?1:.7));
    }
  }
  for(const skill of available){
    if(skill.consume&&!['Sp','Ep'].includes(skill.consume))continue;
    const s=skill.passive?.parts?.length?skill.passive:skill;
    visit(s,s.condition||s.cond?0.65:1);
  }
  return {...entry,attack,support,self};
}

/** Candidate construction only. Bounds, status conditions, SP and damage
 * remain subject to normal legal/loadout checks, beam search and replay. */
export function synergyTeams(pool,skills,{elements=[],count=4,rng=Math.random,owned}={}){
  const byChar=new Map();
  for(const entry of pool){
    const id=entry.s.characterId;
    if(!byChar.has(id))byChar.set(id,new Set());
    byChar.get(id).add(entry.c.styleId);
  }
  for(const [char,ids] of owned||[])if(byChar.has(char))for(const id of ids)byChar.get(char).add(id);
  const members=pool.map(entry=>{
    const style=skills.styles[entry.c.styleId]||{},available=new Map();
    for(const id of byChar.get(entry.s.characterId))for(const s of skills.styles[id]?.skills||[]){
      if(id===entry.c.styleId||!s.restricted)available.set(s.label,s);
    }
    const passives=(style.passives||[]).filter(s=>s.step==null||s.step<=(entry.c.limitBreak||0));
    return profile(entry,[...available.values(),...passives]);
  });
  const result=[],usedAnchors=new Map();
  for(let i=0;i<count;i++){
    const requested=elements.length?elements[i%elements.length]:null;
    const anchors=members.flatMap(m=>[...m.attack].filter(([el])=>!requested||el===requested).map(([el,power])=>{
      const self=[...m.self].filter(([k])=>k.endsWith('|*')||k.endsWith('|'+el)).reduce((v,[,n])=>v+n,0);
      const value=power*(1+Math.min(.5,self*.08))*(.9+rng()*.2)/(1+(usedAnchors.get(m.s.characterId)||0)*.65);
      return {m,el,value};
    })).sort((a,b)=>b.value-a.value);
    if(!anchors.length)continue;
    const {m:anchor,el}=anchors[0];usedAnchors.set(anchor.s.characterId,(usedAnchors.get(anchor.s.characterId)||0)+1);
    const team=[anchor],chars=new Set([anchor.s.characterId]),coverage=new Map();
    const relevant=m=>[...m.support].filter(([k])=>k.endsWith('|*')||k.endsWith('|'+el));
    for(const [k,v] of relevant(anchor))peak(coverage,k,v);
    while(team.length<6){
      const adm=team.some(m=>m.s.role==='Admiral');
      let best=null,high=-Infinity;
      for(const m of members){
        if(chars.has(m.s.characterId)||adm&&m.s.role==='Admiral')continue;
        const gain=relevant(m).reduce((v,[k,n])=>v+Math.max(0,n-(coverage.get(k)||0))+.15*n,0);
        const attack=m.attack.get(el)||0;
        const score=(gain+attack*(team.length===2?.35:.12)+(m.c.limitBreak||0)*.025)*(.88+.24*rng());
        if(score>high){best=m;high=score;}
      }
      if(!best)break;
      team.push(best);chars.add(best.s.characterId);
      for(const [k,v] of relevant(best))peak(coverage,k,v);
    }
    if(team.length===6)result.push({cards:team.map(m=>m.c),element:el});
  }
  return result;
}
