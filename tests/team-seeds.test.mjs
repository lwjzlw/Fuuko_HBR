import test from 'node:test';
import assert from 'node:assert/strict';
import {synergyTeams} from '../public/sim/team-seeds.mjs';
import {mulberry32} from '../public/sim/designer.mjs';
import {optimizerInput} from './fixtures/optimizer-input.mjs';
import {optimize} from '../public/sim/optimizer.mjs';

test('ice anchor gets actual cross-element support and ignores self-only or wrong-element effects',()=>{
  const part=(skillType,targetType,power,el)=>({skillType,targetType,power:[power,0],elements:el?[el]:[]});
  const parts=[
    part('AttackSkill','Single',50000,'Ice'),
    part('AttackUp','AllyAll',1,'Ice'),part('CriticalDamageUp','AllyFront',1),
    part('AdditionalTurn','AllySingle',1),part('HealSp','AllyAll',5),part('DefenseDown','Single',1,'Ice'),
    part('AttackUp','Self',99,'Ice'),part('AttackUp','AllyAll',99,'Fire'),part('NoEffect','Self',50)
  ];
  const pool=parts.map((_,i)=>({s:{characterId:'m'+i,role:'Healer',elements:['Fire']},c:{styleId:'s'+i,limitBreak:0}}));
  const styles=Object.fromEntries(parts.map((p,i)=>['s'+i,{skills:[{label:'a'+i,sp:2,parts:[p]}]}]));
  styles.s0.skills=[];styles.other={skills:[{label:'shared ice',parts:[parts[0]]}]};
  const get=()=>synergyTeams(pool,{styles},{elements:['ice'],count:2,rng:mulberry32(97),owned:[['m0',['other']]]});
  const teams=get();assert.deepEqual(teams,get());assert.equal(teams.length,2);
  for(const t of teams){
    assert.equal(t.cards[0].styleId,'s0');
    assert.deepEqual(t.cards.map(c=>c.styleId).sort(),['s0','s1','s2','s3','s4','s5']);
  }
  styles.other.skills[0].restricted=true;
  assert.deepEqual(get(),[]);
});

test('cold-start long-search dispatches synergy and random teams in separate slots',async()=>{
  const input=optimizerInput({count:14,opts:{longSearch:true,longPassKind:'explore',broad:true,randomSeeds:4,teamElement:'ice'}});
  const sent=[];
  await optimize(input,()=>{},{size:1,async run(task){
    if(task.type==='eval')sent.push(task.cand);
    return {r:null};
  }});
  const synergy=sent.filter(c=>c.origin==='synergy');
  assert.ok(synergy.length>0&&synergy.length<=4);
  assert.ok(sent.some(c=>c.origin==='random'));
  assert.ok(synergy.every(c=>new Set(c.raws.map(r=>r.characterId)).size===6));
});
