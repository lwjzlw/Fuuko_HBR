import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreAttackScore,turnMultiplier,damageScore,damageNeeded,predictActions,ruleSchedule,weaknessSummary,ruleWeeks,rulesOn,ruleMultiplier,stageEnemies,resolveEnemyParameters} from '../public/boss-model.mjs';
import {buildEnemy} from '../public/sim/hbr/battle.mjs';

test('stageEnemies drops empty formation slots and attaches details',()=>{
  const event={enemies:{A:{name:'甲',flags:{is_boss:true}}}};
  const stage={enemies:[{label:'',name:'',dp:0,hp:0},{label:'A',dp:10,hp:5},{label:'B',dp:1,hp:1}]};
  const list=stageEnemies(event,stage);
  assert.deepEqual(list.map(x=>x.label),['A','B']);
  assert.equal(list[0].detail.name,'甲');
  assert.equal(list[1].detail,null);
  assert.deepEqual(stageEnemies(event,null),[]);
});

test('enemy parameters preserve stage zero values and local overrides with their provenance',()=>{
  const event={kind:'wave',enemies:{A:{base:{dp:18000,hp:24000,param_border:750,atk_rate:100}}}};
  const stage={label:'phase-one',enemies:[{label:'A',dp:0,hp:24000,paramBorder:0}]};
  const source=structuredClone({event,stage});
  const raw=resolveEnemyParameters(event,stage,stage.enemies[0]);
  assert.deepEqual([raw.dp,raw.hp,raw.border],[0,24000,0]);
  assert.equal(raw.parameterSource.difficultyVerified,false);
  const enemy=buildEnemy(event,stage,{parameterOverride:{dp:180000,hp:240000,border:775}});
  assert.deepEqual([enemy.dp,enemy.hp,enemy.maxDp,enemy.maxHp,enemy.border],[[180000],240000,180000,240000,775]);
  assert.deepEqual(enemy.parameterSource.fields,{dp:'override',hp:'override',border:'override'});
  assert.deepEqual(enemy.parameterSource.original,{dp:0,hp:24000,border:0});
  assert.deepEqual({event,stage},source);
  const zero=buildEnemy(event,stage,{parameterOverride:{dp:0,border:0}});
  assert.deepEqual(zero.dp,[]);assert.equal(zero.border,0);
});

test('enemy overrides do not accept invalid numbers or disguise absent health as a cleared enemy',()=>{
  const event={enemies:{A:{base:{dp:10,hp:20,param_border:30}}}},stage={enemies:[{label:'A'}]};
  const fallback=buildEnemy(event,stage);
  assert.deepEqual([fallback.dp,fallback.hp,fallback.border],[[10],20,30]);
  assert.deepEqual(fallback.parameterSource.fields,{dp:'enemy-base',hp:'enemy-base',border:'enemy-base'});
  for(const value of [NaN,Infinity,-1,'123'])for(const key of ['dp','hp','border'])assert.throws(()=>buildEnemy(event,stage,{parameterOverride:{[key]:value}}),RangeError);
  assert.throws(()=>buildEnemy(event,stage,{parameterOverride:{hp:0}}),RangeError);
  assert.throws(()=>buildEnemy({},stage),/缺失/);
  assert.equal(resolveEnemyParameters({},stage,stage.enemies[0]).hp,null);
  assert.deepEqual(buildEnemy(event,stage,{parameterOverride:{hp:null}}).hp,20);
});

// Values copied from hbr.quest score_attack #104, difficulty 40 (アビス).
const calc={sbtr:0.5,lsbtr:1.05,sbnb:30,tmdc:0.013,etc:30,min_tr:10000,max_tr:13000,btcfr:10,btr:12000,calc_ver:2};
const stage={difficulty:40,baseScore:700000,damageCap:18568569,noBreakBonus:150000,maxTurnBonus:0,turnLimit:30};

test('turn multiplier follows the piecewise curve',()=>{
  assert.equal(turnMultiplier(calc,stage,1),1.3);
  assert.equal(turnMultiplier(calc,stage,5),1.26);
  assert.equal(turnMultiplier(calc,stage,10),1.2);
  assert.equal(turnMultiplier(calc,stage,20),1.1);
  assert.equal(turnMultiplier(calc,stage,30),1);
});

test('damage score is linear to the cap and logarithmic beyond',()=>{
  assert.equal(damageScore(calc,stage,stage.damageCap),241391);
  assert.equal(damageScore(calc,stage,stage.damageCap/2),Math.trunc(stage.damageCap/2*0.013));
  const twice=damageScore(calc,stage,stage.damageCap*2);
  assert.ok(twice>241391&&twice<2*241391);
});

