import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {optimize,createTaskHandler} from '../public/sim/optimizer.mjs';
import {SEARCH_PRESETS,searchBudget,normalizeMinSuccess,normalizeSuccessBasis} from '../public/sim/optimizer-options.mjs';
import {membersFromDeck} from '../public/sim/hbr/deck.mjs';

const signature=r=>r.top.map(x=>({members:x.members,design:x.design,mc:x.mc,ruleIds:x.ruleIds}));
function delayedRunner(input,size,reverse){
  const handlers=Array.from({length:size},()=>createTaskHandler(structuredClone(input)));
  const queue=[],free=Array.from({length:size},(_,i)=>i),order=[];let seq=0;
  const pump=()=>{
    while(free.length&&queue.length){const worker=free.shift(),job=queue.shift();
      setTimeout(()=>{
        try{const result=handlers[worker](structuredClone(job.task));order.push(job.id);job.resolve(structuredClone(result));}
        catch(err){job.reject(err);}
        finally{free.push(worker);pump();}
      },reverse?(6-job.id%6)*3:job.id%6);
    }
  };
  return {size,order,run:task=>new Promise((resolve,reject)=>{queue.push({id:++seq,task,resolve,reject});pump();})};
}

test('fixed completed-work budgets replace timing cutoffs and spend fewer samples per finalist',()=>{
  assert.deepEqual(searchBudget({searchEvals:24,searchBatch:6,searchMs:1}),{evaluations:24,batch:6});
  assert.equal(searchBudget({searchMs:0}).evaluations,0);
  assert.equal(searchBudget({searchMs:60000}).evaluations,144);
  assert.equal(SEARCH_PRESETS.standard.searchEvals,144);
  assert.equal(SEARCH_PRESETS.standard.mcRuns,32);
  assert.ok(SEARCH_PRESETS.deep.searchEvals>SEARCH_PRESETS.standard.searchEvals);
});

test('repeated broad searches and reversed Worker completion orders keep the same candidates and ranking',async()=>{
  const input=optimizerInput({count:12,opts:{broad:true,randomSeeds:4,searchEvals:24,searchBatch:6,searchMs:1,top:5}});
  const first=await optimize(structuredClone(input)),repeat=await optimize(structuredClone(input));
  const one=delayedRunner(input,1,false),many=delayedRunner(input,4,true),progress=[];
  const serial=await optimize(structuredClone(input),()=>{},one);
  const parallel=await optimize(structuredClone(input),p=>{if(p.step==='evolve')progress.push([p.done,p.total]);},many);
  assert.deepEqual(first.errors,[]);assert.deepEqual(parallel.errors,[]);
  assert.equal(first.iterations,24);assert.equal(parallel.iterations,24);
  assert.deepEqual(signature(first),signature(repeat));assert.deepEqual(signature(first),signature(serial));assert.deepEqual(signature(first),signature(parallel));
  assert.notDeepEqual(one.order,many.order,'the fixture really completed tasks in different orders');
  assert.deepEqual(progress,[[6,24],[12,24],[18,24],[24,24]]);
});

test('existing good axes are re-evaluated and retained when a later search starts from a different team',async()=>{
  const firstInput=optimizerInput({count:12,opts:{top:5}}),first=await optimize(firstInput);
  const prior=first.top[0];assert.ok(prior.mc.success>0);
  const next=optimizerInput({count:12,opts:{top:5,fixedTeam:false}});
  next.base=next.base.map((m,i)=>({...m,front:i>=3}));
  next.incumbents=[{members:prior.members,design:prior.design,ruleIds:prior.ruleIds,label:'Previous good axis',mc:{scoreMean:1e99}}];
  const after=await optimize(next);
  assert.deepEqual(after.errors,[]);assert.equal(after.incumbents,1);
  assert.ok(after.top[0].mc.scoreMean>=prior.mc.scoreMean);
  const handler=createTaskHandler(next),rated=handler({type:'incumbent',incumbent:next.incumbents[0]}).r;
  assert.deepEqual(rated.mc,prior.mc,'old statistics are ignored and the actual old axis is replayed');
});

test('history reuse respects fixed-team and rule constraints',async()=>{
  const input=optimizerInput({count:12,opts:{top:2}}),prior=(await optimize(input)).top[0];
  const fixed=optimizerInput({count:12,opts:{top:2,fixedTeam:true}});
  fixed.incumbents=[{members:prior.members,design:prior.design,ruleIds:['rule-no-longer-available']}];
  const result=await optimize(fixed);assert.equal(result.incumbents,0);
  assert.ok(result.top.every(t=>t.members.every((m,i)=>m.styleId===fixed.base[i].styleId)));
});

