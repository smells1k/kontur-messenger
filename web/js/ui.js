/* ==========================================================================
   Мессенджер «Контур» — слой интерфейса (телефон и ПК).

   Отвечает за то, что зависит от устройства, а не от логики мессенджера:
     • телефон: чат «выезжает» поверх списка, кнопка/жест «назад», шторки снизу,
                долгое нажатие по сообщению вместо правой кнопки мыши,
                клавиатура (композер не уезжает под неё);
     • ПК:     привычные три колонки, наведение мыши, горячие клавиши;
     • установка как приложение (PWA) и работа внутри Android-приложения
       «Контур» (фоновая служба, разрешения камеры, адрес сервера-телефона).
   ========================================================================== */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const MOBILE_MAX = 899;                 // до этой ширины — телефонный макет
  const mq = (() => {
    try { return window.matchMedia(`(max-width: ${MOBILE_MAX}px)`); }
    catch { return { matches: false, addEventListener() {} }; }   // старые браузеры и тесты
  })();
  const isMobile = () => mq.matches;

  /* Внутри Android-приложения? Лаунчер добавляет ?app=1, Capacitor — свой мост. */
  const params = new URLSearchParams(location.search);
  const CAP = window.Capacitor || null;
  const PLUGIN = (CAP && CAP.Plugins && CAP.Plugins.KonturApp) || null;
  const IN_APP = params.has('app') || !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());

  const state = { pushed: false, ignorePop: false, paneOpen: false, wakeLock: null, longPress: null };

  function app() { return $('#app'); }
  function hasChatOpen() { const a = app(); return !!(a && a.classList.contains('chat-open')); }

  /* ==================================================== 1. Окна поверх чата */

  /** Закрывает самый верхний слой (окно, меню, шторка). true — что-то закрыли. */
  function closeTopLayer() {
    for (const sel of ['#context-menu', '#lightbox', '#history-overlay', '#modal']) {
      const el = $(sel);
      if (el && !el.hidden) {
        el.hidden = true;
        if (sel === '#modal') $('#modal-box').innerHTML = '';
        const ov = $('#menu-overlay');
        if (ov && sel === '#context-menu') ov.hidden = true;
        return true;
      }
    }
    if (window.K) {
      const panel = $('#panel');
      const emoji = $('#emoji-panel');
      if (panel && !panel.hidden) { K.togglePanel(false); return true; }
      if (emoji && !emoji.hidden) { K.toggleEmoji(false); return true; }
    }
    return false;
  }

  /* ============================================ 2. «Назад»: кнопка и свайп */

  /* На телефоне открытый чат — отдельный «экран», поэтому он добавляет запись
     в историю браузера: системная кнопка «назад» возвращает к списку чатов. */
  function watchPane() {
    const node = app();
    if (!node) return;
    const sync = () => {
      const open = node.classList.contains('chat-open');
      if (open === state.paneOpen) return;
      state.paneOpen = open;
      if (!isMobile()) return;
      if (open && !state.pushed) {
        state.pushed = true;
        try { history.pushState({ kontur: 'chat' }, ''); } catch { /* file:// */ }
      } else if (!open && state.pushed) {
        state.pushed = false;
        state.ignorePop = true;
        try { history.back(); } catch { /* ничего */ }
      }
    };
    new MutationObserver(sync).observe(node, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  window.addEventListener('popstate', () => {
    if (state.ignorePop) { state.ignorePop = false; return; }
    if (closeTopLayer()) return;
    if (hasChatOpen()) $('#btn-back').click();
  });

  /* Свайп от левого края вправо — «назад» к списку чатов. */
  function bindSwipeBack() {
    const chat = $('#chat');
    if (!chat) return;
    let startX = 0, startY = 0, tracking = false;
    chat.addEventListener('touchstart', (e) => {
      if (!isMobile() || e.touches.length !== 1) return;
      const t = e.touches[0];
      tracking = t.clientX <= 32;          // начинаем только от самого края
      startX = t.clientX; startY = t.clientY;
    }, { passive: true });
    chat.addEventListener('touchmove', (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dy > 60) { tracking = false; return; }
      if (dx > 70) { tracking = false; closeTopLayer(); if (hasChatOpen()) $('#btn-back').click(); }
    }, { passive: true });
    chat.addEventListener('touchend', () => { tracking = false; }, { passive: true });
  }

  /* ================================================= 3. Долгое нажатие (телефон) */

  /* На телефоне правой кнопки нет: меню сообщения показываем по долгому тапу. */
  function bindLongPress() {
    const box = $('#messages');
    if (!box) return;
    const clear = () => { clearTimeout(state.longPress); state.longPress = null; };

    box.addEventListener('touchstart', (e) => {
      const node = e.target.closest('[data-msg]');
      if (!node || e.touches.length !== 1) return;
      const touch = e.touches[0];
      state.longPress = setTimeout(() => {
        hideActions();
        node.classList.add('show-actions');
        if (navigator.vibrate) navigator.vibrate(12);
      }, 460);
      // сдвиг пальца отменяет долгий тап (значит, это прокрутка)
      const cancelOnMove = (ev) => {
        const t = ev.touches[0];
        if (Math.abs(t.clientX - touch.clientX) > 12 || Math.abs(t.clientY - touch.clientY) > 12) {
          clear();
          box.removeEventListener('touchmove', cancelOnMove);
        }
      };
      box.addEventListener('touchmove', cancelOnMove, { passive: true });
    }, { passive: true });

    ['touchend', 'touchcancel', 'touchmove'].forEach((ev) => box.addEventListener(ev, clear, { passive: true }));

    /* Палец ушёл в другое место — плашку убираем (но не мешаем нажимать её кнопки). */
    document.addEventListener('touchstart', (e) => {
      if (!e.target.closest('.msg-actions') && !e.target.closest('[data-msg]')) hideActions();
    }, { passive: true, capture: true });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.msg-actions') && !e.target.closest('[data-msg]')) hideActions();
    });
  }

  function hideActions() { $$('.msg.show-actions').forEach((n) => n.classList.remove('show-actions')); }

  /* ============================================ 4. Клавиатура телефона */

  /* Экранная клавиатура уменьшает видимую область. Узнаём её высоту и поднимаем
     композер, чтобы поле ввода и кнопка «отправить» оставались на виду. */
  function bindKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      if (!isMobile()) {
        document.body.classList.remove('kb-open');
        document.documentElement.style.setProperty('--kb', '0px');
        return;
      }
      const hidden = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
      const open = hidden > 90 && document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      document.body.classList.toggle('kb-open', open);
      document.documentElement.style.setProperty('--kb', open ? hidden + 'px' : '0px');
      if (open && window.K && K.S && K.S.activeId) K.scrollToBottom(false);
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    document.addEventListener('focusin', () => setTimeout(apply, 60));
    document.addEventListener('focusout', () => setTimeout(apply, 60));
  }

  /* ============================================ 5. Адрес сервера на телефоне */

  /* Телефон сам является сервером: друзьям нужен адрес в сети Wi-Fi.
     Показываем его, даём скопировать или отправить в мессенджер/СМС. */
  async function showShareSheet() {
    const port = location.port || '4000';
    const scheme = location.protocol === 'https:' ? 'https:' : 'http:';
    let entries = [];
    try {
      const res = await fetch('/health', { cache: 'no-store' });
      const data = await res.json();
      entries = (data.lan || []).filter((a) => !a.virtual);
    } catch { /* нет связи — покажем хотя бы локальный адрес */ }

    const list = entries.length
      ? entries.map((a) => `${scheme}//${a.address}:${port}`)
      : [location.origin];
    const best = list[0];

    document.getElementById('modal-box').innerHTML = `
      <div class="modal-head"><h3>📡 Адрес этого сервера</h3><button class="icon-btn tiny" id="ui-share-close">✕</button></div>
      <div class="modal-body">
        <div class="server-card">
          <div class="sc-title">🔗 Для друзей в той же сети Wi-Fi</div>
          <div class="sc-addr">${best}</div>
          <div class="sc-hint">${entries.length ? 'Адаптер: ' + entries.map((a) => a.name).join(', ') : 'Обычно это адрес Wi-Fi — он виден, когда телефон в сети.'}</div>
        </div>
        ${list.length > 1 ? `<p class="muted-text">Другие адреса: ${list.slice(1).map((u) => `<code>${u}</code>`).join(' ')}</p>` : ''}
        <p class="muted-text">Другу достаточно открыть этот адрес в браузере или вставить его в приложении «Контур» на экране запуска.<br>
        Интернет-адреса у телефона нет: чтобы писали из другой сети, запустите сервер на компьютере с ключом <code>--tunnel</code>.</p>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="ui-share-copy">Скопировать</button>
        <button class="btn primary" id="ui-share-send">Поделиться</button>
      </div>`;
    $('#modal').hidden = false;

    const close = () => { $('#modal').hidden = true; $('#modal-box').innerHTML = ''; };
    $('#ui-share-close').onclick = close;
    $('#ui-share-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(best); toast('Адрес скопирован'); } catch { toast('Не удалось скопировать', 'err'); }
    };
    $('#ui-share-send').onclick = async () => {
      const text = `Подключайся к моему мессенджеру «Контур»: ${best}`;
      try {
        if (navigator.share) { await navigator.share({ text }); close(); }
        else { await navigator.clipboard.writeText(best); toast('Адрес скопирован'); }
      } catch { /* пользователь отменил */ }
    };
  }

  function toast(text, kind) {
    if (window.K && K.toast) K.toast(text, kind);
    else console.log(text);
  }

  /* ============================================ 6. Место в Android-приложении */

  function bindNativeApp() {
    if (IN_APP) document.documentElement.classList.add('app-mode');
    if (!PLUGIN) return;

    // Держим сервер живым, пока приложение свёрнуто (фоновая служба Android)
    const keepAlive = () => { try { PLUGIN.startBackground(); } catch { /* не критично */ } };
    keepAlive();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAlive(); });

    // Разрешения камеры и микрофона — заранее, чтобы звонок начинался сразу
    const askMedia = () => { try { PLUGIN.requestMediaPermissions(); } catch { /* спросим при звонке */ } };
    $('#btn-call-audio')?.addEventListener('click', askMedia, true);
    $('#btn-call-video')?.addEventListener('click', askMedia, true);

    // Внешние ссылки — в обычный браузер, а не внутрь приложения
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.bubble-text a, .modal-body a, .auth-card a');
      if (!link) return;
      const href = link.getAttribute('href') || '';
      if (!/^https?:/i.test(href) || href.includes(location.host)) return;
      e.preventDefault();
      try { PLUGIN.openExternal({ url: href }); } catch { window.open(href, '_blank'); }
    });
  }

  /* ============================================ 7. Установка как приложение */

  function bindPWA() {
    // Офлайн-оболочка: страница открывается даже без сервера (сообщения — отдельно)
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; });
    window.addEventListener('appinstalled', () => { toast('Приложение установлено 📲', 'ok'); });

    const standalone = (() => {
      try { return window.matchMedia('(display-mode: standalone)').matches; } catch { return false; }
    })() || navigator.standalone;
    if (IN_APP || standalone) return;

    /* Кнопку «Установить» подкладываем в окно настроек — оно собирается в app.js. */
    const modal = $('#modal-box');
    if (!modal) return;
    new MutationObserver(() => {
      if ($('#ui-install')) return;
      const foot = modal.querySelector('.modal-foot');
      const body = modal.querySelector('.modal-body');
      const host = foot || body;
      if (!host || host.querySelector('#ui-install')) return;
      if (!/Настройки|Звук и видео|О сборке/.test(body ? body.textContent : '')) return;
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.id = 'ui-install';
      btn.textContent = '📲 Установить приложение';
      btn.onclick = async () => {
        if (deferred) { deferred.prompt(); deferred = null; return; }
        if (navigator.share) { navigator.share({ url: location.href }).catch(() => {}); return; }
        toast('В меню браузера выберите «Установить приложение»');
      };
      host.appendChild(btn);
    }).observe(modal, { childList: true, subtree: true });
  }

  /* ============================================ 8. Экран не гаснет во время звонка */

  function bindWakeLock() {
    const screen = $('#call-screen');
    if (!screen || !('wakeLock' in navigator)) return;
    const sync = async () => {
      try {
        if (!screen.hidden && !state.wakeLock) {
          state.wakeLock = await navigator.wakeLock.request('screen');
          state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
        } else if (screen.hidden && state.wakeLock) {
          await state.wakeLock.release();
          state.wakeLock = null;
        }
      } catch { /* не поддерживается — не страшно */ }
    };
    new MutationObserver(sync).observe(screen, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  }

  /* ============================================ 9. Мелочи для удобства */

  function bindComfort() {
    /* Телефон: при открытии чата не даём странице «прыгнуть» при появлении клавиатуры */
    $('#input')?.addEventListener('focus', () => {
      if (!isMobile()) return;
      setTimeout(() => { if (window.K && K.S && K.S.activeId) K.scrollToBottom(false); }, 250);
    });

    /* Телефон: двойной тап по шапке чата — к последнему сообщению */
    let lastTap = 0;
    $('.chat-head')?.addEventListener('touchend', () => {
      const now = Date.now();
      if (now - lastTap < 320 && window.K) K.scrollToBottom(true);
      lastTap = now;
    }, { passive: true });

    /* ПК: Ctrl/Cmd+K — к поиску, Alt+← — к списку чатов */
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        $('#search').focus();
      }
      if (e.altKey && e.key === 'ArrowLeft' && hasChatOpen()) { e.preventDefault(); $('#btn-back').click(); }
    });

    /* Все ссылки в сообщениях открываются в новой вкладке (на ПК — привычно) */
    $('#messages')?.addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (link) link.target = '_blank';
    });

    if (isMobile()) document.documentElement.classList.add('is-mobile');
    mq.addEventListener?.('change', () => {
      document.documentElement.classList.toggle('is-mobile', isMobile());
      if (!isMobile()) {
        document.body.classList.remove('kb-open');
        document.documentElement.style.setProperty('--kb', '0px');
      }
    });
  }

  /* =============================================================== запуск */

  function init() {
    if (!$('#app')) return;
    watchPane();
    bindSwipeBack();
    bindLongPress();
    bindKeyboard();
    bindNativeApp();
    bindPWA();
    bindWakeLock();
    bindComfort();
    $('#btn-share-server')?.addEventListener('click', showShareSheet);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* Немного пользы для отладки: KUI.isMobile() в консоли */
  window.KUI = { isMobile, closeTopLayer, showShareSheet, inApp: () => IN_APP };
})();
