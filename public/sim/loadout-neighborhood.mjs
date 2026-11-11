import {accessorySlot,canEquip} from '../equipment.mjs';
import {accessoryEffects} from './hbr/deck.mjs';
import {EXPANSION,styleStatus} from './hbr/stats.mjs';
import {hasSupportResonance} from './hbr/model.mjs';

const elemental=['Ice','Fire','Thunder','Light','Dark'];
const statTypes={Power:'str',Dexterity:'dex',Toughness:'con',Spirit:'spr',Wisdom:'wis',Luck:'luk',Dp:'dp',Sp:'sp'};
const pick=(items,rng)=>items[Math.floor(rng()*items.length)];
const count=(map,id)=>map.set(id,(map.get(id)||0)+1);
export const gearRollKey=a=>JSON.stringify([Number(a.masterId),a.plus||0,a.main||[],a.expansion||[]]);

function elements(style){
  const es=style.elements||[];
  return es.includes('Void')?elemental:es.length?es:['Nonelemental'];
}
export function supportFits(main,support){
  if(!main||!support||main.id===support.id||!['SS','SSR'].includes(main.tier))return false;
  return elements(main).some(e=>elements(support).includes(e));
}

/** Older deck snapshots lack instance IDs. Match their rolled items by quantity,
 * while requiring each identified item to have exactly the rolls of that instance. */
export function accessoryValidator(inventory,byEq,byStyle){
  const known=new Map(),copies=new Map(),anonymous=new Map();
  for(const a of inventory||[]){
    const key=gearRollKey(a);
    if(a.instanceId!=null){
      const id=String(a.instanceId);if(known.has(id))continue;
      known.set(id,key);
    }else count(anonymous,key);
    count(copies,key);
  }
  return raws=>{
    const used=new Map(),ids=new Set(),old=new Map();
    for(const r of raws)for(const [slot,a] of Object.entries(r.accessories||{})){
      if(!a)continue;
      const e=byEq.get(Number(a.masterId)),expected=accessorySlot(e);
      if(e&&(!canEquip(e,{styleId:r.styleId,characterId:byStyle.get(r.styleId)?.characterId})||
        (expected&&expected!=='other'&&expected!==slot)))return false;
      const key=gearRollKey(a);
      if(a.instanceId!=null){
        const id=String(a.instanceId);
        if(ids.has(id))return false;
        ids.add(id);
        if(copies.size&&known.get(id)!==key){
          if(known.has(id))return false;
          count(old,key);if(old.get(key)>(anonymous.get(key)||0))return false;
        }
      }
      if(copies.size){count(used,key);if(used.get(key)>(copies.get(key)||0))return false;}
    }
    return true;
  };
}

function equippedModules(raws){
  const counts=new Map();
  for(const r of raws)for(const id of [r.boosterId,...(r.sphereIds||[])])if(id)count(counts,Number(id));
  return counts;
}
function accessoryStats(a,entry){
  const values={};
  for(const f of accessoryEffects(entry,a.main)){
    const k=statTypes[f.type];
    if(k)values[k]=(values[k]||0)+(Number(f.value?.[0])||0);
  }
  for(const id of a.expansion||[]){
    const roll=EXPANSION[id];if(roll)values[roll[0]]=(values[roll[0]]||0)+roll[1];
  }
  if(entry.slot==='soul')for(const k of ['str','dex','con','spr','wis','luk'])values[k]=5+4*(a.plus||0)+(values[k]||0);
  return values;
}
function selectOption(options,rng,values){
  // Sample the whole set as well as items leading a randomly chosen stat.
  // The fight determines which direction to retain; skill/role tags cannot preselect it.
  if(options.length<2||rng()<0.35)return pick(options,rng);
  const k=pick(Object.values(statTypes),rng);
  const best=Math.max(...options.map(x=>values(x)?.[k]||0));
  return pick(options.filter(x=>(values(x)?.[k]||0)===best),rng);
}

