import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyArchive,validateArchive,checkTeam,mergeArchive} from '../public/legacy-storage.mjs';
function fixture(){const a=emptyArchive();a.roster=Array.from({length:6},(_,i)=>({id:'s'+i,character:'角色'+i,name:'卡面'+i,stats:{力量:null},level:null,limitBreak:0}));a.team=a.roster.map(c=>({styleId:c.id,loadoutId:''}));return a;}
test('new archive follows the requested ideal equipment and orb assumptions',()=>{
  const a=validateArchive(emptyArchive());assert.equal(a.assumptions.allOrbSkillsOwned,true);assert.equal(a.assumptions.equipmentAdjustableMax,true);assert.equal(a.assumptions.checkEquipmentInventory,false);assert.equal(a.roster.length,0);assert.equal(a.loadouts.length,4);
});
test('empty stats remain unknown after JSON roundtrip and schema validation',()=>{
  const a=validateArchive(JSON.parse(JSON.stringify(fixture())));assert.equal(a.roster[0].stats.力量,null);assert.equal(a.roster[0].level,null);
});
test('same character across two styles is rejected for the fixed team',()=>{
  const a=fixture();a.roster[1].character=a.roster[0].character;assert.ok(checkTeam(a).some(x=>x.includes('重复')));
});
test('inventory is ignored by default and checked only when explicitly enabled',()=>{
  const a=fixture();a.items=[{id:'ear',name:'OD',quantity:1}];a.loadouts[0].itemIds=['ear'];a.team[0].loadoutId=a.loadouts[0].id;a.team[1].loadoutId=a.loadouts[0].id;
  assert.deepEqual(checkTeam(a),[]);a.assumptions.checkEquipmentInventory=true;assert.ok(checkTeam(a).some(x=>x.includes('需 2 件')));
});
test('merge gives new IDs, preserves references and never changes current team',()=>{
  const a=fixture(),b=fixture();b.items=[{id:'ear',name:'OD',quantity:1}];b.loadouts[0].itemIds=['ear'];
  const merged=mergeArchive(a,b);assert.equal(merged.roster.length,12);assert.deepEqual(merged.team,a.team);assert.notEqual(merged.roster[6].id,'s0');assert.equal(merged.loadouts[4].itemIds[0],merged.items[0].id);assert.equal(a.roster.length,6);
});
test('malformed or dangling imported records are rejected',()=>{
  const a=fixture();a.loadouts[0].itemIds=['missing'];assert.throws(()=>validateArchive(a),/装备/);
  assert.throws(()=>validateArchive({schemaVersion:2}),/版本/);
  const b=fixture();b.roster.push({...b.roster[0]});assert.throws(()=>validateArchive(b),/重复/);
});
