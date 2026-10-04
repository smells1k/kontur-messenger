'use strict';
/**
 * Полный сквозной сценарий «как в жизни»: два-три человека, личные чаты, группы,
 * сообщения, вложения, прочтения, поиск, синхронизация после переподключения,
 * присутствие, защита от флуда.
 *
 * Запуск:  node test/e2e.js [http://localhost:4100]
 */
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://localhost:4100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (cond, label, extra) => {
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) { failed++; process.exitCode = 1; }
  return cond;
};
const section = (title) => console.log(`\n— ${title} —`);

async function rest(path, { method = 'GET', body, token, raw = false, headers = {} } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status, data });
  return data;
}

/** Лёгкий клиент: WebSocket + ожидание событий. */
function client(token, name) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(token));
  const events = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(msg); }
    }
  });
  ws.on('error', () => {});
  return {
    ws, name, events,
    ready: new Promise((resolve) => ws.on('open', resolve)),
    send(type, payload) { ws.send(JSON.stringify({ type, payload })); },
    /** Ждём событие типа type (можно с предикатом). */
    wait(type, ms = 5000, predicate = () => true) {
      const found = events.find((e) => e.type === type && predicate(e));
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match: (m) => m.type === type && predicate(m), resolve };
        w.timer = setTimeout(() => reject(new Error(`таймаут ожидания ${type} у ${name}`)), ms);
        waiters.push(w);
      });
    },
    waitSafe(type, ms = 4000, predicate = () => true) { return this.wait(type, ms, predicate).catch(() => null); },
    lastOf(type, predicate = () => true) { return [...events].reverse().find((e) => e.type === type && predicate(e)) || null; },
    close() { try { ws.close(); } catch {} },
  };
}

const idOf = (msg) => (msg && msg.payload && (msg.payload.id || (msg.payload.message && msg.payload.message.id))) || null;

