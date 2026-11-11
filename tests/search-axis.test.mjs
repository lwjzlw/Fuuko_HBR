import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {act,buildParty,collectMods,initialState,previewAttack,setPhase,startTurn,usableSkills} from '../public/sim/hbr/battle.mjs';
import {applyCard} from '../public/sim/cards.mjs';
import {designFromPlan,monteCarlo,simulateDesign} from '../public/sim/designer.mjs';
import {carryoverValue,progress,replay,search,selectableAllyTargets} from '../public/sim/search.mjs';
import {optimizerInput} from './fixtures/optimizer-input.mjs';

const oneTurn={maxTurns:1,beam:4,critMode:'none',objective:'minTurns',damageNorm:1e6,allowOd:false,top:1};
const skillData=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url),'utf8'));

test('action-cost passives validate the actual skill and do not buff a later expensive attack',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  const passive=skillData.styles.BIYamawaki08.passives.find(p=>p.label==='Passive.ConsumeSpAttackUp03');
  const high=Object.values(skillData.styles).flatMap(x=>x.passives).find(p=>p?.label==='Passive.ConsumeSpAttackUp02');
  party[5].passives.push(passive);
  party[4].passives.push(high);
  const lowSkill=party[0].skills[0];
  lowSkill.sp=8;
  party[0].skills.push({...lowSkill,label:'expensive',sp:14});
  const expensive=party[0].skills.length-1,enemy=input.target.phases[0].enemies[0];
  const st=initialState(party,enemy,oneTurn);
  startTurn(st);
  assert.ok(!st.units.some(u=>u.effects.some(e=>e.src===passive.label)));
  assert.equal(previewAttack(st,0,0).mods.passiveAttackUp,100);
  assert.equal(previewAttack(st,0,expensive).mods.passiveAttackUp,0);
  const model={element:'ice',physicalType:'slash',hitCount:1};
  assert.equal(collectMods(st,0,model,{sp:15}).passiveAttackUp,high.parts[0].power[0]*100);
  assert.equal(collectMods(st,0,model,{sp:0,normal:true}).passiveAttackUp,0);
  assert.equal(collectMods(st,0,model,{followUp:true}).passiveAttackUp,0);
  st.units[0].sp=20;
  act(st,0,0);
  assert.equal(previewAttack(st,0,expensive).mods.passiveAttackUp,0);
});

test('Breaker EX cards use actual SP and independently grant at most five lasting party buffs across encounters',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  party[0].role='Breaker';
  const ex=party[0].skills[0];
  Object.assign(ex,{isEX:true,sp:15,overwrite:11});
  const enemy={...input.target.phases[0].enemies[0],hp:1e12,maxHp:1e12};
  const st=initialState(party,enemy,oneTurn);
  setPhase(st,[enemy]);startTurn(st);
  applyCard(st,'breakerAtk200');
  const cast=()=>{st.units[0].sp=20;return act(st,0,0);};
  const totals=()=>{
    const m=collectMods(st,5,{element:'ice',physicalType:'slash',hitCount:1},{});
    return [m.passiveAttackUp,m.passiveCritDamageUp];
  };
  cast();assert.deepEqual(totals(),[0,0]);
  ex.overwrite=12;
  for(let i=0;i<2;i++)cast();
  assert.deepEqual(totals(),[400,0]);
  applyCard(st,'breakerCrit100');
  cast();assert.deepEqual(totals(),[600,100]);
  st.enemy.hp=1;act(st,1,-1);
  assert.ok(st.killedTurn);
  setPhase(st,[enemy]);startTurn(st);
  assert.deepEqual(totals(),[600,100]);
  for(let i=0;i<6;i++){cast();act(st,5,0);}
  assert.deepEqual(totals(),[1000,500]);
  assert.deepEqual(st.units.map(u=>u.effects.filter(e=>e.src==='card:breakerAtk200').length),Array(6).fill(5));
});

test('Breaker normal attacks retain the OD card reward only on breaking a shield',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  const enemy={...input.target.phases[0].enemies[0],dp:[1],hp:1e8,maxHp:1e8,odRate:1};
  party[0].role='Breaker';
  for(const [actor,first] of [[0,37.5],[1,7.5]]){
    const st=initialState(party,enemy,oneTurn);startTurn(st);
    applyCard(st,'breakerOd30');
    act(st,actor,-1);assert.equal(st.od,first);
    act(st,actor,-1);assert.equal(st.od,first+7.5);
  }
});

