'use strict';
/**
 * Ядро приложения: вся бизнес-логика в одном месте.
 * Используется и REST-API, и WebSocket-слоем, поэтому поведение всегда одинаковое.
 */
const { newId, cleanText } = require('./util');

const MAX_GROUP_MEMBERS = 500;
const MAX_CALL_PEERS = 8;

class Core {
  constructor(store, hub) {
    this.store = store;
    this.hub = hub;
    this.bots = [];
  }

  /* ------------------------------------------------------------- представления */

  publicMessage(msg) {
    if (!msg) return null;
    const author = this.store.getUser(msg.authorId);
    return {
      id: msg.id, chatId: msg.chatId, authorId: msg.authorId,
      author: author ? this.store.publicUser(author) : null,
      text: msg.deleted ? '' : msg.text,
      attachments: msg.deleted ? [] : msg.attachments,
      replyTo: msg.replyTo || null,
      reactions: msg.reactions || {},
      createdAt: msg.createdAt, editedAt: msg.editedAt || null,
      deleted: !!msg.deleted, system: !!msg.system, clientId: msg.clientId || null,
    };
  }

  chatView(chat, meId) {
    if (!chat) return null;
    const members = chat.members.map((id) => this.store.publicUser(this.store.getUser(id))).filter(Boolean);
    const me = this.store.getUser(meId);
    const peer = chat.type === 'direct' ? members.find((m) => m.id !== meId) || null : null;
    return {
      id: chat.id,
      type: chat.type,
      title: chat.type === 'direct' ? (peer ? peer.displayName : 'Чат') : chat.title,
      avatar: chat.type === 'direct' ? (peer ? peer.avatar : null) : chat.avatar,
      color: chat.type === 'direct' ? (peer ? peer.color : '#65aadd') : (chat.color || '#a695e7'),
      members,
      memberIds: chat.members,
      admins: chat.admins || [],
      peer,
      lastMessage: this.publicMessage(this.store.lastMessage(chat.id)),
      unread: this.store.unreadCount(chat.id, meId),
      myRead: this.store.readState(chat.id, meId),
      readStates: this.store.readStates(chat.id),
      pinnedMessages: chat.pinnedMessages || [],
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      isDemo: !!chat.isDemo,
      onlineCount: members.filter((m) => m.online).length,
      me: me ? this.store.publicUser(me) : null,
    };
  }

  memberIds(chatId) { return this.store.getChat(chatId)?.members || []; }

  /**
   * Системное сообщение («Аня создал(а) группу», «Борис добавил(а) Галину»).
   * Раньше такие записи попадали только в историю и появлялись у людей лишь
   * после перезагрузки — теперь они уходят в сокет как обычные сообщения.
   */
  systemMessage(chat, authorId, text) {
    const msg = this.store.addMessage({ chatId: chat.id, authorId, system: true, text });
    const view = this.publicMessage(msg);
    for (const uid of chat.members) {
      this.emit([uid], 'message:new', { chatId: chat.id, message: view, chat: this.chatView(chat, uid) });
    }
    return msg;
  }

  /** Событие в журнал + мгновенная доставка всем подписчикам. */
  emit(userIds, type, payload) {
    const uniq = [...new Set(userIds)];
    const seq = this.store.pushEvent(uniq, type, payload);
    this.hub.deliver(uniq, { type, seq, payload });
    return seq;
  }

  /* ------------------------------------------------------------------- чаты */

  ensureDirectChat(aId, bId) {
    if (aId === bId) throw Object.assign(new Error('Нельзя начать чат с самим собой'), { status: 400 });
    let chat = this.store.findDirectChat(aId, bId);
    if (!chat) {
      chat = this.store.createChat({ type: 'direct', memberIds: [aId, bId], createdBy: aId });
      // Каждому — своё событие: у личного чата «название» и аватар зависят от того,
      // кто смотрит (это имя собеседника), поэтому одно общее событие давало
      // одному из участников его же имя вместо имени друга.
      for (const uid of [aId, bId]) {
        this.emit([uid], 'chat:new', { chatId: chat.id, chat: this.chatView(chat, uid) });
        this.hub.sendToUser(uid, { type: 'chat:upsert', payload: { chat: this.chatView(chat, uid) } });
      }
    }
    return chat;
  }

