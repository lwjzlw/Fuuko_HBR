import {validateSoulEnhancement} from './soul.mjs';
export function validateCatalog(c){
  if(c?.schemaVersion!==1||!c.version)throw Error('角色数据库格式不支持');
  for(const k of ['characters','styles','latentAbilities']){if(!Array.isArray(c[k])||new Set(c[k].map(x=>x.id)).size!==c[k].length)throw Error('角色数据库 ID 重复或格式错误');}
  const chars=new Set(c.characters.map(x=>x.id));if(c.styles.some(s=>!chars.has(s.characterId)))throw Error('卡面缺少所属角色');return c;
}
export async function loadCatalog(){const response=await fetch('/data/catalog.json',{cache:'no-store'});if(!response.ok)throw Error('角色数据库未能加载');return validateCatalog(await response.json());}
export const roles={Attacker:'输出',Breaker:'破盾',Blaster:'破坏',Buffer:'增益',Debuffer:'减益',Healer:'恢复',Defender:'防御',Admiral:'指挥'};
export const elements={Fire:'火',Ice:'冰',Thunder:'雷',Light:'光',Dark:'暗'};
export const attacks={Slash:'斩',Stab:'突',Strike:'打'};
export function eligibleLatents(catalog,style){return catalog.latentAbilities.filter(l=>!l.characterId||l.characterId===style.characterId);}
export function ownedStyles(catalog,archive){return catalog.styles.filter(s=>archive.styles[s.id]?.owned);}
export function characterProgress(archive,id){return {level:null,reincarnation:null,rank:null,masterSkillUnlocked:null,latentPoolMode:'unknown',availableLatentIds:[],notes:'',...archive.characters[id]};}
export function styleProgress(archive,id){return {owned:false,cardLevel:null,limitBreak:null,bloomed:null,soulBook:null,soulBookLevel:null,latentSlots:[null,null,null],skillLevels:{},training:{},notes:'',...archive.styles[id]};}
export function validateStyleProgress(catalog,style,progress,{checkLatentSlots=true}={}){
  const maxBreak=Math.max(...style.limitBreakSteps.map(x=>x.step));
  if(progress.limitBreak!==null&&progress.limitBreak!==undefined&&progress.limitBreak>maxBreak)throw Error(`该卡面数据库的突破范围是 0–${maxBreak}`);
  if(progress.soulBookLevel!=null){if(!style.soulBook)throw Error('该卡面没有灵魂书记录');validateSoulEnhancement(progress.soulBookLevel);}
  const selected=checkLatentSlots?(progress.latentSlots||[]).filter(Boolean):[], allowed=new Set(eligibleLatents(catalog,style).map(x=>x.id));
  if(new Set(selected).size!==selected.length)throw Error('同一潜在能力不能重复选择');
  for(const id of selected){if(!allowed.has(id))throw Error('潜在能力不适用于此角色');const ability=catalog.latentAbilities.find(x=>x.id===id);if(ability.exclusiveIds.some(x=>selected.includes(x)))throw Error(`「${ability.name}」与另一已选潜在能力互斥`);}
  for(const [id,level] of Object.entries(progress.skillLevels||{})){const skill=style.skills.find(s=>s.id===id);if(skill&&level!==null&&level>skill.maxLevel)throw Error(`「${skill.name}」数据库等级上限为 ${skill.maxLevel}`);}
  for(const [id,value] of Object.entries(progress.training||{})){const group=style.trainingGroups.find(g=>g.id===id);if(group&&Array.isArray(value)&&value.some(node=>!group.nodes.some(n=>n.id===node)))throw Error('强化节点与数据库不匹配，请检查记录');}
}