test('a fixed party finds the same targeted support as a known one-turn clear',()=>{
  const input=optimizerInput({count:6});
  const styles=input.data.skills.styles;
  const ice=styles.S0.skills[0],fire=styles.S1.skills[0],support=styles.S2.skills[1];
  styles.S0.skills=[ice];
  styles.S1.skills=[fire];
  styles.S2.skills=[support];
  for(let i=3;i<6;i++)styles['S'+i].skills=[];
  ice.parts[0].power=[12000,12000];
  fire.parts[0].power=[8000,8000];
  Object.assign(support.parts[0],{power:[1,0],targetType:'AllySingleWithoutSelf'});
  const party=buildParty(input.base,input.data);
  const enemy=input.target.phases[0].enemies[0];
  enemy.weaknesses.element.ice=0;
  enemy.hp=enemy.maxHp=14000;
  const ctx={party,enemy,statusTypes:{}};
  const manual={phases:[{turns:[{front:[0,1,2],actions:[{u:2,s:support.label,target:1},{u:1,s:fire.label},{u:0,s:ice.label}]}]}]};
  const mcContext={party,phases:[{enemies:[enemy]}],statusTypes:{}};
  const check=design=>monteCarlo(mcContext,{extendTurns:0},design,{n:100,seed:97});
  assert.equal(check(manual).onPlan,1);

  const best=search(ctx,oneTurn).plans[0];
  assert.equal(best?.killedTurn,1);
  assert.ok(best.plan.some(p=>p.k==='act'&&p.u===2&&p.target===1));
  assert.equal(replay(ctx,oneTurn,best.plan).killedTurn,1);
  assert.equal(check(designFromPlan(best.plan,party)).onPlan,1);
});

test('advancing to the second enemy retains the progress that made a one-turn clear possible',()=>{
  const input=optimizerInput({count:6});
  const powers=[6800,4100,4100,800,800,800];
  for(const [i,power] of powers.entries()){
    const style=input.data.skills.styles['S'+i];
    style.skills=style.skills.slice(0,1);
    Object.assign(style.skills[0].parts[0],{power:[power,power],elements:[]});
  }
  const party=buildParty(input.base,input.data);
  const enemy=input.target.phases[0].enemies[0];
  const phaseEnemies=[{...enemy,label:'first',hp:6000,maxHp:6000},{...enemy,label:'second',hp:8000,maxHp:8000}];
  const ctx={party,enemy:phaseEnemies[0],phaseEnemies,statusTypes:{}};
  const state=initialState(party,ctx.enemy,oneTurn);
  setPhase(state,phaseEnemies);
  assert.equal(progress(state),0);
  startTurn(state);
  act(state,0,0);
  assert.equal(state.qi,1);
  assert.equal(progress(state),6000/14000);
  const best=search(ctx,oneTurn).plans[0];
  assert.equal(best?.killedTurn,1);
  assert.equal(progress(replay(ctx,oneTurn,best.plan)),1);
});

test('only single-ally skills offer selectable living slots, including back-row members',()=>{
  const members=Array.from({length:6},(_,i)=>({i,front:i<3,down:i===4}));
  const skill=targetType=>({parts:[{targetType}]});
  assert.deepEqual(selectableAllyTargets(skill('AllySingle'),1,members),[0,1,2,3,5]);
  const conditional={parts:[{skillType:'SkillCondition',branches:[skill('AllySingleWithoutSelf')]}]};
  assert.deepEqual(selectableAllyTargets(conditional,1,members),[0,2,3,5]);
  for(const t of ['AllyFront','AllyAll','AllyAllWithoutSelf','AllySub','Self','Single','All']){
    assert.deepEqual(selectableAllyTargets(skill(t),1,members),[]);
  }
});