test('calc_ver 2 total = (base + damage + no-break) × turn multiplier × rule multiplier',()=>{
  const r=scoreAttackScore({calc,stage,rules:[{grade:35}],turns:1,damage:stage.damageCap,noBreak:true});
  assert.equal(r.total,1915391);
  assert.equal(r.ruleMultiplier,1.35);
  const broken=scoreAttackScore({calc,stage,turns:1,damage:stage.damageCap,noBreak:false});
  assert.equal(broken.noBreak,0);
  assert.equal(scoreAttackScore({calc,stage,turns:31}).valid,false);
});

test('older formula keeps a separate turn score',()=>{
  const old={sbtr:0.5,sbnb:30,tmdc:0.01,etc:30,calc_ver:0};
  const r=scoreAttackScore({calc:old,stage:{difficulty:10,baseScore:1000},turns:3,damage:0,noBreak:true});
  assert.equal(r.turnScore,Math.trunc(1000*0.005*27));
  assert.equal(r.noBreak,300);
  assert.equal(r.total,1000+135+300);
});

test('damageNeeded returns the minimal damage reaching a target',()=>{
  const target=1500000;
  const d=damageNeeded({calc,stage,turns:3,target});
  assert.ok(d>0);
  assert.ok(scoreAttackScore({calc,stage,turns:3,damage:d}).total>=target);
  assert.ok(scoreAttackScore({calc,stage,turns:3,damage:d-1}).total<target);
  assert.equal(damageNeeded({calc,stage,turns:3,target:0}),0);
});

test('rule multiplier sums grades',()=>{assert.equal(ruleMultiplier([{grade:35},{grade:15}]),1.5);assert.equal(ruleMultiplier([]),1);});

const enemy={skills:[{id:902,name:'A'},{id:903,name:'B'},{id:904,name:'C'},{id:905,name:'D'}],pattern:{
  dp:{label:'x',entries:[903,904,902,905,902,904].map((s,i)=>({order:i+1,preemptive:false,once:false,weight:100,condition:'',skills:[s]}))},
  hp:{label:'y',entries:[{order:0,preemptive:true,once:false,weight:100,condition:'',skills:[905]},{order:1,preemptive:false,once:true,weight:100,condition:'',skills:[902]},{order:2,preemptive:false,once:false,weight:100,condition:'Hp()<50',skills:[903]}]}}};

test('action prediction cycles by order',()=>{
  const p=predictActions(enemy,'dp',8);
  assert.deepEqual(p.steps.map(s=>s.skills[0].id),[903,904,902,905,902,904,903,904]);
  assert.equal(p.steps[0].turn,1);
  assert.equal(p.uncertain,false);
});

test('preemptive, once and conditional entries are handled and flagged',()=>{
  const p=predictActions(enemy,'hp',3);
  assert.deepEqual(p.steps.map(s=>[s.turn,s.skills[0].id]),[[0,905],[1,902],[2,903],[3,903]]);
  assert.equal(p.uncertain,true);
  assert.equal(predictActions(enemy,'none').known,false);
});

test('rule schedule: battle start and every N turns capped by term',()=>{
  assert.deepEqual(ruleSchedule({timing:['OnBattleStart']},30),[1]);
  assert.deepEqual(ruleSchedule({timing:['OnEveryTurn'],interval:3,term:10},30),[3,6,9,12,15,18,21,24,27,30]);
  assert.deepEqual(ruleSchedule({timing:['OnEveryTurn'],interval:1,term:3},30),[1,2,3]);
});

test('weakness summary and rule weeks',()=>{
  const w=weaknessSummary({resist:{element:{fire:-150,ice:0,thunder:50,slash:0,absorb_element_list:null}}});
  assert.deepEqual(w.weak,['fire']);assert.deepEqual(w.resist,['thunder']);
  const ev={rules:[{id:1,inDate:'2026-10-16T02:00:00Z',outDate:'2026-10-23T01:59:59Z'},{id:2,inDate:'2026-10-23T02:00:00Z',outDate:'2026-10-30T01:59:59Z'},{id:3,inDate:'2026-10-16T02:00:00Z',outDate:'2026-10-23T01:59:59Z'}]};
  assert.deepEqual(ruleWeeks(ev).map(w=>w.rules.map(r=>r.id)),[[1,3],[2]]);
  assert.deepEqual(rulesOn(ev,'2026-10-25T00:00:00Z').map(r=>r.id),[2]);
});
