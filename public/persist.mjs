// 档案持久化：服务端 archive.json（经 wbkit 令牌接口），按修订号串行保存。
// 页面逻辑仍是同步的 save()：先改内存，再排队写服务端；失败时保留待写内容并提示。
const token = document.querySelector('meta[name="wb-token"]')?.content || '';
const LOCAL_KEYS = ['hbr-axis-archive-v2', 'hbr-axis-archive-v1'];

async function call(path, body) {
  const options = { headers: { 'X-WB-Token': token }, cache: 'no-store' };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function createStore({ onStatus } = {}) {
  let revision = 0, pending = null, running = null, failed = null;
  const status = (state, detail = '') => onStatus?.(state, detail);

  async function flush() {
    while (pending) {
      const archive = pending; pending = null;
      try {
        const result = await call('/api/archive', { archive, revision, source: 'ui' });
        revision = result.revision; failed = null;
        status('saved', result.saved);
      } catch (error) {
        // 冲突或断线：保留最后一份待写内容，等用户处理
        if (!pending) pending = archive;
        failed = error;
        status('error', error.status === 409 ? '档案已在别处更新，请刷新页面' : error.message);
        return;
      }
    }
  }

  return {
    async load() {
      const data = await call('/api/archive');
      revision = data.revision;
      return data;
    },
    // 同步接口：返回 true 表示已排队；真实结果经 onStatus 回报
    save(archive) {
      pending = structuredClone(archive);
      status('saving');
      if (!running) running = flush().finally(() => { running = null; });
      return true;
    },
    async retry() { if (pending && !running) running = flush().finally(() => { running = null; }); return running; },
    get failed() { return failed; },
    get dirty() { return !!pending || !!running; },
    snapshot(archive, reason) { return call('/api/snapshot', { archive, reason }); },
    backups() { return call('/api/backups'); },
    openDataDir() { return call('/api/open-data-dir', {}); },
    cachePreview(archive) { return call('/api/cache-import/preview', { archive }); },
    cacheDecks() { return call('/api/cache-decks'); },
  };
}

// 旧版只存在浏览器里的档案（v0.5 及以前）；只读取，不删除
export function readLocalArchive() {
  for (const key of LOCAL_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return { key, raw, value: JSON.parse(raw) };
    } catch { /* 损坏的旧记录忽略，原值仍留在浏览器 */ }
  }
  return null;
}
