import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {buildParty} from '../public/sim/hbr/battle.mjs';
import {monteCarlo,monteCarloSampleSeed,mulberry32,simulateDesign} from '../public/sim/designer.mjs';

function fixture({randomLoss=false}={}){
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  const enemy={...input.target.phases[0].enemies[0],hp:1,maxHp:1};
  const turns=[];
  if(randomLoss){
    // First turn: a random front member is targeted. Only member 0 is fragile.
    party[0].dpMax=1;party[0].hpMax=1;
    enemy.pattern={hp:{entries:[{order:1,skills:[1]}]}};
    enemy.skills=[{id:1,name:'Synthetic hit',parts:[{skillType:'AttackFixedDamageDefinitely',targetType:'Single',power:[100,100]}]}];
    turns.push({actions:[]});
  }
  turns.push({actions:[{u:0,s:'Skill0'}]});
  return {ctx:{party,phases:[{enemies:[enemy]}],statusTypes:{}},design:{phases:[{turns}]}};
}

test('knockout samples affect success rate but never dilute successful scores',()=>{
  const {ctx,design}=fixture({randomLoss:true});let calls=0;
  const mc=monteCarlo(ctx,{extendTurns:0},design,{n:48,seed:7,scoreOf:()=>{calls++;return 100000;}});
  assert.ok(mc.successes>0&&mc.successes<mc.n,'fixture must include both clears and knockouts');
  assert.equal(mc.scoreBasis,'successful');assert.equal(mc.scoreMean,100000);assert.equal(mc.scoreP10,100000);
  assert.equal(mc.scoreSamples,mc.successes);assert.equal(calls,mc.successes);
  assert.equal(mc.success,mc.successes/mc.n);assert.equal(mc.onPlan,mc.success);
  assert.equal(mc.fails['第 1 回合失败'],mc.n-mc.successes);
});

test('all failed samples have unknown score, and a real successful zero score remains zero',()=>{
  const {ctx,design}=fixture();
  const impossible={phases:[{turns:[{actions:[]}]}]};
  const none=monteCarlo(ctx,{extendTurns:0},impossible,{n:12,seed:1,scoreOf:()=>assert.fail('must not score a failure')});
  assert.equal(none.successes,0);assert.equal(none.scoreSamples,0);assert.equal(none.scoreMean,null);assert.equal(none.scoreP10,null);
  assert.equal(Object.values(none.fails).reduce((a,b)=>a+b,0),12);
  const zero=monteCarlo(ctx,{},design,{n:8,seed:1,scoreOf:()=>0});
  assert.equal(zero.successes,8);assert.equal(zero.scoreSamples,8);assert.equal(zero.scoreMean,0);assert.equal(zero.scoreP10,0);
  const noScore=monteCarlo(ctx,{},design,{n:8,seed:1});
  assert.equal(noScore.successes,8);assert.equal(noScore.scoreSamples,0);assert.equal(noScore.scoreMean,null);
});

test('sampling is reproducible and extending its budget preserves the original sample prefix',()=>{
  const {ctx,design}=fixture(),shown=s=>s.phases[0].shown;
  const first=[],larger=[];
  const a=monteCarlo(ctx,{},design,{n:5,seed:19,scoreOf:s=>{const v=shown(s);first.push(v);return v;}});
  monteCarlo(ctx,{},design,{n:12,seed:19,scoreOf:s=>{const v=shown(s);larger.push(v);return v;}});
  assert.deepEqual(first,larger.slice(0,first.length));
  assert.deepEqual(a,monteCarlo(ctx,{},design,{n:5,seed:19,scoreOf:shown}));
  for(let i=0;i<first.length;i++){
    const sample=simulateDesign(ctx,{critMode:'random',enemyTargeting:'random',enemyVariance:'random',rng:mulberry32(monteCarloSampleSeed(19,i)),extendTurns:2,trace:false},design);
    assert.equal(first[i],shown(sample),'sample '+i+' must not depend on random draws consumed by earlier battles');
  }
});

test('sample counts and scoring callbacks cannot yield NaN or Infinity',()=>{
  const {ctx,design}=fixture();
  for(const n of [0,-1,1.5,NaN,Infinity])assert.throws(()=>monteCarlo(ctx,{},design,{n}),/正整数/);
  for(const seed of [NaN,Infinity])assert.throws(()=>monteCarlo(ctx,{},design,{n:1,seed}),/有限数值/);
  for(const value of [NaN,Infinity,-Infinity,null])assert.throws(()=>monteCarlo(ctx,{},design,{n:1,scoreOf:()=>value}),/评分必须是有限数值/);
});
