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
const net = require('net');
const { spawn, exec, execSync } = require('child_process');

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
let PORT = Number(arg('port', process.env.PORT || 4000));
const HOST = String(arg('host', process.env.HOST || '0.0.0.0'));
const OPEN_APP = !has('no-open');
const APP_MODE = !has('browser');
const QUIET = has('quiet');
const TUNNEL_ARG = arg('tunnel', process.env.KONTUR_TUNNEL_TOKEN || null);
const USE_TUNNEL = has('tunnel') || !!process.env.KONTUR_TUNNEL || !!process.env.KONTUR_TUNNEL_TOKEN;
/** Токен именного туннеля Cloudflare (Zero Trust) — тогда адрес постоянный, на своём домене. */
const TUNNEL_TOKEN = (() => {
  if (!TUNNEL_ARG || TUNNEL_ARG === '1' || TUNNEL_ARG === 'true') return null;
  return TUNNEL_ARG.length > 40 ? TUNNEL_ARG : null;
})();

if (has('help') || has('h')) {
  console.log(`
Мессенджер «Контур» — сервер + клиент

  Kontur.exe [параметры]

  --port N        порт (по умолчанию 4000). Если порт занят, лаунчер сам закроет
                  старый экземпляр мессенджера или возьмёт свободный порт рядом
  --host IP       адрес прослушивания (по умолчанию 0.0.0.0 — доступно в локальной сети)
  --data DIR      где хранить базу сообщений и загруженные файлы
  --no-open       не открывать окно клиента автоматически
  --browser       открыть в обычном браузере, а не в режиме приложения
  --https         включить HTTPS (нужно для звонков с телефонов и других ПК)
  --tunnel        открыть доступ из интернета через Cloudflare Tunnel:
                  получится ссылка вида https://что-то.trycloudflare.com — её можно
                  дать друзьям в любой сети, камера и микрофон там разрешены
                  (имя случайное и меняется при перезапуске)
  --tunnel ТОКЕН  постоянный адрес на своём домене: возьмите токен туннеля в панели
                  Cloudflare Zero Trust (Networks → Tunnels), добавьте Public hostname
                  вида kontur.ваш-домен.ру → http://localhost:4000 и запустите так.
                  Адрес всегда один и тот же. Домен подключается к Cloudflare бесплатно.
  --purge-demo    удалить из базы демо-аккаунты, бота и их чаты (ваши переписки остаются)
  --fresh         один раз полностью стереть базу, файлы и настройки
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
    console.error('[x] Не найдена папка web с клиентом. Положи её рядом с .exe.');
    process.exit(1);
  }

  process.argv = [process.argv[0], serverEntry, '--port', String(PORT), '--host', HOST, '--data', DATA_DIR, '--web', webDir]
    .concat(QUIET ? ['--quiet'] : [])
    .concat(USE_HTTPS ? ['--https'] : [])
    .concat(has('no-demo') ? ['--no-demo'] : [])
    .concat(has('purge-demo') ? ['--purge-demo'] : [])
    .concat(has('fresh') ? ['--fresh'] : [])
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
/** Локальный адрес намеренно на 127.0.0.1: «localhost» на Windows резолвится в IPv6 ::1,
 *  а сервер слушает IPv4 — из-за этого проверка «сервер не отвечает» и окно не открывалось. */
const localBase = () => `${USE_HTTPS ? 'https' : 'http'}://127.0.0.1:${PORT}`;

/** Все адреса, по которым этот же компьютер может достучаться до своего сервера. */
function localCandidates() {
  const scheme = USE_HTTPS ? 'https' : 'http';
  const urls = [`${scheme}://127.0.0.1:${PORT}/health`, `${scheme}://[::1]:${PORT}/health`];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a && a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) urls.push(`${scheme}://${a.address}:${PORT}/health`);
      }
    }
  } catch { /* без сети — обойдёмся петлёй */ }
  return urls;
}

/** Ждём ответа сервера по любому из локальных адресов (а не только 127.0.0.1). */
async function waitForServerAny(timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const url of localCandidates()) if (await healthCheck(url)) return url;
    await sleep(400);
  }
  return false;
}