  createGroup(ownerId, title, memberIds = [], avatar = null, isDemo = false) {
    const members = [...new Set([ownerId, ...memberIds])].filter((id) => this.store.getUser(id));
    if (members.length > MAX_GROUP_MEMBERS) throw Object.assign(new Error('Слишком много участников'), { status: 400 });
    const chat = this.store.createChat({ type: 'group', title: cleanText(title, 64) || 'Новая группа', memberIds: members, createdBy: ownerId, avatar, isDemo });
    const owner = this.store.getUser(ownerId);
    for (const uid of members) {
      this.hub.sendToUser(uid, { type: 'chat:upsert', payload: { chat: this.chatView(chat, uid) } });
    }
    this.emit(members, 'chat:new', { chatId: chat.id });
    this.systemMessage(chat, ownerId, `${owner.displayName} создал(а) группу «${chat.title}»`);
    return chat;
  }

  updateChat(actorId, chatId, patch = {}) {
    const chat = this.store.getChat(chatId);
    if (!chat) throw Object.assign(new Error('Чат не найден'), { status: 404 });
    if (!chat.members.includes(actorId)) throw Object.assign(new Error('Нет доступа'), { status: 403 });
    if (chat.type === 'group') {
      if (typeof patch.title === 'string' && patch.title.trim()) chat.title = cleanText(patch.title, 64);
      if ('avatar' in patch) chat.avatar = patch.avatar || null;
    }
    chat.updatedAt = Date.now();
    this.store.save();
    for (const uid of chat.members) this.hub.sendToUser(uid, { type: 'chat:upsert', payload: { chat: this.chatView(chat, uid) } });
    return chat;
  }

  addMembers(actorId, chatId, userIds) {
    const chat = this.store.getChat(chatId);
    if (!chat || chat.type !== 'group') throw Object.assign(new Error('Группа не найдена'), { status: 404 });
    if (!chat.members.includes(actorId)) throw Object.assign(new Error('Нет доступа'), { status: 403 });
    const actor = this.store.getUser(actorId);
    let addedCount = 0;
    for (const uid of userIds) {
      if (this.store.addMember(chat, uid)) {
        addedCount++;
        const u = this.store.getUser(uid);
        if (u) this.systemMessage(chat, actorId, `${actor.displayName} добавил(а) ${u.displayName}`);
      }
    }
    for (const uid of chat.members) this.hub.sendToUser(uid, { type: 'chat:upsert', payload: { chat: this.chatView(chat, uid) } });
    if (addedCount) this.emit(chat.members, 'chat:refresh', { chatId });
    return chat;
  }

  removeMember(actorId, chatId, userId) {
    const chat = this.store.getChat(chatId);
    if (!chat || chat.type !== 'group') throw Object.assign(new Error('Группа не найдена'), { status: 404 });
    if (!chat.members.includes(actorId)) throw Object.assign(new Error('Нет доступа'), { status: 403 });
    const actor = this.store.getUser(actorId);
    const target = this.store.getUser(userId);
    if (!target) throw Object.assign(new Error('Пользователь не найден'), { status: 404 });
    this.store.removeMember(chat, userId);
    const text = userId === actorId
      ? `${actor.displayName} покинул(а) группу`
      : `${actor.displayName} исключил(а) ${target.displayName}`;
    this.systemMessage(chat, actorId, text);
    for (const uid of [...chat.members, userId]) this.hub.sendToUser(uid, { type: 'chat:upsert', payload: { chat: this.chatView(chat, uid) } });
    this.hub.sendToUser(userId, { type: 'chat:removed', payload: { chatId } });
    this.emit(chat.members, 'chat:refresh', { chatId });
    return chat;
  }

  deleteChat(actorId, chatId) {
    const chat = this.store.getChat(chatId);
    if (!chat) throw Object.assign(new Error('Чат не найден'), { status: 404 });
    if (!chat.members.includes(actorId)) throw Object.assign(new Error('Нет доступа'), { status: 403 });
    if (chat.type === 'direct') {
      chat.hiddenFor = [...new Set([...(chat.hiddenFor || []), actorId])];
      this.store.save();
      this.hub.sendToUser(actorId, { type: 'chat:removed', payload: { chatId } });
    } else {
      this.removeMember(actorId, chatId, actorId);
    }
    return chat;
  }

