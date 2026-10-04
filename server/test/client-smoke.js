'use strict';
/**
 * Проверка веб-клиента «глазами браузера» (jsdom + живой сервер).
 * Тест самодостаточный: сам регистрирует двух пользователей, создаёт группу,
 * историю и вложение — поэтому работает и в обычном режиме, и с флагом --demo.
 *
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
const skip = (label) => console.log(`➖ пропущено: ${label}`);
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

async function rest(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status });
  return data;
}

(async () => {
  /* ---------------------------------------------------- подготовка на сервере */
  console.log('\n— Подготовка данных на сервере —');
  const info = await rest('/server/info');
  const demoEnabled = !!info.demoMode;
  console.log(`   режим сервера: ${demoEnabled ? 'демо (--demo)' : 'обычный (без демо-данных)'}`);

  const tag = Math.random().toString(36).slice(2, 7);
  const A = await rest('/auth/register', { method: 'POST', body: { username: 'ui_a_' + tag, displayName: 'Аня Тест', password: 'pass1234' } });
  const B = await rest('/auth/register', { method: 'POST', body: { username: 'ui_b_' + tag, displayName: 'Борис Тест', password: 'pass1234' } });
  ok(!!A.token && !!B.token, 'два тестовых пользователя созданы', `@${A.user.username}, @${B.user.username}`);

  const emptyChats = await rest('/chats', { token: A.token });
  ok(emptyChats.chats.length === 0, 'у нового пользователя нет чужих чатов', emptyChats.chats.length + ' чатов');

  const group = (await rest('/chats/group', { method: 'POST', token: A.token, body: { title: 'Тест-группа 🧪', memberIds: [B.user.id] } })).chat;
  const direct = (await rest('/chats/direct', { method: 'POST', token: A.token, body: { userId: B.user.id } })).chat;
  ok(group.type === 'group' && direct.type === 'direct', 'созданы группа и личный чат для проверки интерфейса');

  const fileRes = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('история.txt'), Authorization: 'Bearer ' + A.token },
    body: Buffer.from('файл для проверки отображения вложений'),
  });
  const file = (await fileRes.json()).file;
  await rest(`/chats/${group.id}/messages`, {
    method: 'POST', token: A.token,
    body: { text: 'Привет, это история 🚀', attachments: [Object.assign({ kind: 'file' }, file)] },
  });
  ok(!!file.url, 'загружен файл и отправлено сообщение с вложением');

  /* ------------------------------------------------------ сторона второго клиента */
  const bws = new WebSocketImpl(BASE.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(B.token));
  await new Promise((resolve) => bws.on('open', resolve));
  const bSend = (type, payload) => bws.send(JSON.stringify({ type, payload }));

  /* ------------------------------------------------------------------ браузер */
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
      window.fetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, BASE).href, init);
      window.WebSocket = function (url) { return new WebSocketImpl(url); };
      window.WebSocket.OPEN = 1;
      window.WebSocket.CONNECTING = 0;
      window.Element.prototype.scrollTo = function () {};
      window.Element.prototype.scrollIntoView = function () {};
      window.HTMLElement.prototype.scrollTo = function () {};
      window.URL.createObjectURL = () => 'blob:stub';
      window.navigator.vibrate = () => true;
      window.localStorage.setItem('k.token', A.token);      // входим под первым тестовым пользователем
    },
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];

  console.log('\n— Загрузка клиента —');
  await waitFor(() => window.K && window.K.S, 'инициализация скриптов');
  ok(!!window.K, 'app.js и call.js загрузились');
  ok(!!(window.EMOJI_CATEGORIES && window.EMOJI_CATEGORIES.length), 'данные эмодзи загружены',
    window.EMOJI_CATEGORIES ? window.EMOJI_CATEGORIES.length + ' категорий' : '');

  console.log('\n— Вход с сохранённой сессией —');
  const booted = await waitFor(() => !$('#app').hidden, 'вход в приложение', 10000);
  ok(!!booted, 'сессия подхватилась, приложение открылось');
  ok(window.K.S.demoMode === demoEnabled, `клиент знает режим сервера (${demoEnabled ? 'демо' : 'обычный'})`);
  if (!demoEnabled) {
    ok($('#demo-block').hidden === true, 'блок «Демо-вход» скрыт на странице входа');
    ok($('#demo-hint').hidden === true, 'подсказка про демо-аккаунты не показывается');
  } else {
    skip('скрытие демо-блока (сервер в демо-режиме)');
  }

  await waitFor(() => window.K.S.chats.size >= 2, 'загрузка чатов');
  ok(window.K.S.chats.size === 2, 'загружены ровно мои чаты (без посторонних)', window.K.S.chats.size + ' шт.');
  const titles = $$('#chat-list .chat-item').map((n) => n.textContent);
  ok(titles.some((t) => t.includes('Тест-группа')), 'группа видна в списке чатов');
  ok(titles.some((t) => t.includes('Борис Тест')), 'личный чат виден в списке');
  if (!demoEnabled) {
    const noDemo = !titles.some((t) => /Общий чат|Команда проекта|Аня Орлова|Вера Соколова|Глеб/.test(t));
    ok(noDemo, 'демо-чаты и демо-люди в списке отсутствуют');
  }

  console.log('\n— История и вложение —');
  window.K.openChat(group.id);
  await waitFor(() => $$('#messages-inner .msg').length > 0, 'сообщения');
  ok($$('#messages-inner .msg').length >= 1, 'история отрисована', $$('#messages-inner .msg').length + ' сообщений');
  const att = $('#messages-inner .att-file');
  ok(!!att, 'вложение-файл отображается', att && att.textContent.replace(/\s+/g, ' ').trim().slice(0, 50));
  ok($('#chat-name').textContent === 'Тест-группа 🧪', 'заголовок чата верный', $('#chat-name').textContent);

  console.log('\n— Отправка сообщения —');
  const text = 'Проверка из jsdom ' + Math.random().toString(36).slice(2, 6);
  $('#input').value = text;
  $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#btn-send').click();
  const bubble = await waitFor(() => $$('#messages-inner .msg.own').find((n) => n.textContent.includes(text)), 'своё сообщение');
  ok(!!bubble, 'сообщение отправлено и появилось в ленте');
  await sleep(500);
  const sent = window.K.getList(group.id).filter((m) => m.text === text);
  ok(sent.length === 1 && !sent[0].pending, 'сообщение подтверждено сервером (ack)');

  console.log('\n— Синхронизация: пишет другой пользователь —');
  const fromB = 'Ответ от Бориса ' + Math.random().toString(36).slice(2, 5);
  bSend('message:send', { chatId: group.id, text: fromB, clientId: 'b1' });
  const incoming = await waitFor(() => $$('#messages-inner .msg').find((n) => n.textContent.includes(fromB)), 'сообщение от второго клиента');
  ok(!!incoming, 'сообщение другого пользователя доехало до браузера (WebSocket)');
  bSend('typing', { chatId: group.id, state: true });
  const typingShown = await waitFor(() => /печатает/.test($('#chat-sub').textContent + $('#typing-line').textContent), 'индикатор печати');
  ok(!!typingShown, 'индикатор «печатает…» работает');

  console.log('\n— Реакции —');
  const targetId = window.K.getList(group.id).find((m) => m.text === text).id;
  window.__konturSend({ type: 'message:react', payload: { id: targetId, emoji: '🔥' } });
  const reacted = await waitFor(() => $$('#messages-inner .reaction').find((r) => r.textContent.includes('🔥')), 'реакция');
  ok(!!reacted, 'реакция появилась и синхронизировалась');

  console.log('\n— Эмодзи-панель —');
  $('#btn-emoji').click();
  await sleep(300);
  const cells = $$('#emoji-grid .emoji-cell').length;
  ok(cells > 1500, 'панель эмодзи отрисована', cells + ' эмодзи');
  const q = $('#emoji-q');
  q.value = 'heart';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => $$('#emoji-grid .emoji-cell').length > 0 && $$('#emoji-grid .emoji-cell').length < cells, 'поиск эмодзи');
  const found = $$('#emoji-grid .emoji-cell').length;
  ok(found > 0 && found < cells, 'поиск эмодзи работает', found + ' совпадений на «heart»');
  const before = $('#input').value;
  $('#emoji-grid .emoji-cell').click();
  ok($('#input').value.length > before.length, 'эмодзи вставляется в поле ввода', JSON.stringify($('#input').value.slice(-2)));
  $('#btn-emoji-close').click();

  console.log('\n— Панель участников —');
  window.K.openChat(group.id);
  await sleep(300);
  $('#btn-panel').click();
  await sleep(300);
  ok(!$('#panel').hidden && $$('#panel-body .member-row').length === 2, 'панель участников: только мои двое',
    $$('#panel-body .member-row').length + ' участников');
  ok($$('#panel-body .emoji-av-row button').length >= 8, 'смена аватара группы доступна');
  $('#btn-panel-close').click();

  console.log('\n— Поиск и фильтры —');
  $('#search').value = 'группа';
  $('#search').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(200);
  ok($$('#chat-list .chat-item').length === 1, 'поиск по чатам фильтрует список', $$('#chat-list .chat-item').length + ' найдено на «группа»');
  $('#search').value = '';
  $('#search').dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.querySelector('#chat-filter .chip[data-filter="groups"]').click();
  await sleep(250);
  ok($$('#chat-list .chat-item').length === 1, 'фильтр «Группы» показывает ровно группу');
  window.document.querySelector('#chat-filter .chip[data-filter="all"]').click();

  console.log('\n— Настройки и тема —');
  $('#btn-profile').click();
  await sleep(400);
  ok(!$('#modal').hidden && $('#modal-box').textContent.includes('Настройки'), 'окно настроек открылось');
  const theme = $('#s-theme');
  theme.checked = false;
  theme.dispatchEvent(new window.Event('click', { bubbles: true }));
  await sleep(150);
  ok(window.document.documentElement.dataset.theme === 'light', 'тема переключается на светлую');
  theme.checked = true;
  theme.dispatchEvent(new window.Event('click', { bubbles: true }));
  ok(window.document.documentElement.dataset.theme === 'dark', 'тема возвращается в тёмную');
  window.K.S.settings.theme = 'dark';
  window.localStorage.setItem('k.settings', JSON.stringify(window.K.S.settings));

  console.log('\n— Звонки —');
  ok(!!(window.K.calls && window.K.calls.start), 'модуль звонков подключён');
  const callSrc = require('fs').readFileSync(__dirname + '/../../web/js/call.js', 'utf8');
  ok(/RTCPeerConnection/.test(callSrc) && /getDisplayMedia/.test(callSrc) && /captureStream/.test(callSrc),
    'в клиенте есть WebRTC, демонстрация экрана и эффекты');

  if (demoEnabled) {
    console.log('\n— Бот (только в демо-режиме) —');
    const botChat = [...window.K.S.chats.values()].find((c) => c.members.some((m) => m.isBot));
    if (botChat) {
      window.K.openChat(botChat.id);
      await sleep(500);
      $('#input').value = '/help';
      $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));
      $('#btn-send').click();
      const reply = await waitFor(() => $$('#messages-inner .msg:not(.own)').find((n) => /бот|команд/i.test(n.textContent)), 'ответ бота', 9000);
      ok(!!reply, 'бот отвечает на /help');
    } else skip('чат с ботом не найден у этого аккаунта');
  } else {
    skip('проверка бота — в обычном режиме бота нет (так и задумано)');
  }

  console.log('\n— Ошибки в консоли —');
  const real = errors.filter((e) => !/Not implemented|Could not load img|stylesheet/i.test(e));
  ok(real.length === 0, 'JavaScript без ошибок', real.slice(0, 3).join(' | ') || 'чисто');

  console.log('\n' + (process.exitCode ? '❌ Есть падения — см. выше' : '✅ Клиент работает на чистом сервере: вход, чаты, история, отправка, синхронизация, реакции, эмодзи, панели, поиск, темы'));

  // аккуратное завершение: сначала закрываем сокеты приложения, потом окно,
  // иначе события WebSocket прилетят в уже уничтоженный jsdom
  bws.close();
  try { window.dispatchEvent(new window.Event('beforeunload')); } catch {}
  await sleep(400);
  try { window.close(); } catch {}
  await sleep(200);
  process.exit(process.exitCode || 0);
})().catch((err) => { console.error('\n💥 Тест клиента упал:', err.stack); process.exit(1); });
