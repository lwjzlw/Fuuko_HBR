import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {act,buildEnemy,buildParty,cloneState,effectiveCost,endExtraTurn,endOdRound,endPlayerTurn,initialState,memberStats,previewAttack,setPhase,startExtraTurn,startOverdrive,startTurn,stateKey,usableSkills} from '../public/sim/hbr/battle.mjs';

const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const data={catalog:read('../public/data/catalog.json'),skills:read('../public/data/skills.json')};
const wave=read('../public/data/bosses/wave/WaveBattle0008.json');
function enemy(label='X',hit=0){
  return {label,name:label,border:400,dp:[1000000],hp:1e8,destruction:10,destructionLimit:300,initialDestruction:1,breakDownSetting:0,
    weaknesses:{element:{},physical:{}},pattern:{hp:{entries:[{order:1,skills:[1]}]},dp:{entries:[{order:1,skills:[1]}]}},
    skills:[{id:1,label:'single',hitCount:1,parts:[{skillType:'AttackFixedDamageDefinitely',targetType:'Single',power:[hit,0]}]}]};
}
function setup(ids,model=enemy(),opt={}){
  const party=buildParty(ids.map(styleId=>({styleId,front:true,extraStyleIds:[],limitBreak:0,initialSp:50,vitals:{dp:1000,hp:10000}})),data);
  return initialState(party,model,{critMode:'none',trace:true,...opt});
}
const skill=(st,i,label)=>{const k=st.ctx.party[i].skills.findIndex(s=>s.label===label);assert.ok(k>=0,label);return k;};
const cost=(st,i,label)=>effectiveCost(st,i,st.ctx.party[i].skills[skill(st,i,label)]);
const cast=(st,i,label)=>act(st,i,skill(st,i,label));
const effect=(st,i,type)=>st.units[i].effects.find(e=>e.type===type||e.status===type);

test('水濑莓冰暗技能共享无敌盾判定，救盾才扣次数，受击与技能分别叠反击',()=>{
  const st=setup(['IMinase08'],enemy('X',5000));startTurn(st);
  assert.equal(cost(st,0,'IMinaseSkill06'),8);
  cast(st,0,'IMinaseSkill07');assert.equal(effect(st,0,'eaGuard').uses,2);
  for(const label of ['IMinaseSkill06','IMinaseSkill06@b'])assert.equal(cost(st,0,label),0);
  cast(st,0,'IMinaseSkill06@b');assert.equal(st.units[0].extra,1);
  assert.equal(effect(st,0,'Revenge').level,1);
  const con=memberStats(st,0).con;
  endPlayerTurn(st);assert.equal(st.units[0].dp,1);assert.equal(effect(st,0,'eaGuard').uses,1);
  assert.equal(effect(st,0,'Revenge').level,2);assert.equal(memberStats(st,0).con,con+2);
  startTurn(st);endPlayerTurn(st);assert.equal(st.units[0].dpBroken,true);
  assert.ok(!usableSkills(st,0).includes(skill(st,0,'IMinaseSkill07')));
});

test('二以奈彩妆使用次数与施放历史分开，破盾后不再免费',()=>{
  const model=enemy('X',5000);model.dp=[];const st=setup(['NiOhshima06'],model);
  startTurn(st);assert.equal(st.units[0].dp,1100);assert.equal(cost(st,0,'NiOhshimaSkill53'),8);
  const u=st.units[0],k=skill(st,0,'NiOhshimaSkill53');u.uses.NiOhshimaSkill53=6;
  assert.ok(usableSkills(st,0).includes(k));act(st,0,k);
  assert.equal(u.uses.NiOhshimaSkill53,6);assert.equal(u.playedSkills.NiOhshimaSkill53,1);
  endPlayerTurn(st);assert.equal(u.dpBroken,true);assert.ok(!effect(st,0,'Makeup'));assert.equal(cost(st,0,'NiOhshimaSkill53'),16);
  u.sp=50;assert.ok(!usableSkills(st,0).includes(k));
});

