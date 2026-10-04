'use strict';
/**
 * Проверка веб-клиента «глазами браузера» (jsdom + живой сервер).
 * Запуск:  node test/client-smoke.js http://localhost:4200
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const WebSocketImpl = require('ws');

const BASE = process.argv[2] || 'http://localhost:4200';
const ok = (cond, label, extra) => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(120);
  }
  console.log(`   ⏱ таймаут: ${label}`);
  return null;
};

(async () => {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (err) => errors.push('jsdomError: ' + err.message));
  vc.on('error', (...args) => errors.push('console.error: ' + args.map(String).join(' ')));

  const dom = await JSDOM.fromURL(BASE + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // то, чего нет в jsdom, но есть в браузере
      window.fetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, BASE).href, init);
      window.WebSocket = function (url) { return new WebSocketImpl(url); };
      window.WebSocket.OPEN = 1;
      window.WebSocket.CONNECTING = 0;
      window.Element.prototype.scrollTo = function () {};
      window.Element.prototype.scrollIntoView = function () {};
      window.HTMLElement.prototype.scrollTo = function () {};
      window.URL.createObjectURL = () => 'blob:stub';
      window.navigator.vibrate = () => true;
    },
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);

  console.log('\n— Загрузка клиента —');
  await waitFor(() => window.K && window.K.S, 'инициализация скриптов');
  ok(!!window.K, 'app.js и call.js загрузились, объект K создан');
  ok(!!(window.EMOJI_CATEGORIES && window.EMOJI_CATEGORIES.length), 'данные эмодзи загружены',
    window.EMOJI_CATEGORIES ? window.EMOJI_CATEGORIES.length + ' категорий' : '');
  await waitFor(() => /на связи|недоступен/.test($('#server-status').textContent), 'ответ сервера о себе');
  const serverStatus = $('#server-status').textContent.includes('на связи');
  ok(serverStatus, 'клиент увидел сервер', $('#server-status') && $('#server-status').textContent);

  console.log('\n— Демо-вход —');
  await waitFor(() => window.K && window.K.S && typeof window.K.api === 'function', 'готовность интерфейса');
  await sleep(200);
  $('#btn-demo').click();
  const loggedIn = await waitFor(() => !$('#app').hidden, 'вход в приложение', 10000);
  ok(!!loggedIn, 'вход выполнен, приложение открылось');
  await waitFor(() => window.K.S.chats.size > 0, 'список чатов');
  ok(window.K.S.chats.size >= 2, 'чаты загружены с сервера', window.K.S.chats.size + ' шт. (у демо-аккаунтов 2–5, зависит от того, кто вошёл)');
  const listItems = window.document.querySelectorAll('#chat-list .chat-item');
  ok(listItems.length >= 2, 'список чатов отрисован', listItems.length + ' элементов');
  ok(!!window.K.S.me && !!window.K.S.me.displayName, 'профиль пользователя получен', window.K.S.me && window.K.S.me.displayName);

  console.log('\n— Открытие чата и история —');
  const groups = [...window.K.S.chats.values()].filter((c) => c.type === 'group');
  ok(groups.length >= 1, 'демо-группы присутствуют', groups.map((g) => g.title).join(' / '));
  const demoChat = groups.find((c) => c.title.includes('Общий')) || groups[0];
  listItems[0].click();
  await waitFor(() => window.K.S.activeId, 'выбран чат');
  window.K.openChat(demoChat.id);
  const rendered = await waitFor(() => window.document.querySelectorAll('#messages-inner .msg').length > 0, 'сообщения');
  ok(!!rendered, 'история сообщений отрисована', window.document.querySelectorAll('#messages-inner .msg').length + ' сообщений');
  ok(window.document.querySelectorAll('.day-sep').length > 0, 'разделители дат есть');
  const reactions = window.document.querySelectorAll('#messages-inner .reaction');
  ok(reactions.length > 0, 'реакции из демо-данных отрисованы', reactions.length + ' реакций');
  const fileAtt = window.document.querySelector('#messages-inner .att-file');
  ok(!!fileAtt, 'вложение-файл показано', fileAtt && fileAtt.textContent.trim().slice(0, 40));
  const header = $('#chat-name') && $('#chat-name').textContent;
  ok(header === demoChat.title, 'заголовок чата верный', header);

  console.log('\n— Отправка сообщения —');
  const before = window.document.querySelectorAll('#messages-inner .msg').length;
  const text = 'Проверка из jsdom ' + Math.random().toString(36).slice(2, 6);
  $('#input').value = text;
  $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#btn-send').click();
  const bubble = await waitFor(() => [...window.document.querySelectorAll('#messages-inner .msg.own')]
    .find((n) => n.textContent.includes(text)), 'своё сообщение', 8000);
  ok(!!bubble, 'сообщение отправлено и появилось в ленте');
  await sleep(500);
  const sent = window.K.getList(demoChat.id).filter((m) => m.text === text);
  ok(sent.length === 1 && !sent[0].pending, 'сообщение подтверждено сервером (ack)');
  const after = window.document.querySelectorAll('#messages-inner .msg').length;
  ok(after >= before, 'лента не потеряла сообщения', `${before} → ${after}`);

  console.log('\n— Бот —');
  const botChat = [...window.K.S.chats.values()].find((c) => c.members.some((m) => m.isBot));
  if (botChat) {
    window.K.openChat(botChat.id);
    await sleep(600);
    $('#input').value = '/help';
    $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));
    $('#btn-send').click();
    const reply = await waitFor(() => [...window.document.querySelectorAll('#messages-inner .msg:not(.own)')]
      .find((n) => !n.classList.contains('msg-system') && /бот|help|команд/i.test(n.textContent)), 'ответ бота', 9000);
    ok(!!reply, 'бот отвечает на /help');
  } else ok(false, 'чат с ботом найден');

  console.log('\n— Эмодзи-панель —');
  $('#btn-emoji').click();
  await sleep(300);
  const cells = window.document.querySelectorAll('#emoji-grid .emoji-cell');
  ok(cells.length > 1500, 'панель эмодзи отрисована', cells.length + ' эмодзи');
  const searchInput = $('#emoji-q');
  searchInput.value = 'heart';
  searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => window.document.querySelectorAll('#emoji-grid .emoji-cell').length < cells.length && window.document.querySelectorAll('#emoji-grid .emoji-cell').length > 0, 'поиск эмодзи');
  const found = window.document.querySelectorAll('#emoji-grid .emoji-cell').length;
  ok(found > 0 && found < cells.length, 'поиск эмодзи работает', found + ' совпадений на «heart»');
  if (found) {
    const first = window.document.querySelector('#emoji-grid .emoji-cell');
    const before2 = $('#input').value;
    first.click();
    ok($('#input').value !== before2 && $('#input').value.length > before2.length, 'эмодзи вставляется в поле ввода', JSON.stringify($('#input').value.slice(-2)));
  }
  $('#btn-emoji-close').click();

  console.log('\n— Панель участников и группы —');
  window.K.openChat(demoChat.id);
  await sleep(300);
  $('#btn-panel').click();
  await sleep(300);
  const memberRows = window.document.querySelectorAll('#panel-body .member-row');
  ok(!$('#panel').hidden && memberRows.length >= 3, 'панель участников открывается', memberRows.length + ' участников');
  ok(window.document.querySelectorAll('#panel-body .emoji-av-row button').length >= 8, 'выбор аватара группы доступен');
  $('#btn-panel-close').click();

  console.log('\n— Поиск по чатам и фильтры —');
  $('#search').value = 'общий';
  $('#search').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(200);
  const filtered = window.document.querySelectorAll('#chat-list .chat-item');
  ok(filtered.length >= 1 && filtered.length < listItems.length, 'поиск по чатам фильтрует список', filtered.length + ' найдено');
  $('#search').value = '';
  $('#search').dispatchEvent(new window.Event('input', { bubbles: true }));
  const groupCount = [...window.K.S.chats.values()].filter((c) => c.type === 'group').length;
  window.document.querySelector('#chat-filter .chip[data-filter="groups"]').click();
  await sleep(250);
  const shownGroups = window.document.querySelectorAll('#chat-list .chat-item').length;
  ok(shownGroups === groupCount && groupCount >= 1, 'фильтр «Группы» показывает ровно группы', `${shownGroups} из ${groupCount}`);
  window.document.querySelector('#chat-filter .chip[data-filter="all"]').click();

  console.log('\n— Настройки и переключение темы —');
  $('#btn-profile').click();
  await sleep(400);
  ok(!$('#modal').hidden && $('#modal-box').textContent.includes('Настройки'), 'окно настроек открылось');
  const themeSwitch = $('#s-theme');
  themeSwitch.checked = false;
  themeSwitch.dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(200);
  ok(window.document.documentElement.dataset.theme === 'light', 'тёмная/светлая тема переключается', window.document.documentElement.dataset.theme);
  themeSwitch.checked = true;
  themeSwitch.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(window.document.documentElement.dataset.theme === 'dark', 'тема возвращается в тёмную');
  window.K.S.settings.theme = 'dark';
  window.localStorage.setItem('k.settings', JSON.stringify(window.K.S.settings));

  console.log('\n— Модуль звонков —');
  ok(!!(window.K.calls && window.K.calls.start), 'модуль звонков подключён');
  const callModule = require('fs').readFileSync(__dirname + '/../../web/js/call.js', 'utf8');
  ok(/RTCPeerConnection/.test(callModule) && /getDisplayMedia/.test(callModule), 'в клиенте есть WebRTC и демонстрация экрана');
  ok(/captureStream/.test(callModule), 'есть обработка видео для эффектов');

  console.log('\n— Ошибки в консоли —');
  const realErrors = errors.filter((e) => !/Not implemented|Could not load img|css|stylesheet/i.test(e));
  ok(realErrors.length === 0, 'JavaScript без ошибок', realErrors.slice(0, 3).join(' | ') || 'чисто');

  window.close();
  console.log('\n' + (process.exitCode ? '❌ Есть падения — см. выше' : '✅ Клиент работает: вход, чаты, история, отправка, бот, эмодзи, панели, поиск, темы'));
  setTimeout(() => process.exit(process.exitCode || 0), 400);
})().catch((err) => { console.error('\n💥 Тест клиента упал:', err.stack); process.exit(1); });
