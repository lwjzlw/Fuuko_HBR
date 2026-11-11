import {simulateDesign,mulberry32,monteCarloSampleSeed,emptyTurn} from './designer.mjs';

// The replay reports the exact failed instruction. Index by object identity:
// early kills can skip turns, so a global turn number is not a design offset.
function indexDesign(design){
  const nodes=new WeakMap();
  function visit(value,path){
    if(!value||typeof value!=='object')return;
    nodes.set(value,path);
    for(const [key,child] of Object.entries(value))visit(child,[...path,key]);
  }
  visit(design,[]);return nodes;
}
const at=(obj,path)=>path.reduce((value,key)=>value[key],obj);
function compare(a,b){
  for(let i=0;i<a.key.length;i++)if(a.key[i]!==b.key[i])return b.key[i]-a.key[i];
  return 0;
}

function probe(ctx,design,n,seed){
  const nodes=indexDesign(design),spots=new Map();
  let wins=0,legalPhases=0,totalClears=0,errors=0,progress=0,turns=0;
  for(let i=0;i<n;i++){
    const hit=[];
    const res=simulateDesign(ctx,{critMode:'random',enemyVariance:'random',enemyTargeting:'random',
      rng:mulberry32(monteCarloSampleSeed(seed,i)),trace:false,onUnavailable:e=>hit.push(e)},design);
    const cleared=res.phases.filter(p=>p.cleared).length,bad=res.issues.filter(e=>e.level==='error').length;
    if(!res.failed&&!bad&&cleared===ctx.phases.length)wins++;
    legalPhases+=hit.length?Math.min(cleared,hit[0].phase):cleared;
    totalClears+=cleared;errors+=bad;turns+=res.turns;
    const remaining=res.final.enemy.dp+res.final.enemy.hp;
    const phase=ctx.phases[res.phases.length-1],max=phase.enemies.reduce((v,e)=>v+(e.maxDp||0)+(e.maxHp||0),0);
    progress+=1-Math.min(1,remaining/Math.max(1,max));
    const seen=new Set();
    for(const [j,failure] of hit.entries()){
      const path=nodes.get(failure.node);if(!path)continue;
      const key=JSON.stringify(path);if(seen.has(key))continue;seen.add(key);
      if(!spots.has(key))spots.set(key,{path,kind:failure.kind,weight:0,choices:new Map(),levels:new Set()});
      const spot=spots.get(key);spot.weight+=j===0?3:1;
      for(const {s,cost} of failure.choices||[]){
        const old=spot.choices.get(s)||{s,cost,count:0};old.count++;spot.choices.set(s,old);
      }
      for(const level of failure.levels||[])spot.levels.add(level);
    }
    const last=res.phases.at(-1);
    if(last&&!last.cleared&&!res.failed){
      const count=design.phases[last.phase].turns.length;
      const path=['phases',String(last.phase),'turns',String(count-1)],key=JSON.stringify(path);
      if(count&&!spots.has(key))spots.set(key,{path,kind:'finish',weight:0});
      if(count)spots.get(key).weight+=hit.length?0.5:2;
    }
  }
  return {design,spots:[...spots.values()].sort((a,b)=>b.weight-a.weight),key:[wins,legalPhases,totalClears,-errors,progress,-turns]};
}

function neighbors(current,ctx,maxTurns){
  const designs=[];
  for(const spot of current.spots.slice(0,2)){
    const path=spot.path,p=Number(path[1]),t=Number(path[3]);
    const mutate=edit=>{const d=structuredClone(current.design),turn=d.phases[p].turns[t];edit(d.phases[p].turns,turn,d);designs.push(d);};
    if(spot.kind==='skill'){
      const old=at(current.design,path);
      const allowed=[...spot.choices.values()].sort((a,b)=>b.count-a.count||a.cost-b.cost);
      const labels=new Set([allowed.find(x=>x.s==='normal')?.s,...allowed.slice(0,3).map(x=>x.s),allowed.slice().sort((a,b)=>b.cost-a.cost)[0]?.s]);
      for(const label of labels)if(label&&label!==old.s)mutate((_,turn,d)=>{
        const action=at(d,path);action.s=label;delete action.target;delete action.backup;
      });
    }else if(spot.kind==='od'){
      const slot=path.at(-1);
      mutate((_,turn)=>{turn[slot]=null;});
      for(const level of spot.levels)mutate((_,turn)=>{turn[slot].level=level;turn[slot].rounds=turn[slot].rounds.slice(0,level);});
      if(slot==='odStart'&&!current.design.phases[p].turns[t].odEnd)mutate((_,turn)=>{turn.odEnd=turn[slot];turn[slot]=null;});
    }else if(current.design.phases[p].turns.length<maxTurns){
      // Write the extra turn into the plan itself. Its costs and any enemy
      // actions are included in the on-plan replay.
      mutate((turns,turn)=>{
        const round=turn.actions?.length?turn:turn.odEnd?.rounds?.at(-1)||turn.odStart?.rounds?.at(-1)||turn;
        turns.push({...emptyTurn(),front:round.front,actions:structuredClone(round.actions||[])});
      });
    }
    // A separate normal turn preserves the original skill, lets the front
    // generate OD, and pays the cost of the intervening enemy attack in replay.
    const original=current.design.phases[p].turns[t];
    const front=original.front||original.odStart?.rounds?.[0]?.front||original.odEnd?.rounds?.[0]?.front||ctx.party.filter(m=>m.front).map(m=>m.i);
    if(current.design.phases[p].turns.length<maxTurns&&front.length===3)mutate(turns=>{
      const actions=front.filter(u=>!ctx.party[u].noNormal||ctx.party[u].skills.some(s=>/CommandBuff$/.test(s.label)&&!s.sp)).map(u=>({u,s:'normal'}));
      turns.splice(t,0,{...emptyTurn(),front:front.slice(),actions});
    });
  }
  return designs;
}

/** Improve a static design on common discovery samples. The caller rates the
 * concrete designs again on its independent final Monte Carlo seed. */
export function repairDesign(ctx,design,{maxTurns=6,samples=5,seed=104729,limit=54}={}){
  const start=probe(ctx,design,samples,seed);
  if(start.key[0]===samples||!start.spots.length)return [];
  let beam=[start],best=start,tried=0;
  const seen=new Set([JSON.stringify(design)]),improved=[];
  for(let depth=0;depth<6&&tried<limit;depth++){
    const pool=[];
    for(const parent of beam)for(const next of neighbors(parent,ctx,maxTurns)){
      if(tried>=limit)break;
      const key=JSON.stringify(next);if(seen.has(key))continue;seen.add(key);tried++;
      const rated=probe(ctx,next,samples,seed);
      if(compare(rated,parent)<0)pool.push(rated);
    }
    if(!pool.length)break;
    pool.sort(compare);beam=pool.slice(0,2);
    if(compare(beam[0],best)<0){best=beam[0];improved.push(best);}
    if(best.key[0]===samples)break;
  }
  return improved.reverse().slice(0,2).map(x=>x.design);
}
