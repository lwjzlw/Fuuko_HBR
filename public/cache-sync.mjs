// 从游戏本机缓存同步：服务端只读缓存并计算差异，直接按游戏已识别值应用。
// 下方预览辅助函数保留供旧测试使用，不参与当前直接同步流程。

export const FIELD_LABELS = {
  owned: '拥有', limitBreak: '突破', bloomed: '开花', cardLevel: '卡面等级',
  soulBook: '灵魂书持有', soulBookLevel: '灵魂书强化',
  level: '角色等级', reincarnation: '转生', latentLevel: '潜在力等级', masterSkillUnlocked: '精通技能',
  availableLatentIds: '潜在词条池', latentPanels: '潜在面板节点', skillLevels: '技能等级', training: '能力树节点',
  gameInventory: '持有装备快照',
};
export const PANEL_LABELS = { str: '力量', dex: '灵巧', con: '体力', spr: '精神', wis: '智慧', luk: '幸运' };
const NESTED = new Set(['latentPanels', 'skillLevels', 'training']);
const fieldLabel = c => (FIELD_LABELS[c.field] || c.field) + (NESTED.has(c.field) ? ' · ' + (c.field === 'latentPanels' ? PANEL_LABELS[c.key] || c.key : c.keyLabel || c.key) : '');
const FIELD_ORDER = Object.keys(FIELD_LABELS);
const GROUPS = [
  ['new', '新增', '档案里还没有的记录或空值'],
  ['up', '提升', '游戏里比档案高'],
  ['down', '下降 / 不一致', '游戏里比档案低；默认不改，确认无误再勾选'],
];

const show = v => v === true ? '是' : v === false ? '否' : v == null ? '空' : Array.isArray(v) ? `${v.length} 项` : String(v);
const showChange = (c, side) => c.field === 'gameInventory' ? (c[side] == null ? '空' : `${c[side]} 件`) : show(c[side]);

export function defaultAccepted(change) {
  return change.direction !== 'down';
}

// 以游戏缓存中已识别的值为准（包括下降）；装备表不完整时不替换现有快照。
export async function syncCacheArchive({ getArchive, getPreview, snapshot, validate, commit }) {
  const original = structuredClone(getArchive());
  const fingerprint = JSON.stringify(original);
  const checkUnchanged = () => {
    if (JSON.stringify(getArchive()) !== fingerprint) throw Error('读取期间档案已变动，请重新同步');
  };
  const preview = await getPreview(original);
  checkUnchanged();
  const missing = preview.optional_missing || [];
  const inventoryIncomplete = ['accessories', 'boosters', 'spheres'].some(x => missing.includes(x));
  const ids = preview.changes.filter(c => !(inventoryIncomplete && c.field === 'gameInventory')).map(c => c.id);
  const warnings = [];
  if (inventoryIncomplete) warnings.push('装备表不完整，未替换装备快照');
  if (preview.unmapped?.equipment) warnings.push(`${preview.unmapped.equipment} 件装备未映射，不在装备快照中`);
  if (preview.unmapped?.cards?.length) warnings.push(`${preview.unmapped.cards.length} 张卡面未映射`);
  if (preview.unmapped?.characters?.length) warnings.push(`${preview.unmapped.characters.length} 名角色未映射`);
  if (missing.length) warnings.push(`缺少可选缓存表：${missing.join('、')}`);
  if (!ids.length) return { applied: [], skipped: preview.changes.map(c => c.id), warnings };
  const result = applyCacheChanges(original, preview.changes, ids, preview.source);
  validate(result.archive);
  await snapshot(original);
  checkUnchanged();
  commit(result.archive);
  return { ...result, warnings };
}

export function applyCacheChanges(archive, changes, acceptedIds, meta = {}) {
  const accepted = new Set(acceptedIds);
  const out = structuredClone(archive);
  out.styles ??= {}; out.characters ??= {}; out.importHistory ??= [];
  const applied = [], skipped = [];
  for (const c of changes) {
    if (!accepted.has(c.id)) { skipped.push(c.id); continue; }
    if (c.kind === 'archive') {
      out[c.field] = structuredClone(c.value);
    } else {
      const bucket = c.kind === 'style' ? out.styles : out.characters;
      const base = c.kind === 'style' ? { owned: false } : {};
      if (c.field === 'latentPanels') {
        if (c.kind !== 'style' || !Object.hasOwn(PANEL_LABELS, c.key) || !Number.isInteger(c.to) || c.to < 0 || c.to > 999999) throw Error('潜在面板节点无效');
        bucket[c.target] = { ...base, ...(bucket[c.target] || {}), latentPanels: { ...(bucket[c.target]?.latentPanels || {}), [c.key]: c.to } };
      } else if (c.field === 'skillLevels' || c.field === 'training') {
        const okKey = c.kind === 'style' && typeof c.key === 'string' && c.key && !['__proto__', 'constructor', 'prototype'].includes(c.key);
        const okValue = c.field === 'skillLevels'
          ? Number.isInteger(c.to) && c.to >= 1 && c.to <= 99
          : Array.isArray(c.to) && c.to.every(x => typeof x === 'string') && new Set(c.to).size === c.to.length;
        if (!okKey || !okValue) throw Error(c.field === 'skillLevels' ? '技能等级无效' : '能力树节点无效');
        bucket[c.target] = { ...base, ...(bucket[c.target] || {}), [c.field]: { ...(bucket[c.target]?.[c.field] || {}), [c.key]: structuredClone(c.to) } };
      } else {
        bucket[c.target] = { ...base, ...(bucket[c.target] || {}), [c.field]: structuredClone(c.to), ...(c.also || {}) };
      }
    }
    applied.push(c.id);
  }
  out.importHistory.push({
    at: new Date().toISOString(), source: 'game-cache', cacheReadAt: meta.read_at || null,
    applied, conflicts: skipped,
  });
  return { archive: out, applied, skipped };
}

