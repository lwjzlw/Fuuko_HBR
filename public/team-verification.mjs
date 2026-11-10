export function compareTeamReference(archive,catalog){
  const ref=archive.teamReference;if(!ref)return null;
  const rows=ref.members.map((m,i)=>{
    const s=catalog.styles.find(x=>x.id===m.styleId),cp=archive.characters[s?.characterId]||{},sp=archive.styles[m.styleId]||{};
    const combinedLevel=cp.level==null||sp.cardLevel==null?null:cp.level+sp.cardLevel;
    const checks={level:combinedLevel==null?null:combinedLevel===m.level,limitBreak:sp.limitBreak==null?null:sp.limitBreak===m.limitBreak,reincarnation:cp.reincarnation==null?null:cp.reincarnation===m.reincarnation,bloomed:sp.bloomed==null?null:sp.bloomed===m.bloomed};
    return {...m,style:s,character:catalog.characters.find(c=>c.id===s?.characterId),classLevel:cp.level,styleLevel:sp.cardLevel,combinedLevel,checks,teamMatches:archive.team[i]?.styleId===m.styleId&&(archive.team[i]?.supportStyleId||'')===m.supportStyleId};
  });
  const ownSum=rows.reduce((s,r)=>s+r.power,0),supportSum=rows.reduce((s,r)=>s+r.supportPower,0);
  return {ref,rows,ownSum,supportSum,total:ownSum+supportSum,difference:ownSum+supportSum-ref.totalPower};
}
export function teamReferenceHTML(archive,catalog,e){
  const v=compareTeamReference(archive,catalog);if(!v)return '';
  const n=x=>Number(x).toLocaleString('zh-CN');
  return `<section class="panel spaced"><h2>截图配队核对</h2><p>对照档案中保存的队伍参考。等级使用当前档案计算 CLv. + SLv.；战斗力列是截图读数，只用于汇总核对。</p><div class="note"><b>${n(v.ownSum)} + ${n(v.supportSum)} = ${n(v.total)}</b> · 截图总战斗力 ${n(v.ref.totalPower)} · 差值 ${v.difference}</div><div class="table-wrap"><table><thead><tr><th>角色／卡面</th><th>等级计算 → 截图</th><th>突破／转生／开花核对</th><th>截图战斗力</th><th>截图加成</th></tr></thead><tbody>${v.rows.map(r=>`<tr><td>${e(r.character?.name||r.styleId)}<br><small>${e(r.style?.name||'')}</small></td><td>${r.classLevel??'？'} + ${r.styleLevel??'？'} = ${r.combinedLevel??'？'} → ${r.level}<br>${r.checks.level===true?'一致':r.checks.level===false?'与截图不同':'待补录'}</td><td>${Object.entries({limitBreak:'突破',reincarnation:'转生',bloomed:'开花'}).map(([k,label])=>`${label}：${r.checks[k]===true?'一致':r.checks[k]===false?'不同':'待补'}`).join('<br>')}</td><td>${n(r.power)}</td><td>+${n(r.supportPower)}</td></tr>`).join('')}</tbody></table></div>${v.rows.some(r=>!r.teamMatches)?'<p class="note">当前主队或支援已改动；上面的截图数值仍对应原截图。</p>':''}<p><b>核验范围：</b>以上分别检查已录养成和截图数字的加总；这些检查不代表六维属性或伤害公式已通过验证。</p><p class="subtle">下一步需要当前配装的具体装备／孔位、灵魂强化、卡面潜在数值和至少一名角色的详细面板。伤害核验还需要敌方、技能与增益状态。当前截图没有这些输入，无法反推出唯一面板。</p></section>`;
}
