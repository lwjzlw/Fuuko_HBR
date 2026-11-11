import test from 'node:test';
import assert from 'node:assert/strict';
import {availableGear,changeAccessory,importMember} from '../public/planner-gear.mjs';
import {partyContextKey,setPlannerMembers} from '../public/planner-results.mjs';
import {renderAxisRows,groupAxisRows} from '../public/planner-axis.mjs';
import {buildParty,initialState,startTurn,act} from '../public/sim/hbr/battle.mjs';
import {optimizerInput} from './fixtures/optimizer-input.mjs';

const orb={sourceId:301,slot:'orb',characterId:'A',effects:[],rollGroups:[]};
const shared={sourceId:302,slot:'orb',effects:[],rollGroups:[]};
const byId=new Map([orb,shared].map(item=>[item.sourceId,item]));
const piece=(masterId,instanceId)=>({masterId,instanceId,plus:0,main:[],expansion:[]});
const inventory=[piece(301,'a'),piece(302,'b'),piece(302,'c'),piece(302,'d')];
const raw=(characterId,accessories={})=>({characterId,styleId:characterId+'01',accessories,skillIds:[15]});

test('changing or reordering styles preserves the old team axis and restores it on return',()=>{
  const members=[{styleId:'A'},{styleId:'B'}],designs={event:{phases:[{turns:[{actions:[{u:0,s:'A-skill'}]}]}]}};
  const planner={members,designs,best:{event:{scoreMean:1234}}};
  setPlannerMembers(planner,[{styleId:'A',stats:{str:10}},members[1]]);
  assert.equal(planner.designs,designs);
  setPlannerMembers(planner,[members[1],members[0]]);
  assert.deepEqual(planner.designs,{});assert.deepEqual(planner.best,{});
  planner.designs.other={phases:[]};
  setPlannerMembers(planner,members);
  assert.equal(planner.designs,designs);assert.equal(planner.best.event.scoreMean,1234);
});

test('inventory picker reserves actual pieces for other slots and supports legacy rolls',()=>{
  const list=[{raw:raw('A')},{raw:raw('B',{jewel:inventory[1]})},{raw:raw('C',{jewel:piece(302,undefined)})}];
  assert.deepEqual(availableGear(list,0,'jewel',inventory,byId).map(a=>a.instanceId),['a','d']);
  assert.ok(availableGear(list,1,'jewel',inventory,byId).every(a=>a.masterId!==301));
  assert.equal(inventory.length,4);
});

test('changing one lab accessory preserves the original cache and assigned support, skills and front',()=>{
  const m={raw:raw('A',{}),front:false,styleId:'A01',supportStyleId:'Support',deckSkillIds:[15],strictDeckSkills:true};
  m.raw.unresolvedAccessories=['jewel','ring'];
  const data={catalog:{styles:[{id:'A01',characterId:'A'}]},equipment:{entries:[orb,shared]}};
  const changed=changeAccessory(m,'jewel',inventory[0],data);
  assert.deepEqual(changed.raw.accessories.jewel,inventory[0]);assert.deepEqual(changed.raw.unresolvedAccessories,['ring']);
  assert.deepEqual(m.raw.accessories,{});assert.equal(changed.front,false);assert.equal(changed.supportStyleId,'Support');
  assert.deepEqual(changed.deckSkillIds,[15]);assert.ok(changed.strictDeckSkills);
  assert.notEqual(partyContextKey([m]),partyContextKey([changed]));
});

test('importing one member from a different game deck retains their skills and uses a free matching accessory',()=>{
  const source={...raw('A',{jewel:inventory[1]}),supportStyleId:'Support'};
  const members=[{front:false,raw:raw('X')},{front:true,raw:raw('B',{jewel:inventory[1]})}];
  const data={catalog:{styles:[{id:'A01',characterId:'A'}]},equipment:{entries:[orb,shared]}};
  const {member,omitted}=importMember(members,0,source,{accessories:inventory},data);
  assert.equal(member.raw.accessories.jewel.instanceId,'c');assert.deepEqual(omitted,[]);
  assert.equal(member.front,false);assert.equal(member.supportStyleId,'Support');assert.deepEqual(member.deckSkillIds,[15]);
  assert.equal(source.accessories.jewel.instanceId,'b');assert.equal(members[1].raw.accessories.jewel.instanceId,'b');
});

test('planned ally target zero and unused backup are visible on their action row',()=>{
  const party=[{name:'支援对象'},{name:'辅助'},{name:'后手'}];
  const planned=[{unit:1,skill:'指定增益',target:0},{unit:2,skill:'普通攻击',backup:true}];
  const html=renderAxisRows([{round:'main',turn:1,planned,actions:[],events:[],actors:[1,2,0]}],{e:String,n:String,party});
  assert.match(html,/指定增益 → 支援对象/);assert.match(html,/备用 · 普通攻击/);
});

test('graviton uses the target elemental weakness and caps damage against exposed HP',()=>{
  const input=optimizerInput({count:6}),s=input.data.skills.styles.S0.skills[0];
  s.parts=[{skillType:'FixedHpDamageRate',targetType:'Single',power:[0.1,0],value:[500000,0],hitCondition:'IsTargetWeakNatureElement(Ice)==1'}];
  const party=buildParty(input.base,input.data);
  for(const [hp,ice,dp,expected] of [[10000000,150,0,500000],[200000,150,0,20000],[200000,100,0,0],[200000,150,1000,0]]){
    const enemy=structuredClone(input.target.phases[0].enemies[0]);
    enemy.hp=enemy.maxHp=hp;enemy.dp=dp?[dp]:[];enemy.maxDp=dp;enemy.weaknesses.element.ice=ice;
    const st=initialState(party,enemy,{});startTurn(st);act(st,0,party[0].skills.findIndex(x=>x.label===s.label));
    assert.equal(hp-st.enemy.hp,expected);assert.equal(st.flags.unsupported['条件:IsTargetWeakNatureElement'],undefined);
  }
});

test('a free command and its break appear before three ordinary actions on the same row',()=>{
  const rows=[{kind:'round',roundId:1,phase:0,round:'main',turn:1,actors:[0,1,2],planned:[],commands:[{unit:4,skill:'魔界骑兵'}]},
    {kind:'command',roundId:1,unit:4,skill:'魔界骑兵',damage:100},
    {kind:'break',roundId:1,unit:4,label:'破盾 敌人'}];
  const html=renderAxisRows(groupAxisRows(rows),{party:[],e:String,n:String});
  assert.equal((html.match(/class="axis-act(?: |")/g)||[]).length,3);
  assert.ok(html.indexOf('魔界骑兵 ×1')<html.indexOf('class="axis-acts"'));assert.match(html,/破盾 敌人/);
});
