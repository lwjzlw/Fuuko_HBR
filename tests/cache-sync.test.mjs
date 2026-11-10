import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCacheChanges, defaultAccepted, renderPreview, syncCacheArchive } from '../public/cache-sync.mjs';

test('direct sync snapshots before committing, applies decreases and skips incomplete inventory', async () => {
  let archive = emptyArchive(); archive.styles.S = { owned: true, limitBreak: 4 };
  const events = [];
  const changes = [
    { id: 'up', kind: 'style', target: 'S', field: 'cardLevel', to: 20, direction: 'new' },
    { id: 'down', kind: 'style', target: 'S', field: 'limitBreak', to: 3, direction: 'down' },
    { id: 'inventory', kind: 'archive', field: 'gameInventory', value: { total: 0 }, direction: 'up' },
  ];
  const result = await syncCacheArchive({ getArchive: () => archive, getPreview: async () => ({ changes, optional_missing: ['spheres'], unmapped: { equipment: 1 } }),
    snapshot: async value => { events.push('snapshot'); assert.equal(value.styles.S.cardLevel, undefined); },
    validate: value => { events.push('validate'); validateArchive(value); }, commit: value => { events.push('commit'); archive = value; } });
  assert.deepEqual(events, ['validate', 'snapshot', 'commit']);
  assert.deepEqual(result.applied, ['up', 'down']); assert.deepEqual(result.skipped, ['inventory']);
  assert.equal(archive.styles.S.cardLevel, 20); assert.equal(archive.styles.S.limitBreak, 3);
  assert.ok(result.warnings.some(x => x.includes('装备')));
});

test('direct sync cancels on snapshot failure or concurrent edits', async () => {
  for (const where of ['failure', 'preview', 'snapshot']) {
    let archive = emptyArchive(), committed = false;
    await assert.rejects(syncCacheArchive({ getArchive: () => archive,
      getPreview: async () => { if (where === 'preview') archive.characters.C = { level: 1 }; return { changes: [{ id: 'x', kind: 'style', target: 'S', field: 'owned', to: true, direction: 'new' }] }; },
      validate: () => {}, snapshot: async () => { if (where === 'failure') throw Error('snapshot failed'); if (where === 'snapshot') archive.characters.C = { level: 1 }; },
      commit: () => { committed = true; } }), /snapshot failed|档案已变动/);
    assert.equal(committed, false);
  }
});

test('direct sync with only incomplete inventory does not save a snapshot or commit', async () => {
  const archive = emptyArchive(); let touched = false;
  const result = await syncCacheArchive({ getArchive: () => archive, getPreview: async () => ({ changes: [{ id: 'i', field: 'gameInventory', direction: 'up' }], optional_missing: ['accessories'] }),
    validate: () => { touched = true; }, snapshot: () => { touched = true; }, commit: () => { touched = true; } });
  assert.equal(touched, false); assert.deepEqual(result.skipped, ['i']);
});

import { emptyArchive, validateArchive, mergeArchive } from '../public/storage-v2.mjs';

test('character latent level sync uses recorded value and merge keeps higher', () => {
  const a = emptyArchive(); a.characters.C = { latentLevel: 3, rank: 9 };
  const change = { id: 'characters.C.latentLevel', kind: 'character', target: 'C', field: 'latentLevel', from: 3, to: 4, direction: 'up' };
  const out = applyCacheChanges(a, [change], [change.id]).archive;
  assert.deepEqual(out.characters.C, { latentLevel: 4, rank: 9 });
  validateArchive(out);
  assert.equal(mergeArchive(a, out).characters.C.latentLevel, 4);
  assert.equal(mergeArchive(out, a).characters.C.latentLevel, 4);
  for(const v of [-1, 1.5, '4']) {
    const bad = structuredClone(out); bad.characters.C.latentLevel = v;
    assert.throws(() => validateArchive(bad), /latentLevel/);
  }
});

const panelChange = (key, from, to, direction) => ({ id: `styles.S.latentPanels.${key}`, kind: 'style', target: 'S', field: 'latentPanels', key, label: 'S', from, to, direction });