test('when an expected kill misses, unspent front-row slots can finish it at zero SP',()=>{
  const input=optimizerInput({count:6}),styles=input.data.skills.styles;
  styles.S0.skills=styles.S0.skills.slice(0,1);
  styles.S0.skills[0].parts[0].power=[8000,8000];
  for(let i=1;i<6;i++)styles['S'+i].skills=[];
  const party=buildParty(input.base,input.data),enemy=input.target.phases[0].enemies[0];
  enemy.hp=enemy.maxHp=8500;
  const ctx={party,enemy,phases:[{enemies:[enemy]}],statusTypes:{}};
  const opts={...oneTurn,critMode:'expected'};
  const best=search(ctx,opts).plans[0],design=designFromPlan(best.plan,party);
  const actions=design.phases[0].turns[0].actions;
  assert.equal(actions.length,3);
  assert.deepEqual(actions.filter(a=>a.backup),[{u:1,s:'normal',backup:true},{u:2,s:'normal',backup:true}]);
  const expected=simulateDesign(ctx,opts,design);
  assert.equal(expected.rows.filter(r=>r.kind==='act').length,1);
  const samples=monteCarlo(ctx,{extendTurns:0},design,{n:100,seed:97});
  assert.equal(samples.onPlan,1);

  const manual=structuredClone(design);
  manual.phases[0].turns[0].actions=actions.filter(a=>!a.backup);
  assert.equal(monteCarlo(ctx,{extendTurns:0},manual,{n:100,seed:97}).successes,24);
});

test('generated backups respect the OD front, extra-action recipients and end of an unfinished turn',()=>{
  const party=Array.from({length:6},()=>({skills:[]}));
  party[4]={noNormal:true,skills:[]};
  const turn={k:'turn'},front={k:'front',units:[0,1,2]},act={k:'act',u:1,s:-1};
  const unfinished=designFromPlan([turn,front,act,{k:'end'}],party).phases[0].turns[0];
  assert.equal(unfinished.actions.length,1);
  const od=[{k:'od',level:1,window:'turnEnd'},{k:'front',units:[3,4,5]},{k:'act',u:3,s:-1}];
  const odClear=designFromPlan([turn,front,act,...od,{k:'odEnd'}],party).phases[0].turns[0];
  assert.equal(odClear.actions.length,1);
  assert.deepEqual(odClear.odEnd.rounds[0].actions.map(a=>a.u),[3,5]);
  const extra=[{k:'extraStart',who:[0,5]},{k:'extra',u:5,s:-1},{k:'extraEnd',who:[0,5]}];
  const extraClear=designFromPlan([turn,front,act,...od,...extra,{k:'odEnd'}],party).phases[0].turns[0];
  assert.equal(extraClear.odEnd.rounds[0].actions.length,1);
  assert.deepEqual(extraClear.odEnd.rounds[0].extra,[{u:5,s:'normal'},{u:0,s:'normal',backup:true}]);
});

test('encounter openers use the previous front at each new battle, preserving spent SP and skill uses',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  const opener=(label,timing,amount)=>({label,timing,condition:'IsFront()',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[amount,0]}]});
  party[0].passives.push(opener('first','OnFirstBattleStart',0.10),opener('each','OnBattleStart',0.20));
  party[3].passives.push(opener('swap-in','OnBattleStart',0.30));
  party[0].skills[0].uses=1;
  const enemy=input.target.phases[0].enemies[0],first={...enemy,hp:1,maxHp:1};
  const context={party,enemy:first,phaseEnemies:[first],statusTypes:{}};
  const plan=[{k:'turn'},{k:'front',units:[0,3,4]},{k:'act',u:0,s:0}];
  const start=initialState(party,first,oneTurn);
  setPhase(start,[first]);
  assert.equal(start.od,30);
  const clear=replay(context,{...oneTurn,rootState:start},plan);
  assert.equal(clear.killedTurn,1);
  const second=replay({...context,enemy,phaseEnemies:[enemy]},{...oneTurn,rootState:clear},[]);
  assert.equal(second.od,clear.od+50);
  assert.equal(second.units[0].sp,clear.units[0].sp);
  assert.deepEqual(second.units[0].uses,clear.units[0].uses);
  assert.ok(!usableSkills(second,0).includes(0));
  const result=simulateDesign({party,phases:[{enemies:[first]},{enemies:[enemy]}]},oneTurn,
    {phases:[designFromPlan(plan,party).phases[0],{turns:[]}]});
  assert.equal(result.final.od,second.od);
  assert.deepEqual(result.final.sp,second.units.map(u=>u.sp));
});

