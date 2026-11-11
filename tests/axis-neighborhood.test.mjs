import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {buildParty,cloneState,initialState} from '../public/sim/hbr/battle.mjs';
import {monteCarlo} from '../public/sim/designer.mjs';
import {refineAxis} from '../public/sim/axis-neighborhood.mjs';
import {carryFrontier} from '../public/sim/search.mjs';
import {createTaskHandler} from '../public/sim/optimizer.mjs';

test('long search improves an already reliable route by bringing in a stronger backliner',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  const enemy={...input.target.phases[0].enemies[0],hp:100,maxHp:100};
  for(const u of party){
    u.skills=u.skills.slice(0,1);
    u.skills[0].parts=[{...u.skills[0].parts[0],elements:[],power:u.i===4?[34000,34000]:[1200,1200]}];
  }
  const ctx={party,phases:[{enemies:[enemy]}],statusTypes:{}};
  const original={phases:[{turns:[{front:[0,1,2],actions:[{u:0,s:'Skill0'},{u:1,s:'Skill1'},{u:2,s:'Skill2'}]}]}]};
  const untouched=structuredClone(original),scoreOf=r=>r.phases[0].shown;
  const stats=d=>monteCarlo(ctx,{extendTurns:0},d,{n:32,seed:14099,scoreOf});
  const before=stats(original);assert.equal(before.onPlan,1);
  const options={limit:216,samples:3,seed:309,scoreOf,optimizeCards:false,minSuccess:1};
  const result=refineAxis(ctx,original,options);
  assert.deepEqual(original,untouched);
  assert.deepEqual(result,refineAxis(ctx,original,options));
  const best=result.designs.map(stats).sort((a,b)=>b.scoreMean-a.scoreMean)[0];
  assert.equal(best.onPlan,1);assert.ok(best.scoreMean>before.scoreMean*5);
  assert.ok(result.tried.front>0&&result.tried.skill>0&&result.tried.order>0&&result.tried.od>0);
  assert.equal(result.tried.card,undefined);
});

test('same aggregate SP on a different ally can survive selection between phases',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  const initial=initialState(party,input.target.phases[0].enemies[0],{}),paths=[];
  for(const i of [1,2,3]){
    const state=cloneState(initial);state.units.forEach(u=>{u.sp=u.i===i?18:4;});
    paths.push({i,state,score:100-i});
  }
  const frontier=carryFrontier(paths,x=>x.state,x=>x.score,{limit:4,seed:91});
  assert.deepEqual(frontier.map(p=>p.i).sort(),[1,2,3]);
});

test('incumbent worker refines a winning equipped design and only replays it for final validation',()=>{
  const input=optimizerInput({count:6,opts:{longSearch:true,fixedTeam:true,axisTrials:216,seed:309,minSuccess:1}});
  Object.assign(input.target.phases[0].enemies[0],{hp:100,maxHp:100});
  for(const [i,m] of input.base.entries()){
    m.deckSkillIds=[100+i];m.strictDeckSkills=true;
    const attack=input.data.skills.styles['S'+i].skills[0].parts[0];
    Object.assign(attack,{elements:[],power:i===4?[34000,34000]:[1200,1200]});
  }
  const design={phases:[{turns:[{front:[0,1,2],actions:[{u:0,s:'Skill0'},{u:1,s:'Skill1'},{u:2,s:'Skill2'}]}]}]};
  const x={label:'起点 · 优化排轴',members:input.base,design,ruleIds:[]};
  const run=(pass,incumbent=x)=>createTaskHandler({...input,opts:{...input.opts,longPassKind:pass,mcSeed:143}})({type:'incumbent',incumbent});
  const baseline=run('baseline').r;
  assert.equal(baseline.mc.success,1);assert.deepEqual(baseline.design,design);assert.equal(baseline.alternatives,undefined);
  const revised=run('axis').r;
  assert.equal(revised.mc.success,1);assert.ok(revised.mc.scoreMean>baseline.mc.scoreMean);
  assert.equal(revised.label,'起点 · 优化排轴');
  assert.ok(revised.alternatives.some(r=>JSON.stringify(r.design)===JSON.stringify(design)));
  const final=run('validate',revised).r;
  assert.deepEqual(final.design,revised.design);assert.deepEqual(final.mc,revised.mc);assert.equal(final.alternatives,undefined);
});
