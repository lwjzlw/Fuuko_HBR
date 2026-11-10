import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeResultSettings, packOptimizationResult, scoreGap, ruleCombinations,successfulScores,optimizationScope,reusableCandidates} from '../public/planner-results.mjs';

test('old or invalid settings retain ten results and unrestricted teams', () => {
  assert.deepEqual(normalizeResultSettings(), {teamElement: '', top: 10});
  assert.deepEqual(normalizeResultSettings({teamElement: 'healer', top: -1}), {teamElement: '', top: 10});
  assert.deepEqual(normalizeResultSettings({teamElement: 'nonelemental', top: '20'}), {teamElement: 'nonelemental', top: 20});
});

test('latest search snapshot restores alternate teams, rules and axes without aliasing live state', () => {
  const t = {label: 'candidate', members: [{styleId: 'ice-output', raw: {skillIds: [1]}}],
    ruleIds: [2], design: {phases: [{turns: [{actions: [{u: 0, s: 'attack'}]}]}]},
    mc: {n: 100, success: 0.9, scoreMean: 123}, teamElement: 'ice', elementShare: 0.7,
    internalSearchState: {discard: true}};
  const r = packOptimizationResult('wave:test', {top: Array(25).fill(t), goal: 'score', errors: [{error: 'private debug'}]}, {teamElement: 'ice', top: 20}, 1);
  t.members[0].raw.skillIds.push(99);
  assert.equal(r.top.length, 20);
  assert.equal(r.selected, 1);
  assert.equal(r.teamElement, 'ice');
  assert.deepEqual(r.top[1].members[0].raw.skillIds, [1]);
  assert.deepEqual(r.top[1].ruleIds, [2]);
  assert.equal(r.top[1].design.phases[0].turns[0].actions[0].s, 'attack');
  assert.equal(r.top[1].internalSearchState, undefined);
  assert.equal(r.errors, undefined);
  assert.equal(r.errorCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r)).top[1], r.top[1]);
});

test('score gaps handle absent scores and tied ranks', () => {
  assert.equal(scoreGap(100, 90), 10);
  assert.equal(scoreGap(100, 100), 0);
  assert.equal(scoreGap(null, 90), null);
});

test('rule search includes no-rule and smaller subsets rather than forcing maximum bonuses', () => {
  const rules = [{id: 1}, {id: 2}, {id: 3}];
  const combos = ruleCombinations(rules, 2).map(rs => rs.map(r => r.id));
  assert.deepEqual(combos, [[], [1], [1, 2], [1, 3], [2], [2, 3], [3]]);
  assert.deepEqual(ruleCombinations(rules, 0), [[]]);
  assert.deepEqual(ruleCombinations([], 1), [[]]);
});

test('old zero-filled averages migrate to successful means without inventing successful quantiles',()=>{
  assert.deepEqual(successfulScores({n:20,success:0.25,scoreMean:25000,scoreP10:0}),{mean:100000,p10:null,successes:5,samples:5,converted:true});
  assert.equal(successfulScores({n:20,success:0,scoreMean:0,scoreP10:0}).mean,null);
  assert.equal(successfulScores({n:20,success:1,scoreMean:100,scoreP10:90}).p10,90);
  assert.deepEqual(successfulScores({n:20,success:0.25,successes:5,scoreBasis:'successful',scoreSamples:5,scoreMean:100000,scoreP10:99000}),
    {mean:100000,p10:99000,successes:5,samples:5,converted:false});
  assert.equal(successfulScores({scoreMean:123}).mean,null);
});

test('history compatibility ignores depth/adopted team but tracks targets, resources and battle settings',()=>{
  const input={target:{kind:'wave',difficulty:40,international:true,phases:[{enemies:[{hp:100}]}],rules:[],cards:[null]},
    opts:{scale:'standard',overkill:true,allOrbs:true,optimizeCards:true},archive:{styles:{A:{owned:true}}},cache:{cards:[{styleId:'A'}],accessories:[]},base:[{styleId:'A'}]};
  const key=optimizationScope('wave:test',input);
  assert.equal(key,optimizationScope('wave:test',{...input,opts:{...input.opts,scale:'deep',threads:12},base:[{styleId:'B'}]}));
  assert.notEqual(key,optimizationScope('wave:other',input));
  assert.notEqual(key,optimizationScope('wave:test',{...input,target:{...input.target,difficulty:35}}));
  assert.notEqual(key,optimizationScope('wave:test',{...input,opts:{...input.opts,allOrbs:false}}));
  assert.notEqual(key,optimizationScope('wave:test',{...input,cache:{...input.cache,cards:[{styleId:'A',limitBreak:4}]}}));
  for(const table of ['catalog','skills','stats','equipment']){
    const a={...input,data:{[table]:{schemaVersion:1,generatedAt:'first'}}};
    const b={...input,data:{[table]:{schemaVersion:1,generatedAt:'updated'}}};
    assert.notEqual(optimizationScope('wave:test',a),optimizationScope('wave:test',b));
  }
});

test('compatible history passes only axes and members for fresh scoring and keeps current manual axis',()=>{
  const t={members:[{styleId:'A'}],design:{phases:[{turns:[{actions:[{u:0,s:'hit'}]}]}]},ruleIds:[1],label:'previous',mc:{scoreMean:999999}};
  const saved={targetKey:'wave:test',scopeKey:'same',top:[t]},current={...t,label:'current'};
  const list=reusableCandidates(saved,'wave:test','same',current);
  assert.equal(list.length,1);assert.equal(list[0].mc,undefined);assert.equal(list[0].label,'current');
  assert.deepEqual(reusableCandidates(saved,'wave:other','same'),[]);
  assert.deepEqual(reusableCandidates(saved,'wave:test','changed'),[]);
  assert.equal(reusableCandidates({...saved,scopeKey:null},'wave:test','new').length,1);
  list[0].members[0].styleId='changed';assert.equal(t.members[0].styleId,'A');
  const packed=packOptimizationResult('wave:test',{top:[t],searchBudget:{evaluations:144},incumbents:1},{scopeKey:'same'});
  assert.equal(packed.scopeKey,'same');assert.equal(packed.searchBudget.evaluations,144);assert.equal(packed.incumbents,1);
});
