// 每个实际行动轮一行，行动次序从左至右；事件留在触发它的那一行。
import {simulateDesign} from './sim/designer.mjs';

const roundLabel=r=>r==='extra'?'追加回合':/^od\d+$/.test(r)?'OD '+r.slice(2):'普通回合';

/** State the replay assumptions beside its events, rather than implying a guaranteed outcome. */
export function replayAssumptions(critMode='expected'){
  if(critMode==='none')return '不暴击、伤害浮动取中值的预测；破盾/击杀不是最低伤害保证。';
  if(critMode==='all')return '全暴击、伤害浮动取中值的预测；破盾/击杀以全暴击为前提，不代表实际必定暴击。';
  if(critMode==='random')return '一次随机样本回放；破盾/击杀仅对应本次样本。';
  return '按暴击概率加权的平均伤害预测；破盾/击杀不保证每次发生。';
}

export function groupAxisRows(rows){
  const out=[],byId=new Map();let pending=[];
  for(const r of rows){
    if(r.kind==='turn'||r.kind==='card'){pending=[];continue;}
    if(r.kind==='od'){
      const previous=out.at(-1);
      // 后开在普通/追加行动结束后发动，不能放到下一轮 OD 行动之后。
      if(r.window==='turnEnd'&&previous?.phase===r.phase&&previous.turn===r.turn)previous.after.push(r);
      else pending.push(r);
      continue;
    }
    if(r.kind==='round'){
      const row={...r,actions:[],events:[],before:pending,after:[]};pending=[];
      out.push(row);byId.set(r.roundId,row);continue;
    }
    const row=byId.get(r.roundId);
    if(!row)continue;
    if(r.kind==='act')row.actions.push(r);
    else if(['break','kill','transcend'].includes(r.kind))row.events.push(r);
  }
  return out;
}

export function renderAxisRows(rounds,{e,n,party}){
  const name=i=>party[i]?.name||'#'+i;
  const odAction=v=>`<div class="axis-od-action" data-od-window="${e(v.window)}" aria-label="${e(v.label)}"><b>${v.window==='turnEnd'?'后开 OD':'前开 OD'}</b><small>Lv.${e(String(v.level))}</small></div>`;
  return `<ol class="axis-turns">${rounds.flatMap(r=>{
    // 以计划顺序排三格；提前击杀仍保留后两人的位置，不能伪装成已行动。
    const planned=r.planned||[],used=new Set();
    const cells=planned.map(p=>{const at=r.actions.findIndex((a,i)=>!used.has(i)&&a.unit===p.unit&&a.skill===p.skill);
      if(at>=0){used.add(at);return {...r.actions[at],executed:true};}
      return {...p,executed:false};});
    r.actions.forEach((a,i)=>{if(!used.has(i))cells.push({...a,executed:true});});
    for(const unit of r.actors||[])if(!cells.some(a=>a.unit===unit))cells.push({unit,executed:false});
    while(cells.length<3)cells.push({empty:true});
    const chunks=Array.from({length:Math.ceil(cells.length/3)},(_,i)=>cells.slice(i*3,i*3+3));
    return chunks.map((chunk,ci)=>{
      while(chunk.length<3)chunk.push({empty:true});
      const events=r.events.filter(v=>v.unit==null?ci===0:chunk.some(a=>a.unit===v.unit));
      const stopped=r.events.some(v=>v.kind==='kill')&&r.actions.at(-1)?.enemy?.hp<=0;
      return `<li class="axis-row axis-${r.round==='extra'?'extra':r.round==='main'?'main':'inod'}" data-round="${e(r.round)}">
<div class="axis-t"><b>T${r.turn}</b><span>${e(roundLabel(r.round))}${ci?'（续）':''}</span>${r.parentRound?`<small>${e(roundLabel(r.parentRound))} 内</small>`:''}</div>
<div class="axis-body"><div class="axis-action-flow">${ci===0?(r.before||[]).map(odAction).join(''):''}<div class="axis-acts">${chunk.map((a,i)=>`<div class="axis-act${a.executed?'':' axis-skipped'}"><span class="axis-order">${ci*3+i+1}</span>${a.empty?`<span class="axis-empty">${r.round==='extra'?'无追加行动':'未安排行动'}</span>`:`<b>${e(name(a.unit))}</b><span>${e(a.skill||'未安排行动')}</span><small>${a.executed?`扣盾/血 ${n(a.damage||0)}${a.sp?.[a.unit]!=null?' · SP '+Math.round(a.sp[a.unit]*10)/10:''}`:a.skill?`未执行${stopped?'（已击杀）':''}`:r.round==='extra'?'有追加资格，未安排':'未安排'}</small>`}</div>`).join('')}</div>${ci===chunks.length-1?(r.after||[]).map(odAction).join(''):''}</div>
${events.length?`<div class="axis-events">${events.map(v=>`<span class="axis-event axis-${v.kind}">${v.unit!=null?e(name(v.unit))+' · ':''}${e(v.label)}</span>`).join('')}</div>`:''}</div></li>`;
    });
  }).join('')}</ol>`;
}

export function axisView({e,n,party,phases,statusTypes,design,critMode='expected',simulationOptions={enemyVariance:1.1,enemyTargeting:'worst'}}){
  const options={critMode,...simulationOptions,trace:true};
  const res=simulateDesign({party,phases,statusTypes},options,design);
  const rounds=groupAxisRows(res.rows),multi=phases.length>1;
  const html=phases.map((phase,p)=>{
    const rs=rounds.filter(r=>r.phase===p),cards=res.rows.filter(r=>r.phase===p&&r.kind==='card'),out=res.phases.find(x=>x.phase===p);
    if(!rs.length&&!cards.length)return '';
    return `<div class="axis-phase">${multi?`<h3>第 ${p+1} 阶段 <small>${e(phase.name||'')}${out?` · ${out.turns} 回合${out.cleared?'':' · <span class="pill-error">未击破</span>'}`:''}</small></h3>`:''}
${cards.length?`<p class="axis-card">${cards.map(c=>e(c.label)).join('　')}</p>`:''}${renderAxisRows(rs,{e,n,party})}</div>`;
  }).join('');
  const errors=res.issues.filter(x=>x.level!=='warn');
  return {html:`<p class="subtle compact axis-assumptions">${e(replayAssumptions(options.critMode))} 每次行动显示所有目标实际扣除 DP / HP 的合计，不是单个敌人的伤害跳字。</p>`+html+(errors.length?`<details class="axis-issues"><summary>${errors.length} 处行动在模拟里无法执行</summary><ul class="compact">${errors.slice(0,20).map(x=>`<li>T${x.turn}：${e(x.msg)}</li>`).join('')}</ul></details>`:''),
    summary:{turns:res.turns,cleared:res.phases.filter(x=>x.cleared).length,phases:phases.length,failed:!!res.failed,damage:res.phases.reduce((a,x)=>a+(x.damage||0),0)}};
}
