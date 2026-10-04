'use strict';
/**
 * Проверка обновлений на GitHub.
 * Нужна, чтобы не сидеть на старой сборке и не гадать «почему ничего не изменилось»:
 * клиент сам покажет «доступна версия X» и ссылку на скачивание.
 *
 * Сервер раз в 30 минут спрашивает у GitHub последний релиз. Интернета нет —
 * просто отвечаем «неизвестно», ничего не падает и не тормозит.
 */
const REPO = process.env.KONTUR_REPO || 'smells1k/kontur-messenger';
const TTL = 30 * 60 * 1000;

let cache = { at: 0, data: null };

function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function fetchLatest() {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'kontur-messenger', Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const rel = await res.json();
    return {
      tag: String(rel.tag_name || '').replace(/^v/, ''),
      page: rel.html_url || `https://github.com/${REPO}/releases/latest`,
      name: rel.name || rel.tag_name || '',
      publishedAt: rel.published_at || '',
      assets: (rel.assets || []).map((a) => ({
        name: a.name, size: a.size, url: a.browser_download_url,
      })),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** { current, latest, hasUpdate, url, exe, note } */
async function checkUpdate(current) {
  const now = Date.now();
  if (!cache.data || now - cache.at > TTL) {
    cache = { at: now, data: await fetchLatest() };
  }
  const rel = cache.data;
  if (!rel) {
    return { current, latest: null, hasUpdate: false, unknown: true, url: `https://github.com/${REPO}/releases/latest` };
  }
  const exe = (rel.assets.find((a) => /\.exe$/i.test(a.name)) || {}).url || null;
  const zip = (rel.assets.find((a) => /\.zip$/i.test(a.name)) || {}).url || null;
  return {
    current,
    latest: rel.tag,
    hasUpdate: compareVersions(rel.tag, current) > 0,
    url: rel.page,
    exe,
    zip,
    publishedAt: rel.publishedAt,
    note: rel.name || '',
  };
}

module.exports = { checkUpdate, compareVersions, REPO };
