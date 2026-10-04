'use strict';
/**
 * Полный сброс данных мессенджера: удаляет базу (db.json), журнал событий,
 * загруженные файлы и демо-контент. Секретный ключ сессий по умолчанию сохраняется,
 * поэтому уже выданные токены продолжают работать — чтобы выйти «в ноль» полностью,
 * укажите --all (тогда пользователи будут разлогинены).
 *
 * Запуск (сервер должен быть остановлен):
 *   node scripts/reset-data.js                 # сбросить базу в папке по умолчанию
 *   node scripts/reset-data.js --data D:\chat  # указать другую папку данных
 *   node scripts/reset-data.js --dry-run       # только показать, что будет удалено
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
function arg(name, def) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return def;
}

function defaultDataDir() {
  const exeDir = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
  if (process.platform === 'win32' || process.env.LOCALAPPDATA) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const appDir = path.join(local, 'Kontur', 'data');
    if (fs.existsSync(appDir)) return appDir;
  }
  const local = path.join(exeDir, 'data');
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), '.kontur', 'data');
}

const DATA_DIR = path.resolve(String(arg('data', process.env.DATA_DIR || defaultDataDir())));
const DRY = has('dry-run');
const ALL = has('all');

/** Размер файла или папки целиком (вложенные каталоги тоже считаем). */
function sizeOf(target) {
  let stat;
  try { stat = fs.statSync(target); } catch { return 0; }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) total += sizeOf(path.join(target, entry.name));
  return total;
}

function remove(target, label) {
  if (!fs.existsSync(target)) return 0;
  const size = sizeOf(target);
  if (DRY) {
    console.log(`  * [пробный запуск] удалил бы ${label}: ${target}`);
  } else {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`  ok удалено (${(size / 1024).toFixed(1)} КБ) - ${label}`);
  }
  return 1;
}

console.log(`\nСброс данных мессенджера "Контур"${DRY ? ' (пробный запуск, ничего не меняется)' : ''}`);
console.log(`Папка данных: ${DATA_DIR}\n`);

if (!fs.existsSync(DATA_DIR)) {
  console.log('[i] Папка данных ещё не создана - сбрасывать нечего.');
  process.exit(0);
}

let removed = 0;
removed += remove(path.join(DATA_DIR, 'db.json'), 'база: пользователи, чаты, сообщения');
removed += remove(path.join(DATA_DIR, 'uploads'), 'загруженные файлы');
removed += remove(path.join(DATA_DIR, 'events.json'), 'журнал событий (если есть)');
if (ALL) removed += remove(path.join(DATA_DIR, 'secret.key'), 'ключ сессий (все будут разлогинены)');

console.log(removed
  ? `\n✅ Готово. Запустите сервер — он стартует с чистой базой и открытой регистрацией.`
  : `\nℹ Ничего не найдено: база уже пустая.`);
if (ALL) console.log('   Флаг --all также сбросил ключ сессий.');
process.exit(0);