test('the fixed-party search may open a discounted OD before the nominal gauge threshold',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  party[0].passives.push({label:'start-85',timing:'OnBattleStart',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[0.85,0]}]},
    {label:'od-discount',timing:'OnBattleStart',parts:[{skillType:'ReduceConsumeOverDrive',power:[0.15,0]}]});
  const enemy=input.target.phases[0].enemies[0];
  enemy.hp=enemy.maxHp=7000;
  const ctx={party,enemy,statusTypes:{}};
  const best=search(ctx,{...oneTurn,allowOd:true,odWindows:['turnStart']}).plans[0];
  assert.equal(best?.killedTurn,1);
  assert.ok(best.plan.some(p=>p.k==='od'&&p.level===1&&p.window==='turnStart'));
  assert.equal(replay(ctx,oneTurn,best.plan).killedTurn,1);
});

test('a phase that ends in the first round of OD2 gives the next phase no unplanned actions or SP',()=>{
  const input=optimizerInput({count:6}),styles=input.data.skills.styles;
  styles.S0.skills=styles.S0.skills.slice(0,1);
  styles.S0.skills[0].parts[0].power=[7000,7000];
  for(let i=1;i<6;i++)styles['S'+i].skills=[];
  const party=buildParty(input.base,input.data),enemy=input.target.phases[0].enemies[0];
  party[0].passives.push({label:'od2',timing:'OnFirstBattleStart',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[2,0]}]});
  const first={...enemy,hp:100,maxHp:100},second={...enemy,hp:14000,maxHp:14000};
  const ctx=enemy=>({party,enemy,phaseEnemies:[enemy],statusTypes:{}});
  const firstPlan=[{k:'turn'},{k:'od',level:2,window:'turnStart'},{k:'front',units:[0,1,2]},{k:'act',u:0,s:0},{k:'odEnd'}];
  const cleared=replay(ctx(first),oneTurn,firstPlan);
  assert.equal(cleared.odRounds,1);
  const opts={...oneTurn,rootState:cleared};
  const next=replay(ctx(second),opts,[]);
  assert.equal(next.odRounds,0);
  assert.equal(next.od,cleared.od);
  assert.deepEqual(next.units.map(u=>u.sp),cleared.units.map(u=>u.sp));
  const attempt=search(ctx(second),opts);
  assert.equal(attempt.plans.length,0);
  assert.ok(!attempt.unfinished.plan.some(p=>p.k==='odEnd'));
  const design={phases:[designFromPlan(firstPlan,party).phases[0],designFromPlan(attempt.unfinished.plan,party).phases[0]]};
  const sim=simulateDesign({party,phases:[{enemies:[first]},{enemies:[second]}]},oneTurn,design);
  assert.equal(sim.phases[1].damage,Math.round(attempt.unfinished.totalDamage-cleared.totalDamage));
  assert.ok(!sim.issues.some(issue=>issue.level==='error'));
});

test('a fixed party can keep a scarce skill for the next phase alongside the high-overkill clear',()=>{
  const input=optimizerInput({count:6}),powers=[100000,5000,4000,800,800,800];
  for(const [i,power] of powers.entries()){
    const style=input.data.skills.styles['S'+i],skill=style.skills[0];
    style.skills=[skill];skill.parts[0].power=[power,power];skill.sp=0;
    if(i===0)skill.uses=1;
  }
  const party=buildParty(input.base,input.data),enemy=input.target.phases[0].enemies[0];
  enemy.hp=enemy.maxHp=7000;
  const ctx={party,enemy,statusTypes:{}},opts={...oneTurn,beam:1,overkill:true};
  const standard=search(ctx,opts);
  assert.equal(standard.plans.length,1);
  const result=search(ctx,{...opts,reserveResources:true});
  assert.equal(result.plans.length,2);
  const [high,budget]=result.plans;
  assert.ok(high.value>=standard.plans[0].value&&high.value>budget.value);
  const remaining=replay(ctx,opts,budget.plan),used=replay(ctx,opts,high.plan);
  assert.ok(usableSkills(remaining,0).includes(0));
  assert.ok(!usableSkills(used,0).includes(0));
  assert.ok(carryoverValue(remaining)>carryoverValue(used));
});