test('柊木的灾厄对副目标有效，三个敌回合内减20，OD/追加不扣时',()=>{
  const a=enemy('A'),b=enemy('B'),st=setup(['KHiiragi04'],a);setPhase(st,[a,b]);startTurn(st);
  cast(st,0,'KHiiragiSkill04');const mark=st.enemy.effects.find(e=>e.type==='misfortune');
  assert.equal(mark.size,20);assert.equal(mark.turns,3);
  st.enemy=st.queue[1].state;st.ctx={...st.ctx,enemy:b};st.qi=1;
  assert.equal(cost(st,0,'KHiiragiSkill52'),6);
  st.od=100;startOverdrive(st,1,'turnEnd');endOdRound(st);assert.equal(mark.turns,3);
  st.units[0].extra=1;startExtraTurn(st);endExtraTurn(st,[0]);assert.equal(mark.turns,3);
  endPlayerTurn(st);assert.equal(mark.turns,2);
  st.queue[0].state.hp=0;st.queue[0].dead=true;assert.equal(cost(st,0,'KHiiragiSkill52'),12);
});

test('真实第8期首关模板，破盾才倒下；倒下令朝仓超倒生效，敌回合后过期',()=>{
  const labels=Object.keys(wave.enemies).filter(k=>/CorollaKnife/.test(k));assert.ok(labels.length);
  const model=buildEnemy(wave,{enemies:[{label:labels[0],dp:1,hp:1e8,paramBorder:775,destruction:[10,300]}]});
  assert.equal(model.breakDownSetting,0);model.hp=1e8;model.dp=[1];
  const st=setup(['KAsakura09'],model);startTurn(st);const fresh=cloneState(st);
  fresh.enemy.dp=[1e8];cast(fresh,0,'KAsakuraSkill09');assert.equal(fresh.enemy.breakDownTurns,0);assert.ok(!fresh.enemy.effects.some(e=>e.type==='superDown'));
  cast(st,0,'KAsakuraSkill09');assert.equal(st.enemy.breakDownTurns,1);assert.ok(st.enemy.effects.some(e=>e.type==='superDown'));
  st.od=100;startOverdrive(st,1,'turnEnd');endOdRound(st);assert.equal(st.enemy.breakDownTurns,1);
  const before=cloneState(st);endPlayerTurn(st);assert.equal(st.enemy.breakDownTurns,0);assert.notEqual(stateKey(before),stateKey(st));assert.ok(!st.enemy.effects.some(e=>e.type==='superDown'));
  const immune=setup(['KAsakura09'],{...model,breakDownSetting:-1});startTurn(immune);cast(immune,0,'KAsakuraSkill09');assert.equal(immune.enemy.breakDownTurns,0);
});

test('幹勁不凭空给全队普通；未证实的开场等级拒绝给高档，明确极佳赋予后走最高档',()=>{
  const st=setup(['RKayamori10','IMinase07']);startTurn(st);
  assert.equal(effect(st,0,'Motivation').level,null);
  assert.equal(previewAttack(st,0,skill(st,0,'RKayamoriSkill57')),null);
  cast(st,1,'IMinaseSkill54');assert.equal(effect(st,0,'Motivation').level,5);
  assert.ok(previewAttack(st,0,skill(st,0,'RKayamoriSkill57')));
});

test('新状态ID缺映射的否定条件不触发，老调用已知ID20兼容',()=>{
  const st=setup(['NiOhshima06']);const s=st.ctx.party[0].skills.find(s=>s.label==='NiOhshimaSkill53');
  assert.equal(effectiveCost(st,0,{...s,overwriteCond:'SpecialStatusCountByType(999999)==0'}),16);
  assert.equal(effectiveCost(st,0,{...s,overwriteCond:'SpecialStatusCountByType(20)==0'}),8);
  assert.ok(Object.keys(st.flags.unsupported).some(x=>x.includes('999999')));
});

