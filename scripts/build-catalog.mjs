import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const input=path.resolve(process.argv[2]||path.join(root,'work/catalog-research'));
const names=['characters','styles','zhTW','latent_abilities','support_skills','accessories'];
const sources=names.map(name=>{const bytes=fs.readFileSync(path.join(input,name+'.json'));return {table:name,url:`https://master.hbr.quest/v1/${name}.json`,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};});
const raw=Object.fromEntries(names.map(name=>[name,JSON.parse(fs.readFileSync(path.join(input,name+'.json'),'utf8'))]));
const translations=raw.zhTW;
const tr=(group,field,id,fallback='')=>translations[group]?.[field]?.[id]||fallback;
const characterIds=new Set(raw.styles.map(s=>s.chara_label));
const localizedCharacter=c=>['lastname','middlename','firstname'].map(k=>tr('character',k,c.label)).filter(Boolean).join('')||c.name.split(' — ')[0];
const asset=(family,name)=>name?{path:`/assets/hbr/${family}/${name}`,sourceUrl:`https://cdn.hbr.quest/webp/jp/${family}/${name}`} : null;
const skill=sk=>({id:sk.label,sourceId:sk.id,name:tr('skill','name',sk.label,sk.name),nameJa:sk.name,sp:sk.sp_cost,consumeType:sk.consume_type,uses:sk.use_count,maxLevel:sk.max_level,hits:sk.hit_count,restricted:!!sk.is_restricted,condition:sk.cond||'',description:tr('skill','info',sk.label,sk.desc)});
const passive=(p,step=null,source='base')=>({id:p.label,sourceId:p.id,name:tr('passiveskill','name',p.label,p.name),nameJa:p.name,description:tr('passiveskill','description',p.label,p.desc),timing:p.timing,condition:p.condition,step,source});
const characters=raw.characters.filter(c=>characterIds.has(c.label)).map(c=>({id:c.label,sourceId:c.id,name:localizedCharacter(c),nameJa:c.name.split(' — ')[0],aliases:c.name.split(' — ').filter(Boolean),team:c.team,portrait:asset('chara_icon',c.image),styleIds:raw.styles.filter(s=>s.chara_label===c.label).map(s=>s.label),baseParameters:c.base_param,reincarnationType:c.reincarnation,masterSkill:c.masterly?.skill?skill(c.masterly.skill):null,sourceUrl:`https://hbr.quest/characters/${c.label}`}));
const styles=raw.styles.map(s=>({
  id:s.label,sourceId:s.id,characterId:s.chara_label,name:tr('card','name',s.label,s.name),nameJa:s.name,hasTranslation:!!tr('card','name',s.label),tier:s.tier,role:s.role,attackType:s.type,elements:s.elements,team:s.team,releaseDate:s.in_date,
  portrait:asset('card',s.image),artwork:asset('card',s.bg),baseParameters:s.base_param,skills:s.skills.map(skill),generalizable:!!s.generalize,
  limitBreakSteps:s.limit_break.bonus_per_level.map(b=>({step:b.step,levelCap:b.level_cap,passiveIds:b.bonus.filter(p=>p.category==='Passive').map(p=>p.label)})),
  passives:[...s.passives.map(p=>passive(p)),...s.limit_break.bonus_per_level.flatMap(b=>b.bonus.filter(p=>p.category==='Passive').map(p=>passive(p,b.step,'limitBreak')))],
  trainingGroups:s.ability_tree.map(t=>({id:t.label,name:tr('abilitytreepart','categoryname',t.label,t.name),nodes:t.ability_list.map((a,i)=>({id:t.label+':'+crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex').slice(0,12)+':'+t.ability_list.slice(0,i).filter(b=>JSON.stringify(a)===JSON.stringify(b)).length,type:a.type,value:a.value,valueType:a.value_type,exclusive:a.is_exclusive,skillId:a.skill,requires:a.requires}))})),
  soulBook:(()=>{const b=raw.accessories.find(a=>a.label==='Acc.Soul.'+s.label);return b?{id:b.label,sourceId:b.id,name:tr('accessory','name',b.label,b.name),maxLevel:5,enhancementCap:5,sourceMaxLv:b.max_lv,description:tr('accessory','text',b.label,b.text)}:null;})(),
  resonanceGroup:s.resonance||null,sourceUrl:`https://hbr.quest/characters/${s.chara_label}`
}));
const latentAbilities=raw.latent_abilities.map(a=>({id:a.label,sourceId:a.id,name:tr('latentability','name',a.label,a.name),nameJa:a.name,rank:a.rank,characterId:a.chara_label,unique:a.unique,description:tr('latentability','overridedescription',a.label)||tr('passiveskill','description',a.desc_label,a.desc),exclusiveIds:(a.exclusive||[]).map(x=>x.label),family:a.family,releaseDate:a.in_date}));
const fingerprint=crypto.createHash('sha256').update(sources.map(s=>s.sha256).join('')).digest('hex').slice(0,12);
const output={schemaVersion:1,version:`${new Date().toISOString().slice(0,10)}-${fingerprint}`,generatedAt:new Date().toISOString(),region:'jp-tw-kr',displayLanguage:'zh-TW',latestRelease:styles.map(s=>s.releaseDate).sort().at(-1),sources,characters,styles,latentAbilities};
for(const [label,list] of [['characters',characters],['styles',styles],['latentAbilities',latentAbilities]])if(new Set(list.map(x=>x.id)).size!==list.length)throw Error('Duplicate '+label+' IDs');
for(const s of styles)if(!characters.some(c=>c.id===s.characterId))throw Error('Dangling character '+s.characterId);
const dir=path.join(root,'public/data');fs.mkdirSync(dir,{recursive:true});const dest=path.join(dir,'catalog.json');
if(fs.existsSync(dest)){const history=path.join(root,'work/catalog-history');fs.mkdirSync(history,{recursive:true});fs.copyFileSync(dest,path.join(history,'catalog-'+Date.now()+'.json'));}
fs.writeFileSync(dest+'.tmp',JSON.stringify(output));fs.renameSync(dest+'.tmp',dest);
console.log(JSON.stringify({version:output.version,characters:characters.length,styles:styles.length,latentAbilities:latentAbilities.length,untranslatedStyles:styles.filter(s=>!s.hasTranslation).length,bytes:fs.statSync(dest).size}));
