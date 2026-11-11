import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {optimize,createTaskHandler} from '../public/sim/optimizer.mjs';
import {SEARCH_PRESETS,searchBudget,normalizeMinSuccess,normalizeSuccessBasis} from '../public/sim/optimizer-options.mjs';
import {membersFromDeck} from '../public/sim/hbr/deck.mjs';
import {membersFrom} from '../public/sim/party.mjs';
import {buildParty,initialState} from '../public/sim/hbr/battle.mjs';
import {repairDesign} from '../public/sim/axis-repair.mjs';
import {simulateDesign,monteCarlo} from '../public/sim/designer.mjs';

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

test('a saved B-mode action replays with a single equipped slot and the original skill name',async()=>{
  const {input,prior}=historyFixture(),root=input.data.skills.styles.S0.skills[0];
  const leaf=element=>({...root,parts:[{...root.parts[0],elements:[element]}]});
  root.parts=[{skillType:'SkillSwitch',branches:[leaf('Fire'),leaf('Ice')],switchModes:{a:[0],b:[1]}}];
  for(const members of [input.base,prior.members]){
    members[0].deckSkillIds=[root.id];members[0].raw.skillIds=[root.id];
  }
  prior.design.phases[0].turns[0].actions[0].s=root.label+'@b';
  const record=replayPrior(input,prior).r;
  assert.equal(record.design.phases[0].turns[0].actions[0].s,'Skill0@b');
  assert.deepEqual(record.loadout[0].skills,[root.name]);
  input.opts.fixedTeam=true;input.opts.keepLoadout=true;
  const fresh=await optimize(input);
  assert.ok(fresh.top.length);assert.deepEqual(fresh.top[0].loadout[0].skills,[root.name]);
});

function transferredSkillFixture(){
  const input=optimizerInput({count:6,opts:{fixedTeam:true,maxTurns:1,beam:2,screenBeam:1,mcRuns:8,top:5,minSuccess:1}});
  const attack=structuredClone(input.data.skills.styles.S0.skills[0]);
  Object.assign(attack,{id:9001,label:'TransferredEX',restricted:true});
  attack.parts[0].power=[200000,200000];
  input.data.skills.styles.S0B={skills:[attack],passives:[]};
  input.data.catalog.characters[0].styleIds.push('S0B');
  input.data.catalog.styles.push({...input.data.catalog.styles[0],id:'S0B'});
  input.archive.styles.S0B={owned:true};
  Object.assign(input.target.phases[0].enemies[0],{hp:100000,maxHp:100000});
  input.base.forEach((m,i)=>{m.raw.skillIds=[100+i];m.deckSkillIds=[100+i];});
  input.base[0].raw.skillIds=[9001,100];input.base[0].deckSkillIds=[9001];
  return input;
}

test('the original fixed loadout keeps its transferred EX, empty skill slots, support and manual panel through final replay',async()=>{
  const input=transferredSkillFixture();
  Object.assign(input.opts,{keepLoadout:true,searchEvals:3,searchBatch:3});
  Object.assign(input.base[0].raw,{supportStyleId:'S3',supportLimitBreak:0,support:structuredClone(input.cache.cards[3])});
  input.base[0].stats.str=888;input.base[0].statsManual=['str'];
  input.base[1].deckSkillIds=[];input.base[1].strictDeckSkills=true;
  const original=structuredClone(input.base),result=await optimize(input);
  assert.deepEqual(result.errors,[]);assert.equal(result.iterations,3);
  assert.ok(result.top.length);assert.deepEqual(input.base,original);
  for(const route of result.top){
    assert.equal(route.mc.onPlan,1);
    assert.ok(route.design.phases[0].turns[0].actions.some(a=>a.u===0&&a.s==='TransferredEX'));
    assert.deepEqual(route.members.map(m=>m.deckSkillIds),input.base.map(m=>m.deckSkillIds));
    assert.deepEqual(route.members[0].raw.support,input.base[0].raw.support);
    assert.equal(route.members[0].stats.str,888);
  }
  const prior=structuredClone(result.top[0]);prior.members[1].deckSkillIds=[101];
  assert.equal(replayPrior(input,prior).r,null);
});

