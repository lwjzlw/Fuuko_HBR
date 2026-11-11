import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parse,evaluate,UnsupportedCondition,functionsUsed} from '../public/sim/expr.mjs';
import {computeAttack,basePower,hitDistribution,earringBonus} from '../public/sim/hbr/damage.mjs';
import {buffSize,debuffSize} from '../public/sim/hbr/effects.mjs';
import {attackModel,effectModel,powersByLevel} from '../public/sim/hbr/model.mjs';
import {accessoryEffects,equipmentFrom,membersFromDeck} from '../public/sim/hbr/deck.mjs';
import {buildParty,buildEnemy,initialState,cloneState,startTurn,startOverdrive,endOdRound,endPlayerTurn,startExtraTurn,endExtraTurn,act,usableSkills,effectiveCost,stateKey,NORMAL,bestTurnDamage,availableCommands,useCommand,setPhase,collectMods} from '../public/sim/hbr/battle.mjs';
import * as R from '../public/sim/hbr/rules.mjs';
import {search,replay} from '../public/sim/search.mjs';
import {validatePlanner,membersFrom,emptyPlanner} from '../public/sim/party.mjs';

const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps*Math.max(1,Math.abs(a));

test('published Yamawaki command is independent of actions and the six-servant Big Bang condition',()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json',import.meta.url)));
  const skills=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url)));
  const f=fixtureParty({dp:1e8,hp:1e9}),enemy={...buildEnemy(f.event,f.stage),border:650};
  const team=Array.from({length:5},(_,i)=>({...f.party[0],i,front:i<3}));
  const [hero]=buildParty([{styleId:'BIYamawaki08',stats:team[0].stats,limitBreak:0,strictDeckSkills:true,deckSkillIds:[46003115,46003116]}],{catalog,skills});
  hero.i=5;team.push(hero);
  const other={...enemy,label:'second',name:'second',border:600};
  const st=initialState(team,enemy,{trace:true,statusTypes:skills.statusTypes,critMode:'none'});
  setPhase(st,[enemy,other]);assert.deepEqual(availableCommands(st),[]);
  startTurn(st);const label='BIYamawakiSkill55b',before=cloneState(st),u=st.units[5],sp=u.sp;
  assert.equal(availableCommands(st)[0].remaining,3);assert.equal(u.front,false);
  assert.ok(!hero.skills.some(s=>s.label===label));
  assert.equal(useCommand(st,0,label),null);assert.equal(st.units[5].commandRemaining,3);
  u.effects.push({type:'attackUp',size:500,uses:1});
  const stronger=cloneState(before);
  stronger.ctx={...stronger.ctx,party:team.map((p,i)=>i===0?{...p,stats:{...p.stats,str:p.stats.str+400,dex:p.stats.dex+400}}:p)};
  const cmd=useCommand(st,5,label),control=useCommand(before,5,label);
  assert.equal(cmd.damage,control.damage);assert.equal(cmd.remaining,2);
  assert.ok(useCommand(stronger,5,label).damage>cmd.damage,'another member contributes to the command damage');
  assert.equal(u.effects.find(e=>e.type==='attackUp').uses,1);
  assert.equal(u.sp,sp);assert.equal(u.played,0);assert.ok(!Object.keys(u.uses).length);
  assert.equal(st.turn,1);assert.equal(st.round,'main');assert.equal(cmd.od,30);
  assert.equal(st.log.filter(e=>e.t==='act').length,0);assert.equal(st.log.filter(e=>e.t==='command').length,1);
  const commandKey=stateKey(st);u.commandRemaining++;assert.notEqual(stateKey(st),commandKey);u.commandRemaining--;
  for(const q of st.queue)assert.equal(q.state.effects.find(e=>e.status==='FearOfDevil').size,100);
  st.enemy.effects.push({type:'misfortune',size:90});
  assert.equal(collectMods(st,5,{element:'nonelemental'}).misfortune,100);
  useCommand(st,5,label);useCommand(st,5,label);assert.equal(st.od,90);
  assert.equal(useCommand(st,5,label),null);
  assert.equal(st.enemy.effects.filter(e=>e.status==='FearOfDevil').length,1);
  endPlayerTurn(st);assert.ok(st.queue.every(q=>!q.state.effects.some(e=>e.status==='FearOfDevil')));
  st.killedTurn=1;setPhase(st,[enemy]);assert.equal(st.units[5].commandRemaining,0);
  const extra=cloneState(before);extra.units[0].extra=1;startExtraTurn(extra);assert.equal(availableCommands(extra)[0].s,label);
  const od=cloneState(before);od.od=100;startOverdrive(od,1,'turnStart');assert.equal(availableCommands(od)[0].s,label);
  const dance=hero.skills.findIndex(s=>s.label==='BIYamawakiSkill08'),bang=hero.skills.findIndex(s=>s.label==='BIYamawakiSkill55');
  assert.equal(skills.statusTypes[155],'BIYamawakiServant');
  assert.ok(!usableSkills(before,5).includes(bang));
  before.units[2].front=false;before.units[5].front=true;
  for(let target=0;target<5;target++){before.units[5].sp=20;act(before,5,dance,target);}
  assert.ok(usableSkills(before,5).includes(bang));
});

test('Kunimi talismans use each enemy’s level, count actions instead of hits and reset between enemy turns',()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json',import.meta.url)));
  const skills=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url)));
  const f=fixtureParty({dp:1e8,hp:1e9,initialSp:20});
  const [kunimi]=buildParty([{styleId:'TKunimi10',front:true,stats:f.party[0].stats,limitBreak:4,extraStyleIds:[],initialSp:20}],{catalog,skills});
  const party=[kunimi,...f.party.map((m,i)=>({...m,i:i+1,front:i<2,elements:['ice']}))];
  const enemy=buildEnemy(f.event,f.stage),other={...enemy,label:'other'};
  const st=initialState(party,enemy,{statusTypes:skills.statusTypes,followUpRate:0});
  const levels=()=>st.queue.map(q=>q.state.effects.find(e=>e.status==='Talisman')?.level);
  setPhase(st,[enemy,other]);assert.deepEqual(levels(),[0,0]);
  startTurn(st);assert.deepEqual(levels(),[2,2]);
  act(st,1,NORMAL);assert.deepEqual(levels(),[3,2]);
  const ex=kunimi.skills.findIndex(s=>s.label==='TKunimiSkill56');
  act(st,0,ex);assert.deepEqual(levels(),[6,5],'five-hit EX raises each target once plus its own two-level passive');
  assert.equal(collectModsFor(st,0).misfortune,60);
  for(let i=0;i<6;i++)act(st,1,NORMAL);
  assert.deepEqual(levels(),[10,5]);endPlayerTurn(st);assert.deepEqual(levels(),[0,0]);
  st.killedTurn=1;setPhase(st,[enemy,other]);assert.deepEqual(levels(),[0,0]);
  const extras=JSON.parse(fs.readFileSync(new URL('../public/data/stats.json',import.meta.url))).extraSkills;
  const graviton=Object.values(extras).find(s=>s.label==='AccessorySkillFixedDamageRateIce01');
  party[1].skills.push(graviton);st.units[1].sp=20;
  const before=st.totalDamage;act(st,1,party[1].skills.length-1);
  assert.equal(st.totalDamage,before);assert.deepEqual(levels(),[1,0],'Graviton raises talisman through intact shields');
});

test('Naruse’s reinforced EX applies the two-turn stat penalty to the chosen enemy before her attack',()=>{
  const skills=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url)));
  const root=skills.styles.HNaruse03.skills.find(s=>s.label==='HNaruseSkill51');
  const f=fixtureParty({A:[root],dp:1e8,hp:1e9,initialSp:20}),enemy=buildEnemy(f.event,f.stage);
  const st=initialState(f.party,enemy,{followUpRate:0});
  setPhase(st,[enemy,{...enemy,label:'other'}]);startTurn(st);
  st.units[0].reinforced='light';act(st,0,0);
  assert.equal(collectModsFor(st,0).misfortune,100);
  assert.ok(!st.queue[1].state.effects.some(e=>e.status==='Undermine'));
  endPlayerTurn(st);assert.equal(collectModsFor(st,0).misfortune,100);
  startTurn(st);endPlayerTurn(st);assert.equal(collectModsFor(st,0).misfortune,0);
});

test('published DP sacrifice uses current DP, leaves one DP and cannot revive a broken shield',()=>{
  const skills=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url)));
  const half=skills.styles.MAikawa09.skills.find(s=>s.label==='MAikawaSkill08');
  const full=skills.styles.FMikoto04.skills.find(s=>s.label==='FMikotoSkill04');
  const team=fixtureParty({A:[half,full],initialSp:20});
  team.party[0].dpMax=1000;
  const st=initialState(team.party,buildEnemy(team.event,team.stage),{});
  startTurn(st);st.units[0].dp=400;act(st,0,0);assert.equal(st.units[0].dp,200);
  act(st,0,1);assert.equal(st.units[0].dp,1);assert.equal(st.units[0].dpBroken,false);
  st.units[0].dp=0;st.units[0].dpBroken=true;
  assert.ok(!usableSkills(st,0).includes(0));assert.ok(!usableSkills(st,0).includes(1));
});

test('the real 30 percent front-row attack passive follows the sampled roll',()=>{
  const skills=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url)));
  const passive=skills.styles.Byakko03.passives.find(p=>p.label==='Passive.Turn_Rate30_AttackUp01');
  const f=fixtureParty();f.party[0].passives=[passive];
  for(const [roll,expected] of [[0.299,true],[0.3,false]]){
    const st=initialState(f.party,buildEnemy(f.event,f.stage),{rng:()=>roll});
    startTurn(st);
    assert.equal(st.units[0].effects.some(e=>e.src===passive.label),expected);
  }
});

// ---------------------------------------------------------------- 条件表达式
test('expr: precedence, identifiers starting with digits, comparisons',()=>{
  const fns={IsTeam:(e,a)=>a[0].v==='31A'?1:0,Sp:()=>7};
  assert.equal(evaluate('IsTeam(31A)==1&&Sp()>=7',{},fns),true);
  assert.equal(evaluate('IsTeam(31C)==1||Sp()+1*2==9',{},fns),true);
  assert.equal(evaluate('!(Sp()>3)',{},fns),false);
  assert.equal(evaluate('',{},fns),true);
  assert.throws(()=>evaluate('Unknown()>0',{},fns),UnsupportedCondition);
  assert.deepEqual(functionsUsed('CountBC(IsPlayer()&&Sp()>1)>=2').sort(),['CountBC','IsPlayer','Sp']);
  assert.throws(()=>parse('Sp(>'),SyntaxError);
});
test('every condition expression in skills.json parses',()=>{
  const d=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url),'utf8'));
  let count=0;const bad=[];
  const walk=o=>{if(Array.isArray(o))return o.forEach(walk);if(o&&typeof o==='object')for(const [k,v] of Object.entries(o)){if(['cond','targetCondition','hitCondition','condition','useCond','overwriteCond'].includes(k)&&typeof v==='string'&&v.trim()){count++;try{parse(v);}catch{bad.push(v);}}else walk(v);}};
  walk(d.styles);
  assert.ok(count>1000);assert.deepEqual(bad,[]);
});

// ---------------------------------------------------------------- 社区计算器对拍（固定样例）
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/community-cases.json',import.meta.url),'utf8'));
test(`damage matches the community calculator on ${fixture.damage.length} recorded cases`,()=>{
  let bad=[];
  for(const [i,c] of fixture.damage.entries()){
    const r=computeAttack({skill:c.skill,level:c.level,stats:Object.fromEntries(Object.entries(c.stats).map(([k,v])=>[k,v+Math.min(10,c.mods.morale||0)*5])),enemy:c.enemy,mods:c.mods,state:c.state});
    const ok=['min','max','critMin','critMax'].every(k=>near(r.total[k],c.expect.total[k]))&&near(r.critRate.total,c.expect.critRate)
      &&r.perHit.every((h,k)=>near(h.min,c.expect.perHit[k].min)&&near(h.max,c.expect.perHit[k].max))
      &&r.destructionPerHit.every((d,k)=>near(d,c.expect.destruction[k]));
    if(!ok)bad.push(i);
  }
  assert.deepEqual(bad,[]);
});
test(`buff/debuff sizes match the community calculator on ${fixture.effects.length} recorded cases`,()=>{
  const bad=[];
  for(const [i,c] of fixture.effects.entries()){
    const r=c.model.kind==='buff'?buffSize(c.model,c.level,c.stats,c.opt):debuffSize(c.model,c.level,c.stats,c.border,c.opt);
    if(!near(r.base,c.expect.base)||!near(r.total,c.expect.total))bad.push(i);
  }
  assert.deepEqual(bad,[]);
});

