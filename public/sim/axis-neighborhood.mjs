import {CARDS} from './cards.mjs';
import {emptyTurn,monteCarlo,mulberry32,simulateDesign,skillChoices} from './designer.mjs';
import {canLimitDamage,initialState} from './hbr/battle.mjs';
import {selectableAllyTargets} from './search.mjs';
import {ATTACK_PART_TYPES} from './hbr/model.mjs';

function actionFeatures(skill){
  const features=new Set();
  function visit(parts){
    for(const p of parts||[]){
      features.add('effect/'+p.skillType);
      if(ATTACK_PART_TYPES.has(p.skillType))features.add('attack');
      if(p.targetType)features.add('target/'+p.targetType);
      for(const el of p.elements||[])features.add('element/'+el);
      for(const b of p.branches||[])visit(b.parts);
    }
  }
  visit(skill?.parts);return features;
}

/** Keep the other five actors' orders. Fit legal skills of the incoming
 * character to the effects used by the outgoing actor, then replay the axis. */
export function transferActorAxis(design,slot,oldUnit,party,capacity,rng){
  const copy=structuredClone(design),unit=party[slot],equipped=new Set(),mapping=new Map();
  const choices=new Set(skillChoices(unit).map(x=>x.s));
  const pool=unit.skills.filter(s=>choices.has(s.label)&&s.id>0);
  const features=new Map(pool.map(s=>[s,actionFeatures(s)]));
  const fit=label=>{
    if(mapping.has(label))return mapping.get(label);
    const old=oldUnit.skills.find(s=>s.label===label),want=actionFeatures(old);
    const available=pool.filter(s=>equipped.size<capacity||equipped.has(s.id));
    const evaluate=s=>{
      let value=-Math.abs((old?.sp||0)-(s.sp||0))*0.3+rng();
      for(const effect of want)if(features.get(s).has(effect))value+=effect.startsWith('effect/')?4:effect==='attack'?3:1;
      return value;
    };
    const same=available.find(s=>s.label===label)||unit.skills.find(s=>s.id<=0&&s.label===label&&choices.has(label));
    const ranked=same?[]:available.map(s=>({s,score:evaluate(s)})).sort((a,b)=>b.score-a.score);
    const pick=same||ranked[0]?.s;if(pick?.id>0)equipped.add(pick.id);
    mapping.set(label,pick);return pick;
  };
  for(const phase of copy.phases)for(const turn of phase.turns||[]){
    const ods=[turn.odStart,turn.odEnd,turn.od].filter(Boolean);
    const keepCommand=c=>c.u!==slot||unit.commandSkill?.label===c.s;
    for(const od of ods)if(od.commandsBefore)od.commandsBefore=od.commandsBefore.filter(keepCommand);
    for(const round of [turn,...ods.flatMap(o=>o.rounds||[])]){
      for(const key of ['commands','extraCommands'])if(round[key])round[key]=round[key].filter(keepCommand);
      for(const a of [...(round.actions||[]),...(round.extra||[])]){
        if(a.u!==slot||!a.s||a.s==='normal')continue;
        const oldLabel=a.s,s=fit(oldLabel);a.s=s?.label||'normal';
        if(a.s!==oldLabel)delete a.limiter;
        const targets=selectableAllyTargets(s,slot,party);
        if(!targets.length)delete a.target;
        else if(!targets.includes(a.target))a.target=targets[Math.floor(rng()*targets.length)];
      }
    }
  }
  return {design:copy,ids:[...equipped]};
}
import {elementSummary} from './optimizer-options.mjs';

const at=(root,path)=>path.reduce((node,key)=>node[key],root);
const swap=(list,i,j)=>{[list[i],list[j]]=[list[j],list[i]];};
function shuffle(list,rng){
  for(let i=list.length-1;i>0;i--)swap(list,i,Math.floor(rng()*(i+1)));
  return list;
}
function normalRound(round){
  return {front:round.front?.slice()||null,actions:structuredClone(round.actions||[]),extra:structuredClone(round.extra||[])};
}