test('panel sync is per axis, preserves stats and skips decreases by default', () => {
  const input = emptyArchive();
  input.styles.S = { owned: true, latentPanels: { str: 15, dex: 9, wis: 5 }, latentStats: { wis: 123 } };
  const list = [panelChange('wis', 5, 7, 'up'), panelChange('dex', 9, 8, 'down'), panelChange('con', null, 0, 'new')];
  const { archive: out } = applyCacheChanges(input, list, list.filter(defaultAccepted).map(c => c.id));
  assert.deepEqual(out.styles.S.latentPanels, { str: 15, dex: 9, wis: 7, con: 0 });
  assert.deepEqual(out.styles.S.latentStats, { wis: 123 });
  assert.equal(input.styles.S.latentPanels.wis, 5);
  validateArchive(out);
  const all = applyCacheChanges(input, list, list.map(c => c.id)).archive;
  assert.equal(all.styles.S.latentPanels.dex, 8);
  const roundtrip = JSON.parse(JSON.stringify(out));
  validateArchive(roundtrip);
  const higher = structuredClone(out); higher.styles.S.latentPanels.wis = 10; higher.styles.S.latentPanels.dex = 2;
  const merged = mergeArchive(roundtrip, higher);
  assert.equal(merged.styles.S.latentPanels.wis, 10);
  assert.equal(merged.styles.S.latentPanels.dex, 9);
});

test('invalid panel keys and counts rejected by application and archive validation', () => {
  for (const [key, value] of [['dp', 1], ['__proto__', 1], ['wis', -1], ['wis', 1.5], ['wis', 1000000]]) {
    const c = panelChange(key, null, value, 'new');
    assert.throws(() => applyCacheChanges(emptyArchive(), [c], [c.id]), /潜在面板/);
    const a = emptyArchive(); a.styles.S = { owned: true, latentPanels: { [key]: value } };
    assert.throws(() => validateArchive(a), /潜在面板/);
  }
});

test('panel preview distinguishes axes, zero, unknown and preserves decrease checkbox', () => {
  const list = [panelChange('wis', 5, 7, 'up'), panelChange('con', null, 0, 'new'), panelChange('dex', 9, 8, 'down')];
  const html = renderPreview({ counts: { new: 1, up: 1, down: 1 }, changes: list }, String);
  assert.ok(html.includes('潜在面板节点 · 智慧'));
  assert.ok(html.includes('空 → <b>0</b>'));
  assert.match(html, /value="styles\.S\.latentPanels\.dex"\s*>/);
  assert.ok(html.includes('不覆盖手填的属性加成'));
});

const changes = [
  { id: 'styles.A.owned', kind: 'style', target: 'A', field: 'owned', label: 'A', from: false, to: true, direction: 'new' },
  { id: 'styles.B.limitBreak', kind: 'style', target: 'B', field: 'limitBreak', label: 'B', from: 4, to: 3, direction: 'down' },
  { id: 'characters.C.level', kind: 'character', target: 'C', field: 'level', label: 'C', from: 150, to: 160, direction: 'up' },
];

test('down changes are not accepted by default', () => {
  assert.deepEqual(changes.map(defaultAccepted), [true, false, true]);
});

test('apply only accepted fields and keep others', () => {
  const archive = { schemaVersion: 2, styles: { B: { owned: true, limitBreak: 4, bloomed: true } }, characters: { C: { level: 150, rank: 13 } } };
  const { archive: out, applied, skipped } = applyCacheChanges(archive, changes, ['styles.A.owned', 'characters.C.level'], { read_at: 'x' });
  assert.equal(out.styles.A.owned, true);
  assert.equal(out.styles.B.limitBreak, 4);
  assert.equal(out.styles.B.bloomed, true);
  assert.deepEqual(out.characters.C, { level: 160, rank: 13 });
  assert.deepEqual(applied, ['styles.A.owned', 'characters.C.level']);
  assert.deepEqual(skipped, ['styles.B.limitBreak']);
  assert.equal(out.importHistory.at(-1).source, 'game-cache');
  assert.deepEqual(out.importHistory.at(-1).conflicts, ['styles.B.limitBreak']);
  assert.equal(archive.styles.A, undefined, 'input archive untouched');
});

test('preview escapes labels and leaves down unchecked', () => {
  const esc = s => String(s).replace(/</g, '&lt;');
  const html = renderPreview({ counts: { new: 1, up: 1, down: 1 }, changes: [{ ...changes[0], label: '<x>' }, changes[1], changes[2]],
    cards_in_cache: 3, characters_in_cache: 1, source: {}, unmapped: { cards: [1] } }, esc);
  assert.ok(html.includes('&lt;x>'));
  assert.match(html, /value="styles\.B\.limitBreak"\s*>/);
  assert.match(html, /value="styles\.A\.owned" checked/);
  assert.ok(html.includes('1 张卡面不在当前目录中'));
});

