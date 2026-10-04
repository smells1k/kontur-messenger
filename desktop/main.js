'use strict';
/**
 * Десктопный клиент «Контур» (Electron).
 * - ищет работающий сервер (localhost или адрес из настроек);
 * - если своего сервера нет — запускает приложенный KonturServer.exe;
 * - открывает мессенджер в отдельном окне с иконкой, меню и нативными разрешениями
 *   на камеру/микрофон (нужны для звонков).
 */
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, session, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_URL = 'http://127.0.0.1:4000';
let mainWindow = null;
let serverProcess = null;
let config = { serverUrl: DEFAULT_URL, autoStartServer: true };

/* ----------------------------------------------------------------- конфигурация */
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = Object.assign(config, raw);
  } catch {}
  return config;
}
function saveConfig() {
  try { fs.writeFileSync(configPath(), JSON.stringify(config, null, 2)); } catch {}
}

/* ------------------------------------------------------------------ проверки */
function health(url) {
  return new Promise((resolve) => {
    const req = http.get(url.replace(/\/$/, '') + '/health', { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serverExeCandidates() {
  const paths = [];
  if (process.env.KONTUR_SERVER_EXE) paths.push(process.env.KONTUR_SERVER_EXE);
  paths.push(path.join(path.dirname(process.execPath), 'KonturServer.exe'));       // рядом с портативной сборкой
  paths.push(path.join(process.resourcesPath || '', 'KonturServer.exe'));          // внутри установленной программы
  paths.push(path.join(__dirname, '..', 'KonturServer.exe'));
  paths.push(path.join(__dirname, '..', 'release', 'KonturServer.exe'));
  paths.push(path.join(__dirname, '..', 'dist', 'KonturServer.exe'));
  return paths;
}

/** Пути к коду сервера внутри сборки (resources/server) и к веб-клиенту. */
function bundledServerPaths() {
  const root = process.resourcesPath || path.join(__dirname, '..');
  const candidates = [
    { server: path.join(root, 'server', 'server.js'), web: path.join(root, 'web') },
    { server: path.join(__dirname, '..', 'server', 'server.js'), web: path.join(__dirname, '..', 'web') },
  ];
  return candidates.find((c) => { try { return fs.existsSync(c.server) && fs.existsSync(path.join(c.web, 'index.html')); } catch { return false; } }) || null;
}

async function startLocalServer() {
  if (!config.autoStartServer) return false;
  if (await health(config.serverUrl)) return true;

  const dataDir = path.join(app.getPath('userData'), 'server-data', 'data');
  const exe = serverExeCandidates().find((p) => { try { return fs.existsSync(p); } catch { return false; } });

  if (exe) {
    serverProcess = spawn(exe, ['--quiet', '--port', '4000', '--data', dataDir], { stdio: 'ignore', windowsHide: true });
  } else {
    // своего server.exe рядом нет — поднимаем сервер самим Electron в режиме Node
    const bundled = bundledServerPaths();
    if (!bundled) return false;
    serverProcess = spawn(process.execPath, [
      bundled.server, '--quiet', '--port', '4000', '--host', '0.0.0.0',
      '--data', dataDir, '--web', bundled.web,
    ], {
      stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
  }
  serverProcess.on('exit', () => { serverProcess = null; });
  for (let i = 0; i < 50; i++) { if (await health('http://127.0.0.1:4000')) return true; await sleep(300); }
  return false;
}

/* --------------------------------------------------------------------- окно */
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    backgroundColor: '#0f1420',
    title: 'Мессенджер «Контур»',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  mainWindow.webContents.setUserAgent(mainWindow.webContents.getUserAgent() + ' KonturDesktop/' + app.getVersion());
  mainWindow.loadURL(url);
  mainWindow.on('page-title-updated', (e, title) => { e.preventDefault(); mainWindow.setTitle(title); });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url.split('/').slice(0, 3).join('/'))) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    {
      label: isMac ? app.name : 'Файл',
      submenu: [
        { label: 'Открыть в браузере', click: () => shell.openExternal(config.serverUrl) },
        { label: 'Адрес сервера…', click: openServerDialog },
        { label: 'Перезапустить клиент', click: () => mainWindow && mainWindow.reload() },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit', label: 'Выход' },
      ],
    },
    { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Обновить' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom', label: 'Обычный масштаб' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полный экран' }, { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    {
      label: 'Помощь',
      submenu: [
        { label: 'Проверить связь с сервером', click: async () => {
          const ok = await health(config.serverUrl);
          dialog.showMessageBox(mainWindow, {
            type: ok ? 'info' : 'error',
            title: 'Связь с сервером',
            message: ok ? `Сервер доступен: ${config.serverUrl}` : `Сервер недоступен: ${config.serverUrl}`,
            detail: ok ? 'Синхронизация и звонки будут работать.' : 'Проверьте, запущен ли KonturServer.exe и совпадает ли адрес.',
          });
        } },
        { label: 'О программе', click: () => dialog.showMessageBox(mainWindow, {
          type: 'info', title: 'О программе',
          message: 'Мессенджер «Контур» — десктопный клиент',
          detail: `Версия ${app.getVersion()}\nСервер: ${config.serverUrl}\nNode ${process.versions.node}, Electron ${process.versions.electron}\n\nСинхронизация, группы, файлы, звонки (WebRTC).`,
        }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openServerDialog() {
  const win = new BrowserWindow({
    width: 460, height: 320, parent: mainWindow, modal: true, resizable: false,
    title: 'Адрес сервера', backgroundColor: '#151b2b', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'settings.html'));
  ipcMain.handleOnce('settings:get', () => config);
  ipcMain.handleOnce('settings:save', async (e, next) => {
    config = Object.assign(config, next);
    saveConfig();
    win.close();
    if (mainWindow) mainWindow.loadURL(config.serverUrl);
    return true;
  });
}

/* ------------------------------------------------------------------ разрешения */
function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(['media', 'notifications', 'clipboard-read', 'clipboard-write', 'fullscreen', 'display-capture'].includes(permission));
  });
  // демонстрация экрана: отдаём первый экран (в браузере доступен полный выбор источника)
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      const primary = sources.find((s) => s.display_id === String(screen.getPrimaryDisplay().id)) || sources[0];
      if (!primary) return callback({});
      callback({ video: primary, audio: 'loopback' });
    }, { useSystemPicker: true });
  } catch (err) { /* старые версии Electron */ }
}

/* ----------------------------------------------------------------------- старт */
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
}

app.whenReady().then(async () => {
  loadConfig();
  setupPermissions();
  buildMenu();

  ipcMain.handle('app:config', () => config);
  ipcMain.handle('app:setServerUrl', (e, url) => { config.serverUrl = url; saveConfig(); if (mainWindow) mainWindow.loadURL(url); return true; });
  ipcMain.handle('app:health', () => health(config.serverUrl));
  ipcMain.handle('app:restartServer', async () => {
    if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
    return startLocalServer();
  });

  let url = config.serverUrl;
  if (!(await health(url))) {
    const started = await startLocalServer();
    if (started) url = 'http://127.0.0.1:4000';
    else {
      // локальный сервер не поднялся — показываем окно с адресом и понятной инструкцией
      const choice = dialog.showMessageBoxSync({
        type: 'warning', title: 'Сервер не найден',
        message: `Не удалось подключиться к ${url}`,
        detail: 'Проверьте адрес сервера, либо запустите KonturServer.exe (он лежит рядом с клиентом или в папке программы).',
        buttons: ['Открыть настройки адреса', 'Продолжить без сервера', 'Выход'],
        defaultId: 0, cancelId: 2,
      });
      if (choice === 2) { app.quit(); return; }
      if (choice === 0) { createWindow(url); setTimeout(openServerDialog, 400); return; }
    }
  }
  createWindow(url);
});

app.on('window-all-closed', () => {
  if (serverProcess) { try { serverProcess.kill(); } catch {} }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (!mainWindow) createWindow(config.serverUrl); });
