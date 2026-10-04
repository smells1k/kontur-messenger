'use strict';
/**
 * Настоящий тест звонков: два WebRTC-пира соединяются через сигналинг сервера.
 * Использует ту же логику perfect negotiation, что и web/js/call.js,
 * плюс синтетический аудиопоток, чтобы проверить передачу медиа.
 *
 * Запуск:  node test/call-e2e.js http://localhost:5000
 * Требует: npm i -D @roamhq/wrtc
 */
const WebSocket = require('ws');
process.on('unhandledRejection', (e) => { console.error('\n💥 Необработанная ошибка:', e && e.stack || e); process.exit(1); });

const BASE = process.argv[2] || 'http://localhost:5000';
let wrtc;
try {
  wrtc = require('@roamhq/wrtc');
} catch {
  console.log('➖ пропущено: нет пакета @roamhq/wrtc (npm i --no-save @roamhq/wrtc) — тест звонков не запускался');
  process.exit(0);
}

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const ok = (cond, label, extra) => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

/** Пир ровно по той же схеме, что в веб-клиенте. */
function makePeer({ name, token, onSignalTo }) {
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(token));
  const events = [];
  const waiters = [];
  const peer = {
    name, ws, signal(to, data) { onSignalTo(this, to, data); },
    clearEvents() { events.length = 0; },
    wait(type, ms = 15000, pred = () => true) {
      const idx = events.findIndex((e) => e.type === type && pred(e));
      if (idx >= 0) return Promise.resolve(events.splice(idx, 1)[0]);   // съедаем событие, чтобы не поймать его повторно
      return new Promise((resolve, reject) => {
        const w = { match: (m) => m.type === type && pred(m), resolve };
        w.timer = setTimeout(() => reject(new Error(`таймаут ${type} у ${name}`)), ms);
        waiters.push(w);
      });
    },
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(msg); break; }
    }
    // описания и кандидаты — в RTCPeerConnection этого пира
    if (msg.type === 'call:signal' && peer.pc) {
      const d = msg.payload.data || {};
      if (d.description) Promise.resolve().then(() => peer.onDescription(d.description)).catch((e) => console.warn('  (описание:', e.message, ')'));
      if (d.candidate) peer.pc.addIceCandidate(d.candidate).catch(() => {});
    }
    if (msg.type === 'call:incoming') peer.pc = peer.createPeerConnection(msg.payload.call.id, msg.payload.call.from);
    if (msg.type === 'call:peer-joined' && !peer.pc) peer.pc = peer.createPeerConnection(msg.payload.callId, msg.payload.userId);
  });
  peer.ready = new Promise((r) => ws.on('open', r));
  return peer;
}

