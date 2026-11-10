export const SCHEMA = 1;
export function emptyArchive(){return {schemaVersion:SCHEMA,assumptions:{allOrbSkillsOwned:true,equipmentFunctionMax:true,equipmentFixedMax:true,equipmentAdjustableMax:true,checkEquipmentInventory:false},roster:[],items:[],loadouts:[
  {id:'preset-main',name:'指定属性拉满',type:'main',mainStat:'力量',odEarring:false,itemIds:[],notes:'按角色和技能选择主属性，默认使用可行满值；装备数值表待接入。'},
  {id:'preset-defense',name:'全精体',type:'defense',mainStat:'',odEarring:false,itemIds:[],notes:'精神、体力优先；用于检验生存约束。'},
  {id:'preset-od',name:'主属性 + OD 耳环',type:'main',mainStat:'力量',odEarring:true,itemIds:[],notes:'主属性取向，耳环使用 OD 类型。'},
  {id:'preset-defense-od',name:'全精体 + OD 耳环',type:'defense',mainStat:'',odEarring:true,itemIds:[],notes:'精神、体力优先，耳环使用 OD 类型。'}
],team:Array.from({length:6},()=>({styleId:'',loadoutId:''})),notes:''};}
export function validateArchive(a){
  if(!a || a.schemaVersion !== SCHEMA) throw Error('备份版本不支持，原档案未更改。');
  for(const key of ['roster','items','loadouts']) {
    if(!Array.isArray(a[key]) || a[key].length>5000) throw Error(`${key} 格式不正确。`);
    const ids = new Set();
    for(const x of a[key]) {if(!x || typeof x.id!=='string' || !x.id || ids.has(x.id) || typeof x.name!=='string') throw Error(`${key} 存在无效或重复 ID。`); ids.add(x.id);}
  }
  if(!Array.isArray(a.team)||a.team.length!==6) throw Error('队伍应包含六个位置。');
  const styles = new Set(a.roster.map(x=>x.id)), items = new Set(a.items.map(x=>x.id)), loadouts=new Set(a.loadouts.map(x=>x.id));
  for(const c of a.roster) {
    if(typeof c.character!=='string' || !c.character.trim()) throw Error('每个卡面都需要角色名。');
    for(const k of ['level','limitBreak']) if(c[k]!==null && c[k]!==undefined && (!Number.isFinite(c[k])||c[k]<0)) throw Error('等级或突破数不正确。');
    if(c.stats && (typeof c.stats!=='object'||Array.isArray(c.stats))) throw Error('面板格式不正确。');
    for(const v of Object.values(c.stats||{})) if(v!==null && (!Number.isFinite(v)||v<0)) throw Error('面板必须是非负数字或留空。');
  }
  for(const x of a.items) if(!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>999) throw Error('装备数量应为 1–999。');
  for(const l of a.loadouts) if(!Array.isArray(l.itemIds)||l.itemIds.some(id=>!items.has(id))||new Set(l.itemIds).size!==l.itemIds.length) throw Error('配装引用了无效或重复装备。');
  for(const t of a.team) if(!t||typeof t.styleId!=='string'||typeof t.loadoutId!=='string'||(t.styleId&&!styles.has(t.styleId))||(t.loadoutId&&!loadouts.has(t.loadoutId))) throw Error('队伍引用了不存在的卡面或配装。');
  return a;
}
export function checkTeam(a){
  const issues=[], characters=new Set(), used=new Map();
  for(let i=0;i<6;i++) {
    const s=a.team[i], c=a.roster.find(x=>x.id===s.styleId);
    if(!c){issues.push(`位置 ${i+1} 尚未选卡面`);continue;}
    const key=c.character.normalize('NFKC').trim().toLocaleLowerCase();
    if(characters.has(key)) issues.push(`角色「${c.character}」重复出场`); characters.add(key);
    if(!c.name.trim()) issues.push(`位置 ${i+1} 缺卡面名`);
    const profile=a.loadouts.find(x=>x.id===s.loadoutId);
    for(const id of profile?.itemIds||[]) used.set(id,(used.get(id)||0)+1);
  }
  if(a.assumptions?.checkEquipmentInventory) for(const [id,count] of used){const item=a.items.find(x=>x.id===id);if(item && count>item.quantity) issues.push(`「${item.name}」需 ${count} 件，档案只有 ${item.quantity} 件`);}
  return issues;
}
export function mergeArchive(current,incoming){
  validateArchive(incoming);
  const result=structuredClone(current), maps={};
  for(const key of ['roster','items','loadouts']) {maps[key]=new Map(incoming[key].map(x=>[x.id,crypto.randomUUID()]));}
  for(const key of ['roster','items','loadouts']) for(const x of incoming[key]) {
    const copy=structuredClone(x); copy.id=maps[key].get(x.id);
    if(key==='loadouts') copy.itemIds=copy.itemIds.map(id=>maps.items.get(id));
    result[key].push(copy);
  }
  return validateArchive(result);
}
