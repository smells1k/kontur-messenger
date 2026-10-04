'use strict';
/**
 * «Контур» на телефоне — точка входа Node.js внутри Android-приложения.
 *
 * Этот файл запускается движком Node.js (плагин capacitor-nodejs) и делает три вещи:
 *   1. выбирает свободный порт и папку для данных внутри песочницы приложения;
 *   2. поднимает обычный сервер «Контура» (тот же код, что и на компьютере);
 *   3. сообщает приложению «сервер готов, вот адрес» через мост bridge → Capacitor.
 *
 * Отличия от настольной версии:
 *   • данные лежат в личной папке приложения (DATADIR), а не рядом с программой;
 *   • не открываем браузер и не создаём сертификаты — на телефоне это не нужно;
 *   • адрес сервера сообщаем приложению, чтобы то открыло мессенджер по нему.
 */
const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');

/** Мост «Node ↔ приложение». Есть только внутри мобильной сборки. */
let bridge = null;
try { bridge = require('bridge'); } catch { bridge = null; }

function send(eventName, payload) {
  try {
    if (!bridge || !bridge.channel) return;
    bridge.channel.send(eventName, typeof payload === 'string' ? payload : JSON.stringify(payload));
  } catch (err) {
    console.log('[mobile] не удалось сообщить приложению о событии', eventName + ':', err.message);
  }
}

const log = (...args) => console.log('[kontur]', ...args);
const PREFERRED_PORT = Number(process.env.KONTUR_PORT || 4000);

/** Первый свободный порт, начиная с заданного. */
function findFreePort(start, tries = 25) {
  return new Promise((resolve) => {
    const attempt = (port, left) => {
      const probe = net.createServer();
      probe.once('error', () => {
        if (left > 0) attempt(port + 1, left - 1);
        else resolve(0);
      });
      probe.once('listening', () => probe.close(() => resolve(port)));
      try { probe.listen(port, '0.0.0.0'); } catch { resolve(0); }
    };
    attempt(start, tries);
  });
}

(async () => {
  /* Данные: личная папка приложения (её даёт мост), иначе временная. */
  const dataRoot = process.env.DATADIR || os.tmpdir();
  const dataDir = path.join(dataRoot, 'kontur');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (err) { log('не удалось создать папку данных:', err.message); }

  const port = await findFreePort(PREFERRED_PORT);
  if (!port) {
    send('server-error', 'Не нашёл свободный порт. Закройте другие приложения и попробуйте снова.');
    return;
  }

  process.env.KONTUR_MOBILE = '1';

  /** Сервер сам позовёт этот обработчик, когда начнёт слушать порт. */
  global.__konturServerReady = (info) => {
    const addresses = (info && info.addresses) || [];
    log(`сервер готов: http://127.0.0.1:${port}`);
    send('server-ready', {
      port: info && info.port ? info.port : port,
      addresses,
      data: dataDir,
      version: require('./server/src/version').version,
    });
  };

  const serverEntry = path.join(__dirname, 'server', 'server.js');
  process.argv = [
    process.argv[0], serverEntry,
    '--port', String(port),
    '--host', '0.0.0.0',      // и сам телефон, и друзья в той же сети Wi-Fi
    '--data', dataDir,
    '--name', 'Мессенджер «Контур» (телефон)',
  ];

  log('запускаю сервер из', serverEntry);
  require(serverEntry);
})().catch((err) => {
  console.error('[kontur] сервер не запустился:', err && err.stack || err);
  send('server-error', (err && err.message) || 'Сервер не запустился');
});