test('style side fields, owned default and archive snapshot', () => {
  const list = [
    { id: 'styles.S.soulBookLevel', kind: 'style', target: 'S', field: 'soulBookLevel', label: 'S', from: null, to: 5, direction: 'new', also: { soulBookLevelMode: 'recorded' } },
    { id: 'characters.C.availableLatentIds', kind: 'character', target: 'C', field: 'availableLatentIds', label: 'C', from: null, to: ['a', 'b'], direction: 'new', also: { latentPoolMode: 'selected' } },
    { id: 'archive.gameInventory', kind: 'archive', target: 'archive', field: 'gameInventory', label: 'inv', from: null, to: 3, value: { total: 3, entries: { x: { count: 3 } } }, direction: 'new' },
  ];
  const { archive: out } = applyCacheChanges({ schemaVersion: 2, styles: {}, characters: { C: { level: 1 } } }, list, list.map(c => c.id));
  assert.deepEqual(out.styles.S, { owned: false, soulBookLevel: 5, soulBookLevelMode: 'recorded' });
  assert.deepEqual(out.characters.C, { level: 1, availableLatentIds: ['a', 'b'], latentPoolMode: 'selected' });
  assert.equal(out.gameInventory.entries.x.count, 3);
  list[2].value.entries.x.count = 9;
  assert.equal(out.gameInventory.entries.x.count, 3, 'snapshot is copied');
});

test('large groups are split by field', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ id: 'styles.S' + i + '.soulBookLevel', kind: 'style', target: 'S' + i, field: 'soulBookLevel', label: 'S' + i, from: null, to: 5, direction: 'new' }));
  const html = renderPreview({ counts: { new: 15, up: 0, down: 0 }, changes: many, cards_in_cache: 0, characters_in_cache: 0 }, String);
  assert.match(html, /sync-field-group/);
  assert.ok(html.includes('灵魂书强化'));
});

test('skill levels and training merge per key, keep other keys and validate', () => {
  const a = emptyArchive();
  a.styles.S = { owned: true, skillLevels: { Keep: 3, Sk: 9 }, training: { Other: ['x'] } };
  const list = [
    { id: 'styles.S.skillLevels.Sk', kind: 'style', target: 'S', field: 'skillLevels', key: 'Sk', keyLabel: '技能甲', label: 'S', from: 9, to: 7, direction: 'down' },
    { id: 'styles.S.training.G', kind: 'style', target: 'S', field: 'training', key: 'G', keyLabel: '能力強化I', label: 'S', from: null, to: ['n1', 'n2'], direction: 'new' },
    { id: 'styles.T.skillLevels.Sk', kind: 'style', target: 'T', field: 'skillLevels', key: 'Sk', label: 'T', from: null, to: 4, direction: 'new' },
  ];
  const out = applyCacheChanges(a, list, list.map(c => c.id)).archive;
  assert.deepEqual(out.styles.S.skillLevels, { Keep: 3, Sk: 7 });
  assert.deepEqual(out.styles.S.training, { Other: ['x'], G: ['n1', 'n2'] });
  assert.deepEqual(out.styles.T, { owned: false, skillLevels: { Sk: 4 } });
  assert.equal(a.styles.S.skillLevels.Sk, 9);
  validateArchive(JSON.parse(JSON.stringify(out)));
  const html = renderPreview({ counts: { new: 2, down: 1 }, changes: list }, String);
  assert.ok(html.includes('技能等级 · 技能甲') && html.includes('能力树节点 · 能力強化I'));
  for (const bad of [{ field: 'skillLevels', key: 'Sk', to: 0 }, { field: 'skillLevels', key: 'Sk', to: 2.5 },
    { field: 'skillLevels', key: '__proto__', to: 3 }, { field: 'training', key: 'G', to: ['a', 'a'] }, { field: 'training', key: 'G', to: [1] }]) {
    const c = { id: 'b', kind: 'style', target: 'S', direction: 'new', ...bad };
    assert.throws(() => applyCacheChanges(emptyArchive(), [c], ['b']), /技能等级|能力树节点/);
  }
});
