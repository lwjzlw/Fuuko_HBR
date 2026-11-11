import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
    enemy.skills=[{id:1,name:'Synthetic double hit',hitCount:2,hitRatios:[0.5,0.5],
      parts:[{skillType:'AttackFixedDamageDefinitely',targetType:'Single',power:[100,100]}]}];
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

// No start-SP equipment: each member chooses the first normal round at 3 SP.
function resourceFixture(cost,consume='Sp'){
  const {ctx}=fixture();
  for(const u of ctx.party)u.initialSp=0;
  const support=(label,parts)=>({...ctx.party[0].skills[0],label,name:label,sp:0,parts});
  ctx.party[0].skills.push(
    support('FeedSP',[{skillType:'HealSp',targetType:'AllySingleWithoutSelf',power:[4,4]}]),
    support('GiveExtra',[{skillType:'AdditionalTurn',targetType:'AllyFront'}]),
    support('ChargeOD',[{skillType:'OverDrivePointUp',targetType:'Self',power:[2,2]}]));
  ctx.party[1].skills.push({...ctx.party[1].skills[0],label:'Finisher',name:'Finisher',sp:cost,consume});
  return ctx;
}
const feed={u:0,s:'FeedSP',target:1},finish={u:1,s:'Finisher'};
const makeDesign=(...turns)=>({phases:[{turns}]});
const plannedFinisher=(res,round)=>res.rows.find(r=>r.kind==='round'&&r.round===round).planned.find(p=>p.unit===1);

test('all three choices use opening SP; a teammate grant becomes available at the next menu',()=>{
  const ctx=resourceFixture(7),repairs=[];
  const result=simulateDesign(ctx,{onUnavailable:reason=>repairs.push(reason)},makeDesign({actions:[feed,finish]}));
  const choice=plannedFinisher(result,'main');
  assert.equal(choice.selectionSp,3);assert.equal(choice.selectionCost,7);assert.equal(choice.selectionCurrency,'SP');
  assert.match(choice.selectionError,/选招时不可用：SP不足（现有 3，需要 7）/);
  assert.deepEqual(result.rows.filter(r=>r.kind==='act').map(r=>r.skill),['FeedSP']);
  assert.equal(result.final.sp[1],7);
  assert.equal(repairs.length,1);assert.ok(!repairs[0].choices.some(a=>a.s==='Finisher'));
  const next=simulateDesign(ctx,{},makeDesign({actions:[feed]},{actions:[finish]}));
  assert.ok(next.phases[0].cleared);assert.ok(!next.issues.some(i=>i.level==='error'));
  assert.equal(next.rows.filter(r=>r.kind==='round')[1].planned[0].selectionSp,9);
});

test('a legal all-SP attack spends the live balance, including SP granted after selection',()=>{
  const ctx=resourceFixture(-1),res=simulateDesign(ctx,{},makeDesign({actions:[feed,finish]}));
  assert.ok(res.phases[0].cleared);assert.ok(!res.issues.some(i=>i.level==='error'));
  assert.equal(plannedFinisher(res,'main').selectionCost,3);
  assert.equal(res.rows.find(r=>r.kind==='act'&&r.unit===1).cost,7);assert.equal(res.final.sp[1],0);
});