function healthCheck(url = `${localBase()}/health`) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : http;
    const req = lib.get(url, { timeout: 1500, rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* ------------------------------------------------------- проверка порта и запуск */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Что находится на порту: свободно / наш мессенджер / чужая программа.
 * Раньше лаунчер просто ждал ответа от 127.0.0.1 и, если что-то мешало
 * (старый экземпляр, VPN вроде Cloudflare WARP, запрет порта Windows),
 * писал «сервер не отвечает» и не открывал окно.
 */
function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const finish = (state, extra) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(Object.assign({ state }, extra || {}));
    };
    const timer = setTimeout(() => finish('foreign', { why: 'нет ответа' }), 1500);
    sock.on('error', (err) => {
      clearTimeout(timer);
      finish(err.code === 'ECONNREFUSED' ? 'free' : 'foreign', { why: err.code });
    });
    sock.on('connect', () => {
      clearTimeout(timer);
      const req = http.get({ host, port, path: '/health', timeout: 2000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            finish(j && j.ok ? 'ours' : 'foreign', { version: j && j.version, name: j && j.name, data: j && j.data });
          } catch { finish('foreign'); }
        });
      });
      req.on('error', () => finish('foreign'));
      req.on('timeout', () => { req.destroy(); finish('foreign', { why: 'таймаут' }); });
    });
  });
}

/** Первый свободный порт, начиная с заданного (4001, 4002, …). */
async function freePortFrom(start, tries = 30) {
  for (let p = start; p < start + tries; p++) {
    const st = await probePort(p);
    if (st.state === 'free') return p;
  }
  return null;
}

