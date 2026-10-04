'use strict';
/**
 * Мессенджер «Контур» — Windows-лаунчер.
 *
 * Что делает:
 *   1. поднимает сервер мессенджера (Node.js, Express + WebSocket);
 *   2. отдаёт веб-клиент из папки ./web (рядом с .exe или распаковывает встроенную копию);
 *   3. по умолчанию открывает «приложение» — окно без интерфейса браузера
 *      (Edge/Chrome в режиме --app), а если их нет — обычный браузер.
 *
 * Запуск:  Kontur.exe [--port 4000] [--no-open] [--data C:\path] [--host 0.0.0.0]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, exec } = require('child_process');

const IS_PKG = !!process.pkg;
const EXE_DIR = IS_PKG ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const IS_WINDOWS = process.platform === 'win32';

/* ------------------------------------------------------------------ аргументы */
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
function arg(name, def) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return def;
}

const SERVER_URL = (() => {
  const v = arg('server', process.env.KONTUR_SERVER || null);
  if (!v) return null;
  let url = String(v).trim();
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
})();
const PORT = Number(arg('port', process.env.PORT || 4000));
const HOST = String(arg('host', process.env.HOST || '0.0.0.0'));
const OPEN_APP = !has('no-open');
const APP_MODE = !has('browser');
const QUIET = has('quiet');
const USE_TUNNEL = has('tunnel') || process.env.KONTUR_TUNNEL === '1';

if (has('help') || has('h')) {
  console.log(`
Мессенджер «Контур» — сервер + клиент

  Kontur.exe [параметры]

  --port N        порт (по умолчанию 4000)
  --host IP       адрес прослушивания (по умолчанию 0.0.0.0 — доступно в локальной сети)
  --data DIR      где хранить базу сообщений и загруженные файлы
  --no-open       не открывать окно клиента автоматически
  --browser       открыть в обычном браузере, а не в режиме приложения
  --https         включить HTTPS (нужно для звонков с телефонов и других ПК)
  --tunnel        открыть доступ из интернета через Cloudflare Tunnel:
                  получится ссылка вида https://что-то.trycloudflare.com — её можно
                  дать друзьям в любой сети, камера и микрофон там разрешены
  --closed        закрыть регистрацию (полезно вместе с --tunnel)
  --server URL    подключиться к ЧУЖОМУ серверу (свой сервер не запускается):
                  KonturServer.exe --server http://192.168.1.10:4000
                  окно-приложение получит доступ к камере и микрофону даже по http
  --no-demo       выключить демо-режим (бот и демо-аккаунты)
  --closed        закрыть регистрацию новых пользователей
  --quiet         меньше вывода в консоль
  --help          эта справка

Локальный адрес:  http://localhost:${PORT}
Для друзей в сети:  http://<IP-компьютера>:${PORT}
`);
  process.exit(0);
}

/* ------------------------------------------------------- каталог пользовательских данных */
function userDataDir() {
  if (IS_WINDOWS) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Kontur');
  return path.join(os.homedir(), '.kontur');
}
const DATA_DIR = path.resolve(String(arg('data', process.env.DATA_DIR || path.join(userDataDir(), 'data'))));

/* ------------------------------------------------------------------ веб-клиент */
/** Кандидаты путей внутри снапшота pkg и рядом с .exe. */
function relativeCandidates(rel) {
  return ['', '..', '../..', '../../..', '../../../..'].map((up) => path.resolve(__dirname, up, rel));
}

/** Ищем папку web: рядом с exe, в подпапке, в ресурсах Electron или внутри сборки pkg. */
function findWebDir() {
  const candidates = [
    arg('web', null),
    path.join(EXE_DIR, 'web'),
    path.join(EXE_DIR, 'resources', 'web'),
    ...relativeCandidates('web'),   // внутри снапшота pkg: web лежит рядом со скриптом
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'index.html'))) return dir; } catch {}
  }
  return null;
}

/** Если web рядом нет — распаковываем встроенную копию из снапшота pkg в папку пользователя. */
function extractWeb() {
  const src = relativeCandidates('web').find((dir) => {
    try { return fs.existsSync(path.join(dir, 'index.html')); } catch { return false; }
  });
  if (!src) return null;
  const dest = path.join(userDataDir(), 'app', 'web');
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      if (entry.isDirectory()) walk(s, d);
      else fs.writeFileSync(d, fs.readFileSync(s));
    }
  };
  try {
    walk(src, dest);
    if (fs.existsSync(path.join(dest, 'index.html'))) return dest;
  } catch (err) {
    console.error('[launcher] не удалось распаковать веб-клиент:', err.message);
  }
  return null;
}