function row(c, esc) {
  return `
    <label class="sync-row">
      <input type="checkbox" name="accept" value="${esc(c.id)}" ${defaultAccepted(c) ? 'checked' : ''}>
      <span class="sync-name">${esc(c.label)}</span>
      <span class="sync-field">${esc(fieldLabel(c))}${c.unverified ? '<em title="缓存字段与游戏内显示的对应尚未目视核对">待核对</em>' : ''}</span>
      <span class="sync-value">${esc(showChange(c, 'from'))} → <b>${esc(showChange(c, 'to'))}</b></span>
    </label>`;
}

export function groupByField(list) {
  const map = new Map();
  for (const c of list) { if (!map.has(c.field)) map.set(c.field, []); map.get(c.field).push(c); }
  return [...map.entries()].sort((a, b) => FIELD_ORDER.indexOf(a[0]) - FIELD_ORDER.indexOf(b[0]));
}

export function renderPreview(preview, esc) {
  const { counts, changes, source = {}, unmapped = {} } = preview;
  const groups = GROUPS.filter(([dir]) => counts[dir]).map(([dir, title, hint]) => {
    const fields = groupByField(changes.filter(c => c.direction === dir));
    const body = fields.length > 1 || fields[0]?.[1].length > 12
      ? fields.map(([field, list]) => `<details class="sync-field-group" ${list.length <= 12 ? 'open' : ''}><summary>${esc(FIELD_LABELS[field] || field)} <span class="count">${list.length}</span></summary>${list.map(c => row(c, esc)).join('')}</details>`).join('')
      : fields.flatMap(([, list]) => list).map(c => row(c, esc)).join('');
    return `
    <details class="sync-group" data-dir="${dir}" ${dir !== 'down' ? 'open' : ''}>
      <summary><b>${title}</b> <span class="count">${counts[dir]}</span> <small>${hint}</small></summary>
      ${body}
    </details>`;
  }).join('');
  const table = source.tables || {};
  const extra = [];
  if (unmapped.cards?.length) extra.push(`${unmapped.cards.length} 张卡面不在当前目录中（目录需要刷新），已跳过`);
  if (unmapped.characters?.length) extra.push(`${unmapped.characters.length} 名角色不在当前目录中，已跳过`);
  if (unmapped.equipment) extra.push(`${unmapped.equipment} 件装备不在当前装备目录中，未计入快照`);
  return `
    <p>已只读游戏缓存：卡面 ${preview.cards_in_cache} 张、角色 ${preview.characters_in_cache} 名。
       卡面表更新于 ${esc(table.cards?.modified || '未知')}，角色表更新于 ${esc(table.characters?.modified || '未知')}。</p>
    <p class="subtle">缓存是游戏上次同步时的状态；刚在游戏里养成的话，先在游戏里打开一次相关页面再同步。
       缓存里没出现的卡面不会被改成未拥有；潜在面板按六项已取得节点数同步，不覆盖手填的属性加成。角色潜在力等级直接同步游戏显示值；能力树全部取得的分区同步节点，技能等级按能力树节点＋战斗/道具升级推算；Rank 暂不导入。持有装备快照会整体替换上一次的快照。${extra.length ? '<br>' + esc(extra.join('；')) + '。' : ''}</p>
    ${changes.length ? `<div class="sync-tools"><button type="button" data-sync="all">全选</button><button type="button" data-sync="safe">只选新增与提升</button><button type="button" data-sync="none">全不选</button></div>${groups}`
                     : '<p><b>档案与游戏一致，没有需要更新的字段。</b></p>'}`;
}

export function bindPreviewTools(root, changes) {
  root.querySelectorAll('[data-sync]').forEach(btn => btn.onclick = () => {
    const mode = btn.dataset.sync;
    const dir = Object.fromEntries(changes.map(c => [c.id, c.direction]));
    root.querySelectorAll('input[name="accept"]').forEach(box => {
      box.checked = mode === 'all' || (mode === 'safe' && dir[box.value] !== 'down');
    });
  });
}
