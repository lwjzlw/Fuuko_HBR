import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {plannerPhases,withEnemyParameters,enemyParameterKey,enemyContextKey,BATTLE_MODEL_VERSION,resultMatchesEnemies,sameRuleIds} from '../public/planner-enemies.mjs';

const event=()=>JSON.parse(readFileSync(new URL('../public/data/bosses/wave/WaveBattle0008.json',import.meta.url),'utf8'));
test('wave enemy context uses the confirmed border while preserving unverified public DP/HP',()=>{
  const ev=event(),ph=plannerPhases(ev,ev.stages[0],{waveSettings:{difficulty:40}});
  assert.equal(ph.length,5);assert.equal(ph[0].enemies.length,3);
  assert.ok(ph.flatMap(p=>p.enemies).every(x=>x.border===775));
  assert.deepEqual(ph[0].enemies.map(x=>[x.maxDp,x.maxHp]),[[18000,24000],[6400,3600],[6400,3600]]);
  assert.ok(ph.flatMap(p=>p.enemies).every(x=>x.parameterSource.difficultyVerified===false));
  assert.equal(ev.stages[0].enemies[0].paramBorder,750);
});
test('local enemy overrides are scoped to the level and target and propagate into all consumers',()=>{
  const ev=event(),s=ev.stages[0],x=s.enemies[0],key=enemyParameterKey(s,x,40);
  const overrides={[key]:{dp:0,hp:123456,border:800}};
  const changed=plannerPhases(ev,s,{waveSettings:{difficulty:40},overrides});
  assert.deepEqual([changed[0].enemies[0].dp,changed[0].enemies[0].maxHp,changed[0].enemies[0].border],[[],123456,800]);
  assert.equal(changed[0].enemies[1].border,775);
  const lower=plannerPhases(ev,s,{waveSettings:{difficulty:39},overrides});
  assert.equal(lower[0].enemies[0].maxDp,18000);assert.equal(lower[0].enemies[0].border,750);
  const one={...ev,kind:'dimension'},singleKey=enemyParameterKey(s,x);
  const single=plannerPhases(one,s,{enemyLabel:x.label,overrides:{[singleKey]:{border:801}}});
  assert.equal(single.length,1);assert.equal(single[0].enemies.length,1);assert.equal(single[0].enemies[0].border,801);
});
test('old scores are invalidated by the battle revision or an enemy parameter change',()=>{
  const ev=event(),ph=plannerPhases(ev,ev.stages[0],{}),key=enemyContextKey(ph);
  const result={battleVersion:BATTLE_MODEL_VERSION,enemyContextKey:key};
  assert.equal(resultMatchesEnemies(result,key),true);assert.equal(resultMatchesEnemies({},key),false);
  ph[0].enemies[0].maxHp+=1;assert.equal(resultMatchesEnemies(result,enemyContextKey(ph)),false);
});
test('local difficulty tables join phases and labelled enemies without changing public data or override identities',()=>{
  const ev=event(),original=structuredClone(ev);
  const mk=n=>ev.stages.map((s,i)=>({phase:s.phase,battleLabel:'synthetic-battle-'+i,parameterSource:{kind:'installed-game-static'},
    enemies:s.enemies.filter(x=>x.label).map((x,j)=>({label:x.label,slot:j+(i>0?1:0),dp:n+i*100+j,hp:n*2,paramBorder:800}))}));
  const merged=withEnemyParameters(ev,{events:{[ev.label]:{difficultyStages:{40:mk(100000),39:mk(90000)}}}});
  assert.deepEqual(ev,original);
  const a=plannerPhases(merged,ev.stages[0],{waveSettings:{difficulty:40}}),b=plannerPhases(merged,ev.stages[0],{waveSettings:{difficulty:39}});
  assert.equal(a[0].enemies[0].maxDp,100000);assert.equal(b[0].enemies[0].maxDp,90000);
  assert.ok(a.flatMap(x=>x.enemies).every(x=>x.border===800&&x.parameterSource.difficultyVerified));
  const key=enemyParameterKey(ev.stages[0],ev.stages[0].enemies[0],40);
  const custom=plannerPhases(merged,ev.stages[0],{waveSettings:{difficulty:40},overrides:{[key]:{dp:123}}});
  assert.equal(custom[0].enemies[0].maxDp,123);
  const bad=mk(100000);bad[0].enemies[0].label='wrong-enemy';
  const mixed=withEnemyParameters(ev,{events:{[ev.label]:{difficultyStages:{40:mk(100000),10:bad}}}});
  assert.equal(plannerPhases(mixed,ev.stages[0],{waveSettings:{difficulty:40}})[0].enemies[0].maxDp,100000);
  assert.throws(()=>plannerPhases(mixed,ev.stages[0],{waveSettings:{difficulty:10}}),/难度 10.*标签不匹配/);
});
test('scoring context invalidates old scores even when enemy parameters coincide',()=>{
  const ev=event(),ph=plannerPhases(ev,ev.stages[0],{waveSettings:{difficulty:39}});
  const key=w=>enemyContextKey(ph,{wave:{difficulty:39,international:true,overkill:true,...w}});
  assert.notEqual(key({}),key({difficulty:38}));assert.notEqual(key({}),key({international:false}));assert.notEqual(key({}),key({overkill:false}));
  assert.ok(sameRuleIds([2,1],[1,2]));assert.ok(!sameRuleIds([], [1]));assert.ok(!sameRuleIds(undefined,[]));
});