/* ------------------------------------------------------------------- сам сервер */
function startServer() {
  const serverEntry = [
    path.join(EXE_DIR, 'server', 'server.js'),      // портативная папка: server/ рядом с .exe
    ...relativeCandidates('server/server.js'),      // внутри снапшота pkg
    path.join(EXE_DIR, 'resources', 'server', 'server.js'),
  ].find((p) => { try { return fs.existsSync(p); } catch { return false; } });

  const webDir = findWebDir() || extractWeb();
  if (!webDir) {
    console.error('❌ Не найдена папка web с клиентом. Положи её рядом с .exe.');
    process.exit(1);
  }

  process.argv = [process.argv[0], serverEntry, '--port', String(PORT), '--host', HOST, '--data', DATA_DIR, '--web', webDir]
    .concat(QUIET ? ['--quiet'] : [])
    .concat(USE_HTTPS ? ['--https'] : [])
    .concat(has('no-demo') ? ['--no-demo'] : [])
    .concat(has('closed') ? ['--closed'] : []);
  process.env.KONTUR_LAUNCHER = '1';
  if (process.env.KONTUR_DEBUG === '1') {
    console.log('[debug] exe:', process.execPath);
    console.log('[debug] exe dir:', EXE_DIR);
    console.log('[debug] server:', serverEntry);
    console.log('[debug] web:', webDir);
    console.log('[debug] data:', DATA_DIR);
    try { console.log('[debug] __dirname:', __dirname, '->', fs.readdirSync(__dirname).join(', ')); } catch (e) { console.log('[debug] __dirname err', e.message); }
    for (const up of ['', '..', '../..', '../../..']) {
      const dir = path.resolve(__dirname, up);
      try { console.log('[debug] list', dir, '=>', fs.readdirSync(dir).join(', ')); } catch (e) { console.log('[debug] list', dir, 'err', e.message); }
    }
  }
  require(serverEntry);
  return true;
}

/* -------------------------------------------------------------------- клиент */
const USE_HTTPS = has('https') || process.env.HTTPS === '1';

