'use strict';
/**
 * Мессенджер «Контур» — сервер.
 * Запуск:  node server.js [--port 4000] [--host 0.0.0.0] [--no-demo] [--no-seed]
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');

const { Store } = require('./src/store');
const { Core } = require('./src/core');
const { Hub } = require('./src/realtime');
const { createApi } = require('./src/api');
const { seedDemo } = require('./src/seed');
const { checkUpdate } = require('./src/update');
const { AssistantBot } = require('./src/bots');

/* ------------------------------------------------------------------ аргументы */

const argv = process.argv.slice(2);
function flag(name, def) {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  if (argv.includes(`--${name}`)) return true;
  return def;
}

const ROOT = path.resolve(__dirname, '..');

/**
 * Где хранить базу и файлы.
 * В упакованном .exe каталог кода лежит внутри образа (только для чтения), поэтому
 * на Windows берём %LOCALAPPDATA%\Kontur\data — ровно туда же пишет лаунчер Kontur.exe.
 * Благодаря этому и одиночный KonturServer.exe, и лаунчер видят одну и ту же базу.
 */
function defaultDataDir() {
  if (process.pkg) {
    if (process.platform === 'win32' || process.env.LOCALAPPDATA) {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(local, 'Kontur', 'data');
    }
    return path.join(path.dirname(process.execPath), 'data');
  }
  return path.join(ROOT, 'data');
}

// Демо-режим (демо-аккаунты, бот, готовые чаты) по умолчанию ВЫКЛЮЧЕН.
// Включить для показа:  node server.js --demo   (или DEMO=1)
const DEMO_MODE = (argv.includes('--demo') || process.env.DEMO === '1') && !argv.includes('--no-demo');

const { version: BUILD_VERSION, builtAt: BUILD_DATE } = require('./src/version');

const config = {
  version: BUILD_VERSION,
  buildDate: BUILD_DATE,
  serverName: String(flag('name', process.env.SERVER_NAME || 'Мессенджер «Контур»')),
  port: Number(flag('port', process.env.PORT || 4000)),
  host: String(flag('host', process.env.HOST || '0.0.0.0')),
  dataDir: path.resolve(String(flag('data', process.env.DATA_DIR || defaultDataDir()))),
  webDir: path.resolve(String(flag('web', process.env.WEB_DIR || path.join(ROOT, 'web')))),
  demoMode: DEMO_MODE,
  autoSeed: DEMO_MODE && !argv.includes('--no-seed'),
  registrationOpen: !argv.includes('--closed') && process.env.REGISTRATION_OPEN !== '0',
  maxUploadMb: Number(flag('max-upload', process.env.MAX_UPLOAD_MB || 100)),
  quiet: argv.includes('--quiet'),
  openBrowser: argv.includes('--open'),
};
config.uploadDir = path.join(config.dataDir, 'uploads');

/**
 * Полная зачистка сервера: удаляет базу, загруженные файлы и сертификаты.
 * Запуск:  node server.js --fresh   (или KonturServer.exe --fresh)
 */
if (argv.includes('--fresh') && !argv.includes('--no-fresh')) {
  const keepSecret = argv.includes('--keep-secret');
  const removed = [];
  try {
    for (const entry of fs.readdirSync(config.dataDir)) {
      if (keepSecret && entry === 'secret.key') continue;
      fs.rmSync(path.join(config.dataDir, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  } catch (err) {
    console.error('[!]  Не удалось очистить папку данных:', err.message);
  }
  console.log('');
  console.log('   Зачистка базы (флаг --fresh)');
  console.log('     Папка: ' + config.dataDir);
  console.log('     Удалено: ' + (removed.length ? removed.join(', ') : 'нечего удалять - было пусто'));
  console.log('     Сервер стартует с нуля: пользователей, чатов и файлов нет.');
  console.log('     Дальше запускай без --fresh, иначе база будет стираться каждый раз.');
  console.log('');
}

fs.mkdirSync(config.dataDir, { recursive: true });

/* -------------------------------------------------------------------- секрет */

const secretFile = path.join(config.dataDir, 'secret.key');
let secret = process.env.SECRET || null;
if (!secret) {
  try { secret = fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, secret, { mode: 0o600 }); }
}
config.secret = secret;

/* ------------------------------------------------------------------- сервисы */

const store = new Store(path.join(config.dataDir, 'db.json'));
const core = new Core(store, null);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/* ------------------------------------------------------- HTTPS (для звонков) */

/** Адаптеры, по которым друзья точно не зайдут: виртуальные коммутаторы и служебные интерфейсы. */
const VIRTUAL_RE = /virtual|vmware|hyper-?v|vethernet|docker|wsl|loopback|tailscale|zerotier|radmin|hamachi|npcap|openvpn|tap-|bluetooth|isatap|teredo/i;

/**
 * Все локальные IPv4 с именами адаптеров. Виртуальные помечаются и уходят в конец:
 * на Windows рядом с Wi-Fi часто есть Hyper-V/VMware-адаптеры со своими 192.168.x.1,
 * и именно их нельзя давать друзьям.
 */
function localIPv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const virtual = VIRTUAL_RE.test(name) || /^169\.254\./.test(iface.address);
      out.push({ name, address: iface.address, virtual });
    }
  }
  out.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return out;
}