  /** Бот присоединяется к группе, если его упомянули (@bot). */
  addBotToChat(botId, chatId) {
    const chat = this.store.getChat(chatId);
    const bot = this.store.getUser(botId);
    if (!chat || !bot || chat.members.includes(botId)) return false;
    if (chat.members.length >= MAX_GROUP_MEMBERS) return false;
    this.store.addMember(chat, botId);
    this.systemMessage(chat, botId, `${bot.displayName} присоединился к группе (его позвали)`);
    for (const uid of chat.members) this.hub.sendToUser(uid, { type: 'chat:upsert', payload: { chat: this.chatView(chat, uid) } });
    this.emit(chat.members, 'chat:refresh', { chatId });
    return true;
  }

  /* -------------------------------------------------------------- сообщения */

  /**
   * Вложение принимаем только то, что реально лежит в хранилище этого сервера.
   * Так в сообщение нельзя подсунуть ссылку на чужой сайт или на файл, которого нет,
   * а вместе с ним — ничего лишнего в базу.
   */
  normalizeAttachments(list) {
    const files = [];
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 10)) {
      if (!raw || typeof raw !== 'object') continue;
      const url = String(raw.url || '');
      const byId = raw.id ? this.store.data.uploadedFiles[raw.id] : null;
      const meta = byId || Object.values(this.store.data.uploadedFiles).find((f) => f && f.url === url) || null;
      if (!meta) throw Object.assign(new Error('Вложение не найдено: загрузите файл заново'), { status: 400 });
      const kind = ['image', 'video', 'audio', 'voice', 'file'].includes(raw.kind)
        ? raw.kind
        : (/^image\//.test(meta.mime) ? 'image' : /^video\//.test(meta.mime) ? 'video' : /^audio\//.test(meta.mime) ? 'audio' : 'file');
      files.push({
        id: meta.id, url: meta.url, name: meta.name, mime: meta.mime, size: meta.size, kind,
        duration: Number(raw.duration) || 0, width: Number(raw.width) || 0, height: Number(raw.height) || 0,
      });
    }
    return files;
  }

  sendMessage({ chatId, authorId, text, attachments = [], replyTo = null, clientId = null, system = false, createdAt }) {
    const chat = this.store.getChat(chatId);
    if (!chat) throw Object.assign(new Error('Чат не найден'), { status: 404 });
    const author = this.store.getUser(authorId);
    if (!author || !chat.members.includes(authorId)) throw Object.assign(new Error('Нет доступа к чату'), { status: 403 });
    const body = cleanText(text, 4096);
    const files = this.normalizeAttachments(attachments);
    if (!body && !files.length) throw Object.assign(new Error('Пустое сообщение'), { status: 400 });
    // Идемпотентность: если такое сообщение уже отправляли (повтор из очереди,
    // переподключение, двойной клик) — возвращаем прежнее, а не плодим дубль.
    if (clientId) {
      const duplicate = this.store.findByClientId(chatId, authorId, clientId);
      if (duplicate) return duplicate;
    }
    const msg = this.store.addMessage({ chatId, authorId, text: body, attachments: files, replyTo, clientId, system, createdAt });
    const view = this.publicMessage(msg);
    const event = { message: view, chatId };
    for (const uid of chat.members) {
      this.emit([uid], 'message:new', { ...event, chat: this.chatView(chat, uid) });
    }
    if (!system) {
      this.store.markRead(chatId, authorId, msg.id);
      for (const bot of this.bots) {
        try { bot.onMessage({ chat, message: view, author }); } catch (err) { console.error('[bot]', err.message); }
      }
    }
    return msg;
  }

  editMessage(actorId, messageId, text) {
    const msg = this.store.getMessage(messageId);
    if (!msg) throw Object.assign(new Error('Сообщение не найдено'), { status: 404 });
    if (msg.authorId !== actorId) throw Object.assign(new Error('Можно редактировать только свои сообщения'), { status: 403 });
    msg.text = cleanText(text, 4096);
    msg.editedAt = Date.now();
    this.store.save();
    const view = this.publicMessage(msg);
    this.emit(this.memberIds(msg.chatId), 'message:updated', { message: view, chatId: msg.chatId });
    return msg;
  }

  deleteMessage(actorId, messageId) {
    const msg = this.store.getMessage(messageId);
    if (!msg) throw Object.assign(new Error('Сообщение не найдено'), { status: 404 });
    const chat = this.store.getChat(msg.chatId);
    if (msg.authorId !== actorId && !(chat?.admins || []).includes(actorId)) {
      throw Object.assign(new Error('Нет прав удалить сообщение'), { status: 403 });
    }
    msg.deleted = true; msg.text = ''; msg.attachments = []; msg.reactions = {};
    this.store.save();
    const view = this.publicMessage(msg);
    this.emit(this.memberIds(msg.chatId), 'message:updated', { message: view, chatId: msg.chatId });
    return msg;
  }

  toggleReaction(actorId, messageId, emoji) {
    const msg = this.store.getMessage(messageId);
    if (!msg) throw Object.assign(new Error('Сообщение не найдено'), { status: 404 });
    const chat = this.store.getChat(msg.chatId);
    if (!chat?.members.includes(actorId)) throw Object.assign(new Error('Нет доступа'), { status: 403 });
    const key = String(emoji).slice(0, 8);
    msg.reactions = msg.reactions || {};
    const list = new Set(msg.reactions[key] || []);
    if (list.has(actorId)) list.delete(actorId); else list.add(actorId);
    if (list.size) msg.reactions[key] = [...list]; else delete msg.reactions[key];
    this.store.save();
    const view = this.publicMessage(msg);
    this.emit(this.memberIds(msg.chatId), 'message:updated', { message: view, chatId: msg.chatId });
    return msg;
  }

  pinMessage(actorId, messageId) {
    const msg = this.store.getMessage(messageId);
    if (!msg) throw Object.assign(new Error('Сообщение не найдено'), { status: 404 });
    const chat = this.store.getChat(msg.chatId);
    if (!chat?.members.includes(actorId)) throw Object.assign(new Error('Нет доступа'), { status: 403 });
    chat.pinnedMessages = chat.pinnedMessages || [];
    const idx = chat.pinnedMessages.indexOf(messageId);
    if (idx >= 0) chat.pinnedMessages.splice(idx, 1); else chat.pinnedMessages.unshift(messageId);
    chat.pinnedMessages = chat.pinnedMessages.slice(0, 20);
    this.store.save();
    for (const uid of chat.members) this.hub.sendToUser(uid, { type: 'chat:upsert', payload: { chat: this.chatView(chat, uid) } });
    return chat;
  }

  markRead(userId, chatId, lastMessageId) {
    const chat = this.store.getChat(chatId);
    if (!chat || !chat.members.includes(userId)) return null;
    const ids = this.store.messageIds(chatId);
    const current = this.store.readState(chatId, userId).lastMessageId || null;
    const currentIdx = current ? ids.indexOf(current) : -1;
    // Принимаем только настоящее сообщение ЭТОГО чата и только движение «вперёд»:
    // случайный или устаревший id не должен сбивать счётчики непрочитанных.
    const target = lastMessageId && ids.includes(lastMessageId) ? lastMessageId : null;
    if (!target || (currentIdx >= 0 && ids.indexOf(target) <= currentIdx)) {
      return this.store.readState(chatId, userId);
    }
    const read = this.store.markRead(chatId, userId, target);
    this.emit(chat.members, 'read', { chatId, userId, lastMessageId: read.lastMessageId, ts: read.ts });
    return read;
  }

  typing(userId, chatId, state) {
    const chat = this.store.getChat(chatId);
    if (!chat || !chat.members.includes(userId)) return;
    const user = this.store.getUser(userId);
    const targets = chat.members.filter((id) => id !== userId);
    for (const uid of targets) {
      this.hub.sendToUser(uid, { type: 'typing', payload: { chatId, userId, displayName: user.displayName, state: !!state } });
    }
  }

  /* ---------------------------------------------------------------- звонки */

  activeCallsFor(userId) {
    return Object.values(this.store.data.calls).filter((c) => c.members.includes(userId));
  }

  currentCall(chatId) {
    return Object.values(this.store.data.calls).find((c) => c.chatId === chatId) || null;
  }

  callView(call) {
    return {
      id: call.id, chatId: call.chatId, kind: call.kind, from: call.from,
      startedAt: call.startedAt,
      participants: call.participants.map((p) => ({
        userId: p.userId, joinedAt: p.joinedAt, muted: !!p.muted, camera: !!p.camera, screen: !!p.screen,
        user: this.store.publicUser(this.store.getUser(p.userId)),
      })),
    };
  }

  startCall(userId, chatId, kind = 'video') {
    const chat = this.store.getChat(chatId);
    if (!chat || !chat.members.includes(userId)) throw Object.assign(new Error('Нет доступа к чату'), { status: 403 });
    const existing = this.currentCall(chatId);
    if (existing) return existing;
    const id = newId('call');
    const call = {
      id, chatId, kind: kind === 'audio' ? 'audio' : 'video', from: userId,
      members: chat.members.slice(), participants: [{ userId, joinedAt: Date.now(), muted: false, camera: kind !== 'audio', screen: false }],
      startedAt: Date.now(), declined: [],
    };
    this.store.data.calls[id] = call;
    this.store.save();
    const targets = chat.members.filter((id) => id !== userId);
    for (const uid of targets) {
      this.hub.sendToUser(uid, { type: 'call:incoming', payload: { call: this.callView(call), chat: this.chatView(chat, uid) } });
    }
    return call;
  }

  joinCall(userId, callId) {
    const call = this.store.data.calls[callId];
    if (!call) throw Object.assign(new Error('Звонок уже завершён'), { status: 404 });
    if (!call.members.includes(userId)) throw Object.assign(new Error('Нет доступа'), { status: 403 });
    if (call.participants.length >= MAX_CALL_PEERS) throw Object.assign(new Error('В звонке слишком много участников'), { status: 400 });
    const others = call.participants.map((p) => p.userId);
    if (!others.includes(userId)) call.participants.push({ userId, joinedAt: Date.now(), muted: false, camera: call.kind !== 'audio', screen: false });
    call.declined = call.declined.filter((id) => id !== userId);
    this.store.save();
    for (const uid of others) this.hub.sendToUser(uid, { type: 'call:peer-joined', payload: { callId, userId, call: this.callView(call) } });
    return { call, existingPeers: others };
  }

  leaveCall(userId, callId) {
    const call = this.store.data.calls[callId];
    if (!call) return null;
    call.participants = call.participants.filter((p) => p.userId !== userId);
    if (call.participants.length === 0) {
      delete this.store.data.calls[callId];
      this.store.save();
      for (const uid of call.members) this.hub.sendToUser(uid, { type: 'call:ended', payload: { callId, reason: 'empty' } });
      return null;
    }
    this.store.save();
    for (const uid of call.members) this.hub.sendToUser(uid, { type: 'call:peer-left', payload: { callId, userId, call: this.callView(call) } });
    return call;
  }

  declineCall(userId, callId) {
    const call = this.store.data.calls[callId];
    if (!call) return;
    call.declined = [...new Set([...(call.declined || []), userId])];
    this.store.save();
    for (const p of call.participants) this.hub.sendToUser(p.userId, { type: 'call:peer-declined', payload: { callId, userId } });
    // если отказались все приглашённые — звонок завершается
    const pending = call.members.filter((m) => !call.participants.some((p) => p.userId === m) && !call.declined.includes(m));
    if (!pending.length && call.participants.length <= 1) {
      this.hub.sendToUser(call.participants[0]?.userId, { type: 'call:ended', payload: { callId, reason: 'declined' } });
      delete this.store.data.calls[callId];
      this.store.save();
    }
  }

  signalCall(fromUserId, { callId, to, data }) {
    const call = this.store.data.calls[callId];
    if (!call || !call.members.includes(fromUserId) || !call.members.includes(to)) return;
    this.hub.sendToUser(to, { type: 'call:signal', payload: { callId, from: fromUserId, data } });
  }

  updateCallState(userId, callId, patch = {}) {
    const call = this.store.data.calls[callId];
    if (!call) return;
    const p = call.participants.find((x) => x.userId === userId);
    if (!p) return;
    if ('muted' in patch) p.muted = !!patch.muted;
    if ('camera' in patch) p.camera = !!patch.camera;
    if ('screen' in patch) p.screen = !!patch.screen;
    this.store.save();
    for (const uid of call.members) {
      this.hub.sendToUser(uid, { type: 'call:state', payload: { call: this.callView(call) } });
    }
  }
}

module.exports = { Core, MAX_CALL_PEERS };