export function createLoadoutNeighborhood({data,cache={},baseRaws=[],archive}){
  const byStyle=new Map(data.catalog.styles.map(s=>[s.id,s]));
  const byEq=new Map((data.equipment.entries||[]).map(e=>[Number(e.sourceId),e]));
  const decks=[baseRaws,...(cache.decks||[]).map(d=>d.members)].map(ms=>ms.filter(Boolean));
  const checkedGear=accessoryValidator(cache.accessories,byEq,byStyle);
  const gear=new Map(),supportPool=new Map(),supportStats=new Map(),previousSupports=new Map();
  const inventory=cache.gameInventory?.entries||archive?.gameInventory?.entries;
  const modules=new Map();
  if(cache.moduleCounts){
    for(const [id,n] of Object.entries(cache.moduleCounts))if(n>0&&['booster','chip'].includes(byEq.get(Number(id))?.slot))modules.set(Number(id),n);
  }else if(inventory){
    for(const [id,e] of byEq)if(['booster','chip'].includes(e.slot)&&inventory[e.id]?.count>0)modules.set(id,inventory[e.id].count);
  }else{
    // Two saved decks can describe the same physical inventory.
    for(const d of decks)for(const [id,n] of equippedModules(d))modules.set(id,Math.max(n,modules.get(id)||0));
  }
  for(const d of decks)for(const m of d){
    if(m.styleId)supportPool.set(m.styleId,m);
    if(m.support?.styleId)supportPool.set(m.support.styleId,m.support);
    if(m.styleId&&m.supportStyleId){
      if(!previousSupports.has(m.styleId))previousSupports.set(m.styleId,new Set());
      previousSupports.get(m.styleId).add(m.supportStyleId);
    }
  }
  for(const c of cache.cards||[])if(c.styleId)supportPool.set(c.styleId,c);
  for(const a of cache.accessories||[]){
    const e=byEq.get(Number(a.masterId)),slot=accessorySlot(e);if(!slot||slot==='other')continue;
    if(!gear.has(slot))gear.set(slot,[]);
    gear.get(slot).push({a,e,key:gearRollKey(a),stats:accessoryStats(a,e)});
  }
  function legalSupports(raws){
    const used=new Set(raws.map(r=>r.styleId));
    for(const r of raws){
      const id=r.supportStyleId;if(!id){if(r.support?.styleId)return false;continue;}
      if(used.has(id)||!supportPool.has(id)||!supportFits(byStyle.get(r.styleId),byStyle.get(id)))return false;
      if(r.support&&r.support.styleId!==id)return false;
      const lb=supportPool.get(id).limitBreak;
      if(lb!=null&&Number(r.supportLimitBreak||0)>Number(lb))return false;
      used.add(id);
    }
    return true;
  }
  function legalModules(raws){
    for(const r of raws){
      const chips=r.sphereIds||[],booster=byEq.get(Number(r.boosterId));
      if(r.boosterId&&booster?.slot!=='booster')return false;
      if(chips.length>(booster?.chipSlots||0)||chips.some(id=>byEq.get(Number(id))?.slot!=='chip'))return false;
    }
    for(const [id,n] of equippedModules(raws))if(n>(modules.get(id)||0))return false;
    return true;
  }
  const valid=raws=>checkedGear(raws)&&legalModules(raws)&&legalSupports(raws);
  const report=(r,desc)=>[...(r._changes||[]),desc].slice(-6);
  function withSupport(r,source){
    const styleId=source?.styleId??null,lb=source?.limitBreak??null;
    const support=source?{styleId,limitBreak:lb,card:source.card,character:source.character,characterCards:source.characterCards}:null;
    return {...r,supportStyleId:styleId,supportLimitBreak:lb,support,_changes:report(r,'支援 '+(byStyle.get(styleId)?.name||'卸下'))};
  }
  function statsOfSupport(c){
    if(!supportStats.has(c.styleId)){
      const value=data.stats?.characters&&data.stats?.styles?styleStatus(c,data.stats,data.catalog)?.value:null;
      supportStats.set(c.styleId,value||{});
    }
    return supportStats.get(c.styleId);
  }
  function equipPersonal(r){
    const owner={styleId:r.styleId,characterId:byStyle.get(r.styleId)?.characterId};
    let out=r;
    for(const slot of ['soul','jewel']){
      if(out.accessories?.[slot])continue;
      const compatible=(gear.get(slot)||[]).filter(x=>(x.e.styleId||x.e.characterId)&&canEquip(x.e,owner));
      const value=x=>(x.a.plus||0)+(x.stats.dp||0)/20+Object.entries(x.stats).reduce((sum,[k,n])=>sum+(k==='dp'?0:n),0);
      const best=compatible.reduce((best,x)=>!best||value(x)>value(best)?x:best,null);
      if(best)out={...out,accessories:{...out.accessories,[slot]:best.a},_changes:report(out,'装备 '+best.e.name)};
    }
    return out;
  }
  function repairSupports(raws){
    const used=new Set(raws.map(r=>r.styleId)),needs=[];
    const out=raws.map((r,i)=>{
      const id=r.supportStyleId;
      if(id&&!used.has(id)&&supportPool.has(id)&&supportFits(byStyle.get(r.styleId),byStyle.get(id))){used.add(id);return r;}
      if(id||r._new)needs.push(i);
      return id||r.support?withSupport(r,null):r;
    });
    // First reserve every legal incumbent. A replacement cannot displace the
    // next member's support simply because its slot appears earlier in the deck.
    for(const i of needs){
      const r=out[i],main=byStyle.get(r.styleId);
      const eligible=c=>!used.has(c.styleId)&&supportFits(main,byStyle.get(c.styleId));
      let source=[...(previousSupports.get(r.styleId)||[])].map(id=>supportPool.get(id)).find(c=>c&&eligible(c));
      if(!source){
        const matching=[...supportPool.values()].filter(eligible);
        const strength=c=>{const s=statsOfSupport(c);return ['str','dex','con','spr','wis','luk'].reduce((sum,k)=>sum+(s[k]||0),0);};
        const resonant=(main?.tier==='SSR'||r.card?.resonanceShift)&&matching.filter(c=>data.stats?.styles?.[c.styleId]?.resonance);
        const list=resonant?.length?resonant:matching;
        source=list.reduce((best,c)=>!best||strength(c)>strength(best)?c:best,null);
      }
      if(source){out[i]=withSupport(r,source);used.add(source.styleId);}
    }
    return out;
  }
  function supportChange(raws,i,rng){
    const r=raws[i],main=byStyle.get(r.styleId),reserved=new Set(raws.map(r=>r.styleId));
    const options=[...supportPool.values()].filter(c=>c.styleId!==r.supportStyleId&&!reserved.has(c.styleId)&&supportFits(main,byStyle.get(c.styleId)));
    const resonant=hasSupportResonance(main,r.card?.resonanceShift)&&options.filter(c=>data.stats?.styles?.[c.styleId]?.resonance);
    const c=selectOption(resonant?.length&&rng()<0.55?resonant:options,rng,statsOfSupport);
    if(!c)return null;
    const out=raws.slice(),j=raws.findIndex(m=>m.supportStyleId===c.styleId);
    out[i]=withSupport(r,c);
    if(j!==-1){
      const previous=byStyle.get(r.supportStyleId);
      out[j]=withSupport(raws[j],supportFits(byStyle.get(raws[j].styleId),previous)?supportPool.get(previous.id):null);
    }
    return out;
  }
  function gearChange(raws,i,rng){
    const r=raws[i],owner={styleId:r.styleId,characterId:byStyle.get(r.styleId)?.characterId};
    const slots=[...gear.keys()];
    while(slots.length){
      const slot=slots.splice(Math.floor(rng()*slots.length),1)[0],old=r.accessories?.[slot];
      const oldKey=old&&gearRollKey(old),options=gear.get(slot).filter(x=>x.key!==oldKey&&canEquip(x.e,owner));
      if(!options.length)continue;
      const rolls=new Map();
      for(const item of options)if(!rolls.has(item.key))rolls.set(item.key,item);
      let x=selectOption([...rolls.values()],rng,x=>x.stats);
      const heldIds=new Set(raws.flatMap(m=>m.accessories?.[slot]?.instanceId!=null?[String(m.accessories[slot].instanceId)]:[]));
      x=options.find(y=>y.key===x.key&&y.a.instanceId!=null&&!heldIds.has(String(y.a.instanceId)))||x;
      const out=raws.slice();
      out[i]={...r,accessories:{...r.accessories,[slot]:x.a},_changes:report(r,'装备 '+x.e.name)};
      if(checkedGear(out))return out;
      for(let j=0;j<out.length;j++){
        const donor=raws[j],held=donor.accessories?.[slot];
        if(j===i||!held||gearRollKey(held)!==x.key)continue;
        if(x.a.instanceId!=null&&held.instanceId!=null&&String(x.a.instanceId)!==String(held.instanceId))continue;
        const acc={...donor.accessories};
        if(old&&canEquip(byEq.get(Number(old.masterId)),{styleId:donor.styleId,characterId:byStyle.get(donor.styleId)?.characterId}))acc[slot]=old;
        else delete acc[slot];
        out[j]={...donor,accessories:acc,_changes:report(donor,'调出 '+x.e.name)};
        if(checkedGear(out))return out;
        out[j]=donor;
      }
    }
    return null;
  }
  const moduleStats=new Map([...modules.keys()].map(id=>[id,accessoryStats({},byEq.get(id)||{})]));
  function moduleChange(raws,i,rng,kind){
    const r=raws[i],chips=(r.sphereIds||[]).slice(),slots=byEq.get(Number(r.boosterId))?.chipSlots||0;
    if(kind==='chip'&&!slots)return null;
    const k=kind==='chip'?Math.floor(rng()*Math.min(chips.length+1,slots)):0;
    const old=kind==='booster'?r.boosterId:chips[k],used=equippedModules(raws);
    const options=[...modules.keys()].filter(id=>byEq.get(id)?.slot===kind&&id!==old&&
      (kind==='booster'||(used.get(id)||0)<modules.get(id)||raws.some((r,j)=>j!==i&&r.sphereIds?.includes(id))));
    const id=selectOption(options,rng,id=>moduleStats.get(id));if(!id)return null;
    const out=raws.slice(),desc=byEq.get(id).name;
    if(kind==='booster')out[i]={...r,boosterId:id,sphereIds:chips.slice(0,byEq.get(id).chipSlots),_changes:report(r,'增幅器 '+desc)};
    else {chips[k]=id;out[i]={...r,sphereIds:chips,_changes:report(r,'芯片 '+desc)};}
    if((used.get(id)||0)>=modules.get(id)){
      const j=raws.findIndex((m,j)=>j!==i&&(kind==='booster'?m.boosterId===id:m.sphereIds?.includes(id)));
      if(j<0)return null;
      const donor=raws[j];
      if(kind==='booster')out[j]={...donor,boosterId:old||null,sphereIds:(donor.sphereIds||[]).slice(0,byEq.get(Number(old))?.chipSlots||0),_changes:report(donor,'调出 '+desc)};
      else {const rest=donor.sphereIds.slice(),index=rest.indexOf(id);if(old)rest[index]=old;else rest.splice(index,1);out[j]={...donor,sphereIds:rest,_changes:report(donor,'调出 '+desc)};}
    }
    return out;
  }
  function propose(raws,rng,requestedKind){
    const kinds=requestedKind?[requestedKind]:['equipment','equipment','support','booster','chip'];
    // Try each member before giving up on an unavailable category.
    while(kinds.length){
      const kind=kinds.splice(Math.floor(rng()*kinds.length),1)[0],start=Math.floor(rng()*raws.length);
      for(let n=0;n<raws.length;n++){
        const i=(start+n)%raws.length;
        const out=kind==='equipment'?gearChange(raws,i,rng):kind==='support'?supportChange(raws,i,rng):moduleChange(raws,i,rng,kind);
        if(out&&valid(out))return {raws:out,kind};
      }
    }
    return null;
  }
  return {propose,valid,repairSupports,equipPersonal};
}
