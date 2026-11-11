import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {act,buildParty,canLimitDamage,cloneState,effectiveCost,initialState,NORMAL,previewAttack,setPhase,startExtraTurn,startTurn,stateKey,usableSkills} from '../public/sim/hbr/battle.mjs';
import {applyCard} from '../public/sim/cards.mjs';
import {designFromPlan,monteCarlo,simulateDesign,skillChoices} from '../public/sim/designer.mjs';
import {replay} from '../public/sim/search.mjs';

const data=Object.fromEntries(['catalog','skills','stats'].map(k=>[k,JSON.parse(readFileSync(new URL('../public/data/'+k+'.json',import.meta.url)))]));
const enemy={label:'training',name:'训练',border:550,hp:1e9,dp:[1e9],destructionLimit:300,
  weaknesses:{element:{fire:100,ice:100,dark:100,nonelemental:100},physical:{slash:100,stab:100,strike:100}},pattern:{},skills:[],rules:[]};
function battle(styleId,labels,extra={}){
  const ids=data.skills.styles[styleId].skills.filter(x=>labels.includes(x.label)).map(x=>x.id);
  const stats={str:700,dex:700,con:700,wis:700,spr:700,luk:700};
  const party=buildParty([styleId,'TKunimi01','SMinase01'].map((id,i)=>({styleId:id,front:true,stats,initialSp:45,
    deckSkillIds:i===0?[...ids,...extra.skillIds||[]]:[],strictDeckSkills:true,...(i===0?extra.member:{})})),data);
  for(const m of party)m.passives=[];
  const st=initialState(party,enemy,{statusTypes:data.skills.statusTypes,trace:true,critMode:'none'});
  return {st,party,index:label=>party[0].skills.findIndex(s=>s.label===label)};
}

test('first-use cost and first-use attack see the same prior uses, including after another skill or a stage change',()=>{
  const label='IIshiiSkill51Ev1',other=data.skills.styles.IIshii03.skills.find(s=>s.label!==label&&!s.passive).label;
  const {st,party,index}=battle('IIshii03',[label,other]),k=index(label),skill=party[0].skills[k],u=st.units[0];
  act(st,0,index(other));st.od=0;
  assert.equal(effectiveCost(st,0,skill),6);
  const copy=cloneState(st);
  act(st,0,k);
  assert.ok(st.od>=30);assert.equal(u.playedSkills[label],1);assert.equal(copy.units[0].playedSkills[label],undefined);
  assert.equal(effectiveCost(st,0,skill),12);
  applyCard(st,'skillCount1');
  assert.equal(u.uses[label],0);assert.equal(effectiveCost(st,0,skill),12);
  act(st,0,k);const used=u.uses[label];
  st.killedTurn=1;setPhase(st,[enemy]);
  assert.equal(u.uses[label],used);assert.equal(effectiveCost(st,0,skill),6);
  const changed=cloneState(st);changed.units[0].playedSkills[label]=1;
  assert.notEqual(stateKey(changed),stateKey(st));
});

test('progressive Dance ranks use only that skill, cap at rank four, and repeated EX resolves one cast',()=>{
  const label='MTenneSkill54',other=data.skills.styles.MTenne06.skills.find(s=>s.label!==label&&!s.passive).label;
  const {st,index}=battle('MTenne06',[label,other]),k=index(label);
  act(st,0,index(other));
  for(const expected of [1,2,3,4,4]){
    st.units[1].sp=0;st.units[0].sp=20;
    act(st,0,k);assert.equal(st.units[1].sp,expected);
  }
  st.killedTurn=1;setPhase(st,[enemy]);st.units[0].effects.push({type:'doubleAction',uses:1});
  st.units[1].sp=0;act(st,0,k);
  assert.equal(st.units[1].sp,2);assert.equal(st.units[0].playedSkills[label],1);
});

test('published escalating SP cost advances 8/12/16/20 and respects the cap',()=>{
  const label='CathyCSkill51',{st,party,index}=battle('CathyC03',[label]),k=index(label);
  for(const cost of [8,12,16,20,20]){
    st.units[0].sp=22;assert.equal(effectiveCost(st,0,party[0].skills[k]),cost);act(st,0,k);
  }
});

