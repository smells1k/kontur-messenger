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
      // «Выключатель» сети: с __wsGate.blocked = true соединение открыть нельзя,
      // как будто пропал интернет. Нужен для проверки офлайн-очереди сообщений.
      window.__wsGate = { blocked: false };
      window.WebSocket = function (url) {
        if (!window.__wsGate.blocked) {
          const real = new WebSocketImpl(url);
          window.__lastWs = real;   // чтобы тест мог «оборвать кабель» прямо сейчас
          return real;
        }
        const stub = { readyState: 0, url, send() {}, close() {} };
        setTimeout(() => { try { if (stub.onclose) stub.onclose(new window.Event('close')); } catch { /* уже закрыт */ } }, 30);
        return stub;
      };
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

  console.log('\n— Клик по цитате ответа не должен дублировать сообщения —');
  const beforeJump = window.K.getList(group.id).length;
  const quoted = window.K.getList(group.id)[0];
  // отвечаем на первое сообщение, затем «прыгаем» по цитате несколько раз
  const replyId = window.K.postMessage(group.id, 'Ответ на первое сообщение', [], { replyTo: quoted.id });
  await sleep(600);
  window.K.openChat(group.id);
  await waitFor(() => $$('#messages-inner .msg').length > 0, 'лента после ответа');
  const quoteEl = $('#messages-inner .reply-quote');
  ok(!!quoteEl, 'цитата ответа отрисована');
  for (let i = 0; i < 3; i++) {
    window.K.loadContextAround(quoted.id);
    await sleep(350);
  }
  const afterJump = window.K.getList(group.id).length;
  ok(afterJump === beforeJump + 1, 'сообщения не дублируются после переходов по цитате', `${beforeJump} → ${afterJump}`);
  const ids = window.K.getList(group.id).map((m) => m.id);
  ok(new Set(ids).size === ids.length, 'в ленте нет повторов id');
  ok(!!replyId, 'сообщение-ответ отправлено');

  console.log('\n— Эмодзи-панель —');
  $('#btn-emoji').click();
  await sleep(300);
  const cells = $$('#emoji-grid .emoji-cell').length;
  ok(cells > 900, 'панель эмодзи отрисована', cells + ' эмодзи');
  // в наборе не должно быть «квадратиков»: ни ZWJ-составных, ни тонов кожи, ни флагов
  const allEmoji = window.EMOJI_CATEGORIES.flatMap((c) => c.items.map((i) => i.e));
  const bad = allEmoji.filter((e) => /\u200D/.test(e) || /[\u{1F3FB}-\u{1F3FF}]/u.test(e) || /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(e) || /\u20E3/.test(e) || [...e].length > 2);
  ok(bad.length === 0, 'в наборе нет составных/неподдерживаемых эмодзи (квадратиков)', bad.slice(0, 3).join(' ') || 'чисто');
  ok(window.EMOJI_CATEGORIES.every((c) => /[А-Яа-я]/.test(c.name)), 'категории подписаны по-русски',
    window.EMOJI_CATEGORIES.map((c) => c.name).slice(0, 3).join(', '));
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
  ok(!!$('#group-av-upload'), 'можно загрузить своё фото группы');
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

  console.log('\n— Панели не мешают друг другу —');
  window.K.toggleEmoji(true);
  await sleep(150);
  ok(!$('#emoji-panel').hidden && $('#panel').hidden, 'открыта только панель эмодзи');
  window.K.togglePanel(true);
  await sleep(150);
  ok($('#emoji-panel').hidden && !$('#panel').hidden, 'при открытии участников эмодзи закрылись (интерфейс не съезжает)');
  ok(window.document.querySelector('#app').classList.contains('with-panel'), 'класс with-panel выставлен верно');
  $('#btn-panel-close').click();

  console.log('\n— Настройки и тема —');
  $('#btn-profile').click();
  await sleep(400);
  ok(!$('#modal').hidden && $('#modal-box').textContent.includes('Настройки'), 'окно настроек открылось');
  ok(!!$('#d-mic') && !!$('#d-cam') && !!$('#d-out'), 'в настройках есть выбор микрофона, камеры и динамиков');
  ok(!!$('#d-test'), 'есть кнопка проверки микрофона');
  ok(!!$('#s-avatar-preview'), 'в профиле можно загрузить свой аватар');
  ok(!!$('#s-clear'), 'есть кнопка очистки локальных данных');
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

  console.log('\n— Версия и обновление —');
  ok(!!$('#stale-banner'), 'есть плашка «клиент устарел — обновите страницу»');
  ok(!!$('#auth-version'), 'на экране входа показана версия клиента');
  ok(!!$('script[src="/js/build-info.js"]'), 'страница подключает файл с версией сборки');
  ok($('#s-info').innerHTML.includes('Клиент: v'), 'в настройках видно версию клиента и сборку');
  ok(!!(window.KONTUR_BUILD && window.KONTUR_BUILD.version), 'в браузере известна версия клиента', window.KONTUR_BUILD && window.KONTUR_BUILD.version);

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

  console.log('\n— Офлайн: сообщение ждёт сети в очереди —');
  window.K.openChat(group.id);
  await sleep(200);
  window.__wsGate.blocked = true;            // «выдёргиваем кабель»: обрываем текущий сокет и запрещаем новые
  try { window.__lastWs && window.__lastWs.close(); } catch {}
  await sleep(400);
  const offlineText = 'Офлайн-сообщение ' + Math.random().toString(36).slice(2, 6);
  $('#input').value = offlineText;
  $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('#btn-send').click();
  await sleep(400);
  ok(window.K.S.outbox.some((p) => p.text === offlineText), 'сообщение без сети ушло в очередь, а не пропало');
  ok($('#offline-banner').hidden === false, 'показана плашка «нет соединения»');
  const waiting = $$('#messages-inner .msg.own').find((n) => n.textContent.includes(offlineText));
  ok(!!waiting, 'сообщение видно в ленте со статусом «отправляется»');

  window.__wsGate.blocked = false;           // сеть вернулась
  const delivered = await waitFor(async () => {
    const seen = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 200);
      const onMsg = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'message:new' && msg.payload.message.text === offlineText) { clearTimeout(timer); resolve(true); }
      };
      bws.on('message', onMsg);
      setTimeout(() => bws.off('message', onMsg), 300);
    });
    return seen || window.K.S.outbox.length === 0;
  }, 'отправка очереди после возврата сети', 15000);
  ok(!!delivered, 'после возврата сети отложенное сообщение уехало на сервер');
  ok(window.K.S.outbox.length === 0, 'очередь после отправки пуста');

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
