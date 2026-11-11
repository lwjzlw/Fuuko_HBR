import assert from 'node:assert/strict';
import test from 'node:test';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {optimize} from '../public/sim/optimizer.mjs';
import {transferActorAxis} from '../public/sim/axis-neighborhood.mjs';
import {longSearchKey,runLongSearch,waveScoreCeiling} from '../public/sim/long-search.mjs';

function startingAxis(input){
  return {label:'original',ruleIds:[],members:input.base,design:{phases:[{turns:[{actions:[{u:0,s:'Skill0'}]}]}]}};
}
const rating=(candidate,score,success=1)=>({...candidate,mc:{success,onPlan:success,scoreMean:score,n:40,successes:Math.round(40*success)}});

test('a held-out rerank uses its own outcomes, keeps failed samples in the rate, and never feeds its score back into the search',async()=>{
  const input=optimizerInput({opts:{minSuccess:.8,minSuccessBasis:'onPlan',seed:16}});
  const a=startingAxis(input),b={...a,label:'alternative',design:{phases:[{turns:[{actions:[{u:1,s:'Skill1'}]}]}]}};
  input.incumbents=[a,b];const calls=[];let checkpoint;
  const runPass=async pass=>{
    calls.push(pass.opts);
    const holdout=pass.opts.longPassKind==='validate';
    return {top:holdout?[rating(a,99,.75),rating(b,88,.95)]:[rating(a,101,.9),rating(b,85,.85)],threads:2,evaluated:2,screened:2};
  };
  const result=await runLongSearch(input,{runPass,maxPasses:1,onCheckpoint:c=>{checkpoint=c;}});
  assert.deepEqual(calls.map(x=>x.longPassKind),['baseline','validate']);
  assert.notEqual(calls[0].mcSeed??7,calls[1].mcSeed);
  assert.equal(result.top[0].label,'alternative');assert.equal(result.top.length,1);
  assert.equal(result.longSearch.validated,true);assert.equal(checkpoint.result.top[0].mc.scoreMean,101);
  calls.length=0;
  const resumed=await runLongSearch(input,{runPass,maxPasses:2,checkpoint});
  assert.deepEqual(calls.map(x=>x.longPassKind),['transfer','explore','validate']);
  assert.equal(resumed.longSearch.rounds,3);assert.equal(resumed.screened,6);
});

test('checkpoint scope follows stock, selected party locks, rule settings and scoring but allows more time',()=>{
  const input=optimizerInput({opts:{fixedTeam:true,keepLoadout:true,longMinutes:60}}),key=longSearchKey(input);
  input.opts.longMinutes=360;assert.equal(longSearchKey(input),key);
  const mutate=fn=>{const i=structuredClone(input);fn(i);assert.notEqual(longSearchKey(i),key);};
  mutate(i=>{i.base[0].raw.supportStyleId='other';});mutate(i=>{i.archive.gameInventory={entries:[{amount:2}]};});
  mutate(i=>{i.opts.minSuccess=.5;});mutate(i=>{i.opts.battleVersion='different';});
  mutate(i=>{i.opts.searchRules=true;});mutate(i=>{i.opts.mcRuns=64;});
});
test('the score ceiling includes each eligible multiplier and one counted turn per phase',()=>{
  const phases=Array.from({length:5},()=>({})),target={kind:'wave',difficulty:40,international:true,phases,
    ruleOptions:[{phases,rules:[]},{phases,rules:[{grade:30}]}]};
  assert.equal(waveScoreCeiling(target),166842);assert.equal(waveScoreCeiling({...target,kind:'dimension'}),null);
});

test('changing an actor rewrites that slot using equipped skill effects and preserves the remaining five actors',()=>{
  const skill=(id,label,skillType)=>({id,label,sp:3,parts:[{skillType,targetType:'Single'}]});
  const old={skills:[skill(1,'ice','AttackSkill')]},team=Array.from({length:6},(_,i)=>({i,skills:[]}));
  team[1].skills=[skill(2,'heal','HealDpRate'),skill(3,'replacement','AttackSkill')];
  const actions=[{u:0,s:'unchanged'},{u:1,s:'ice'},{u:2,s:'normal'}];
  const design={phases:[{turns:[{actions,commands:[{u:1,s:'removed'},{u:2,s:'preserved'}],odEnd:{rounds:[{actions}]}}]}]};
  const next=transferActorAxis(design,1,old,team,1,()=>.5);
  const turn=next.design.phases[0].turns[0];
  assert.equal(turn.actions[1].s,'replacement');assert.equal(turn.odEnd.rounds[0].actions[1].s,'replacement');
  assert.deepEqual(next.ids,[3]);assert.deepEqual(turn.actions[0],actions[0]);assert.deepEqual(turn.commands,[{u:2,s:'preserved'}]);
  assert.equal(design.phases[0].turns[0].actions[1].s,'ice');
});

test('a discovered no-rule axis replays unchanged on the bonus rule using that rule’s enemies',async()=>{
  const input=optimizerInput({count:6,opts:{longSearch:true,longPassKind:'baseline',fixedTeam:true,keepLoadout:true,mcRuns:8}});
  input.base.forEach((m,i)=>{m.deckSkillIds=[100+i];m.raw.skillIds=m.deckSkillIds;});
  input.incumbents=[startingAxis(input)];
  const rules=[{id:'bonus',grade:30}];
  input.target.phases[0].enemies[0].hp=input.target.phases[0].enemies[0].maxHp=1;
  input.target.phases[0].enemies[0].maxDp=0;
  input.target.ruleOptions=[{ids:[],rules:[],phases:input.target.phases},{ids:['bonus'],rules,phases:structuredClone(input.target.phases)}];
  const first=await optimize(input);
  assert.deepEqual(first.top[0].ruleIds,['bonus']);assert.deepEqual(first.top[0].design,input.incumbents[0].design);
  assert.ok(first.moves.rule>0);
  const harderEnemy=input.target.ruleOptions[1].phases[0].enemies[0];
  harderEnemy.hp=harderEnemy.maxHp=1e12;
  const harder=await optimize(input);assert.deepEqual(harder.top[0].ruleIds,[]);
  input.opts.searchRules=false;
  const locked=await optimize(input);assert.ok(locked.top.every(t=>!t.ruleIds.length));assert.equal(locked.moves.rule,undefined);
});
test('a real saved axis can finish baseline, axis edits and independent validation without generating equipment when locked',async()=>{
  const input=optimizerInput({count:6,opts:{fixedTeam:true,keepLoadout:true,maxTurns:2,axisTrials:4,validationRuns:8,mcRuns:8,top:5}});
  input.base.forEach((m,i)=>{m.deckSkillIds=[100+i];m.strictDeckSkills=true;m.raw.skillIds=m.deckSkillIds;});
  input.incumbents=[startingAxis(input)];
  const checkpoints=[];
  const result=await runLongSearch(input,{runPass:optimize,maxPasses:2,onCheckpoint:c=>checkpoints.push(c)});
  assert.deepEqual(checkpoints.map(c=>c.rounds),[1,2]);assert.equal(result.longSearch.counts.axis,1);
  assert.ok(result.top.length);assert.ok(result.top.every(t=>t.mc.n===8&&t.members.every((m,i)=>m.styleId===input.base[i].styleId)));
  assert.equal(result.longSearch.moves.equipment,undefined);
});