test('a lost conditional discount cannot silently overdraw SP; lower live fees and permitted borrowing still work',()=>{
  const {ctx}=fixture(),base=ctx.phases[0].enemies[0];
  const data=JSON.parse(readFileSync(new URL('../public/data/skills.json',import.meta.url),'utf8'));
  const scythe=Object.values(data.styles).flatMap(x=>x.skills).find(s=>s.label==='BIYamawakiSkill54');
  ctx.party[1].skills.push({...scythe,level:1});
  ctx.phases[0].enemies=[{...base,dp:[1],maxDp:1,breakDownSetting:3,hp:1000,maxHp:1000},base];
  const hit={u:1,s:scythe.label},design=makeDesign({actions:[{u:2,s:'normal'}]},
    {actions:[{u:0,s:'Skill0'},hit,{u:2,s:'Skill2'}]});
  const repairs=[],result=simulateDesign(ctx,{onUnavailable:why=>repairs.push(why)},design);
  const choice=result.rows.filter(r=>r.kind==='round')[1].planned[1];
  assert.equal(choice.selectionSp,5);assert.equal(choice.selectionCost,0);assert.equal(choice.selectionError,undefined);
  assert.equal(choice.executionCost,17);assert.match(choice.executionError,/结算时SP不足.*尚待实测/);
  assert.equal(result.final.sp[1],5);assert.ok(result.phases[0].cleared);
  assert.equal(repairs.length,1);assert.ok(repairs[0].choices.some(c=>c.s==='normal'));
  assert.ok(!repairs[0].choices.some(c=>c.s===scythe.label));
  const mc=monteCarlo(ctx,{},design,{n:4,seed:4,scoreOf:()=>assert.fail('invalid repriced action must not score')});
  assert.equal(mc.fails['计划含不可用行动'],4);assert.equal(mc.scoreMean,null);
  // Sufficient SP at selection: the ally's Break lowers the fee to zero before the attack.
  ctx.party[1].initialSp=14;
  const cheaper=simulateDesign(ctx,{},makeDesign({actions:[{u:2,s:'normal'},hit]}));
  assert.equal(plannedFinisher(cheaper,'main').selectionCost,17);
  assert.equal(cheaper.rows.find(r=>r.kind==='act'&&r.unit===1).cost,0);assert.equal(cheaper.final.sp[1],17);
  const borrower=resourceFixture(7);borrower.party[1].skills.at(-1).cond='Sp()>=0';
  const debt=simulateDesign(borrower,{},makeDesign({actions:[finish]}));
  assert.equal(plannedFinisher(debt,'main').selectionAllowance,'技能自带：SP 非负时可透支');
  assert.ok(debt.phases[0].cleared);assert.ok(!debt.issues.some(i=>i.level==='error'));assert.equal(debt.final.sp[1],-4);
});

test('an early kill cannot hide an illegal later selection in simulation or Monte Carlo scoring',()=>{
  const ctx=resourceFixture(1,'Ep'),design=makeDesign({actions:[{u:0,s:'Skill0'},finish]});
  const res=simulateDesign(ctx,{},design),choice=plannedFinisher(res,'main');
  assert.ok(res.phases[0].cleared);assert.equal(choice.selectionCurrency,'EP');assert.equal(choice.selectionEp,0);
  assert.match(choice.selectionError,/EP不足/);assert.ok(res.issues.some(i=>i.level==='error'));
  assert.deepEqual(res.rows.filter(r=>r.kind==='act').map(r=>r.unit),[0]);
  const mc=monteCarlo(ctx,{},design,{n:4,seed:3,scoreOf:()=>assert.fail('illegal plan must never be scored')});
  assert.equal(mc.successes,0);assert.equal(mc.fails['计划含不可用行动'],4);
});

test('extra rounds and successive OD rounds each get a fresh selection window',()=>{
  const ctx=resourceFixture(7);
  const extra=simulateDesign(ctx,{},makeDesign({actions:[{u:0,s:'GiveExtra'}],extra:[feed,finish]}));
  assert.equal(plannedFinisher(extra,'extra').selectionSp,3);assert.match(plannedFinisher(extra,'extra').selectionError,/SP不足/);
  assert.equal(extra.final.sp[1],7);
  // A separate grantor lets SP feeding and unlocking an extra round coexist in the main round.
  ctx.party[2].skills.push(ctx.party[0].skills.find(s=>s.label==='GiveExtra'));
  const legalExtra=simulateDesign(ctx,{},makeDesign({actions:[{u:2,s:'GiveExtra'},feed],extra:[finish]}));
  assert.ok(legalExtra.phases[0].cleared);assert.equal(plannedFinisher(legalExtra,'extra').selectionSp,7);
  const odCtx=resourceFixture(19),od=(first,second)=>makeDesign({actions:[{u:0,s:'ChargeOD'}],
    odEnd:{level:2,rounds:[{actions:first},{actions:second}]}});
  const odFirst=simulateDesign(odCtx,{},od([feed,finish],[]));
  assert.equal(plannedFinisher(odFirst,'od1').selectionSp,15);assert.match(plannedFinisher(odFirst,'od1').selectionError,/SP不足/);
  const odNext=simulateDesign(odCtx,{},od([feed],[finish]));
  assert.ok(odNext.phases[0].cleared);assert.ok(!odNext.issues.some(i=>i.level==='error'));
  assert.equal(plannedFinisher(odNext,'od2').selectionSp,19);
});
