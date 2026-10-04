/* ==========================================================================
   Контур на Android: экран запуска.
   Запускает Node.js-сервер внутри приложения (плагин CapacitorNodeJS),
   ждёт сигнал «сервер готов», показывает адреса и открывает мессенджер.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CAP = window.Capacitor || null;
  const plugins = (CAP && CAP.Plugins) || {};
  const isAndroid = !!(CAP && CAP.getPlatform && CAP.getPlatform() === 'android');
  const BRIDGE = plugins.CapacitorNodeJS || null;
  const APP = plugins.KonturApp || null;          // наш плагин (фоновая служба, переходы, разрешения)

  const state = {
    phase: 'idle',        // idle | starting | ready | error
    port: null,
    addresses: [],
    version: '—',
    readyTimer: null,
    listeners: [],
  };

  /* ------------------------------------------------------------------ утилиты */

  function toast(text, ms = 2600) {
    const node = $('toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { node.hidden = true; }, ms);
  }

  function logLine(text) {
    const box = $('log');
    $('card-log').hidden = false;
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    box.textContent += `${time}  ${text}\n`;
    box.scrollTop = box.scrollHeight;
  }

  function setPhase(phase, text) {
    state.phase = phase;
    const dot = $('server-dot');
    dot.className = 'dot ' + phase;
    if (text) $('server-hint').textContent = text;
  }

  /* ------------------------------------------------------ адреса и «делиться» */

  /** Адрес, который стоит давать друзьям: первый не виртуальный IPv4. */
  function friendsAddress() {
    const list = state.addresses || [];
    const good = list.find((a) => !/^169\.254\./.test(a) && !/^127\./.test(a)) || list[0];
    return good ? `http://${good}:${state.port}` : null;
  }

  function renderAddresses() {
    const local = `http://127.0.0.1:${state.port}`;
    $('lan-addr').textContent = friendsAddress() || '—';
    $('local-addr').textContent = local;
    $('server-status').hidden = false;
  }

  function copyAddress() {
    const addr = friendsAddress() || `http://127.0.0.1:${state.port}`;
    const done = () => toast('Адрес скопирован: ' + addr, 3200);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(addr).then(done, () => toast('Не удалось скопировать'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = addr;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch { toast('Не удалось скопировать'); }
      ta.remove();
    }
  }

  function shareAddress() {
    const addr = friendsAddress();
    if (!addr) return;
    const text = `Подключайся к моему мессенджеру «Контур»: ${addr}`;
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else copyAddress();
  }

  /* ------------------------------------------------------------- запуск сервера */

  /** Открыть адрес внутри приложения (через наш плагин) или обычным переходом. */
  async function openUrl(url) {
    rememberAddress(url);
    if (APP && APP.navigate) {
      try { await APP.navigate({ url }); return; } catch (err) { logLine('переход: ' + err.message); }
    }
    window.location.href = url;
  }

  function rememberAddress(url) {
    try {
      const key = 'k.mobile.recent';
      const list = JSON.parse(localStorage.getItem(key) || '[]').filter((u) => u !== url);
      list.unshift(url);
      localStorage.setItem(key, JSON.stringify(list.slice(0, 4)));
    } catch { /* приватный режим — не страшно */ }
  }

  function renderRecent() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('k.mobile.recent') || '[]'); } catch {}
    if (!list.length) { $('recent').hidden = true; return; }
    $('recent').hidden = false;
    $('recent-chips').innerHTML = '';
    for (const url of list) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.textContent = url.replace(/^https?:\/\//, '');
      chip.onclick = () => openUrl(url);
      $('recent-chips').appendChild(chip);
    }
  }

  /** Ждём сообщение из Node.js: сервер сам скажет, когда поднялся. */
  function listenBridge() {
    if (!BRIDGE || !BRIDGE.addListener) return;
    state.listeners.push(BRIDGE.addListener('server-ready', (data) => {
      const payload = parsePayload(data);
      state.port = payload.port || state.port;
      state.addresses = payload.addresses || [];
      state.version = payload.version || state.version;
      clearTimeout(state.readyTimer);
      setPhase('ready', 'Сервер работает. Мессенджер уже открывается — если нет, нажмите «Открыть мессенджер».');
      $('btn-start').hidden = true;
      $('btn-open').hidden = false;
      $('btn-restart').hidden = false;
      $('btn-copy').hidden = false;
      $('btn-share').hidden = false;
      $('btn-keep').hidden = !(APP && APP.startBackground);
      $('ver').textContent = 'версия ' + state.version;
      renderAddresses();
      logLine(`сервер готов: порт ${state.port}, адреса: ${state.addresses.join(', ') || 'только локально'}`);
      keepAlive();
      setTimeout(() => openUrl(`http://127.0.0.1:${state.port}`), 350);
    }));
    state.listeners.push(BRIDGE.addListener('server-error', (data) => {
      const payload = parsePayload(data);
      clearTimeout(state.readyTimer);
      setPhase('error', payload.message || 'Сервер не запустился.');
      logLine('ошибка: ' + (payload.message || 'неизвестная'));
      $('btn-start').hidden = false;
      $('btn-start').textContent = '↻ Попробовать снова';
    }));
    state.listeners.push(BRIDGE.addListener('log', (data) => {
      const payload = parsePayload(data);
      if (payload.message) logLine(payload.message);
    }));
  }

  function parsePayload(data) {
    const raw = data && data.args && data.args.length ? data.args[0] : data;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { message: raw }; } }
    return raw || {};
  }

  /** Просим систему не выгружать сервер, пока приложение свёрнуто. */
  async function keepAlive() {
    if (!APP || !APP.startBackground) return;
    try {
      await APP.startBackground();
      logLine('приложение попросило Android держать сервер в фоне');
    } catch (err) {
      logLine('фоновая работа недоступна: ' + err.message);
    }
  }

  async function startServer() {
    if (state.phase === 'starting') return;
    setPhase('starting', 'Запускаю сервер… Первый запуск занимает несколько секунд.');
    $('btn-start').disabled = true;
    logLine('прошу движок Node.js запустить сервер');
    try {
      if (!BRIDGE || !BRIDGE.start) {
        throw new Error('Этот экран работает только в приложении «Контур» для Android');
      }
      await BRIDGE.start({ nodeDir: 'nodejs', script: 'mobile-server.js' });
      logLine('движок Node.js запущен, жду готовности сервера');
      state.readyTimer = setTimeout(() => {
        if (state.phase !== 'ready') {
          setPhase('error', 'Сервер не ответил за 30 секунд. Нажмите «Попробовать снова».');
          $('btn-start').hidden = false;
          $('btn-start').textContent = '↻ Попробовать снова';
        }
      }, 30000);
    } catch (err) {
      setPhase('error', err.message || 'Не удалось запустить сервер');
      logLine('ошибка запуска: ' + (err.message || err));
      $('btn-start').hidden = false;
      $('btn-start').textContent = '↻ Попробовать снова';
    } finally {
      $('btn-start').disabled = false;
    }
  }

  /* -------------------------------------------------------------- кнопки */

  $('btn-start').onclick = startServer;
  $('btn-open').onclick = () => openUrl(`http://127.0.0.1:${state.port}`);
  $('btn-restart').onclick = () => {
    toast('Закройте приложение полностью и откройте заново — сервер запустится со свежими данными');
  };
  $('btn-copy').onclick = copyAddress;
  $('btn-share').onclick = shareAddress;
  $('btn-keep').onclick = async () => {
    if (!APP) return;
    try { await APP.startBackground(); toast('Сервер будет работать, пока приложение в фоне'); }
    catch (err) { toast('Не удалось: ' + err.message); }
  };
  $('btn-connect').onclick = () => {
    const raw = $('addr').value.trim();
    if (!raw) { toast('Введите адрес сервера'); return; }
    const url = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
    try { new URL(url); } catch { toast('Адрес выглядит неправильно'); return; }
    openUrl(url.replace(/\/+$/, ''));
  };
  $('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-connect').click(); });
  $('btn-log-toggle').onclick = () => {
    const box = $('log');
    const hidden = box.style.display === 'none';
    box.style.display = hidden ? '' : 'none';
    $('btn-log-toggle').textContent = hidden ? 'свернуть' : 'развернуть';
  };
  $('gh').onclick = (e) => {
    e.preventDefault();
    const url = 'https://github.com/smells1k/kontur-messenger';
    if (APP && APP.openExternal) APP.openExternal({ url }); else window.open(url, '_blank');
  };

  /* -------------------------------------------------------------- старт */

  function init() {
    renderRecent();
    logLine('экран запуска открыт');
    if (!isAndroid) {
      logLine('это обычный браузер: сервер на телефоне здесь не запускается');
      setPhase('idle', 'Экран запуска Android-приложения. В браузере сервер не поднимается — запустите его на компьютере и введите адрес ниже.');
      $('btn-start').textContent = '▶ Запустить сервер (только в приложении)';
      $('btn-start').disabled = true;
      return;
    }
    listenBridge();
    // На телефоне сервер стартует сам, как только приложение открылось
    startServer();
  }

  // Разрешения на камеру и микрофон просим заранее — чтобы звонки работали сразу
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && APP && APP.requestMediaPermissions) {
      APP.requestMediaPermissions().catch(() => {});
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
