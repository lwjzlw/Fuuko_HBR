import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeResultSettings, packOptimizationResult, scoreGap, ruleCombinations} from '../public/planner-results.mjs';

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
