import {scoreAttackScore,scoreCurve,damageNeeded,weaknessSummary,debuffSummary,predictActions,describeSkill,ruleSchedule,ruleWeeks,rulesOn,stageEnemies,turnLimit,exitText,ELEMENT_LABEL} from './boss-model.mjs';

const skillName=k=>k.name||(k.label?'（无名）'+String(k.label).split('_').pop():'#'+k.id);
const KIND_LABEL={scoreAttack:'积分挑战',dimension:'异时层'};
const GROUP_LABEL={main:'',central:'中央',satellite:'卫星',ex:'EX'};
const PHASE_LABEL={dp:'破盾前（DP 阶段）',hp:'破盾后（HP 阶段）'};

export function createBossUI(ctx){
  const {e,n,notice}=ctx;
  let index=null,loadError=null,kind='scoreAttack',query='',label='',stageIdx=-1,enemyLabel='';
  let calc={turns:1,damage:'',noBreak:true,rules:[],target:''};
  const cache=new Map();
  const date=x=>x?String(x).slice(0,10):'—';

  async function loadIndex(){
    if(index||loadError)return;
    try{const r=await fetch('/data/bosses/index.json',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);index=await r.json();}
    catch(err){loadError=err;}
  }
  async function loadEvent(entry){
    if(!cache.has(entry.file)){
      const r=await fetch('/data/bosses/'+entry.file,{cache:'no-store'});if(!r.ok)throw Error('Boss 数据加载失败：HTTP '+r.status);
      cache.set(entry.file,await r.json());
    }
    return cache.get(entry.file);
  }

  async function mount(host){
    if(!index&&!loadError){host.innerHTML='<p class="subtle">正在加载 Boss 目录…</p>';await loadIndex();}
    if(loadError){host.innerHTML=`<div class="note"><b>Boss 目录未生成或加载失败</b><p>${e(loadError.message)}。在项目目录运行 <code>python scripts/build-bosses.py</code> 生成 <code>public/data/bosses/</code>。</p></div>`;return;}
    const list=index.events.filter(x=>x.kind===kind&&(!query||[x.name,x.label,...x.bosses].join(' ').toLowerCase().includes(query.toLowerCase())));
    if(!list.some(x=>x.label===label)){label=list[0]?.label||'';stageIdx=-1;enemyLabel='';}
    const entry=list.find(x=>x.label===label);
    let ev=null;
    if(entry){try{ev=await loadEvent(entry);}catch(err){notice(err.message);}}
    if(ev){
      if(stageIdx<0||stageIdx>=ev.stages.length)stageIdx=ev.stages.length-1;
      if(kind==='scoreAttack'&&!calc.rules.every(id=>ev.rules.some(r=>r.id===id)))calc.rules=[];
    }
    const stage=ev?.stages[stageIdx];
    const enemies=ev?stageEnemies(ev,stage):[];
    if(!enemyLabel||!enemies.some(x=>x.label===enemyLabel))enemyLabel=(enemies.find(x=>x.detail?.flags?.is_boss)||enemies[0])?.label||'';
    const foe=enemies.find(x=>x.label===enemyLabel);

    host.innerHTML=`
<div class="note"><b>数据来源 · hbr.quest 公开主数据</b><p class="compact">生成于 ${e(date(index.generatedAt))}。数值是主数据原值；<b>行动顺序、规则生效回合和计分公式</b>是推定或第三方实现，标“推定”的地方需游戏内核对。</p></div>
<section class="panel spaced boss-pick">
  <div class="field-grid">
    <label>玩法<select id="boss-kind">${Object.entries(KIND_LABEL).map(([k,t])=>`<option value="${k}" ${k===kind?'selected':''}>${t}（${index.events.filter(x=>x.kind===k).length}）</option>`).join('')}</select></label>
    <label>搜索 Boss／期数<input id="boss-query" value="${e(query)}" placeholder="如 モール、104"></label>
    <label class="full">期数<select id="boss-event">${list.map(x=>`<option value="${e(x.label)}" ${x.label===label?'selected':''}>${e(x.name)} · ${e(x.bosses.slice(0,2).join('、'))} · ${date(x.inDate)}</option>`).join('')}</select></label>
  </div>
</section>
${ev?eventView(ev,stage,enemies,foe):'<p class="subtle">没有匹配的期数。</p>'}`;
    bind(host,ev);
  }

  function eventView(ev,stage,enemies,foe){
    const weeks=ruleWeeks(ev),limit=ev.kind==='scoreAttack'?turnLimit(ev.scoreCalc,stage):0;
    return `
<section class="panel spaced">
  <div class="split-heading"><h2>${e(ev.name)} <small class="subtle">${e(ev.label)}</small></h2><span class="tag">${date(ev.inDate)} – ${date(ev.outDate)}</span></div>
  ${ev.recommend?`<p class="subtle compact">${e(ev.recommend)}</p>`:''}
  ${ev.styleBonus?.length?`<p class="compact">编成加成：${ev.styleBonus.map(b=>`${e(ELEMENT_LABEL[String(b.type).toLowerCase()]||b.type||b.style)} DP+${b.dp} 能力+${b.status}`).join('；')}</p>`:''}
  <label>难度<select id="boss-stage">${ev.stages.map((s,i)=>`<option value="${i}" ${i===stageIdx?'selected':''}>${GROUP_LABEL[s.group]?GROUP_LABEL[s.group]+' · ':''}Lv.${s.difficulty} ${e(s.difficultyName)}</option>`).join('')}</select></label>
  <div class="table-wrap"><table><thead><tr><th>敌人</th><th>DP</th><th>HP</th><th>攻击倍率</th><th>参数基准</th><th>破坏率 每hit／上限</th></tr></thead><tbody>
  ${enemies.map(x=>`<tr class="${x.label===foe?.label?'active-row':''}"><td><button class="link" data-enemy="${e(x.label)}">${e(x.name||x.label)}</button>${x.detail?.flags?.is_boss?' <span class="tag">Boss</span>':''}</td><td>${n(x.dp)}</td><td>${n(x.hp)}</td><td>${x.attackRate??'—'}</td><td>${x.paramBorder??'—'}</td><td>${destruction(x)}</td></tr>`).join('')}
  </tbody></table></div>
  ${ev.kind==='scoreAttack'?`<p class="subtle compact">基础分 ${n(stage.baseScore)} · 伤害上限 ${n(stage.damageCap)} · NoBreak +${n(stage.noBreakBonus)} · 回合上限 ${limit}</p>`:''}
  ${stage.rules?.length||stage.enchant?`<details open><summary>本关规则</summary>${[...(stage.rules||[]),...(stage.enchant?[stage.enchant]:[])].map(r=>ruleRow(r,limit||30)).join('')}</details>`:''}
</section>
${foe?enemyView(foe):''}
${weeks.length?`<section class="panel spaced"><h2>特殊规则 <small class="subtle">每期可选 ${ev.maxRules||1} 条</small></h2>${weeks.map(w=>`<h3 class="compact">${date(w.inDate)} – ${date(w.outDate)}</h3>${w.rules.map(r=>ruleRow(r,limit||30,ev.kind==='scoreAttack')).join('')}`).join('')}</section>`:''}
${ev.kind==='scoreAttack'&&ev.scoreCalc?.tmdc?scoreView(ev,stage):''}`;
  }

  function destruction(x){
    const d=x.destruction||[x.detail?.base?.d_rate,x.detail?.base?.max_d_rate];
    return Array.isArray(d)&&d[0]!=null?`${d[0]}% ／ ${d[1]}%`:'—';
  }

  function ruleRow(r,limit,selectable=false){
    const turns=ruleSchedule(r,limit),checked=calc.rules.includes(r.id);
    const when=turns.length?(turns.length>6?`第 ${turns.slice(0,4).join('、')}… 回合（共 ${turns.length} 次）`:`第 ${turns.join('、')} 回合`):r.timing.filter(t=>t&&t!=='None').join('/')||`类型 ${r.type||'—'}`;
    return `<div class="rule-row">${selectable?`<label class="inline"><input type="checkbox" data-rule="${r.id}" ${checked?'checked':''}>`:'<div class="inline">'}<b>${e(r.name||r.nameJa)}</b>${r.grade?` <span class="tag">+${r.grade}%</span>`:''}${selectable?'</label>':'</div>'}
<p class="compact">${e(r.desc)}</p><p class="subtle compact">对象 ${e(r.target||'—')} · 生效 ${e(when)} <span title="按 interval／term 推算，未经游戏核对">（推定）</span>${r.parts.map(p=>` · ${e(p.skillType)}${p.power?` ${p.power[0]}`:''}${p.targetCondition?` [${e(p.targetCondition)}]`:''}${p.exit?.cond&&p.exit.cond!=='None'?` ${e(exitText(p.exit))}`:''}`).join('')}</p></div>`;
  }

  function enemyView(x){
    const d=x.detail;
    if(!d)return `<section class="panel spaced"><h2>${e(x.name||x.label)}</h2><p class="subtle">没有这个敌人的详情数据。</p></section>`;
    const w=weaknessSummary(d),deb=debuffSummary(d),phases=Object.keys(d.pattern||{});
    return `<section class="panel spaced">
  <div class="split-heading"><h2>${e(d.name)} <small class="subtle">${e(d.nameJa)}</small></h2><span class="tag">${e(d.label)}</span></div>
  <h3 class="compact">属性／攻击类型 <small class="subtle">数值&lt;0 为弱点，&gt;0 为耐性</small></h3>
  <div class="tags">${w.rows.map(r=>`<span class="tag res-${r.kind}">${e(r.label)} ${r.value>0?'+':''}${r.value}</span>`).join('')}${w.absorb?.length?`<span class="tag res-resist">吸收 ${e(w.absorb.join('/'))}</span>`:''}</div>
  ${deb.length?`<h3 class="compact">异常抗性</h3><div class="tags">${deb.map(r=>`<span class="tag">${e(r.label)} ${r.value}</span>`).join('')}</div>`:''}
  ${d.extraGauge?`<p class="compact">额外量表：${e(JSON.stringify(d.extraGauge))}</p>`:''}
  <h3>技能</h3>
  <div class="table-wrap"><table><thead><tr><th>技能</th><th>内容</th><th>参照属性</th></tr></thead><tbody>
  ${d.skills.map(s=>{const atk=s.parts.find(p=>p.skillType==='AttackSkill');return `<tr><td>${e(skillName(s))}<br><small class="subtle">#${s.id}</small></td><td>${e(describeSkill(s))}${s.hitRatios.length?`<br><small class="subtle">hit 比例 ${s.hitRatios.join(' / ')}</small>`:''}</td><td>${atk?e(Object.entries(atk.parameters||{}).map(([k,v])=>`${k}×${v}`).join(' ')):'—'}</td></tr>`;}).join('')}
  </tbody></table></div>
  <h3>行动预测 <small class="subtle">按 order 循环（推定）</small></h3>
  ${phases.length?`<div class="cols">${phases.map(ph=>{const p=predictActions(d,ph,8);return `<div><h4 class="compact">${e(PHASE_LABEL[ph]||ph)}</h4>${p.uncertain?'<p class="pill-error compact">含权重或条件分支，顺序可能变化</p>':''}<ol class="boss-actions">${p.steps.map(s=>`<li value="${s.turn}">${s.turn===0?'<b>先制</b> ':''}${s.skills.map(k=>e(skillName(k))).join(' + ')}${s.once?' <small>（一次）</small>':''}${s.condition?` <small class="subtle">[${e(s.condition)}]</small>`:''}</li>`).join('')}</ol></div>`;}).join('')}</div>`:'<p class="subtle">没有行动表数据。</p>'}
</section>`;
  }

  function scoreView(ev,stage){
    const chosen=ev.rules.filter(r=>calc.rules.includes(r.id)),limit=turnLimit(ev.scoreCalc,stage);
    const damage=Number(calc.damage)||stage.damageCap||0;
    const r=scoreAttackScore({calc:ev.scoreCalc,stage,rules:chosen,turns:Number(calc.turns)||1,damage,noBreak:calc.noBreak});
    const curve=scoreCurve({calc:ev.scoreCalc,stage,rules:chosen,damage,noBreak:calc.noBreak,maxTurns:Math.min(limit,10)});
    const target=Number(calc.target)||0;
    const need=target?curve.map(row=>({turns:row.turns,damage:damageNeeded({calc:ev.scoreCalc,stage,rules:chosen,turns:row.turns,noBreak:calc.noBreak,target})})):[];
    return `<section class="panel spaced"><h2>计分试算 <small class="subtle">公式参照 hbr.quest 计算器，未经游戏结算核对</small></h2>
<div class="field-grid">
  <label>通关回合<input id="score-turns" type="number" min="1" max="${limit}" value="${e(calc.turns)}"></label>
  <label>计分伤害（单回合最大）<input id="score-damage" type="number" min="0" value="${e(calc.damage)}" placeholder="${stage.damageCap||0}"></label>
  <label>目标总分（可选）<input id="score-target" type="number" min="0" value="${e(calc.target)}"></label>
  <label class="inline"><input id="score-nb" type="checkbox" ${calc.noBreak?'checked':''}>NoBreak</label>
</div>
<p class="subtle compact">规则加成在上方“特殊规则”里勾选（${chosen.length?chosen.map(x=>e(x.name)).join('、'):'未选'}）；伤害留空时按伤害上限 ${n(stage.damageCap)} 计算。</p>
${r.valid?`<div class="result-metrics"><div><strong>${n(r.total)}</strong><span>总分</span></div><div><strong>${n(r.base)}</strong><span>基础分</span></div><div><strong>${n(r.damage)}</strong><span>伤害分</span></div><div><strong>${n(r.noBreak)}</strong><span>NoBreak</span></div><div><strong>×${r.turnMultiplier??'—'}</strong><span>回合倍率</span></div><div><strong>×${r.ruleMultiplier.toFixed(2)}</strong><span>规则倍率</span></div></div>`:`<p class="pill-error">${e(r.reason)}</p>`}
<div class="table-wrap"><table><thead><tr><th>回合</th>${curve.map(c=>`<th>${c.turns}</th>`).join('')}</tr></thead><tbody>
<tr><td>倍率</td>${curve.map(c=>`<td>${c.turnMultiplier??'—'}</td>`).join('')}</tr>
<tr><td>总分</td>${curve.map(c=>`<td>${n(c.total)}</td>`).join('')}</tr>
${need.length?`<tr><td>达标所需伤害</td>${need.map(x=>`<td>${x.damage==null?'不可达':n(x.damage)}</td>`).join('')}</tr>`:''}
</tbody></table></div></section>`;
  }

  function bind(host,ev){
    const on=(sel,type,fn)=>{const el=host.querySelector(sel);if(el)el.addEventListener(type,fn);};
    on('#boss-kind','change',x=>{kind=x.target.value;label='';mount(host);});
    on('#boss-query','change',x=>{query=x.target.value.trim();mount(host);});
    on('#boss-event','change',x=>{label=x.target.value;stageIdx=-1;enemyLabel='';calc.rules=[];mount(host);});
    on('#boss-stage','change',x=>{stageIdx=Number(x.target.value);enemyLabel='';mount(host);});
    host.querySelectorAll('[data-enemy]').forEach(b=>b.onclick=()=>{enemyLabel=b.dataset.enemy;mount(host);});
    host.querySelectorAll('[data-rule]').forEach(c=>c.onchange=()=>{
      const id=Number(c.dataset.rule),max=ev?.maxRules||1;
      calc.rules=c.checked?[...calc.rules.filter(x=>x!==id),id].slice(-max):calc.rules.filter(x=>x!==id);mount(host);
    });
    on('#score-turns','change',x=>{calc.turns=x.target.value;mount(host);});
    on('#score-damage','change',x=>{calc.damage=x.target.value;mount(host);});
    on('#score-target','change',x=>{calc.target=x.target.value;mount(host);});
    on('#score-nb','change',x=>{calc.noBreak=x.target.checked;mount(host);});
  }

  return {mount,rulesOn};
}