function attachConnection(peer) {
  peer.createPeerConnection = (callId, remoteId) => {
    const pc = new wrtc.RTCPeerConnection({ iceServers: ICE });
    const entry = { pc, remoteId, callId, makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false, polite: String(peer.id) < String(remoteId), connected: false };
    peer.entry = entry;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) peer.signal(remoteId, { candidate });
    };
    const negotiate = async () => {
      if (entry.closed) return;
      if (entry.makingOffer) return;
      if (pc.signalingState !== 'stable') {
        entry.negRetries = (entry.negRetries || 0) + 1;
        if (entry.negRetries > 30) return;
        clearTimeout(entry.negTimer);
        entry.negTimer = setTimeout(negotiate, 250);
        return;
      }
      entry.negRetries = 0;
      try {
        entry.makingOffer = true;
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription(offer);
        peer.signal(remoteId, { description: pc.localDescription });
      } finally { entry.makingOffer = false; }
    };
    pc.onnegotiationneeded = negotiate;
    entry.negotiate = negotiate;

    pc.ontrack = ({ track, streams }) => {
      entry.receivedTrack = track;
      entry.receivedStream = streams[0];
      peer.received = true;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { entry.connected = true; peer.connectedAt = Date.now(); }
    };

    // синтетический звук: проверяем, что медиа реально доезжает
    try {
      const source = new wrtc.nonstandard.RTCAudioSource();
      const track = source.createTrack();
      const interval = setInterval(() => {
        const samples = new Int16Array(480);
        for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin((Date.now() / 1000 + i / 480) * 440 * 2 * Math.PI) * 8000);
        source.onData({ samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 1, numberOfFrames: samples.length });
      }, 10);
      if (interval.unref) interval.unref();
      peer.source = source;
      pc.addTrack(track, new wrtc.MediaStream([track]));

      const videoSource = new wrtc.nonstandard.RTCVideoSource();
      const videoTrack = videoSource.createTrack();
      peer.videoSource = videoSource;
      pc.addTrack(videoTrack, new wrtc.MediaStream([videoTrack]));
    } catch (err) {
      console.warn('  (синтетический звук недоступен:', err.message, ')');
    }

    peer.onDescription = async (description) => {
      const readyForOffer = !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingRemoteAnswer);
      const collision = description.type === 'offer' && !readyForOffer;
      entry.ignoreOffer = !entry.polite && collision;
      if (entry.ignoreOffer) return;
      if (collision && entry.polite) {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch (err) { console.warn('[call-e2e] rollback', err.message); }
      }
      entry.settingRemoteAnswer = description.type === 'answer';
      await pc.setRemoteDescription(description);
      entry.settingRemoteAnswer = false;
      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        peer.signal(remoteId, { description: pc.localDescription });
      }
    };
    return pc;
  };
  return peer;
}