function historyFixture(){
  const input=optimizerInput({count:6,opts:{allOrbs:false,mcRuns:2,searchEvals:0,beam:1,screenBeam:1,maxTurns:1}});
  Object.assign(input.target.phases[0].enemies[0],{hp:1,maxHp:1});
  const prior={members:structuredClone(input.base),ruleIds:[],design:{phases:[{turns:[{actions:[{u:0,s:'Skill0'}]}]}]}};
  return {input,prior};
}
const replayPrior=(input,prior)=>createTaskHandler(input)({type:'incumbent',incumbent:prior});

test('retained axes cannot bypass skill slots, disabled new orbs, or fixed tactical cards',async()=>{
  const cases=[];
  {
    const {input,prior}=historyFixture(),own=input.data.skills.styles.S0;
    for(let i=1;i<=4;i++)own.skills.push({...structuredClone(own.skills[0]),id:1000+i,label:'Extra'+i});
    prior.members[0].deckSkillIds=own.skills.filter(s=>s.label!=='Buff0').map(s=>s.id);
    cases.push({input,prior});
  }
  {
    const {input,prior}=historyFixture();
    input.data.stats.extraSkills['46300001']={...structuredClone(input.data.skills.styles.S0.skills[0]),id:46300001,label:'OrbTest'};
    prior.members[0].deckSkillIds=[46300001];prior.design.phases[0].turns[0].actions[0].s='OrbTest';
    cases.push({input,prior});
  }
  {
    const {input,prior}=historyFixture();
    input.target.phases.push(structuredClone(input.target.phases[0]));input.target.cards=[null,null];
    prior.design.phases.push({card:'sp5',turns:[{actions:[{u:0,s:'Skill0'}]}]});
    cases.push({input,prior});
  }
  for(const {input,prior} of cases){
    assert.equal(replayPrior(input,prior).r,null,'reject illegal retained final axes');
    input.incumbents=[prior];
    const result=await optimize(input);
    assert.equal(result.incumbents,0,'also reject illegal historical seeds before exploration');
    assert.ok(result.top.every(t=>t.cards.every(c=>c===null)),'fixed no-card settings also apply to fresh searches');
  }
});

test('a manually chosen rule remains reusable when rule search is disabled',async()=>{
  const {input,prior}=historyFixture();
  input.target.rules=[{id:'synthetic-rule',name:'Synthetic rule'}];input.opts.searchRules=false;
  prior.ruleIds=['synthetic-rule'];input.incumbents=[prior];
  const result=await optimize(input);
  assert.equal(result.incumbents,1);assert.deepEqual(result.errors,[]);
  assert.deepEqual(replayPrior(input,prior).r.ruleIds,['synthetic-rule']);
});

test('historical support and equipment values are rebuilt while explicit manual stats survive',()=>{
  const {input}=historyFixture();
  Object.assign(input.base[0].raw,{support:structuredClone(input.cache.cards[1]),supportStyleId:'S1',supportLimitBreak:0});
  input.base=membersFromDeck({members:input.base.map(m=>m.raw)},input.data);
  const prior={members:structuredClone(input.base),ruleIds:[],design:{phases:[{turns:[{actions:[{u:0,s:'Skill0'}]}]}]}};
  const oldStrength=prior.members[0].stats.str;
  prior.members[0].stats.dex=777;prior.members[0].statsManual=['dex'];
  prior.members[0].initialSp=99;prior.members[0].equipment.normalAttackUp=999;
  input.data.stats.characters.C1.str=[700,700];
  const expected=membersFromDeck({members:prior.members.map(m=>m.raw)},input.data)[0];
  const result=replayPrior(input,prior);assert.deepEqual(result.errors,[]);assert.ok(result.r);
  assert.notEqual(expected.stats.str,oldStrength);
  assert.equal(result.r.members[0].stats.str,expected.stats.str);
  assert.equal(result.r.members[0].stats.dex,777);
  assert.equal(result.r.members[0].initialSp,expected.initialSp);
  assert.equal(result.r.members[0].equipment.normalAttackUp,expected.equipment.normalAttackUp);
});