/** Только те адреса, которые стоит давать друзьям (без виртуальных). */
function publicIPv4(list) {
  const all = list || localIPv4();
  const real = all.filter((a) => !a.virtual);
  return real.length ? real : all;
}

/**
 * Браузеры разрешают камеру/микрофон только на localhost или по HTTPS.
 * Поэтому для звонков с других устройств в сети есть режим --https:
 * при первом запуске сам подписывает сертификат (нужен openssl) под IP этого компьютера.
 */
function ensureCerts(cfg) {
  const keyPath = String(flag('key', process.env.TLS_KEY || path.join(cfg.dataDir, 'certs', 'key.pem')));
  const certPath = String(flag('cert', process.env.TLS_CERT || path.join(cfg.dataDir, 'certs', 'cert.pem')));
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), keyPath, certPath };
    }
  } catch {}
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...localIPv4().map((ip) => 'IP:' + ip)].join(',');
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    require('child_process').execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 ` +
      `-keyout "${keyPath}" -out "${certPath}" -subj "/CN=kontur-messenger" -addext "subjectAltName=${san}"`,
      { stdio: 'ignore' }
    );
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), keyPath, certPath };
  } catch (err) {
    console.warn('[!]  HTTPS: не удалось создать сертификат (openssl):', err.message);
    return null;
  }
}

const wantHttps = argv.includes('--https') || process.env.HTTPS === '1';
const tls = wantHttps ? ensureCerts(config) : null;
config.https = !!tls;
if (wantHttps && !tls) console.warn('[!]  Продолжаю по http - звонки с других устройств браузер может заблокировать.');

const server = tls ? require('https').createServer(tls, app) : http.createServer(app);
const hub = new Hub({ server, store, core, secret, path: '/ws' });
core.hub = hub;
core.hubStore = store;

/**
 * Полное удаление демо-данных из существующей базы (флаг --purge-demo):
 * демо-аккаунты, бот @bot, их чаты, группы и сообщения. Ваши переписки остаются.
 */
function purgeDemoData() {
  const DEMO_LOGINS = new Set(['anya', 'boris', 'vera', 'gleb', 'bot']);
  const demoIds = new Set();
  for (const [id, u] of Object.entries(store.data.users || {})) {
    if (!u) continue;
    if (u.isBot || DEMO_LOGINS.has(String(u.username))) demoIds.add(id);
  }
  const removed = { users: demoIds.size, chats: 0, messages: 0 };
  if (!demoIds.size) return removed;

  for (const id of demoIds) delete store.data.users[id];

  for (const [chatId, chat] of Object.entries(store.data.chats || {})) {
    if (!chat) continue;
    const left = (chat.members || []).filter((id) => !demoIds.has(id));
    const hadDemo = left.length !== (chat.members || []).length;
    if (!hadDemo) continue;
    // личный чат с демо-аккаунтом или группа, в которой не осталось людей — удаляем целиком
    if (!left.length || (chat.type === 'direct' && !chat.isDemo)) {
      for (const mid of store.data.chatMessages[chatId] || []) delete store.data.messages[mid];
      delete store.data.chatMessages[chatId];
      delete store.data.chats[chatId];
      removed.chats++;
      continue;
    }
    chat.members = left;
  }

  // сообщения демо-аккаунтов в оставшихся чатах тоже убираем
  for (const [mid, m] of Object.entries(store.data.messages || {})) {
    if (m && demoIds.has(m.authorId)) {
      delete store.data.messages[mid];
      const list = store.data.chatMessages[m.chatId];
      if (list) store.data.chatMessages[m.chatId] = list.filter((x) => x !== mid);
      removed.messages++;
    }
  }
  for (const key of Object.keys(store.data.reads || {})) {
    if (demoIds.has(key.split(':')[1])) delete store.data.reads[key];
  }
  store.data.calls = {};
  store.data.events = (store.data.events || []).filter((e) => !e || !demoIds.has(e.actorId));
  store.save();
  return removed;
}

if (argv.includes('--purge-demo')) {
  const clean = store.data.users ? purgeDemoData() : { users: 0, chats: 0, messages: 0 };
  console.log('');
  console.log('   Очистка демо-данных (флаг --purge-demo)');
  console.log(`     Удалено: демо-аккаунтов - ${clean.users}, чатов - ${clean.chats}, сообщений - ${clean.messages}`);
  console.log('     Ваши аккаунты, чаты и история не тронуты. Дальше запускайте без этого флага.');
  console.log('');
}

const seeded = config.autoSeed ? seedDemo({ store, core, uploadDir: config.uploadDir }) : { skipped: true };

/* --------------------------------------------------------------------- боты */

let bot = null;
const botUser = Object.values(store.data.users).find((u) => u.isBot);
if (botUser) {
  core.botUserId = botUser.id;
  bot = new AssistantBot(core, store);
  core.bots.push(bot);
  const demoGroup = Object.values(store.data.chats).find((c) => c.type === 'group' && c.isDemo && botUser.id && c.members.includes(botUser.id));
  if (demoGroup && config.demoMode) bot.startAmbient(demoGroup.id, botUser.id);
}

/* ----------------------------------------------------------------------- API */

app.use('/api', createApi({ core, store, secret, config }));

// Проверка обновлений: клиент спрашивает и, если вышла новая версия, показывает ссылку.
app.get('/api/server/update', (req, res) => checkUpdate(config.version).then((u) => res.json(u)).catch(() => res.json({ current: config.version, hasUpdate: false, unknown: true })));

app.get('/health', (req, res) => res.json({
  ok: true,
  lan: publicIPv4().map((a) => ({ address: a.address, name: a.name, virtual: a.virtual })),
  tunnel: process.env.KONTUR_TUNNEL_URL || null,
  name: config.serverName,
  version: config.version,
  build: config.buildDate || '',
  uptime: process.uptime(),
  users: Object.keys(store.data.users).length,
  chats: Object.keys(store.data.chats || {}).length,
  seq: store.seq,
  demoMode: config.demoMode,
  data: config.dataDir,
}));

/* --------------------------------------------------------------- статика веб */

const indexFile = path.join(config.webDir, 'index.html');
// Загруженные файлы неизменяемы — их можно кэшировать надолго.
app.use('/uploads', express.static(config.uploadDir, { etag: true, maxAge: '7d', fallthrough: true }));
// Клиент — всегда перепроверяем у сервера (ETag → 304, если не менялся):
// после обновления сервера в браузере сразу видна новая версия, а не старый кэш.
app.use(express.static(config.webDir, {
  etag: true,
  lastModified: true,
  maxAge: 0,
  index: 'index.html',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.setHeader('X-Kontur-Version', config.version);
  },
}));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(indexFile, (err) => { if (err) res.status(404).send('Клиент не найден: ' + indexFile); });
});

/* -------------------------------------------------------------------- запуск */

/** Колбэк запуска: сообщаем лаунчеру «готово» и печатаем баннер. */
function onListening() {
  const addresses = localIPv4();
  // Лаунчер (тот же процесс) ждёт этот сигнал — раньше он проверял себя по сети
  // и на Windows мог не дождаться (VPN, файрвол, IPv6), из-за чего окно не открывалось.
  if (typeof global.__konturServerReady === 'function') {
    try { global.__konturServerReady({ port: config.port, addresses: addresses.map((a) => a.address) }); } catch {}
  }
  if (!config.quiet) {
    const scheme = config.https ? 'https' : 'http';
    const wsScheme = config.https ? 'wss' : 'ws';
    console.log('');
    console.log('  +' + '-'.repeat(53) + '+');
    console.log('  | ' + String(config.serverName).replace(/[«»]/g, '').trim().padEnd(50).slice(0, 50) + '|');
    console.log('  +' + '-'.repeat(53) + '+');
    console.log(` Версия:      ${config.version}${config.buildDate ? ' (сборка ' + config.buildDate + ')' : ''}  -  Node ${process.version}`);
    console.log(` Локально:    ${scheme}://127.0.0.1:${config.port}   (этот адрес открывает окно мессенджера)`);
    const real = publicIPv4(addresses);
    for (const a of real) {
      console.log(` В сети:      ${scheme}://${a.address}:${config.port}   <- ${a.name} - этот адрес давайте друзьям`);
    }
    const virtualOnes = addresses.filter((a) => a.virtual);
    if (virtualOnes.length) {
      console.log(` (виртуальные адаптеры, друзьям не подходят: ${virtualOnes.map((a) => a.address).join(', ')})`);
    }
    if (addresses.length) console.log('      (если друзья в той же сети не заходят - разрешите мессенджер в брандмауэре Windows для частных сетей)');
    console.log(` WebSocket:   ${wsScheme}://localhost:${config.port}/ws`);
    if (config.https) {
      console.log('   [https] HTTPS включён: сертификат самоподписанный -> браузер один раз спросит');
      console.log(' "Подробнее -> Перейти на сайт". Зато камера, микрофон и звонки');
      console.log('      работают на всех устройствах в сети.');
    } else {
      console.log('   [i]  Голос/видео из браузера доступны только на этом компьютере (localhost).');
      console.log('      Чтобы звонить с телефона/другого ПК, запусти с флагом --https.');
    }
    console.log('   Из интернета: KonturServer.exe --tunnel   <- даст ссылку https://... ,');
    console.log('      она работает из любой сети, и камера с микрофоном там разрешены.');
    console.log('      Из исходников: cloudflared tunnel --url http://localhost:' + config.port);
    console.log(` Данные:      ${config.dataDir}`);
    console.log(` Зачистка:    удалите эту папку или запустите с флагом --fresh (один раз, без повтора регистрации)`);
    console.log('   Очистить всё: запусти один раз с флагом --fresh - база, файлы и');
    console.log('      настройки удалятся, сервер начнёт с чистого листа.');
    if (seeded && !seeded.skipped) {
      console.log('');
      console.log('   [демо] Демо-режим: аккаунты anya, boris, vera, gleb (пароль demo1234) - бот @bot');
      console.log('      Или нажми "Демо-вход" прямо на странице входа.');
      console.log('      Обычный режим без демо - запусти без флага --demo.');
    } else {
      console.log('');
      console.log('    База пустая: на странице входа нажми "Регистрация" -');
      console.log('      аккаунт создаётся за 5 секунд. Демо-чатов и ботов нет.');
    }
    console.log('');
  }
  if (config.openBrowser) {
    const url = `${config.https ? 'https' : 'http'}://localhost:${config.port}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(cmd, () => {});
  }
}

/**
 * Слушаем «0.0.0.0» двойным стеком (::): тогда работают и 127.0.0.1, и ::1.
 * На Windows браузеры часто ходят на localhost через IPv6 — из-за IPv4-only
 * привязки проверка «сервер не отвечает» срабатывала даже у живого сервера.
 */
let listenFallback = false;
function listenNow() {
  if (!config.host || config.host === '0.0.0.0') {
    server.listen(config.port, '::', onListening);
  } else {
    server.listen(config.port, config.host, onListening);
  }
}

server.on('error', (err) => {
  // IPv6 может быть выключен в системе — тогда спокойно переходим на IPv4
  if (!listenFallback && (!config.host || config.host === '0.0.0.0') &&
      ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL', 'EPROTONOSUPPORT'].includes(err.code)) {
    listenFallback = true;
    console.log('   [i] IPv6 в системе недоступен - слушаю только IPv4.');
    server.listen(config.port, '0.0.0.0', onListening);
    return;
  }
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[x] Порт ${config.port} уже занят: похоже, запущен старый KonturServer (или другая программа).`);
    console.error(`   Кто держит порт:      netstat -ano | findstr :${config.port}`);
    console.error(`   Запустить на другом:  KonturServer.exe --port ${config.port + 1}`);
    console.error('   Лаунчер KonturServer.exe делает это сам: закрывает старый экземпляр или берёт свободный порт.');
    console.error('');
    process.exitCode = 1;
    return;
  }
  if (err.code === 'EACCES') {
    console.error('');
    console.error(`[x] Windows не даёт занять порт ${config.port} (порт в запрещённом диапазоне Hyper-V/WSL).`);
    console.error('   Посмотреть запрещённые диапазоны:  netsh int ipv4 show excludedportrange protocol=tcp');
    console.error(`   Проще всего взять другой порт:      KonturServer.exe --port ${config.port + 1}`);
    console.error('');
    process.exitCode = 1;
    return;
  }
  console.error('[server] ошибка сервера:', err.message);
});

listenNow();

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n[server] останавливаюсь, сохраняю данные...');
  bot?.pending?.clear?.();
  store.flush();
  for (const [, st] of hub.sockets) { try { st.userId && hub.sendToUser(st.userId, { type: 'server:shutdown' }); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => console.error('[fatal]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

module.exports = { app, server, store, core, hub, config };
