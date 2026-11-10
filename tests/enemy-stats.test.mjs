import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {buildParty,buildEnemy,initialState,setPhase,startTurn,act,cloneState} from '../public/sim/hbr/battle.mjs';

function battle({hits=1,dpA=1e9,dpB=1,hpB=100,resistB=0,borderB=400,drB=1,power=10000}={}){
  const f=optimizerInput({count:6}),s=f.data.skills.styles.S0.skills[0];
  s.hitCount=hits;s.parts[0].targetType='All';s.parts[0].power=[power,power];
  const event={enemies:{A:{resist:{element:{}},pattern:{},skills:[]},B:{resist:{element:{ice:resistB}},pattern:{},skills:[]}}};
  const stage={enemies:[{label:'A',name:'primary',dp:dpA,hp:1e9,paramBorder:400,destruction:[1,600]},
    {label:'B',name:'secondary',dp:dpB,hp:hpB,paramBorder:borderB,destruction:[1,600]}]};
  const party=buildParty(f.base,f.data),enemies=stage.enemies.map(e=>buildEnemy(event,stage,{enemyLabel:e.label}));
  const st=initialState(party,enemies[0],{critMode:'none',followUpRate:0,trace:true});setPhase(st,enemies);
  st.queue[1].state.dr=drB;startTurn(st);
  return {st,party,enemies,skill:party[0].skills.findIndex(x=>x.label===s.label)};
}

test('one AoE hit can break a secondary shield without overflowing that hit into HP',()=>{
  const {st,skill}=battle();act(st,0,skill);
  assert.deepEqual(st.queue[1].state.dp,[0]);assert.equal(st.queue[1].state.hp,100);
  assert.equal(st.queue[1].dead,false);
  assert.ok(st.log.some(x=>x.t==='break'&&x.name==='secondary'));
  assert.ok(!st.log.some(x=>x.t==='kill'));
});

test('a second AoE hit can hit secondary HP after its first hit breaks DP',()=>{
  const {st,skill}=battle({hits:2});act(st,0,skill);
  assert.equal(st.queue[1].dead,true);assert.equal(st.queue[1].state.hp,0);
  assert.equal(st.log.filter(x=>x.t==='kill'&&x.name==='secondary').length,1);
  assert.ok(st.queue[0].state.dp[0]>0);
});

test('AoE secondary damage uses its own border, resistance, destruction and debuffs',()=>{
  const {st,skill,party,enemies}=battle({dpB:0,hpB:1e9,resistB:50,borderB:525,drB:2.5});
  st.queue[1].state.effects.push({type:'defenseDown',size:50,uses:null,turns:null});
  const single=initialState(party,enemies[1],{critMode:'none',followUpRate:0});startTurn(single);
  single.enemy.dr=2.5;single.enemy.effects=structuredClone(st.queue[1].state.effects);
  act(single,0,skill);act(st,0,skill);
  assert.equal(st.queue[1].state.hp,single.enemy.hp);
  assert.equal(st.queue[1].state.dr,single.enemy.dr);
  assert.notEqual(st.queue[0].state.dp[0]-1e9,st.queue[1].state.hp-1e9);
});

test('AoE consumes one attack buff once and does not charge OD for resisted or dead targets',()=>{
  const {st,skill}=battle({dpB:1e9,hpB:1e9,resistB:50});
  st.units[0].effects.push({type:'attackUp',size:100,uses:2,turns:null,passive:false});
  const dead=cloneState(st);dead.queue[1].dead=true;dead.queue[1].state.hp=0;
  act(st,0,skill);act(dead,0,skill);
  assert.equal(st.units[0].effects.find(e=>e.type==='attackUp').uses,1);
  assert.equal(st.od,2.5);assert.equal(dead.od,2.5);
});

test('AoE keeps damage inscriptions on each enemy and records a primary kill only once',()=>{
  const {st,skill}=battle({dpA:0,dpB:0,hpB:1e9});
  st.queue[0].state.hp=1;
  for(const q of st.queue)q.state.effects.push({type:'status',status:'Inscription',level:1,damage:0,uses:null,turns:null});
  act(st,0,skill);
  assert.equal(st.queue[0].state.effects.find(e=>e.status==='Inscription').damage,1);
  assert.equal(st.queue[1].state.effects.find(e=>e.status==='Inscription').damage,1e9-st.queue[1].state.hp);
  assert.equal(st.log.filter(x=>x.t==='kill'&&x.name==='primary').length,1);
  assert.equal(st.ctx.enemy.name,'secondary');assert.equal(st.killedTurn,0);
});