test('field enhancement from encounter rule A and its tactical card applies only to an active cast',()=>{
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  const zone={skillType:'Zone',targetType:'Field',elements:['Ice'],power:[1.35,0],exit:{cond:'PlayerTurnEnd',value:[2,0]}};
  party[1].passives.push({label:'opener',timing:'OnBattleStart',parts:[zone]});
  party[1].skills.push({label:'active',sp:0,consume:'Sp',parts:[zone]});
  const rule={type:'SkillPart',target:'Member',timing:['OnFirstBattleStart'],parts:[{skillType:'ZoneUpEternal',power:[1,0]}]};
  const enemy=input.target.phases[0].enemies[0];
  const strength=s=>collectMods(s,0,{element:'ice',physicalType:'slash',hitCount:1}).field;
  const cast=s=>act(s,1,party[1].skills.length-1);
  for(const rules of [[],[rule]]){
    const state=initialState(party,{...enemy,rules},oneTurn);
    assert.equal(strength(state),35);
    assert.equal(state.field.turns,2);
    startTurn(state);
    cast(state);
    assert.equal(strength(state),rules.length?70:35);
    assert.equal(state.field.turns,rules.length?null:2);
  }
  const st=initialState(party,{...enemy,rules:[rule]},oneTurn);
  applyCard(st,'zoneEternal300');
  applyCard(st,'fieldOd30');
  assert.equal(strength(st),35);
  assert.equal(st.field.turns,2);
  setPhase(st,[enemy]);startTurn(st);
  cast(st);
  assert.equal(strength(st),175);
  assert.equal(st.field.turns,null);
  assert.equal(st.od,30);
});

test('the search can assign six distinct servants from zero and activate Super Big Bang',()=>{
  const input=optimizerInput({count:6}),styles=input.data.skills.styles;
  const skill=(id,label)=>skillData.styles[id].skills.find(s=>s.label===label);
  styles.S0.skills=[skill('BIYamawaki09','BIYamawakiSkill09'),skill('BIYamawaki08','BIYamawakiSkill08'),skill('BIYamawaki08','BIYamawakiSkill55')];
  for(let i=1;i<6;i++)styles['S'+i].skills=[];
  input.base[0].initialSp=18;
  const party=buildParty(input.base,input.data),enemy=input.target.phases[0].enemies[0];
  enemy.hp=enemy.maxHp=28000;
  const ctx={party,enemy,statusTypes:skillData.statusTypes},opts={...oneTurn,maxTurns:8,beam:2};
  assert.ok(!usableSkills(initialState(party,enemy,{...opts,statusTypes:ctx.statusTypes}),0).includes(2));
  const best=search(ctx,opts).plans[0];
  assert.ok(best?.killedTurn);
  const recipients=best.plan.filter(p=>p.target!=null).map(p=>p.target);
  assert.deepEqual(recipients.slice().sort(),[0,1,2,3,4,5]);
  const clear=replay(ctx,opts,best.plan);
  assert.equal(clear.units[0].uses.BIYamawakiSkill55,1);
  assert.equal(simulateDesign(ctx,opts,designFromPlan(best.plan,party)).phases[0].cleared,true);
});

function commandFixture(hp){
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  party[5].passives.push(skillData.styles.BIYamawaki08.passives.find(p=>p.label==='Passive.Machina_Demon'));
  const enemy=input.target.phases[0].enemies[0];
  enemy.hp=enemy.maxHp=hp;
  return {party,enemy,statusTypes:skillData.statusTypes};
}
const command={u:5,s:'BIYamawakiSkill55b'};

