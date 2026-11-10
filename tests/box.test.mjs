import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boxData, breakLabel, tileState, exportLayout, flatTiles, maxBreak, EXPORT } from '../public/box.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('../public/data/catalog.json', import.meta.url), 'utf8'));
const ss = catalog.styles.filter((s) => s.tier === 'SS' || s.tier === 'SSR');

test('box covers every SS/SSR style once, grouped by team then character', () => {
  const data = boxData(catalog, { styles: {} });
  const tiles = data.teams.flatMap((t) => t.characters.flatMap((c) => c.tiles));
  assert.equal(tiles.length, ss.length);
  assert.equal(new Set(tiles.map((t) => t.style.id)).size, ss.length);
  assert.equal(data.summary.total, ss.length);
  assert.equal(data.summary.owned, 0);
  for (const team of data.teams) for (const { character } of team.characters) assert.equal(character.team, team.team);
});

test('break labels are bare digits; unknown is ?; clamped to the style maximum', () => {
  const style = ss[0];
  const max = maxBreak(style);
  assert.equal(max, 4);
  assert.equal(breakLabel(tileState(style, undefined)), '');
  assert.equal(breakLabel(tileState(style, { owned: true })), '?');
  assert.equal(breakLabel(tileState(style, { owned: true, limitBreak: 2 })), '2');
  assert.equal(breakLabel(tileState(style, { owned: true, limitBreak: 4 })), '4');
  assert.ok(tileState(style, { owned: true, limitBreak: 4 }).maxed);
  assert.equal(tileState(style, { owned: true, limitBreak: 9 }).limitBreak, 4);
  assert.equal(tileState(style, { owned: false, limitBreak: 4 }).maxed, false);
});

test('filters change the shown tiles but not the summary', () => {
  const [a, b] = ss;
  const archive = { styles: { [a.id]: { owned: true, limitBreak: 4 }, [b.id]: { owned: true, limitBreak: 1 } } };
  const owned = boxData(catalog, archive, { ownership: 'owned' });
  assert.deepEqual(owned.teams.flatMap((t) => t.characters.flatMap((c) => c.tiles.map((x) => x.style.id))).sort(), [a.id, b.id].sort());
  assert.equal(owned.summary.owned, 2);
  assert.equal(owned.summary.maxed, 1);
  assert.equal(owned.summary.total, ss.length);
  const character = catalog.characters.find((c) => c.id === a.characterId);
  const searched = boxData(catalog, archive, { query: character.name });
  assert.ok(searched.teams.every((t) => t.characters.every((c) => c.character.id === a.characterId)));
  const ssrOnly = boxData(catalog, archive, { tiers: ['SSR'] });
  assert.ok(ssrOnly.teams.every((t) => t.characters.every((c) => c.tiles.every((x) => x.style.tier === 'SSR'))));
});

test('export layout packs tiles densely in order, row by row, inside the canvas', () => {
  const data = boxData(catalog, { styles: {} });
  const tiles = flatTiles(data.teams);
  assert.equal(tiles.length, ss.length);
  for (const perRow of [12, 16, 20, 24]) {
    const layout = exportLayout(tiles, { perRow });
    assert.equal(layout.items.length, tiles.length);
    layout.items.forEach((item, i) => {
      assert.equal(item.tile, tiles[i]);
      assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.w <= layout.width && item.y + item.h <= layout.height);
      if (i % perRow) {
        const prev = layout.items[i - 1];
        assert.equal(item.y, prev.y);
        assert.equal(item.x - (prev.x + prev.w), EXPORT.gap);
      }
    });
    assert.equal(new Set(layout.items.map((x) => x.y)).size, Math.ceil(tiles.length / perRow));
  }
  const few = exportLayout(tiles.slice(0, 3), { perRow: 16 });
  assert.equal(few.width, EXPORT.pad * 2 + 3 * EXPORT.tile + 2 * EXPORT.gap);
  assert.equal(exportLayout([], {}).items.length, 0);
});
