import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoadoutNeighborhood,supportFits} from '../public/sim/loadout-neighborhood.mjs';
import {buildParty} from '../public/sim/hbr/battle.mjs';
import {mulberry32} from '../public/sim/designer.mjs';

function fixture(){
  const styles=Array.from({length:9},(_,i)=>({id:'s'+i,name:'s'+i,characterId:'c'+i,tier:'SS',elements:['Ice']}));
  styles[6].characterId=styles[0].characterId;
  styles[8].elements=['Fire'];
  const entry=(sourceId,slot,props={})=>({sourceId,id:String(sourceId),name:String(sourceId),slot,effects:[],rollGroups:[],...props});
  const entries=[entry(10,'ring'),entry(11,'orb',{characterId:'c0'}),entry(20,'booster',{chipSlots:2}),
    entry(21,'booster',{chipSlots:1}),entry(30,'chip'),entry(31,'chip')];
  const items=[{masterId:10,instanceId:'a',main:[101],expansion:[42400011]},
    {masterId:10,instanceId:'b',main:[102],expansion:[42400012]},{masterId:11,instanceId:'p'}];
  const data={catalog:{styles,characters:[]},skills:{styles:{}},equipment:{entries},stats:{styles:{}}};
  const cards=styles.map(s=>({styleId:s.id,characterId:s.characterId,limitBreak:2,card:{level:3},character:{level:4},characterCards:[]}));
  const raws=cards.slice(0,6).map(c=>({...c,accessories:{}}));
  Object.assign(raws[0],{accessories:{ring:items[0],jewel:items[2]},boosterId:20,sphereIds:[30,31]});
  Object.assign(raws[1],{accessories:{ring:items[1]},boosterId:21,sphereIds:[30]});
  const cache={decks:[{members:raws},{members:raws}],cards,accessories:items};
  const set=createLoadoutNeighborhood({data,cache,baseRaws:raws});
  return {data,raws,items,cards,cache,set};
}
test('proposals use actual inventory, rolls and card progression, and preserve the input',()=>{
  const {raws,set,items,cards}=fixture(),saved=structuredClone(raws);
  const generate=()=>{
    const seq=[],rng=mulberry32(4925);
    for(const kind of ['equipment','support','booster','chip']){
      for(let n=0;n<24;n++){
        const next=set.propose(raws,rng,kind);assert.equal(next.kind,kind);
        assert.ok(set.valid(next.raws));assert.notDeepEqual(next.raws,raws);
        for(const m of next.raws){
          for(const a of Object.values(m.accessories))assert.deepEqual(a,items.find(x=>x.instanceId===a.instanceId));
          if(m.supportStyleId){const c=cards.find(x=>x.styleId===m.supportStyleId);assert.equal(m.supportLimitBreak,c.limitBreak);assert.deepEqual(m.support.card,c.card);}
        }
        seq.push(next);
      }
    }
    return seq;
  };
  assert.deepEqual(generate(),generate());
  assert.deepEqual(raws,saved);
});
test('rolled items, character-exclusive items, module copies, chip slots and support occupancy are checked',()=>{
  const {raws,set,items,cards}=fixture();
  const check=(i,patch)=>set.valid(raws.map((r,j)=>i===j?{...r,...patch}:r));
  assert.ok(set.valid(raws));
  assert.equal(check(0,{accessories:{ring:{...items[0],expansion:[42400012]}}}),false);
  assert.equal(check(1,{accessories:{jewel:items[2]}}),false);
  assert.equal(check(3,{accessories:{ring:items[0]}}),false);
  assert.equal(check(2,{boosterId:20}),false);
  assert.equal(check(1,{sphereIds:[30,31]}),false);
  assert.equal(check(1,{sphereIds:[31]}),false);
  assert.equal(check(0,{supportStyleId:'s1'}),false);
  assert.equal(check(0,{supportStyleId:'s8'}),false);
  assert.equal(check(0,{supportStyleId:'s9'}),false);
  assert.equal(check(0,{supportStyleId:'s6',supportLimitBreak:8}),false);
  assert.equal(check(0,{supportStyleId:'s6',support:cards[6],supportLimitBreak:2}),true);
  const dup=raws.map((r,i)=>i<2?{...r,supportStyleId:'s6'}:r);
  assert.equal(set.valid(dup),false);assert.ok(set.valid(set.repairSupports(dup)));
  assert.equal(set.repairSupports(dup)[1].supportStyleId,'s7');
  const empty=raws.map((r,i)=>i===0?{...r,_new:true,accessories:{}}:r);
  assert.equal(set.repairSupports(empty)[0].supportStyleId,'s6');
  assert.deepEqual(set.equipPersonal(empty[0]).accessories.jewel,items[2]);
  assert.equal(set.equipPersonal(empty[1]),empty[1]);
});
test('owned module counts beyond the recorded decks are searchable',()=>{
  const {data,cache,raws}=fixture();
  const archive={gameInventory:{entries:{20:{count:3},21:{count:1},30:{count:2},31:{count:2}}}};
  const set=createLoadoutNeighborhood({data,cache,baseRaws:raws,archive});
  assert.ok(set.valid([...raws.slice(0,2),{...raws[2],boosterId:20,sphereIds:[31]},...raws.slice(3)]));
  const latest=createLoadoutNeighborhood({data,cache:{...cache,moduleCounts:{20:1,21:1,30:2,31:1}},baseRaws:raws,archive});
  assert.ok(latest.valid(raws));
  assert.equal(latest.valid([...raws.slice(0,2),{...raws[2],boosterId:20},...raws.slice(3)]),false);
});
test('supports match elements, including Void and elementless, and only a resonance main activates the passive',()=>{
  const {data}=fixture(),[main]=data.catalog.styles;
  const support=data.catalog.styles[6];
  assert.ok(supportFits(main,support));
  assert.ok(supportFits({...main,elements:['Fire','Ice']},support));
  assert.ok(supportFits({...main,elements:['Void']},support));
  assert.equal(supportFits({...main,elements:['Void']},{...support,elements:[]}),false);
  assert.ok(supportFits({...main,elements:[]},{...support,elements:[]}));
  assert.equal(supportFits({...main,tier:'S'},support),false);
  data.stats={styles:{s6:{resonance:'r'}},supportSkills:{r:[{lb:2,passive:{name:'Resonance',parts:[]}}]}};
  const active=(resonanceShift=false)=>buildParty([{styleId:main.id,stats:{},supportStyleId:'s6',supportLimitBreak:2,resonanceShift}],data)[0].passives.some(p=>p.source==='support:s6');
  assert.equal(active(),false);
  assert.equal(active(true),true);
  main.tier='SSR';assert.equal(active(),true);
});