test('夏目的SP20下限、消耗全部SP的EX与负SP专技按行动前实值判断',()=>{
  const st=setup(['INatsume05','CSkopovskaya08']);
  const charge=skill(st,0,'INatsumeSkill05'),all=skill(st,0,'INatsumeSkill53'),negative=skill(st,1,'CSkopovskayaSkill55');
  st.units[0].sp=19;assert.ok(!usableSkills(st,0).includes(charge));
  st.units[0].sp=20;assert.ok(usableSkills(st,0).includes(charge));assert.equal(effectiveCost(st,0,st.ctx.party[0].skills[all]),20);
  act(st,0,all);assert.equal(st.units[0].sp,0);assert.ok(!usableSkills(st,0).includes(all));
  st.units[1].sp=0;assert.ok(!usableSkills(st,1).includes(negative));
  st.units[1].sp=-1;assert.ok(usableSkills(st,1).includes(negative));
});

test('苍井的注目作用于敌方，樱庭降费；两次无效按敌方攻击计，第三次全体攻击仍回到其他队员',()=>{
  const a=enemy('A',200),b=enemy('B',200);
  for(const model of [a,b])model.skills[0].parts[0].targetType='All';
  const st=setup(['EAoi03','SSakuraba06'],a);setPhase(st,[a,b]);startTurn(st);
  const before=cost(st,1,'SSakurabaSkill53');cast(st,0,'EAoiSkill51');
  assert.ok(st.queue.every(q=>q.state.effects.some(e=>e.type==='cover'&&e.owner===0)));
  assert.ok(cost(st,1,'SSakurabaSkill53')<before);
  const hp=st.units.map(u=>u.dp);endPlayerTurn(st);assert.deepEqual(st.units.map(u=>u.dp),hp);
  assert.ok(!effect(st,0,'invincible'));
  startTurn(st);endPlayerTurn(st);assert.ok(st.units[0].dp<hp[0]);assert.equal(st.units[1].dp,hp[1]);
  startTurn(st);endPlayerTurn(st);assert.ok(st.units[1].dp<hp[1]);
});

test('伊达的悲观持续5个敌方回合，早开OD不提前解锁EX减费',()=>{
  const st=setup(['ADate05']);startTurn(st);
  const normal=cost(st,0,'ADateSkill53');st.od=100;startOverdrive(st,1,'turnStart');endOdRound(st);
  assert.equal(effect(st,0,'NegativeMind').turns,5);
  for(let i=0;i<5;i++){endPlayerTurn(st);startTurn(st);}
  assert.ok(!effect(st,0,'NegativeMind'));assert.equal(cost(st,0,'ADateSkill53'),normal/2);
});

test('歌姬加护允许耗尽的常规EX，负次数标记的限定EX仍有严格上限',()=>{
  const st=setup(['RKayamori09','KHiiragi04']);startTurn(st);cast(st,0,'RKayamoriSkill56');
  const regular=skill(st,1,'KHiiragiSkill52'),limited=skill(st,0,'RKayamoriSkill56');
  st.units[1].uses.KHiiragiSkill52=6;st.units[0].uses.RKayamoriSkill56=4;
  assert.ok(usableSkills(st,1).includes(regular));assert.ok(!usableSkills(st,0).includes(limited));
  act(st,1,regular);assert.equal(st.units[1].uses.KHiiragiSkill52,6);
  st.units[1].effects=st.units[1].effects.filter(e=>e.status!=='Diva');assert.ok(!usableSkills(st,1).includes(regular));
});

test('Cathy的前卫回避判定一次攻击，两个随机分支均消耗一次',()=>{
  for(const roll of [0.1,0.9]){
    const st=setup(['CathyA02'],enemy('X',150),{rng:()=>roll});startTurn(st);
    cast(st,0,'CathyASkill02');assert.equal(effect(st,0,'dodge').uses,1);
    const before=st.units[0].dp;endPlayerTurn(st);
    assert.equal(st.units[0].dp,before-(roll<0.5?0:150));assert.ok(!effect(st,0,'dodge'));
  }
});