test('success thresholds and their basis have explicit bounded defaults',()=>{
  for(const value of [undefined,null,'',NaN,Infinity,-Infinity,'invalid',-0.5])assert.equal(normalizeMinSuccess(value),0);
  assert.equal(normalizeMinSuccess('0.8'),0.8);assert.equal(normalizeMinSuccess(1),1);assert.equal(normalizeMinSuccess(1.5),1);
  for(const value of [undefined,'invalid','onPlan'])assert.equal(normalizeSuccessBasis(value),'onPlan');
  assert.equal(normalizeSuccessBasis('success'),'success');
});

function successThresholdFixture(){
  const input=optimizerInput({count:12,opts:{mcRuns:24,maxTurns:5,top:20,finalists:20}});
  for(let i=0;i<12;i++){
    const s=input.data.skills.styles['S'+i];
    s.skills[0].sp=2+i%4;s.skills[0].hitCount=1+i%3;
    s.skills[0].parts[0].power=[750+((i*7)%13)*200,750+((i*7)%13)*200];
    s.skills[1].sp=2+i%3;s.skills[1].parts[0].power=[0.2+(i%5)*0.15,0];
  }
  const enemy=input.target.phases[0].enemies[0];enemy.hp=enemy.maxHp=18000;
  const pattern={entries:[{order:1,skills:[900]}]};enemy.pattern={dp:pattern,hp:pattern};
  enemy.skills=[{id:900,label:'SyntheticDanger',name:'Synthetic enemy attack',parts:[{skillType:'AttackSkill',targetType:'Single',power:[2500,2500],parameters:{con:1},diffForMax:0}]}];
  input.target.phases.push(structuredClone(input.target.phases[0]));input.target.cards=[null,'critRate100'];
  return input;
}

test('100% rate filters all rerated routes before top-N and distinguishes on-plan from extended clears',async()=>{
  const input=successThresholdFixture(),unfiltered=await optimize(structuredClone(input));
  assert.deepEqual(unfiltered.errors,[]);assert.equal(unfiltered.minSuccess,0);assert.equal(unfiltered.minSuccessBasis,'onPlan');
  assert.equal(unfiltered.rejectedBySuccess,0);assert.equal(unfiltered.resultCandidates,unfiltered.top.length);
  assert.ok(unfiltered.top[0].mc.success<1,'fixture exposes a high-score route below the success threshold');
  const clears=unfiltered.top.filter(t=>t.mc.success===1),onPlan=unfiltered.top.filter(t=>t.mc.onPlan===1);
  assert.ok(clears.length>onPlan.length&&onPlan.length>=3,'fixture includes 100% clears that sometimes need continuation');
  const prior=unfiltered.top[0];input.incumbents=[{members:prior.members,design:prior.design,ruleIds:prior.ruleIds}];
  input.opts={...input.opts,top:3,minSuccess:1,minSuccessBasis:'success'};
  const filtered=await optimize(structuredClone(input));
  assert.equal(filtered.incumbents,1,'a low-rate incumbent is reevaluated before filtering');
  assert.equal(filtered.minSuccessBasis,'success');assert.equal(filtered.minSuccess,1);
  assert.equal(filtered.qualifiedCandidates,clears.length);assert.equal(filtered.rejectedBySuccess,unfiltered.top.length-clears.length);
  assert.deepEqual(signature(filtered),signature({top:clears.slice(0,3)}),'low-rate high scores cannot occupy top-N slots');
  input.opts={...input.opts,top:20,minSuccessBasis:'onPlan'};
  const strict=await optimize(input);
  assert.equal(strict.qualifiedCandidates,onPlan.length);assert.equal(strict.rejectedBySuccess,unfiltered.top.length-onPlan.length);
  assert.deepEqual(signature(strict),signature({top:onPlan}),'the threshold never changes conditional score statistics');
});

test('an unmet success threshold returns an empty result with searched and rejected counts',async()=>{
  const input=optimizerInput({count:6,opts:{minSuccess:0.01,mcRuns:4}});
  Object.assign(input.target.phases[0].enemies[0],{hp:1e9,maxHp:1e9});
  const result=await optimize(input);
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.top,[]);
  assert.equal(result.minSuccess,0.01);assert.equal(result.minSuccessBasis,'onPlan');assert.equal(result.qualifiedCandidates,0);
  assert.ok(result.resultCandidates>0);assert.equal(result.rejectedBySuccess,result.resultCandidates);
  assert.ok(result.screened>0);assert.ok(result.evaluated>0);assert.equal(result.iterations,0);
});
