import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {optimize,createTaskHandler} from '../public/sim/optimizer.mjs';
import {TEAM_ELEMENTS,normalizeTeamElement,resultLimit,candidateIdentity,attackElements,elementSummary} from '../public/sim/optimizer-options.mjs';
import {buildParty,initialState,cloneState,startTurn,act,NORMAL} from '../public/sim/hbr/battle.mjs';
import {membersFrom} from '../public/sim/party.mjs';
import {search} from '../public/sim/search.mjs';
import {designFromPlan,simulateDesign,mulberry32,monteCarlo,monteCarloSampleSeed} from '../public/sim/designer.mjs';

test('optimizer identity preserves slots, front, full equipment rolls and support',()=>{
  const {base}=optimizerInput(),raws=base.map(m=>m.raw),front=base.map(m=>m.front);
  const key=candidateIdentity(raws,front);
  assert.notEqual(key,candidateIdentity(raws.toReversed(),front));
  assert.notEqual(key,candidateIdentity(raws,front.toReversed()));
  for(const extra of [{supportStyleId:'support'},{latentIds:[123]},{skillIds:[456]},{accessories:{ring:{masterId:1,main:[2],expansion:[3]}}}]){
    const changed=raws.slice();changed[0]={...changed[0],...extra};assert.notEqual(key,candidateIdentity(changed,front));
  }
  const presented=raws.map(r=>({...r,_changes:['display only'],_new:true,_earNote:'display'}));
  assert.equal(key,candidateIdentity(presented,front));
  assert.notEqual(key,candidateIdentity(raws,front,1));
});

test('element capabilities inspect attacks in branches, not card element or role',()=>{
  const skill={parts:[{skillType:'SkillCondition',branches:[{parts:[{skillType:'AttackSkill',elements:['Ice']}]},{parts:[{skillType:'AttackSkill',elements:[]}]}]}]};
  assert.deepEqual([...attackElements([skill])],['ice','nonelemental']);
  assert.equal(attackElements([{parts:[{skillType:'AttackUp',elements:['Ice']}]}]).size,0);
  assert.equal(attackElements([{passive:{},parts:[{skillType:'AttackSkill',elements:['Fire']}]}]).size,0);
  assert.equal(normalizeTeamElement(null),'');assert.equal(resultLimit(undefined),10);assert.equal(resultLimit(100),20);
  assert.throws(()=>normalizeTeamElement('water'),/未知/);
});

test('element summary requires actual dominant skill damage, with non-elemental distinct from unrestricted',()=>{
  assert.equal(elementSummary({},'nonelemental').elementMatch,false);
  assert.equal(elementSummary({ice:10,fire:30},'ice').elementMatch,false);
  const s=elementSummary({ice:60,fire:40},'ice');assert.equal(s.elementMatch,true);assert.equal(s.elementShare,0.6);
  assert.equal(elementSummary({ice:60,fire:40},'').teamElement,'ice');
});

test('tracking actual damage does not label ordinary attacks as a non-elemental team',()=>{
  const input=optimizerInput(),{members}=membersFrom({members:input.base},input.archive,input.data.catalog);
  const party=buildParty(members,input.data),enemy=input.target.phases[0].enemies[0];
  const st=initialState(party,enemy,{trackElements:true,critMode:'none'});startTurn(st);
  act(st,0,NORMAL);assert.deepEqual(st.skillDamageByElement,{});
  const clone=cloneState(st);act(clone,0,0);
  assert.ok(clone.skillDamageByElement.ice>0);assert.deepEqual(st.skillDamageByElement,{});
});

test('fast search summary returns identical scores and plans without unused replay logs',()=>{
  const input=optimizerInput(),{members}=membersFrom({members:input.base},input.archive,input.data.catalog);
  const ctx={party:buildParty(members,input.data),enemy:input.target.phases[0].enemies[0]};
  const opts={objective:'minTurns',maxTurns:4,beam:4,critMode:'expected',top:1};
  const a=search(ctx,opts),b=search(ctx,{...opts,trace:false});
  assert.deepEqual(a.plans.map(x=>({plan:x.plan,value:x.value,vitals:x.vitals,totalDamage:x.totalDamage})),b.plans.map(x=>({plan:x.plan,value:x.value,vitals:x.vitals,totalDamage:x.totalDamage})));
  assert.ok(a.plans[0].log.length);assert.equal(b.plans[0].log,null);
});