test('flexible skill search includes equipped transferable EX and master skills exactly once',async()=>{
  const input=transferredSkillFixture(),master=structuredClone(input.data.skills.styles.S0B.skills[0]);
  Object.assign(master,{id:46500001,label:'MasterSkill'});
  input.data.stats.extraSkills[master.id]=master;
  input.base[1].raw.skillIds=[master.id];
  const candidate={label:'Flexible',raws:input.base.map(m=>m.raw),front:input.base.map(m=>m.front)};
  const {r,errors}=createTaskHandler(input)({type:'eval',cand:candidate});
  assert.deepEqual(errors,[]);assert.equal(r.cleared,1);
  assert.ok(r.slots[0].ids.includes(9001));assert.ok(r.slots[1].ids.includes(master.id));
  for(const {ids,cap} of r.slots){assert.equal(new Set(ids).size,ids.length);assert.ok(ids.length<=cap);}
});

test('fixed loadout replays the equipped passive and support resonance and rebuilds historical manual stats from the current team',async()=>{
  const input=transferredSkillFixture();
  input.data.catalog.styles.find(s=>s.id===input.base[0].styleId).tier='SSR';
  input.opts.keepLoadout=true;
  const effect=(label,rate)=>({label,name:label,timing:'OnBattleStart',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[rate,0]}]});
  const offStyle={id:9002,label:'TransferPassive',name:'Transfer passive',restricted:true,passive:effect('FromSkill',0.2)};
  input.data.skills.styles.S0B.skills.push(offStyle);
  input.base[0].raw.skillIds.push(offStyle.id);input.base[0].deckSkillIds.push(offStyle.id);
  const support=input.cache.cards[3];
  Object.assign(input.base[0].raw,{support:structuredClone(support),supportStyleId:support.styleId,supportLimitBreak:3});
  input.data.stats.styles.S3.resonance='SupportGroup';
  input.data.stats.supportSkills={SupportGroup:[{lb:0,passive:effect('BaseResonance',0.1)},{lb:3,passive:effect('FullResonance',0.3)}]};
  Object.assign(input.base[0],{statsManual:['dex'],stats:{...input.base[0].stats,dex:777}});
  const result=await optimize(input);assert.deepEqual(result.errors,[]);assert.ok(result.top.length);
  const {members}=membersFrom({members:result.top[0].members},input.archive,input.data.catalog);
  const party=buildParty(members,input.data);
  assert.equal(initialState(party,input.target.phases[0].enemies[0]).od,50);
  const prior=structuredClone(result.top[0]);prior.members[0].stats.dex=9999;prior.members[0].supportStyleId='S2';
  const rated=replayPrior(input,prior).r;assert.ok(rated);
  assert.equal(rated.members[0].stats.dex,777);assert.equal(rated.members[0].supportStyleId,'S3');
  prior.members[0].raw.supportStyleId='S2';
  assert.equal(replayPrior(input,prior).r,null);
  delete input.base[0].raw;
  await assert.rejects(optimize(input),/请先导入/);
});

test('encounter finalists keep a one-use attack for the second phase and replay both rule multipliers',async()=>{
  const input=transferredSkillFixture();Object.assign(input.opts,{keepLoadout:true,searchRules:true,finalists:1,top:1});
  input.data.skills.styles.S0B.skills[0].uses=1;
  const hard=structuredClone(input.target.phases[0]);
  Object.assign(input.target.phases[0].enemies[0],{hp:100,maxHp:100});
  input.target.phases.push(hard);input.target.cards=[null,null];
  const rule={id:'grade',name:'Grade bonus',grade:20};
  input.target.ruleOptions=[{ids:[],rules:[],phases:input.target.phases},{ids:[rule.id],rules:[rule],phases:input.target.phases}];
  const handler=createTaskHandler(input),finals=[];
  const run=await optimize(input,()=>{},{size:1,run:async task=>{
    const message=handler(task);
    if(task.type==='final'){assert.ok(task.f.reserve);finals.push(message.r);}
    return message;
  }});
  assert.deepEqual(run.errors,[]);assert.equal(finals.length,2);assert.ok(run.top.length);
  const rated=finals.map(r=>[r,...r.alternatives].find(v=>v.mc.onPlan===1));
  assert.ok(rated.every(Boolean));
  const bonus=rated.find(v=>v.ruleIds.includes(rule.id)),plain=rated.find(v=>!v.ruleIds.length);
  assert.ok(bonus.mc.scoreMean>plain.mc.scoreMean);
  const [opening,boss]=run.top[0].design.phases.map(p=>p.turns.flatMap(t=>t.actions));
  assert.ok(opening.every(a=>a.s!=='TransferredEX'));
  assert.ok(boss.some(a=>a.s==='TransferredEX'));
  assert.deepEqual(run.top[0].ruleIds,[rule.id]);
});

