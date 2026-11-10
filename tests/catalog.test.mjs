import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateCatalog,characterProgress,styleProgress,validateStyleProgress,eligibleLatents,ownedStyles} from '../public/catalog.mjs';
import {emptyArchive,validateArchive,migrateArchive,mergeArchive,checkTeam,linkLegacy} from '../public/storage.mjs';
import {emptyArchive as v1} from '../public/legacy-storage.mjs';
const c=validateCatalog(JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json',import.meta.url),'utf8')));
test('catalog matches known public snapshot and has complete character/style references',()=>{
  assert.equal(c.characters.length,61);assert.equal(c.styles.length,380);assert.equal(c.latentAbilities.length,139);
  assert.equal(c.styles.find(s=>s.id==='FMikoto05').name,'崩壞之夜的繆思');
  assert.equal(c.characters.find(s=>s.id==='RKayamori').name,'茅森月歌');
  for(const char of c.characters)for(const id of char.styleIds)assert.equal(c.styles.find(s=>s.id===id).characterId,char.id);
  for(const s of c.styles){assert.ok(s.skills.length);assert.ok(s.limitBreakSteps.length);for(const group of s.trainingGroups)assert.equal(new Set(group.nodes.map(n=>n.id)).size,group.nodes.length);}
});
test('new archive is sparse: catalog exists independently and nothing is presumed owned or raised',()=>{
  const a=emptyArchive(c);assert.deepEqual(a.styles,{});assert.deepEqual(a.characters,{});assert.equal(ownedStyles(c,a).length,0);assert.equal(styleProgress(a,'RKayamori03').limitBreak,null);assert.equal(a.assumptions.allOrbSkillsOwned,true);
});
test('shared character progress and independent card level/break remain distinct',()=>{
  const a=emptyArchive(c);a.characters.RKayamori={level:160,reincarnation:12,rank:8};
  a.styles.RKayamori03={...styleProgress(a,'RKayamori03'),owned:true,cardLevel:120,limitBreak:3};
  a.styles.RKayamori04={...styleProgress(a,'RKayamori04'),owned:true,cardLevel:130,limitBreak:1};
  const roundtrip=validateArchive(JSON.parse(JSON.stringify(a)),c);
  assert.equal(characterProgress(roundtrip,c.styles.find(s=>s.id==='RKayamori04').characterId).level,160);
  assert.equal(roundtrip.styles.RKayamori03.cardLevel,120);assert.equal(roundtrip.styles.RKayamori04.cardLevel,130);assert.equal(roundtrip.styles.RKayamori03.limitBreak,3);
});
test('unchecking ownership retains individual progression and warns when a team uses the card',()=>{
  const a=emptyArchive(c);a.styles.RKayamori03={...styleProgress(a,'RKayamori03'),owned:false,cardLevel:120,bloomed:true};a.team[0].styleId='RKayamori03';
  assert.equal(validateArchive(a,c).styles.RKayamori03.cardLevel,120);assert.ok(checkTeam(a,c).some(x=>x.includes('未标记拥有')));
});
test('canonical character identity prevents different-style duplicates independently of display names',()=>{
  const a=emptyArchive(c);for(const id of ['RKayamori03','RKayamori04'])a.styles[id]={...styleProgress(a,id),owned:true};a.team[0].styleId='RKayamori03';a.team[1].styleId='RKayamori04';
  assert.ok(checkTeam(a,c).some(x=>x.includes('重复出场')));
});
test('personal unknown, known zero and confirmed false survive a roundtrip',()=>{
  const a=emptyArchive(c);a.characters.RKayamori={level:null,reincarnation:0,rank:0};a.styles.RKayamori03={...styleProgress(a,'RKayamori03'),limitBreak:0,bloomed:false,soulBook:null,latentSlots:[null,'',null]};
  const b=validateArchive(JSON.parse(JSON.stringify(a)),c);assert.equal(b.characters.RKayamori.level,null);assert.equal(b.characters.RKayamori.reincarnation,0);assert.equal(b.styles.RKayamori03.bloomed,false);assert.equal(b.styles.RKayamori03.soulBook,null);assert.deepEqual(b.styles.RKayamori03.latentSlots,[null,'',null]);
});
test('v1 migration never guesses names or level scope and preserves the complete source snapshot',()=>{
  const old=v1();old.roster=[{id:'manual1',character:'月歌',name:'初始',level:130,limitBreak:2,stats:{力量:430},notes:'keep me'}];old.team[0].styleId='manual1';
  const before=structuredClone(old),next=migrateArchive(old,c);assert.deepEqual(old,before);assert.deepEqual(next.legacySnapshots[0].payload,old);assert.equal(next.legacyRecords[0].data.level,130);assert.deepEqual(next.styles,{});assert.deepEqual(next.characters,{});assert.equal(next.team[0].styleId,'');
  const linked=linkLegacy(next,next.legacyRecords[0].id,'RKayamori03',c);assert.equal(linked.styles.RKayamori03.owned,true);assert.equal(linked.styles.RKayamori03.limitBreak,2);assert.equal(linked.styles.RKayamori03.cardLevel,null);assert.equal(characterProgress(linked,'RKayamori').level,null);assert.equal(linked.legacyRecords[0].wasInLegacyTeam,true);
});
test('imports keep higher progression, current team and exact incoming evidence',()=>{
  const a=emptyArchive(c),b=emptyArchive(c);a.characters.RKayamori={level:150,reincarnation:0,rank:null};b.characters.RKayamori={level:140,reincarnation:8,rank:6};
  a.styles.RKayamori03={...styleProgress(a,'RKayamori03'),owned:true,limitBreak:0};b.styles.RKayamori03={...styleProgress(b,'RKayamori03'),owned:false,limitBreak:null};a.team[0].styleId='RKayamori03';
  const result=mergeArchive(a,b,c);assert.equal(result.characters.RKayamori.level,150);assert.equal(result.characters.RKayamori.reincarnation,8);assert.equal(result.characters.RKayamori.rank,6);assert.equal(result.styles.RKayamori03.owned,true);assert.equal(result.styles.RKayamori03.limitBreak,0);assert.deepEqual(result.team,a.team);assert.equal(result.importHistory[0].payload.characters.RKayamori.level,140);assert.ok(result.importHistory[0].conflicts.includes('characters.RKayamori.level'));
});
test('catalog translation update leaves personal progression keyed by stable IDs unchanged',()=>{
  const a=emptyArchive(c);a.styles.RKayamori03={...styleProgress(a,'RKayamori03'),owned:true,limitBreak:1};const renamed=structuredClone(c);renamed.styles.find(x=>x.id==='RKayamori03').name='new translation';assert.deepEqual(validateArchive(structuredClone(a),renamed),a);
});
test('a later catalog boundary change never makes a saved archive unreadable or deletes its data',()=>{
  const a=emptyArchive(c);a.styles.RKayamori03={...styleProgress(a,'RKayamori03'),owned:true,limitBreak:4,latentSlots:['retired-id',null,null]};
  assert.deepEqual(validateArchive(structuredClone(a),c),a);
  assert.throws(()=>validateStyleProgress(c,c.styles.find(s=>s.id==='RKayamori03'),a.styles.RKayamori03),/不适用/);
});
test('skill caps, eligible character-specific latents, duplicates and exclusive variants are enforced',()=>{
  const s=c.styles.find(s=>s.id==='RKayamori03'),a=emptyArchive(c),p=styleProgress(a,s.id);
  p.limitBreak=20;assert.throws(()=>validateStyleProgress(c,s,p),/突破范围/);p.limitBreak=0;
  p.skillLevels={[s.skills[0].id]:s.skills[0].maxLevel+1};assert.throws(()=>validateStyleProgress(c,s,p),/等级上限/);p.skillLevels={};
  const another=c.latentAbilities.find(l=>l.characterId&&l.characterId!==s.characterId);p.latentSlots=[another.id,null,null];assert.throws(()=>validateStyleProgress(c,s,p),/不适用/);
  const common=eligibleLatents(c,s).find(l=>l.exclusiveIds.length);p.latentSlots=[common.id,common.id,null];assert.throws(()=>validateStyleProgress(c,s,p),/重复/);p.latentSlots=[common.id,common.exclusiveIds[0],null];assert.throws(()=>validateStyleProgress(c,s,p),/互斥/);
});
test('old references and remapped equipment survive merging an explicitly linked legacy archive',()=>{
  const old=v1();old.roster=[{id:'m1',character:'月歌',name:'test',level:130,limitBreak:1}];
  let incoming=migrateArchive(old,c);incoming=linkLegacy(incoming,incoming.legacyRecords[0].id,'RKayamori03',c);
  const a=emptyArchive(c);a.items=[{id:'e1',name:'old',quantity:1}];incoming.items=[{id:'e1',name:'different',quantity:1}];incoming.loadouts[0].itemIds=['e1'];
  const merged=mergeArchive(a,incoming,c),ids=merged.styles.RKayamori03.legacyRecordIds;
  assert.equal(ids.length,1);assert.ok(merged.legacyRecords.some(r=>r.id===ids[0]));assert.ok(merged.loadouts.some(l=>l.itemIds.includes(merged.items.find(i=>i.name==='different').id)));
});
test('malformed personal records are rejected instead of silently normalized',()=>{
  const a=emptyArchive(c);a.characters.RKayamori={level:-1};assert.throws(()=>validateArchive(a,c),/整数/);
  const b=emptyArchive(c);b.styles.RKayamori03={owned:'true'};assert.throws(()=>validateArchive(b,c),/拥有/);
});
