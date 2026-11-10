// Box 页：按部队 → 角色显示 SS/SSR 卡面和突破数；点卡面改养成，点角色改共通；导出为图片分享到社区。
import { boxData, breakLabel, exportLayout, flatTiles, EXPORT, BOX_TIERS } from './box.mjs';

const TIER_OPTIONS = [['SS,SSR', 'SS · SSR'], ['SS', 'SS'], ['SSR', 'SSR'], ['S', 'S'], ['A', 'A']];
const OWNERSHIP_OPTIONS = [['all', '全部'], ['owned', '已拥有'], ['unowned', '未拥有']];
const STATE_KEY = 'hbr-box-view';
const EXPORT_KEY = 'hbr-box-export';

function loadJSON(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...fallback }; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 无痕模式 */ }
}

export function createBoxUI({ catalog, getArchive, e, editStyle, editCharacter, notice }) {
  let state = loadJSON(STATE_KEY, { tiers: 'SS,SSR', ownership: 'all', team: '', query: '' });
  let host = null;
  const tiersOf = (value) => value.split(',');

  const tileHTML = (t) => {
    const label = breakLabel(t);
    const title = `${t.style.name}（${t.style.tier}）${t.owned ? ` · ${t.limitBreak == null ? '突破未知' : t.maxed ? `满突（${t.limitBreak}）` : `${t.limitBreak} 突`}` : ' · 未拥有'}`;
    return `<button type="button" class="box-tile tier-${e(t.style.tier)}${t.owned ? ' owned' : ''}${t.maxed ? ' maxed' : ''}"
      data-style="${e(t.style.id)}" title="${e(title)}" aria-label="${e(title)}">
      <img src="${e(t.style.portrait?.path || '/image-placeholder.svg')}" alt="" loading="lazy" decoding="async">
      ${t.style.tier === 'SSR' ? '<span class="box-tier">SSR</span>' : ''}
      ${label ? `<span class="box-lb">${e(label)}</span>` : ''}</button>`;
  };

  function summaryHTML(summary) {
    const tiers = summary.tiers.map((t) => `<div class="box-stat"><strong>${t.owned}<small> / ${t.total}</small></strong><span>${e(t.tier)} 已拥有</span></div>`).join('');
    return `${tiers}<div class="box-stat"><strong>${summary.maxed}</strong><span>满突</span></div>`;
  }

  function segmented(name, options, value) {
    return `<div class="box-seg" role="group" aria-label="${e(name)}">${options.map(([v, label]) =>
      `<button type="button" data-${e(name)}="${e(v)}" aria-pressed="${v === value}">${e(label)}</button>`).join('')}</div>`;
  }

  function render() {
    if (!host) return;
    const data = boxData(catalog, getArchive(), { tiers: tiersOf(state.tiers), ownership: state.ownership, team: state.team, query: state.query });
    const teamOptions = [['', '全部部队'], ...data.allTeams.map((t) => [t, t])];
    const body = data.teams.length ? data.teams.map((block) => `<section class="box-team" aria-label="${e(block.team)}">
        <header><h2>${e(block.team)}</h2><span>${block.owned} / ${block.total}</span></header>
        ${block.characters.map(({ character, tiles }) => `<div class="box-row">
          <button type="button" class="box-who" data-character="${e(character.id)}" title="编辑 ${e(character.name)} 的角色共通养成">
            <img src="${e(character.portrait?.path || '/image-placeholder.svg')}" alt="" loading="lazy"><span>${e(character.name)}</span></button>
          <div class="box-tiles">${tiles.map(tileHTML).join('')}</div></div>`).join('')}
      </section>`).join('')
      : `<div class="box-empty"><p>没有符合筛选的卡面。</p><button type="button" class="quiet" data-reset>清除筛选</button></div>`;
    host.innerHTML = `<div class="box-head">
        <div class="box-stats">${summaryHTML(data.summary)}</div>
        <div class="box-actions">
          <button type="button" class="primary" data-export>导出 box 图</button>
        </div>
      </div>
      <div class="box-tools">
        <label class="box-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="搜索角色或卡面" value="${e(state.query)}" aria-label="搜索角色或卡面"></label>
        <select aria-label="部队" data-team-select>${teamOptions.map(([v, t]) => `<option value="${e(v)}" ${v === state.team ? 'selected' : ''}>${e(t)}</option>`).join('')}</select>
        ${segmented('tiers', TIER_OPTIONS, state.tiers)}
        ${segmented('ownership', OWNERSHIP_OPTIONS, state.ownership)}
      </div>
      <p class="box-hint">点卡面修改突破、开花等养成；点角色名修改等级、转生等共通养成。角标数字是突破数，金色是满突，灰色是还没有的卡。</p>
      <div class="box-grid">${body}</div>`;
    bind();
  }

  function setState(patch) {
    state = { ...state, ...patch };
    saveJSON(STATE_KEY, { ...state, query: '' });
    render();
  }

  function bind() {
    const search = host.querySelector('.box-search input');
    search.oninput = () => {
      state.query = search.value;
      const position = search.selectionStart;
      render();
      const again = host.querySelector('.box-search input');
      again.focus();
      again.setSelectionRange(position, position);
    };
    search.onkeydown = (ev) => { if (ev.key === 'Escape' && search.value) { ev.preventDefault(); setState({ query: '' }); host.querySelector('.box-search input').focus(); } };
    host.querySelector('[data-team-select]').onchange = (ev) => setState({ team: ev.target.value });
    host.querySelectorAll('[data-tiers]').forEach((b) => { b.onclick = () => setState({ tiers: b.dataset.tiers }); });
    host.querySelectorAll('[data-ownership]').forEach((b) => { b.onclick = () => setState({ ownership: b.dataset.ownership }); });
    host.querySelectorAll('[data-style]').forEach((b) => { b.onclick = () => editStyle(b.dataset.style); });
    host.querySelectorAll('[data-character]').forEach((b) => { b.onclick = () => editCharacter(b.dataset.character); });
    host.querySelector('[data-export]').onclick = () => openExport();
    host.querySelector('[data-reset]')?.addEventListener('click', () => setState({ tiers: 'SS,SSR', ownership: 'all', team: '', query: '' }));
  }

  // ---------------------------------------------------------------- 导出图片
  const PALETTES = {
    light: { bg: '#f5f3ee', block: '#fffefb', line: '#e6e2d9', text: '#26303a', sub: '#7b858c', accent: '#c4553f',
      badge: 'rgba(28,34,40,.78)', badgeText: '#fff', gold: '#d4a23c', goldText: '#3a2a05', empty: '#e9e6df' },
    dark: { bg: '#15181c', block: '#1f2328', line: '#2f353c', text: '#e8ebed', sub: '#98a3aa', accent: '#e07a5f',
      badge: 'rgba(0,0,0,.72)', badgeText: '#fff', gold: '#e7b54a', goldText: '#2b1f04', empty: '#2a2f35' },
  };
  const FONT = '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';

  const imageCache = new Map();
  function loadImage(src) {
    if (!src) return Promise.resolve(null);
    if (!imageCache.has(src)) {
      imageCache.set(src, new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      }));
    }
    return imageCache.get(src);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  async function drawBox(options) {
    const tiers = options.tiers === 'SS' || options.tiers === 'SSR' ? [options.tiers] : BOX_TIERS;
    const data = boxData(catalog, getArchive(), { tiers, ownership: options.unowned === 'hide' ? 'owned' : 'all' });
    const layout = exportLayout(flatTiles(data.teams), { perRow: Number(options.perRow) || EXPORT.perRow });
    const P = PALETTES[options.theme] || PALETTES.light;
    const L = EXPORT;
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, layout.width, layout.height);
    ctx.textBaseline = 'top';

    // 标题一行，统计一行；图例靠右
    ctx.fillStyle = P.accent;
    roundRect(ctx, L.pad, L.pad + 4, 5, 28, 2.5); ctx.fill();
    ctx.fillStyle = P.text;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(options.title || 'HBR Box', L.pad + 15, L.pad);
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const stats = data.summary.tiers.map((t) => `${t.tier} ${t.owned}/${t.total}`).join('  ·  ');
    ctx.font = `400 14px ${FONT}`;
    ctx.fillStyle = P.sub;
    ctx.fillText(`${date}  ·  ${stats}  ·  满突 ${data.summary.maxed}`, L.pad + 15, L.pad + 38);
    ctx.textAlign = 'right';
    ctx.font = `400 13px ${FONT}`;
    let lx = layout.width - L.pad;
    const legendY = L.pad + 39;
    const legend = (text, color) => {
      ctx.fillStyle = P.sub; ctx.fillText(text, lx, legendY);
      lx -= ctx.measureText(text).width + 6;
      ctx.fillStyle = color; roundRect(ctx, lx - 14, legendY + 1, 14, 14, 3); ctx.fill();
      lx -= 26;
    };
    if (options.unowned !== 'hide') legend('未拥有', P.empty);
    legend('满突', P.gold);
    ctx.textAlign = 'left';

    const images = await Promise.all(layout.items.map((it) => loadImage(it.tile.style.portrait?.path)));
    layout.items.forEach((it, index) => {
      const t = it.tile;
      const img = images[index];
      ctx.save();
      roundRect(ctx, it.x, it.y, it.w, it.h, 9);
      ctx.fillStyle = P.empty; ctx.fill();
      ctx.clip();
      if (img) {
        if (!t.owned) { ctx.filter = 'grayscale(1)'; ctx.globalAlpha = 0.28; }
        ctx.drawImage(img, it.x, it.y, it.w, it.h);
        ctx.filter = 'none'; ctx.globalAlpha = 1;
      }
      ctx.restore();
      if (t.maxed) {
        ctx.strokeStyle = P.gold; ctx.lineWidth = 3;
        roundRect(ctx, it.x + 1.5, it.y + 1.5, it.w - 3, it.h - 3, 8); ctx.stroke();
      }
      if (t.style.tier === 'SSR') {
        ctx.font = `800 9px ${FONT}`;
        const tw = ctx.measureText('SSR').width + 6;
        ctx.fillStyle = t.owned ? 'rgba(20,24,30,.62)' : 'rgba(20,24,30,.25)';
        roundRect(ctx, it.x + 3, it.y + 3, tw, 13, 3); ctx.fill();
        ctx.fillStyle = t.owned ? '#ffe7a3' : 'rgba(255,255,255,.7)';
        ctx.fillText('SSR', it.x + 6, it.y + 5);
      }
      const label = breakLabel(t);
      if (label) {
        ctx.font = `800 13px ${FONT}`;
        const size = 18;
        const bx = it.x + it.w - size - 3;
        const by = it.y + it.h - size - 3;
        ctx.fillStyle = t.maxed ? P.gold : P.badge;
        roundRect(ctx, bx, by, size, size, 5); ctx.fill();
        ctx.fillStyle = t.maxed ? P.goldText : P.badgeText;
        ctx.textAlign = 'center';
        ctx.fillText(label, bx + size / 2, by + 2);
        ctx.textAlign = 'left';
      }
    });

    ctx.fillStyle = P.sub;
    ctx.font = `400 11px ${FONT}`;
    ctx.fillText('由 HBR 研究室生成 · 卡面资料 hbr.quest · 图像版权归原权利方', L.pad, layout.height - L.pad / 2 - 16);
    return { canvas, data };
  }

  function exportFileName() {
    const d = new Date();
    return `HBR-box-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.png`;
  }

  async function openExport() {
    let options = loadJSON(EXPORT_KEY, { title: '我的 HBR Box', unowned: 'dim', tiers: 'SS,SSR', theme: 'light', perRow: '16' });
    if (!['12', '16', '20', '24'].includes(String(options.perRow))) options.perRow = '16';
    const dialog = document.createElement('dialog');
    dialog.className = 'box-export';
    dialog.setAttribute('aria-label', '导出 box 图');
    const opt = (name, value, list) => `<select name="${name}">${list.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    dialog.innerHTML = `<div class="box-export-head"><h2>导出 box 图</h2><button type="button" data-close aria-label="关闭">×</button></div>
      <div class="box-export-body">
        <form class="box-export-form">
          <label>标题<input name="title" maxlength="30" value="${e(options.title)}"></label>
          <label>稀有度${opt('tiers', options.tiers, [['SS,SSR', 'SS 和 SSR'], ['SS', '只要 SS'], ['SSR', '只要 SSR']])}</label>
          <label>还没有的卡${opt('unowned', options.unowned, [['dim', '变灰显示'], ['hide', '不显示']])}</label>
          <label>每行张数${opt('perRow', String(options.perRow), [['12', '12 张（偏竖）'], ['16', '16 张'], ['20', '20 张'], ['24', '24 张（偏横）']])}</label>
          <label>底色${opt('theme', options.theme, [['light', '浅色'], ['dark', '深色']])}</label>
          <p class="box-export-info" data-info>正在生成预览…</p>
        </form>
        <div class="box-export-preview" data-preview><span class="box-spinner" aria-hidden="true"></span></div>
      </div>
      <div class="box-export-actions"><button type="button" class="quiet" data-copy>复制图片</button><button type="button" class="primary" data-save>保存 PNG</button></div>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.showModal();
    let current = null;
    let seq = 0;
    const refresh = async () => {
      const mine = ++seq;
      const form = new FormData(dialog.querySelector('form'));
      options = Object.fromEntries(form.entries());
      saveJSON(EXPORT_KEY, options);
      dialog.querySelector('[data-info]').textContent = '正在生成预览…';
      const result = await drawBox(options);
      if (mine !== seq || !dialog.isConnected) return;
      current = result.canvas;
      current.className = 'box-export-canvas';
      dialog.querySelector('[data-preview]').replaceChildren(current);
      const s = result.data.summary;
      dialog.querySelector('[data-info]').textContent = `${current.width} × ${current.height} 像素 · 已拥有 ${s.owned}/${s.total} · 满突 ${s.maxed}`;
    };
    let timer = null;
    dialog.querySelector('form').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
    dialog.querySelector('form').addEventListener('submit', (ev) => ev.preventDefault());
    const toBlob = () => new Promise((resolve) => current.toBlob(resolve, 'image/png'));
    dialog.querySelector('[data-save]').onclick = async () => {
      if (!current) return;
      const url = URL.createObjectURL(await toBlob());
      const a = document.createElement('a');
      a.href = url; a.download = exportFileName(); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      notice(`已保存 ${exportFileName()}，可以直接发到社区。`);
    };
    dialog.querySelector('[data-copy]').onclick = async (ev) => {
      if (!current) return;
      const button = ev.currentTarget;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob() })]);
        button.textContent = '已复制 ✓';
        setTimeout(() => { if (button.isConnected) button.textContent = '复制图片'; }, 1800);
      } catch {
        button.textContent = '无法复制，请用保存';
      }
    };
    await refresh();
  }

  function imageFallback(event) {
    const image = event.target;
    if (image?.tagName !== 'IMG' || image.dataset.hbrFallback) return;
    image.dataset.hbrFallback = 'true';
    image.src = '/image-placeholder.svg';
  }

  return {
    mount(element) {
      host?.removeEventListener('error', imageFallback, true);
      host = element;
      host.addEventListener('error', imageFallback, true);
      host.classList.add('box-page');
      render();
    },
    refresh: render,
  };
}
