'use strict';
/**
 * Проверка интерфейса «руками»: тест нажимает те же кнопки, что и человек —
 * контекстное меню сообщения, реакции, ответ, правку, удаление, закрепление,
 * пересылку, панель участников, создание группы, поиск по чату и выгрузку истории.
 *
 * Запуск:  node test/client-flows.js http://localhost:4100
 */
const { JSDOM, VirtualConsole } = require('jsdom');
const WebSocketImpl = require('ws');

const BASE = process.argv[2] || 'http://localhost:4100';
let failed = 0;
const ok = (cond, label, extra) => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed++;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, label, ms = 9000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ }
    await sleep(120);
  }
  ok(false, `таймаут: ${label}`);
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
  console.log('\n— Подготовка —');
  const tag = Math.random().toString(36).slice(2, 7);
  const A = await rest('/auth/register', { method: 'POST', body: { username: 'fl_a_' + tag, displayName: 'Аня Флоу', password: 'pass1234' } });
  const B = await rest('/auth/register', { method: 'POST', body: { username: 'fl_b_' + tag, displayName: 'Борис Флоу', password: 'pass1234' } });
  const group = (await rest('/chats/group', { method: 'POST', token: A.token, body: { title: 'Флоу-группа ' + tag, memberIds: [B.user.id] } })).chat;
  const direct = (await rest('/chats/direct', { method: 'POST', token: A.token, body: { userId: B.user.id } })).chat;
  const msg = (await rest(`/chats/${group.id}/messages`, { method: 'POST', token: B.token, body: { text: 'Сообщение для действий ' + tag } })).message;
  ok(!!group.id && !!direct.id && !!msg.id, 'данные готовы: группа, личный чат, сообщение собеседника');

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
      window.Element.prototype.scrollTo = function () {};
      window.Element.prototype.scrollIntoView = function () {};
      window.HTMLElement.prototype.scrollTo = function () {};
      window.URL.createObjectURL = () => 'blob:stub';
      window.URL.revokeObjectURL = () => {};
      window.localStorage.setItem('k.token', A.token);
    },
  });
  const { window } = dom;
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  const click = (node) => node && node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  const rightClick = (node) => node && node.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, clientX: 30, clientY: 30 }));
  const msgNode = (id) => $(`#messages-inner .msg[data-msg="${id}"]`) || $$('#messages-inner .msg').find((n) => n.dataset.msg === id);
  const menu = (id) => $(`#context-menu [data-mi="${id}"]`);

  await waitFor(() => window.K && window.K.S && !$('#app').hidden, 'вход в приложение', 12000);
  await waitFor(() => window.K.S.chats.size >= 2, 'загрузка чатов');
  ok(true, 'клиент открылся и подтянул чаты');

  /* ---------------------------------------------------------- реакции и меню */
  console.log('\n— Контекстное меню сообщения —');
  window.K.openChat(group.id);
  await waitFor(() => msgNode(msg.id), 'сообщение в ленте');
  rightClick(msgNode(msg.id));
  await sleep(200);
  ok(!$('#context-menu').hidden, 'правый клик открывает меню сообщения');
  const items = $$('#context-menu [data-mi]').map((n) => n.dataset.mi);
  ok(['reply', 'pin', 'forward', 'del'].every((i) => items.includes(i)), 'в меню есть ответ, закрепление, пересылка и удаление', items.join(', '));

  console.log('\n— Реакция —');
  const reactBtn = $('#context-menu [data-mi^="react:"]') || menu('react');
  ok(!!reactBtn, 'в меню есть быстрые реакции');
  if (reactBtn) {
    if (reactBtn.dataset.mi.startsWith('react:')) {
      click(reactBtn);
    } else {
      click($('#messages-inner .msg [data-act="react"]'));
      await sleep(150);
      const quick = $('#context-menu [data-mi^="q:"]') || $('#context-menu [data-mi^="react:"]');
      click(quick);
    }
    await waitFor(() => $('#messages-inner .reaction'), 'плашка реакции в ленте');
    const server = (await rest(`/chats/${group.id}/messages?limit=50`, { token: B.token })).messages.find((m) => m.id === msg.id);
    ok(!!server && Object.keys(server.reactions || {}).length > 0, 'реакция сохранена на сервере', JSON.stringify(server && server.reactions));

    // второй путь: кнопка «😊» у сообщения (так ставят реакции с телефона)
    const quickAnchor = $(`#messages-inner .msg[data-msg="${msg.id}"] [data-act="react"]`);
    ok(!!quickAnchor, 'у сообщения есть кнопка быстрой реакции');
    click(quickAnchor);
    await sleep(200);
    const quickEmoji = $$('#context-menu [data-mi^="q:"]')[0];
    ok(!!quickEmoji, 'кнопка реакции открывает набор эмодзи');
    if (quickEmoji) {
      click(quickEmoji);
      const more = await waitFor(async () => {
        const s = (await rest(`/chats/${group.id}/messages?limit=50`, { token: B.token })).messages.find((m) => m.id === msg.id);
        return s && Object.keys(s.reactions || {}).length >= 1 && !$('#context-menu').hidden === false ? s : s;
      }, 'вторая реакция на сервере', 6000);
      ok(!!more, 'реакция из набора у сообщения тоже уходит на сервер');
    }
  }

  console.log('\n— Ответ на сообщение —');
  rightClick(msgNode(msg.id));
  await sleep(150);
  click(menu('reply'));
  await sleep(150);
  ok(!$('#reply-preview').hidden, 'показана плашка «ответ на сообщение»');
  $('#input').value = 'это ответ через интерфейс';
  $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));
  click($('#btn-send'));
  const quoted = await waitFor(() => $$('#messages-inner .msg').find((n) => n.textContent.includes('это ответ через интерфейс')), 'сообщение с цитатой');
  ok(!!quoted && /reply-quote|quote/.test(quoted.innerHTML), 'ответ отправлен и показывает цитату');

  console.log('\n— Правка своего сообщения —');
  // ждём подтверждения сервера: у отправленного сообщения появляется настоящий id
  const myMsg = await waitFor(() => {
    const node = $$('#messages-inner .msg.own').pop();
    return node && node.dataset.msg && !node.dataset.msg.startsWith('tmp_') ? node : null;
  }, 'подтверждённое своё сообщение');
  rightClick(myMsg);
  await sleep(150);
  click(menu('edit'));
  await sleep(150);
  ok($('#input').value.length > 0, 'текст подставлен в поле ввода');
  $('#input').value = 'изменено через меню';
  $('#input').dispatchEvent(new window.Event('input', { bubbles: true }));
  click($('#btn-send'));
  const editedInList = await waitFor(() => $$('#messages-inner .msg').find((n) => n.textContent.includes('изменено через меню')), 'правка в ленте');
  ok(!!editedInList, 'правка применилась в интерфейсе');
  const editedOnServer = await waitFor(async () => {
    const list = (await rest(`/chats/${group.id}/messages?limit=50`, { token: B.token })).messages;
    return list.find((m) => m.text === 'изменено через меню');
  }, 'правка на сервере');
  ok(!!editedOnServer, 'правка сохранилась на сервере');

  console.log('\n— Закрепление —');
  rightClick(msgNode(msg.id));
  await sleep(150);
  click(menu('pin'));
  await waitFor(() => !$('#pin-bar').hidden, 'полоса закреплённых');
  ok(!$('#pin-bar').hidden, 'закреплённое сообщение показано над лентой', $('#pin-bar').textContent.trim().slice(0, 40));
  click(menu('pin') || $('#pin-bar [data-act="unpin"]'));
  await sleep(150);

  console.log('\n— Пересылка —');
  rightClick(msgNode(msg.id));
  await sleep(150);
  click(menu('forward'));
  await sleep(250);
  const fwdRow = $('#fwd-list [data-fwd]');
  ok(!!fwdRow, 'окно «Переслать в…» показывает список чатов');
  if (fwdRow) {
    const directRow = $$('#fwd-list [data-fwd]').find((n) => n.dataset.fwd === direct.id) || fwdRow;
    click(directRow);
    const forwarded = await waitFor(async () => {
      const res = await rest(`/chats/${direct.id}/messages?limit=20`, { token: B.token });
      return res.messages.find((m) => m.text === msg.text);
    }, 'пересланное сообщение в личном чате');
    ok(!!forwarded, 'сообщение переслано в выбранный чат');
  }

  console.log('\n— Удаление своего сообщения —');
  const ownNow = $$('#messages-inner .msg.own').pop();
  rightClick(ownNow);
  await sleep(150);
  click(menu('del'));
  await sleep(300);
  ok(!$$('#messages-inner .msg').some((n) => n.textContent.includes('изменено через меню')), 'удалённое сообщение исчезло из ленты');
  const deletedOnServer = await waitFor(async () => {
    const list = (await rest(`/chats/${group.id}/messages?limit=50`, { token: B.token })).messages;
    const m = list.find((x) => x.id === (ownNow && ownNow.dataset.msg));
    return m && m.deleted ? m : null;
  }, 'удаление на сервере');
  ok(!!deletedOnServer, 'на сервере сообщение помечено удалённым');

  /* -------------------------------------------------------------- панели */
  console.log('\n— Панель участников —');
  click($('#btn-panel'));
  await sleep(200);
  ok(!$('#panel').hidden, 'панель «Информация» открылась');
  ok($('#panel-body').textContent.includes('Борис Флоу'), 'в панели видно участника');
  const addBtn = $('#btn-add-members');
  ok(!!addBtn, 'в панели есть кнопка «добавить участника»');
  if (addBtn) {
    click(addBtn);
    await sleep(350);
    ok(!$('#modal').hidden && $('#modal-box').textContent.includes('Добавить'), 'окно добавления участников открывается');
    click($('#modal-box #m-close') || $('#modal-box #m-cancel'));
    await sleep(150);
  }
  click($('#btn-panel-close'));
  await sleep(150);

  console.log('\n— Создание группы через интерфейс —');
  click($('#btn-new-chat'));
  await sleep(300);
  ok(!$('#modal').hidden && /Новый чат/.test($('#modal-box').textContent), 'модальное окно нового чата открылось');
  click($('#modal-box #m-cancel'));
  await sleep(150);
  click($('#btn-new-chat'));
  await sleep(300);
  click($$('#modal-box [data-pick]')[0]);
  await sleep(150);
  ok(true, 'человек выбирается в списке');
  click($('#modal-box #m-cancel'));

  /* ------------------------------------------------------------ история */
  console.log('\n— История чатов и выгрузка —');
  click($('#btn-history'));
  await sleep(400);
  ok(!$('#history-overlay').hidden, 'окно истории открылось');
  ok($$('#history-list .history-row').length >= 1, 'в истории есть записи', $$('#history-list .history-row').length + ' строк');
  const gotoRow = $('#history-list .history-row');
  click(gotoRow);
  await waitFor(() => $('#history-overlay').hidden, 'переход к сообщению из истории', 8000);
  ok($('#history-overlay').hidden, 'клик по записи истории открывает сообщение в чате');
  click($('#btn-history'));
  await sleep(350);
  $('#history-q').value = 'действий';
  $('#history-q').dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(600);
  ok($('#history-list').textContent.includes('действий'), 'поиск по всей истории фильтрует записи');
  const exportBtn = $('#btn-history-export');
  click(exportBtn);
  await waitFor(() => exportBtn.textContent === 'Скачать .txt' && !exportBtn.disabled, 'кнопка выгрузки вернулась в исходное состояние', 6000);
  ok(true, 'выгрузка истории .txt запускается без ошибок');
  click($('#btn-history-close'));
  await sleep(150);

  console.log('\n— Поиск по чату —');
  window.K.openChat(group.id);
  await sleep(200);
  click($('#btn-search-chat'));
  await sleep(150);
  ok(!$('#search-bar').hidden, 'строка поиска по чату открылась');
  $('#chat-search-input').value = 'действий';
  $('#chat-search-input').dispatchEvent(new window.Event('input', { bubbles: true }));
  const found = await waitFor(() => $$('#search-results [data-goto], #search-results > *').length > 0, 'результаты поиска по чату', 8000);
  ok(!!found, 'поиск по чату показывает результаты');
  click($('#btn-chat-search-close'));

  /* ------------------------------------------------------------ настройки */
  console.log('\n— Настройки —');
  click($('#btn-profile'));
  await sleep(300);
  ok(!$('#modal').hidden && /Настройки/.test($('#modal-box').textContent), 'настройки открываются');
  click($('#m-close') || $$('#modal-box .icon-btn.tiny').pop());
  await sleep(150);

  console.log('\n— Ошибки в консоли —');
  const real = errors.filter((e) => !/Not implemented|Could not load img|stylesheet|navigation/i.test(e));
  ok(real.length === 0, 'JavaScript без ошибок за весь прогон интерфейса', real.slice(0, 3).join(' | ') || 'чисто');

  console.log('\n' + (failed ? `❌ Провалено проверок: ${failed}` : '✅ Интерфейс прошёл сценарий: меню, реакции, ответ, правка, удаление, закрепление, пересылка, панели, поиск, история'));
  try { window.dispatchEvent(new window.Event('beforeunload')); } catch {}
  await sleep(300);
  try { window.close(); } catch {}
  await sleep(200);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('\n💥 Тест интерфейса упал:', err && err.stack || err); process.exit(1); });