test('lightweight Monte Carlo replay matches traced phases, issues, final state and random samples',()=>{
  const input=optimizerInput(),{members}=membersFrom({members:input.base},input.archive,input.data.catalog);
  const party=buildParty(members,input.data),ctx={party,enemy:input.target.phases[0].enemies[0],phases:input.target.phases};
  const r=search(ctx,{objective:'minTurns',maxTurns:4,beam:4,critMode:'expected',top:1});
  const design=designFromPlan(r.plans[0].plan,party);
  for(const seed of [1,2,3,7,19]){
    const opts={critMode:'random',enemyTargeting:'random',enemyVariance:'random',extendTurns:2};
    const a=simulateDesign(ctx,{...opts,rng:mulberry32(seed)},design);
    const b=simulateDesign(ctx,{...opts,rng:mulberry32(seed),trace:false},design);
    for(const field of ['issues','phases','turns','failed','final','flags'])assert.deepEqual(a[field],b[field]);
    assert.ok(a.rows.length>0);assert.equal(b.rows.length,0);
  }
  const n=40,samples=Array.from({length:n},(_,i)=>simulateDesign(ctx,{critMode:'random',enemyTargeting:'random',enemyVariance:'random',extendTurns:2,rng:mulberry32(monteCarloSampleSeed(7,i))},design));
  assert.ok(samples.every(s=>!s.failed&&s.phases.every(p=>p.cleared)));
  const scoreOf=s=>s.phases.reduce((v,p)=>v+p.shown,0),scores=samples.map(scoreOf).sort((a,b)=>a-b),turns=samples.map(s=>s.turns).sort((a,b)=>a-b);
  const expected={n,successes:n,success:1,onPlan:samples.filter(s=>s.phases.every(p=>!p.extended)).length/n,turnsMedian:turns[Math.floor(n/2)],fails:{},scoreBasis:'successful',scoreSamples:n,scoreMean:scores.reduce((a,b)=>a+b,0)/n,scoreP10:scores[Math.floor(n*0.1)]};
  assert.deepEqual(monteCarlo(ctx,{},design,{n,seed:7,scoreOf}),expected);
});

test('a clear after skipping an illegal planned action is a failed Monte Carlo sample',()=>{
  const input=optimizerInput(),{members}=membersFrom({members:input.base},input.archive,input.data.catalog);
  const party=buildParty(members,input.data),ctx={party,enemy:input.target.phases[0].enemies[0],phases:input.target.phases};
  const result=search(ctx,{objective:'minTurns',maxTurns:4,beam:4,critMode:'expected',top:1});
  const design=designFromPlan(result.plans[0].plan,party),actions=design.phases[0].turns[0].actions;
  actions.splice(1,0,{...actions[0]});
  const replay=simulateDesign(ctx,{critMode:'expected'},design);
  assert.ok(replay.phases.every(p=>p.cleared));assert.ok(replay.issues.some(x=>x.level==='error'));
  const mc=monteCarlo(ctx,{},design,{n:20,seed:7,scoreOf:()=>100000});
  assert.equal(mc.success,0);assert.equal(mc.onPlan,0);assert.equal(mc.successes,0);assert.equal(mc.scoreSamples,0);assert.equal(mc.scoreMean,null);assert.equal(mc.scoreP10,null);
  assert.equal(mc.fails['计划含不可用行动'],20);
});

test('optimizer returns requested ranked alternatives without suppressing similar lineups',async()=>{
  const r=await optimize(optimizerInput());
  assert.deepEqual(r.errors,[]);assert.equal(r.top.length,10);
  assert.ok(r.top.every((v,i)=>!i||r.top[i-1].mc.scoreMean>=v.mc.scoreMean));
  assert.equal(new Set(r.top.map(x=>JSON.stringify([x.members.map(m=>m.styleId),x.rule,x.design]))).size,r.top.length);
});

test('twenty-result search retains the smaller shortlist best instead of replacing it for diversity',async()=>{
  const a=await optimize(optimizerInput({count:24,opts:{top:2}}));
  const b=await optimize(optimizerInput({count:24,opts:{top:20}}));
  assert.deepEqual(b.errors,[]);assert.equal(b.top.length,20);
  assert.ok(b.top[0].mc.scoreMean>=a.top[0].mc.scoreMean);
});

for(const teamElement of TEAM_ELEMENTS)test(`optimizer ${teamElement} allows mixed-element support and ignores role labels`,async()=>{
  const input=optimizerInput({opts:{teamElement}}),r=await optimize(input);
  assert.deepEqual(r.errors,[]);assert.ok(r.top.length>0);
  for(const t of r.top){assert.equal(t.teamElement,teamElement);assert.equal(elementSummary(t.elementDamage,teamElement).elementMatch,true);
    assert.ok(t.members.some(m=>!input.data.catalog.styles.find(s=>s.id===m.styleId).elements.includes(teamElement[0].toUpperCase()+teamElement.slice(1))));}
});

test('fixed lineup preserves all six members, and absent output element returns no misleading team',async()=>{
  const input=optimizerInput({count:6,opts:{fixedTeam:true,teamElement:'ice'}}),r=await optimize(input);
  assert.ok(r.top.length);for(const t of r.top)assert.deepEqual(t.members.map(m=>m.styleId),input.base.map(m=>m.styleId));
  for(const s of Object.values(input.data.skills.styles))for(const p of s.skills[0].parts)p.elements=['Fire'];
  const none=await optimize(input);assert.deepEqual(none.errors,[]);assert.equal(none.top.length,0);
});

test('inline coordinator and asynchronous task handler produce the same fixed-input ranking',async()=>{
  const input=optimizerInput({count:8,opts:{top:5}}),direct=await optimize(input);
  const handler=createTaskHandler(input),via=await optimize(input,()=>{},{size:1,run:task=>Promise.resolve(structuredClone(handler(structuredClone(task))))});
  const signature=r=>r.top.map(x=>({members:x.members.map(m=>m.styleId),design:x.design,mean:x.mc.scoreMean}));
  assert.deepEqual(signature(direct),signature(via));
});