test('axis repair writes a legal static route for a failed OD and an unaffordable skill',async()=>{
  const {input}=historyFixture(),expensive=input.data.skills.styles.S0.skills[1];
  expensive.sp=60;
  const party=buildParty(membersFrom({members:input.base},input.archive,input.data.catalog).members,input.data);
  const phase=input.target.phases[0],ctx={party,phases:[phase,structuredClone(phase)]};
  const design={phases:[
    {turns:[{front:[0,1,2],actions:[{u:2,s:'Skill2'}]}]},
    {turns:[{front:[0,1,2],odStart:{level:3,rounds:[]},actions:[{u:0,s:expensive.label},{u:1,s:'Skill1'}]}]},
  ]},original=structuredClone(design);
  assert.equal(monteCarlo(ctx,{},design,{n:40,seed:7}).success,0);
  const plans=repairDesign(ctx,design,{maxTurns:1});
  assert.deepEqual(design,original);assert.ok(plans.length);
  const winner=plans.find(d=>monteCarlo(ctx,{},d,{n:64,seed:851}).onPlan===1);
  assert.ok(winner);
  assert.equal(winner.phases[1].turns[0].odStart,null);
  assert.notEqual(winner.phases[1].turns[0].actions[0].s,expensive.label);
  input.opts.fixedTeam=true;input.opts.minSuccess=1;
  input.target.phases=ctx.phases;input.target.cards=[null,null];
  input.incumbents=[{label:'Saved route',members:input.base,ruleIds:[],design}];
  const worker=createTaskHandler(input);let revisited;
  const run=await optimize(input,()=>{},{size:1,run:async task=>{
    const message=worker(task);
    if(task.type==='incumbent')revisited=message.r;
    return message;
  }});
  assert.deepEqual(run.errors,[]);assert.equal(run.incumbents,1);
  assert.ok(revisited?.label.includes('修正排轴'));assert.equal(revisited.mc.onPlan,1);
});

test('an expected-path resource error does not discard genuinely legal fixed-team random clears',()=>{
  const {input}=historyFixture();Object.assign(input.opts,{fixedTeam:true,mcRuns:96});
  const fatal=input.data.skills.styles.S1.skills[1];fatal.sp=60;
  const prior={members:structuredClone(input.base),design:{phases:[{turns:[{front:[0,1,2],actions:[{u:0,s:'Skill0'},{u:1,s:fatal.label}]}]}]},ruleIds:[]};
  prior.members[0].deckSkillIds=[100];prior.members[1].deckSkillIds=[fatal.id];
  const party=buildParty(membersFrom({members:prior.members},input.archive,input.data.catalog).members,input.data);
  const enemy=input.target.phases[0].enemies[0];enemy.hp=enemy.maxHp=1e8;
  const ctx={party,phases:input.target.phases};
  const hit=simulateDesign(ctx,{critMode:'expected'},prior.design).phases[0].shown;
  enemy.hp=enemy.maxHp=hit+2;
  assert.ok(simulateDesign(ctx,{critMode:'expected'},prior.design).issues.some(i=>i.level==='error'));
  const r=replayPrior(input,prior).r;assert.ok(r);assert.equal(r.score,null);
  assert.ok(r.mc.successes>0&&r.mc.successes<r.mc.n);
  assert.equal(r.mc.successes,r.mc.scoreSamples);
});

