// 排轴器页签：当期任务 → 求最佳轴（组队 + 规则 + 排轴 + 随机模拟）→ 只读的最佳轴；
// 固定配队、特殊规则、单队排轴、逐回合设计器、伤害计算器收在“更多细致选项”里。
// 规则与公式按社区计算器 hbr-calculator.com（Calculator + Planner 模块）重写，见 public/sim/hbr/。
import {buildParty,buildEnemy,initialState,applyEffectsOnly,previewAttack} from './sim/hbr/battle.mjs';
import {membersFromDeck} from './sim/hbr/deck.mjs';
import {computePanel} from './sim/hbr/stats.mjs';
import {ATTACK_PART_TYPES} from './sim/hbr/model.mjs';
import {STATS} from './sim/hbr/rules.mjs';
import {OBJECTIVES} from './sim/search.mjs';
import {emptyPlanner,membersFrom,estimateStats,STAT_LABEL} from './sim/party.mjs';
import {turnLimit,waveRoundScore} from './boss-model.mjs';
import {renderDesigner} from './designer-ui.mjs';
import {designFromPlan,emptyDesign} from './sim/designer.mjs';
import {cardById} from './sim/cards.mjs';
import {cardSeenProb} from './sim/optimizer.mjs';
import {axisView} from './planner-axis.mjs';
import {loadoutDetailsHtml} from './planner-loadout.mjs';
import {TEAM_ELEMENTS,normalizeResultSettings,packOptimizationResult,scoreGap,ruleCombinations,successfulScores,optimizationScope,reusableCandidates,visibleCandidates} from './planner-results.mjs';
import {SEARCH_PRESETS} from './sim/optimizer-options.mjs';
import {plannerPhases,plannerStages,withEnemyParameters,enemyParameterKey,enemyContextKey,BATTLE_MODEL_VERSION,resultMatchesEnemies,sameRuleIds} from './planner-enemies.mjs';

const KIND_LABEL={scoreAttack:'积分挑战',dimension:'异时层',wave:'遭遇战'};
const CRIT_LABEL={expected:'期望值',none:'不暴击',all:'全暴击'};
const EARRING_LABEL={attacking:'进攻（对HP）',breaking:'BREAK（对DP）',devastating:'爆破（破坏率）'};
const ELEM_LABEL={fire:'火',ice:'冰',thunder:'雷',light:'光',dark:'暗',nonelemental:'无'};