function extraActors(ctx,design){
  const rounds=new WeakMap(),indices=new Map();
  for(const row of simulateDesign(ctx,{critMode:'expected'},design).rows){
    if(row.kind==='turn')indices.set(row.phase,(indices.get(row.phase)??-1)+1);
    if(row.kind!=='round'||row.round!=='extra')continue;
    const turn=design.phases[row.phase]?.turns[indices.get(row.phase)];
    if(!turn)continue;
    const od=row.odWindow==='turnStart'?(turn.odStart||turn.od):row.odWindow==='turnEnd'?(turn.odEnd||turn.od):null;
    const round=od?.rounds?.[Number(row.parentRound?.slice(2))-1]||turn;
    rounds.set(round,row.actors);
  }
  return rounds;
}

// Produce edits against the concrete equipped skill list. Replay checks the
// actual SP, remaining uses, OD, conditions and cross-phase consequences.
function editGroups(ctx,design,options,rng){
  const groups=new Map(),commandSlots=[],roundSlots=[],byActor=new Map();
  const add=(kind,edit)=>{if(!groups.has(kind))groups.set(kind,[]);groups.get(kind).push(edit);};
  const skills=ctx.party.map(m=>skillChoices(m).filter(x=>x.s).map(x=>x.s));
  const commands=options.commands;
  const extras=extraActors(ctx,design);
  let front=ctx.party.filter(m=>m.front).map(m=>m.i);
  function addRound(round,path){
    front=round.front||front;
    const active=front.slice();
    if(round.actions?.length)roundSlots.push({round,path,front:active,signature:JSON.stringify([active,round.actions,round.extra])});
    for(const field of ['actions','extra']){
      const actions=round[field]||[],listPath=[...path,field];
      for(const [i,a] of actions.entries()){
        if(!byActor.has(a.u))byActor.set(a.u,[]);
        byActor.get(a.u).push({action:a,path:[...listPath,i]});
        for(let j=i+1;j<actions.length;j++)add('order',d=>swap(at(d,listPath),i,j));
        const meta=ctx.party[a.u];if(!meta)continue;
        for(const label of skills[a.u]){
          const skill=meta.skills.find(s=>s.label===label);
          const targets=selectableAllyTargets(skill,a.u,ctx.party);
          for(const target of targets.length?targets:[undefined]){
            if(label===a.s&&target===a.target)continue;
            add('skill',d=>{at(d,listPath)[i]={u:a.u,s:label,...(target==null?{}:{target})};});
          }
        }
        const original=meta.skills.find(s=>s.label===a.s);
        if(canLimitDamage(meta,original))add('limiter',d=>{
          const action=at(d,listPath)[i];
          if(action.limiter)delete action.limiter;else action.limiter=true;
        });
        if(field!=='actions'||!active.includes(a.u))continue;
        for(const m of ctx.party.filter(m=>!active.includes(m.i)))for(const label of skills[m.i]){
          const skill=m.skills.find(s=>s.label===label);
          const targets=selectableAllyTargets(skill,m.i,ctx.party);
          for(const target of targets.length?targets:[undefined])add('front',d=>{
            const r=at(d,path);
            r.front=active.map(u=>u===a.u?m.i:u);
            r.actions[i]={u:m.i,s:label,...(target==null?{}:{target})};
          });
        }
      }
      const eligible=field==='actions'?active:extras.get(round)||[];
      for(const u of eligible.filter(u=>!actions.some(a=>a.u===u))){
        for(const label of skills[u]){
          const targets=selectableAllyTargets(ctx.party[u].skills.find(s=>s.label===label),u,ctx.party);
          for(const target of targets.length?targets:[undefined])add('fill',d=>{
            (at(d,path)[field]??=[]).push({u,s:label,...(target==null?{}:{target})});
          });
        }
      }
      if(field==='actions'||actions.length||eligible.length)commandSlots.push([...path,field==='actions'?'commands':'extraCommands']);
    }
  }
  const phases=design.phases,cards=phases.map(p=>p.card||null);
  for(const [p,phase] of phases.entries()){
    if(p&&options.optimizeCards){
      for(const card of [null,...CARDS.map(c=>c.id)]){
        if(card===cards[p]||card&&cards.includes(card))continue;
        add('card',d=>{d.phases[p].card=card;});
      }
      for(let q=p+1;q<phases.length;q++){
        if(cards[q]!==cards[p])add('cardOrder',d=>{d.phases[p].card=cards[q];d.phases[q].card=cards[p];});
        // An opener can enable a later payout. Try pairs without requiring a
        // single-card substitution to improve the axis first.
        const choices=CARDS.map(c=>c.id).filter(id=>!cards.some((c,i)=>c===id&&i!==p&&i!==q));
        for(const first of shuffle(choices.slice(),rng)){
          const seconds=choices.filter(id=>id!==first&&id!==cards[q]);
          if(first===cards[p]||!seconds.length)continue;
          const second=seconds[Math.floor(rng()*seconds.length)];
          add('cardPair',d=>{d.phases[p].card=first;d.phases[q].card=second;});
        }
      }
    }
    for(const [i,turn] of phase.turns.entries()){
      const path=['phases',p,'turns',i];
      if(phase.turns.length>1)add('turn',d=>{d.phases[p].turns.splice(i,1);});
      if(i+1<phase.turns.length)add('turn',d=>swap(d.phases[p].turns,i,i+1));
      if(phase.turns.length<options.maxTurns&&turn.actions?.length){
        add('turn',d=>{d.phases[p].turns.splice(i,0,{...emptyTurn(),...normalRound(turn)});});
      }
      for(const window of ['odStart','main','odEnd']){
        if(window==='main'){addRound(turn,path);continue;}
        const other=window==='odStart'?'odEnd':'odStart',od=turn[window];
        if(od){
          if(!turn[other])add('od',d=>{
            const t=at(d,path);t[other]=t[window];t[window]=null;
            if(other==='odEnd'&&t[other].commandsBefore?.length){
              t.commands=[...t[other].commandsBefore,...(t.commands||[])];delete t[other].commandsBefore;
            }
          });
          add('od',d=>{at(d,path)[window]=null;});
          if(window==='odStart')commandSlots.push([...path,window,'commandsBefore']);
          for(const [j,r] of (od.rounds||[]).entries())addRound(r,[...path,window,'rounds',j]);
        }
        for(let level=1;level<=3;level++){
          if(level===od?.level||!od&&!turn.actions?.length)continue;
          add('od',d=>{
            const t=at(d,path),entry=t[window]||{rounds:[]};
            entry.level=level;entry.rounds=(entry.rounds||[]).slice(0,level);
            while(entry.rounds.length<level)entry.rounds.push(normalRound(entry.rounds.at(-1)||t));
            t[window]=entry;
          });
        }
      }
    }
  }
  // Transfer a working buff/attack sequence together. Single substitutions
  // cannot reach a sequence if its new caster and beneficiary must both move.
  for(const source of roundSlots)for(const dest of roundSlots){
    if(source.signature===dest.signature)continue;
    add('round',d=>Object.assign(at(d,dest.path),normalRound({...source.round,front:source.front})));
  }
  // Move SP expenditure and limited uses to a different phase or turn while
  // retaining the actor, front, and number of casts in the design.
  for(const slots of byActor.values())for(let i=0;i<slots.length;i++)for(let j=i+1;j<slots.length;j++){
    const a=slots[i],b=slots[j];if(a.action.s===b.action.s&&a.action.target===b.action.target)continue;
    add('castTiming',d=>{
      at(d,a.path.slice(0,-1))[a.path.at(-1)]=structuredClone(b.action);
      at(d,b.path.slice(0,-1))[b.path.at(-1)]=structuredClone(a.action);
    });
  }
  for(const path of commandSlots){
    const node=d=>at(d,path.slice(0,-1)),field=path.at(-1);
    for(const c of commands)add('command',d=>{(node(d)[field]??=[]).push({...c});});
    for(const [i] of (node(design)[field]||[]).entries()){
      add('command',d=>node(d)[field].splice(i,1));
      for(const dest of commandSlots.filter(slot=>slot!==path))add('commandMove',d=>{
        const [c]=node(d)[field].splice(i,1);
        (at(d,dest.slice(0,-1))[dest.at(-1)]??=[]).push(c);
      });
    }
  }
  return shuffle([...groups].map(([kind,edits])=>({kind,edits:shuffle(edits,rng)})),rng);
}

