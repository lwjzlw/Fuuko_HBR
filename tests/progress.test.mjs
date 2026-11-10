import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {emptyArchive,validateArchive,mergeArchive,migrateArchive} from '../public/storage.mjs';
import {applyDefaultProgress,clearAssumedSoulLevels,availableLatents,validateCharacterLatents,maxBreak,patchStyles,recordMaxLevels,advanceStyles} from '../public/progress.mjs';
import {validateStyleProgress} from '../public/catalog.mjs';
const c=JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json',import.meta.url)));
test('bulk defaults use each A/S cap, preserve real character panels and leave SS ownership/bloom unknown',()=>{
 const a=emptyArchive(c);a.characters.RKayamori={level:180,rank:4,reincarnation:12,notes:'retain'};a.styles.RKayamori03={owned:true,limitBreak:1,bloomed:true,cardLevel:122};const before=structuredClone(a),b=applyDefaultProgress(a,c);
 assert.deepEqual(a,before);for(const s of c.styles.filter(s=>['A','S'].includes(s.tier))){assert.equal(b.styles[s.id].owned,true);assert.equal(b.styles[s.id].limitBreak,maxBreak(s));assert.equal(b.styles[s.id].bloomed,false);}
 for(const [k,v]of Object.entries(a.characters.RKayamori))assert.equal(b.characters.RKayamori[k],v);
 assert.equal(b.styles.RKayamori03.limitBreak,1);assert.equal(b.styles.RKayamori03.bloomed,true);assert.equal(b.styles.RKayamori03.cardLevel,122);
 for(const s of c.styles.filter(s=>['SS','SSR'].includes(s.tier)&&s.id!=='RKayamori03')){assert.ok(!b.styles[s.id]?.owned);assert.equal(b.styles[s.id]?.bloomed,undefined);}
 assert.equal(b.progressDefaults,undefined);assert.equal(b.styles.RKayamori01.cardLevel,20);validateArchive(b,c);
});
test('graded soul books come from real accessory records, including books for unowned styles',()=>{
 const b=applyDefaultProgress(emptyArchive(c),c);assert.ok(c.styles.filter(s=>s.soulBook).length>100);
 for(const s of c.styles){if(s.soulBook){assert.equal(s.soulBook.id,'Acc.Soul.'+s.id);assert.equal(b.styles[s.id].soulBookLevel,undefined);assert.equal(b.styles[s.id].soulBook,true);}else assert.ok(b.styles[s.id]?.soulBook!==true);}
 const s=c.styles.find(s=>s.soulBook);assert.throws(()=>validateStyleProgress(c,s,{...b.styles[s.id],soulBookLevel:s.soulBook.maxLevel+1}),/灵魂书强化/);
});
test('soul ownership never presumes level; correction removes only max assumptions and preserves observed grades',()=>{
 const a=emptyArchive(c);a.styles.RKayamori03={owned:true,soulBook:true,soulBookLevel:2,soulBookLevelMode:'recorded',limitBreak:1};a.styles.RKayamori04={owned:false,soulBook:true,soulBookLevel:3,soulBookLevelMode:'max'};
 const b=applyDefaultProgress(a,c);assert.equal(b.styles.RKayamori03.soulBookLevel,2);assert.equal(b.styles.RKayamori03.soulBookLevelMode,'recorded');
 const fixed=clearAssumedSoulLevels(b);assert.equal(fixed.styles.RKayamori03.soulBookLevel,2);assert.equal(fixed.styles.RKayamori04.soulBookLevel,null);assert.equal(fixed.styles.RKayamori04.soulBook,true);assert.equal(fixed.styles.RKayamori04.owned,false);assert.equal(fixed.progressDefaults,undefined);assert.equal(a.styles.RKayamori04.soulBookLevel,3);
 assert.throws(()=>patchStyles(a,c,['RKayamori03'],{soulBookLevel:6}),/灵魂书/);
});
test('defaults are idempotent and never unlock latent entries without evidence',()=>{
 const a=emptyArchive(c),id=c.characters[0].id;const eligible=c.latentAbilities.filter(l=>!l.characterId||l.characterId===id);a.characters[id]={latentPoolMode:'selected',availableLatentIds:[eligible[0].id]};const b=applyDefaultProgress(a,c);
 assert.deepEqual(applyDefaultProgress(b,c),b);assert.equal(availableLatents(c,b,id).length,1);assert.equal(availableLatents(c,b,c.characters[1].id).length,0);assert.equal(b.characters[c.characters[1].id].latentPoolMode,'unknown');
});
test('pool is shared across styles; owning exclusive variants differs from equipping them together',()=>{
 const a=emptyArchive(c),id='RKayamori',latent=c.latentAbilities.find(l=>!l.characterId&&l.exclusiveIds.length);a.characters[id]={latentPoolMode:'selected',availableLatentIds:[latent.id,latent.exclusiveIds[0]]};validateCharacterLatents(c,id,a.characters[id]);
 assert.equal(availableLatents(c,a,c.styles.find(s=>s.id==='RKayamori03').characterId).length,2);assert.equal(availableLatents(c,a,c.styles.find(s=>s.id==='RKayamori04').characterId).length,2);
 const other=c.latentAbilities.find(l=>l.characterId&&l.characterId!==id);assert.throws(()=>validateCharacterLatents(c,id,{availableLatentIds:[other.id]}),/不适用/);
 a.characters[id].latentPoolMode='unknown';assert.equal(availableLatents(c,a,id).length,0);assert.equal(a.characters[id].availableLatentIds.length,2);
});
test('legacy boolean soul books and style latent slots are preserved and never converted to invented levels or ownership pools',()=>{
 const a=emptyArchive(c);a.styles.RKayamori03={owned:true,soulBook:true,latentSlots:['old-selection',null,null]};const b=migrateArchive(a,c);assert.deepEqual(b.styles,a.styles);assert.equal(b.styles.RKayamori03.soulBookLevel,undefined);assert.deepEqual(b.characters,{});
});
test('bulk edits are all-or-nothing, use style-specific caps and preserve unedited card data',()=>{
 const a=emptyArchive(c);a.styles.RKayamori03={owned:true,limitBreak:0,bloomed:false,notes:'original'};const before=structuredClone(a);assert.throws(()=>patchStyles(a,c,['RKayamori03','missing'],{limitBreak:1}));assert.deepEqual(a,before);
 const b=patchStyles(a,c,['RKayamori03','RKayamori01'],{limitBreak:'max'});assert.equal(b.styles.RKayamori03.notes,'original');assert.equal(b.styles.RKayamori03.bloomed,false);assert.equal(b.styles.RKayamori01.limitBreak,maxBreak(c.styles.find(s=>s.id==='RKayamori01')));assert.equal(b.styles.RKayamori01.owned,false);
 assert.throws(()=>patchStyles(a,c,['RKayamori03'],{limitBreak:20}),/突破阶段/);
});
test('added fields roundtrip and merge without discarding raw conflicts',()=>{
 const a=emptyArchive(c),b=applyDefaultProgress(emptyArchive(c),c);a.progressDefaults={characterLevelMode:'recorded'};a.characters.RKayamori={level:170,latentPoolMode:'selected',availableLatentIds:[]};
 const merged=mergeArchive(a,b,c);assert.equal(merged.characters.RKayamori.level,170);assert.equal(merged.characters.RKayamori.latentPoolMode,'selected');assert.equal(merged.progressDefaults.characterLevelMode,'recorded');assert.equal(merged.styles.RKayamori01.cardLevel,20);assert.deepEqual(validateArchive(JSON.parse(JSON.stringify(merged)),c),merged);
});
test('zero is a valid raw record, while authorized inexpensive upgrades directly store max levels',()=>{
 const a=emptyArchive(c);a.styles.RKayamori03={owned:true,cardLevel:0,limitBreak:0,bloomed:false};
 validateArchive(a,c);assert.equal(validateArchive(JSON.parse(JSON.stringify(a)),c).styles.RKayamori03.cardLevel,0);
 const b=applyDefaultProgress(a,c);validateArchive(b,c);assert.equal(b.styles.RKayamori03.cardLevel,20);assert.equal(b.progressDefaults,undefined);
 assert.throws(()=>validateArchive({...b,styles:{RKayamori03:{owned:true,cardLevel:-1}}},c),/卡面等级/);
});
test('quick updates never regress progression, initialize inexpensive levels, and leave book grades alone',()=>{
 const a=emptyArchive(c);a.styles.RKayamori03={owned:true,limitBreak:3,bloomed:true,soulBook:true,soulBookLevel:2,cardLevel:20};
 const b=advanceStyles(a,c,['RKayamori03'],{owned:false,limitBreak:1,bloomed:false,soulBookLevel:1,cardLevel:0});assert.deepEqual(b.styles.RKayamori03,a.styles.RKayamori03);
 const added=advanceStyles(a,c,['RKayamori04'],{owned:true});assert.equal(added.styles.RKayamori04.cardLevel,20);assert.equal(added.styles.RKayamori04.limitBreak,undefined);assert.equal(added.styles.RKayamori04.soulBookLevel,undefined);
 for(const sk of c.styles.find(s=>s.id==='RKayamori04').skills)assert.equal(added.styles.RKayamori04.skillLevels[sk.id],sk.maxLevel);
 assert.throws(()=>advanceStyles(a,c,['RKayamori03'],{limitBreak:5}),/突破/);assert.equal(a.styles.RKayamori03.limitBreak,3);
 const upgraded=recordMaxLevels({...a,progressDefaults:{cardLevelMode:'max'}},c);assert.equal(upgraded.styles.RKayamori03.soulBookLevel,2);assert.equal(upgraded.progressDefaults,undefined);
});
test('potential numeric bonuses belong to each style while the unlocked effect pool is character-shared',()=>{
 const a=emptyArchive(c);a.characters.RKayamori={level:180,reincarnation:5,rank:13,masterSkillUnlocked:true,latentPoolMode:'selected',availableLatentIds:[]};
 a.styles.RKayamori03={owned:true,latentStats:{dp:0,str:12,dex:null}};a.styles.RKayamori04={owned:true,latentStats:{str:3}};
 const b=validateArchive(JSON.parse(JSON.stringify(a)),c);assert.deepEqual(b.characters,a.characters);assert.deepEqual(b.styles,a.styles);assert.equal(availableLatents(c,b,'RKayamori').length,0);
 assert.throws(()=>validateArchive({...a,styles:{RKayamori03:{owned:true,latentStats:{str:-1}}}},c),/潜在数值/);
 assert.equal(recordMaxLevels(a,c).styles.RKayamori03.latentStats.str,12);assert.equal(recordMaxLevels(a,c).styles.RKayamori04.latentStats.str,3);
 assert.deepEqual(recordMaxLevels(a,c).characters,a.characters);
});
test('later imports add unlocked effects and increases without undoing newer progress',()=>{
 const a=emptyArchive(c),b=emptyArchive(c),ids=c.latentAbilities.filter(l=>!l.characterId).slice(0,2).map(l=>l.id);
 a.characters.RKayamori={rank:13,reincarnation:5,masterSkillUnlocked:true,latentPoolMode:'selected',availableLatentIds:[ids[0]]};
 b.characters.RKayamori={rank:14,reincarnation:2,masterSkillUnlocked:false,latentPoolMode:'selected',availableLatentIds:[ids[1]]};
 a.styles.RKayamori03={owned:true,cardLevel:20,bloomed:true,limitBreak:2,soulBookLevel:1,latentStats:{str:10,dp:0}};b.styles.RKayamori03={owned:true,cardLevel:0,bloomed:false,limitBreak:3,soulBookLevel:2,latentStats:{str:4,dp:20}};
 a.styles.RKayamori04={owned:true,latentStats:{str:7}};
 const merged=mergeArchive(a,b,c);assert.equal(merged.characters.RKayamori.rank,14);assert.equal(merged.characters.RKayamori.reincarnation,5);assert.equal(merged.characters.RKayamori.masterSkillUnlocked,true);assert.deepEqual(merged.characters.RKayamori.availableLatentIds,ids);
 assert.deepEqual(merged.styles.RKayamori03,{owned:true,cardLevel:20,bloomed:true,limitBreak:3,soulBookLevel:2,latentStats:{str:10,dp:20}});assert.equal(merged.styles.RKayamori04.latentStats.str,7);assert.equal(merged.importHistory[0].payload.styles.RKayamori03.cardLevel,0);
});