(async () => {
  const tag = Math.random().toString(36).slice(2, 7);
  const made = [];

  /* ------------------------------------------------------------- 1. регистрация */
  section('Регистрация, вход и безопасность');
  const u1 = await rest('/auth/register', { method: 'POST', body: { username: 'e2e_a_' + tag, displayName: 'Аня E2E', password: 'pass1234' } });
  const u2 = await rest('/auth/register', { method: 'POST', body: { username: 'e2e_b_' + tag, displayName: 'Борис E2E', password: 'pass1234' } });
  const u3 = await rest('/auth/register', { method: 'POST', body: { username: 'e2e_c_' + tag, displayName: 'Галина E2E', password: 'pass1234' } });
  made.push(u1.user.id, u2.user.id, u3.user.id);
  ok(!!u1.token && !!u2.token && !!u3.token, 'три пользователя зарегистрированы');

  const relogin = await rest('/auth/login', { method: 'POST', body: { username: 'e2e_a_' + tag, password: 'pass1234' } });
  ok(!!relogin.token, 'повторный вход по логину и паролю работает');
  let wrongPass = false;
  try { await rest('/auth/login', { method: 'POST', body: { username: 'e2e_a_' + tag, password: 'неверный' } }); }
  catch (err) { wrongPass = err.status === 401; }
  ok(wrongPass, 'неверный пароль отклонён (401)');
  let dupLogin = false;
  try { await rest('/auth/register', { method: 'POST', body: { username: 'e2e_a_' + tag, password: 'pass1234' } }); }
  catch (err) { dupLogin = err.status === 409; }
  ok(dupLogin, 'повторная регистрация того же логина отклонена (409)');

  const c1 = client(u1.token, 'Аня');
  const c2 = client(u2.token, 'Борис');
  const c3 = client(u3.token, 'Галина');
  await Promise.all([c1.ready, c2.ready, c3.ready]);
  await Promise.all([c1.wait('ready'), c2.wait('ready'), c3.wait('ready')]);
  ok(true, 'все три клиента подключились по WebSocket');

  /* ------------------------------------------------------------- 2. личный чат */
  section('Личный чат: у каждого своё название');
  const direct = (await rest('/chats/direct', { method: 'POST', token: u1.token, body: { userId: u2.user.id } })).chat;
  const c2Chat = await c2.wait('chat:upsert', 4000, (e) => e.payload.chat.id === direct.id).catch(() => null);
  const seenByB = c2Chat ? c2Chat.payload.chat : (await rest('/chats/' + direct.id, { token: u2.token })).chat;
  ok(seenByB.title === 'Аня E2E', 'Борис видит в личном чате имя собеседника', `«${seenByB.title}»`);
  const c1Chat = await c1.wait('chat:upsert', 4000, (e) => e.payload.chat.id === direct.id).catch(() => null);
  ok(c1Chat && c1Chat.payload.chat.title === 'Борис E2E', 'Аня видит имя собеседника в своём представлении чата');

  /* ------------------------------------------------------------- 3. группа */
  section('Группа: состав, системные сообщения, непрочитанные');
  const group = (await rest('/chats/group', { method: 'POST', token: u1.token, body: { title: 'E2E группа ' + tag, memberIds: [u2.user.id] } })).chat;
  const g3 = (await rest('/chats/' + group.id + '/members', { method: 'POST', token: u1.token, body: { userIds: [u3.user.id] } })).chat;
  ok(g3.memberIds.includes(u3.user.id), 'третий участник добавлен в группу');
  const removedMsg = await c3.waitSafe('message:new', 4000, (e) => e.payload.chatId === group.id && e.payload.message.system);
  ok(!!removedMsg, 'Галина получила системное сообщение о добавлении в группу');
  const g3view = (await rest('/chats/' + group.id, { token: u3.token })).chat;
  ok(g3view.unread === 0, 'системные сообщения не считаются непрочитанными', `непрочитанных: ${g3view.unread}`);

  const dropRes = await rest('/chats/' + group.id + '/members/' + u3.user.id, { method: 'DELETE', token: u1.token });
  ok(!dropRes.chat.memberIds.includes(u3.user.id), 'участник исключён из группы');
  const kickEvent = await c3.waitSafe('chat:removed', 4000, (e) => e.payload.chatId === group.id);
  ok(!!kickEvent, 'исключённый получил событие chat:removed');
  let noAccess = false;
  try { await rest('/chats/' + group.id + '/messages', { method: 'POST', token: u3.token, body: { text: 'меня тут нет' } }); }
  catch (err) { noAccess = err.status === 403 || err.status === 404; }
  ok(noAccess, 'исключённый не может писать в группу');

  /* ------------------------------------------------------------- 4. сообщения */
  section('Сообщения: отправка, правка, реакции, закрепление, ответы, удаление');
  c1.send('message:send', { chatId: group.id, text: 'Привет, команда!', clientId: 'cli_' + tag + '_1' });
  const ack = await c1.wait('message:ack', 5000, (e) => e.payload.clientId === 'cli_' + tag + '_1');
  ok(!!ack.payload.id, 'на отправку пришло подтверждение с id сообщения');
  const incoming = await c2.wait('message:new', 5000, (e) => e.payload.chatId === group.id && !e.payload.message.system);
  ok(incoming.payload.message.text === 'Привет, команда!', 'собеседник получил сообщение');
  ok(incoming.payload.message.author.displayName === 'Аня E2E', 'в сообщении виден автор');
  ok(!!incoming.payload.chat, 'вместе с сообщением пришло состояние чата (счётчики непрочитанных)');

  const mid = ack.payload.id;
  c1.send('message:edit', { id: mid, text: 'Привет, команда! (исправлено)' });
  const edited = await c2.wait('message:updated', 5000, (e) => e.payload.message.id === mid && !!e.payload.message.editedAt);
  ok(edited.payload.message.text.includes('исправлено'), 'правка сообщения доходит до собеседника');

  c1.send('message:react', { id: mid, emoji: '🔥' });
  const reacted = await c2.wait('message:updated', 5000, (e) => e.payload.message.id === mid && (e.payload.message.reactions || {})['🔥']);
  ok(!!reacted, 'реакция доходит до собеседника');

  c1.send('message:pin', { id: mid });
  await sleep(250);
  const pinned = (await rest('/chats/' + group.id, { token: u1.token })).chat;
  ok(pinned.pinnedMessages.includes(mid), 'сообщение закреплено в чате');

  c1.send('message:send', { chatId: group.id, text: 'это ответ', replyTo: mid, clientId: 'cli_' + tag + '_2' });
  const replyAck = await c1.wait('message:ack', 5000, (e) => e.payload.clientId === 'cli_' + tag + '_2');
  const replyView = (await rest('/chats/' + group.id + '/messages?limit=5', { token: u1.token })).messages.pop();
  ok(replyView && replyView.replyTo === mid, 'сообщение-ответ хранит ссылку на исходное');

  c1.send('message:delete', { id: mid });
  const deleted = await c2.wait('message:updated', 5000, (e) => e.payload.message.id === mid && e.payload.message.deleted);
  ok(deleted.payload.message.text === '' && deleted.payload.message.attachments.length === 0, 'удаление очищает текст и вложения у всех');

  // повторная отправка (переподключение, очередь) не должна плодить дубли
  c1.send('message:send', { chatId: group.id, text: 'дубль', clientId: 'dup_' + tag });
  const ackA = await c1.wait('message:ack', 5000, (e) => e.payload.clientId === 'dup_' + tag);
  c1.send('message:send', { chatId: group.id, text: 'дубль', clientId: 'dup_' + tag });
  await sleep(300);
  const dupAcks = c1.events.filter((e) => e.type === 'message:ack' && e.payload.clientId === 'dup_' + tag);
  ok(dupAcks.every((e) => e.payload.id === ackA.payload.id), 'повторная отправка того же сообщения не создаёт дубль', `подтверждений: ${dupAcks.length}`);
  const dupCount = (await rest('/chats/' + group.id + '/messages?limit=50', { token: u1.token })).messages.filter((m) => m.text === 'дубль').length;
  ok(dupCount === 1, 'в истории ровно одно такое сообщение', 'найдено: ' + dupCount);

  // чужое сообщение правкой не испортить
  let editForeign = false;
  try { await rest('/messages/' + replyAck.payload.id, { method: 'PATCH', token: u2.token, body: { text: 'взлом' } }); }
  catch (err) { editForeign = err.status === 403; }
  ok(editForeign, 'чужое сообщение редактировать нельзя (403)');

  /* --------------------------------------------------- 5. прочтения и счётчики */
  section('Прочтения и счётчик непрочитанных');
  const m1 = await rest('/chats/' + group.id + '/messages', { method: 'POST', token: u1.token, body: { text: 'раз' } });
  await rest('/chats/' + group.id + '/messages', { method: 'POST', token: u1.token, body: { text: 'два' } });
  await sleep(200);
  let bChat = (await rest('/chats/' + group.id, { token: u2.token })).chat;
  ok(bChat.unread >= 2, 'у собеседника копятся непрочитанные', String(bChat.unread));
  const lastForB = (await rest('/chats/' + group.id + '/messages?limit=1', { token: u2.token })).messages[0];
  c2.send('chat:read', { chatId: group.id, lastMessageId: lastForB.id });
  const readEvent = await c1.wait('read', 5000, (e) => e.payload.chatId === group.id && e.payload.userId === u2.user.id);
  ok(readEvent.payload.lastMessageId === lastForB.id, 'отметка «прочитано» приходит собеседнику');
  await sleep(200);
  bChat = (await rest('/chats/' + group.id, { token: u2.token })).chat;
  ok(bChat.unread === 0, 'после прочтения счётчик обнулился');
  ok(bChat.readStates[u2.user.id].lastMessageId === lastForB.id, 'состояние прочтения видно в чате');

  // прочтение по несуществующему id не должно ломать счётчики
  c2.send('chat:read', { chatId: group.id, lastMessageId: 'm_несуществующий' });
  await sleep(200);
  bChat = (await rest('/chats/' + group.id, { token: u2.token })).chat;
  ok(bChat.readStates[u2.user.id].lastMessageId === lastForB.id, 'чужой/несуществующий id в отметке прочтения игнорируется');

  /* --------------------------------------------------------- 6. вложения */
  section('Файлы и вложения');
  const up = async (name, mime, body) => {
    const res = await fetch(BASE + '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': mime, 'X-File-Name': encodeURIComponent(name), Authorization: 'Bearer ' + u1.token },
      body: Buffer.from(body),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const good = await up('отчёт.txt', 'text/plain', 'данные отчёта');
  ok(good.status === 200 && good.data.file && good.data.file.url.startsWith('/uploads/'), 'обычный файл загружается', good.data.file && good.data.file.url);
  const getFile = await fetch(BASE + good.data.file.url);
  const fileBody = await getFile.text();
  ok(getFile.status === 200 && fileBody === 'данные отчёта', 'файл отдаётся по ссылке из сообщения');
  ok((getFile.headers.get('x-content-type-options') || '') === 'nosniff', 'файлы отдаются с защитой от подмены типа (nosniff)');

  const evil = await up('злой.html', 'text/html', '<script>alert(1)</script>');
  const evilUrl = evil.data.file && evil.data.file.url || '';
  ok(evil.status === 200 && !/\.html?$/i.test(evilUrl), 'скрипт-файл не сохраняется как .html (нельзя выполнить в браузере)', evilUrl);
  const evilRes = await fetch(BASE + evilUrl);
  ok(!/text\/html/i.test(evilRes.headers.get('content-type') || ''), 'опасный файл не отдаётся как html');

  const att = await rest('/chats/' + group.id + '/messages', {
    method: 'POST', token: u1.token,
    body: { text: 'файл', attachments: [Object.assign({ kind: 'file' }, good.data.file)] },
  });
  ok(att.message.attachments.length === 1, 'вложение принято в сообщении');
  let badAtt = false;
  try {
    await rest('/chats/' + group.id + '/messages', { method: 'POST', token: u1.token, body: { text: 'x', attachments: [{ url: 'http://зло/файл.exe', name: 'trojan.exe' }] } });
  } catch (err) { badAtt = err.status === 400; }
  ok(badAtt, 'вложение со сторонней ссылкой отклонено');

  /* ------------------------------------------------------- 7. поиск и история */
  section('Поиск и выгрузка истории');
  const found = await rest('/chats/' + group.id + '/search?q=' + encodeURIComponent('ответ'), { token: u2.token });
  ok(found.results.length >= 1, 'поиск по чату находит сообщение');
  const foundGone = await rest('/chats/' + group.id + '/search?q=' + encodeURIComponent('Привет, команда'), { token: u2.token });
  ok(foundGone.results.length === 0, 'удалённое сообщение из поиска исчезает');
  const hist = await rest('/api'.length && '/history?limit=5', { token: u1.token }).catch(() => null);
  const histQ = await rest('/history?q=' + encodeURIComponent('файл') + '&limit=10', { token: u1.token });
  ok(histQ.total >= 1 && histQ.messages.length >= 1, 'поиск по всей истории находит сообщение', `найдено: ${histQ.total}`);
  const histAll = await rest('/history?limit=3', { token: u1.token });
  ok(histAll.hasMore === (histAll.total > 3), 'история указывает, есть ли ещё записи', `всего ${histAll.total}`);
  ok(!histAll.messages.some((r) => r.message.system), 'служебные сообщения в выгрузку не попадают');
  if (hist) { /* первая проверка недоступного пути — просто не должна ронять сервер */ }

  // вложение: 25 сообщений, листаем назад
  for (let i = 0; i < 25; i++) await rest('/chats/' + group.id + '/messages', { method: 'POST', token: u1.token, body: { text: 'порция ' + i } });
  const page1 = await rest('/chats/' + group.id + '/messages?limit=10', { token: u1.token });
  const page2 = await rest('/chats/' + group.id + '/messages?limit=10&before=' + page1.messages[0].id, { token: u1.token });
  const ids1 = new Set(page1.messages.map((m) => m.id));
  ok(page1.messages.length === 10 && page1.hasMore, 'страница истории отдаётся порциями');
  ok(page2.messages.every((m) => !ids1.has(m.id)), 'следующая страница не повторяет предыдущую');

  /* ------------------------------------------------- 8. синхронизация и устройства */
  section('Синхронизация после переподключения и второе устройство');
  const c1b = client(u1.token, 'Аня-второе-устройство');
  await c1b.ready;
  await c1b.wait('ready');
  ok(true, 'второе устройство вошло под тем же аккаунтом');
  c2.send('message:send', { chatId: group.id, text: 'видно на двух устройствах', clientId: 'cli_' + tag + '_3' });
  const onA = await c1.waitSafe('message:new', 5000, (e) => e.payload.message.clientId === 'cli_' + tag + '_3');
  const onAb = await c1b.waitSafe('message:new', 5000, (e) => e.payload.message.clientId === 'cli_' + tag + '_3');
  ok(!!onA && !!onAb, 'сообщение приходит на оба устройства пользователя');

  const seqNow = (await rest('/chats', { token: u1.token })).seq;
  c1b.close();
  await sleep(300);
  c2.send('message:send', { chatId: group.id, text: 'пока устройство было offline', clientId: 'cli_' + tag + '_4' });
  await sleep(400);
  const c1c = client(u1.token, 'Аня-вернулась');
  await c1c.ready;
  c1c.send('sync', { since: seqNow });
  const synced = await c1c.waitSafe('sync:done', 6000);
  ok(!!synced, 'клиент получил подтверждение синхронизации');
  const caught = c1c.events.filter((e) => e.type === 'sync:events').flatMap((e) => e.payload.events);
  ok(caught.some((e) => e.type === 'message:new' && e.payload.message.clientId === 'cli_' + tag + '_4'), 'пропущенное за время офлайна сообщение догнало клиента', `событий: ${caught.length}`);
  c1c.close();

  /* ------------------------------------------------------- 9. присутствие и печать */
  section('Присутствие и индикатор набора');
  // у Бориса и Галины должен быть общий чат — иначе о присутствии сообщать некому
  const bDirect = (await rest('/chats/direct', { method: 'POST', token: u2.token, body: { userId: u3.user.id } })).chat;
  c3.close();
  await sleep(400);
  const c4 = client(u3.token, 'Галина-снова');
  await c4.ready;
  const presenceOn = await c2.waitSafe('presence', 6000, (e) => e.payload.userId === u3.user.id && e.payload.online);
  ok(!!presenceOn, 'о подключении человека сообщается тем, с кем есть общий чат');
  c1.send('typing', { chatId: group.id, state: true });
  const typing = await c2.waitSafe('typing', 4000, (e) => e.payload.userId === u1.user.id && e.payload.state === true);
  ok(!!typing, 'индикатор набора текста доходит');
  c4.send('message:send', { chatId: bDirect.id, text: 'привет из личного чата', clientId: 'cli_' + tag + '_5' });
  const directMsg = await c2.waitSafe('message:new', 5000, (e) => e.payload.chatId === bDirect.id);
  ok(!!directMsg, 'личный чат между «старыми» участниками тоже работает');
  c4.close();
  await sleep(400);
  const presenceOff = await c2.waitSafe('presence', 6000, (e) => e.payload.userId === u3.user.id && !e.payload.online);
  ok(!!presenceOff, 'отключение человека тоже видно');

  /* -------------------------------------------------------- 10. защита от флуда */
  section('Защита: флуд и подбор пароля');
  let limited = false;
  for (let i = 0; i < 14; i++) {
    try { await rest('/auth/login', { method: 'POST', body: { username: 'e2e_a_' + tag, password: 'нет-' + i } }); }
    catch (err) { if (err.status === 429) { limited = true; break; } }
  }
  ok(limited, 'после серии неудачных попыток вход временно блокируется (429)');
  const stillOk = await rest('/auth/login', { method: 'POST', body: { username: 'e2e_a_' + tag, password: 'pass1234' } }).catch(() => null);
  ok(!!stillOk, 'с правильным паролем вход по-прежнему работает (блокировка не запирает навсегда)');

  // гигантский пакет по WebSocket не должен вешать сервер
  const big = client(u2.token, 'Борис-флуд');
  await big.ready;
  let bigClosed = false;
  big.ws.on('close', () => { bigClosed = true; });
  try { big.send('typing', { chatId: group.id, state: true, junk: 'x'.repeat(3 * 1024 * 1024) }); } catch { bigClosed = true; }
  await sleep(700);
  ok(bigClosed || big.ws.readyState !== 1, 'слишком большой пакет не принимается (соединение закрывается)');
  const alive = await rest('/server/info');
  ok(alive.ok === true, 'сервер продолжает работать после флуда');
  big.close();

  c1.close(); c2.close(); c4.close();
  await sleep(200);

  console.log(failed ? `\n❌ Провалено проверок: ${failed}` : '\n✅ Полный сценарий пройден без ошибок');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\n💥 Тест упал:', err && err.stack || err);
  process.exit(1);
});
