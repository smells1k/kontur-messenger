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
  dataDir: path.resolve(String(flag('data', process.env.DATA_DIR || path.join(ROOT, 'data')))),
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
    console.error('⚠️  Не удалось очистить папку данных:', err.message);
  }
  console.log('');
  console.log('  🧹 Зачистка базы (флаг --fresh)');
  console.log('     Папка:      ' + config.dataDir);
  console.log('     Удалено:    ' + (removed.length ? removed.join(', ') : 'нечего удалять — было пусто'));
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

function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
  }
  return out;
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
    console.warn('⚠️  HTTPS: не удалось создать сертификат (openssl):', err.message);
    return null;
  }
}

const wantHttps = argv.includes('--https') || process.env.HTTPS === '1';
const tls = wantHttps ? ensureCerts(config) : null;
config.https = !!tls;
if (wantHttps && !tls) console.warn('⚠️  Продолжаю по http — звонки с других устройств браузер может заблокировать.');

const server = tls ? require('https').createServer(tls, app) : http.createServer(app);
const hub = new Hub({ server, store, core, secret, path: '/ws' });
core.hub = hub;
core.hubStore = store;

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

app.get('/health', (req, res) => res.json({
  ok: true,
  name: config.serverName,
  version: config.version,
  build: config.buildDate || '',
  uptime: process.uptime(),
  users: Object.keys(store.data.users).length,
  chats: Object.keys(store.data.chats || {}).length,
  seq: store.seq,
  demoMode: config.demoMode,
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

server.listen(config.port, config.host, () => {
  const addresses = localIPv4();
  if (!config.quiet) {
    const scheme = config.https ? 'https' : 'http';
    const wsScheme = config.https ? 'wss' : 'ws';
    console.log('');
    console.log('  ┌─────────────────────────────────────────────────────┐');
    console.log('  │  💬  ' + config.serverName.padEnd(44) + ' │');
    console.log('  └─────────────────────────────────────────────────────┘');
    console.log(`   Версия:      ${config.version}${config.buildDate ? ' (сборка ' + config.buildDate + ')' : ''}  ·  Node ${process.version}`);
    console.log(`   Локально:    ${scheme}://localhost:${config.port}`);
    for (const ip of addresses) console.log(`   В сети:      ${scheme}://${ip}:${config.port}   ← открой у друзей в той же сети`);
    if (addresses.length) console.log('      (если друзья в той же сети не заходят — разрешите мессенджер в брандмауэре Windows для частных сетей)');
    console.log(`   WebSocket:   ${wsScheme}://localhost:${config.port}/ws`);
    if (config.https) {
      console.log('   🔒 HTTPS включён: сертификат самоподписанный → браузер один раз спросит');
      console.log('      «Подробнее → Перейти на сайт». Зато камера, микрофон и звонки');
      console.log('      работают на всех устройствах в сети.');
    } else {
      console.log('   ℹ️  Голос/видео из браузера доступны только на этом компьютере (localhost).');
      console.log('      Чтобы звонить с телефона/другого ПК, запусти с флагом --https.');
    }
    console.log('   Из интернета: KonturServer.exe --tunnel   ← даст ссылку https://… ,');
    console.log('      она работает из любой сети, и камера с микрофоном там разрешены.');
    console.log('      Из исходников: cloudflared tunnel --url http://localhost:' + config.port);
    console.log(`   Данные:      ${config.dataDir}`);
    console.log('   Очистить всё: запусти один раз с флагом --fresh — база, файлы и');
    console.log('      настройки удалятся, сервер начнёт с чистого листа.');
    if (seeded && !seeded.skipped) {
      console.log('');
      console.log('   🧪 Демо-режим: аккаунты anya, boris, vera, gleb (пароль demo1234) · бот @bot');
      console.log('      Или нажми «Демо-вход» прямо на странице входа.');
      console.log('      Обычный режим без демо — запусти без флага --demo.');
    } else {
      console.log('');
      console.log('   👤 База пустая: на странице входа нажми «Регистрация» —');
      console.log('      аккаунт создаётся за 5 секунд. Демо-чатов и ботов нет.');
    }
    console.log('');
  }
  if (config.openBrowser) {
    const url = `${config.https ? 'https' : 'http'}://localhost:${config.port}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('child_process').exec(cmd, () => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Порт ${config.port} занят. Запусти с другим портом:  node server.js --port ${config.port + 1}\n`);
    process.exit(1);
  }
  throw err;
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n[server] останавливаюсь, сохраняю данные…');
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