// ---------------------------------------------------------------- 公式细节
test('base power: linear up to the limit, +0.25%/pt beyond, floor 1 below',()=>{
  assert.equal(basePower(100,200,100,100),200);
  assert.equal(basePower(100,200,50,100),150);
  assert.equal(basePower(100,200,-50,100),50);
  assert.equal(basePower(100,200,-100,100),1);
  assert.equal(basePower(100,200,500,100),400);
});
test('hit distribution and earring tables',()=>{
  assert.deepEqual(hitDistribution(null,4),[25,25,25,25]);
  assert.deepEqual(hitDistribution([50],3),[50,25,25]);
  assert.equal(earringBonus({bonus:15},1),15);
  assert.equal(earringBonus({bonus:15},10),5);
  assert.equal(earringBonus({bonus:15},1,true),5);
});
test('a weak hit enables mind-eye and fragile; resisted element keeps them off',()=>{
  const skill={element:'ice',physicalType:'slash',hitCount:1,maxLevel:1,powers:{min:[1000],max:[2000]},paramLimit:100,parameters:{str:1,dex:0,con:0,wis:0,spr:0,luk:0},destructionRateBonus:1};
  const enemy=w=>({border:300,hp:1e9,dp:[],destruction:5,destructionLimit:999,weaknesses:{physical:{slash:100,stab:100,strike:100},element:{fire:100,ice:w,thunder:100,light:100,dark:100,nonelemental:100}}});
  const mods={mindsEye:50,fragile:40};
  const weak=computeAttack({skill,level:1,stats:{str:400,dex:400,con:0,wis:0,spr:0,luk:0},enemy:enemy(200),mods});
  const resist=computeAttack({skill,level:1,stats:{str:400,dex:400,con:0,wis:0,spr:0,luk:0},enemy:enemy(50),mods});
  assert.equal(weak.meta.weak,true);assert.equal(resist.meta.weak,false);
  assert.ok(near(weak.meta.attack.hp,1.5));assert.ok(near(weak.meta.defense.hp,1.4));
  assert.ok(near(resist.meta.attack.hp,1));assert.ok(near(resist.meta.defense.hp,1));
});

// ---------------------------------------------------------------- 主数据 → 模型
test('attack model from master data parts',()=>{
  const part={skillType:'AttackSkill',targetType:'Single',power:[1455,2910],attackType:'Slash',diffForMax:123,parameters:{str:2,dex:1},growth:[0.05,0.02],multipliers:{dp:1,hp:1.3,dr:1.5}};
  const m=attackModel({id:1,label:'X',hitCount:2,maxLevel:10,parts:[part]},part);
  assert.equal(m.hpBonus,30);assert.equal(m.dpBonus,undefined);assert.equal(m.destructionRateBonus,1.5);
  assert.equal(m.powers.min[9],2109.75);assert.ok(near(m.powers.max[9],3433.8));assert.equal(m.powers.min.length,20);
  const pen=attackModel({hitCount:2,maxLevel:1,parts:[]},{...part,skillType:'PenetrationCriticalAttack',value:[3,0]});
  assert.equal(pen.isPenetration,true);assert.equal(pen.penetrationPhysicalWeakness,400);
  const weak=attackModel({hitCount:1,maxLevel:1,parts:[]},{...part,skillType:'DamageRateChangeAttackSkill',value:[3.125,1.32],cond:'IsHitWeak()'});
  assert.equal(weak.weakHitDestructionRate,3.125);assert.equal(weak.weakHitPowerMultiplier,1.32);
});
test('effect models: fixed values, DP-only defense down, funnel ranges, misfortune levels',()=>{
  const s={id:1,label:'S',maxLevel:10};
  assert.deepEqual(effectModel(s,{skillType:'CriticalDamageUp',power:[0.5,0]}).effects.max.slice(0,2),[50,50]);
  assert.equal(effectModel(s,{skillType:'DefenseDown',power:[0.8,1.4],multipliers:{dp:1,hp:0}}).type,'dpDefenseDown');
  assert.equal(effectModel(s,{skillType:'DefenseDown',power:[0.3,0.45],elements:['Fire'],exit:{cond:'Eternal'}}).isPermanent,true);
  assert.deepEqual(effectModel(s,{skillType:'Funnel',power:[2,3],value:[0.25,0]}).effects.max,[25,25,25]);
  assert.equal(effectModel(s,{skillType:'Misfortune',power:[2,0]}).effects.max[0],20);
  assert.equal(effectModel(s,{skillType:'Zone',power:[1.8,0],elements:['Ice']}).effects.max[0],80);
  assert.equal(effectModel(s,{skillType:'HealSp',power:[3,0]}),null);
  assert.deepEqual(powersByLevel({power:[10,20],growth:[0.1,0]},3),{min:[10,11,12],max:[20,20,20]});
});

// ---------------------------------------------------------------- 编队与饰品
test('accessory main-ability ids decode as group + option; equipment parameters',()=>{
  const ear={sourceId:9,effects:[],rollGroups:[[{type:'PassiveSkill',skill:{description:'OD量表上升量最大+10%'}},{type:'PassiveSkill',skill:{description:'OD量表上升量最大+12%'}},{type:'PassiveSkill',skill:{description:'OD量表上升量最大+15%'}}],[{type:'Dp',value:[400,0]},{type:'Dp',value:[450,0]}]]};
  assert.equal(accessoryEffects(ear,[42600203,42600212]).length,2);
  const atk={sourceId:10,effects:[],rollGroups:[[{type:'PassiveSkill',skill:{description:'對HP技能攻擊力最大+12%（Hit數越少效果越高）'}}]]};
  const neck={sourceId:11,effects:[{type:'PassiveSkill',skill:{parts:[{skill_type:'AttackUp',power:[0.1,0],elements:[]}]}},{type:'PassiveSkill',skill:{parts:[{skill_type:'SkillLimitCountUp',power:[1,0],elements:['Ice']}]}},{type:'Sp',value:[3,0]}],rollGroups:[]};
  const role={sourceId:12,effects:[],rollGroups:[[{type:'Sp',value:[3,0],condition:'IsAttacker()'},{type:'Sp',value:[3,0],condition:'IsHealer()'}]]};
  const ring={sourceId:13,effects:[{type:'PassiveSkill',skill:{parts:[{skill_type:'AttackUp',power:[0.1,0],elements:['Ice']}]}}],rollGroups:[]};
  const by=new Map([[9,ear],[10,atk],[11,neck],[12,role],[13,ring]]);
  const q=equipmentFrom({earring:{masterId:9,main:[42600203]},necklace:{masterId:11,main:[]},ring:{masterId:13,main:[]}},by,'Attacker');
  assert.equal(q.odEarringBonus,15);assert.equal(q.necklaceAttack,true);assert.equal(q.initialSp,3);assert.equal(q.ringElement,'ice');assert.equal(q.ringLevel,4);assert.equal(q.skillCountUp.ice,1);
  assert.deepEqual(equipmentFrom({earring:{masterId:10,main:[42600101]}},by,'Healer').earring,{type:'attacking',bonus:12});
  assert.equal(equipmentFrom({necklace:{masterId:12,main:[42601001]}},by,'Attacker').initialSp,3);
  assert.equal(equipmentFrom({necklace:{masterId:12,main:[42601001]}},by,'Healer').initialSp,0);
  const catalog={styles:[{id:'S1',characterId:'C1',role:'Attacker'}]};
  const ms=membersFromDeck({index:3,members:[{styleId:'S1',accessories:{necklace:{masterId:11,main:[]}},skillIds:[5,6],limitBreak:4,tearLevel:1}]},{catalog,equipment:{entries:[neck]},previous:[{styleId:'S1',stats:{str:500}}]});
  assert.equal(ms.length,6);assert.equal(ms[0].initialSp,3);assert.deepEqual(ms[0].stats,{str:500});assert.equal(ms[0].tearLevel,1);assert.deepEqual(ms[0].deckSkillIds,[5,6]);assert.equal(ms[1].styleId,'');
});

// ---------------------------------------------------------------- 回合（社区 Planner 规则）
const atkSkill=(label,sp,power,extra={})=>({id:label.length*1000+sp,label,name:label,sp,consume:'Sp',uses:-1,hitCount:2,maxLevel:1,restricted:false,
  parts:[{skillType:'AttackSkill',targetType:'Single',power:[power,power],attackType:'Slash',diffForMax:100,parameters:{str:1},multipliers:{dp:1,hp:1,dr:2}}],...extra});
const buffSkill=(label,sp,value,exit={cond:'Count',value:[1,0]},limitType)=>({id:label.length*7+sp,label,name:label,sp,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,restricted:false,
  parts:[{skillType:'AttackUp',targetType:'AllyFront',power:[value,0],exit,limitType}]});
function fixtureParty({A=[atkSkill('A1',2,1000)],B=[buffSkill('B1',2,0.5)],C=[],passives=[],dp=1000,hp=100000,weak={},initialSp=0,odEarring=0}={}){
  const catalog={styles:[
    {id:'S1',characterId:'C1',name:'s1',team:'31A',role:'Attacker',attackType:'Slash',elements:['Fire'],baseParameters:{}},
    {id:'S2',characterId:'C2',name:'s2',team:'31A',role:'Buffer',attackType:'Stab',elements:[],baseParameters:{}},
    {id:'S3',characterId:'C3',name:'s3',team:'31A',role:'Buffer',attackType:'Strike',elements:[],baseParameters:{}}],
    characters:[{id:'C1',name:'甲',styleIds:['S1']},{id:'C2',name:'乙',styleIds:['S2']},{id:'C3',name:'丙',styleIds:['S3']}]};
  const skills={styles:{S1:{skills:A,passives},S2:{skills:B,passives:[]},S3:{skills:C,passives:[]}},statusTypes:{20:'AdditionalTurn'}};
  const stats={str:500,dex:500,con:500,wis:500,spr:500,luk:0};
  const party=buildParty([{styleId:'S1',stats,front:true,initialSp,equipment:{odEarringBonus:odEarring}},{styleId:'S2',stats,front:true,initialSp},{styleId:'S3',stats,front:true,initialSp}],{skills,catalog});
  const event={enemies:{E:{flags:{is_boss:true},resist:{element:{slash:weak.slash||0,stab:0,strike:0,fire:0}},pattern:{dp:{entries:[{order:1,skills:[1]}]},hp:{entries:[{order:1,skills:[1]}]}},skills:[{id:1,name:'敌技',parts:[{skillType:'AttackSkill'}]}]}}};
  const stage={enemies:[{label:'',dp:0,hp:0},{label:'E',name:'敌',dp,hp,paramBorder:400,destruction:[10,300]}]};
  return {party,event,stage,skills,catalog};
}