test('fixed-team equipment variants use owned instances, respect personal jewels and retain the original candidate',async()=>{
  const {input}=historyFixture();
  Object.assign(input.opts,{fixedTeam:true,searchEvals:6,top:1,finalists:1});
  const jewel={sourceId:501,slot:'orb',name:'Personal jewel',characterId:'C1',effects:[{type:'Dp',valueType:'RealNumber',value:[1000,0]}],rollGroups:[]};
  const ring={sourceId:502,slot:'ring',name:'Shared ring',effects:[],rollGroups:[]};
  const soul={sourceId:503,slot:'soul',name:'Personal soul',styleId:'S0',effects:[],rollGroups:[]};
  input.data.equipment.entries.push(jewel,ring,soul);
  const orb={masterId:501,instanceId:'orb',main:[],expansion:[],plus:0};
  const first={masterId:502,instanceId:'ring-a',main:[],expansion:[],plus:0},second={...first,instanceId:'ring-b'};
  const book={masterId:503,instanceId:'soul',main:[],expansion:[],plus:0};
  input.cache.accessories=[orb,first,second,book];
  input.base[0].raw.accessories.soul=book;
  input.base[0].raw.accessories.ring=first;
  input.base[0].deckSkillIds=[100];
  const handler=createTaskHandler(input),finals=[],seeds=[];
  const runner={size:1,run:async task=>{
    if(task.type==='final')finals.push(task.f);
    if(task.type==='eval')seeds.push(task.cand);
    return handler(task);
  }};
  const res=await optimize(input,()=>{},runner);
  assert.deepEqual(res.errors,[]);assert.ok(res.iterations>0);
  assert.ok(finals.some(f=>f.reserve&&f.raws[0]._skills.length===1));
  assert.ok(seeds.some(c=>c.raws[1].accessories.jewel?.instanceId==='orb'));
  for(const c of seeds){
    assert.deepEqual(c.raws.map(m=>m.styleId),input.base.map(m=>m.styleId));
    assert.ok(c.raws.every((r,i)=>i===1||!r.accessories.jewel));
    const ids=c.raws.flatMap(m=>Object.values(m.accessories).map(a=>a.instanceId));
    assert.equal(new Set(ids).size,ids.length);
  }
  const prior={members:structuredClone(input.base),ruleIds:[],design:{phases:[{turns:[{actions:[{u:0,s:'Skill0'}]}]}]}};
  prior.members[1].raw.accessories.ring=first;
  assert.equal(replayPrior(input,prior).r,null);
  prior.members[1].raw.accessories.ring=second;
  assert.ok(replayPrior(input,prior).r);
  delete prior.members[0].raw.accessories.soul;
  prior.members[1].raw.accessories.soul=book;
  assert.equal(replayPrior(input,prior).r,null);
  delete prior.members[1].raw.accessories.soul;
  prior.members[0].raw.accessories.jewel=orb;
  assert.equal(replayPrior(input,prior).r,null);
  input.cache.accessories=[book,first];
  const moved=[];
  const transfer=createTaskHandler(input);
  await optimize(input,()=>{},{size:1,run:async task=>{
    if(task.type==='eval')moved.push(task.cand.raws);
    return transfer(task);
  }});
  assert.ok(moved.some(raws=>!raws[0].accessories.ring&&raws.slice(1).some(r=>r.accessories.ring?.instanceId===first.instanceId)));
});

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
  const enemy=input.target.phases[0].enemies[0];enemy.hp=enemy.maxHp=30000;
  const pattern={entries:[{order:1,skills:[900]}]};enemy.pattern={dp:pattern,hp:pattern};
  enemy.skills=[{id:900,label:'SyntheticDanger',name:'Synthetic enemy attack',parts:[{skillType:'AttackSkill',targetType:'Single',power:[2100,2100],parameters:{con:1},diffForMax:0}]}];
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