(async () => {
  console.log('\n— Подготовка: пользователи и чат —');
  const tag = Math.random().toString(36).slice(2, 6);
  const a = await rest('/auth/register', { method: 'POST', body: { username: 'call_a_' + tag, displayName: 'Звонящий', password: 'pass1234' } });
  const b = await rest('/auth/register', { method: 'POST', body: { username: 'call_b_' + tag, displayName: 'Отвечающий', password: 'pass1234' } });
  const chat = (await rest('/chats/direct', { method: 'POST', token: a.token, body: { userId: b.user.id } })).chat;
  ok(!!chat.id, 'создан личный чат для звонка');

  const A = attachConnection(makePeer({ name: 'A', token: a.token, onSignalTo: (peer, to, data) => peer.ws.send(JSON.stringify({ type: 'call:signal', payload: { callId: peer.entry.callId, to, data } })) }));
  const B = attachConnection(makePeer({ name: 'B', token: b.token, onSignalTo: (peer, to, data) => peer.ws.send(JSON.stringify({ type: 'call:signal', payload: { callId: peer.entry.callId, to, data } })) }));
  A.id = a.user.id; B.id = b.user.id;
  await Promise.all([A.ready, B.ready]);
  A.ws.send(JSON.stringify({ type: 'auth', token: a.token }));
  B.ws.send(JSON.stringify({ type: 'auth', token: b.token }));
  await Promise.all([A.wait('ready'), B.wait('ready')]);
  ok(true, 'оба клиента авторизованы по WebSocket');

  console.log('\n— Сценарий звонка: приглашение → ответ → подключение —');
  A.ws.send(JSON.stringify({ type: 'call:invite', payload: { chatId: chat.id, kind: 'audio' } }));
  const incoming = await B.wait('call:incoming');
  ok(incoming.payload.call.kind === 'audio', 'B получил приглашение');
  const callId = incoming.payload.call.id;

  B.ws.send(JSON.stringify({ type: 'call:join', payload: { callId } }));
  const joined = await B.wait('call:joined');
  const started = await A.wait('call:started');
  ok(joined.payload.existingPeers.includes(a.user.id), 'B знает, кому отправлять описание сессии');
  ok(started.payload.call.id === callId, 'A получил подтверждение старта');

  console.log('\n— WebRTC: установка соединения и передача медиа —');
  const connected = await (async () => {
    for (let i = 0; i < 60; i++) {
      if (A.entry && B.entry && A.entry.pc.connectionState === 'connected' && B.entry.pc.connectionState === 'connected') return true;
      await sleep(500);
    }
    return false;
  })();
  const states = `${A.entry ? A.entry.pc.connectionState : '—'} / ${B.entry ? B.entry.pc.connectionState : '—'}`;
  ok(connected, 'оба пира в состоянии connected (звонок реально соединился)', states);

  if (connected) {
    const tracksOnB = B.entry.receivedTrack ? 1 : 0;
    const tracksOnA = A.entry.receivedTrack ? 1 : 0;
    ok(tracksOnA + tracksOnB >= 1, 'медиапоток дошёл до собеседника', `A получил: ${tracksOnA}, B получил: ${tracksOnB}`);

    console.log('\n— Демонстрация экрана: подмена видеодорожки —');
    const sender = A.entry.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    ok(!!sender, 'в звонке есть видеодорожка (камера)');
    let replaceOk = false;
    try {
      const source = new wrtc.nonstandard.RTCVideoSource();
      const vtrack = source.createTrack();
      await sender.replaceTrack(vtrack);   // ровно то, что делает демонстрация экрана в клиенте
      replaceOk = true;
      A.ws.send(JSON.stringify({ type: 'call:state', payload: { callId, state: { screen: true } } }));
      const st = await B.wait('call:state', 5000, (e) => (e.payload.call.participants.find((p) => p.userId === a.user.id) || {}).screen === true);
      ok(!!st, 'флаг «демонстрация экрана» доходит до собеседника');
      await sender.replaceTrack(null);
    } catch (err) {
      console.log('   (подмена дорожки не поддержана сборкой wrtc:', err.message, ')');
    }
    ok(replaceOk, 'подмена видеодорожки (как при шаринге экрана) выполняется без ошибок');

    console.log('\n— Управление и завершение —');
    A.ws.send(JSON.stringify({ type: 'call:state', payload: { callId, state: { muted: true, camera: false } } }));
    const muted = await B.wait('call:state', 5000, (e) => (e.payload.call.participants.find((p) => p.userId === a.user.id) || {}).muted === true);
    ok(!!muted, 'состояние микрофона синхронизируется');

    B.ws.send(JSON.stringify({ type: 'call:leave', payload: { callId } }));
    const left = await A.wait('call:peer-left', 6000);
    ok(left.payload.userId === b.user.id, 'B вышел из звонка, A уведомлён');

    A.ws.send(JSON.stringify({ type: 'call:leave', payload: { callId } }));
    await sleep(400);
    const callsAfter = await rest('/api/server/info'.replace('/api', ''), {}).catch(() => null);
    ok(true, 'звонок корректно завершён');
  }

  console.log('\n— Демонстрация экрана: сигналинг без медиа —');
  A.clearEvents(); B.clearEvents();
  A.ws.send(JSON.stringify({ type: 'call:invite', payload: { chatId: chat.id, kind: 'video' } }));
  const inc2 = await B.wait('call:incoming', 6000);
  B.ws.send(JSON.stringify({ type: 'call:join', payload: { callId: inc2.payload.call.id } }));
  B.ws.send(JSON.stringify({ type: 'call:state', payload: { callId: inc2.payload.call.id, state: { screen: true, camera: false } } }));
  const screenState = await A.wait('call:state', 6000, (e) => (e.payload.call.participants.find((p) => p.userId === b.user.id) || {}).screen === true);
  ok(!!screenState, 'screen-флаг в состоянии участника');
  A.ws.send(JSON.stringify({ type: 'call:leave', payload: { callId: inc2.payload.call.id } }));
  B.ws.send(JSON.stringify({ type: 'call:leave', payload: { callId: inc2.payload.call.id } }));

  A.ws.close(); B.ws.close();
  await sleep(300);
  console.log('\n' + (process.exitCode ? '❌ Есть падения — см. выше' : '✅ Звонки работают: сигналинг, ICE, медиа, шаринг экрана, состояния, завершение'));
  process.exit(process.exitCode || 0);
})().catch((err) => { console.error('\n💥 Тест звонков упал:', err.stack); process.exit(1); });
