'use strict';
/**
 * Простейшее надёжное хранилище: JSON-файл с отложенной атомарной записью.
 * Держим «горячие» индексы в памяти, чтобы поиск был O(1).
 */
const fs = require('fs');
const path = require('path');
const { newId, colorFor, hashPassword } = require('./util');

const EVENTS_KEPT = 40000;

class Store {
  constructor(file) {
    this.file = file;
    this.listeners = [];
    this.data = {
      version: 1,
      users: {},
      chats: {},
      messages: {},
      chatMessages: {},   // chatId -> [messageId] (по возрастанию времени)
      reads: {},          // `${chatId}:${userId}` -> { lastMessageId, ts }
      calls: {},          // активные звонки
      uploadedFiles: {},
      events: [],         // журнал событий для синхронизации
      seq: 0,
      createdAt: Date.now(),
    };
    this._dirty = false;
    this.load();
  }

  /* ---------------------------------------------------------------- файл */

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...parsed };
        // чистим незавершённые звонки после перезапуска
        this.data.calls = {};
      }
    } catch (err) {
      console.error('[store] не удалось прочитать базу, начинаем с чистой:', err.message);
      try { fs.renameSync(this.file, this.file + '.broken-' + Date.now()); } catch {}
    }
  }

  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 200);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] ошибка записи:', err.message);
    }
  }

  onFlush(fn) { this.listeners.push(fn); }

  /* --------------------------------------------------------------- люди */

  findUserByName(username) {
    const needle = String(username || '').toLowerCase();
    return Object.values(this.data.users).find((u) => u.username.toLowerCase() === needle) || null;
  }

  getUser(id) { return this.data.users[id] || null; }

  createUser({ username, displayName, password, isBot = false, bio = '', avatar = null }) {
    if (this.findUserByName(username)) throw Object.assign(new Error('Такой логин уже занят'), { status: 409 });
    const { salt, hash } = hashPassword(password || newId('pw'));
    const id = newId('u');
    const user = {
      id, username, displayName: displayName || username,
      salt, hash, bio, avatar, isBot,
      color: colorFor(username), createdAt: Date.now(), lastSeen: Date.now(),
      online: false,
    };
    this.data.users[id] = user;
    this.save();
    return user;
  }

  publicUser(user) {
    if (!user) return null;
    return {
      id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar,
      bio: user.bio || '', color: user.color, isBot: !!user.isBot,
      online: !!user.online, lastSeen: user.lastSeen || 0,
      email: user.email || '', phone: user.phone || '',
    };
  }

  /* --------------------------------------------------------------- чаты */

  createChat({ type, title, avatar, memberIds, createdBy, isDemo = false }) {
    const id = newId('c');
    const now = Date.now();
    const members = [...new Set(memberIds)];
    const chat = {
      id, type, title: title || '', avatar: avatar || null, members,
      createdBy, createdAt: now, updatedAt: now, isDemo,
      pinnedMessages: [], admins: type === 'group' ? [createdBy] : members,
      lastMessageId: null,
    };
    this.data.chats[id] = chat;
    this.data.chatMessages[id] = [];
    for (const m of members) this.data.reads[`${id}:${m}`] = { lastMessageId: null, ts: now };
    this.save();
    return chat;
  }

  getChat(id) { return this.data.chats[id] || null; }

  findDirectChat(a, b) {
    return Object.values(this.data.chats).find(
      (c) => c.type === 'direct' && c.members.length === 2 && c.members.includes(a) && c.members.includes(b)
    ) || null;
  }

  chatsOf(userId) {
    return Object.values(this.data.chats).filter((c) => c.members.includes(userId));
  }

  addMember(chat, userId) {
    if (chat.members.includes(userId)) return false;
    chat.members.push(userId);
    chat.updatedAt = Date.now();
    if (!this.data.reads[`${chat.id}:${userId}`]) this.data.reads[`${chat.id}:${userId}`] = { lastMessageId: null, ts: Date.now() };
    this.save();
    return true;
  }

  removeMember(chat, userId) {
    chat.members = chat.members.filter((m) => m !== userId);
    chat.admins = (chat.admins || []).filter((m) => m !== userId);
    chat.updatedAt = Date.now();
    delete this.data.reads[`${chat.id}:${userId}`];
    this.save();
    return true;
  }

  /* ----------------------------------------------------------- сообщения */

  addMessage(msg) {
    const id = newId('m');
    const full = {
      id, chatId: msg.chatId, authorId: msg.authorId || null, text: msg.text || '',
      attachments: msg.attachments || [], replyTo: msg.replyTo || null,
      reactions: {}, createdAt: msg.createdAt || Date.now(), editedAt: null,
      deleted: false, system: !!msg.system, clientId: msg.clientId || null,
    };
    this.data.messages[id] = full;
    (this.data.chatMessages[full.chatId] = this.data.chatMessages[full.chatId] || []).push(id);
    const chat = this.getChat(full.chatId);
    if (chat) { chat.lastMessageId = id; chat.updatedAt = full.createdAt; }
    this.save();
    if (full.clientId) this._clientIndex().set(this._clientKey(full.chatId, full.authorId, full.clientId), id);
    return full;
  }

  /* ------------------------------------------- защита от двойной отправки */

  _clientKey(chatId, authorId, clientId) { return `${chatId}|${authorId}|${clientId}`; }

  /**
   * Индекс «клиентский идентификатор → сообщение» строится один раз и обновляется
   * при добавлении. Нужен, чтобы повторная отправка (переподключение, повтор
   * из очереди, повторный клик) не создавала второй дубль сообщения.
   */
  _clientIndex() {
    if (this._clientIdx) return this._clientIdx;
    const map = new Map();
    for (const m of Object.values(this.data.messages)) {
      if (m && m.clientId) map.set(this._clientKey(m.chatId, m.authorId, m.clientId), m.id);
    }
    this._clientIdx = map;
    return map;
  }

  /** Уже есть сообщение от этого автора с таким clientId? */
  findByClientId(chatId, authorId, clientId) {
    if (!clientId) return null;
    const id = this._clientIndex().get(this._clientKey(chatId, authorId, clientId));
    return id ? this.getMessage(id) : null;
  }

  getMessage(id) { return this.data.messages[id] || null; }

  messageIds(chatId) { return this.data.chatMessages[chatId] || []; }

  /** Последние N сообщений чата (по возрастанию времени). */
  lastMessages(chatId, limit = 50) {
    const ids = this.messageIds(chatId);
    return ids.slice(Math.max(0, ids.length - limit)).map((id) => this.data.messages[id]).filter(Boolean);
  }

  /** Страница истории «вверх»: before — id сообщения, до которого грузим. */
  messagesBefore(chatId, beforeId, limit = 50) {
    const ids = this.messageIds(chatId);
    let end = ids.length;
    if (beforeId) {
      const idx = ids.indexOf(beforeId);
      if (idx >= 0) end = idx;
    }
    return ids.slice(Math.max(0, end - limit), end).map((id) => this.data.messages[id]).filter(Boolean);
  }

  lastMessage(chatId) {
    const ids = this.messageIds(chatId);
    return ids.length ? this.data.messages[ids[ids.length - 1]] : null;
  }

  /* ------------------------------------------------------------- прочтения */

  markRead(chatId, userId, lastMessageId) {
    const key = `${chatId}:${userId}`;
    const read = this.data.reads[key] || { lastMessageId: null, ts: 0 };
    if (lastMessageId && read.lastMessageId === lastMessageId) return read;
    this.data.reads[key] = { lastMessageId: lastMessageId || read.lastMessageId, ts: Date.now() };
    this.save();
    return this.data.reads[key];
  }

  readState(chatId, userId) { return this.data.reads[`${chatId}:${userId}`] || { lastMessageId: null, ts: 0 }; }

  readStates(chatId) {
    const out = {};
    for (const m of (this.getChat(chatId)?.members || [])) out[m] = this.readState(chatId, m);
    return out;
  }

  unreadCount(chatId, userId) {
    const ids = this.messageIds(chatId);
    // Служебные сообщения («Вася создал группу») прочитанными не считаются —
    // они не должны зажигать счётчик новых сообщений.
    const countable = (id) => {
      const m = this.data.messages[id];
      return m && !m.deleted && !m.system && m.authorId !== userId;
    };
    const { lastMessageId } = this.readState(chatId, userId);
    if (!lastMessageId) return ids.filter(countable).length;
    const idx = ids.indexOf(lastMessageId);
    if (idx < 0) return 0;
    return ids.slice(idx + 1).filter(countable).length;
  }

  /* ------------------------------------------------------------ синхронизация */

  pushEvent(userIds, type, payload) {
    const seq = ++this.data.seq;
    this.data.events.push({ seq, users: userIds, type, payload, ts: Date.now() });
    if (this.data.events.length > EVENTS_KEPT) this.data.events.splice(0, this.data.events.length - EVENTS_KEPT);
    this.save();
    return seq;
  }

  eventsSince(userId, since, limit = 5000) {
    return this.data.events.filter((e) => e.seq > since && e.users.includes(userId)).slice(0, limit);
  }

  get seq() { return this.data.seq; }
}

module.exports = { Store };
