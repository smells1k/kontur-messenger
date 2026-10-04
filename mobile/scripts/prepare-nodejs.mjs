#!/usr/bin/env node
/**
 * Собирает Node.js-бандл для Android-приложения.
 *
 * Что делает: берёт сервер и веб-клиент прямо из этого репозитория (одна копия
 * кода на все платформы — правим здесь, работает и на Windows, и на телефоне)
 * и складывает их в mobile/www/nodejs — эту папку Capacitor кладёт в APK,
 * а плагин распаковывает в личную папку приложения при первом запуске.
 *
 * Запуск:  node scripts/prepare-nodejs.mjs          (сборка)
 *          node scripts/prepare-nodejs.mjs --check  (только проверить результат)
 */
import { cp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');
const REPO = path.resolve(MOBILE, '..');
const TARGET = path.join(MOBILE, 'www', 'nodejs');
const CHECK_ONLY = process.argv.includes('--check');

const VERSION = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8')).version;

/** Копирует только нужное: без тестов, без dev-файлов, без node_modules. */
async function copySources(from, to, filter) {
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true, filter: (src) => (filter ? filter(src) : true) });
}

const log = (...args) => console.log('▶︎', ...args);

async function build() {
  log(`собираю Node-бандл для APK (версия ${VERSION})`);
  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });

  // 1. Сервер: server.js + src/* (тесты и package-lock внутри APK не нужны)
  await copySources(
    path.join(REPO, 'server'),
    path.join(TARGET, 'server'),
    (src) => !/[\\/](test|node_modules)([\\/]|$)/.test(src) && !/package-lock\.json$/.test(src)
  );

  // 2. Веб-клиент целиком — его раздаёт тот же сервер
  await copySources(path.join(REPO, 'web'), path.join(TARGET, 'web'));

  // 3. Точка входа для телефона
  await cp(path.join(MOBILE, 'node', 'mobile-server.js'), path.join(TARGET, 'mobile-server.js'));

  // 4. package.json бандла: без зависимостей сервера не поднимется
  const serverPkg = JSON.parse(await readFile(path.join(REPO, 'server', 'package.json'), 'utf8'));
  const bundlePkg = {
    name: 'kontur-server-mobile',
    version: VERSION,
    private: true,
    description: 'Сервер «Контура» внутри Android-приложения',
    main: 'mobile-server.js',
    dependencies: {
      express: serverPkg.dependencies.express,
      ws: serverPkg.dependencies.ws,
    },
  };
  await writeFile(path.join(TARGET, 'package.json'), JSON.stringify(bundlePkg, null, 2) + '\n');

  // 5. Зависимости — «на месте», чтобы плагин положил их в APK как есть
  log('ставлю зависимости сервера (express, ws) внутрь бандла…');
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], {
    cwd: TARGET,
    stdio: 'inherit',
  });

  const size = await dirSize(TARGET);
  log(`готово: ${path.relative(REPO, TARGET)} — ${(size / 1024 / 1024).toFixed(1)} МБ`);
}

async function dirSize(dir) {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await stat(full)).size;
  }
  return total;
}

function check() {
  const needed = [
    'mobile-server.js',
    'package.json',
    'server/server.js',
    'server/src/core.js',
    'server/src/version.js',
    'web/index.html',
    'node_modules/express/package.json',
    'node_modules/ws/package.json',
  ];
  let bad = 0;
  for (const rel of needed) {
    const ok = existsSync(path.join(TARGET, rel));
    console.log(`${ok ? '✅' : '❌'} ${rel}`);
    if (!ok) bad++;
  }
  if (bad) {
    console.error('\nБандл собран не полностью — запустите: npm run prepare:node');
    process.exit(1);
  }
  console.log('\n✅ Node-бандл для APK на месте');
}

if (CHECK_ONLY) check();
else await build();