test('SP: +2 per normal turn for everyone, no regen at ≥20, OD first round +5/+12/+20, extra turns give none',()=>{
  const f=fixtureParty({initialSp:1});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});
  assert.deepEqual(st.units.map(u=>u.sp),[2,2,2],'base 1 + initialSp 1');
  startTurn(st);assert.deepEqual(st.units.map(u=>u.sp),[4,4,4]);
  st.units[0].sp=19;st.units[1].sp=20;st.units[2].sp=25;startTurn(st);
  assert.deepEqual(st.units.map(u=>u.sp),[20,20,25]);
  st.od=200;assert.equal(startOverdrive(st,2,'turnStart'),true);
  assert.deepEqual(st.units.map(u=>u.sp),[32,32,37]);assert.equal(st.odRounds,2);assert.equal(st.od,0);
  const before=st.units.map(u=>u.sp);st.units[0].extra=1;startExtraTurn(st);endExtraTurn(st,[0]);
  assert.deepEqual(st.units.map(u=>u.sp),before);
});
test('OD gauge: 2.5% per hit scaled by DRIVE earring, normal attack counts 3 hits, resisted hits add nothing',()=>{
  const f=fixtureParty({dp:1e7,odEarring:15});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});st.units.forEach(u=>u.sp=20);startTurn(st);
  act(st,0,0);                                   // 2 hits, earring +15 at 2 hits → 15−(10/9)×8
  const per=Math.floor(2.5*(1+(15-10/9*8)/100)*100)/100;
  assert.ok(near(st.od,2*per));
  const o=st.od;act(st,1,NORMAL);assert.ok(near(st.od,o+7.5));
  const g=fixtureParty({dp:1e7,weak:{slash:50}});
  const s2=initialState(g.party,buildEnemy(g.event,g.stage),{});s2.units.forEach(u=>u.sp=20);startTurn(s2);act(s2,0,0);
  assert.equal(s2.od,0);
});
test('durations: Count buffs are spent by the next skill attack, turn buffs tick at turn end, OD rounds tick separately',()=>{
  const f=fixtureParty({dp:1e7,B:[buffSkill('B1',2,0.5),buffSkill('B2',2,0.3,{cond:'PlayerTurnEnd',value:[2,0]})]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});st.units.forEach(u=>u.sp=20);
  startTurn(st);act(st,1,0);act(st,1,1);
  const types=()=>st.units[0].effects.map(e=>e.size);
  assert.equal(st.units[0].effects.length,2);
  act(st,0,NORMAL);assert.equal(st.units[0].effects.length,2,'normal attack does not spend skill buffs');
  act(st,0,0);assert.equal(st.units[0].effects.length,1,'Count buff spent');
  endPlayerTurn(st);assert.equal(st.units[0].effects[0].turns,1);
  startTurn(st);st.od=100;startOverdrive(st,1,'turnEnd');endOdRound(st);
  assert.equal(st.units[0].effects.length,0,'OD round counts as a turn');
});
test('slot rule: two attack buffs at most, a [single activation] buff fills both slots',()=>{
  const f=fixtureParty({dp:1e9,B:[buffSkill('B1',0,0.5),buffSkill('B2',0,0.4),buffSkill('B3',0,0.3)],C:[buffSkill('O1',0,1.2,{cond:'Count',value:[1,0]},'Once')]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none'});st.units.forEach(u=>u.sp=30);startTurn(st);
  act(st,1,0);act(st,1,1);act(st,1,2);
  const d1=st.totalDamage;act(st,0,0);const two=st.totalDamage-d1; // 0.5+0.4 = ×1.9
  act(st,2,0);const d2=st.totalDamage;act(st,0,0);const once=st.totalDamage-d2; // Once 1.2 alone vs leftover 0.3? → Once占满 → ×2.2
  assert.ok(near(once/two,2.2/1.9,1e-3),`once/two=${once/two}`);
});
test('extra turn: only the granted member acts and only their turn effects tick',()=>{
  const extra={id:77,label:'X',name:'X',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[{skillType:'AdditionalTurn',targetType:'Self',power:[1,0]}]};
  const f=fixtureParty({A:[atkSkill('A1',2,1000),extra],B:[buffSkill('B2',0,0.3,{cond:'PlayerTurnEnd',value:[2,0]})]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);
  act(st,1,0);act(st,0,1);assert.equal(st.units[0].extra,1);
  startExtraTurn(st);endExtraTurn(st,[0]);
  assert.equal(st.units[0].effects[0].turns,1,'actor ticked');
  assert.equal(st.units[1].effects[0].turns,2,'others not');
  assert.equal(st.units[0].extra,0);
});
test('deck skill ids restrict the usable pool; skill count up from necklaces',()=>{
  const f=fixtureParty({A:[atkSkill('A1',2,1000,{uses:[1]}),atkSkill('A22',3,900)]});
  const p=buildParty([{styleId:'S1',stats:{str:500},front:true,deckSkillIds:[f.party[0].skills[1].id]}],{skills:f.skills,catalog:f.catalog});
  assert.deepEqual(p[0].skills.map(s=>s.label),['A22']);
  const fire={...atkSkill('F1',0,100,{uses:[1]})};fire.parts[0].elements=['Fire'];
  const g=fixtureParty({A:[fire]});
  const q=buildParty([{styleId:'S1',stats:{str:500},front:true,equipment:{skillCountUp:{fire:1}}},{styleId:'S2',front:true},{styleId:'S3',front:true}],{skills:g.skills,catalog:g.catalog});
  const st=initialState(q,buildEnemy(g.event,g.stage),{});startTurn(st);
  act(st,0,0);assert.ok(usableSkills(st,0).includes(0),'second use allowed by +1');
  act(st,0,0);assert.ok(!usableSkills(st,0).includes(0));
});
test('search finds a kill and replay reproduces it',()=>{
  const f=fixtureParty({dp:2000,hp:20000});
  const enemy=buildEnemy(f.event,f.stage);
  const r=search({party:f.party,enemy,statusTypes:f.skills.statusTypes},{objective:'minTurns',maxTurns:10,beam:8,critMode:'none'});
  assert.ok(r.plans.length>=1);
  const p=r.plans[0];
  const st=replay({party:f.party,enemy,statusTypes:f.skills.statusTypes},{critMode:'none'},p.plan);
  assert.equal(st.killedTurn,p.killedTurn);
  assert.equal(Math.round(bestTurnDamage(st)),Math.round(p.scoreDamage));
  assert.ok(p.log.some(l=>l.t==='enemy'));
});

// ---------------------------------------------------------------- 配置
test('planner config validation and member assembly',()=>{
  const p=emptyPlanner();
  assert.equal(validatePlanner(p),p);
  assert.throws(()=>validatePlanner({members:[]}),/六个位置/);
  assert.throws(()=>validatePlanner({members:Array(6).fill({styleId:'',stats:{foo:1}})}),/未知面板属性/);
  assert.throws(()=>validatePlanner({members:Array(6).fill({styleId:'',initialSp:-1})}),/初期 SP/);
  const catalog={styles:[{id:'S1',characterId:'C1',baseParameters:{str:5}}],characters:[{id:'C1',name:'甲',styleIds:['S1'],baseParameters:{level:[1,200],str:[10,210]}}]};
  p.members[0]={styleId:'S1',stats:{str:900},front:true,initialSp:3,equipment:{necklaceAttack:true},deckSkillIds:[1]};
  const r=membersFrom(p,{styles:{S1:{owned:true,limitBreak:3,skillLevels:{X:7}}},characters:{C1:{level:200}}},catalog);
  assert.equal(r.ready,false);
  assert.equal(r.members[0].stats.str,900);assert.equal(r.members[0].limitBreak,3);assert.equal(r.members[0].skillLevels.X,7);
  assert.equal(r.members[0].initialSp,3);assert.equal(r.members[0].equipment.necklaceAttack,true);assert.deepEqual(r.members[0].deckSkillIds,[1]);
});

// ---------------------------------------------------------------- 面板推算
import {computePanel,titleRank,treeNodes,STAT_MODEL} from '../public/sim/hbr/stats.mjs';
test('title rank thresholds and tree nodes from cache part counts',()=>{
  assert.equal(titleRank(0),1);assert.equal(titleRank(500),2);assert.equal(titleRank(1499),2);assert.equal(titleRank(1500),3);assert.equal(titleRank(42600),13);
  const sd={tree:[[{t:'Skill'}],[{t:'all',v:15}],[{t:'str',v:2},{t:'Skill'},{t:'dex',v:10}],[{t:'wis',v:2},{t:'all',v:1}]]};
  const r=treeNodes(sd,[{id:38111102,count:3},{id:38111103,count:1}]);
  assert.deepEqual(r.nodes.filter(n=>n.v).map(n=>n.t+n.v),['all15','str2','dex10','wis2']);assert.equal(r.partial,true);
});
test('computePanel follows the structure verified against the in-game panel',()=>{
  const lvl={level:[1,201],str:[0,200],dex:[0,200],con:[0,200],spr:[0,200],wis:[0,200],luk:[0,200],dp:[100,2100],hp:[0,1800]};
  const stats={characters:{C1:lvl,C2:lvl},
    styles:{
      S1:{tier:'SSR',base:{str:35,dex:35,con:30,spr:40,wis:40,luk:30,dp:70,hp:0},statUpPerLb:10,lbMax:4,basic:false,lbBonus:[],
          tree:[[],[{t:'dp',v:200,k:'add'},{t:'all',v:15,k:'add'}],[{t:'str',v:10,k:'ratio'},{t:'str',v:2,k:'add'},{t:'wis',v:1,k:'shared'}]]},
      S0:{tier:'SS',base:{},statUpPerLb:10,lbMax:4,basic:true,tree:[[],[],[{t:'str',v:1,k:'shared'}]],lbBonus:[{step:4,t:'allOther',v:10}]},
      S2:{tier:'S',base:{},statUpPerLb:3,lbMax:10,tree:[],lbBonus:[{step:10,t:'dex',v:2}]},
      SP:{tier:'SS',base:{str:40,dex:40,con:40,spr:40,wis:40,luk:40,dp:70,hp:0},statUpPerLb:10,lbMax:4,basic:false,lbBonus:[],tree:[]}},
    latents:{'9':{unique:true,stats:{str:20,dex:20},passives:[]}},
    extraSkills:{'777':{passive:{parts:[{skillType:'MemorySpirit',dv:20}]}}}};
  const equipment={entries:[
    {sourceId:1,slot:'ring',effects:[{type:'Power',value:[42,0]},{type:'Dexterity',value:[55,0]}],rollGroups:[]},
    {sourceId:2,slot:'charm',effects:[],rollGroups:[[{type:'Power',value:[6,0]},{type:'Power',value:[9,0]},{type:'Power',value:[12,0]},{type:'Power',value:[14,0]},{type:'Power',value:[15,0]}]]},
    {sourceId:3,slot:'soul',effects:[],rollGroups:[]},
    {sourceId:5,slot:'earring',effects:[],rollGroups:[[{type:'PassiveSkill',value:[0,0]}],[{type:'Dp',value:[400,0]},{type:'Dp',value:[1200,0]}],[{type:'Wisdom',value:[32,0]},{type:'Wisdom',value:[48,0]}]]},
    {sourceId:4,slot:'booster',effects:[{type:'Power',value:[39,0]}]}]};
  const catalog={styles:[{id:'S1',characterId:'C1'},{id:'S0',characterId:'C1'},{id:'S2',characterId:'C1'},{id:'SP',characterId:'C2'}]};
  const m={styleId:'S1',limitBreak:3,character:{level:180,reincarnation:5,titleExp:42600},card:{level:21,daphne:0,latentPanels:[3,0,0,0,0,0],treeParts:[{id:2,count:3}]},
    accessories:{ring:{masterId:1,main:[],expansion:[42400012,42400012]},powerCharm:{masterId:2,main:[42601505]},soul:{masterId:3,main:[],plus:5,expansion:[]},earring:{masterId:5,main:[42600203,42600212,42600221],expansion:[]}},
    boosterId:4,sphereIds:[],latentIds:[9],skillIds:[777],
    characterCards:[{styleId:'S1',limitBreak:3,treeParts:[{id:2,count:3}]},{styleId:'S0',limitBreak:4,treeParts:[{id:2,count:1}]},{styleId:'S2',limitBreak:10,treeParts:[]}],
    support:{styleId:'SP',limitBreak:4,card:{level:21,daphne:1,latentPanels:[],treeParts:[]},character:{level:180,reincarnation:0,titleExp:0},characterCards:[{styleId:'SP',limitBreak:4,treeParts:[]}]}};
  const r=computePanel(m,{stats,equipment,catalog,memoryCount:2});
  // 基础 str = 200(Lv201) + 5 + 9(称号13) + 1(S0 共享) + 6(潜在 3×2) = 221；战术% = 35+30+10(节点)+10(基本衣装)
  assert.equal(r.rate.str,85);assert.equal(r.rate.dp,70);
  const C=x=>Math.ceil(x-1e-9); // 游戏向上取整
  const sup=C(C(200*(1+(40+40+10)/100))*0.1);
  const gear=42+15+25;
  assert.equal(r.final.str,C(221*1.85)+(15+2)+gear+39+20+sup);
  assert.equal(r.final.dex,C((200+5+9+2)*1.75)+15+(55+6+25)+20+C(C(200*1.9)*0.1),'dex: S2 LB bonus 2 in base, +slots 2×3');
  assert.equal(r.final.wis,C((200+5+9+1)*1.8)+15+(48+25)+C(C(200*1.9)*0.1),'own shared node lands in base');
  assert.equal(r.final.dp,C((2100+100)*1.7)+200+1200+C(C(2100*1.7)*0.1));
  assert.equal(r.final.hp,1800+180,'HP: no style %, support 10%');
  assert.equal(titleRank(42600),13);
});

// ---------------------------------------------------------------- 机制补全
test('mechanics: OD damage passive, break-triggered passive, stat-up, per-token attack, debuff extension, named status conditions',()=>{
  const odP={label:'P.OD',name:'OD',timing:'OnOverdriveStart',parts:[{skillType:'DamageUpByOverDrive',targetType:'Self',power:[0.1,0],exit:{cond:'OverDriveEnd',value:[1,0]}}]};
  const brk={label:'P.BRK',name:'破碎',timing:'OnFirstBattleStart',parts:[{skillType:'AdditionalHitOnBreaking',targetType:'Self',power:[0,0]},{skillType:'AttackUp',targetType:'AllyAll',power:[0.6,0],exit:{cond:'PlayerTurnEnd',value:[8,0]},limitType:'Only'}]};
  const tokP={label:'P.TOK',name:'高揚',timing:'OnPlayerTurnStart',parts:[{skillType:'AttackUpPerToken',targetType:'Self',power:[0.05,0],exit:{cond:'PlayerTurnEnd',value:[1,0]}}]};
  const ext={label:'P.EXT',name:'蝕化',timing:'OnFirstBattleStart',parts:[{skillType:'GiveDebuffTurnUp',targetType:'Self',power:[1,0],exit:{cond:'Eternal'}}]};
  const strUp={id:5,label:'SU',name:'SU',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[{skillType:'PowerUpValue',targetType:'Self',power:[20,0],exit:{cond:'PlayerTurnEnd',value:[2,0]}}]};
  const diva={id:6,label:'DV',name:'DV',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[{skillType:'Diva',targetType:'AllyAll',power:[0.3,0],exit:{cond:'PlayerTurnEnd',value:[5,0]}}]};
  const def={id:7,label:'DD',name:'DD',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[{skillType:'DefenseDown',targetType:'Single',power:[0.3,0],exit:{cond:'EnemyTurnEnd',value:[1,0]}}]};
  const f=fixtureParty({dp:500,hp:1e9,A:[atkSkill('A1',0,1000),strUp,diva,def],passives:[odP,brk,tokP,ext]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none',statusTypes:{144:'Diva'}});st.units.forEach(u=>u.sp=30);
  startTurn(st);
  act(st,0,0);                                   // 破盾 → 全队攻击 +60%（8 回合）
  assert.ok(st.units[1].effects.some(e=>e.type==='attackUp'&&e.size===60&&e.turns===8));
  act(st,0,1);assert.ok(st.units[0].effects.some(e=>e.type==='statUp'&&e.stat==='str'&&e.size===20));
  act(st,0,2);assert.ok(st.units[2].effects.some(e=>e.status==='Diva'));
  assert.equal(evaluateIn(st,0,'SpecialStatusCountByType(144)>0'),true);
  act(st,0,3);assert.equal(st.enemy.effects.find(e=>e.type==='defenseDown').turns,2,'1 + GiveDebuffTurnUp 1');
  st.units[0].tokens=4;
  const a=collectModsFor(st,0);assert.equal(a.passiveAttackUp,20,'5% × 4 tokens');
  st.od=100;startOverdrive(st,1,'turnStart');
  assert.equal(collectModsFor(st,0).overdrivePercent,110);
  const s3=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none',statusTypes:{144:'Diva'}});startTurn(s3);s3.od=300;startOverdrive(s3,3,'turnStart');
  assert.equal(collectModsFor(s3,0).overdrivePercent,130,'OD3 ×1.3');
});
test('deck skill list resolves orb/master skills and equipped latent ability passives',()=>{
  const f=fixtureParty();
  const stats={extraSkills:{'46300007':{id:46300007,label:'Orb',name:'ポイントケア',sp:1,consume:'Sp',uses:[1],hitCount:-1,maxLevel:1,parts:[{skillType:'HealSp',targetType:'Self',power:[3,0]}]}},
    latents:{'331':{unique:false,stats:{},passives:[{label:'L1',name:'火の心得',timing:'OnFirstBattleStart',parts:[{skillType:'AttackUp',targetType:'Self',power:[0.1,0],elements:['Fire'],exit:{cond:'Eternal'}}]}]}}};
  const p=buildParty([{styleId:'S1',stats:{str:500},front:true,deckSkillIds:[f.party[0].skills[0].id,46300007],latentIds:[331]}],{skills:f.skills,catalog:f.catalog,stats});
  assert.deepEqual(p[0].skills.map(s=>s.label),['A1','Orb']);
  assert.ok(p[0].passives.some(x=>x.label==='L1'));
});
import {normalAttackModel} from '../public/sim/hbr/battle.mjs';
import {evaluate as evalExpr} from '../public/sim/expr.mjs';
function collectModsFor(st,i){return collectMods(st,i,{element:'nonelemental',physicalType:'slash'},{});}
function evaluateIn(st,i,expr){
  // 借 usableSkills 的条件求值通道：构造一个带条件的技能
  const u=st.ctx.party[i];const probe={id:-9,label:'probe',name:'probe',sp:0,consume:'Sp',uses:-1,maxLevel:1,parts:[],cond:expr};
  u.skills.push(probe);const ok=usableSkills(st,i).includes(u.skills.length-1);u.skills.pop();return ok;
}

test('transcendence gauge: 15%/member start, +4% per action of that element, 100% → OD +100 and burst for that element',()=>{
  const f=fixtureParty({dp:1e9,hp:1e9});
  f.party[0].transcend='fire';f.party[1].elements=['fire'];   // 火属性 2 人 → 初期 30%
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none'});st.units.forEach(u=>u.sp=30);
  assert.deepEqual({g:st.trans.gauge,a:st.trans.active,el:st.trans.element},{g:30,a:false,el:'fire'});
  startTurn(st);
  act(st,0,NORMAL);assert.equal(st.trans.gauge,34);
  act(st,2,NORMAL);assert.equal(st.trans.gauge,34,'non-fire member does not charge');
  act(st,1,NORMAL);assert.equal(st.trans.gauge,38);
  st.trans.gauge=96;const od=st.od;act(st,0,NORMAL);
  assert.equal(st.trans.active,true);assert.ok(near(st.od,od+7.5+100));
  const fire=collectMods(st,0,{element:'fire',physicalType:'slash'},{}),none=collectMods(st,0,{element:'nonelemental',physicalType:'slash'},{});
  assert.equal(fire.passiveAttackUp,300);assert.equal(fire.forceCrit,true);assert.equal(fire.critDamageUp,100);assert.equal(fire.superBreak,300);assert.equal(fire.passiveDamageRateUp,10);
  assert.equal(none.passiveAttackUp,300);assert.equal(!!none.forceCrit,false);assert.equal(none.superBreak,0);
  assert.equal(collectMods(st,2,{element:'fire',physicalType:'slash'},{}).passiveAttackUp,0,'non-fire style gets nothing');
  // 单独发动的暴伤：技能 120% 单独发动 > 超越 100%，取高者
  st.units[0].effects.push({type:'critDamageUp',size:120,limitType:'Once',uses:null,turns:3});
  assert.equal(collectMods(st,0,{element:'fire',physicalType:'slash'},{}).critDamageUp,120);
  // 确定暴击：critMode none 下也按暴击伤害
  const r=computeAttack({skill:attackModel(f.party[0].skills[0],f.party[0].skills[0].parts[0],{}),level:1,stats:f.party[0].stats,
    enemy:{...buildEnemy(f.event,f.stage)},mods:{forceCrit:true},state:{destructionRate:1}});
  assert.equal(r.critRate.total,100);
});
test('element marks: only styles of that element, level = party count; Lv1 damage, Lv3 destruction gain',()=>{
  const mark={label:'P.FM',name:'火の印',timing:'OnFirstBattleStart',parts:[{skillType:'FireMark',targetType:'AllyAll',power:[0.3,0],exit:{cond:'Eternal'}}]};
  const f=fixtureParty({passives:[mark]});f.party[1].elements=['fire'];
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});
  assert.deepEqual(st.units.map(u=>u.effects.find(e=>e.type==='mark')?.level??0),[2,2,0]);
  const m=collectMods(st,0,{element:'fire',physicalType:'slash'},{});
  assert.equal(m.passiveAttackUp,30,'Lv1 +30% joins the attack group');assert.equal(m.passiveDamageRateUp,0);
  assert.equal(collectMods(st,0,{element:'fire',physicalType:'slash'},{normal:true}).passiveAttackUp,0,'normal attack is not a skill attack');
  const g=fixtureParty({passives:[mark]});g.party[1].elements=['fire'];g.party[2].elements=['fire'];
  const s3=initialState(g.party,buildEnemy(g.event,g.stage),{});
  assert.equal(s3.units[2].effects.find(e=>e.type==='mark').level,3);
  assert.equal(collectMods(s3,0,{element:'fire',physicalType:'slash'},{}).passiveDamageRateUp,10);
});
test('OD rounding: per-hit amount truncated to 0.01 before multiplying by hits; skill OD parts scaled by earring and truncated',()=>{
  const odSkill={id:77,label:'ODS',name:'ODS',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[0.1,0]}]};
  const f=fixtureParty({dp:1e9,hp:1e9,odEarring:15,A:[atkSkill('A1',0,1000,{hitCount:10}),odSkill]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});st.units.forEach(u=>u.sp=30);startTurn(st);
  act(st,0,0);assert.equal(st.od,28.7,'10 hits × floor(2.5×1.15) = 10 × 2.87 (@gazou774)');
  act(st,0,1);assert.equal(st.od,39.2,'非攻击技能按 1 hit：耳环 +5% → 10 × 1.05 = 10.50');
});
test('admiral styles cannot normal attack; their command action is always available',()=>{
  const cmd={id:46001134,label:'RKayamoriCommandBuff',name:'指揮行動',sp:0,consume:'Sp',uses:-1,hitCount:-1,maxLevel:10,
    parts:[{skillType:'AttackUpIncludeNormal',targetType:'AllyFront',power:[0.15,0.15],exit:{cond:'PlayerTurnEnd',value:[1,0]}}]};
  const f=fixtureParty({A:[atkSkill('A1',2,1000),cmd]});
  const p=buildParty([{styleId:'S1',stats:{str:500},front:true,deckSkillIds:[f.party[0].skills[0].id]},{styleId:'S2',stats:{},front:true}],{skills:f.skills,catalog:f.catalog});
  assert.deepEqual(p[0].skills.map(s=>s.label),['A1','RKayamoriCommandBuff']);
  const st=initialState(p,buildEnemy(f.event,f.stage),{});startTurn(st);
  const u=usableSkills(st,0);assert.ok(!u.includes(NORMAL));assert.ok(u.includes(1));
  assert.ok(usableSkills(st,1).includes(NORMAL));
  act(st,0,1);assert.ok(st.units[1].effects.some(e=>e.type==='attackUp'&&e.size===15&&e.includeNormal));
});
test('void element counts as all five elements: marks, transcendence count/charge, element conditions',()=>{
  const mark={label:'P.FM',name:'火の印',timing:'OnFirstBattleStart',parts:[{skillType:'FireMark',targetType:'AllyAll',power:[0.3,0],targetCondition:'IsNatureElement(Fire)',exit:{cond:'Eternal'}}]};
  const f=fixtureParty({dp:1e9,hp:1e9,passives:[mark]});
  f.party[0].transcend='fire';f.party[1].elements=['void'];      // 火 1 + 虚 1 → 视为火 2 人
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});st.units.forEach(u=>u.sp=30);
  assert.equal(st.trans.gauge,30);
  assert.deepEqual(st.units.map(u=>u.effects.find(e=>e.type==='mark')?.level??0),[2,2,0]);
  startTurn(st);act(st,1,NORMAL);assert.equal(st.trans.gauge,34,'void member charges the gauge');
  assert.equal(evaluateIn(st,1,'IsNatureElement(Ice)'),true);assert.equal(evaluateIn(st,2,'IsNatureElement(Fire)'),false);
  st.trans.gauge=96;act(st,1,NORMAL);
  assert.equal(st.trans.active,true);assert.equal(collectMods(st,1,{element:'nonelemental',physicalType:'slash'},{}).passiveAttackUp,300);
});
test('the action that fills the transcendence gauge does not get its effects; the next one does',()=>{
  const f=fixtureParty({dp:1e9,hp:1e9});f.party[0].transcend='fire';
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none',trace:true});st.units.forEach(u=>u.sp=30);startTurn(st);
  act(st,0,NORMAL);st.trans.gauge=96;act(st,0,NORMAL);act(st,0,NORMAL);
  const d=st.log.filter(l=>l.t==='act').map(l=>l.damage);
  assert.equal(d[1],d[0]);assert.equal(st.trans.active,true);assert.ok(near(d[2]/d[0],4,1e-3),'attack +300%');
});
test('support resonance, deck-listed passives, bracelet normal attack, DamageSp, [特性強化] supersedes the small version',()=>{
  const deckPassive={id:9101,label:'TTojoPassiveSkill01',name:'日蔭下的午休',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,
    passive:{timing:'OnBattleStart',parts:[],condition:'IsFront()'},parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[0.1,0]}]};
  const small={label:'P.S',name:'勢如破竹（小）',timing:'OnFirstBattleStart',parts:[{skillType:'AttackUp',targetType:'Self',power:[0.1,0],exit:{cond:'Eternal'}}]};
  const big={label:'P.B',name:'勢如破竹[特性強化]',timing:'OnFirstBattleStart',parts:[{skillType:'AttackUp',targetType:'Self',power:[0.25,0],exit:{cond:'Eternal'}}]};
  const f=fixtureParty({A:[atkSkill('A1',2,1000),deckPassive],passives:[small,big]});
  const stats={styles:{SUP:{resonance:'G1'}},supportSkills:{G1:[{lb:0,passive:{label:'Sup0',name:'R',timing:'OnEveryTurn',condition:'IsFront()',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[0.05,0]}]}},
    {lb:4,passive:{label:'Sup4',name:'R',timing:'OnEveryTurn',condition:'IsFront()',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[0.1,0]}]}}]}};
  const p=buildParty([{styleId:'S1',stats:{str:500,dex:500},front:true,deckSkillIds:[f.party[0].skills[0].id,9101],supportStyleId:'SUP',supportLimitBreak:4,
    equipment:{normalAttackUp:200,normalElement:'ice'}},{styleId:'S2',stats:{},front:true}],{skills:f.skills,catalog:f.catalog,stats});
  assert.deepEqual(p[0].passives.map(x=>x.name),['勢如破竹[特性強化]','日蔭下的午休','R']);
  const st=initialState(p,buildEnemy(f.event,f.stage),{critMode:'none'});
  assert.equal(st.od,10,'deck passive: battle start front OD +10');
  startTurn(st);assert.equal(st.od,20,'support LB4: turn start front OD +10');
  const m=collectMods(st,0,{element:'ice',physicalType:'slash'},{normal:true});
  assert.equal(m.passiveAttackUp,200);
  st.units[1].sp=10;
  const ds={label:'DS',name:'DS',level:1,maxLevel:1,parts:[]};
  // DamageSp 走 applyPart：经 firePassive 触发
  const surv={label:'SURV',name:'求生',timing:'OnEveryTurn',condition:'Sp()>=20',parts:[{skillType:'DamageSp',targetType:'Self',power:[3,0]},{skillType:'HealSp',targetType:'AllyAllWithoutSelf',power:[1,0]}]};
  st.ctx.party[1].passives.push(surv);st.units[1].sp=20;startTurn(st);
  assert.equal(st.units[1].sp,17,'SP ≥20: no regen, then −3');
});
test('DamageRateChangeAttackSkill with cond IsHitWeak() still attacks a neutral enemy',()=>{
  const sk={id:4242,label:'DRC',name:'DRC',sp:0,consume:'Sp',uses:-1,hitCount:3,maxLevel:1,
    parts:[{skillType:'DamageRateChangeAttackSkill',targetType:'All',power:[2000,4000],value:[8,1.2],attackType:'Slash',elements:['Fire'],diffForMax:100,parameters:{str:1},multipliers:{dp:1,hp:1,dr:1.8},cond:'IsHitWeak()'}]};
  const f=fixtureParty({dp:1e9,hp:1e9,A:[sk]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none',trace:true});startTurn(st);act(st,0,0);
  assert.ok(st.log.at(-1).damage>0);assert.ok(st.od>0);
});
test('mark Lv1/Lv3 only for skills of its element, Lv4/Lv5 for every attack; burst crit damage stacks with passives',()=>{
  const mark={label:'P.FM',name:'火の印',timing:'OnFirstBattleStart',parts:[{skillType:'FireMark',targetType:'AllyAll',power:[0.3,0],exit:{cond:'Eternal'}}]};
  const f=fixtureParty({passives:[mark]});f.party[1].elements=['fire'];f.party[2].elements=['fire'];
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});
  assert.equal(collectMods(st,0,{element:'fire',physicalType:'slash'},{}).passiveAttackUp,30);
  const ice=collectMods(st,0,{element:'ice',physicalType:'slash'},{});
  assert.equal(ice.passiveAttackUp,0);assert.equal(ice.passiveDamageRateUp,0);
  // Lv3 印：暴击率/暴伤 需要 Lv4/5，这里只有 3 人 → 用 Lv 检查替代
  assert.equal(ice.passiveCritRateUp,0);
  const g=fixtureParty({dp:1e9,hp:1e9});g.party[0].transcend='fire';
  const s2=initialState(g.party,buildEnemy(g.event,g.stage),{});s2.trans.active=true;
  s2.units[0].effects.push({type:'critDamageUp',size:30,passive:true,uses:null,turns:null});
  const m=collectMods(s2,0,{element:'fire',physicalType:'slash'},{});
  assert.equal(m.critDamageUp,100);assert.equal(m.passiveCritDamageUp,30,'passive crit damage still stacks');
  assert.equal(collectMods(s2,0,{element:'nonelemental',physicalType:'slash'},{}).passiveCritDamageUp,30);
});
test('無念無想: choosing 沉浸 (element) → next selection in 沉浸: skills 0 SP and take the element; reinforced EX ends it',()=>{
  const ex={id:51,label:'X51',name:'虚心',sp:13,consume:'Sp',uses:-1,hitCount:1,maxLevel:1,isEX:true,
    parts:[{skillType:'SkillCondition',cond:'IsReinforcedMode()',branches:[
      {parts:[{skillType:'AttackSkill',targetType:'Single',power:[2000,4000],attackType:'Stab',diffForMax:100,parameters:{str:1},multipliers:{dp:2,hp:1,dr:1}}]},
      {parts:[{skillType:'AttackSkill',targetType:'Single',power:[2000,4000],attackType:'Stab',diffForMax:100,parameters:{str:1},multipliers:{dp:1,hp:1,dr:1}}]}]}]};
  const f=fixtureParty({dp:1e9,hp:1e9,A:[atkSkill('A1',5,1000),ex]});
  f.skills.styles.S1.immersion=true;
  const p=buildParty([{styleId:'S1',stats:{str:500,dex:500},front:true},{styleId:'S2',stats:{},front:true}],{skills:f.skills,catalog:f.catalog});
  const imm=p[0].skills.findIndex(s=>s.label==='Immersion:light');assert.ok(imm>=0);
  const st=initialState(p,buildEnemy(f.event,f.stage),{critMode:'none',trace:true});st.units[0].sp=20;startTurn(st);
  act(st,0,imm);assert.equal(st.units[0].immPending,'light');assert.ok(!usableSkills(st,0).includes(imm));
  endPlayerTurn(st);startTurn(st);
  assert.equal(st.units[0].reinforced,'light');const sp=st.units[0].sp;
  act(st,0,0);assert.equal(st.units[0].sp,sp,'0 SP in 沉浸');assert.equal(st.units[0].reinforced,'light');
  act(st,0,1);assert.equal(st.units[0].sp,sp);assert.equal(st.units[0].reinforced,null,'reinforced EX ends 沉浸');
});
test('normal attack hits by weapon (with character exceptions); follow-up expected OD only when a rate is given',()=>{
  const f=fixtureParty({dp:1e9,hp:1e9,A:[atkSkill('A1',0,1000)]});
  Object.assign(f.skills.styles.S1,{weapon:'Shield',followUpHits:3});Object.assign(f.skills.styles.S2,{weapon:'Gun',followUpHits:1});Object.assign(f.skills.styles.S3,{weapon:'Sword',followUpHits:4});
  const p=buildParty([{styleId:'S1',stats:{},front:true},{styleId:'S2',stats:{},front:true},{styleId:'S3',stats:{},front:false}],{skills:f.skills,catalog:f.catalog});
  assert.deepEqual(p.map(x=>normalAttackModel(x).hitCount),[1,3,3]);
  const a=initialState(p,buildEnemy(f.event,f.stage),{});startTurn(a);a.units.forEach(u=>u.sp=30);act(a,0,0);
  const b=initialState(p,buildEnemy(f.event,f.stage),{followUpRate:0.5});startTurn(b);b.units.forEach(u=>u.sp=30);act(b,0,0);
  assert.ok(near(b.od-a.od,0.5*4*2.5),'one back member with 4 follow-up hits, 50%');
});
import {exAttenuation,capAttack} from '../public/sim/hbr/damage.mjs';
test('damage caps: 1e9 soft cap and EX-score attenuation (HBR Toolbox)',()=>{
  assert.equal(capAttack(5e8),5e8);
  assert.ok(near(capAttack(2e9),1e9*(2-Math.exp(0.7*(1-2)))));
  assert.equal(exAttenuation(9e6),9e6);
  assert.ok(near(exAttenuation(2e7),1e7+4434e5*Math.log(1+0.02046)));
});
test('all-target attacks gain OD per enemy hit',()=>{
  const all=atkSkill('AOE',0,1000);all.parts[0].targetType='All';
  const f=fixtureParty({dp:1e9,hp:1e9,A:[all]});
  const one=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(one);act(one,0,0);
  const E3={...buildEnemy(f.event,f.stage),others:2};
  const three=initialState(f.party,E3,{});startTurn(three);act(three,0,0);
  assert.ok(near(three.od,one.od*3));
});
test('passive skill count +1, OD cost reduction, token-consuming parts, SpecifySp next turn',()=>{
  const cu={label:'P.CU',name:'協心',timing:'OnFirstBattleStart',parts:[{skillType:'SkillLimitCountUp',targetType:'AllyAll',power:[1,0],exit:{cond:'Eternal'}}]};
  const rc={label:'P.RC',name:'偽裝術',timing:'OnFirstBattleStart',parts:[{skillType:'ReduceConsumeOverDrive',targetType:'Self',power:[0.15,0],exit:{cond:'Eternal'}}]};
  const lim=atkSkill('LIM',0,1000,{uses:1});
  const tok={id:88,label:'TOK',name:'TOK',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[
    {skillType:'AttackUpByToken',targetType:'AllyAll',power:[0.25,0.25],exit:{cond:'Eternal'}},{skillType:'HealSpByToken',targetType:'AllyAll',power:[1,0],value:[30,0]},
    {skillType:'OverDrivePointUpByToken',targetType:'Self',power:[0.1,0]}]};
  const spec={id:89,label:'SPEC',name:'SPEC',sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,parts:[{skillType:'SpecifySp',targetType:'AllyAllWithoutSelf',power:[10,0]}]};
  const f=fixtureParty({dp:1e9,hp:1e9,A:[lim,tok,spec],passives:[cu,rc]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);st.units.forEach(u=>u.sp=0);
  act(st,0,0);assert.ok(usableSkills(st,0).includes(0),'uses 1 + 1');act(st,0,0);assert.ok(!usableSkills(st,0).includes(0));
  st.units[0].tokens=4;const od=st.od;act(st,0,1);
  assert.equal(st.units[0].tokens,0);assert.ok(st.units[1].effects.some(e=>e.type==='attackUp'&&e.size===100));assert.equal(st.units[1].sp,4);assert.ok(st.od-od>=40);
  act(st,0,2);st.units[1].sp=1;endPlayerTurn(st);startTurn(st);assert.equal(st.units[1].sp,10);
  st.od=90;assert.equal(startOverdrive(st,1,'turnStart'),true,'OD1 costs 85 with −15%');assert.ok(near(st.od,5));
});

// ---------------------------------------------------------------- 2026-11 特殊机制
const utilitySkill=(label,parts,extra={})=>({id:700000+label.length*97,label,name:label,sp:0,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,restricted:false,parts,...extra});
const eternal={cond:'Eternal',value:[0,0]};

test('specials: skill overwrite, territory overwriteCond and sourced OverwriteSp change the real cost',()=>{
  const cold=atkSkill('COLD',11,1000,{overwrite:8,overwriteCond:'IsTerritory(SummersEndTerritory)==1'});
  const ow={label:'P.OW',name:'覆写',timing:'OnEveryTurn',skillLabel:'COLD',parts:[{skillType:'OverwriteSp',targetType:'Self',power:[5,0],exit:{cond:'PlayerTurnEnd',value:[1,0]}}]};
  const f=fixtureParty({A:[cold],passives:[ow]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);
  assert.equal(effectiveCost(st,0,st.ctx.party[0].skills[0]),5,'被动定点覆写优先');
  st.units[0].effects=st.units[0].effects.filter(e=>e.type!=='overwriteSp');
  assert.equal(effectiveCost(st,0,st.ctx.party[0].skills[0]),11);
  st.territory={name:'SummersEndTerritory',active:false};
  assert.equal(effectiveCost(st,0,st.ctx.party[0].skills[0]),8,'冷奏类通用 overwriteCond');
  st.units[0].sp=8;act(st,0,0);assert.equal(st.units[0].sp,0);
});

test('specials: EP is a separate resource, HealEp caps at 10 and OD EpLimitOverwrite raises it to 20',()=>{
  const ep=atkSkill('EP',7,1000,{consume:'Ep'});
  const heal=utilitySkill('HEP',[{skillType:'HealEp',targetType:'Self',power:[5,0]}]);
  const odP={label:'P.EPL',name:'超载',timing:'OnOverdriveStart',parts:[
    {skillType:'EpLimitOverwrite',targetType:'Self',power:[20,0],exit:{cond:'OverDriveEnd',value:[1,0]}},
    {skillType:'HealEp',targetType:'Self',power:[5,0]}]};
  const f=fixtureParty({A:[ep,heal],passives:[odP]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{conquestBikeLevel:80});
  assert.ok(!usableSkills(st,0).includes(0),'0 EP 不能施放 EP 技能');
  const sp=st.units[0].sp;act(st,0,1);assert.equal(st.units[0].ep,5);assert.equal(st.units[0].sp,sp);
  st.units[0].ep=7;assert.ok(usableSkills(st,0).includes(0));act(st,0,0);
  assert.equal(st.units[0].ep,0);assert.equal(st.units[0].sp,sp,'扣 EP 不扣 SP');
  assert.equal(evaluateIn(st,0,'ConquestBikeLevel()>=80'),true);
  st.od=100;assert.equal(startOverdrive(st,1,'turnStart'),true);assert.equal(st.units[0].ep,5);
  st.units[0].ep=18;act(st,0,1);assert.equal(st.units[0].ep,20,'OD 上限 20');
  endOdRound(st);assert.equal(st.units[0].ep,10,'OD 结束恢复上限 10');
});

test('specials: Shredding permits skills at nonnegative SP and allows the balance to go negative',()=>{
  const shred=utilitySkill('SHRED',[{skillType:'Shredding',targetType:'AllyAll',power:[0,0],exit:{cond:'PlayerTurnEnd',value:[3,0]}}]);
  const f=fixtureParty({A:[atkSkill('A1',5,1000),shred]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);st.units[0].sp=3;
  assert.ok(!usableSkills(st,0).includes(0));act(st,0,1);
  assert.ok(usableSkills(st,0).includes(0));act(st,0,0);assert.equal(st.units[0].sp,-2);
  startTurn(st);assert.equal(st.units[0].sp,0);
});

test('specials: infantilization adds attack damage, EX raises 2 and an active DP heal raises 1; DP heal grants tokens',()=>{
  const babyP={label:'P.BABY',name:'母性',timing:'OnBattleStart',parts:[{skillType:'Infantilized',targetType:'All',power:[2,0],exit:eternal}]};
  const tokenP={label:'P.TOKDP',name:'祝福',timing:'OnFirstBattleStart',parts:[{skillType:'TokenSetByHealedDp',targetType:'Self',power:[1,0],exit:eternal}]};
  const ex=utilitySkill('BABYEX',[{skillType:'Infantilized',targetType:'All',power:[2,0],exit:eternal}]);
  const heal=utilitySkill('DPH',[{skillType:'HealDp',targetType:'AllyAll',power:[800,0]}]);
  const f=fixtureParty({A:[ex,heal],passives:[babyP,tokenP]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);
  const baby=()=>st.enemy.effects.find(e=>e.status==='Infantilized');
  assert.equal(baby().level,2);assert.equal(collectModsFor(st,0).babied,6);
  act(st,0,0);assert.equal(baby().level,4);assert.equal(collectModsFor(st,0).babied,12);
  act(st,0,1);assert.equal(baby().level,5);assert.equal(st.units[0].tokens,1);
  baby().level=20;assert.equal(collectModsFor(st,0).babied,90,'Lv20：3%×20 + 30%');
});

test('specials: venom starts next turn, deals fixed damage and accumulates all-stat down with Disaster',()=>{
  const venom=utilitySkill('VENOM',[
    {skillType:'Disaster',targetType:'Single',power:[2,0],exit:eternal},
    {skillType:'Venom',targetType:'Single',power:[2,0],exit:{cond:'EnemyTurnEnd',value:[10,0]}}]);
  const f=fixtureParty({dp:0,hp:1e9,A:[venom]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);act(st,0,0);
  assert.equal(st.totalDamage,0,'施加当回合不立即跳毒');
  startTurn(st);assert.equal(st.totalDamage,375000);assert.equal(collectModsFor(st,0).misfortune,18,'祸 14 + 猛毒累计 4');
  startTurn(st);assert.equal(st.totalDamage,750000);assert.equal(collectModsFor(st,0).misfortune,22);
  assert.equal(st.od,0,'DoT 不增加 OD');
});

test('specials: inscription stores actual damage only, release is hard-capped at 2 billion and clears the mark',()=>{
  const mark={label:'P.INS',name:'刻印',timing:'OnBattleStart',parts:[{skillType:'Inscription',targetType:'All',power:[0,0],exit:eternal}]};
  const release=utilitySkill('RELEASE',[{skillType:'InscriptionAttack',targetType:'Single',power:[0,0]}],{
    hitCount:8,cond:'CountBC(IsPlayer()==0&&SpecialStatusCountByType(223)>0)>0',
    hits:Array.from({length:8},(_,i)=>({type:'Main',ratio:i===7?0.65:0.05}))});
  const f=fixtureParty({dp:0,hp:1e12,A:[atkSkill('A1',0,1000),release],passives:[mark]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none',statusTypes:{223:'Inscription'}});startTurn(st);
  assert.ok(usableSkills(st,0).includes(1),'刻印在场时满足引爆条件');
  act(st,0,0);const inscribed=st.enemy.effects.find(e=>e.status==='Inscription');
  assert.equal(inscribed.damage,st.totalDamage,'只累计实际 DP／HP 伤害');
  assert.ok(usableSkills(st,0).includes(1));
  inscribed.damage=3e9;const before=st.totalDamage,info=act(st,0,1);
  assert.equal(info.inscriptionReleased,2e9);assert.equal(st.totalDamage-before,2e9);
  assert.ok(!st.enemy.effects.some(e=>e.status==='Inscription'));
  assert.ok(!usableSkills(st,0).includes(1),'引爆后技能条件失效');
});

test('specials: Byakko assault doubles attack damage and OD but pays SP and use count once',()=>{
  const p={label:'P.BYAKKO',name:'猛袭',timing:'OnPlayerTurnStart',condition:'DpRate()>=1.0',parts:[{skillType:'ByakkoDoubleActionAttackSkill',targetType:'Self',power:[0,0],exit:{cond:'PlayerTurnEnd',value:[1,0]}}]};
  const one=fixtureParty({dp:1e9,hp:1e9,A:[atkSkill('A1',5,1000)]});
  const two=fixtureParty({dp:1e9,hp:1e9,A:[atkSkill('A1',5,1000)],passives:[p]});
  const a=initialState(one.party,buildEnemy(one.event,one.stage),{critMode:'none'}),b=initialState(two.party,buildEnemy(two.event,two.stage),{critMode:'none'});
  for(const st of [a,b]){st.units[0].sp=20;startTurn(st);act(st,0,0);}
  assert.ok(near(b.totalDamage,2*a.totalDamage));assert.ok(near(b.od,2*a.od));
  assert.equal(b.units[0].sp,a.units[0].sp);assert.equal(b.units[0].uses.A1,1);
});

test('specials: ReplaceNormalSkill uses the branch attack model while retaining normal-attack OD',()=>{
  const branch={id:1,label:'LIGHTNORMAL',name:'曙光',sp:0,consume:'Sp',uses:-1,hitCount:1,maxLevel:1,parts:[{
    skillType:'AttackSkill',targetType:'All',power:[750,1500],attackType:'Strike',elements:['Light'],diffForMax:117,parameters:{str:1,dex:1},multipliers:{dp:1,hp:1,dr:1}}]};
  const repl=utilitySkill('REPL',[{skillType:'ReplaceNormalSkill',targetType:'Self',power:[0,0],exit:eternal,branches:[branch]}],{passive:{timing:'OnFirstBattleStart',parts:[]}});
  const f=fixtureParty({dp:1e9,hp:1e9,A:[repl]}),plain=fixtureParty({dp:1e9,hp:1e9,A:[]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none'}),base=initialState(plain.party,buildEnemy(plain.event,plain.stage),{critMode:'none'});
  startTurn(st);startTurn(base);act(st,0,NORMAL);act(base,0,NORMAL);
  assert.ok(st.totalDamage>0);assert.notEqual(st.totalDamage,base.totalDamage);
  assert.equal(st.od,7.5);assert.equal(base.od,7.5);
});

test('specials: ReplacePursuit executes the equipped back-row skill once, with its attack and front buffs',()=>{
  const make=(equipped=true,back=true)=>{
    const pursuit=atkSkill('PURSUIT',0,1800,{hitCount:5,restricted:true,cond:'IsFront()==0'});
    pursuit.parts.push({skillType:'AttackUp',targetType:'AllyFront',power:[1.3,0],elements:['Dark'],hits:[{type:'Before',ratio:0}],exit:{cond:'PlayerTurnEnd',value:[3,0]},limitType:'Only'});
    const passive={label:'P.PURSUIT',name:'温泉手形',timing:'OnFirstBattleStart',parts:[{skillType:'ReplacePursuit',targetType:'Self',power:[0,0],cond:'HasSkill(PURSUIT)==1',exit:eternal,branches:[pursuit]}]};
    const f=fixtureParty({dp:1e9,hp:1e9,A:[atkSkill('A1',0,1000)]});
    if(equipped)f.party[1].skills.push(pursuit);f.party[1].passives.push(passive);
    const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none',followUpRate:1});st.units[1].front=!back;startTurn(st);
    return st;
  };
  const st=make(),info=act(st,0,0);
  assert.ok(info.followUpDamage>0);assert.ok(st.totalDamage>info.damage);
  assert.ok(st.units[0].effects.some(e=>e.type==='elementAttackUp'&&e.element==='dark'&&e.size===130));
  assert.equal(st.units[1].sp,3,'追击不扣 SP');assert.equal(st.units[1].uses.PURSUIT,undefined,'追击不扣技能次数');
  const missing=make(false),mi=act(missing,0,0);assert.equal(mi.followUpDamage,undefined);assert.equal(missing.totalDamage,mi.damage);
  const front=make(true,false),fi=act(front,0,0);assert.equal(fi.followUpDamage,undefined,'前排不满足替换追击分支');
});

test('specials: RemoveDebuffCount is recorded only after actual removals and gates later parts',()=>{
  const cleanse=utilitySkill('CLEANSE',[
    {skillType:'RemoveDebuff',targetType:'AllyAll',power:[3,0],hits:[{type:'Before',ratio:0}]},
    {skillType:'MindEye',targetType:'AllyAll',power:[0.42,0],hitCondition:'RemoveDebuffCount()>0',hits:[{type:'After',ratio:0}],exit:{cond:'Count',value:[1,0]}},
    {skillType:'AttackUp',targetType:'AllyAll',power:[0.75,0],hitCondition:'RemoveDebuffCount()>0',hits:[{type:'After',ratio:0}],exit:{cond:'Count',value:[1,0]}}]);
  const f=fixtureParty({A:[cleanse]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);
  st.units[0].effects.push({type:'defenseDown',size:30,turns:2});st.units[1].effects.push({type:'attackUp',size:10,turns:2});
  const info=act(st,0,0);assert.equal(info.removeDebuffCount,1);
  assert.ok(st.units[2].effects.some(e=>e.type==='mindsEye'));assert.ok(st.units[1].effects.some(e=>e.type==='attackUp'&&e.size===10),'增益不被误删');
  const empty=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(empty);const no=act(empty,0,0);
  assert.equal(no.removeDebuffCount,undefined);assert.ok(!empty.units[0].effects.some(e=>e.type==='mindsEye'||e.type==='attackUp'));
});

test('specials: SummersEnd territory switches to activation, reduces 冷奏 and grants 残響 only once',()=>{
  const cold=atkSkill('COLD',11,1000,{overwrite:8,overwriteCond:'IsTerritory(SummersEndTerritory)==1'});
  const field=utilitySkill('SUMMER',[
    {skillType:'SummersEndTerritory',targetType:'Field',power:[0,0]},
    {skillType:'AttackUpRangeByAllDamageRate',targetType:'AllyAll',power:[0,0]}]);
  const residual={label:'Passive.SummersEndTerritory_AdditionalTurn01',name:'残響',timing:'OnFirstBattleStart',condition:'AdditionalHitCount(Passive.SummersEndTerritory_AdditionalTurn01)==0',parts:[
    {skillType:'AdditionalHitOnSpecifiedSkill',targetType:'Self',power:[0,0],cond:'IsTerritory(SummersEndTerritory)==1 && SpecialStatusCountByType(20)==0 && AdditionalHitCount(Passive.SummersEndTerritory_AdditionalTurn01)==0',branches:[cold]},
    {skillType:'AdditionalTurn',targetType:'Self',power:[1,0]}]};
  const f=fixtureParty({A:[field,cold],passives:[residual]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none'});startTurn(st);
  act(st,0,0);assert.equal(st.territory.active,false);assert.ok(!st.units[0].effects.some(e=>e.type==='summerAttack'));
  const sp=st.units.map(u=>u.sp);startTurn(st);assert.deepEqual(st.units.map(u=>u.sp),sp.map(x=>x+3),'普通回复 2 + 晚夏 1');
  act(st,0,0);assert.equal(st.territory.active,true);assert.equal(st.units[0].effects.find(e=>e.type==='summerAttack').size,50);
  assert.equal(effectiveCost(st,0,st.ctx.party[0].skills[1]),8);
  act(st,0,1);assert.equal(st.units[0].extra,1);assert.equal(st.passiveCount[residual.label+':0'],1);
  act(st,0,1);assert.equal(st.passiveCount[residual.label+':0'],1,'同一次出击最多一次');
  startExtraTurn(st);act(st,0,1);assert.equal(st.passiveCount[residual.label+':0'],1,'追加回合内不重复赋予');
});

test('six real cuisine states stack by dish and restore DP from damage actually dealt',()=>{
  const db=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url),'utf8'));
  const types=['Steak','Tea','Curry','Shchi','Gelato','DimSum'];
  const parts=Object.values(db.styles).flatMap(s=>s.skills.flatMap(k=>k.parts));
  const dishes=types.map(t=>utilitySkill(t,[parts.find(p=>p.skillType===t)]));
  const attack=atkSkill('TEST-ATTACK',0,1000),f=fixtureParty({A:[attack,...dishes],dp:0,hp:1000});
  f.party[0].dpMax=10000;
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);
  for(let i=1;i<=dishes.length;i++)act(st,0,i);
  act(st,0,1);
  assert.equal(collectModsFor(st,0).passiveAttackUp,300);
  assert.equal(collectMods(st,0,{element:'nonelemental',physicalType:'slash'},{normal:true}).passiveAttackUp,0);
  st.units[0].dp=100;
  const hit=act(st,0,0);
  assert.ok(hit.damage>0);assert.ok(Math.abs(st.units[0].dp-(100+0.6*hit.damage))<1e-5);
});

test('Kanade drains her own DP from her hit, and lower recovery caps preserve an existing surplus',()=>{
  const db=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url),'utf8'));
  const skill=db.styles.AliceA04.skills.find(s=>s.label==='AliceASkill04');
  const f=fixtureParty({A:[skill],dp:0,hp:500,initialSp:20});
  f.party[0].dpMax=2000;
  for(const start of [500,2200]){
    const st=initialState(f.party,buildEnemy(f.event,f.stage),{});startTurn(st);st.units[0].dp=start;
    const {damage}=act(st,0,0);assert.ok(damage>0);
    assert.equal(st.units[0].dp,start>2000?start:start+damage*0.3);
  }
});

test('the summer formation heals front and back up to 120 percent on normal turn starts',()=>{
  const f=fixtureParty();for(const m of f.party)m.dpMax=1000;
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});
  st.territory={name:'SummersEndTerritory',active:false};st.units[1].front=false;
  st.units[0].dp=1180;st.units[1].dp=900;st.units[2].dp=0;st.units[2].dpBroken=true;
  startTurn(st);assert.deepEqual(st.units.map(u=>u.dp),[1200,970,0]);
});

test('specials: clone and state key preserve EP, inscription, territory and passive trigger counts',()=>{
  const f=fixtureParty({A:[atkSkill('A1',0,1000)]});const st=initialState(f.party,buildEnemy(f.event,f.stage),{});
  st.territory={name:'SummersEndTerritory',active:false};const copy=cloneState(st);copy.territory.active=true;
  assert.equal(st.territory.active,false,'领域对象深拷贝');assert.notEqual(stateKey(st),stateKey(copy));
  const mutations=[s=>s.units[0].ep=1,s=>s.passiveCount['P:0']=1,s=>s.enemy.effects.push({type:'status',status:'Inscription',damage:123}),s=>s.enemy.effects.push({type:'status',status:'Infantilized',level:2})];
  for(const mutate of mutations){const c=cloneState(st);mutate(c);assert.notEqual(stateKey(st),stateKey(c));}
});

test('specials: real master-data cards execute overwrite, EP, statuses, double action and pursuit end to end',()=>{
  const skills=JSON.parse(fs.readFileSync(new URL('../public/data/skills.json',import.meta.url),'utf8'));
  const catalog=JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json',import.meta.url),'utf8'));
  const env=fixtureParty({dp:1e9,hp:1e9});
  const real=(ids,opt={})=>{
    const party=buildParty(ids.map((styleId,i)=>({styleId,stats:{str:500,dex:500,con:500,wis:500,spr:500,luk:500},front:i===0,limitBreak:4})),{skills,catalog});
    return initialState(party,buildEnemy(env.event,env.stage),{critMode:'none',statusTypes:skills.statusTypes,...opt});
  };
  const im=real(['IMinase07']),imk=im.ctx.party[0].skills.findIndex(s=>s.label==='IMinaseSkill54');
  assert.equal(effectiveCost(im,0,im.ctx.party[0].skills[imk]),8,'速攻◯：16→8，来源是被动技能也能推断唯一 EX');
  const ma=real(['MAikawa06']);ma.field={element:'fire',size:50,owner:0};startTurn(ma);
  const mak=ma.ctx.party[0].skills.findIndex(s=>s.label==='MAikawaSkill53');assert.equal(effectiveCost(ma,0,ma.ctx.party[0].skills[mak]),10,'火领域神樂舞：15→10');
  const ms=real(['MSatsuki09']);ms.enemy.effects.push({type:'defenseDown',size:30,turns:2});startTurn(ms);
  const msk=ms.ctx.party[0].skills.findIndex(s=>s.label==='MSatsukiSkill56');assert.equal(effectiveCost(ms,0,ms.ctx.party[0].skills[msk]),0,'防御下降在场时打针 0 SP');
  const nn=real(['NNanase03']);assert.equal(nn.units[0].ep,5,'三凸开场 EP+5');startTurn(nn);nn.units[0].ep=7;
  const nnk=nn.ctx.party[0].skills.findIndex(s=>s.label==='NNanaseSkill51');assert.ok(usableSkills(nn,0).includes(nnk));act(nn,0,nnk);
  assert.equal(nn.units[0].ep,0);assert.ok(nn.units[0].sp>0);
  const baby=real(['RMurohushi08']);assert.equal(baby.enemy.effects.find(e=>e.status==='Infantilized').level,2,'开场幼儿回归 Lv2');
  const ins=real(['KAsakura10']);startTurn(ins);assert.ok(ins.enemy.effects.some(e=>e.status==='Inscription'),'回合开始赋予刻印');
  const by=real(['Byakko06']);by.units[0].sp=20;startTurn(by);
  const byk=by.ctx.party[0].skills.findIndex(s=>s.label==='ByakkoSkill06');act(by,0,byk);
  assert.equal(by.units[0].uses.ByakkoSkill06,1);assert.equal(by.od,15,'白虎 3 hit 双发 = 6 hit OD');
  const sh=real(['SHanamura06']);startTurn(sh);
  const sf=sh.ctx.party[0].skills.findIndex(s=>s.label==='SHanamuraSkill53'),sc=sh.ctx.party[0].skills.findIndex(s=>s.label==='SHanamuraSkill07');
  act(sh,0,sf);assert.equal(sh.territory.active,false);act(sh,0,sf);assert.equal(sh.territory.active,true);
  assert.equal(effectiveCost(sh,0,sh.ctx.party[0].skills[sc]),8);sh.units[0].sp=20;act(sh,0,sc);assert.equal(sh.units[0].extra,1,'真实残響被动');
  const yo=real(['Byakko06','YoOhshima05'],{followUpRate:1});yo.units[0].sp=20;startTurn(yo);
  const yk=yo.ctx.party[0].skills.findIndex(s=>s.label==='ByakkoSkill06'),yi=act(yo,0,yk);
  assert.ok(yi.followUpDamage>0,'四叶后卫特殊追击');assert.equal(yo.units[1].uses.YoOhshimaSkill53,undefined);
});
test('ally DP/HP: enemy attack formula, defense up until enemy turn end, heal, down and wipe',()=>{
  const f=fixtureParty({dp:1e9,hp:1e9});
  f.event.enemies.E.skills=[{id:1,name:'敌技',parts:[{skillType:'AttackSkill',targetType:'All',power:[300,1800],parameters:{con:2,spr:1},diffForMax:600}]}];
  const p=buildParty([{styleId:'S1',stats:{con:300,spr:300},front:true,vitals:{dp:1000,hp:500}},{styleId:'S2',stats:{con:300,spr:300},front:true,vitals:{dp:1000,hp:500}},
    {styleId:'S3',stats:{con:300,spr:300},front:true,vitals:{dp:1000,hp:500}}],{skills:f.skills,catalog:f.catalog});
  const st=initialState(p,{...buildEnemy(f.event,f.stage),border:400},{enemyVariance:1});
  assert.equal(st.units[0].dp,1000);
  startTurn(st);
  // 能力差 400−300=100 → 300+1500×100/600 = 550
  st.units[1].effects.push({type:'defenseUp',size:40,enemyEnd:true,uses:null,turns:1,currentOnly:false});
  endPlayerTurn(st);
  assert.ok(near(st.units[0].dp,450));assert.ok(near(st.units[1].dp,1000-330),'defense up 40% survives our turn end');
  assert.ok(!st.units[1].effects.some(e=>e.type==='defenseUp'),'expires after enemy turn');
  startTurn(st);endPlayerTurn(st);
  assert.equal(st.units[0].dp,0);assert.equal(st.units[0].hp,500);assert.equal(st.units[0].dpBroken,true);
  assert.ok(usableSkills(st,0).length>0,'DP 0 (倒下) can still act');
  startTurn(st);endPlayerTurn(st);startTurn(st);endPlayerTurn(st);
  assert.equal(st.units[0].down,true);assert.deepEqual(usableSkills(st,0),[]);
  assert.ok(st.wiped>0,'any member at 0 HP = battle lost');
});
import {waveDamageScore,waveDifficultyScore,waveRoundScore,waveScore} from '../public/boss-model.mjs';
test('incoming hits stop at the broken DP, then consume HP using published ratios and explicit fallbacks',()=>{
  const publicSkill=(file,label)=>{
    const event=JSON.parse(fs.readFileSync(new URL('../public/data/bosses/'+file,import.meta.url)));
    return Object.values(event.enemies).flatMap(e=>e.skills).find(s=>s.label===label);
  };
  function take(skill,dp=150,hp=1000,{defense=false}={}){
    const {party,event,stage}=fixtureParty({dp:10000,hp:10000});
    party.forEach((p,i)=>{p.dpMax=1000;p.hpMax=hp;p.front=i===0;});
    event.enemies.E.skills=[{...skill,id:1}];
    const st=initialState(party,buildEnemy(event,stage),{trace:true,enemyVariance:1});
    startTurn(st);st.units[0].dp=dp;
    if(defense)st.units[0].effects.push({type:'defenseUp',size:50,uses:2,hitUses:true});
    endPlayerTurn(st);
    return {unit:st.units[0],log:st.log,approx:Object.keys(st.flags.approx).join(' ')};
  }
  const fixed=publicSkill('sa/scoreAttack99.json','ThorHammer2nd_scoreattack99_AttackSingle01');
  assert.equal(fixed.hitCount,1);assert.deepEqual(fixed.parts[0].power,[99999,0]);
  let r=take(fixed,1,100);
  assert.equal(r.unit.dp,0);assert.equal(r.unit.hp,100);assert.equal(r.unit.down,false);
  assert.equal(r.log.find(e=>e.t==='hurt').hpLost,0);
  assert.ok(take(fixed,0,100).unit.down);

  const ray=publicSkill('wave/WaveBattle0008.json','GiraffeHalo_AttackAll02_Thunder_waveBattle_08');
  assert.deepEqual(ray.hitRatios,[0.1,0.1,0.1,0.1,0.6]);
  const attack={...ray,parts:[{...ray.parts[0],power:[1000,1000],diffForMax:0}]};
  r=take(attack);
  assert.equal(r.unit.dp,0);assert.ok(near(r.unit.hp,200));
  assert.equal(r.log.filter(e=>e.t==='dpBreak').length,1);assert.doesNotMatch(r.approx,/均分/);
  r=take(attack,150,1000,{defense:true});
  assert.equal(r.unit.effects.find(e=>e.hitUses).uses,1);assert.ok(near(r.unit.hp,650));

  r=take({...attack,hitRatios:[]}); // 5×200，每段单独结算
  assert.ok(near(r.unit.hp,200));assert.match(r.approx,/均分/);
  r=take({...attack,hitRatios:[]},250);assert.ok(near(r.unit.hp,400));
  assert.ok(near(take(attack,250).unit.hp,300));
  r=take({...attack,hitRatios:[],hitCount:undefined},1);
  assert.equal(r.unit.hp,1000);assert.match(r.approx,/暂按单段/);
});
test('encounter (wave) score matches the community sheet example',()=>{
  // 遭遇战出分计算.xlsx 示例：12.75/18.25/19.75/39.25/60 亿，回合分 32805、难度分 65000、×1.3
  const dm=[1275000000,1825000000,1975000000,3925000000,6000000000];
  assert.deepEqual(dm.map(waveDamageScore),[4474,4485,4488,4527,4568]);
  assert.equal(waveDifficultyScore(40),65000);
  assert.equal(waveRoundScore(7,40,true),32805);
  assert.equal(waveDamageScore(1e7),2000);assert.equal(waveDamageScore(25e6),3200);assert.equal(waveDamageScore(1e8),4450);
  const s=waveScore({damages:dm,turns:7,difficulty:40,rules:[{grade:30}]});
  assert.equal(s.total,Math.trunc((s.damageScore+32805+65000)*1.3));
});
import {simulateDesign,emptyTurn,designFromPlan} from '../public/sim/designer.mjs';
test('designer: one action per member per round, multi-enemy phases cleared in order, state carries across phases',()=>{
  const f=fixtureParty({dp:0,hp:3000,A:[atkSkill('A1',4,1000)],initialSp:10});
  const base=buildEnemy(f.event,f.stage);
  const mk=(name,hp)=>({...base,name,hp,maxHp:hp,dp:[],others:0});
  const des={phases:[{turns:[{...emptyTurn(),front:[0,1,2],actions:[{u:0,s:'A1'},{u:0,s:'A1'},{u:1,s:'normal'}]},
    {...emptyTurn(),actions:[{u:0,s:'A1'},{u:1,s:'normal'},{u:2,s:'normal'}]},{...emptyTurn(),actions:[{u:0,s:'A1'},{u:1,s:'normal'},{u:2,s:'normal'}]}]},
    {turns:[{...emptyTurn(),actions:[{u:0,s:'A1'}]}]}]};
  const res=simulateDesign({party:f.party,phases:[{enemies:[mk('小',1500),mk('小2',1500)]},{enemies:[mk('大',1e9)]}],statusTypes:{}},{critMode:'none'},des);
  assert.ok(res.issues.some(i=>/本轮已经行动过/.test(i.msg)));
  assert.ok(res.rows.some(r=>r.kind==='kill'&&r.label.includes('小2')),JSON.stringify(res.issues));
  assert.equal(res.phases[0].cleared,true);
  const p2=res.rows.find(r=>r.kind==='turn'&&r.phase===1);assert.ok(p2.od>0,'OD carried into phase 2');
});
test('encounter tactical cards apply at the next phase; enemy OD rate halves hit OD',()=>{
  const f=fixtureParty({dp:0,hp:3000,A:[atkSkill('A1',4,1000)],initialSp:10});
  const base=buildEnemy(f.event,f.stage);
  const mk=(name,hp,extra={})=>({...base,name,hp,maxHp:hp,dp:[],others:0,...extra});
  const des={phases:[{turns:[{...emptyTurn(),front:[0,1,2],actions:[{u:0,s:'A1'}]}]},{card:'sp5',turns:[emptyTurn()]}]};
  const res=simulateDesign({party:f.party,phases:[{enemies:[mk('小',100)]},{enemies:[mk('大',1e9,{border:500})]}],statusTypes:{}},{critMode:'none'},des);
  const card=res.rows.find(r=>r.kind==='card');assert.ok(card&&/SP\+5/.test(card.label));
  const before=res.rows.filter(r=>r.kind==='act').at(-1).sp[1];assert.equal(card.sp[1],before+5);
  const a=initialState(f.party,{...base,odRate:1},{});startTurn(a);act(a,0,0);
  const b=initialState(f.party,{...base,odRate:0.5},{});startTurn(b);act(b,0,0);
  assert.ok(near(b.od,a.od/2,0.05),`${a.od} vs ${b.od}`);
});
import {monteCarlo} from '../public/sim/designer.mjs';
test('monte carlo: seeded, extends unfinished phases by repeating the last turn, reports success and on-plan rate',()=>{
  const f=fixtureParty({dp:0,hp:3000,A:[atkSkill('A1',0,1000)]});
  const base=buildEnemy(f.event,f.stage);
  const enemy={...base,name:'敌',hp:5000,maxHp:5000,dp:[],others:0};
  const des={phases:[{turns:[{...emptyTurn(),front:[0,1,2],actions:[{u:0,s:'A1'}]}]}]};
  const ctx={party:f.party,phases:[{enemies:[enemy]}],statusTypes:{}};
  const a=monteCarlo(ctx,{},des,{n:20,seed:3}),b=monteCarlo(ctx,{},des,{n:20,seed:3});
  assert.deepEqual(a,b,'same seed → same result');
  assert.ok(a.success>=a.onPlan);
  const strict=monteCarlo(ctx,{extendTurns:0},des,{n:20,seed:3});
  assert.ok(strict.success<=a.success);
});

// ---------------------------------------------------------------- 2026-11-09 技能格上限、#08 战术卡、显示伤害
import {skillSlotCap} from '../public/sim/hbr/deck.mjs';
import {CARDS,applyCard,relevantCards,encounterCardSets} from '../public/sim/cards.mjs';
import {cardSeenProb} from '../public/sim/optimizer.mjs';
test('skill slot cap: 3 + reincarnation 1/5/10/20 + bloom + title rank 10 + admiral',()=>{
  const raw=(re,daphne,exp)=>({character:{reincarnation:re,titleExp:exp},card:{daphne}});
  assert.equal(titleRank(0),1);assert.equal(titleRank(22499),9);assert.equal(titleRank(22500),10);assert.equal(titleRank(1e9),15);
  assert.equal(skillSlotCap(raw(0,0,0),'Attacker'),3);
  assert.equal(skillSlotCap(raw(1,0,0),'Attacker'),4);
  assert.equal(skillSlotCap(raw(4,0,0),'Attacker'),4);
  assert.equal(skillSlotCap(raw(5,0,0),'Attacker'),5);
  assert.equal(skillSlotCap(raw(10,1,22500),'Buffer'),8);
  assert.equal(skillSlotCap(raw(20,1,30000),'Healer'),9,'缓存里 転生20+开花+Rank13 的蒼井装了 9 个');
  assert.equal(skillSlotCap(raw(10,0,30000),'Admiral'),8,'二階堂 转生10 未开花 装 8 个');
});
test('#08 tactical cards: 28 unique cards; applyCard copies the set; hooks change mods and turn start',()=>{
  assert.equal(CARDS.length,28);assert.equal(new Set(CARDS.map(c=>c.id)).size,28);
  const f=fixtureParty({dp:0,hp:1e9});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{});
  const shared=new Set();st.cards=shared;applyCard(st,'critRate100');
  assert.notEqual(st.cards,shared,'clone-safe');assert.ok(st.cards.has('critRate100'));
  const base=collectMods({...st,cards:new Set()},0,{element:'ice'},{});
  const m1=collectMods(st,0,{element:'ice'},{});
  assert.equal(m1.passiveCritRateUp-base.passiveCritRateUp,100);
  applyCard(st,'zoneAtk300');st.field={element:'ice',size:50,owner:1,turns:null};
  assert.equal(collectMods(st,0,{element:'ice'},{}).passiveAttackUp-base.passiveAttackUp,300);
  assert.equal(collectMods(st,0,{element:'fire'},{}).passiveAttackUp-base.passiveAttackUp,0,'不同属性不吃');
  assert.equal(collectMods(st,0,{element:'ice'},{normal:true}).passiveAttackUp,collectMods({...st,cards:new Set()},0,{element:'ice'},{normal:true}).passiveAttackUp,'普攻不吃“技能攻击力”');
  // DP 溢出：技能攻击 +500%、回合开始 SP+5；每名 DP≥120% 给敌人禍 +2
  f.party.forEach(u=>{u.dpMax=1000;});st.units.forEach(u=>{u.dp=1000;});st.units[0].dp=1300;
  applyCard(st,'dpOverAtk500');applyCard(st,'dpOverSp5');applyCard(st,'dp120Disaster2');
  assert.equal(collectMods(st,0,{element:'fire'},{}).passiveAttackUp-collectMods(st,1,{element:'fire'},{}).passiveAttackUp,500);
  const sp=st.units.map(u=>u.sp);startTurn(st);
  assert.equal(st.units[0].sp-sp[0],(st.units[1].sp-sp[1])+5);
  assert.equal(st.enemy.effects.find(e=>e.status==='Disaster')?.level,2);
  assert.ok(cardSeenProb(1)>0.45&&cardSeenProb(1)<0.55&&cardSeenProb(3)>0.85);
});
test('joint card candidates use available combinations and award cards after phase one',()=>{
  const pool=['breakerCrit100','breakerAtk200','breakerOd30','enemyStat100','zoneAtk300'];
  assert.deepEqual(encounterCardSets(pool,5),[[null,...pool.slice(0,4)]]);
  assert.deepEqual(encounterCardSets(pool,3),[[null,...pool.slice(0,2)]]);
  assert.deepEqual(encounterCardSets(['zoneAtk300'],5),[]);
});

test('relevantCards: breaker/zone/heal cards only when the team can trigger them',()=>{
  const f=fixtureParty();
  const ids=relevantCards(f.party);
  assert.ok(ids.includes('sp5')&&!ids.includes('breakerOd30')&&!ids.includes('fieldOd30')&&!ids.includes('healerEx20'));
  const withBreaker=f.party.map((u,i)=>i===0?{...u,role:'Breaker'}:u);
  assert.ok(relevantCards(withBreaker).includes('breakerOd30'));
});
test('shown damage keeps overkill (whole attack) while dealt damage stops at remaining HP',()=>{
  const f=fixtureParty({dp:0,hp:10,A:[atkSkill('A1',0,1000)]});
  const st=initialState(f.party,buildEnemy(f.event,f.stage),{critMode:'none'});startTurn(st);act(st,0,0);
  assert.ok(st.totalDamage<=10);assert.ok(st.shownDamage>100,`${st.shownDamage}`);
  const des={phases:[{turns:[{...emptyTurn(),front:[0,1,2],actions:[{u:0,s:'A1'}]}]}]};
  const res=simulateDesign({party:f.party,phases:[{enemies:[buildEnemy(f.event,f.stage)]}],statusTypes:{}},{critMode:'none'},des);
  assert.ok(res.phases[0].shown>res.phases[0].damage);
});

// ---------------------------------------------------------------- 2026-11-09 宝玉技能全部可用、遭遇战最高分搜索目标
import {isOrbSkillId} from '../public/sim/hbr/battle.mjs';
test('orb skills: id ranges; allOrbSkills adds every orb (not master) skill without dropping card skills',()=>{
  assert.ok(isOrbSkillId(46300003)&&isOrbSkillId('46450002'));
  assert.ok(!isOrbSkillId(46511101)&&!isOrbSkillId(46501301)&&!isOrbSkillId(4630000));
  const f=fixtureParty();
  const stats={extraSkills:{46300003:{name:'ドライブゲイン',label:'OrbDriveGain',sp:6,consume:'Sp',uses:-1,parts:[]},46511101:{name:'紡がれた記憶',label:'Master',sp:0,parts:[]}}};
  const m={styleId:'S1',stats:{str:500,dex:500,con:500,wis:500,spr:500,luk:0},front:true};
  const plain=buildParty([m],{skills:f.skills,catalog:f.catalog,stats});
  const orbs=buildParty([{...m,allOrbSkills:true}],{skills:f.skills,catalog:f.catalog,stats});
  assert.ok(!plain[0].skills.some(s=>s.id===46300003));
  assert.ok(orbs[0].skills.some(s=>s.id===46300003&&s.extra),'orb skill added');
  assert.ok(!orbs[0].skills.some(s=>s.id===46511101),'master skill not added');
  assert.ok(orbs[0].skills.some(s=>s.label==='A1'),'card skills kept');
});
test('waveScore objective: searches one turn past the first kill and trades turns against damage score',()=>{
  const f=fixtureParty({dp:2000,hp:20000});
  const ctx={party:f.party,enemy:buildEnemy(f.event,f.stage),statusTypes:f.skills.statusTypes};
  const base={maxTurns:10,beam:8,critMode:'none',overkill:true};
  const fast=search(ctx,{...base,objective:'minTurns'});
  const cheap=search(ctx,{...base,objective:'waveScore',turnCost:1e9});
  const free=search(ctx,{...base,objective:'waveScore',turnCost:0});
  assert.ok(fast.plans.length&&cheap.plans.length&&free.plans.length);
  assert.equal(cheap.plans[0].killedTurn,fast.plans[0].killedTurn,'expensive turns → same as min turns');
  assert.ok(free.plans[0].killedTurn>=fast.plans[0].killedTurn);
  assert.ok(free.plans[0].value>=cheap.plans[0].value+cheap.plans[0].killedTurn*1e9-1e-6,'free turns never score worse');
});
