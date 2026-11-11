import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {act,availableCommands,buildParty,cloneState,endExtraTurn,endOdRound,initialState,setPhase,startExtraTurn,startOverdrive,startTurn} from '../public/sim/hbr/battle.mjs';
import {simulateDesign} from '../public/sim/designer.mjs';
import {search,replay} from '../public/sim/search.mjs';
import {optimizerInput} from './fixtures/optimizer-input.mjs';

const load=name=>JSON.parse(readFileSync(new URL('../public/data/'+name+'.json',import.meta.url)));
const skills=load('skills'),catalog=load('catalog');
function setup(limitBreak){
  const input=optimizerInput({count:6}),party=buildParty(input.base,input.data);
  for(const m of party){m.dpMax=10000;m.hpMax=2000;}
  const [megumi]=buildParty([{styleId:'MAikawa09',stats:party[5].stats,vitals:{dp:10000,hp:2000},limitBreak}],{skills,catalog});
  party[5]={...megumi,i:5,front:false};
  const enemy={...input.target.phases[0].enemies[0],hp:1e9,maxHp:1e9,
    pattern:{hp:{entries:[{order:1,skills:[1]}]}},skills:[{id:1,name:'shield hit',hitCount:1,parts:[{skillType:'AttackFixedDamageDefinitely',targetType:'All',power:[1e6,0]}]}]};
  return {party,enemy,statusTypes:skills.statusTypes};
}
const charges=st=>st.units[5].effects.find(e=>e.skillLabel==='MAikawaSkill07')?.uses||0;
const breakDp=u=>{u.dp=0;u.dpBroken=true;};

test('Tama Session automatically revives and heals everyone, consuming one charge per qualifying normal turn',()=>{
  const ctx=setup(4),st=initialState(ctx.party,ctx.enemy,{trace:true,statusTypes:skills.statusTypes});
  setPhase(st,[ctx.enemy]);startTurn(st);
  assert.equal(charges(st),3);assert.deepEqual(availableCommands(st),[]);
  assert.ok(!ctx.party[5].skills.some(s=>s.label==='MAikawaSkill07'));
  breakDp(st.units[0]);breakDp(st.units[1]);st.units[2].dp=1900;
  breakDp(st.units[4]);st.units[4].hp=0;st.units[4].down=true;
  st.units[0].sp=28;st.units[1].sp=33;
  const other=cloneState(st);
  st.od=100;startOverdrive(st,1,'turnStart');assert.equal(charges(st),3);endOdRound(st);
  st.units[0].extra=1;startExtraTurn(st);assert.equal(charges(st),3);endExtraTurn(st,[0]);
  startTurn(other);
  assert.deepEqual(other.units.slice(0,3).map(u=>u.dp),[5000,5000,6900]);
  assert.deepEqual([other.units[4].hp,other.units[4].dp,other.units[4].down],[0,0,true]);
  assert.deepEqual(other.units.slice(0,2).map(u=>u.sp),[30,33]);
  assert.equal(other.units[5].played,0);assert.equal(charges(other),2);assert.equal(charges(st),3);
  for(let i=0;i<3;i++){breakDp(other.units[0]);startTurn(other);}
  assert.equal(charges(other),0);assert.equal(other.units[0].dp,0);
  assert.equal(other.log.filter(e=>e.t==='autoSkill').length,3);
  other.killedTurn=other.turn;setPhase(other,[ctx.enemy]);
  assert.equal(charges(other),3);assert.equal(other.units[0].dp,0);
  startTurn(other);assert.equal(other.units[0].dp,5000);assert.equal(charges(other),2);
  other.killedTurn=other.turn;setPhase(other,[ctx.enemy]);
  assert.equal(charges(other),3);assert.equal(other.units[5].effects.filter(e=>e.skillLabel==='MAikawaSkill07').length,1);
});

test('a real published back-row Tama Session triggers on an enemy break and precedes the three action slots',()=>{
  const turn={front:[0,1,2],actions:[0,1,2].map(u=>({u,s:'normal'}))};
  const design={phases:[{turns:[turn,turn]}]};
  for(const lb of [0,4]){
    const sim=simulateDesign(setup(lb),{critMode:'none'},design);
    const events=sim.rows.filter(r=>r.kind==='autoSkill');
    assert.equal(events.length,1);
    const [event]=events;
    assert.equal(event.unit,5);assert.equal(event.skillId,'MAikawaSkill07');assert.equal(event.remaining,2);
    assert.equal(event.allies[0].dp,5000);assert.equal(event.turn,2);
    const opening=sim.rows.find(r=>r.kind==='turn'&&r.turn===1);
    assert.equal(event.sp[1]-opening.sp[1],lb===4?7:2);
    assert.equal(sim.rows.filter(r=>r.kind==='act'&&r.turn===2).length,3);
    assert.ok(sim.rows.indexOf(event)<sim.rows.findIndex(r=>r.kind==='round'&&r.turn===2));
    assert.equal(sim.failed,0);
  }
});

test('a fixed party can search and replay a three-turn clear that needs automatic DP revival',()=>{
  const ctx=setup(0),attack={...ctx.party[0].skills[0],sp:0};
  ctx.party=[ctx.party[0],ctx.party[1],ctx.party[5]].map((m,i)=>({...m,i,front:true,noNormal:true,skills:[attack]}));
  const opts={objective:'minTurns',beam:4,maxTurns:3,top:1,critMode:'none',allowOd:false,damageNorm:1e6};
  const probe=initialState(ctx.party,ctx.enemy,opts);startTurn(probe);
  for(const u of probe.units)act(probe,u.i,0);
  ctx.enemy.hp=ctx.enemy.maxHp=Math.round(probe.totalDamage*2.5);
  const best=search(ctx,opts).plans[0];
  assert.equal(best?.killedTurn,3);
  assert.equal(replay(ctx,opts,best.plan).killedTurn,3);
  assert.ok(!best.plan.some(p=>p.k==='command'));
  const control={...ctx,party:ctx.party.map(m=>({...m,passives:[]}))};
  assert.ok(!search(control,opts).plans.some(p=>p.killedTurn));
});
