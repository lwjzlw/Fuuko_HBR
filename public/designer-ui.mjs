// 排轴设计器界面：逐回合手排（前卫、OD、三人行动、追加回合），每次修改即用引擎重放，显示状态与问题。
import {simulateDesign,emptyTurn,skillChoices} from './sim/designer.mjs';
import {waveScore} from './boss-model.mjs';
import {CARDS} from './sim/cards.mjs';
import {groupAxisRows,renderAxisRows,replayAssumptions} from './planner-axis.mjs';

const ROUNDS=['main','extra'];
const clone=x=>JSON.parse(JSON.stringify(x));
// 敌方技能没有名字时（主数据只有内部 label）按 label 归类显示
const enemySkillName=x=>!/_/.test(x||'')?x:/AttackAll/i.test(x)?'全体攻击':/AttackSingle/i.test(x)?'单体攻击':/AttackUp/i.test(x)?'攻击上升':/Heal/i.test(x)?'回复':/Defense/i.test(x)?'防御':/Charge/i.test(x)?'蓄力':'特殊行动';

/**
 * env = {e, n, host, party, phases:[{name, enemies:[enemy…]}], statusTypes, opt:{critMode}, design, save(design),
 *        wave:{rules, difficulty, international}|null, setWave(patch), notice}
 */