test('damage limiter applies one damage per active hit through DP and HP, only on the selected cast',()=>{
  const label='YShirakawaSkill54',equipped={skillIds:[46450002]};
  const {party,index}=battle('YShirakawa07',[label],equipped),k=index(label+'@b');
  const target={...enemy,dp:[2],hp:50,destruction:1},st=initialState(party,target,{critMode:'all',followUpRate:0,trace:true});
  st.units[0].effects.push({type:'consecutiveHit',size:10,ratios:[.1,.1],uses:1});
  assert.ok(canLimitDamage(party[0],party[0].skills[k]));
  assert.equal(canLimitDamage(party[1],party[0].skills[k]),false);
  const info=act(st,0,k,undefined,true);
  assert.equal(info.damage,12);assert.deepEqual(st.enemy.dp,[0]);assert.equal(st.enemy.hp,40);
  assert.ok(st.enemy.dr>1);assert.ok(st.od>0);assert.equal(st.shownDamage,12);
  assert.throws(()=>act(st,0,NORMAL,undefined,true),/限制器/);
  assert.equal(st.enemy.hp,40);
  act(st,0,k);assert.equal(st.enemy.hp,0);
  const available=battle('YShirakawa07',[label],{member:{allOrbSkills:true}});
  assert.ok(available.party[0].skills.some(s=>s.id===46450002));
  assert.equal(canLimitDamage(available.party[0],available.party[0].skills[available.index(label)]),false);
});

test('fixed design, direct replay and Monte Carlo retain the per-action limiter; old designs default off',()=>{
  const label='YShirakawaSkill54',{party,index}=battle('YShirakawa07',[label],{skillIds:[46450002]});
  const target={...enemy,dp:[2],hp:50,destruction:1},k=index(label+'@b'),ctx={party,enemy:target,phases:[{enemies:[target]}]};
  const plan=[{k:'turn'},{k:'front',units:[0,1,2]},{k:'act',u:0,s:k,limiter:true},{k:'end'}];
  assert.equal(replay(ctx,{followUpRate:0},plan).totalDamage,10);
  const design=designFromPlan(plan,party),action=design.phases[0].turns[0].actions[0];assert.equal(action.limiter,true);
  const result=simulateDesign(ctx,{},design),row=result.rows.find(r=>r.kind==='act');
  assert.equal(row.damage,10);assert.equal(row.limiter,true);assert.equal(result.final.enemy.hp,42);
  assert.equal(monteCarlo(ctx,{extendTurns:0},design,{n:8,seed:413}).successes,0);
  delete action.limiter;
  const legacy=monteCarlo(ctx,{extendTurns:0},design,{n:8,seed:413});
  assert.equal(legacy.successes,8);action.limiter=false;
  assert.deepEqual(monteCarlo(ctx,{extendTurns:0},design,{n:8,seed:413}),legacy);
  action.limiter=true;party[0].damageLimiter=false;
  const illegal=simulateDesign(ctx,{},design);
  assert.ok(illegal.issues.some(x=>x.level==='error'&&x.msg.includes('限伤')));
  assert.equal(illegal.final.enemy.hp,50);
});

test('action trace records the actual pre-cast resource cost, including first use and progressive costs',()=>{
  for(const [style,label,first] of [['IIshii03','IIshiiSkill51Ev1',6],['CathyC03','CathyCSkill51',8]]){
    const {party,index}=battle(style,[label]);
    const plan=[{k:'turn'},{k:'front',units:[0,1,2]},{k:'act',u:0,s:index(label)}];
    const row=simulateDesign({party,phases:[{enemies:[enemy]}]},{},designFromPlan(plan,party)).rows.find(r=>r.kind==='act');
    assert.equal(row.cost,first);assert.equal(row.consume,'Sp');
  }
});

test('unavailable skills report their effective usage limit, activation condition or actual resource separately',()=>{
  const label='BIYamawakiSkill55',{st,index}=battle('BIYamawaki08',[label]),k=index(label);
  const why=()=>{const issue={k};assert.equal(usableSkills(st,0,issue).includes(k),false);return issue.reason;};
  st.units[1].effects.push({status:'BIYamawakiServant'});
  assert.match(why(),/需要 6 名山脇的小跟班，当前 1 名/);
  st.units[0].uses[label]=4;
  assert.match(why(),/使用次数已用尽（已用 4 次，上限 4 次）/);
  for(const [style,s,resource] of [['YShirakawa07','YShirakawaSkill54','SP'],['NNanase03','NNanaseSkill51','EP']]){
    const b=battle(style,[s]);b.st.units[0].sp=0;
    const detail={k:b.index(s)};usableSkills(b.st,0,detail);
    assert.ok(detail.reason.startsWith(resource+'不足（现有 0，需'));
  }
});

test('unmodeled event equipment is reported once, immersion defense only after entering the mode',()=>{
  const r=battle('IRedmayne04',[]);
  r.party[0].passives.push(data.skills.styles.IRedmayne04.passives.find(p=>p.parts.some(q=>q.skillType==='AdditionalHitOnRemovingBuff')));
  act(r.st,0,NORMAL);act(r.st,0,NORMAL);
  assert.deepEqual(Object.entries(r.st.flags.approx).filter(([msg])=>msg.includes('触发条件未建模')),[[r.party[0].name+'已装备「怪盜斬亂麻」，触发条件未建模（AdditionalHitOnRemovingBuff）',1]]);
  const n=battle('HNaruse03',[]),note='成濑已进入沉浸：防御上升与持续 DP 回复未建模';
  act(n.st,0,n.index('Immersion:light'));assert.equal(n.st.flags.approx[note],undefined);
  startTurn(n.st);assert.equal(n.st.flags.approx[note],1);
  startTurn(n.st);assert.equal(n.st.flags.approx[note],1);
});

