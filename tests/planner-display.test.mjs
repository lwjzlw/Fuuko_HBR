import test from 'node:test';
import assert from 'node:assert/strict';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {buildParty} from '../public/sim/hbr/battle.mjs';
import {simulateDesign} from '../public/sim/designer.mjs';
import {groupAxisRows,renderAxisRows,axisView} from '../public/planner-axis.mjs';
import {equipmentDetails,supportDetails,loadoutDetailsHtml} from '../public/planner-loadout.mjs';

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
  assert.equal(rows[0].events[0].label,'前开 OD Lv.1');assert.equal(rows[4].events[0].label,'后开 OD Lv.2');
  assert.equal(rows[1].parentRound,'od1');assert.equal(rows[3].parentRound,undefined);
  assert.deepEqual(res.final,noTrace.final);assert.deepEqual(res.phases,noTrace.phases);assert.deepEqual(res.issues,noTrace.issues);
  const html=renderAxisRows(rows,{e,n,party:ctx.party});
  assert.equal((html.match(/class="axis-row /g)||[]).length,6);
  assert.equal((html.match(/class="axis-act[ "]/g)||[]).length,18);
  assert.match(html,/OD 2/);assert.match(html,/OD 1 内/);
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