export function renderDesigner(env){
  const {e,n,host,party,phases}=env;
  const design=env.design;
  while(design.phases.length<phases.length)design.phases.push({turns:[emptyTurn()]});
  const view=env.view||(env.view={phase:0,crit:env.opt.critMode||'expected',vary:1.1,target:'worst'});
  view.phase=Math.min(view.phase,phases.length-1);
  const res=simulateDesign({party,phases,statusTypes:env.statusTypes},{critMode:view.crit,enemyVariance:Number(view.vary),enemyTargeting:view.target||'worst'},design);
  const ph=design.phases[view.phase];
  const name=i=>e(party[i]?.name||'#'+i);
  const memberOpts=(cur,pool)=>`<option value="">—</option>${pool.map(i=>`<option value="${i}" ${i===cur?'selected':''}>${name(i)}</option>`).join('')}`;
  const skillOpts=(u,cur)=>{if(!Number.isInteger(u))return '<option value="">—</option>';
    return skillChoices(party[u]).map(c=>`<option value="${e(c.s)}" ${c.s===cur?'selected':''}>${e(c.name)}${c.sp?` · SP${c.sp}`:''}</option>`).join('');};
  const slots=(path,list,count,pool)=>Array.from({length:count},(_,k)=>{const a=list?.[k]||{};
    return `<span class="slot"><select data-dz-u="${path}|${k}" aria-label="行动者">${memberOpts(a.u,pool)}</select><select data-dz-s="${path}|${k}" aria-label="技能">${skillOpts(a.u,a.s)}</select></span>`;}).join('');
  const all=party.map((_,i)=>i);
  const frontSel=(path,front)=>[0,1,2].map(k=>`<select data-dz-f="${path}|${k}" aria-label="前卫 ${k+1}">${memberOpts(front?.[k],all)}</select>`).join('');
  const odBlock=(t,ti,key,label)=>{
    const od=t[key];
    const lv=`<label>${label}<select data-dz-od="${ti}|${key}"><option value="0">不开</option>${[1,2,3].map(l=>`<option value="${l}" ${od?.level===l?'selected':''}>OD${l}</option>`).join('')}</select></label>`;
    if(!od?.level)return lv;
    const rounds=Array.from({length:od.level},(_,r)=>{const R=od.rounds?.[r]||{};
      return `<div class="dz-round"><b>OD 第 ${r+1} 轮</b> 前卫 ${frontSel(`${ti}|${key}|${r}`,R.front)}<br>${slots(`${ti}|${key}|${r}|actions`,R.actions,3,all)}
      <details ${R.extra?.some(a=>a.s)?'open':''}><summary>追加回合</summary>${slots(`${ti}|${key}|${r}|extra`,R.extra,3,all)}</details></div>`;}).join('');
    return lv+rounds;
  };
  // 每回合的结果摘要
  const rowsOf=ti=>res.rows.filter(r=>r.phase===view.phase&&r.turn===turnNo(ti));
  const turnBase=design.phases.slice(0,view.phase).reduce((a,p,i)=>a+(res.phases[i]?.turns??p.turns.length),0);
  const turnNo=ti=>turnBase+ti+1;
  const summary=ti=>{
    const rs=rowsOf(ti);if(!rs.length)return '<p class="subtle compact">（未执行：前面已击破或已失败）</p>';
    const last=rs.at(-1),dmg=rs.filter(r=>r.kind==='act').reduce((a,r)=>a+r.damage,0);
    const iss=res.issues.filter(x=>x.turn===turnNo(ti));
    const acts=renderAxisRows(groupAxisRows(rs),{e,n,party});
    const enemy=rs.filter(r=>r.kind==='enemy').map(r=>`<p class="compact subtle">敌方：${e([...new Set(r.events.filter(x=>x.t==='enemy').map(x=>enemySkillName(x.skill)))].join('、')||'—')}${r.events.some(x=>x.t==='dpBreak')?' <span class="pill-error">有人倒下</span>':''}</p>`).join('');
    return `${acts}${enemy}
<p class="compact subtle">本回合伤害 ${n(dmg)} · OD ${last.od}% · 敌 ${e(last.enemy.name)} DP ${n(last.enemy.dp)} / HP ${n(last.enemy.hp)} · 破坏率 ${last.enemy.dr}%${last.trans!=null?` · 超越 ${last.trans}%`:''}</p>
<p class="compact subtle">SP ${last.sp.map((v,i)=>`${name(i)} ${Math.round(v*10)/10}`).join(' · ')}</p>
<p class="compact subtle">DP/HP ${last.allies.map((a,i)=>a.dpMax?`${name(i)} ${n(a.dp)}/${n(a.hp)}${a.broken?' <b class="pill-error">倒下</b>':''}`:`${name(i)} ?`).join(' · ')}</p>
${iss.length?`<ul class="compact">${iss.map(x=>`<li class="${x.level==='error'?'pill-error':'subtle'}">${e(x.msg)}</li>`).join('')}</ul>`:''}`;
  };
  const turnHtml=(t,ti)=>`<div class="dz-turn">
<div class="split-heading"><h3>第 ${turnNo(ti)} 回合</h3><div class="inline"><button class="link" data-dz-copy="${ti}" type="button">复制到下一回合</button><button class="link" data-dz-del="${ti}" type="button">删除</button></div></div>
<div class="dz-grid">
  <div>${odBlock(t,ti,'odStart','回合开始 OD')}
  <div class="dz-round"><b>普通行动</b> 前卫 ${frontSel(`${ti}|main`,t.front)}<br>${slots(`${ti}|actions`,t.actions,3,all)}
  <details ${t.extra?.some(a=>a.s)?'open':''}><summary>追加回合</summary>${slots(`${ti}|extra`,t.extra,3,all)}</details></div>
  ${odBlock(t,ti,'odEnd','回合结束 OD')}</div>
  <div class="dz-result">${summary(ti)}</div>
</div></div>`;
  const W=env.wave;
  let waveHtml='';
  if(W){
    const overkill=W.overkill!==false;
    const damages=phases.map((_,i)=>overkill?res.phases[i]?.shown??res.phases[i]?.damage??0:res.phases[i]?.damage||0);
    const sc=waveScore({damages,turns:res.turns,difficulty:Number(W.difficulty)||40,rules:W.rules,international:W.international});
    waveHtml=`<div class="dz-wave"><h3>遭遇战计分</h3>
<div class="field-grid three"><label>难度<input id="dz-diff" type="number" min="1" max="40" value="${W.difficulty}"></label>
<label class="inline"><input id="dz-intl" type="checkbox" ${W.international?'checked':''}>国际服回合分（总回合 −3）</label>
<label class="inline"><input id="dz-overkill" type="checkbox" ${overkill?'checked':''}>伤害分计溢出伤害（推定）</label></div>
<p class="compact">各阶段伤害 ${damages.map((d,i)=>`${i+1}面 ${n(d)}（${n(sc.phaseScores[i])} 分）`).join(' · ')}</p>
<p class="compact">伤害分 ${n(sc.damageScore)} + 回合分 ${n(sc.roundScore)}（${res.turns} 回合）+ 难度分 ${n(sc.difficultyScore)} → × 规则 ${sc.multiplier.toFixed(2)} = <b>${n(sc.total)}</b>${res.failed?' <span class="pill-error">（设计中途失败，分数无效）</span>':''}</p>
<p class="subtle compact">计分按社区遭遇战出分表 / HBR Toolbox。敌人使用主界面“敌方参数”所列数值，DP/HP 底表尚未完成各难度实战校准；可填写已知实测值，修改难度会重建回放。勾选“计溢出”时每阶段伤害 = 画面显示的全部伤害（含击破那一下超出的部分），否则只计实际扣掉的 DP/HP。</p></div>`;
  }
  const flags=Object.entries(res.flags?.approx||{}).map(([k,v])=>`${e(k)} ×${v}`);
  host.innerHTML=`<div class="split-heading"><h2>排轴设计器 <small class="subtle">手排每回合行动，修改即重放</small></h2>
<div class="inline"><label>暴击<select id="dz-crit">${[['expected','期望'],['none','不暴击'],['all','全暴击']].map(([k,t])=>`<option value="${k}" ${k===view.crit?'selected':''}>${t}</option>`).join('')}</select></label>
<label>敌方伤害<select id="dz-vary">${[['1.1','最大（×1.1，保守）'],['1','平均']].map(([k,t])=>`<option value="${k}" ${String(view.vary)===k?'selected':''}>${t}</option>`).join('')}</select></label>
<label>敌方单体攻击<select id="dz-target">${[['worst','集火最危险的人（保守）'],['spread','平均分摊（期望）']].map(([k,t])=>`<option value="${k}" ${(view.target||'worst')===k?'selected':''}>${t}</option>`).join('')}</select></label>
<button id="dz-clear" class="quiet" type="button">清空</button></div></div>
<p class="subtle compact axis-assumptions">${e(replayAssumptions(view.crit))}</p>
${phases.length>1?`<div class="tags">${phases.map((p,i)=>`<button class="${i===view.phase?'primary':'quiet'}" data-dz-phase="${i}" type="button">第 ${i+1} 阶段 · ${e(p.name)}${res.phases[i]?.cleared?' ✓':''}</button>`).join('')}</div>`:''}
${res.failed?`<p class="pill-error">第 ${res.failed} 回合有成员 HP 清零：战斗失败。</p>`:''}
${phases.length>1&&view.phase>0?`<p class="compact"><label>进入本阶段前选的战术卡 <select id="dz-card"><option value="">（不选）</option>${[...new Set(CARDS.map(c=>c.cat))].map(cat=>`<optgroup label="${e(cat)}">${CARDS.filter(c=>c.cat===cat).map(c=>`<option value="${c.id}" ${ph.card===c.id?'selected':''}>${e(c.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
<small class="subtle">${e((CARDS.find(c=>c.id===ph.card)||{}).desc||'#08 每战结束后 3 选 1，可重抽 5 次；共 28 张（按 2026-11-09 游戏截图录入）。选中的卡从下一阶段起一直有效。')}</small></p>`:''}
${ph.turns.map(turnHtml).join('')}
<div class="inline"><button id="dz-add" type="button">+ 添加回合</button></div>
${waveHtml}
${flags.length?`<details><summary>近似处理（${flags.length}）</summary><p class="compact subtle">${flags.join(' · ')}</p></details>`:''}`;
  bindDesigner(env,res);
}

function listAt(design,phase,path){
  const [ti,key,r,sub]=path.split('|');const t=design.phases[phase].turns[Number(ti)];
  if(key==='actions'||key==='extra'){t[key]=t[key]||[];return t[key];}
  const od=t[key];od.rounds=od.rounds||[];const R=od.rounds[Number(r)]=od.rounds[Number(r)]||{front:null,actions:[],extra:[]};
  R[sub]=R[sub]||[];return R[sub];
}
function frontAt(design,phase,path){
  const [ti,key,r]=path.split('|');const t=design.phases[phase].turns[Number(ti)];
  if(key==='main'){t.front=t.front||[null,null,null];return t.front;}
  const od=t[key];od.rounds=od.rounds||[];const R=od.rounds[Number(r)]=od.rounds[Number(r)]||{front:null,actions:[],extra:[]};
  R.front=R.front||[null,null,null];return R.front;
}

function bindDesigner(env,res){
  const {host}=env,design=env.design,view=env.view,P=view.phase;
  const commit=()=>{for(const ph of design.phases)for(const t of ph.turns){if(t.front&&t.front.every(x=>x==null))t.front=null;}env.save(design);renderDesigner(env);};
  host.querySelectorAll('[data-dz-u]').forEach(s=>s.onchange=()=>{const parts=s.dataset.dzU.split('|');const k=Number(parts.pop());const list=listAt(design,P,parts.join('|'));
    list[k]={u:s.value===''?null:Number(s.value),s:''};commit();});
  host.querySelectorAll('[data-dz-s]').forEach(s=>s.onchange=()=>{const parts=s.dataset.dzS.split('|');const k=Number(parts.pop());const list=listAt(design,P,parts.join('|'));
    list[k]={...(list[k]||{}),s:s.value};commit();});
  host.querySelectorAll('[data-dz-f]').forEach(s=>s.onchange=()=>{const parts=s.dataset.dzF.split('|');const k=Number(parts.pop());const f=frontAt(design,P,parts.join('|'));
    f[k]=s.value===''?null:Number(s.value);commit();});
  host.querySelectorAll('[data-dz-od]').forEach(s=>s.onchange=()=>{const [ti,key]=s.dataset.dzOd.split('|');const t=design.phases[P].turns[Number(ti)];const l=Number(s.value);
    t[key]=l?{level:l,rounds:(t[key]?.rounds||[]).slice(0,l)}:null;commit();});
  host.querySelectorAll('[data-dz-copy]').forEach(b=>b.onclick=()=>{const ti=Number(b.dataset.dzCopy);const turns=design.phases[P].turns;turns.splice(ti+1,0,clone(turns[ti]));commit();});
  host.querySelectorAll('[data-dz-del]').forEach(b=>b.onclick=()=>{const turns=design.phases[P].turns;turns.splice(Number(b.dataset.dzDel),1);if(!turns.length)turns.push(emptyTurn());commit();});
  host.querySelectorAll('[data-dz-phase]').forEach(b=>b.onclick=()=>{view.phase=Number(b.dataset.dzPhase);renderDesigner(env);});
  const on=(id,t,f)=>{const el=host.querySelector(id);if(el)el.addEventListener(t,f);};
  on('#dz-add','click',()=>{design.phases[P].turns.push(emptyTurn());commit();});
  on('#dz-card','change',x=>{design.phases[P].card=x.target.value||null;commit();});
  on('#dz-clear','click',()=>{if(confirm('清空本阶段的设计？')){design.phases[P].turns=[emptyTurn()];commit();}});
  on('#dz-crit','change',x=>{view.crit=x.target.value;renderDesigner(env);});
  on('#dz-vary','change',x=>{view.vary=x.target.value;renderDesigner(env);});
  on('#dz-target','change',x=>{view.target=x.target.value;renderDesigner(env);});
  on('#dz-diff','change',x=>{env.setWave({difficulty:Math.max(1,Math.min(40,Math.round(Number(x.target.value))||40))});renderDesigner(env);});
  on('#dz-intl','change',x=>{env.setWave({international:x.target.checked});renderDesigner(env);});
  on('#dz-overkill','change',x=>{env.setWave({overkill:x.target.checked});renderDesigner(env);});
}