test('eight switch skills expose two named battle modes with one equipped skill and use limit',()=>{
  const switches=Object.entries(data.skills.styles).flatMap(([styleId,d])=>d.skills.filter(s=>s.parts.some(p=>p.skillType==='SkillSwitch')).map(s=>[styleId,s]));
  assert.equal(switches.length,8);
  for(const [styleId,s] of switches){
    const {party,index}=battle(styleId,[s.label]),[a,b]=[index(s.label),index(s.label+'@b')];
    assert.ok(a>=0&&b>=0);
    assert.equal(party[0].skills[a].id,party[0].skills[b].id);assert.equal(party[0].skills[b].rootLabel,s.label);assert.equal(party[0].skills[b].rootName,s.name);
    assert.notEqual(party[0].skills[a].name,party[0].skills[b].name);
    assert.ok(skillChoices(party[0]).some(x=>x.s===s.label+'@b'));
  }
  const label='RKayamoriSkill55',{st,party,index}=battle('RKayamori08',[label]),a=index(label),b=index(label+'@b');
  assert.equal(previewAttack(st,0,a).model.element,'dark');assert.equal(previewAttack(st,0,b).model.element,'fire');
  const design=designFromPlan([{k:'turn'},{k:'front',units:[0,1,2]},{k:'act',u:0,s:b}],party);
  assert.equal(design.phases[0].turns[0].actions[0].s,label+'@b');
  const res=simulateDesign({party,phases:[{enemies:[enemy]}],statusTypes:data.skills.statusTypes},{trace:true},design);
  assert.ok(res.rows.some(row=>row.kind==='act'&&row.skill===party[0].skills[b].name));
  const limit=Math.max(...party[0].skills[b].uses);st.units[0].uses[label]=limit-1;
  act(st,0,b);assert.equal(st.units[0].uses[label],limit);assert.equal(st.units[0].playedSkills[label],1);
  assert.equal(usableSkills(st,0).includes(a),false);assert.equal(usableSkills(st,0).includes(b),false);
});

test('a same-element switch preserves five versus ten hits and its additional-turn leaf cost',()=>{
  const label='YShirakawaSkill54',{st,party,index}=battle('YShirakawa07',[label]),a=index(label),b=index(label+'@b');
  assert.match(party[0].skills[a].name,/5连击/);assert.match(party[0].skills[b].name,/10连击/);
  assert.equal(previewAttack(st,0,a).model.hitCount,5);assert.equal(previewAttack(st,0,b).model.hitCount,10);
  assert.equal(effectiveCost(st,0,party[0].skills[b]),15);st.units[0].extra=1;startExtraTurn(st);
  assert.equal(effectiveCost(st,0,party[0].skills[b]),7);
});

test('published binary random skills draw from the replay RNG instead of always applying the successful effect',()=>{
  for(const [style,label,low,high] of [
    ['SHiguchi03','SHiguchiSkill51',.5,.5],['YBungo03','YBungoSkill51',.5,.8],
    ['YBungo03','YBungoSkill51Ev1',.5,.8],['YBungo05','YBungoSkill05',.1,.5],
    ['YBungo07','YBungoSkill07',.5,.8],['ADate05','ADateSkill05',.4,.6],
  ]){
    for(const [luck,prob] of [[enemy.border,low],[enemy.border+100,high]]){
      for(const [draw,side] of [[prob-.001,'a'],[prob+.001,'b']]){
        const {st,party,index}=battle(style,[label]);party[0].stats.luk=luck;
        st.ctx.opt.critMode='random';st.ctx.opt.rng=()=>draw;act(st,0,index(label));
        assert.equal(st.log.find(x=>x.t==='skillRandom')?.branch,label+side);
      }
    }
  }
});

test('three verified fair binary draws in the Murohushi tree give four 25 percent duration outcomes',()=>{
  const label='RMurohushiSkill06';
  for(const [draw,side] of [[.249,'aa'],[.25,'ab'],[.5,'ba'],[.75,'bb']]){
    const {st,index}=battle('RMurohushi07',[label]);st.ctx.opt.critMode='random';st.ctx.opt.rng=()=>draw;
    act(st,0,index(label),1);assert.equal(st.log.find(x=>x.t==='skillRandom').branch,label+side);
  }
});
