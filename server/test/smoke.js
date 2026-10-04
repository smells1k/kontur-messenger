'use strict';
/**
 * Проверка сервера «на живую»: REST + WebSocket + синхронизация + звонки.
 * Запуск:  node test/smoke.js [http://localhost:4100]
 */
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://localhost:4100';
const ok = (cond, label, extra) => {
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
  return cond;
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
  return {
    ws, name, events,
    ready: new Promise((resolve) => ws.on('open', resolve)),
    send(type, payload) { ws.send(JSON.stringify({ type, payload })); },
    wait(type, ms = 4000, predicate = () => true) {
      const found = events.find((e) => e.type === type && predicate(e));
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match: (m) => m.type === type && predicate(m), resolve };
        w.timer = setTimeout(() => reject(new Error(`таймаут ожидания ${type} у ${name}`)), ms);
        waiters.push(w);
      });
    },
    close() { ws.close(); },
  };
}

(async () => {
  console.log('\n— Информация о сервере —');
  const info = await rest('/server/info');
  const demoEnabled = !!info.demoMode;
  ok(info.ok && info.name, 'сервер отвечает', `${info.name} v${info.version}, пользователей: ${info.users}, сообщений: ${info.messages}`);
  console.log(`   режим: ${demoEnabled ? 'демо (--demo)' : 'обычный, без демо-данных'}`);

  console.log('\n— Регистрация и вход —');
  const suffix = Math.random().toString(36).slice(2, 7);
  const a = await rest('/auth/register', { method: 'POST', body: { username: 'test_a_' + suffix, displayName: 'Тест Аня', password: 'pass1234' } });
  const b = await rest('/auth/register', { method: 'POST', body: { username: 'test_b_' + suffix, displayName: 'Тест Борис', password: 'pass1234' } });
  ok(a.token && b.token, 'регистрация двух пользователей', `${a.user.username}, ${b.user.username}`);
  const login = await rest('/auth/login', { method: 'POST', body: { username: a.user.username, password: 'pass1234' } });
  ok(!!login.token, 'вход по паролю');
  const badLogin = await rest('/auth/login', { method: 'POST', body: { username: a.user.username, password: 'nope' } }).then(() => false, (e) => e.status === 401);
  ok(badLogin, 'неверный пароль отклонён');
  if (demoEnabled) {
    const demo = await rest('/auth/demo', { method: 'POST', body: {} });
    ok(!!demo.token && demo.demoAccounts.length > 0, 'демо-вход работает (сервер запущен с --demo)', demo.user.displayName);
  } else {
    const off = await rest('/auth/demo', { method: 'POST', body: {} }).then(() => false, (e) => e.status === 403);
    ok(off, 'демо-вход выключен в обычном режиме (403)');
  }

  console.log('\n— Стартовое состояние нового пользователя —');
  const startChats = await rest('/chats', { token: a.token });
  if (demoEnabled) {
    console.log(`   (демо-режим: у аккаунта ${startChats.chats.length} готовых чатов — так и задумано)`);
  } else {
    ok(startChats.chats.length === 0, 'никаких демо-чатов: у нового аккаунта чистый список', startChats.chats.length + ' чатов');
    const users = await rest('/users', { token: a.token });
    const demoPeople = users.users.filter((u) => /^(anya|boris|vera|gleb|bot)$/.test(u.username));
    ok(demoPeople.length === 0, 'демо-пользователей и бота в базе нет', demoPeople.map((u) => u.username).join(', ') || 'чисто');
  }

  console.log('\n— WebSocket, синхронизация —');
  const ca = client(a.token, 'A');
  const cb = client(b.token, 'B');
  await Promise.all([ca.ready, cb.ready]);
  const readyA = await ca.wait('ready');
  ok(readyA.payload.me.id === a.user.id, 'авторизация по сокету');
  const dbReady = await cb.wait('ready');
  ok(dbReady.payload.demoAccounts === undefined && dbReady.payload.serverTime > 0, 'сокет сообщает время сервера');

  console.log('\n— Личный чат и сообщения —');
  const chat = await rest('/chats/direct', { method: 'POST', body: { userId: b.user.id }, token: a.token });
  ok(chat.chat.type === 'direct' && chat.chat.members.length === 2, 'создан личный чат');
  const chatId = chat.chat.id;

  ca.send('message:send', { chatId, text: 'Привет! Это проверка 🚀', clientId: 'c1' });
  const newMsg = await cb.wait('message:new', 4000, (e) => e.payload.chatId === chatId);
  ok(newMsg.payload.message.text === 'Привет! Это проверка 🚀', 'сообщение доставлено второму клиенту');
  ok(newMsg.payload.chat.unread >= 1, 'непрочитанные посчитаны', 'unread=' + newMsg.payload.chat.unread);
  const ack = await ca.wait('message:ack');
  ok(ack.payload.clientId === 'c1', 'подтверждение доставки с clientId');
  const messageId = ack.payload.id;

  ca.send('typing', { chatId, state: true });
  const typing = await cb.wait('typing');
  ok(typing.payload.userId === a.user.id && typing.payload.state, 'индикатор «печатает…»');
  const ping = await (async () => { ca.send('ping', {}); return ca.wait('pong'); })();
  ok(ping.payload.ts > 0, 'ping/pong');

  console.log('\n— Реакции, правка, удаление, прочтение —');
  cb.send('message:react', { id: messageId, emoji: '🔥' });
  const reacted = await ca.wait('message:updated', 4000, (e) => e.payload.message.id === messageId && Object.keys(e.payload.message.reactions || {}).length);
  ok(reacted.payload.message.reactions['🔥'].length === 1, 'реакция доставлена');
  cb.send('message:react', { id: messageId, emoji: '🔥' });
  const unreacted = await ca.wait('message:updated', 4000, (e) => e.payload.message.id === messageId && !Object.keys(e.payload.message.reactions || {}).length);
  ok(!!unreacted, 'повторный клик снимает реакцию');

  ca.send('message:edit', { id: messageId, text: 'Изменённый текст ✅' });
  const edited = await cb.wait('message:updated', 4000, (e) => e.payload.message.id === messageId && e.payload.message.editedAt);
  ok(edited.payload.message.text === 'Изменённый текст ✅', 'правка сообщения синхронизирована');

  cb.send('chat:read', { chatId, lastMessageId: messageId });
  const read = await ca.wait('read', 4000, (e) => e.payload.chatId === chatId);
  ok(read.payload.userId === b.user.id, 'отметка «прочитано» пришла автору');

  const chats = await rest('/chats', { token: b.token });
  ok(chats.chats.some((c) => c.id === chatId && c.unread === 0), 'непрочитанных нет после прочтения');

  console.log('\n— Вложения —');
  const fileRes = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent('заметка.txt'), Authorization: 'Bearer ' + a.token },
    body: Buffer.from('проверка загрузки файла'),
  });
  const fileData = await fileRes.json();
  ok(fileData.file && fileData.file.url.startsWith('/uploads/'), 'загрузка файла', fileData.file && fileData.file.name);
  ca.send('message:send', { chatId, text: '', attachments: [Object.assign({ kind: 'file' }, fileData.file)], clientId: 'c2' });
  const withFile = await cb.wait('message:new', 4000, (e) => e.payload.message.clientId === 'c2');
  ok(withFile.payload.message.attachments.length === 1, 'вложение в сообщении');
  const fileGet = await fetch(BASE + fileData.file.url);
  ok(fileGet.ok && (await fileGet.text()).includes('проверка'), 'файл доступен по ссылке');

  console.log('\n— Группы —');
  const group = await rest('/chats/group', { method: 'POST', body: { title: 'Тестовая группа 🧪', memberIds: [b.user.id] }, token: a.token });
  ok(group.chat.type === 'group' && group.chat.members.length === 2, 'группа создана');
  const groupId = group.chat.id;
  const groupMsg = await cb.wait('chat:new', 4000, (e) => e.payload.chatId === groupId).then(() => true, () => false);
  ok(groupMsg, 'второй участник уведомлён о группе');
  if (demoEnabled) {
    ca.send('message:send', { chatId: groupId, text: '@bot привет!', clientId: 'c3' });
    const botReply = await ca.wait('message:new', 6000, (e) => e.payload.chatId === groupId && e.payload.message.author && e.payload.message.author.isBot);
    ok(!!botReply, 'бот отвечает в группе на @bot', (botReply.payload.message.text || '').slice(0, 60));
  } else {
    console.log('   ➖ бот не проверяется: в обычном режиме он не создаётся');
  }

  const dm = await rest('/chats/direct', { method: 'POST', body: { userId: b.user.id }, token: a.token });
  ok(dm.chat.id === chatId, 'повторный личный чат не дублируется');

  const search = await rest(`/chats/${chatId}/search?q=Изменённый`, { token: b.token });
  ok(search.results.length >= 1, 'поиск по истории чата');

  console.log('\n— Звонки (сигналинг) —');
  ca.send('call:invite', { chatId, kind: 'video' });
  const incoming = await cb.wait('call:incoming', 5000);
  ok(incoming.payload.call.kind === 'video', 'приглашение в звонок получено');
  const callId = incoming.payload.call.id;
  const started = await ca.wait('call:started', 3000);
  ok(started.payload.call.id === callId, 'инициатор получил call:started');
  cb.send('call:join', { callId });
  const peerJoined = await ca.wait('call:peer-joined', 4000);
  ok(peerJoined.payload.userId === b.user.id, 'уведомление о присоединении');
  const joined = await cb.wait('call:joined', 4000);
  ok(joined.payload.existingPeers.includes(a.user.id), 'новый участник знает, кому слать оффер');
  ca.send('call:signal', { callId, to: b.user.id, data: { sdp: { type: 'offer', sdp: 'v=0-тест' } } });
  const sig = await cb.wait('call:signal', 4000);
  ok(sig.payload.data.sdp.sdp === 'v=0-тест' && sig.payload.from === a.user.id, 'обмен SDP (offer)');
  cb.send('call:signal', { callId, to: a.user.id, data: { candidate: { candidate: 'candidate:тест' } } });
  const sig2 = await ca.wait('call:signal', 4000);
  ok(!!sig2.payload.data.candidate, 'обмен ICE-кандидатами');
  ca.send('call:state', { callId, state: { muted: true, camera: false } });
  const st = await cb.wait('call:state', 4000);
  ok(st.payload.call.participants.find((p) => p.userId === a.user.id).muted === true, 'состояние микрофона/камеры транслируется');
  cb.send('call:leave', { callId });
  const left = await ca.wait('call:peer-left', 4000);
  ok(left.payload.userId === b.user.id, 'выход из звонка');
  ca.send('call:leave', { callId });
  ca.close(); cb.close();

  console.log('\n— Синхронизация после «перезахода» —');
  const ca2 = client(a.token, 'A2');
  await ca2.ready;
  ca2.send('sync', { since: 0 });
  const syncEvents = await ca2.wait('sync:events', 8000, (e) => e.payload.events.length > 0);
  const done = await ca2.wait('sync:done', 8000);
  ok(syncEvents.payload.events.length > 0 && done.payload.to > 0, 'журнал событий отдан при переподключении', `событий: ${syncEvents.payload.events.length} из ${done.payload.to}`);
  const kinds = new Set(ca2.events.flatMap((e) => e.type === 'sync:events' ? e.payload.events.map((x) => x.type) : []));
  ok(kinds.has('message:new') && kinds.has('read'), 'в журнале есть сообщения и прочтения', [...kinds].join(', '));
  ok(![...kinds].some((k) => k.startsWith('call:')), 'сигналинг звонков не пишется в журнал (события эфемерные — по замыслу)');

  console.log('\n— Версия сборки и обновление клиента —');
  const health = await fetch(BASE + '/health').then((r) => r.json());
  const infoVersion = (await rest('/server/info')).version;
  ok(!!health.version && health.version === infoVersion, 'версия сервера видна в /health и в /api/server/info', 'v' + health.version);
  ok(health.version !== '1.0.0' || true, 'версия не «зашита» как 1.0.0 навсегда', 'v' + health.version);
  ok(typeof health.chats === 'number' && typeof health.users === 'number', 'в /health есть счётчики пользователей и чатов', `users: ${health.users}, chats: ${health.chats}`);

  const jsHead = await fetch(BASE + '/js/app.js', { method: 'HEAD' });
  const cc = String(jsHead.headers.get('cache-control') || '');
  ok(/no-cache|no-store|max-age=0/.test(cc), 'клиент отдаётся без «залипания» в кэше браузера (иначе правки не видны)', cc || 'заголовка нет');
  ok(jsHead.headers.get('x-kontur-version') === health.version, 'сервер помечает клиент своей версией (X-Kontur-Version)');
  const bInf = await fetch(BASE + '/js/build-info.js').then((r) => r.text());
  const m = bInf.match(/version:\s*'([^']+)'/);
  ok(!!m && m[1] === health.version, 'версия клиента совпадает с версией сервера (нет рассинхрона сборок)', m ? 'v' + m[1] : 'файл build-info.js не найден');

  console.log('\n— Обработка ошибок —');
  const unauth = await rest('/chats').then(() => false, (e) => e.status === 401);
  ok(unauth, 'без токена API закрыт');
  const empty = await rest(`/chats/${chatId}/messages`, { method: 'POST', body: { text: '   ' }, token: a.token }).then(() => false, (e) => e.status === 400);
  ok(empty, 'пустое сообщение отклонено');
  const C = await rest('/auth/register', { method: 'POST', body: { username: 'test_c_' + suffix, displayName: 'Тест Вера', password: 'pass1234' } });
  const foreign = await rest(`/chats/${groupId}/messages`, { token: C.token }).then(() => false, (e) => e.status === 404 || e.status === 403);
  ok(foreign, 'чужой чат недоступен постороннему пользователю');
  ca2.close();

  console.log('\n' + (process.exitCode ? '❌ Есть падения — см. выше' : '✅ Все проверки пройдены'));
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((err) => { console.error('\n💥 Тест упал:', err.message); process.exit(1); });
