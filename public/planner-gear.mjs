import {ownedAccessoryOptions} from './equipment.mjs';
import {membersFromDeck} from './sim/hbr/deck.mjs';

export const gearSlots={jewel:'宝玉',powerCharm:'力量吊饰',dexterityCharm:'灵巧吊饰',toughnessCharm:'体力吊饰',spiritCharm:'精神吊饰',wisdomCharm:'智慧吊饰',luckCharm:'幸运吊饰',earring:'耳环',necklace:'项链',ring:'戒指',bracelet:'手镯',soul:'灵魂书'};

const rolls=a=>JSON.stringify([a.masterId,a.main||[],a.expansion||[],a.plus||0]);

export function availableGear(members,index,slot,inventory,byId){
  const choices=ownedAccessoryOptions(slot,members[index].raw,inventory,byId);
  const used=members.flatMap((m,i)=>i===index?[]:Object.values(m.raw?.accessories||{})).filter(Boolean);
  const instances=new Set(used.filter(a=>a.instanceId!=null).map(a=>String(a.instanceId)));
  const remaining=choices.filter(a=>a.instanceId==null||!instances.has(String(a.instanceId)));
  // Older archives identify equipment only by its master and actual rolls.
  // Reserve one matching inventory piece for each such equipped item.
  for(const a of used.filter(a=>a.instanceId==null)){
    const at=remaining.findIndex(item=>rolls(item)===rolls(a));
    if(at>=0)remaining.splice(at,1);
  }
  return remaining;
}

export function changeAccessory(member,slot,item,data){
  const raw=structuredClone(member.raw);
  raw.accessories={...raw.accessories};
  if(item)raw.accessories[slot]=structuredClone(item);
  else delete raw.accessories[slot];
  if(raw.unresolvedAccessories)raw.unresolvedAccessories=raw.unresolvedAccessories.filter(s=>s!==slot);
  const [updated]=membersFromDeck({index:-1,members:[raw]},{...data,previous:[member]});
  return {...member,raw,stats:updated.stats,vitals:updated.vitals,initialSp:updated.initialSp,equipment:updated.equipment};
}

// Mount a saved style in one position. Other party members keep their items.
export function importMember(members,index,source,cache,data){
  const raw=structuredClone(source);
  raw.accessories={...raw.accessories};
  const byId=new Map(data.equipment.entries.map(item=>[Number(item.sourceId),item]));
  const team=members.map((m,i)=>i===index?{raw}:m);
  const omitted=[];
  for(const [slot,piece] of Object.entries(raw.accessories)){
    if(!piece)continue;
    const options=availableGear(team,index,slot,cache.accessories,byId);
    const item=options.find(a=>a.instanceId!=null&&a.instanceId===piece.instanceId)
      ||options.find(a=>rolls(a)===rolls(piece));
    if(item)raw.accessories[slot]=structuredClone(item);
    else{delete raw.accessories[slot];omitted.push(gearSlots[slot]||slot);}
  }
  const [member]=membersFromDeck({index:-1,members:[raw]},data);
  member.front=members[index].front;
  return {member,omitted};
}