test('a searched plan can press three independent commands before anyone acts and replay it',()=>{
  const ctx=commandFixture(990000),opts={...oneTurn,critMode:'expected',beam:2};
  const best=search(ctx,opts).plans[0];
  assert.equal(best?.killedTurn,1);
  assert.equal(best.plan.filter(p=>p.k==='command').length,3);
  const state=replay(ctx,opts,best.plan);
  assert.equal(state.units[5].commandRemaining,0);
  assert.equal(state.killedTurn,1);
  const design=designFromPlan(best.plan,ctx.party),turn=design.phases[0].turns[0];
  assert.deepEqual(turn.commands,[command,command,command]);
  assert.equal(turn.actions.length,3);
  const sim=simulateDesign(ctx,opts,design);
  assert.deepEqual(sim.issues,[]);
  assert.deepEqual(sim.rows.filter(r=>r.kind==='command').map(r=>r.remaining),[2,1,0]);
  assert.equal(sim.rows.filter(r=>r.kind==='act').length,0);
});

test('commands can precede normal, OD or extra actions, and a fourth press across phases is illegal',()=>{
  const ctx=commandFixture(1e8),front={k:'front',units:[0,1,2]};
  ctx.party[0].passives.push({label:'OD1',timing:'OnFirstBattleStart',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[1,0]}]});
  ctx.party[0].skills.push({label:'extra',sp:0,uses:-1,parts:[{skillType:'AdditionalTurn',targetType:'Self',power:[1,0]}]});
  const press={k:'command',...command};
  const plan=[{k:'turn'},{k:'od',level:1,window:'turnStart'},front,press,{k:'act',u:0,s:ctx.party[0].skills.length-1},
    {k:'extraStart',who:[0]},press,{k:'extra',u:0,s:-1},{k:'extraEnd',who:[0]},{k:'odEnd'},front,press,{k:'act',u:0,s:-1},{k:'end'}];
  const sim=simulateDesign(ctx,oneTurn,designFromPlan(plan,ctx.party));
  const rows=sim.rows.filter(r=>r.kind==='command');
  assert.deepEqual(rows.map(r=>r.round),['od1','extra','main']);
  assert.deepEqual(rows.map(r=>r.remaining),[2,1,0]);
  for(const r of rows)assert.ok(sim.rows.indexOf(r)<sim.rows.findIndex(a=>a.kind==='act'&&a.roundId===r.roundId));
  assert.ok(!sim.issues.some(i=>i.level==='error'));

  const easy={...ctx.enemy,hp:1,maxHp:1};
  const stages=Array.from({length:4},()=>({enemies:[easy]}));
  const phases=stages.map(()=>({turns:[{front:[0,1,2],commands:[command],actions:[{u:0,s:'normal'}]}]}));
  const repeated=simulateDesign({...ctx,phases:stages},oneTurn,{phases});
  assert.deepEqual(repeated.rows.filter(r=>r.kind==='command').map(r=>r.remaining),[2,1,0]);
  assert.equal(repeated.issues.filter(i=>i.level==='error').length,1);
  assert.match(repeated.issues.find(i=>i.level==='error').msg,/指令不可用或次数已用完/);
});

test('commands may fill the gauge before a turn-start OD and are not replayed a second time inside it',()=>{
  const ctx=commandFixture(1120000);
  ctx.party[0].passives.push({label:'start85',timing:'OnFirstBattleStart',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[0.85,0]}]});
  const opts={...oneTurn,critMode:'expected',beam:4,allowOd:true,odWindows:['turnStart']};
  const best=search(ctx,opts).plans[0];
  assert.equal(best?.killedTurn,1);
  const design=designFromPlan(best.plan,ctx.party);
  assert.ok(design.phases[0].turns[0].odStart.commandsBefore.length);
  const sim=simulateDesign(ctx,opts,design);
  assert.equal(sim.phases[0].cleared,true);
  assert.deepEqual(sim.issues,[]);
  const od=sim.rows.findIndex(r=>r.kind==='od');
  assert.ok(od>sim.rows.findIndex(r=>r.kind==='command'&&r.beforeOd));
  assert.deepEqual(sim.rows.filter(r=>r.kind==='command').map(r=>r.remaining),[2,1,0]);

  const early=simulateDesign({...ctx,enemy:{...ctx.enemy,hp:1,maxHp:1}},opts,design);
  assert.equal(early.phases[0].cleared,true);
  assert.ok(!early.rows.some(r=>r.kind==='od'));
  assert.equal(early.rows.filter(r=>r.kind==='command').length,1);
});
