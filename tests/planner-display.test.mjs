import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {buildParty} from '../public/sim/hbr/battle.mjs';
import {simulateDesign,monteCarlo} from '../public/sim/designer.mjs';
import {groupAxisRows,renderAxisRows,axisView,replayMechanics} from '../public/planner-axis.mjs';
import {equipmentDetails,supportDetails,loadoutDetailsHtml} from '../public/planner-loadout.mjs';
import {renderDesigner} from '../public/designer-ui.mjs';

const e=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=String;
const actions=()=>[0,1,2].map(u=>({u,s:'normal'}));
function battle(){
  const f=optimizerInput({count:6}),party=buildParty(f.base,f.data),enemy={...f.target.phases[0].enemies[0],dp:[1e7],hp:1e7,maxDp:1e7,maxHp:1e7};
  party[0].passives.push({label:'ODStart',name:'ODStart',timing:'OnBattleStart',parts:[{skillType:'OverDrivePointUp',targetType:'Self',power:[3,0]}]});
  party[0].skills.push({label:'Extra',name:'追加技能',sp:0,consume:'Sp',uses:-1,parts:[{skillType:'AdditionalTurn',targetType:'AllyFront'}]});
  return {party,phases:[{enemies:[enemy]}],statusTypes:{}};
}

test('real replay separates front/end OD and their extras into three-action rows without changing results',()=>{
  const ctx=battle(),grant=[{u:0,s:'Extra'},...actions().slice(1)];
  const design={phases:[{turns:[{actions:grant,extra:actions(),
    odStart:{level:1,rounds:[{actions:grant,extra:actions()}]},
    odEnd:{level:2,rounds:[{actions:actions()},{actions:actions()}]}}]}]};
  const res=simulateDesign(ctx,{},design),noTrace=simulateDesign(ctx,{trace:false},design),rows=groupAxisRows(res.rows);
  assert.deepEqual(rows.map(r=>r.round),['od1','extra','main','extra','od1','od2']);
  assert.equal(rows[0].before[0].label,'前开 OD Lv.1');assert.equal(rows[3].after[0].label,'后开 OD Lv.2');
  assert.equal(rows[4].before.length,0);assert.equal(rows[4].after.length,0);
  assert.equal(rows[1].parentRound,'od1');assert.equal(rows[3].parentRound,undefined);
  assert.deepEqual(res.final,noTrace.final);assert.deepEqual(res.phases,noTrace.phases);assert.deepEqual(res.issues,noTrace.issues);
  const html=renderAxisRows(rows,{e,n,party:ctx.party});
  assert.equal((html.match(/class="axis-row /g)||[]).length,6);
  assert.equal((html.match(/class="axis-act[ "]/g)||[]).length,18);
  assert.match(html,/OD 2/);assert.match(html,/OD 1 内/);
  const renderedRows=html.split('<li ').slice(1);
  assert.ok(renderedRows[0].indexOf('data-od-window="turnStart"')<renderedRows[0].indexOf('class="axis-acts"'));
  assert.ok(renderedRows[3].indexOf('data-od-window="turnEnd"')>renderedRows[3].lastIndexOf('class="axis-act"'));
  assert.ok(!renderedRows[4].includes('data-od-window'));
});

test('free commands around a start OD keep their order and all three action slots',()=>{
  const turn={turn:1,phase:0},meta={...turn,roundId:1,unit:0};
  const rows=groupAxisRows([
    {...turn,kind:'turn'},{...meta,kind:'autoSkill',skill:'贝斯独奏',remaining:2},{...meta,kind:'command',beforeOd:true,damage:321},{...meta,kind:'break',beforeOd:true,label:'破盾'},
    {...turn,kind:'od',window:'turnStart',level:1,label:'前开 OD'},
    {...meta,kind:'round',round:'od1',actors:[0,1,2],commands:[{}]},
    {...meta,kind:'command',damage:123}
  ]);
  const html=renderAxisRows(rows,{e,n,party:battle().party});
  assert.equal(rows[0].usedCommands.length,2);assert.equal(rows[0].events[0].label,'破盾');
  assert.ok(html.indexOf('321')<html.indexOf('前开 OD'));
  assert.match(html,/自动.*贝斯独奏 · 剩 2 次/);
  assert.ok(html.indexOf('贝斯独奏')<html.indexOf('321'));
  assert.ok(html.indexOf('前开 OD')<html.indexOf('123'));
  assert.ok(html.indexOf('123')<html.indexOf('class="axis-acts"'));
  assert.equal((html.match(/class="axis-act[ "]/g)||[]).length,3);
});

test('replay discloses only encountered unsupported or approximate mechanics and escapes labels',()=>{
  assert.equal(replayMechanics({},e),'');
  const html=replayMechanics({unsupported:{'未导入<技能>':3},approx:{'伤害范围':2}},e);
  assert.match(html,/1 项未支持，1 项近似/);
  assert.match(html,/未导入&lt;技能&gt;/);
  assert.match(html,/伤害范围/);
});

test('end OD follows normal actions when there is no extra; failed activation is not rendered',()=>{
  const ctx=battle(),design={phases:[{turns:[{actions:actions(),odEnd:{level:1,rounds:[{actions:actions()}]}}]}]};
  const rows=groupAxisRows(simulateDesign(ctx,{},design).rows);
  assert.deepEqual(rows.map(r=>r.round),['main','od1']);
  assert.equal(rows[0].after[0].window,'turnEnd');assert.equal(rows[1].before.length,0);
  ctx.party[0].passives=[];
  const failed=simulateDesign(ctx,{},design);
  assert.ok(failed.issues.some(x=>/发动失败/.test(x.msg)));
  assert.ok(!renderAxisRows(groupAxisRows(failed.rows),{e,n,party:ctx.party}).includes('data-od-window'));
});

test('break and kill stay on the triggering round and later actions are visibly unexecuted',()=>{
  const ctx=battle();Object.assign(ctx.phases[0].enemies[0],{dp:[1],hp:1,maxDp:1,maxHp:1});
  const design={phases:[{turns:[{actions:actions()}]}]},res=simulateDesign(ctx,{},design),rows=groupAxisRows(res.rows);
  assert.equal(rows.length,1);assert.equal(rows[0].actions.length,2);
  assert.deepEqual(rows[0].events.map(x=>x.kind),['break','kill']);
  const html=axisView({e,n,...ctx,design}).html;
  assert.match(html,/破盾/);assert.match(html,/击杀/);
  assert.equal((html.match(/未执行（已击杀）/g)||[]).length,1);
});

test('AoE shield breaks name the secondary enemy while the primary shield remains intact',()=>{
  const f=optimizerInput({count:6}),skill=f.data.skills.styles.S0.skills[0];
  skill.hitCount=1;skill.parts[0].targetType='All';
  const party=buildParty(f.base,f.data),enemy=f.target.phases[0].enemies[0];
  const primary={...enemy,name:'主敌',dp:[1e7],maxDp:1e7,hp:1e7,maxHp:1e7};
  const secondary={...enemy,name:'旁敌',dp:[1],maxDp:1,hp:1e7,maxHp:1e7};
  const ctx={party,phases:[{enemies:[primary,secondary]}],statusTypes:{}};
  const design={phases:[{turns:[{actions:[{u:0,s:'Skill0'}]}]}]};
  const replay=simulateDesign(ctx,{critMode:'none'},design),view=axisView({e,n,...ctx,design,critMode:'none'});
  assert.ok(replay.final.enemy.dp>0,'the focused primary enemy still has its shield');
  assert.deepEqual(replay.rows.filter(r=>r.kind==='break').map(r=>r.label),['破盾 旁敌']);
  assert.match(view.html,/破盾 旁敌/);assert.doesNotMatch(view.html,/破盾 主敌/);
});

test('expected first-turn kills are labeled as predictions and differ from noncritical replay',()=>{
  const f=optimizerInput({count:6});f.data.skills.styles.S0.skills[0].hitCount=1;
  const party=buildParty(f.base,f.data),enemy={...f.target.phases[0].enemies[0],hp:1225,maxHp:1225,dp:[],maxDp:0};
  const ctx={party,phases:[{enemies:[enemy]}],statusTypes:{}},design={phases:[{turns:[{actions:[{u:0,s:'Skill0'}]}]}]};
  const expected=axisView({e,n,...ctx,design}),none=axisView({e,n,...ctx,design,critMode:'none'});
  assert.equal(expected.summary.cleared,1);assert.equal(none.summary.cleared,0);
  assert.match(expected.html,/平均伤害预测/);assert.match(expected.html,/不保证每次发生/);assert.match(expected.html,/axis-kill/);
  assert.match(none.html,/不暴击、伤害浮动取中值/);assert.doesNotMatch(none.html,/axis-kill/);
  const original=monteCarlo(ctx,{extendTurns:0},design,{n:200,seed:7}),extended=monteCarlo(ctx,{},design,{n:200,seed:7});
  assert.ok(original.onPlan>0&&original.onPlan<1,'an expected kill must not be mistaken for guaranteed success');
  assert.equal(extended.onPlan,original.onPlan);assert.ok(extended.success>original.success,'continued turns are distinct from the displayed first turn');
  const override=axisView({e,n,...ctx,design,critMode:'expected',simulationOptions:{critMode:'none'}});
  assert.match(override.html,/不暴击、伤害浮动取中值/);assert.equal(override.summary.cleared,0);
});

test('designer replay explains each selected critical mode beside its result',()=>{
  const ctx=battle(),host={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
  const env={e,n,host,...ctx,opt:{},design:{phases:[{turns:[{actions:actions()}]}]},view:{phase:0,crit:'expected',vary:1.1},save:()=>{}};
  renderDesigner(env);assert.match(host.innerHTML,/平均伤害预测/);
  env.view.crit='none';renderDesigner(env);assert.match(host.innerHTML,/不暴击、伤害浮动取中值/);assert.doesNotMatch(host.innerHTML,/平均伤害预测/);
  env.view.crit='all';renderDesigner(env);assert.match(host.innerHTML,/不代表实际必定暴击/);
});

test('action cards distinguish selection from execution SP, and an unselectable finisher cannot earn a score',()=>{
  const ctx=battle(),[giver,receiver]=ctx.party;
  for(const u of ctx.party)u.initialSp=0;
  giver.skills.push({...giver.skills[0],label:'Give',name:'喂 SP',sp:0,
    parts:[{skillType:'HealSp',targetType:'AllySingleWithoutSelf',power:[4,4]}]});
  const hit={...receiver.skills[0],label:'Hit',name:'重击',sp:3};
  receiver.skills.push(hit);
  Object.assign(ctx.phases[0].enemies[0],{dp:[],maxDp:0,hp:1,maxHp:1});
  const design={phases:[{turns:[{actions:[{u:0,s:'Give',target:1},{u:1,s:'Hit'},{u:2,s:'Skill2'}]}]}]};
  const good=axisView({e,n,...ctx,design});
  assert.equal(good.summary.invalid,false);
  assert.match(good.html,/重击<\/span><small>选招时 SP 3 · 需 3<\/small><small>扣盾\/血 1 · 行动后 SP 4/);
  hit.sp=7;
  const bad=axisView({e,n,...ctx,design});
  assert.equal(bad.summary.invalid,true);
  assert.match(bad.html,/选招时 SP 3 · 需 7<\/small><small class="pill-error">/);
  const host={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
  renderDesigner({e,n,host,...ctx,opt:{},design,wave:{difficulty:40,rules:[]},save:()=>{}});
  assert.match(host.innerHTML,/有无法执行的行动，无通关分数/);
  assert.doesNotMatch(host.innerHTML,/× 规则 [\d.]+ = <b>\d/);
  hit.allowSpOverdraft=true;
  const exempt=axisView({e,n,...ctx,design});
  assert.equal(exempt.summary.invalid,false);assert.match(exempt.html,/选招时 SP 3 · 需 7<\/small><small>[^<]*(透支|负)/);
});

test('sparse extra and invalid actions have three positions, preserve order and escape text',()=>{
  const ctx=battle();ctx.party[0].skills.at(-1).parts[0].targetType='Self';ctx.party[0].name='<img onerror=bad>';
  const design={phases:[{turns:[{actions:[{u:0,s:'Extra'},...actions().slice(1)],extra:[{u:0,s:'missing<script>'}]}]}]};
  const res=simulateDesign(ctx,{},design),rows=groupAxisRows(res.rows),html=renderAxisRows(rows,{e,n,party:ctx.party});
  assert.equal(rows[1].actors.length,1);assert.equal(rows[1].actions.length,0);
  assert.equal((html.match(/class="axis-act[ "]/g)||[]).length,6);
  assert.equal((html.match(/无追加行动/g)||[]).length,2);
  assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.match(html,/未执行/);
});

const equipment={entries:[{sourceId:1,name:'冰耳环',effects:[{type:'Dp',value:[1200]}],rollGroups:[[{type:'Wisdom',value:[40]},{type:'Wisdom',value:[48]}]]},
  {sourceId:2,name:'灵魂书',effects:[],rollGroups:[]}]};
test('equipment details show names, plus, selected rolls, ordered sockets and unknowns without inventing values',()=>{
  const member={raw:{accessories:{earring:{masterId:1,plus:6,main:[42600202],expansion:[42400015,999]},soul:{masterId:2,plus:3,main:[],expansion:[]}}}};
  const rows=equipmentDetails(member,equipment),ear=rows.find(r=>r.slot==='earring');
  assert.equal(ear.plus,6);assert.ok(ear.lines.includes('主词条：智慧 +48'));assert.ok(ear.lines.some(x=>x.includes('1. 智慧 +3；2. 未识别 #999')));
  assert.ok(rows.find(r=>r.slot==='soul').lines.some(x=>x.includes('全能力 +17')));
  member.raw.accessories.earring.main=[];
  const missing=equipmentDetails(member,equipment)[0].lines;
  assert.ok(missing.includes('主词条：未记录'));assert.ok(missing.some(x=>x.startsWith('模拟暂按：')));
  assert.equal(equipmentDetails({},equipment),null);
});

test('support configuration uses equipped style and LB tier, distinguishes empty and unknown, and shows computed panel',()=>{
  const f=optimizerInput({count:6}),stats=f.data.stats;
  stats.styles.S1.resonance='R';stats.supportSkills={R:[{lb:0,passive:{name:'共鸣 0',desc:'低档效果'}},{lb:3,passive:{name:'共鸣 3',desc:'高档效果'}}]};
  const m={supportStyleId:'S1',supportLimitBreak:4,raw:{support:structuredClone(f.cache.cards[1]),supportStyleId:'S0',supportLimitBreak:0,accessories:{}}};
  const sup=supportDetails(m,f.data);assert.match(sup.name,/Style 1/);assert.ok(sup.lines.includes('突破：4'));
  assert.ok(sup.lines.some(x=>x.includes('共鸣 3（突破 3 档）')));assert.ok(sup.lines.includes('高档效果'));
  assert.ok(sup.lines.some(x=>x.includes('面板加成（推算）')));
  assert.equal(supportDetails({},f.data).name,'未记录');assert.equal(supportDetails({supportStyleId:null},f.data).name,'未装备');
  delete m.supportLimitBreak;delete m.raw.supportLimitBreak;delete m.raw.support.limitBreak;
  assert.ok(supportDetails(m,f.data).lines.includes('突破：未记录'));
  assert.ok(!supportDetails(m,f.data).lines.includes('低档效果'));
  m.supportStyleId='<script>';assert.ok(!loadoutDetailsHtml(m,{...f.data,equipment},e).includes('<script>'));
});
