import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {canEquip,defaultEquipment,evaluateEquipment,evaluateLoadout,ownedAccessoryOptions} from '../public/equipment.mjs';
import {membersFromDeck,withCurrentEquipment} from '../public/sim/hbr/deck.mjs';
import {buildParty,initialState,endPlayerTurn} from '../public/sim/hbr/battle.mjs';
import {equipmentDetails} from '../public/planner-loadout.mjs';
import {emptyArchive,validateArchive,mergeArchive} from '../public/storage.mjs';
import {validateStyleProgress} from '../public/catalog.mjs';
import {advanceStyles} from '../public/progress.mjs';
import {compareTeamReference,teamReferenceHTML} from '../public/team-verification.mjs';
const catalog=JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json',import.meta.url)));
const gear=JSON.parse(fs.readFileSync(new URL('../public/data/equipment.json',import.meta.url)));
const stats=JSON.parse(fs.readFileSync(new URL('../public/data/stats.json',import.meta.url)));
const data={catalog,equipment:gear,stats,skills:{styles:{}}};
const entry=id=>gear.entries.find(x=>x.id===id);
const pick=id=>defaultEquipment(entry(id));

test('equipment catalog preserves all source variants and links soul books to actual styles',()=>{
 assert.equal(gear.entries.length,747);assert.equal(new Set(gear.entries.map(x=>x.id)).size,747);
 for(const x of gear.entries.filter(x=>x.slot==='soul')){assert.ok(catalog.styles.some(s=>s.id===x.styleId));assert.equal(x.soulEnhancementCap,5);}
 assert.equal(gear.sources.length,3);
});
test('owned accessory choices keep instance rolls, character orbs, style souls and six charm slots distinct',()=>{
 const byId=new Map(gear.entries.map(e=>[e.sourceId,e]));
 const alice={styleId:'AliceA03',characterId:'AliceA'},other={styleId:'AliceA04',characterId:'AliceA'};
 const orbs=gear.entries.filter(e=>e.id.startsWith('Acc.COrb.'));
 assert.equal(orbs.length,44);
 for(const orb of orbs)assert.ok(catalog.characters.some(c=>c.id===orb.characterId));
 const orb=byId.get(5030921),soul=entry('Acc.Soul.AliceA03');
 assert.ok(canEquip(orb,other));assert.ok(canEquip(soul,alice));assert.equal(canEquip(soul,other),false);
 const normal=entry('Acc.Orb001a');
 const inventory=[orb,orbs.find(e=>e.characterId!=='AliceA'),normal,byId.get(5026201),entry('Acc.Charm01.F001'),entry('Acc.Charm01.F001'),entry('Acc.Charm01.F002')]
   .map((e,i)=>({instanceId:String(i+7),masterId:e.sourceId,main:i===4?[42601501]:i===5?[42601504]:[],expansion:[],plus:0}));
 const options=slot=>ownedAccessoryOptions(slot,alice,inventory,byId);
 assert.deepEqual(options('jewel'),[inventory[0],inventory[2]]);
 assert.deepEqual(options('powerCharm'),inventory.slice(3,6));
 assert.deepEqual(options('dexterityCharm'),[inventory[6]]);
 const picks=['Acc.Charm01.F001','Acc.Charm_Dimension.F002'].map(pick);
 assert.ok(evaluateLoadout(gear,{equipment:picks}).complete);
 assert.match(evaluateLoadout(gear,{equipment:[...picks,pick('Acc.Charm_Dimension.F001')]}).missing.join(),/重复部位/);
});
test('Kanade relic orb and high power charm reach the battle panel and expanded equipment rows',()=>{
 const charm={masterId:5026201,main:[],expansion:[],plus:0},jewel={...charm,masterId:5030921};
 const make=(accessories,styleId='AliceA03')=>membersFromDeck({members:[{styleId,characterId:catalog.styles.find(s=>s.id===styleId).characterId,
   character:{level:100},card:{level:20},accessories,unresolvedAccessories:['ring']}]},data)[0];
 const base=make({}),both=make({powerCharm:charm,jewel});
 const party=m=>buildParty([m],data)[0];
 assert.equal(party(both).dpMax-party(make({powerCharm:charm})).dpMax,1000);
 assert.equal(party(both).stats.str-party(make({jewel})).stats.str,18);
 assert.equal(party(both).hpMax,party(base).hpMax);
 const other='RKayamori01';
 assert.equal(party(make({jewel},other)).dpMax,party(make({},other)).dpMax);
 const rows=equipmentDetails(both,gear),row=slot=>rows.find(r=>r.slot===slot);
 assert.match(row('powerCharm').name,/力量高級吊飾/);assert.match(row('powerCharm').lines.join(),/力量 \+18/);
 assert.match(row('jewel').name,/立華/);assert.match(row('jewel').lines.join(),/DP \+1000/);
 assert.match(row('ring').name,/未匹配库存/);assert.equal(row('earring').name,'未装备');
});
test('ancient defense necklace and conditional defense use the actual DP at enemy turn start',()=>{
 const raw={styleId:'AliceA03',characterId:'AliceA',character:{level:100},card:{level:20},accessories:{}};
 const enemy={dp:[10000],hp:10000,border:100,pattern:{dp:{entries:[{order:0,skills:[9]}]}},
   skills:[{id:9,parts:[{skillType:'AttackSkill',targetType:'All',power:[100,100]}]}]};
 const defend=(necklace,ratio,conditional=false,fixed=false)=>{
   const accessories=necklace?{necklace:{masterId:necklace,main:[],expansion:[],plus:0}}:{};
   const member=membersFromDeck({members:[{...raw,accessories}]},data)[0],party=buildParty([member],data);
   if(conditional)party[0].passives.push({label:'halfDp',timing:'OnEnemyTurnStart',condition:'DpRate()<=0.5 && IsFront()',
     parts:[{skillType:'DefenseUp',targetType:'Self',power:[0.25,0],exit:{cond:'EnemyTurnEnd',value:[1,0]}}]});
   const battleEnemy=structuredClone(enemy);
   if(fixed)battleEnemy.skills[0].parts[0].skillType='AttackFixedDamageDefinitely';
   const st=initialState(party,battleEnemy,{trace:true,enemyVariance:1});
   st.units[0].dp=party[0].dpMax*ratio;
   endPlayerTurn(st);
   assert.ok(!st.units[0].effects.some(e=>e.type==='defenseUp'));
   return st.log.find(e=>e.t==='hurt').amount;
 };
 assert.equal(defend(null,1),100);assert.equal(defend(5025001,1),100);
 for(const masterId of [5025002,5025004,5025006,5025008,5025010])assert.equal(defend(masterId,1),90);
 assert.equal(defend(5025002,1,true),90);assert.equal(defend(5025002,0.5,true),65);
 assert.equal(defend(5025002,0,true),65);assert.equal(defend(5025002,0.5,true,true),100);
});
test('replay refreshes an old imported item and keeps manual values, original skills and front positions',()=>{
 const raw={styleId:'AliceA03',characterId:'AliceA',character:{level:100},card:{level:20},supportStyleId:'AliceA04',
   skillIds:[46300001,46300007],accessories:{necklace:{masterId:5025002},jewel:{masterId:5030921}}};
 const [member]=membersFromDeck({members:[raw]},data);
 const expectedDp=member.vitals.dp;
 const saved={...member,front:false,statsManual:['dex'],stats:{...member.stats,dex:543},vitals:{dp:1,hp:1},
   equipment:{},deckSkillIds:[46300007],strictDeckSkills:true,supportStyleId:'AliceA04'};
 const manual={styleId:'RKayamori01',front:true,stats:{str:145}};
 const [fresh,untouched]=withCurrentEquipment([saved,manual],data);
 assert.equal(fresh.vitals.dp,expectedDp);assert.equal(fresh.stats.dex,543);assert.equal(fresh.front,false);
 assert.deepEqual(fresh.deckSkillIds,[46300007]);assert.equal(fresh.strictDeckSkills,true);assert.equal(fresh.supportStyleId,'AliceA04');
 assert.equal(fresh.equipment.enemyTurnDefense.timing,'OnEnemyTurnStart');
 assert.equal(saved.vitals.dp,1);assert.equal(saved.equipment.enemyTurnDefense,undefined);
 assert.equal(untouched,manual);
});
test('OD earring selects exactly one option per group and keeps hit-dependent passive separate',()=>{
 const e=entry('Acc.Earring006.F003'),p=defaultEquipment(e),r=evaluateEquipment(e,p);
 assert.deepEqual(p.rollSelections,[2,8,8]);assert.equal(r.stats.dp,1200);assert.equal(r.stats.wis,48);assert.equal(r.effects.length,1);assert.match(r.effects[0],/15%/);
 p.rollSelections[1]=7;assert.equal(evaluateEquipment(e,p).stats.dp,900);
 p.rollSelections[1]=null;assert.equal(evaluateEquipment(e,p).complete,false);
 p.rollSelections[1]=100;assert.throws(()=>evaluateEquipment(e,p),/超出/);
});
test('real ring, earring, booster and four chips add exact base values without multiplying passives',()=>{
 const ids=['Acc.Ring007_Fire_aa_6','Acc.Earring006.F003','SBooster_0702',...Array(4).fill('SChip_6003')];
 const l={equipment:ids.map(pick)},r=evaluateLoadout(gear,l);
 assert.deepEqual(r.stats,{dp:1200,str:98,dex:85,con:89,spr:43,wis:91,luk:43,sp:0});assert.equal(r.effects.length,2);assert.equal(r.complete,true);
 l.equipment.push(pick('SChip_6003'));assert.match(evaluateLoadout(gear,l).missing.join(),/芯片数量超出/);
 assert.match(evaluateLoadout(gear,{equipment:[pick('SChip_6003')]}).missing.join(),/芯片数量超出/);
});
test('socket assumption adds nine to one chosen attribute and never combines with manual slot totals',()=>{
 const e=entry('Acc.Ring007_Fire_aa_6'),p=defaultEquipment(e);p.socketStat='str';let r=evaluateEquipment(e,p);assert.equal(r.stats.str,64);assert.equal(r.stats.dex,42);assert.equal(r.complete,true);
 p.socketStat='con';r=evaluateEquipment(e,p);assert.equal(r.stats.str,55);assert.equal(r.stats.con,19);
 p.extraStats={str:9};assert.throws(()=>evaluateEquipment(e,p),/不能同时/);
 p.extraStats={};p.socketStat='dp';assert.throws(()=>evaluateEquipment(e,p),/六维/);
 assert.throws(()=>evaluateEquipment(entry('SChip_6003'),{...pick('SChip_6003'),socketStat:'str'}),/开孔/);
});
test('missing gear does not shift edit/remove indexes and duplicates are reported',()=>{
 const r=evaluateLoadout(gear,{equipment:[{catalogId:'unknown'},pick('Acc.Earring006.F003'),pick('Acc.Earring006.F003')]});assert.equal(r.rows[0].selectionIndex,1);assert.match(r.missing.join(),/目录缺失/);assert.match(r.missing.join(),/重复部位/);
});
test('soul enhancement accepts zero through five independent of source max_lv, preserving unknown',()=>{
 const s=catalog.styles.find(s=>s.soulBook),a=emptyArchive(catalog);
 assert.equal(s.soulBook.maxLevel,5);assert.equal(s.soulBook.sourceMaxLv,3);
 for(const value of [null,0,1,3,4,5]){
  const progress={owned:true,soulBook:true,soulBookLevel:value};validateStyleProgress(catalog,s,progress);a.styles[s.id]=progress;assert.equal(validateArchive(JSON.parse(JSON.stringify(a)),catalog).styles[s.id].soulBookLevel,value);
 }
 assert.throws(()=>validateStyleProgress(catalog,s,{owned:true,soulBookLevel:6}),/强化/);
 a.styles[s.id].soulBookLevel=4;assert.equal(advanceStyles(a,catalog,[s.id],{soulBookLevel:5}).styles[s.id].soulBookLevel,5);assert.equal(advanceStyles(a,catalog,[s.id],{soulBookLevel:0}).styles[s.id].soulBookLevel,4);
 const b=structuredClone(a);b.styles[s.id].soulBookLevel=5;assert.equal(mergeArchive(a,b,catalog).styles[s.id].soulBookLevel,5);
 const e=gear.entries.find(e=>e.slot==='soul'),p=defaultEquipment(e);assert.equal(evaluateEquipment(e,p).complete,false);p.soulEnhancement=0;assert.equal(evaluateEquipment(e,p).stats.str,5);p.soulEnhancement=5;assert.equal(evaluateEquipment(e,p).stats.str,5);assert.match(evaluateEquipment(e,p).missing.join(),/增量表/);
});
test('equipment choices survive archive export and merge',()=>{
 const a=emptyArchive(catalog);a.loadouts[0].equipment=[{...pick('Acc.Earring006.F003'),socketStat:'wis'}];
 const b=validateArchive(JSON.parse(JSON.stringify(a)),catalog);assert.deepEqual(b.loadouts,a.loadouts);assert.deepEqual(mergeArchive(emptyArchive(catalog),b,catalog).loadouts.find(l=>l.equipment)?.equipment,a.loadouts[0].equipment);
});
test('soul equipment reads the card archive so progress updates do not leave a second conflicting grade',()=>{
 const e=gear.entries.find(e=>e.slot==='soul'),p=defaultEquipment(e),l={equipment:[p]};p.soulEnhancement=5;
 assert.match(evaluateLoadout(gear,l,{[e.styleId]:{soulBookLevel:4}}).missing.join(),/灵魂书 \+4/);
 assert.equal(evaluateLoadout(gear,l,{[e.styleId]:{soulBookLevel:0}}).complete,true);
 assert.match(evaluateLoadout(gear,l,{}).missing.join(),/强化值待填/);
});
test('screenshot arithmetic cannot masquerade as derived stats; unknown or changed levels fail comparison',()=>{
 const a=emptyArchive(catalog),s=catalog.styles[0];a.styles[s.id]={owned:true,cardLevel:20,limitBreak:1,bloomed:false};a.characters[s.characterId]={level:180,reincarnation:10};a.team=Array.from({length:6},()=>({styleId:s.id,supportStyleId:s.id,loadoutId:''}));
 a.teamReference={totalPower:8250,members:[1000,1100,1200,1300,1400,1500].map((power,i)=>({styleId:s.id,supportStyleId:s.id,power,supportPower:[100,110,120,130,140,150][i],level:200,limitBreak:1,reincarnation:10,bloomed:false}))};
 let result=compareTeamReference(a,catalog);assert.equal(result.total,8250);assert.equal(result.difference,0);assert.equal(result.rows[0].combinedLevel,200);assert.equal(result.rows[0].checks.level,true);
 a.characters[s.characterId].level=170;assert.equal(compareTeamReference(a,catalog).rows[0].checks.level,false);a.characters[s.characterId].level=null;assert.equal(compareTeamReference(a,catalog).rows[0].checks.level,null);
 assert.match(teamReferenceHTML(a,catalog,String),/不代表六维属性或伤害公式已通过验证/);
});
