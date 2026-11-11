import {buildEnemy} from './sim/hbr/battle.mjs';

export const BATTLE_MODEL_VERSION='2026-11-11-known-party-v3';
export function enemyContextKey(phases,{wave=null}={}){
  return JSON.stringify({wave:wave?{difficulty:Number(wave.difficulty||40),international:wave.international!==false,overkill:wave.overkill!==false}:null,
    phases:phases.map(p=>p.enemies.map(x=>({label:x.label,dp:x.dp,hp:x.maxHp,border:x.border,
    weaknesses:x.weaknesses,destruction:x.destruction,destructionLimit:x.destructionLimit,odRate:x.odRate})))});
}
export const resultMatchesEnemies=(result,key)=>result?.battleVersion===BATTLE_MODEL_VERSION&&result.enemyContextKey===key;
export const sameRuleIds=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());

/** Local static tables stay outside the public catalog. Join by phase and enemy
 * label, preserving the original public stage identity for saved overrides. */
export function withEnemyParameters(event,supplement){
  if(event.kind!=='wave'||!supplement?.events?.[event.label])return event;
  const difficultyStages={},parameterIssues={};
  for(const [difficulty,stages] of Object.entries(supplement.events[event.label].difficultyStages||{})){
    try{
    if(!Array.isArray(stages)||stages.length!==event.stages.length)throw Error('本机敌方参数的阶段数量不匹配');
    const seen=new Set();
    difficultyStages[difficulty]=stages.map(s=>{
      const original=event.stages.find(x=>x.phase===s.phase);
      if(!original||seen.has(s.phase))throw Error('本机敌方参数的阶段编号不匹配');
      seen.add(s.phase);
      const remaining=(original.enemies||[]).filter(x=>x.label).slice();
      const enemies=s.enemies.map(x=>{
        const i=remaining.findIndex(y=>y.label===x.label);
        if(i<0)throw Error('本机敌方参数与公开敌人标签不匹配');
        const [base]=remaining.splice(i,1);
        return {...base,...x};
      });
      if(remaining.length)throw Error('本机敌方参数缺少敌人');
      return {...original,enemies,difficulty:Number(difficulty),battleLabel:s.battleLabel,
        parameterSource:{...s.parameterSource,kind:'installed-game-static',difficultyVerified:true}};
    }).sort((a,b)=>a.phase-b.phase);
    }catch(err){
      // Missing low-difficulty enemy variants must not invalidate other levels.
      // Selecting this level fails explicitly instead of borrowing another enemy.
      parameterIssues[difficulty]=err.message;
    }
  }
  return {...event,difficultyStages,parameterIssues};
}
export function plannerStages(event,stage,waveSettings={}){
  if(event.kind!=='wave')return [stage];
  const difficulty=String(Number(waveSettings.difficulty||40));
  if(event.parameterIssues?.[difficulty])throw Error(`难度 ${difficulty} 的敌人资料不完整：${event.parameterIssues[difficulty]}。请先更新 Boss 目录。`);
  return event.difficultyStages?.[difficulty]||event.stages;
}

export const enemyParameterKey=(stage,enemy,difficulty=null)=>JSON.stringify([stage.label??stage.id??stage.phase,difficulty,enemy.label]);

export function enemyOverridesFor(event,stage,enemy,{waveSettings={},overrides={}}={}){
  const difficulty=event.kind==='wave'?Number(waveSettings.difficulty||40):null;
  // Observed in game for this event/level; never infer a DP/HP scaling curve.
  const confirmed=!stage.parameterSource?.difficultyVerified&&event.kind==='wave'&&event.label==='WaveBattle0008'&&difficulty===40?{border:775}:{};
  return {...confirmed,...overrides[enemyParameterKey(stage,enemy,difficulty)]};
}

/** One path for the optimizer, replay, calculator and single-target search. */
export function plannerPhases(event,stage,{rules=[],enemyLabel='',waveSettings={},overrides={}}={}){
  const stages=plannerStages(event,stage,waveSettings);
  return stages.map(s=>{
    const options={rules,parameterOverride:null};
    const all=(s.enemies||[]).filter(x=>x?.label);
    const chosen=event.kind==='wave'?all:[all.find(x=>x.label===enemyLabel)||all.find(x=>event.enemies?.[x.label]?.flags?.is_boss)||all[0]];
    const enemies=chosen.filter(Boolean).map(x=>buildEnemy(event,s,{...options,enemyLabel:x.label,parameterOverride:enemyOverridesFor(event,s,x,{waveSettings,overrides})}));
    if(!enemies.length)throw Error('这一档没有敌人数据');
    return {name:enemies.map(x=>x.name).filter((v,i,a)=>a.indexOf(v)===i).join('、'),enemies};
  });
}