function healthCheck(url = `${USE_HTTPS ? 'https' : 'http'}://127.0.0.1:${PORT}/health`) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : http;
    const req = lib.get(url, { timeout: 1500, rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function findChromium() {
  if (!IS_WINDOWS) return null;
  const roots = [
    process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA,
  ].filter(Boolean);
  const rel = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Chromium', 'Application', 'chrome.exe'],
    ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ];
  for (const root of roots) for (const parts of rel) {
    const p = path.join(root, ...parts);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

async function waitForServer(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await healthCheck()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Браузер разрешает камеру/микрофон только на localhost или по HTTPS.
 *  Для окна-приложения по обычному http-адресу в сети добавляем флаг Chromium,
 *  который помечает этот адрес как доверенный — иначе разрешение не спросить даже. */
function permissionsArgs(url) {
  const args = [];
  let origin = null;
  try { const u = new URL(url); origin = u.origin; } catch { /* не URL — пропускаем */ }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());
  if (origin && !isLocal && !url.startsWith('https:')) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${origin}`);
    args.push('--allow-running-insecure-content');
  }
  return args;
}

async function openClient(url = null) {
  const target = url || `${USE_HTTPS ? 'https' : 'http'}://localhost:${PORT}`;
  if (!(await waitForServer(target.replace(/\/$/, '') + '/health'))) { console.error('❌ Сервер не отвечает, окно не открываю.'); return; }
  const browser = APP_MODE ? findChromium() : null;
  if (browser) {
    // «приложение»: окно без адресной строки и вкладок
    const profile = path.join(userDataDir(), 'app-profile' + (url ? '-' + target.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) : ''));
    const args = [`--app=${target}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate', '--window-size=1280,820', ...permissionsArgs(target)];
    if (!IS_WINDOWS && process.platform === 'linux') args.push('--class=Kontur');
    const child = spawn(browser, args, { detached: true, stdio: 'ignore' });
    child.unref();
    if (IS_WINDOWS) console.log(`   Окно приложения открыто (${path.basename(browser)}). Работает как обычное приложение.`);
    if (permissionsArgs(target).length) {
      console.log('   Камера, микрофон и демонстрация экрана разрешены в этом окне даже по http.');
    }
    return;
  }
  const cmd = IS_WINDOWS ? `start "" "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
  exec(cmd, () => {});
  if (!target.startsWith('https') && permissionsArgs(target).length) {
    console.log('   ⚠️ Открываю в обычном браузере: камеру и микрофон он заблокирует (не-localhost по http).');
    console.log('      Варианты: запустите без --browser (окно-приложение), либо на сервере включите --https.');
  }
}

/* ------------------------------------------------------------------- туннель */
/** Путь до cloudflared: сначала рядом с .exe, потом из PATH. */
function cloudflaredBin() {
  const local = ['cloudflared.exe', 'cloudflared'].map((n) => path.join(EXE_DIR, n)).find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  return local || (IS_WINDOWS ? 'cloudflared.exe' : 'cloudflared');
}

/** Поднимает Cloudflare Tunnel и печатает публичную https-ссылку. */
function startTunnel() {
  const bin = cloudflaredBin();
  console.log('');
  console.log('  🌍 Открываю доступ из интернета (Cloudflare Tunnel)…');
  console.log(`     адрес внутри: http://127.0.0.1:${PORT}`);

  let child;
  try {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    printTunnelHelp(err.message);
    return null;
  }

  let shown = false;
  const onData = (buf) => {
    const text = buf.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !shown) {
      shown = true;
      console.log('');
      console.log('  ┌───────────────────────────────────────────────────────────────┐');
      console.log('  │  ✅ Ссылка для друзей — работает из любой сети:               │');
      console.log('  └───────────────────────────────────────────────────────────────┘');
      console.log(`     ${m[0]}`);
      console.log('     Камера, микрофон и демонстрация экрана там разрешены (это HTTPS).');
      console.log('     ⚠️ Кто знает ссылку — может зарегистрироваться. Только для своих:');
      console.log('        создайте аккаунты и перезапустите с флагом --closed.');
      console.log('');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => printTunnelHelp(err.message));
  child.on('exit', (code) => { if (code && code !== 0) console.log(`  ⚠️ Туннель закрылся (код ${code}). Ссылка перестала работать.`); });
  process.on('exit', () => { try { child.kill(); } catch { /* уже закрыт */ } });
  return child;
}

function printTunnelHelp(reason) {
  console.log('  ❌ Не удалось запустить cloudflared' + (reason ? ` (${reason})` : '') + '.');
  console.log('     Он не входит в состав мессенджера. Скачайте один файл:');
  console.log('     https://github.com/cloudflare/cloudflared/releases/latest  →  cloudflared-windows-amd64.exe');
  console.log('     Переименуйте в cloudflared.exe, положите рядом с KonturServer.exe и запустите снова.');
  console.log('     Или вручную в другом окне:  cloudflared tunnel --url http://localhost:' + PORT);
}

/* --------------------------------------------------------------------- старт */
(async () => {
  // Режим «подключиться к чужому серверу»: свой сервер не поднимаем вообще.
  if (SERVER_URL) {
    if (!QUIET) {
      console.log('');
      console.log('  💬  Мессенджер «Контур» — подключаюсь к серверу друга');
      console.log(`      Адрес: ${SERVER_URL}`);
      console.log('      Свой сервер не запускается — вы в общей сети с другом.');
      console.log('');
    }
    const up = await healthCheck(SERVER_URL + '/health');
    if (!up && !QUIET) {
      console.log('   ⚠️ Сервер пока не отвечает. Проверьте:');
      console.log('      • адрес указан верно (например, http://192.168.1.10:4000);');
      console.log('      • вы в одной сети с тем, кто запустил сервер;');
      console.log('      • на его компьютере разрешён мессенджер в брандмауэре.');
      console.log('   Всё равно открываю окно — клиент сам переподключится.');
    }
    if (OPEN_APP) await openClient(SERVER_URL);
    return;
  }

  const already = await healthCheck();
  if (already) {
    if (!QUIET) console.log(`\n[launcher] Сервер уже запущен на порту ${PORT} — открываю клиент.`);
    if (OPEN_APP) await openClient();
    if (USE_TUNNEL) startTunnel();
    return;
  }

  startServer();

  // лёгкая подстраховка: даём серверу подняться и, если он упал — выходим с кодом 1
  process.on('uncaughtException', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.log(`\n[launcher] Порт ${PORT} занят — возможно, мессенджер уже запущен. Открываю клиент.`);
      if (OPEN_APP) openClient();
      return;
    }
    console.error('[launcher] ошибка:', err && err.message);
  });

  if (OPEN_APP) {
    setTimeout(async () => {
      const up = await waitForServer();
      if (up) await openClient();
      else console.error('❌ Сервер не отвечает.');
    }, 300);
  }

  if (USE_TUNNEL) setTimeout(startTunnel, 800);
})();
