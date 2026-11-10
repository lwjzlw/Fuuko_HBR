// Box：按部队 → 角色整理 SS/SSR 卡面的拥有与突破，并计算导出图片的排版。纯函数，不碰 DOM。
export const BOX_TIERS = ['SS', 'SSR'];

const normalize = (x) => String(x ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s/g, '');

export function maxBreak(style) {
  const steps = style.limitBreakSteps || [];
  return steps.length ? steps[steps.length - 1].step : 0;
}

// 单张卡在 box 里的状态：limitBreak 为 null 表示已拥有但突破未知
export function tileState(style, progress) {
  const owned = Boolean(progress?.owned);
  const max = maxBreak(style);
  const limitBreak = owned && Number.isInteger(progress?.limitBreak) ? Math.min(progress.limitBreak, max) : null;
  return { style, owned, limitBreak, max, maxed: owned && limitBreak === max };
}

// 角标只写数字（0–4），满突靠金色区分；突破未知写“?”
export function breakLabel(tile) {
  if (!tile.owned) return '';
  if (tile.limitBreak == null) return '?';
  return String(tile.limitBreak);
}

function countTier(tiles, tier) {
  const list = tiles.filter((t) => t.style.tier === tier);
  return { tier, total: list.length, owned: list.filter((t) => t.owned).length, maxed: list.filter((t) => t.maxed).length };
}

/**
 * 整理 box 数据。
 * options.tiers：参与的稀有度；ownership：all | owned | unowned；team：只看某部队；query：按角色/卡面名搜索。
 * 统计（summary）只受稀有度影响，不受搜索和拥有筛选影响，导出图上的数字因此始终是整个 box 的。
 */
export function boxData(catalog, archive, { tiers = BOX_TIERS, ownership = 'all', team = '', query = '' } = {}) {
  const progress = archive?.styles || {};
  const tierSet = new Set(tiers);
  const stylesByCharacter = new Map();
  const allTiles = [];
  for (const style of catalog.styles) {
    if (!tierSet.has(style.tier)) continue;
    const tile = tileState(style, progress[style.id]);
    allTiles.push(tile);
    if (!stylesByCharacter.has(style.characterId)) stylesByCharacter.set(style.characterId, []);
    stylesByCharacter.get(style.characterId).push(tile);
  }
  const q = normalize(query);
  const teams = [];
  const teamIndex = new Map();
  for (const character of catalog.characters) {
    const tiles = (stylesByCharacter.get(character.id) || [])
      .slice().sort((a, b) => String(a.style.releaseDate).localeCompare(String(b.style.releaseDate)));
    if (!tiles.length) continue;
    if (!teamIndex.has(character.team)) {
      teamIndex.set(character.team, teams.length);
      teams.push({ team: character.team, characters: [], owned: 0, total: 0 });
    }
    const block = teams[teamIndex.get(character.team)];
    block.total += tiles.length;
    block.owned += tiles.filter((t) => t.owned).length;
    if (team && character.team !== team) continue;
    const characterText = normalize([character.name, character.nameJa, ...(character.aliases || [])].join(' '));
    const shown = tiles.filter((t) => (ownership === 'all' || (ownership === 'owned') === t.owned)
      && (!q || characterText.includes(q) || normalize(`${t.style.name} ${t.style.nameJa || ''}`).includes(q)));
    if (shown.length) block.characters.push({ character, tiles: shown });
  }
  const summary = {
    total: allTiles.length,
    owned: allTiles.filter((t) => t.owned).length,
    maxed: allTiles.filter((t) => t.maxed).length,
    tiers: [...tierSet].map((tier) => countTier(allTiles, tier)),
  };
  return { teams: teams.filter((t) => t.characters.length), allTeams: teams.map((t) => t.team), summary };
}

// ---------------------------------------------------------------- 导出图片的排版
// 不分部队、不写角色名：所有卡面按部队 → 角色 → 实装顺序依次密排，每行 perRow 张。
export const EXPORT = { pad: 28, head: 74, foot: 34, tile: 64, gap: 4, perRow: 16 };

export function flatTiles(teams) {
  return teams.flatMap((block) => block.characters.flatMap((c) => c.tiles));
}

export function exportLayout(tiles, { perRow = EXPORT.perRow, layout = EXPORT } = {}) {
  const L = layout;
  const cols = Math.max(1, Math.min(perRow, tiles.length || 1));
  const rows = Math.ceil(tiles.length / cols);
  const step = L.tile + L.gap;
  const items = tiles.map((tile, i) => ({
    kind: 'tile', x: L.pad + (i % cols) * step, y: L.pad + L.head + Math.floor(i / cols) * step, w: L.tile, h: L.tile, tile,
  }));
  return {
    width: L.pad * 2 + cols * step - L.gap,
    height: L.pad * 2 + L.head + Math.max(0, rows * step - L.gap) + L.foot,
    items,
  };
}
