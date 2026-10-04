'use strict';
/**
 * WebSocket-слой: синхронизация, присутствие, доставка событий, сигналинг WebRTC.
 */
const { WebSocketServer } = require('ws');
const { verifyToken } = require('./util');

class Hub {
  constructor({ server, store, core, secret, path = '/ws' }) {
    this.store = store;
    this.core = core;
    this.secret = secret;
    this.sockets = new Map(); // ws -> { userId, alive, id }
    this.wss = new WebSocketServer({ noServer: true });
    this.stats = { connections: 0, messagesIn: 0, messagesOut: 0 };

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== path) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    this.heartbeat = setInterval(() => this.tick(), 25000);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  /* -------------------------------------------------------------- служебное */

  onConnection(ws, req) {
    this.stats.connections++;
    const state = { userId: null, alive: true, ip: req.socket.remoteAddress, device: req.headers['user-agent'] || '' };
    this.sockets.set(ws, state);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => this.onMessage(ws, raw));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => {});

    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (token) this.authenticate(ws, token, 0);
    else this.send(ws, { type: 'hello', payload: { needAuth: true, serverTime: Date.now() } });

    this.authTimer = (this.authTimer || new Map()).set(ws, setTimeout(() => {
      const st = this.sockets.get(ws);
      if (st && !st.userId) { this.send(ws, { type: 'auth:error', payload: { message: 'Таймаут авторизации' } }); ws.close(); }
    }, 20000));
  }

  tick() {
    for (const [ws, st] of this.sockets) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} this.sockets.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
    for (const [ws, st] of this.sockets) {
      if (st.userId && st.alive) this.send(ws, { type: 'pong', payload: { ts: Date.now() } });
    }
  }

  onClose(ws) {
    const st = this.sockets.get(ws);
    this.sockets.delete(ws);
    const timers = this.authTimer;
    if (timers && timers.has(ws)) { clearTimeout(timers.get(ws)); timers.delete(ws); }
    if (!st || !st.userId) return;
    const user = this.store.getUser(st.userId);
    if (!user) return;
    if (!this.isOnline(st.userId)) {
      user.online = false;
      user.lastSeen = Date.now();
      this.store.save();
      this.broadcastPresence(st.userId, false);
      // если у пользователя больше нет соединений — он выходит из звонков
      for (const call of this.core.activeCallsFor(st.userId)) {
        try { this.core.leaveCall(st.userId, call.id); } catch (err) { console.error('[call]', err.message); }
      }
    }
  }

  /* ------------------------------------------------------------ авторизация */

  authenticate(ws, token, since = 0) {
    const payload = verifyToken(token, this.secret);
    if (!payload || !payload.sub) { this.send(ws, { type: 'auth:error', payload: { message: 'Сессия истекла, войдите заново' } }); return false; }
    const user = this.store.getUser(payload.sub);
    if (!user) { this.send(ws, { type: 'auth:error', payload: { message: 'Пользователь не найден' } }); return false; }
    const st = this.sockets.get(ws);
    st.userId = user.id;
    const firstEver = !user.online;
    user.online = true;
    user.lastSeen = Date.now();
    this.store.save();

    this.send(ws, {
      type: 'ready',
      payload: {
        me: this.store.publicUser(user),
        seq: this.store.seq,
        serverTime: Date.now(),
        devices: this.deviceCount(user.id),
        calls: this.core.activeCallsFor(user.id).map((c) => this.core.callView(c)),
      },
    });
    if (since > 0) this.syncUser(ws, user.id, since);
    if (firstEver) this.broadcastPresence(user.id, true);
    return true;
  }

  deviceCount(userId) {
    let n = 0;
    for (const [, st] of this.sockets) if (st.userId === userId) n++;
    return n;
  }

  isOnline(userId) {
    for (const [, st] of this.sockets) if (st.userId === userId) return true;
    return false;
  }

  onlineUsers() {
    const set = new Set();
    for (const [, st] of this.sockets) if (st.userId) set.add(st.userId);
    return [...set];
  }

  /** Кому сообщать о присутствии: всем, с кем есть общий чат. */
  broadcastPresence(userId, online) {
    const user = this.store.getUser(userId);
    const targets = new Set();
    for (const chat of this.store.chatsOf(userId)) for (const m of chat.members) if (m !== userId) targets.add(m);
    const payload = { userId, online: !!online, lastSeen: user ? user.lastSeen : Date.now() };
    for (const uid of targets) this.sendToUser(uid, { type: 'presence', payload });
  }

  /* -------------------------------------------------------------- доставка */

  send(ws, obj) {
    try {
      this.stats.messagesOut++;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    } catch { /* сокет мог умереть */ }
  }

  sendToUser(userId, obj) {
    for (const [ws, st] of this.sockets) if (st.userId === userId) this.send(ws, obj);
  }

  deliver(userIds, event) {
    for (const uid of userIds) this.sendToUser(uid, event);
  }

  syncUser(ws, userId, since) {
    const events = this.store.eventsSince(userId, Number(since) || 0);
    const chunk = 500;
    for (let i = 0; i < events.length; i += chunk) {
      this.send(ws, { type: 'sync:events', payload: { events: events.slice(i, i + chunk), to: this.store.seq } });
    }
    this.send(ws, { type: 'sync:done', payload: { from: since, to: this.store.seq, count: events.length } });
  }

  /* --------------------------------------------------------------- команды */

  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    this.stats.messagesIn++;
    const st = this.sockets.get(ws);
    if (!st) return;

    // --- до авторизации разрешены только auth/sync/ping
    if (!st.userId) {
      if (msg.type === 'auth') return void this.authenticate(ws, msg.token, msg.since || 0);
      if (msg.type === 'ping') return void this.send(ws, { type: 'pong', payload: { ts: Date.now() } });
      return void this.send(ws, { type: 'auth:error', payload: { message: 'Сначала авторизуйтесь' } });
    }

    const me = st.userId;
    const p = msg.payload || msg.data || {};
    const fail = (err) => this.send(ws, { type: 'error', payload: { message: err.message || 'Ошибка', request: msg.type, requestId: msg.requestId || null } });

    try {
      switch (msg.type) {
        case 'ping': return void this.send(ws, { type: 'pong', payload: { ts: Date.now(), requestId: msg.requestId } });
        case 'sync': return void this.syncUser(ws, me, p.since || 0);
        case 'presence:list': return void this.send(ws, { type: 'presence:list', payload: { online: this.onlineUsers() } });
        case 'typing': return void this.core.typing(me, p.chatId, p.state);
        case 'message:send': {
          const m = this.core.sendMessage({
            chatId: p.chatId, authorId: me, text: p.text, attachments: p.attachments || [],
            replyTo: p.replyTo || null, clientId: p.clientId || null,
          });
          return void this.send(ws, { type: 'message:ack', payload: { clientId: p.clientId || null, id: m.id, chatId: m.chatId, createdAt: m.createdAt } });
        }
        case 'message:edit': {
          const m = this.core.editMessage(me, p.id, p.text);
          return void this.send(ws, { type: 'ok', payload: { request: msg.type, requestId: msg.requestId, id: m.id } });
        }
        case 'message:delete': {
          const m = this.core.deleteMessage(me, p.id);
          return void this.send(ws, { type: 'ok', payload: { request: msg.type, requestId: msg.requestId, id: m.id } });
        }
        case 'message:react': {
          const m = this.core.toggleReaction(me, p.id, p.emoji);
          return void this.send(ws, { type: 'ok', payload: { request: msg.type, requestId: msg.requestId, id: m.id } });
        }
        case 'message:pin': {
          this.core.pinMessage(me, p.id);
          return void this.send(ws, { type: 'ok', payload: { request: msg.type, requestId: msg.requestId } });
        }
        case 'chat:read': return void this.core.markRead(me, p.chatId, p.lastMessageId || null);
        case 'call:invite': {
          const call = this.core.startCall(me, p.chatId, p.kind);
          return void this.send(ws, { type: 'call:started', payload: { call: this.core.callView(call), existingPeers: call.participants.map((x) => x.userId) } });
        }
        case 'call:join': {
          const { call, existingPeers } = this.core.joinCall(me, p.callId);
          return void this.send(ws, { type: 'call:joined', payload: { call: this.core.callView(call), existingPeers } });
        }
        case 'call:decline': return void this.core.declineCall(me, p.callId);
        case 'call:leave': return void this.core.leaveCall(me, p.callId);
        case 'call:state': return void this.core.updateCallState(me, p.callId, p.state || {});
        case 'call:signal': return void this.core.signalCall(me, { callId: p.callId, to: p.to, data: p.data });
        case 'device:list': {
          const devices = [];
          for (const [, s] of this.sockets) if (s.userId === me) devices.push({ ip: s.ip, device: s.device.slice(0, 120) });
          return void this.send(ws, { type: 'device:list', payload: { devices } });
        }
        default: return void this.send(ws, { type: 'error', payload: { message: `Неизвестная команда: ${msg.type}`, requestId: msg.requestId || null } });
      }
    } catch (err) { fail(err); }
  }
}

module.exports = { Hub };