/** PID процесса, слушающего порт (Windows: netstat -ano). */
function pidOnPort(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 5000 });
    const re = new RegExp('[:.]' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** Закрываем ТОЛЬКО старый KonturServer.exe — чужой процесс не трогаем. */
function killOldInstance(pid) {
  try {
    if (!pid || pid === process.pid) return false;
    const info = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 });
    if (!/KonturServer\.exe|Kontur\.exe/i.test(info)) return false;
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Готовим порт до запуска сервера:
 *  • свободен — работаем как обычно;
 *  • занят старым мессенджером — закрываем его (только Windows) либо берём другой порт;
 *  • занят чужой программой — берём свободный порт и объясняем почему.
 */
async function preparePort() {
  const state = await probePort(PORT);
  if (state.state === 'free') return { mode: 'start' };

  if (state.state === 'ours') {
    if (!QUIET) {
      console.log('');
      console.log(`[launcher] На порту ${PORT} уже работает мессенджер${state.version ? ' v' + state.version : ''}.`);
    }
    if (IS_WINDOWS) {
      const pid = pidOnPort(PORT);
      if (killOldInstance(pid)) {
        if (!QUIET) console.log(`   Закрыл старый экземпляр (PID ${pid}) — поднимаю новый сервер.`);
        await sleep(800);
        if ((await probePort(PORT)).state === 'free') return { mode: 'start' };
      } else if (!QUIET) {
        console.log('   Закрыть его не удалось (закройте окно старого сервера вручную: Ctrl+C).');
      }
    } else if (!QUIET) {
      console.log('   Использую его - своё окно открою к тому же серверу.');
    }
    // Старый сервер жив и работает: не плодим второй, просто откроем окно к нему.
    if (!IS_WINDOWS) return { mode: 'reuse' };
  } else if (!QUIET) {
    console.log('');
    console.log(`[launcher] Порт ${PORT} занят другой программой (${state.why || 'не отвечает'}).`);
  }

  const alt = await freePortFrom(PORT + 1);
  if (!alt) {
    console.error(`[x] Не нашёл свободный порт рядом с ${PORT}. Запустите с другим портом: --port 4300`);
    process.exit(1);
  }
  if (!QUIET) {
    console.log(`   Поднимаю мессенджер на свободном порту ${alt}.`);
    console.log(`   Чтобы вернуться на ${PORT}, закройте занимающую его программу и запустите снова.`);
  }
  PORT = alt;
  return { mode: 'start' };
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
  const target = url || localBase();
  let alive = false;
  if (url) {
    alive = await waitForServer(url.replace(/\/$/, '') + '/health', 12000);
    if (!alive) {
      console.log('   [!] Сервер друга пока не отвечает. Проверьте:');
      console.log('      * адрес указан верно (например, http://192.168.1.10:4000);');
      console.log('      * вы в одной сети с тем, кто запустил сервер;');
      console.log('      * на его компьютере разрешён мессенджер в брандмауэре.');
      console.log('   Всё равно открываю окно - клиент сам переподключится.');
    }
  } else {
    alive = await waitForServer(`${localBase()}/health`, 15000) || await waitForServerAny(10000);
    if (!alive) {
      // Раньше здесь лаунчер отказывался открывать окно. Теперь окно открывается всегда:
      // сервер работает в этом же процессе, а проверка по сети может не пройти из-за
      // VPN (Cloudflare WARP), антивируса, IPv6 или запрещённого порта Windows.
      console.log(`   [!] Не дождался ответа по адресу ${localBase()}/health, но окно открываю.`);
      console.log('      Если в окне пусто, проверьте:');
      console.log(`        * порт не занят другой программой:  netstat -ano | findstr :${PORT}`);
      console.log('        * VPN/антивирус (например, Cloudflare WARP) и брандмауэр Windows: разрешите мессенджеру локальные соединения;');
      console.log(`        * другой порт:  KonturServer.exe --port ${PORT + 1}`);
    }
  }
  const browser = APP_MODE ? findChromium() : null;
  if (browser) {
    // «приложение»: окно без адресной строки и вкладок
    const profile = path.join(userDataDir(), 'app-profile' + (url ? '-' + target.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) : ''));
    const args = [`--app=${target}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate', '--window-size=1280,820', ...permissionsArgs(target)];
    if (!IS_WINDOWS && process.platform === 'linux') args.push('--class=Kontur');
    const child = spawn(browser, args, { detached: true, stdio: 'ignore' });
    child.unref();
    if (IS_WINDOWS) console.log(` Окно приложения открыто (${path.basename(browser)}). Работает как обычное приложение.`);
    if (!url) console.log(`   Адрес окна: ${target}  ·  мессенджер слушает порт ${PORT}`);
    if (permissionsArgs(target).length) {
      console.log('   Камера, микрофон и демонстрация экрана разрешены в этом окне даже по http.');
    }
    return;
  }
  const cmd = IS_WINDOWS ? `start "" "${target}"` : process.platform === 'darwin' ? `open "${target}"` : `xdg-open "${target}"`;
  exec(cmd, () => {});
  if (!target.startsWith('https') && permissionsArgs(target).length) {
    console.log('   [!] Открываю в обычном браузере: камеру и микрофон он заблокирует (не-localhost по http).');
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
  const named = !!TUNNEL_TOKEN;
  console.log('');
  console.log(named
    ? '  [i] Подключаю постоянный адрес (именной туннель Cloudflare)…'
    : '  [i] Открываю доступ из интернета (Cloudflare Tunnel)…');
  console.log(`   адрес внутри: http://127.0.0.1:${PORT}`);

  const args = named
    ? ['tunnel', '--no-autoupdate', 'run', '--token', TUNNEL_TOKEN]
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];

  let child;
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      process.env.KONTUR_TUNNEL_URL = m[0];   // сервер отдаст её в /health — покажем в интерфейсе
      console.log('');
      console.log('  +' + '-'.repeat(61) + '+');
      console.log('  |  ССЫЛКА ДЛЯ ДРУЗЕЙ - работает из любой сети:' + ' '.repeat(16) + '|');
      console.log('  +' + '-'.repeat(61) + '+');
      console.log(`   ${m[0]}`);
      console.log('     Камера, микрофон и демонстрация экрана там разрешены (это HTTPS).');
      console.log('     [!] Кто знает ссылку - может зарегистрироваться. Только для своих:');
      console.log('        создайте аккаунты и перезапустите с флагом --closed.');
      console.log('');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  if (named) {
    console.log('');
    console.log('  +' + '-'.repeat(61) + '+');
    console.log('  |  ПОСТОЯННЫЙ АДРЕС - тот, что вы задали в Cloudflare:' + ' '.repeat(10) + '|');
    console.log('  |  например https://kontur.ваш-домен.ру' + ' '.repeat(23) + '|');
    console.log('  +' + '-' .repeat(61) + '+');
    console.log('     Он не меняется при перезапуске сервера. Камера, микрофон и');
    console.log('     демонстрация экрана там работают - это HTTPS.');
    console.log('     Если адрес не открывается - проверьте в панели Cloudflare:');
    console.log('     Networks -> Tunnels -> Public hostname ведёт на http://localhost:' + PORT);
    console.log('');
  }
  child.on('error', (err) => printTunnelHelp(err.message));
  child.on('exit', (code) => { if (code && code !== 0) console.log(`[!] Туннель закрылся (код ${code}). Ссылка перестала работать.`); });
  process.on('exit', () => { try { child.kill(); } catch { /* уже закрыт */ } });
  return child;
}

function printTunnelHelp(reason) {
  console.log('  [x] Не удалось запустить cloudflared' + (reason ? ` (${reason})` : '') + '.');
  console.log('     Он не входит в состав мессенджера. Скачайте один файл:');
  console.log('     https://github.com/cloudflare/cloudflared/releases/latest  ->  cloudflared-windows-amd64.exe');
  console.log('     Переименуйте в cloudflared.exe, положите рядом с KonturServer.exe и запустите снова.');
  console.log('     Или вручную в другом окне:  cloudflared tunnel --url http://localhost:' + PORT);
}

/* --------------------------------------------------------------------- старт */
(async () => {
  // Режим «подключиться к чужому серверу»: свой сервер не поднимаем вообще.
  if (SERVER_URL) {
    if (!QUIET) {
      console.log('');
      console.log('    Мессенджер "Контур" - подключаюсь к серверу друга');
      console.log(`    Адрес: ${SERVER_URL}`);
      console.log('      Свой сервер не запускается - вы в общей сети с другом.');
      console.log('');
    }
    const up = await healthCheck(SERVER_URL + '/health');
    if (!up && !QUIET) {
      console.log('   [!] Сервер пока не отвечает. Проверьте:');
      console.log('      * адрес указан верно (например, http://192.168.1.10:4000);');
      console.log('      * вы в одной сети с тем, кто запустил сервер;');
      console.log('      * на его компьютере разрешён мессенджер в брандмауэре.');
      console.log('   Всё равно открываю окно - клиент сам переподключится.');
    }
    if (OPEN_APP) await openClient(SERVER_URL);
    return;
  }

  // Порт: пустой — работаем; занят старым мессенджером — закрываем его (Windows) или
  // переиспользуем; занят чужой программой — берём свободный и объясняем это в консоли.
  const prep = await preparePort();
  if (prep.mode === 'reuse') {
    if (!QUIET) console.log(`\n[launcher] Сервер уже запущен на порту ${PORT} - открываю окно.`);
    if (OPEN_APP) await openClient();
    if (USE_TUNNEL) startTunnel();
    return;
  }

  // Сигнал «сервер поднялся» приходит напрямую из сервера (тот же процесс) —
  // так окно открывается даже там, где проверка по сети врёт.
  let readyResolve = null;
  const serverReady = new Promise((resolve) => { readyResolve = resolve; });
  global.__konturServerReady = (info) => { if (readyResolve) readyResolve(info); };

  startServer();

  // лёгкая подстраховка: даём серверу подняться и, если он упал — выходим с кодом 1
  process.on('uncaughtException', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.log(`\n[launcher] Порт ${PORT} занят - возможно, мессенджер уже запущен. Открываю клиент.`);
      if (OPEN_APP) openClient();
      return;
    }
    console.error('[launcher] ошибка:', err && err.message);
  });

  if (OPEN_APP) {
    (async () => {
      const info = await Promise.race([serverReady, sleep(9000).then(() => null)]);
      if (!info) console.log('[launcher] Сервер поднимается дольше обычного - открываю окно и продолжаю ждать.');
      await openClient();
    })();
  }

  if (USE_TUNNEL && !SERVER_URL) setTimeout(startTunnel, 800);
})();