export function createPlannerUI(ctx){
  const {e,n,notice,catalog,equipment,getArchive,save,cacheDecks}=ctx;
  let index=null,skills=null,statsData=null,enemyParameters=null,loadError=null,worker=null,result=null,progress=null,shown=0,decks=null,lastParty=null,lastAxisEnv=null;
  const events=new Map();
  const sel={kind:'scoreAttack',label:'',stage:-1,enemy:'',rules:[]};
  const opt={objective:'score',maxTurns:8,beam:24,critMode:'expected',allowOd:true,odWindows:'both'};
  const calc={attacker:0,skill:null,pre:[],morale:0,tokens:0,dr:100,level:null};

  async function load(){
    if(index&&skills)return;
    try{
      const [a,b,c,d]=await Promise.all([fetch('/data/bosses/index.json',{cache:'no-store'}),fetch('/data/skills.json',{cache:'no-store'}),fetch('/data/stats.json',{cache:'no-store'}),fetch('/api/enemy-parameters',{cache:'no-store',headers:{'X-WB-Token':document.querySelector('meta[name="wb-token"]')?.content||''}})]);
      if(!c.ok)throw Error('面板数据 HTTP '+c.status+'（运行 python scripts/build-stats.py）');
      if(!a.ok)throw Error('Boss 目录 HTTP '+a.status+'（运行 python scripts/build-bosses.py）');
      if(!b.ok)throw Error('技能表 HTTP '+b.status+'（运行 python scripts/build-skills.py）');
      if(!d.ok)throw Error('本机敌方参数加载失败（HTTP '+d.status+'），请检查数据文件或重启研究室服务。');
      index=await a.json();skills=await b.json();statsData=await c.json();enemyParameters=await d.json();
    }catch(err){loadError=err;}
  }
  async function eventOf(entry){
    if(!events.has(entry.file)){const r=await fetch('/data/bosses/'+entry.file,{cache:'no-store'});if(!r.ok)throw Error('Boss 数据 HTTP '+r.status);events.set(entry.file,withEnemyParameters(await r.json(),enemyParameters));}
    return events.get(entry.file);
  }
  let settingsLoaded=false,openPanel=null;
  // 档案里的搜索设置只在首次读入；之后以页面上的修改为准（否则每次重绘都会被旧设置覆盖）
  function planner(){const a=getArchive();if(!a.planner)a.planner=emptyPlanner();if(!settingsLoaded){Object.assign(opt,a.planner.settings||{});settingsLoaded=true;}return a.planner;}

  // ---------------------------------------------------------------- 当期任务
  const parseDate=s=>s?new Date(String(s).replace(' ','T')).getTime():NaN;
  /** 正在开放的期数（按开始时间新的在前）。 */
  function openEvents(){const now=Date.now();return index.events.filter(x=>parseDate(x.inDate)<=now&&now<=parseDate(x.outDate)).sort((a,b)=>parseDate(b.inDate)-parseDate(a.inDate));}
  const eventNo=x=>Number(String(x.label).replace(/\D/g,''))||x.name;
  const shortName=x=>x.kind==='scoreAttack'?`积分挑战 ${x.name}`:`${KIND_LABEL[x.kind]||x.kind} #${eventNo(x)}`;
  const until=x=>{const d=new Date(parseDate(x.outDate));return Number.isNaN(d.getTime())?'':`至 ${d.getMonth()+1}/${d.getDate()}`;};
  let selInit=false,showOther=false,moreOpen=false,bestIdx=0;
  function saveSel(){const P=planner();P.selection={kind:sel.kind,label:sel.label,stage:sel.stage,enemy:sel.enemy,rules:sel.rules.slice()};save();}
  /** 首次打开：优先沿用上次选的期数（仍在开放时），否则选最新开放的一期。 */
  function initSelection(){
    if(selInit)return;selInit=true;
    const P=planner(),saved=P.selection,open=openEvents();
    if(P.optSettings)Object.assign(optOpt,P.optSettings);
    Object.assign(optOpt,normalizeResultSettings(optOpt));
    if(!SEARCH_PRESETS[optOpt.scale])optOpt.scale='standard';
    const savedOk=saved&&index.events.some(x=>x.kind===saved.kind&&x.label===saved.label);
    const savedOpen=savedOk&&open.some(x=>x.kind===saved.kind&&x.label===saved.label);
    if(savedOpen||(savedOk&&!open.length))Object.assign(sel,{kind:saved.kind,label:saved.label,stage:saved.stage??-1,enemy:saved.enemy||'',rules:saved.rules||[]});
    else if(open.length)Object.assign(sel,{kind:open[0].kind,label:open[0].label,stage:-1,enemy:'',rules:[]});
  }
  function targetLine(ev,stage){
    if(ev.kind==='wave'){
      const names=ev.stages.map(s=>(s.enemies||[]).map(x=>x.name).filter((v,i,a)=>v&&a.indexOf(v)===i).join('、'));
      return `<p class="pl-foe">${ev.stages.length} 个阶段：${names.map((x,i)=>`<span>${i+1}. ${e(x)}</span>`).join('')}</p>`;
    }
    return enemyLine(ev,stage).replace('<p class="compact">','<p class="pl-foe">');
  }
  function enemyParametersHtml(ev,stage){
    try{
      const P=planner(),difficulty=ev.kind==='wave'?Number(P.waveSettings?.difficulty||40):null;
      const phases=phasesFor(ev,stage,[]),stages=plannerStages(ev,stage,P.waveSettings),custom=P.enemyOverrides?.[`${ev.kind}:${ev.label}`]||{};
      const verified=ev.kind==='wave'&&phases.every(p=>p.enemies.every(x=>x.parameterSource.difficultyVerified));
      return `${ev.kind==='wave'&&!verified?'<p class="pill-error">当前难度尚缺阶段 DP / HP 参数，正在使用敌人基础值；分数、破盾与击杀预测不能作为实战依据。</p>':''}<details class="pl-enemy-parameters"><summary>敌方参数：模拟实际使用的 DP / HP / 能力值${verified?' · 已载入本机难度表':''}</summary>
      <p class="subtle compact">${ev.kind==='wave'?(verified?'已按难度、阶段、敌人槽位读取本机游戏静态参数表。':'当前使用公开底表；没有实值时不猜测 DP / HP 倍率。'):''}可逐个填写实测值，留空恢复默认；修改后需要重新搜索。</p>
      <div class="table-wrap"><table><thead><tr><th>阶段 / 敌人</th><th>DP</th><th>HP</th><th>能力值</th></tr></thead><tbody>${phases.flatMap((p,pi)=>p.enemies.map(x=>{
        const key=enemyParameterKey(stages[pi],x,difficulty),over=custom[key]||{};
        return `<tr><td>${ev.kind==='wave'?pi+1:sel.stage+1}. ${e(x.name)}</td>${[['dp',x.maxDp],['hp',x.maxHp],['border',x.border]].map(([field,value])=>`<td><b data-enemy-current="${e(key)}" data-enemy-field="${field}">${n(value)}</b><small class="subtle">${Object.hasOwn(over,field)?' · 手填':verified?' · 难度表':field==='border'&&ev.label==='WaveBattle0008'&&difficulty===40?' · 已确认':' · 公开底表'}</small><input type="number" min="${field==='hp'?1:0}" step="1" aria-label="${e(x.name)} ${field} 覆盖值" data-enemy-param="${e(key)}" data-enemy-field="${field}" value="${over[field]??''}" placeholder="手动覆盖，留空恢复" ${optWorker?'disabled':''}></td>`).join('')}</tr>`;
      })).join('')}</tbody></table></div></details>`;
    }catch(err){return `<p class="pill-error">敌方参数不可用：${e(err.message)}</p>`;}
  }
  const SCALE_HINT={quick:'快速搜索',standard:'标准搜索',deep:'深入搜索'};

  async function mount(host){
    if(!index&&!loadError){host.innerHTML='<p class="subtle">正在加载 Boss 目录与技能表…</p>';await load();}
    if(loadError){host.innerHTML=`<div class="note"><b>数据未生成或加载失败</b><p>${e(loadError.message)}</p></div>`;return;}
    initSelection();
    const list=index.events.filter(x=>x.kind===sel.kind);
    if(!list.some(x=>x.label===sel.label)){sel.label=list[0]?.label||'';sel.stage=-1;sel.rules=[];}
    const entry=list.find(x=>x.label===sel.label);
    let ev=null;try{ev=entry?await eventOf(entry):null;}catch(err){notice(err.message);}
    if(ev&&(sel.stage<0||sel.stage>=ev.stages.length))sel.stage=ev.stages.length-1;
    const stage=ev?.stages[sel.stage];
    const P=planner();
    const open=openEvents(),isOpen=x=>open.some(o=>o.kind===x.kind&&o.label===x.label);
    const wave=ev?.kind==='wave';
    const foes=stage?(stage.enemies||[]).filter(x=>x.label):[];
    host.innerHTML=`
<section class="panel pl-task">
  <p class="eyebrow">当期任务</p>
  <div class="pl-chips">${open.map(x=>`<button type="button" class="pl-chip${x.kind===sel.kind&&x.label===sel.label?' active':''}" data-pl-pick="${e(x.kind)}|${e(x.label)}">${e(shortName(x))}<small>${e(until(x))}</small></button>`).join('')}
    ${entry&&!isOpen(entry)?`<button type="button" class="pl-chip active" aria-current="true">${e(shortName(entry))}<small>往期</small></button>`:''}
    <button type="button" class="pl-chip ghost" id="pl-other-toggle" aria-expanded="${showOther}">${showOther?'收起':'选其他期数…'}</button></div>
  <div class="field-grid pl-other" ${showOther?'':'hidden'}>
    <label>玩法<select id="pl-kind">${Object.entries(KIND_LABEL).map(([k,t])=>`<option value="${k}" ${k===sel.kind?'selected':''}>${t}</option>`).join('')}</select></label>
    <label>期数<select id="pl-event">${list.map(x=>`<option value="${e(x.label)}" ${x.label===sel.label?'selected':''}>${e(shortName(x))} · ${e(x.bosses.slice(0,2).join('、'))}</option>`).join('')}</select></label>
  </div>
  ${ev&&stage?`<div class="pl-target">
    ${!wave?`<label>难度<select id="pl-stage">${ev.stages.map((s,i)=>`<option value="${i}" ${i===sel.stage?'selected':''}>${e(s.group&&s.group!=='main'&&s.group!=='wave'?s.group+' · ':'')}${s.difficulty!=null?'Lv.'+s.difficulty+' ':''}${e(s.difficultyName)}${s.enemies?.filter(x=>x.label).length===1?' · '+e(s.enemies.find(x=>x.label).name||''):''}</option>`).join('')}</select></label>`:`<label>遭遇战难度<input id="pl-wave-difficulty" type="number" min="1" max="40" value="${P.waveSettings?.difficulty||40}" ${optWorker?'disabled':''}></label>`}
    ${!wave&&foes.length>1?`<label>目标敌人<select id="pl-enemy">${foes.map(x=>`<option value="${e(x.label)}" ${x.label===sel.enemy?'selected':''}>${e(x.name||x.label)}</option>`).join('')}</select></label>`:''}
    ${targetLine(ev,stage)}
  </div>`:''}
  ${ev&&stage?enemyParametersHtml(ev,stage):''}
  <div class="pl-search-options">
    <label>队伍输出属性<select id="opt-element" ${optWorker?'disabled':''}>${TEAM_ELEMENTS.map(k=>`<option value="${k}" ${optOpt.teamElement===k?'selected':''}>${k?ELEM_LABEL[k]+'属性':'不限属性'}</option>`).join('')}</select></label>
    <label>候选数量<select id="opt-top" ${optWorker?'disabled':''}>${[5,10,20].map(k=>`<option value="${k}" ${optOpt.top===k?'selected':''}>最多 ${k} 个</option>`).join('')}</select></label>
    <label>最低成功率（%）<input id="opt-min-success" type="number" min="0" max="100" step="1" value="${Math.round(optOpt.minSuccess*100)}" ${optWorker?'disabled':''}></label>
    <label>成功判定<select id="opt-success-basis" ${optWorker?'disabled':''}><option value="onPlan" ${optOpt.minSuccessBasis==='onPlan'?'selected':''}>照轴完成（不续打）</option><option value="success" ${optOpt.minSuccessBasis==='success'?'selected':''}>通关（每阶段最多 2 回合续打）</option></select></label>
    <p class="subtle compact">按排轴中的主要技能伤害属性筛选，允许跨属性辅助；“无”指无属性技能输出。搜索不按 Healer 等职责标签分配队伍位置。</p>
  </div>
  <p class="subtle compact">成功率下限 0 表示不限；下限立即筛选已有候选，重新搜索会按此要求挑选新方案。比例来自有限次数模拟，100% 不代表实战必过。</p>
  <div class="pl-go">
    <button id="opt-run" class="primary pl-run" type="button" ${optWorker||!ev?'disabled':''}>${optWorker?'正在求解…':'求最佳轴'}</button>
    ${optWorker&&optWorker!=='loading'?'<button id="opt-stop" type="button">停止</button>':''}
    <span class="subtle" id="opt-progress">${optWorker?e(optProgress?optProgressText(optProgress):'准备中…'):`${SCALE_HINT[optOpt.scale]||''} · 从你持有的 SS/SSR 里组队、选特殊规则、排轴，再用随机模拟比成功率${wave?'和分数':''}`}</span>
  </div>
  ${optWorker?'<div class="progress"><i></i></div>':''}
</section>
<section class="panel pl-best" id="pl-best">${bestHtml(ev,stage)}</section>
<details class="panel pl-more" ${moreOpen?'open':''}>
  <summary>更多细致选项 <small>固定配队 · 特殊规则 · 搜索投入 · 逐回合修改 · 伤害计算器</small></summary>
  <div class="pl-more-body">
    <section class="pl-sub"><h3>求解设置</h3>${settingsHtml(ev)}</section>
    <section class="pl-sub">
      <div class="split-heading"><h3>配队 <small class="subtle">勾“固定当前配队”时只用这六人</small></h3><div class="inline"><button id="pl-decks" class="quiet" type="button">从游戏编队导入</button><button id="pl-save" class="quiet" type="button">保存到档案</button></div></div>
      ${decks?deckPicker():''}
      <p class="subtle compact">面板是游戏里的最终能力值（导入编队时按缓存推算，可手改）。勾选的 3 人为开场前排。</p>
      <div class="table-wrap"><table class="planner-team"><thead><tr><th>#</th><th>前排</th><th>卡面</th>${STATS.map(k=>`<th>${STAT_LABEL[k]}</th>`).join('')}<th>面板来源 · 装备与初期</th></tr></thead><tbody>
      ${P.members.map((m,i)=>memberRow(m,i)).join('')}
      </tbody></table></div>
      <div id="pl-issues">${issuesHtml(P)}</div>
    </section>
    <section class="pl-sub" id="pl-designer"></section>
    <section class="pl-sub">
      <h3>只用当前配队快速排轴 <small class="subtle">单个敌人的束搜索，几秒出结果</small></h3>
      <div class="field-grid three">
        <label>目标<select id="pl-objective">${Object.entries(OBJECTIVES).map(([k,t])=>`<option value="${k}" ${k===opt.objective?'selected':''} ${k==='score'&&ev?.kind!=='scoreAttack'&&ev?.kind!=='wave'?'disabled':''}>${k==='score'&&ev?.kind==='wave'?'遭遇战最高分':t}</option>`).join('')}</select></label>
        <label>回合上限<input id="pl-turns" type="number" min="1" max="${stage&&ev?.kind==='scoreAttack'?turnLimit(ev.scoreCalc,stage)||30:30}" value="${opt.maxTurns}"></label>
        <label>搜索宽度<select id="pl-beam">${[[12,'快 · 12'],[24,'标准 · 24'],[48,'细 · 48'],[96,'很细 · 96（慢）']].map(([v,t])=>`<option value="${v}" ${v===Number(opt.beam)?'selected':''}>${t}</option>`).join('')}</select></label>
        <label>暴击<select id="pl-crit">${Object.entries(CRIT_LABEL).map(([k,t])=>`<option value="${k}" ${k===opt.critMode?'selected':''}>${t}</option>`).join('')}</select></label>
        <label>OD 时机<select id="pl-odw">${[['both','回合开始或结束'],['turnStart','只在回合开始'],['turnEnd','只在回合结束']].map(([v,t])=>`<option value="${v}" ${v===opt.odWindows?'selected':''}>${t}</option>`).join('')}</select></label>
        <label class="inline"><input id="pl-od" type="checkbox" ${opt.allowOd?'checked':''}>允许发动 OD</label>
      </div>
      <div class="inline"><button id="pl-run" ${worker?'disabled':''}>${worker?'搜索中…':'开始排轴'}</button><button id="pl-stop" ${worker?'':'disabled'}>停止</button><span id="pl-progress" class="subtle">${progressText()}</span></div>
      <div id="pl-result">${result?resultHtml(result):''}</div>
    </section>
    <section class="pl-sub" id="pl-calc">${calcHtml(ev,stage)}</section>
    <section class="pl-sub"><h3>公式来源与仍为推定的部分</h3>
      <p class="subtle">伤害按社区计算器 hbr-calculator.com 的 Calculator 模块、回合（SP/OD/持续/追加回合）按其 Planner 模块重写，与原实现随机 3000 例逐项一致。技能/Boss/规则来自公开主数据；我方受伤按面板推算与敌方行动表模拟，任何成员 HP 清零即判失败；NoBreak 未判定。结果<b>不是游戏实测分数</b>。</p>
      ${rulesHtml()}</section>
  </div>
</details>`;
    bind(host,ev,stage);
    bindTask(host,ev,stage);
    mountDesigner(host,ev,stage);
  }

  function bindTask(host,ev,stage){
    const q=s=>host.querySelector(s);
    host.querySelectorAll('[data-pl-pick]').forEach(b=>b.onclick=()=>{const [kind,label]=b.dataset.plPick.split('|');Object.assign(sel,{kind,label,stage:-1,enemy:'',rules:[]});showOther=false;saveSel();mount(host);});
    q('#pl-other-toggle').onclick=()=>{showOther=!showOther;mount(host);};
    q('.pl-more').addEventListener('toggle',ev_=>{moreOpen=ev_.target.open;});
    if(q('#opt-run'))q('#opt-run').onclick=()=>runOptimize(host,ev,stage);
    if(q('#opt-stop'))q('#opt-stop').onclick=()=>{optWorker?.terminate();optWorker=null;optProgress=null;mount(host);};
    const setOpt=(id,key,get=x=>x.checked)=>{const el=q(id);if(el)el.onchange=()=>{optOpt[key]=get(el);saveOpt();if(['scale','searchRules','minSuccess','minSuccessBasis'].includes(key))mount(host);};};
    setOpt('#opt-scale','scale',x=>x.value);setOpt('#opt-goal','goal',x=>x.value);
    setOpt('#opt-element','teamElement',x=>x.value);setOpt('#opt-top','top',x=>Number(x.value));
    setOpt('#opt-min-success','minSuccess',x=>Math.max(0,Math.min(100,Number(x.value)||0))/100);
    setOpt('#opt-success-basis','minSuccessBasis',x=>x.value);
    setOpt('#opt-fixed','fixedTeam');setOpt('#opt-rules','searchRules');setOpt('#opt-orbs','allOrbs');
    setOpt('#opt-cards','optimizeCards');setOpt('#opt-overkill','overkill');
    if(q('#pl-wave-difficulty'))q('#pl-wave-difficulty').onchange=ev_=>{
      const P=planner();P.waveSettings={difficulty:40,international:true,...P.waveSettings,difficulty:Math.max(1,Math.min(40,Math.round(Number(ev_.target.value))||40))};save();mount(host);
    };
    host.querySelectorAll('[data-enemy-param]').forEach(el=>el.onchange=()=>{
      const P=planner(),group=`${ev.kind}:${ev.label}`,key=el.dataset.enemyParam,field=el.dataset.enemyField;
      const value=el.value.trim();if(value!==''&&(!Number.isFinite(Number(value))||Number(value)<0||(field==='hp'&&Number(value)===0))){notice('DP/能力值须为非负数，HP 须大于 0。',true);return;}
      P.enemyOverrides=P.enemyOverrides||{};const map=P.enemyOverrides[group]||(P.enemyOverrides[group]={}),custom=map[key]||(map[key]={});
      if(value==='')delete custom[field];else custom[field]=Number(value);
      if(!Object.keys(custom).length)delete map[key];save();mount(host);
    });
    if(optWorker)host.querySelectorAll('[data-pl-pick],#pl-kind,#pl-event,#pl-stage,#pl-enemy,[data-enemy-param],[data-opt-use],#pl-edit,.pl-more input,.pl-more select,.pl-more button').forEach(el=>el.disabled=true);
    host.querySelectorAll('[data-opt-use]').forEach(b=>b.onclick=()=>{adopt(Number(b.dataset.optUse),ev,stage);mount(host);});
    if(q('#pl-edit'))q('#pl-edit').onclick=()=>{moreOpen=true;q('.pl-more').open=true;q('#pl-designer')?.scrollIntoView({behavior:'smooth'});};
  }

  // ---------------------------------------------------------------- 排轴设计器
  const dview={};
  const designKey=(ev,stage)=>ev.kind==='wave'?`wave:${ev.label}`:`${ev.kind}:${ev.label}:${sel.stage}:${sel.enemy||''}`;
  function designOf(ev,stage,phases){
    const P=planner();P.designs=P.designs||{};
    const k=designKey(ev,stage);if(!P.designs[k])P.designs[k]=emptyDesign(phases);
    return P.designs[k];
  }
  function mountDesigner(host,ev,stage){
    const box=host.querySelector('#pl-designer');if(!box)return;
    if(!ev||!stage){box.innerHTML='<h2>排轴设计器</h2><p class="subtle">先选对手。</p>';return;}
    const c=buildCtx(ev,stage);
    if(c.error){box.innerHTML=`<h2>排轴设计器</h2><p class="subtle">${e(c.error)}</p>`;return;}
    const P=planner();
    const k=designKey(ev,stage);
    P.waveSettings=P.waveSettings||{difficulty:40,international:true};
    const env={e,n,host:box,party:c.party,phases:c.phases,statusTypes:skills.statusTypes,opt,design:designOf(ev,stage,c.phases.length),
      view:(dview[k]=dview[k]||{phase:0,crit:opt.critMode,vary:'1.1'}),
      save:d=>{P.designs[k]=d;save();},
      wave:ev.kind==='wave'?{...P.waveSettings,rules:c.rules}:null,
      setWave:patch=>{Object.assign(P.waveSettings,patch);env.wave={...env.wave,...patch};env.phases=phasesFor(ev,stage,c.rules);save();queueMicrotask(()=>mount(host));},notice};
    lastDesignEnv=env;
    try{renderDesigner(env);}catch(err){box.innerHTML=`<h2>排轴设计器</h2><p class="pill-error">设计器出错：${e(err.message)}</p>`;console.error(err);}
  }
  let lastDesignEnv=null;

  // ---------------------------------------------------------------- 求最佳轴（配置优化：队伍 / 规则 / 技能 / 饰品 / 战术卡 + 排轴）
  let cachePool=null,optWorker=null,optProgress=null,optResult=null,optResultKey='';
  const OPT_SCALE=SEARCH_PRESETS;
  const optOpt={maxTurns:6,scale:'standard',broad:true,fixedTeam:false,optimizeCards:true,overkill:true,goal:'score',searchRules:true,allOrbs:true,teamElement:'',top:10,minSuccess:0,minSuccessBasis:'onPlan'};
  const GOALS={score:'最高分（通关均分）',stable:'最稳（成功率优先）',fast:'最少回合'};
  const optStepLabel={evaluate:'评估候选',evolve:'改进候选',final:'深排与少量随机模拟',incumbent:'复评已有方案'};
  const optProgressText=x=>`${optStepLabel[x.step]||x.step}${x.total>0?` ${Math.max(0,Math.min(x.total,x.done))}/${x.total}${x.step==='evolve'?' 次评估':''}`:''} · ${x.label} · 已用 ${(x.elapsed/1000).toFixed(0)} 秒`;
  const pct=x=>x==null?'—':`${Math.round(x*100)}%`;
  function saveOpt(){const P=planner();P.optSettings={scale:optOpt.scale,goal:optOpt.goal,fixedTeam:optOpt.fixedTeam,searchRules:optOpt.searchRules,allOrbs:optOpt.allOrbs,optimizeCards:optOpt.optimizeCards,overkill:optOpt.overkill,...normalizeResultSettings(optOpt)};save();}
  function resultsFor(key){return optResultKey===key&&optResult?optResult:(planner().lastOptimization?.targetKey===key?planner().lastOptimization:null);}
  const goalFor=ev=>ev.kind==='wave'||optOpt.goal!=='score'?optOpt.goal:'stable';

  function settingsHtml(ev){
    if(!ev)return '<p class="subtle">先选期数。</p>';
    const wave=ev.kind==='wave',rules=(ev.kind==='scoreAttack'||wave)?ev.rules||[]:[];
    const goal=goalFor(ev);
    return `<div class="field-grid three">
  <label>搜索投入<select id="opt-scale" ${optWorker?'disabled':''}>${Object.entries(OPT_SCALE).map(([k,v])=>`<option value="${k}" ${optOpt.scale===k?'selected':''}>${v.label} · 最多 ${v.searchEvals} 次改进</option>`).join('')}</select></label>
  <label>以什么为准<select id="opt-goal" ${optWorker?'disabled':''}>${Object.entries(GOALS).filter(([k])=>wave||k!=='score').map(([k,v])=>`<option value="${k}" ${goal===k?'selected':''}>${v}</option>`).join('')}</select></label>
</div>
<div class="pl-checks">
  <label class="inline"><input id="opt-fixed" type="checkbox" ${optOpt.fixedTeam?'checked':''}>固定当前配队（不换人，只排轴和挑技能/饰品）</label>
  <label class="inline"><input id="opt-orbs" type="checkbox" ${optOpt.allOrbs?'checked':''}>宝玉技能全部可用</label>
  ${wave?`<label class="inline"><input id="opt-cards" type="checkbox" ${optOpt.optimizeCards?'checked':''}>挑战术卡</label><label class="inline"><input id="opt-overkill" type="checkbox" ${optOpt.overkill?'checked':''}>伤害分计溢出（推定）</label>`:''}
  ${rules.length?`<label class="inline"><input id="opt-rules" type="checkbox" ${optOpt.searchRules?'checked':''}>特殊规则也自动选</label>`:''}
</div>
${rules.length?`<div class="pl-rules"><p class="subtle compact">${optOpt.searchRules?'自动选时，下面勾的规则是起点；':'不自动选时，按下面勾的规则求解；'}每期可选 ${ev.maxRules||1} 条，已选 ${sel.rules.length}。</p>
${rules.map(r=>`<label class="inline rule-pick"><input type="checkbox" data-pl-rule="${r.id}" ${sel.rules.includes(r.id)?'checked':''}>${e(r.name)} <span class="tag">+${r.grade}%</span> <small class="subtle">${e(r.parts.map(p=>p.skillType).join('、')||r.type)}</small></label>`).join('')}</div>`:''}
<p class="subtle compact">固定搜索量，耗时随队伍和关卡变化；提高搜索投入会尝试更多候选并加宽排轴搜索。已有方案会重新评估并保留参选。精评每条轴 ${OPT_SCALE[optOpt.scale].mcRuns} 次随机模拟，均分只计通关样本，失败率单独统计。</p>
<p class="subtle compact">不固定配队时，候选包括当前配队、游戏里的 6 人编队、同角色换卡面，以及从全部已持有 SS/SSR 组的新队，再按模拟里的贡献换人、交叉、换耳环。技能按格数上限保留排轴实际用到的；成功率来自随机模拟（逐段暴击、伤害浮动、敌方随机目标）。${wave?`战术卡每次 3 选 1、可重抽 5 次，指定一张出现的概率约 ${Math.round(cardSeenProb(1)*100)}%。`:''}</p>`;
  }

  function bestHtml(ev,stage){
    if(!ev||!stage)return '<p class="subtle">先选期数。</p>';
    const P=planner(),k=designKey(ev,stage),summary=P.best?.[k];
    const R=resultsFor(k),wave=ev.kind==='wave';
    const selected=R?.selected??bestIdx;
    const design=P.designs?.[k];
    const hasAxis=design?.phases?.some(p=>p.turns?.some(t=>t.actions?.some(a=>a.s)||t.odStart||t.odEnd));
    if(!hasAxis&&!R)return `<div class="pl-empty"><h2>还没有这一期的轴</h2><p class="subtle">点上面的「求最佳轴」。会自动读取本机游戏缓存（只读）里的已持有卡面、饰品和当前编队。</p></div>`;
    let contextKey=null;try{contextKey=enemyContextKey(phasesFor(ev,stage,[]),contextOptions(ev));}catch{}
    const activeRules=ev.kind==='scoreAttack'||ev.kind==='wave'?sel.rules:(stage.rules||[]).map(r=>r.id);
    const resultStale=R&&!resultMatchesEnemies(R,contextKey),summaryStale=summary&&(!resultMatchesEnemies(summary,contextKey)||!sameRuleIds(summary.ruleIds,activeRules));
    const rows=resultStale?[]:visibleCandidates(R,optOpt),basisName=optOpt.minSuccessBasis==='success'?'通关率（含续打）':'照轴完成率';
    const maxScore=rows.length?Math.max(...rows.map(({candidate:t})=>successfulScores(t.mc).mean??0)):0;
    const legacyScores=wave&&R?.top?.some(t=>successfulScores(t.mc).converted);
    const thresholdNote=R&&optOpt.minSuccess>0?`<p class="subtle compact">按${basisName} ≥ ${pct(optOpt.minSuccess)} 筛选，当前保留 ${rows.length} 个候选${R.rejectedBySuccess?`；搜索结束时另有 ${R.rejectedBySuccess} 条轴未达到当时下限`:''}。${rows.length?'':'可降低下限或提高搜索投入后重新搜索。'}</p>`:'';
    const currentBelow=!summaryStale&&summary&&optOpt.minSuccess>0&&!(satisfiesThreshold(summary,optOpt))?`<p class="pill-error">当前采用方案低于所选成功率下限。可从合格候选中重新选择，或重新搜索。</p>`:'';
    const staleNote=resultStale||summaryStale?'<p class="pill-error">敌方参数、计分设置、规则或战斗模型已更新，旧均分和成功率暂不作为有效结果。旧轴保留供查看；请重新搜索，以当前模型复评。</p>':'';
    const chips=rows.length?`<p class="subtle compact">${legacyScores?'保留历史搜索顺序':'本次按'+e(GOALS[R.goal]||'模拟结果')+'排列'} · ${R.teamElement?ELEM_LABEL[R.teamElement]+'属性':'不限属性'} · ${rows.length} 个候选。点击可切换配队与排轴，最近一批结果会保存在本机。</p>
    <div class="pl-plans">${rows.map(({candidate:t,index:i})=>{const sc=successfulScores(t.mc),gap=scoreGap(maxScore,sc.mean);return `<button type="button" class="pl-plan${i===selected?' active':''}" data-opt-use="${i}" aria-pressed="${i===selected}">
      <b>候选 ${i+1}${i===selected?' · 已采用':''}</b>${t.newTeam?'<span class="tag">新队伍</span>':''}<span>按轴 ${pct(t.mc.onPlan)} · 通关 ${pct(t.mc.success)}</span><span>失败 ${sc.successes==null||t.mc.n==null?'—':t.mc.n-sc.successes}/${t.mc.n??'?'} 次</span>${wave?`<span>${sc.mean!=null?`通关均分 ${n(Math.round(sc.mean))} · ${sc.samples??'?'} 个成功样本${gap>=0.5?` · 距最高 ${n(Math.round(gap))}`:''}`:'暂无通关分数'}</span>`:''}<span>${t.mc.turnsMedian??t.turns} 回合${t.teamElement?` · ${ELEM_LABEL[t.teamElement]||t.teamElement} ${pct(t.elementShare)}`:''}</span></button>`;}).join('')}</div>${legacyScores?'<p class="subtle compact">旧均分已剔除失败的零分；重新搜索会用新样本复评已有轴并更新排序。</p>':''}`:'';
    let axis='',sum=null;
    if(hasAxis){
      const c=buildCtx(ev,stage);
      if(c.error)axis=`<p class="pill-error">${e(c.error)}</p>`;
      else{const v=axisView({e,n,party:c.party,phases:c.phases,statusTypes:skills.statusTypes,design,critMode:'expected'});axis=v.html;sum=v.summary;}
    }
    const s=summary||{},scores=successfulScores({...s,n:s.samples});
    const team=(s.team||[]).map(x=>`<span class="pl-member">${e(x)}</span>`).join('');
    const loadout=(s.loadout||[]).length?`<details class="pl-loadout" open><summary>配置详情：队伍、技能、饰品、支援卡${wave&&s.cardNames?.some(Boolean)?'、战术卡':''}</summary>
${wave&&s.cardNames?.some(Boolean)?`<p class="compact">${s.cardNames.map((c,p)=>p&&c?`第 ${p+1} 阶段前选 <b>${e(c)}</b>`:'').filter(Boolean).join('　')}</p>`:''}
<div class="pl-loadout-grid">${s.loadout.map((m,i)=>`<article class="pl-loadout-member"><h3><span class="tag">${m.front?'前卫':'后卫'}</span> ${e(m.name)}${m.isNew?' <span class="tag">新换上</span>':''}</h3>
<p class="compact">${m.skillsChanged?'<span class="tag">技能需调整</span> ':''}技能：${e(m.skills.join('、'))} <small class="subtle">（${m.skills.length}/${m.cap??'?'} 格）</small></p>
${m.changes?.length?`<p class="compact">饰品改动：${e(m.changes.join('、'))}</p>`:''}
${loadoutDetailsHtml(P.members[i],{equipment,catalog,stats:statsData},e)}<p class="subtle compact">当前计算参数：${e(equipText(P.members[i]||{}))}</p></article>`).join('')}</div></details>`:'';
    const stats=summary&&!summaryStale?`<div class="pl-best-stats">
      <div><strong>${pct(s.onPlan)}</strong><span>模拟按轴完成${s.samples?' · '+s.samples+' 次':''}</span></div>
      <div><strong>${pct(s.success)}</strong><span>通关（每阶段最多 2 回合续打）</span></div>
      ${s.samples&&scores.successes!=null?`<div><strong>${s.samples-scores.successes}/${s.samples}</strong><span>失败次数（不计入均分）</span></div>`:''}
      ${wave?`<div><strong>${scores.mean!=null?n(Math.round(scores.mean)):'—'}</strong><span>通关均分 · ${scores.samples??'?'} 个成功样本</span></div>`:''}
      ${wave&&scores.p10!=null?`<div><strong>${n(Math.round(scores.p10))}</strong><span>通关分数第 10 百分位</span></div>`:''}
      <div><strong>${s.turnsMedian??s.turns??'—'}</strong><span>回合（中位）</span></div>
      ${s.ruleNames?`<div><strong class="pl-rule-name">${e(s.ruleNames.join('、')||'不选')}</strong><span>特殊规则</span></div>`:''}
    </div>`:sum?`<div class="pl-best-stats"><div><strong>${sum.turns}</strong><span>回合</span></div><div><strong>${sum.cleared}/${sum.phases}</strong><span>击破</span></div></div>`:'';
    return `<div class="split-heading"><h2 title="${e(s.label||'')}">当前方案${summary?` <small class="subtle">${s.newTeam?'新组的队伍 · ':''}${s.at?new Date(s.at).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+' 求出':''}</small>`:''}</h2>
  ${hasAxis?'<button id="pl-edit" class="quiet" type="button">逐回合修改</button>':''}</div>
${staleNote}${thresholdNote}${currentBelow}${chips}${stats}${team?`<div class="pl-team">${team}</div>`:''}
<div class="pl-axis">${axis}</div>
${loadout}
${R?`<p class="subtle compact">比较了 ${R.evaluated} 个候选（粗筛 ${R.screened??R.evaluated}），${R.threads??1} 个线程，用时 ${(R.elapsed/1000).toFixed(0)} 秒${(R.errorCount||R.errors?.length)?`；${R.errorCount||R.errors.length} 个候选出错`:''}。启发式搜索不保证全局最优；分数和成功率来自有限样本的社区公式模拟，小分差可能是抽样波动，不是游戏实测。</p>`:''}`;
  }

  function satisfiesThreshold(summary,settings){
    const rate=summary[settings.minSuccessBasis];
    return Number.isFinite(rate)&&rate>=settings.minSuccess;
  }

  function bestSummary(t,result){
    const sc=successfulScores(t.mc);
    return {label:t.label,newTeam:!!t.newTeam,team:t.team,ruleIds:t.ruleIds||[],ruleNames:t.ruleNames||null,battleVersion:result?.battleVersion,enemyContextKey:result?.enemyContextKey,success:t.mc.success,onPlan:t.mc.onPlan,scoreMean:sc.mean,scoreP10:sc.p10,scoreBasis:'successful',scoreSamples:sc.samples,successes:sc.successes,samples:t.mc.n,teamElement:t.teamElement,elementShare:t.elementShare,
      turnsMedian:t.mc.turnsMedian,turns:t.turns,loadout:t.loadout||[],cardNames:(t.cards||[]).map(c=>c?cardById(c)?.name||c:null),at:Date.now()};
  }
  /** 采用第 i 个方案：研究室的配队、该期排轴、特殊规则都换成它（游戏本身不会被修改）。 */
  function adopt(i,ev,stage){
    const R=resultsFor(designKey(ev,stage)),t=R?.top?.[i];if(!t)return;
    const P=planner();
    P.members=structuredClone(t.members);
    if(Array.isArray(t.ruleIds))sel.rules=t.ruleIds.slice();
    const k=designKey(ev,stage);
    P.designs=P.designs||{};P.designs[k]=structuredClone(t.design);
    P.best=P.best||{};P.best[k]=bestSummary(t,R);
    bestIdx=i;R.selected=i;if(P.lastOptimization?.targetKey===k)P.lastOptimization.selected=i;persist();saveSel();
  }
  async function ensureCache(){
    if(cachePool)return true;
    try{const r=await cacheDecks();decks={list:r.decks,readAt:r.read_at};cachePool={decks:r.decks,cards:r.cards||[],accessories:r.accessories||[]};return true;}
    catch(err){notice('读取游戏缓存失败：'+err.message+'。求最佳轴需要本机游戏缓存里的已持有卡面和饰品（只读）。',true);return false;}
  }
  async function runOptimize(host,ev,stage){
    if(!ev||!stage){notice('先选期数。');return;}
    if(optWorker)return;
    optWorker='loading';optProgress={step:'evaluate',done:-1,total:0,label:'读取游戏缓存',elapsed:0};mount(host);
    const ok=await ensureCache();
    if(!ok){optWorker=null;optProgress=null;mount(host);return;}
    const P=planner();
    // 研究室里还没有完整配队时，先用游戏里当前的编队当起点
    if(!membersFrom(P,getArchive(),catalog).ready){
      const d=cachePool.decks.find(x=>x.current&&x.members.filter(Boolean).length===6)||cachePool.decks.find(x=>x.members.filter(Boolean).length===6);
      if(d)P.members=membersFromDeck(d,{catalog,equipment,stats:statsData,previous:P.members});
    }
    const c=buildCtx(ev,stage);
    if(c.error){optWorker=null;optProgress=null;notice(c.error,true);mount(host);return;}
    const k=designKey(ev,stage),d=designOf(ev,stage,c.phases.length);
    const originalMembers=JSON.stringify(P.members);
    const ws=P.waveSettings||{difficulty:40,international:true};
    // 特殊规则：自动选时每种组合各建一份阶段敌人；当前所选规则也在其中（ruleIndex）
    let ruleOptions=null,ruleIndex=0;
    if(optOpt.searchRules&&ev.rules?.length&&(ev.kind==='scoreAttack'||ev.kind==='wave')){
      try{
        const combos=ruleCombos(ev),key=rs=>rs.map(r=>r.id).sort().join(',');
        if(!combos.some(rs=>key(rs)===key(c.rules)))combos.unshift(c.rules);
        ruleOptions=combos.map(rs=>({ids:rs.map(r=>r.id),rules:rs,phases:phasesFor(ev,stage,rs)}));
        ruleIndex=ruleOptions.findIndex(o=>key(o.rules)===key(c.rules));
      }catch(err){notice('规则组合构建失败，按当前规则计算：'+err.message);ruleOptions=null;}
    }
    const input={data:{catalog,skills,stats:statsData,equipment},archive:getArchive(),cache:cachePool,base:P.members,
      target:{kind:ev.kind,ev:{elements:ev.elements||[]},rules:c.rules,phases:c.phases,cards:d.phases.map(p=>p.card||null),difficulty:ws.difficulty,international:ws.international,ruleOptions,ruleIndex},
      opts:{...optOpt,...OPT_SCALE[optOpt.scale],goal:goalFor(ev),overkill:ws.overkill!==false&&optOpt.overkill}};
    input.opts.scopeKey=optimizationScope(k,input);
    input.opts.battleVersion=BATTLE_MODEL_VERSION;input.opts.enemyContextKey=enemyContextKey(c.phases,contextOptions(ev));
    input.incumbents=reusableCandidates(resultsFor(k),k,input.opts.scopeKey,{members:P.members,design:d,ruleIds:c.rules.map(r=>r.id),label:'当前已有轴'});
    optResult=null;optResultKey=k;optProgress={step:'evaluate',done:-1,total:0,label:'准备',elapsed:0};
    const w=new Worker('/sim/optimizer-worker.mjs',{type:'module'});optWorker=w;
    w.onmessage=m=>{const x=m.data;
      if(x.stage==='progress'){optProgress=x;const el=host.querySelector('#opt-progress');if(el)el.textContent=optProgressText(x);}
      else{
        w.terminate();optWorker=null;optProgress=null;
        if(x.stage==='done'){optResult={...x.result,targetKey:k,scopeKey:input.opts.scopeKey,battleVersion:input.opts.battleVersion,enemyContextKey:input.opts.enemyContextKey,teamElement:input.opts.teamElement,selected:0};bestIdx=0;
          const current=planner();current.lastOptimization=packOptimizationResult(k,optResult,input.opts);
          if(optResult?.top?.length){
            if(current===P&&JSON.stringify(current.members)===originalMembers){adopt(0,ev,stage);notice(`本次找到 ${optResult.top.length} 个候选，已采用第 1 个，模拟成功率 ${pct(optResult.top[0].mc.success)}。可点击其他候选比较。`);}
            else{optResult.selected=-1;current.lastOptimization.selected=-1;save();notice(`本次找到 ${optResult.top.length} 个候选。求解期间档案或配队有更新，已保留你的改动；点击候选后采用。`);}}
          else{save();notice(`本次没有找到${input.opts.teamElement?ELEM_LABEL[input.opts.teamElement]+'属性的':''}合适方案${input.opts.minSuccess>0?`（${input.opts.minSuccessBasis==='onPlan'?'照轴完成率':'含续打通关率'}至少 ${pct(input.opts.minSuccess)}）`:''}。可降低成功率下限、提高搜索投入或调整配队；搜索无结果不代表不存在。`,true);}}
        else notice('求解失败：'+x.message,true);
        mount(host);}
    };
    w.onerror=err=>{notice('求解出错：'+(err.message||''),true);w.terminate();optWorker=null;mount(host);};
    w.postMessage(input);mount(host);
    host.querySelector('#pl-best')?.scrollIntoView({behavior:'smooth',block:'nearest'});
  }

  // ---------------------------------------------------------------- 对手与队伍
  function enemyLine(ev,stage){
    const foe=(stage.enemies||[]).filter(x=>x.label).find(x=>x.label===sel.enemy)||(stage.enemies||[]).filter(x=>x.label)[0];
    if(!foe)return '<p class="subtle">这一档没有敌人数据。</p>';
    const d=ev.enemies?.[foe.label];
    const res=d?.resist?.element?Object.entries(d.resist.element).filter(([k,v])=>typeof v==='number'&&v!==0).map(([k,v])=>`${k} ${100-v}%`).join(' · '):'';
    let actual;try{actual=phasesFor(ev,stage,[])[0].enemies[0];}catch(err){return `<p class="pill-error">${e(err.message)}</p>`;}
    return `<p class="compact">${e(actual.name||actual.label)} · DP ${n(actual.maxDp)} · HP ${n(actual.maxHp)} · 基准 ${actual.border} · 破坏系数 ${foe.destruction?.[0]??'—'} 上限 ${foe.destruction?.[1]??'—'}%${res?` · 弱点/抗性 ${e(res)}`:''}${stage.damageCap?` · 伤害上限 ${n(stage.damageCap)}`:''}</p>`;
  }
  function deckPicker(){
    if(decks.error)return `<p class="pill-error">${e(decks.error)}</p>`;
    return `<div class="inline deck-pick"><label>游戏编队<select id="pl-deck">${decks.list.map(d=>`<option value="${d.index}">${d.index}「${e(d.name)}」${d.current?'（当前）':''} · ${d.members.filter(Boolean).map(m=>e(catalog.characters.find(c=>c.id===m.characterId)?.name||'?')).join('、')}</option>`).join('')}</select></label><button id="pl-deck-apply" type="button">导入这一套</button><small class="subtle">读取于 ${e(decks.readAt||'')}</small></div>`;
  }
  function styleOptions(current){
    const a=getArchive();
    const owned=catalog.styles.filter(s=>a.styles?.[s.id]?.owned),pool=owned.length?owned:catalog.styles,byChar=new Map();
    for(const s of pool){const c=catalog.characters.find(x=>x.id===s.characterId);const k=c?.name||s.characterId;if(!byChar.has(k))byChar.set(k,[]);byChar.get(k).push(s);}
    const cur=current&&!pool.some(s=>s.id===current)?catalog.styles.find(s=>s.id===current):null;
    return `<option value="">（未选）</option>${cur?`<option value="${e(cur.id)}" selected>${e(cur.name)}（未持有）</option>`:''}${[...byChar].map(([name,list])=>`<optgroup label="${e(name)}">${list.map(s=>`<option value="${e(s.id)}" ${s.id===current?'selected':''}>${e(s.tier)} ${e(s.name)}</option>`).join('')}</optgroup>`).join('')}`;
  }
  function equipText(m){
    const q=m.equipment||{},out=[];
    if(q.earring)out.push(`${EARRING_LABEL[q.earring.type]||q.earring.type}+${q.earring.bonus}%`);
    if(q.odEarringBonus)out.push(`DRIVE+${q.odEarringBonus}%`);
    if(q.necklaceAttack)out.push('古代项链');
    if(q.ringElement)out.push(`${ELEM_LABEL[q.ringElement]||q.ringElement}戒 Lv${(q.ringLevel??0)+1}`);
    if(m.tearLevel)out.push(`泪${m.tearLevel}`);
    out.push(`初期SP ${m.initialSp||0}`);
    if(m.deckSkillIds?.length)out.push(`编队技能 ${m.deckSkillIds.length}`);
    return out.join(' · ');
  }
  function panelCell(m,i){
    const src=m.raw?(m.statsManual?.length?`推算（手改 ${m.statsManual.map(k=>STAT_LABEL[k]).join('、')}）`:'推算（游戏缓存）'):'手填';
    return `<span class="tag">${e(src)}</span> ${m.raw?`<button class="link" data-pl-panel="${i}" type="button">${openPanel===i?'收起明细':'配置与面板'}</button>${m.statsManual?.length?` <button class="link" data-pl-reset="${i}" type="button">恢复推算</button>`:''}`:''}<br>${e(equipText(m))}`;
  }
  function panelHtml(m){
    const config=loadoutDetailsHtml(m,{equipment,catalog,stats:statsData},e);
    const r=computePanel(m.raw,{stats:statsData,equipment,catalog});
    if(!r.final)return config+`<p class="subtle">${e(r.notes.join('；'))}</p>`;
    const fmt=v=>Math.round(v*10)/10;
    const kind={base:'基础（×战术%）',rate:'战术型态 %',flat:'固定加值'};
    return `${config}<div class="table-wrap"><table class="panel-table"><thead><tr><th>项目</th><th>类</th>${STATS.map(k=>`<th>${STAT_LABEL[k]}</th>`).join('')}<th>DP</th></tr></thead><tbody>
${r.parts.map(p=>`<tr><td>${e(p.label)}</td><td class="subtle">${kind[p.kind]}</td>${STATS.map(k=>`<td class="num">${fmt(p.values[k])}</td>`).join('')}<td class="num">${fmt(p.values.dp||0)}</td></tr>`).join('')}
<tr><td><b>推算面板</b></td><td></td>${STATS.map(k=>`<td class="num"><b>${r.final[k]}</b></td>`).join('')}<td class="num"><b>${r.final.dp}</b></td></tr></tbody></table></div>
<p class="subtle compact">合计 = ⌈基础×(1+战术%)⌉ + 固定加值 + ⌈支援卡面状态值×10%⌉（游戏向上取整）。已用 4 人合计与 2 张支援面板核对，全部一致。${r.notes.length?e(r.notes.join('；')):''}</p>`;
  }
  function memberRow(m,i){
    const est=m.styleId?estimateStats(catalog,m.styleId,getArchive()):{};
    return `<tr><td>${i+1}</td><td><input type="checkbox" data-pl-front="${i}" ${m.front?'checked':''} aria-label="第 ${i+1} 位开场前排"></td>
<td><select data-pl-style="${i}" aria-label="第 ${i+1} 位卡面">${styleOptions(m.styleId)}</select></td>
${STATS.map(k=>`<td><input class="stat-input" type="number" min="0" max="99999" data-pl-stat="${i}:${k}" value="${m.stats?.[k]??''}" placeholder="${est[k]??''}" aria-label="第 ${i+1} 位 ${STAT_LABEL[k]}"></td>`).join('')}
<td class="subtle equip-cell">${m.styleId?panelCell(m,i):''}</td></tr>${openPanel===i&&m.raw?`<tr class="panel-row"><td colspan="${STATS.length+4}">${panelHtml(m)}</td></tr>`:''}`;
  }
  function issuesHtml(P){
    const {issues}=membersFrom(P,getArchive(),catalog);
    return issues.length?`<ul class="compact subtle">${issues.map(x=>`<li>${e(x)}</li>`).join('')}</ul>`:'<p class="subtle compact">队伍已就绪。</p>';
  }

  // ---------------------------------------------------------------- 伤害计算器
  /** 设计器 / 优化器的阶段：遭遇战 = 全部阶段、每阶段全部敌人；其他 = 当前关卡的目标敌人。rules 不同敌人数据不同（规则效果挂在敌人上）。 */
  function phasesFor(ev,stage,rules){
    const P=planner();return plannerPhases(ev,stage,{rules,enemyLabel:sel.enemy,waveSettings:P.waveSettings,overrides:P.enemyOverrides?.[`${ev.kind}:${ev.label}`]});
  }
  function contextOptions(ev){
    const ws=planner().waveSettings||{};
    return {wave:ev.kind==='wave'?{...ws,overkill:ws.overkill!==false&&optOpt.overkill}:null};
  }
  /** 规则组合含不选与少选：倍率更高也可能因战斗代价降低总分。 */
  function ruleCombos(ev){
    return ruleCombinations(ev.rules||[],ev.maxRules??1);
  }
  function buildCtx(ev,stage){
    const P=planner(),{members,ready,issues}=membersFrom(P,getArchive(),catalog);
    if(!ready)return {error:'队伍未就绪：'+issues.join('；')};
    try{
      // 旧档案没有 DP/HP：从编队原始数据现算（面板推算），算不出时该成员不计受伤
      members.forEach((m,i)=>{if(!m.vitals?.dp){const raw=P.members[i]?.raw;if(raw&&statsData){const r=computePanel(raw,{stats:statsData,equipment,catalog});if(r.final)m.vitals={dp:Math.round(r.final.dp),hp:Math.round(r.final.hp)};}}});
      const party=buildParty(members,{skills,catalog,stats:statsData});
      const rules=ev.kind==='scoreAttack'||ev.kind==='wave'?ev.rules.filter(r=>sel.rules.includes(r.id)):[...(stage.rules||[])];
      // 设计器的阶段：遭遇战 = 全部阶段、每阶段全部敌人；其他 = 当前关卡的目标敌人
      const phases=phasesFor(ev,stage,rules);
      const list=phases[ev.kind==='wave'?sel.stage:0].enemies;
      const enemy=list.find(x=>x.label===sel.enemy)||list.find(x=>ev.enemies?.[x.label]?.flags?.is_boss)||list[0];
      return {party,enemy,phases,rules};
    }catch(err){return {error:err.message};}
  }
  function calcHtml(ev,stage){
    if(!ev||!stage)return '<h2>伤害计算器</h2><p class="subtle">先选对手。</p>';
    const c=buildCtx(ev,stage);
    if(c.error)return `<h2>伤害计算器</h2><p class="subtle">${e(c.error)}</p>`;
    const {party,enemy}=c;
    const atk=party[Math.min(calc.attacker,party.length-1)];
    const attackIdx=atk.skills.map((s,k)=>[s,k]).filter(([s])=>hasAttack(s));
    if(calc.skill==null||!attackIdx.some(([,k])=>k===calc.skill))calc.skill=attackIdx[0]?.[1]??null;
    const supports=party.flatMap(u=>u.skills.map((s,k)=>({u,s,k})).filter(x=>hasEffect(x.s)));
    let out='';
    if(calc.skill!=null){
      const st=initialState(party,enemy,{statusTypes:skills.statusTypes});
      st.units.forEach(u=>{u.morale=calc.morale;u.tokens=calc.tokens;});
      st.enemy.dr=Math.max(1,calc.dr/100);
      for(const key of calc.pre){const [ui,k]=key.split(':').map(Number);applyEffectsOnly(st,ui,k);}
      const pv=previewAttack(st,atk.i,calc.skill,{level:calc.level||undefined});
      out=pv?breakdown(pv,enemy):'<p class="subtle">这个技能没有攻击部件。</p>';
    }
    return `<h2>伤害计算器 <small class="subtle">单次技能，按社区计算器的式子逐段计算</small></h2>
<div class="field-grid three">
  <label>攻击者<select id="pc-atk">${party.map(u=>`<option value="${u.i}" ${u.i===atk.i?'selected':''}>${e(u.name)}〈${e(u.styleName)}〉</option>`).join('')}</select></label>
  <label>技能<select id="pc-skill">${attackIdx.map(([s,k])=>`<option value="${k}" ${k===calc.skill?'selected':''}>${e(s.name)} · SP${s.sp} · Lv${s.level}</option>`).join('')}</select></label>
  <label>技能等级<input id="pc-level" type="number" min="1" max="20" value="${calc.level??''}" placeholder="档案值"></label>
  <label>士气等级（全员）<input id="pc-morale" type="number" min="0" max="10" value="${calc.morale}"></label>
  <label>标记数（全员）<input id="pc-tokens" type="number" min="0" max="10" value="${calc.tokens}"></label>
  <label>当前破坏率 %<input id="pc-dr" type="number" min="100" max="99999" value="${calc.dr}"></label>
</div>
<details ${calc.pre.length?'open':''}><summary>先施加这些技能的增益/减益（按勾选顺序，已选 ${calc.pre.length}）</summary>
<div class="pre-list">${supports.map(x=>{const key=`${x.u.i}:${x.k}`;return `<label class="inline"><input type="checkbox" data-pc-pre="${key}" ${calc.pre.includes(key)?'checked':''}>${e(x.u.name)} · ${e(x.s.name)} <small class="subtle">${e(effectTypes(x.s))}</small></label>`;}).join('')}</div></details>
${out}`;
  }
  function breakdown(pv,enemy){
    const {res,mods,model,stats}=pv,M=res.meta;
    const pct=x=>`${Math.round(x*10)/10}%`,mul=x=>`×${(Math.round(x*1000)/1000).toFixed(3)}`;
    const rows=res.perHit.map((h,k)=>{const c=res.perHitCrit[k];return `<tr><td>${k+1}${k>=res.consecutiveHitStartIndex?' <span class="tag">连击</span>':''}</td><td>${h.dp?'DP':'HP'}</td><td class="num">${n(h.min)}–${n(h.max)}</td><td class="num">${n(c.min)}–${n(c.max)}</td><td class="num">${pct(res.destructionPerHit[k]*100)}</td></tr>`;}).join('');
    return `<div class="result-metrics calc-metrics">
<div><strong>${n(Math.round(res.total.min))}–${n(Math.round(res.total.max))}</strong><span>合计（不暴击）</span></div>
<div><strong>${n(Math.round(res.total.critMin))}–${n(Math.round(res.total.critMax))}</strong><span>合计（全暴击）</span></div>
<div><strong>${pct(res.critRate.total)}</strong><span>暴击率（基础 ${pct(res.critRate.base)}）</span></div>
<div><strong>${pct((res.destructionPerHit.at(-1)??1)*100)}</strong><span>最后一段时破坏率</span></div></div>
<p class="compact">加权能力 ${Math.round(model.parameters&&weighted(model.parameters,stats))} − 基准 ${M.border} = 差 ${Math.round(M.statDiff)}（上限 ${model.paramLimit}）→ 基础威力 ${n(M.basePower)}，暴击时 ${n(M.critBasePower)}；
攻击组 ${mul(M.attack.hp)}（对DP ${mul(M.attack.dp)}）· 防御组 ${mul(M.defense.hp)}（对DP ${mul(M.defense.dp)}）· 物理 ${mul(M.physMult)} · 属性 ${mul(M.elemMult)}${M.weak?' · <b>弱点</b>（心眼/脆弱生效）':''} · 暴击倍率 ${mul(M.critMultiplier)} · 破坏倍率 ${Math.round(M.destructionRateBonus*100)/100}</p>
<p class="subtle compact">攻击组构成：技能攻击 ${pct(mods.attackUp)} + 被动 ${pct(mods.passiveAttackUp)} + 属性 ${pct(mods.elementAttackUp+mods.passiveElementAttackUp)} + 领域 ${pct(mods.field)} + 心眼 ${pct(M.weak?mods.mindsEye:0)} + 士气 ${mods.morale*5}% + 蓄力 ${pct(mods.chargeAttackUp)}${mods.necklace?' + 项链 10%':''}${mods.ringLevel!=null?` + 戒指 ${[2,4,6,8,10][mods.ringLevel]}%`:''}${mods.earring?.type?` · 耳环 ${EARRING_LABEL[mods.earring.type]} ${mods.earring.bonus}`:''}；防御组：防御下降 ${pct(mods.defenseDown+mods.passiveDefenseDown+mods.permanentDefenseDown)} + 属性防御下降 ${pct(mods.elementDefenseDown+mods.permanentElementDefenseDown)} + 脆弱 ${pct(M.weak?mods.fragile:0)}；连击 ${mods.funnel.length} 段</p>
<div class="table-wrap"><table class="planner-log"><thead><tr><th>段</th><th>对</th><th>伤害（浮动 90–110%）</th><th>暴击时</th><th>该段时破坏率</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function weighted(p,s){const w=Object.entries(p).filter(([,v])=>v>0),t=w.reduce((a,[,v])=>a+v,0);return t?w.reduce((a,[k,v])=>a+s[k]*v,0)/t:(s.str+s.dex)/2;}
  const allParts=s=>(s.parts||[]).flatMap(p=>p.branches?[p,...p.branches.flatMap(b=>b.parts||[])]:[p]);
  const hasAttack=s=>allParts(s).some(p=>ATTACK_PART_TYPES.has(p.skillType));
  const hasEffect=s=>allParts(s).some(p=>/AttackUp|MindEye|Critical|Funnel|BuffCharge|Zone|DefenseDown|Fragile|ResistDown|Hacking|Misfortune|DamageRateUp|Morale|TokenSet|SuperBreak|ShadowClone|EternalOath|BIYamawakiServant/.test(p.skillType));
  const effectTypes=s=>[...new Set(allParts(s).map(p=>p.skillType).filter(t=>!ATTACK_PART_TYPES.has(t)&&t!=='SkillCondition'&&t!=='SkillSwitch'))].join('、');

  // ---------------------------------------------------------------- 结果
  function progressText(){
    if(!progress)return '';
    return `回合 ${progress.turn}/${progress.maxTurns} · 已展开 ${n(progress.expanded)} 个状态 · 已击破方案 ${progress.finished} · ${(progress.elapsed/1000).toFixed(1)} 秒`;
  }
  function resultHtml(r){
    const plans=r.plans.length?r.plans:(r.unfinished?[r.unfinished]:[]);
    if(!plans.length)return '<section class="panel spaced"><p>没有找到可行方案。</p></section>';
    shown=Math.min(shown,plans.length-1);
    const p=plans[shown];
    const flags=[...Object.entries(r.flags.unsupported).map(([k,v])=>['未支持',k,v]),...Object.entries(r.flags.approx).map(([k,v])=>['近似',k,v])];
    return `<section class="panel spaced">
<div class="split-heading"><h2>结果 <small class="subtle">${(r.elapsed/1000).toFixed(1)} 秒 · 展开 ${n(r.expanded)} 个状态</small></h2></div>
${r.plans.length?'':`<p class="pill-error">回合上限内没有击破。下面是推进最多的一条（剩余 ${(100-p.progress*100).toFixed(1)}%）。</p>`}
<p class="compact"><button id="pl-todesign" type="button">把这个方案载入排轴设计器（可逐步修改）</button>${p.wipedTurn?` <span class="pill-error">第 ${p.wipedTurn} 回合有成员 HP 清零（失败）</span>`:''}</p>
<div class="tags">${plans.map((x,i)=>`<button class="${i===shown?'primary':'quiet'}" data-pl-plan="${i}">方案 ${i+1}：${x.killedTurn?`${x.killedTurn} 回合击破`:'未击破'} · 计分伤害 ${n(Math.round(x.scoreDamage))}${x.score?.valid?` · ${n(x.score.total)} 分`:''}</button>`).join('')}</div>
${p.score?.valid?`<p class="compact">推定总分 <b>${n(p.score.total)}</b>（基础 ${n(p.score.base)} + 伤害 ${n(p.score.damage)} + NoBreak ${n(p.score.noBreak)}）× 回合 ${p.score.turnMultiplier} × 规则 ${p.score.ruleMultiplier.toFixed(2)}；NoBreak 按“达成”假设。</p>`:''}
<p class="subtle compact">每回合伤害：${p.turnDamage.slice(1).map((d,i)=>`T${i+1} ${n(Math.round(d))}`).join(' · ')}</p>
${timeline(p)}
${flags.length?`<details><summary>未支持／近似处理的机制（${flags.length} 项，搜索中累计出现次数）</summary><ul class="compact">${flags.sort((a,b)=>b[2]-a[2]).map(([t,k,v])=>`<li>${t} · ${e(k)} <small class="subtle">×${n(v)}</small></li>`).join('')}</ul></details>`:''}
</section>`;
  }
  function timeline(p){
    if(!lastAxisEnv||!p.plan)return '';
    return axisView({e,n,...lastAxisEnv,design:designFromPlan(p.plan,lastParty)}).html;
  }
  function rulesHtml(){
    return `<ul class="compact">
<li><b>伤害</b>（社区 Calculator）：基础威力按“加权能力−基准”对参数上限分段（超出每点 +0.25%）；技能攻击/领域/心眼(弱点)/蓄力/士气/项链/戒指/耳环同组相加；防御下降与脆弱(弱点)同组；物理×属性弱点；暴击基准−50、×(1.5+暴伤)、基础暴击率 min(10%,1.5%+(运−基准)×0.04%)；连击为追加段；破坏率按段累计；单段 10 亿软上限。</li>
<li><b>效果量</b>：增益按施放者加权能力（不减基准），减益按能力−基准；泪、效果量上升按原式。同类增益最多 2 个（[单独发动] 占满），被动不占槽；取效果量最大的组合。</li>
<li><b>回合</b>（社区 Planner）：普通回合全员 SP+2（已 ≥20 不加）；OD 首轮全员 SP +5/+12/+20、OD 轮各算一回合；每段 OD +2.5%（DRIVE 耳环按段数加成），普攻按 3 段，被抗不加 OD；追加回合不加 SP，只给获得者计时；仅本轮/次数/回合数/永久四种持续。</li>
<li><b>仍为推定</b>：普通攻击威力（300–600、力2灵巧1）；敌方按行动表顺序循环；“每 N 回合”规则首次在第 N 回合；计分公式取自 hbr.quest；泪等级取缓存 _daphneUsedNum；增益超过 2 个时保留效果量最大的。</li>
<li><b>主数据与社区表的差异</b>：部分技能 Lv1 威力取整、少数技能破坏倍率/对 HP 倍率/[单独发动]增益数值与社区（国际服）表不同，以主数据为准。</li></ul>`;
  }

  // ---------------------------------------------------------------- 交互
  function persist(){const a=getArchive();a.planner.settings={...opt};save();}
  function bind(host,ev,stage){
    const q=s=>host.querySelector(s),on=(s,t,f)=>{const el=q(s);if(el)el.addEventListener(t,f);};
    const P=planner();
    const recalc=()=>{const box=q('#pl-calc');if(box){box.innerHTML=calcHtml(ev,stage);bindCalc(host,ev,stage);}};
    on('#pl-kind','change',x=>{sel.kind=x.target.value;sel.label='';if(sel.kind!=='scoreAttack'&&sel.kind!=='wave'&&opt.objective==='score')opt.objective='minTurns';mount(host).then(saveSel);});
    on('#pl-event','change',x=>{sel.label=x.target.value;sel.stage=-1;sel.rules=[];sel.enemy='';saveSel();mount(host);});
    on('#pl-stage','change',x=>{sel.stage=Number(x.target.value);sel.enemy='';saveSel();mount(host);});
    on('#pl-enemy','change',x=>{sel.enemy=x.target.value;saveSel();mount(host);});
    host.querySelectorAll('[data-pl-rule]').forEach(c=>c.onchange=()=>{const id=Number(c.dataset.plRule),max=ev?.maxRules||1;sel.rules=c.checked?[...sel.rules.filter(x=>x!==id),id].slice(-max):sel.rules.filter(x=>x!==id);saveSel();mount(host);});
    host.querySelectorAll('[data-pl-style]').forEach(s=>s.onchange=()=>{const m=P.members[Number(s.dataset.plStyle)];m.styleId=s.value;delete m.equipment;delete m.deckSkillIds;m.initialSp=0;m.tearLevel=0;mount(host);});
    host.querySelectorAll('[data-pl-front]').forEach(c=>c.onchange=()=>{P.members[Number(c.dataset.plFront)].front=c.checked;q('#pl-issues').innerHTML=issuesHtml(P);recalc();});
    host.querySelectorAll('[data-pl-stat]').forEach(inp=>inp.onchange=()=>{
      const [i,k]=inp.dataset.plStat.split(':');const v=inp.value.trim(),m=P.members[Number(i)];m.stats=m.stats||{};
      if(v==='')delete m.stats[k];else{const x=Math.round(Number(v));if(Number.isFinite(x)&&x>=0&&x<=99999)m.stats[k]=x;else{inp.value=m.stats[k]??'';return;}}
      if(m.raw){m.statsManual=[...new Set([...(m.statsManual||[]),k])];const cell=inp.closest('tr')?.querySelector('.equip-cell');if(cell){cell.innerHTML=panelCell(m,Number(i));bindPanelButtons(cell);}}
      q('#pl-issues').innerHTML=issuesHtml(P);recalc();
    });
    // 面板明细/恢复推算按钮（用 onclick 赋值，重复绑定也只有一个处理函数）
    const bindPanelButtons=root=>{
      root.querySelectorAll('[data-pl-panel]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.plPanel);openPanel=openPanel===i?null:i;mount(host);});
      root.querySelectorAll('[data-pl-reset]').forEach(b=>b.onclick=()=>{const m=P.members[Number(b.dataset.plReset)];const r=computePanel(m.raw,{stats:statsData,equipment,catalog});if(r.final){for(const k of STATS)m.stats[k]=Math.round(r.final[k]);m.statsManual=[];}persist();mount(host);});
    };
    bindPanelButtons(host);
    on('#pl-save','click',()=>{persist();notice('排轴器队伍已保存到档案。');});
    on('#pl-decks','click',async()=>{
      try{const r=await cacheDecks();decks={list:r.decks,readAt:r.read_at};cachePool={decks:r.decks,cards:r.cards||[],accessories:r.accessories||[]};}catch(err){decks={error:'读取游戏编队失败：'+err.message};}
      mount(host);
    });
    on('#pl-deck-apply','click',()=>{
      const d=decks?.list?.find(x=>x.index===Number(q('#pl-deck').value));if(!d)return;
      P.members=membersFromDeck(d,{catalog,equipment,stats:statsData,previous:P.members});persist();
      notice(`已导入编队 ${d.index}「${d.name}」：卡面、突破、泪、编队技能、饰品、初期 SP 已带入，面板已按缓存推算（公式待校准，可点“面板明细”核对，手改的项会保留）。`);
      decks=null;mount(host);
    });
    on('#pl-objective','change',x=>{opt.objective=x.target.value;});
    on('#pl-turns','change',x=>{opt.maxTurns=Math.max(1,Math.min(30,Math.round(Number(x.target.value))||8));});
    on('#pl-beam','change',x=>{opt.beam=Number(x.target.value);});
    on('#pl-crit','change',x=>{opt.critMode=x.target.value;});
    on('#pl-odw','change',x=>{opt.odWindows=x.target.value;});
    on('#pl-od','change',x=>{opt.allowOd=x.target.checked;});
    host.querySelectorAll('[data-pl-plan]').forEach(b=>b.onclick=()=>{shown=Number(b.dataset.plPlan);q('#pl-result').innerHTML=resultHtml(result);bind(host,ev,stage);});
    on('#pl-stop','click',()=>{if(worker){worker.terminate();worker=null;progress=null;mount(host);}});
    on('#pl-run','click',()=>run(host,ev,stage));
    on('#pl-todesign','click',()=>{
      const plans=result?.plans?.length?result.plans:(result?.unfinished?[result.unfinished]:[]);const p=plans[shown];if(!p||!lastParty)return;
      const P=planner(),k=designKey(ev,stage);const d=designFromPlan(p.plan,lastParty);
      if(ev.kind==='wave'){const cur=designOf(ev,stage,ev.stages.length);const ph=Math.max(0,sel.stage);cur.phases[ph]=d.phases[0];if(dview[k])dview[k].phase=ph;}
      else P.designs[k]=d;
      save();mountDesigner(host,ev,stage);moreOpen=true;const more=host.querySelector('.pl-more');if(more)more.open=true;host.querySelector('#pl-designer')?.scrollIntoView({behavior:'smooth'});notice('已载入排轴设计器。');
    });
    bindCalc(host,ev,stage);
  }
  function bindCalc(host,ev,stage){
    const q=s=>host.querySelector(s),on=(s,t,f)=>{const el=q(s);if(el)el.addEventListener(t,f);};
    const redo=()=>{const box=q('#pl-calc');box.innerHTML=calcHtml(ev,stage);bindCalc(host,ev,stage);};
    on('#pc-atk','change',x=>{calc.attacker=Number(x.target.value);calc.skill=null;calc.level=null;redo();});
    on('#pc-skill','change',x=>{calc.skill=Number(x.target.value);calc.level=null;redo();});
    on('#pc-level','change',x=>{const v=Math.round(Number(x.target.value));calc.level=v>0?Math.min(20,v):null;redo();});
    on('#pc-morale','change',x=>{calc.morale=Math.max(0,Math.min(10,Math.round(Number(x.target.value))||0));redo();});
    on('#pc-tokens','change',x=>{calc.tokens=Math.max(0,Math.min(10,Math.round(Number(x.target.value))||0));redo();});
    on('#pc-dr','change',x=>{calc.dr=Math.max(100,Math.round(Number(x.target.value))||100);redo();});
    host.querySelectorAll('[data-pc-pre]').forEach(c=>c.onchange=()=>{const k=c.dataset.pcPre;calc.pre=c.checked?[...calc.pre.filter(x=>x!==k),k]:calc.pre.filter(x=>x!==k);redo();});
  }

  function run(host,ev,stage){
    if(!ev||!stage){notice('先选对手。');return;}
    const c=buildCtx(ev,stage);if(c.error){notice(c.error);return;}
    persist();
    const waveScoreMode=ev.kind==='wave'&&opt.objective==='score';
    const objective=waveScoreMode?'waveScore':ev.kind!=='scoreAttack'&&opt.objective==='score'?'minTurns':opt.objective;
    const ws_=planner().waveSettings||{};
    const options={objective,maxTurns:opt.maxTurns,beam:Number(opt.beam),critMode:opt.critMode,allowOd:opt.allowOd,
      odWindows:opt.odWindows==='both'?['turnStart','turnEnd']:[opt.odWindows],
      damageNorm:stage.damageCap||Math.max(1,(c.enemy.maxHp+c.enemy.maxDp)/10),
      ...(waveScoreMode?{turnCost:waveRoundScore(5,ws_.difficulty||40,ws_.international!==false)-waveRoundScore(6,ws_.difficulty||40,ws_.international!==false),extraTurns:1,overkill:ws_.overkill!==false}:{}),
      score:ev.kind==='scoreAttack'&&ev.scoreCalc?.tmdc?{calc:ev.scoreCalc,stage,rules:ev.rules.filter(r=>sel.rules.includes(r.id)),noBreak:true}:null};
    lastParty=c.party;lastAxisEnv={party:c.party,phases:[{name:c.enemy.name,enemies:[c.enemy]}],statusTypes:skills.statusTypes,critMode:options.critMode,simulationOptions:options};
    result=null;shown=0;progress={turn:0,maxTurns:options.maxTurns,expanded:0,finished:0,elapsed:0};
    worker=new Worker('/sim/worker.mjs',{type:'module'});
    worker.onmessage=m=>{
      const d=m.data;
      if(d.stage==='progress'){progress=d;const el=host.querySelector('#pl-progress');if(el)el.textContent=progressText();}
      else if(d.stage==='done'){result=d.result;worker.terminate();worker=null;mount(host);}
      else if(d.stage==='error'){notice('排轴失败：'+d.message);worker.terminate();worker=null;mount(host);}
    };
    worker.onerror=err=>{notice('排轴 Worker 出错：'+(err.message||'未知错误'));worker?.terminate();worker=null;mount(host);};
    worker.postMessage({party:c.party,enemy:c.enemy,statusTypes:skills.statusTypes,options});
    mount(host);
  }
  return {mount};
}