function compare(a,b){
  for(let i=0;i<a.key.length;i++)if(a.key[i]!==b.key[i])return a.key[i]>b.key[i]?-1:1;
  return 0;
}

/** Explore even a successful incumbent. A stratified budget keeps front/OD/
 * sequence edits from being crowded out by the much larger skill/card lists.
 * The caller independently re-rates each shortlisted design with final MC. */
export function refineAxis(ctx,design,{seed=97,limit=72,samples=5,maxTurns=6,optimizeCards=true,
  scoreOf=null,goal='score',minSuccess=0,basis='onPlan',teamElement='',keep=5}={}){
  if(design.phases.some(p=>p.turns.some(t=>t.od?.level))){
    design=structuredClone(design);
    for(const phase of design.phases)for(const t of phase.turns){
      if(!t.od?.level)continue;
      const slot=t.od.window==='turnStart'?'odStart':t.od.window==='turnEnd'?'odEnd':null;
      if(slot)t[slot]??=t.od;
      delete t.od;
    }
  }
  const rng=mulberry32(seed),sampleSeed=(seed^0x65aa9d93)>>>0;
  const rate=d=>{
    const mc=monteCarlo(ctx,{},d,{n:samples,seed:sampleSeed,scoreOf});
    const score=mc.scoreMean??-Infinity,turns=-(mc.turnsMedian??Infinity);
    const metric=goal==='stable'?[mc.success,score,turns]:goal==='fast'?[turns,mc.success,score]:[score,mc.success,turns];
    const passes=mc[basis]>=minSuccess;
    const key=[Number(mc.successes>0),Number(passes),passes?0:mc[basis],...metric,mc.onPlan];
    return {design:d,mc,key};
  };
  const start=rate(design),archive=[],seen=new Set([JSON.stringify(design)]),tried={};
  const st=initialState(ctx.party,ctx.phases?.[0]?.enemies?.[0]||ctx.enemy,{statusTypes:ctx.statusTypes});
  const commands=st.units.filter(u=>u.commandRemaining>0&&u.commandSkill).map(u=>({u:u.i,s:u.commandSkill.label}));
  let parent=start,num=0;
  const perPass=Math.max(1,Math.ceil(limit/3));
  for(let pass=0;pass<3&&num<limit;pass++){
    const groups=editGroups(ctx,parent.design,{commands,maxTurns,optimizeCards},rng);
    const end=Math.min(limit,num+perPass),recent=[];
    while(groups.some(g=>g.edits.length)&&num<end){
      for(const group of groups){
        if(!group.edits.length||num>=end)continue;
        const next=structuredClone(parent.design);group.edits.pop()(next);
        const signature=JSON.stringify(next);if(seen.has(signature))continue;
        seen.add(signature);num++;tried[group.kind]=(tried[group.kind]||0)+1;
        if(teamElement){
          const check=simulateDesign(ctx,{critMode:'expected',trace:false,teamElement},next);
          if(!elementSummary(check.elementDamage,teamElement).elementMatch)continue;
        }
        const result=rate(next);
        if(result.mc.successes){archive.push(result);recent.push(result);}
      }
    }
    archive.sort(compare);
    // Try composing a second edit even across an intermediate score plateau.
    recent.sort(compare);
    parent=(pass===0?archive[0]:recent.find(r=>compare(r,start)!==0)||recent[0])||start;
  }
  const chosen=[],values=new Set();
  for(const result of archive){
    // Equivalent unused edits must not use up all independent validation slots.
    const key=result.key.join('|');if(values.has(key))continue;
    values.add(key);chosen.push(result.design);if(chosen.length===keep)break;
  }
  return {designs:chosen,tried,total:num};
}
