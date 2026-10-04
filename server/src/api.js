'use strict';
/** REST-API: авторизация, профиль, чаты, история, загрузка файлов. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { signToken, verifyToken, cleanText, newId } = require('./util');

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/webm': '.webm', 'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'application/pdf': '.pdf',
  'text/plain': '.txt', 'application/zip': '.zip',
};

function createApi({ core, store, secret, config }) {
  const api = express.Router();
  const auth = (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
    const payload = verifyToken(token, secret);
    const user = payload && store.getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'Требуется авторизация' });
    req.user = user;
    next();
  };

  const wrap = (fn) => (req, res) => {
    try { fn(req, res); } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка' });
    }
  };

  api.get('/server/info', (req, res) => {
    res.json({
      ok: true,
      name: config.serverName,
      version: config.version,
      registrationOpen: config.registrationOpen,
      demoMode: config.demoMode,
      online: core.hub ? 0 : 0,
      users: Object.keys(store.data.users).length,
      chats: Object.keys(store.data.chats).length,
      messages: Object.keys(store.data.messages).length,
      build: config.buildDate || '',
      dataDir: config.dataDir,
      time: Date.now(),
    });
  });

  /* ------------------------------------------------------------ авторизация */

  api.post('/auth/register', wrap((req, res) => {
    if (!config.registrationOpen) return res.status(403).json({ error: 'Регистрация закрыта' });
    const { username, displayName, password, email } = req.body || {};
    const login = cleanText(username, 24).toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    if (login.length < 3) return res.status(400).json({ error: 'Логин: минимум 3 символа (a-z, 0-9, _ . -)' });
    if (!password || String(password).length < 4) return res.status(400).json({ error: 'Пароль: минимум 4 символа' });
    if (store.findUserByName(login)) return res.status(409).json({ error: 'Такой логин уже занят' });
    const user = store.createUser({ username: login, displayName: cleanText(displayName, 40) || login, password, email: cleanText(email, 80) });
    const token = signToken({ sub: user.id, login: user.username }, secret);
    res.json({ token, user: store.publicUser(user) });
  }));

  api.post('/auth/login', wrap((req, res) => {
    const { username, password } = req.body || {};
    const user = store.findUserByName(cleanText(username, 24).replace(/^@/, ''));
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    const { verifyPassword } = require('./util');
    if (!verifyPassword(password || '', user.salt, user.hash)) return res.status(401).json({ error: 'Неверный пароль' });
    user.lastSeen = Date.now();
    store.save();
    const token = signToken({ sub: user.id, login: user.username }, secret);
    res.json({ token, user: store.publicUser(user) });
  }));

  /** Демо-вход: выдаёт сессию под одним из демо-аккаунтов (для быстрого знакомства). */
  api.post('/auth/demo', wrap((req, res) => {
    if (!config.demoMode) return res.status(403).json({ error: 'Демо-режим выключен' });
    const demoUsers = Object.values(store.data.users).filter((u) => u.isDemo && !u.isBot);
    if (!demoUsers.length) return res.status(404).json({ error: 'Демо-аккаунтов нет' });
    const wanted = cleanText((req.body || {}).username, 24);
    const user = wanted ? (demoUsers.find((u) => u.username === wanted) || demoUsers[0]) : demoUsers[Math.floor(Math.random() * demoUsers.length)];
    const token = signToken({ sub: user.id, login: user.username }, secret);
    res.json({ token, user: store.publicUser(user), demoAccounts: demoUsers.map((u) => ({ username: u.username, displayName: u.displayName, color: u.color })) });
  }));

  api.get('/auth/demo/users', wrap((req, res) => {
    const demoUsers = Object.values(store.data.users).filter((u) => u.isDemo && !u.isBot);
    res.json({ accounts: demoUsers.map((u) => ({ username: u.username, displayName: u.displayName, color: u.color, bio: u.bio })) });
  }));

  api.get('/me', auth, (req, res) => res.json({ user: store.publicUser(req.user) }));

  api.patch('/me', auth, wrap((req, res) => {
    const b = req.body || {};
    if (typeof b.displayName === 'string' && b.displayName.trim()) req.user.displayName = cleanText(b.displayName, 40);
    if (typeof b.bio === 'string') req.user.bio = cleanText(b.bio, 240);
    if (typeof b.email === 'string') req.user.email = cleanText(b.email, 80);
    if (typeof b.phone === 'string') req.user.phone = cleanText(b.phone, 32);
    if ('avatar' in b) req.user.avatar = b.avatar ? String(b.avatar).slice(0, 400) : null;
    store.save();
    res.json({ user: store.publicUser(req.user) });
  }));

  /* -------------------------------------------------------------------- люди */

  api.get('/users', auth, wrap((req, res) => {
    const q = cleanText(req.query.q || '', 32).toLowerCase();
    const users = Object.values(store.data.users)
      .filter((u) => u.id !== req.user.id)
      .filter((u) => !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q))
      .slice(0, 60)
      .map((u) => ({ ...store.publicUser(u), isDemo: !!u.isDemo }));
    res.json({ users });
  }));

  api.get('/contacts', auth, wrap((req, res) => {
    const seen = new Map();
    for (const chat of store.chatsOf(req.user.id)) {
      if (chat.type !== 'direct') continue;
      for (const m of chat.members) if (m !== req.user.id) {
        const u = store.getUser(m);
        if (u && !seen.has(u.id)) seen.set(u.id, store.publicUser(u));
      }
    }
    if (req.user.contacts) for (const id of req.user.contacts) { const u = store.getUser(id); if (u) seen.set(u.id, store.publicUser(u)); }
    res.json({ contacts: [...seen.values()] });
  }));

  /* -------------------------------------------------------------------- чаты */

  api.get('/chats', auth, wrap((req, res) => {
    const chats = store.chatsOf(req.user.id)
      .filter((c) => !(c.hiddenFor || []).includes(req.user.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => core.chatView(c, req.user.id));
    res.json({ chats, seq: store.seq });
  }));

  api.post('/chats/direct', auth, wrap((req, res) => {
    const { userId } = req.body || {};
    if (!store.getUser(userId)) return res.status(404).json({ error: 'Пользователь не найден' });
    const chat = core.ensureDirectChat(req.user.id, userId);
    res.json({ chat: core.chatView(chat, req.user.id) });
  }));

  api.post('/chats/group', auth, wrap((req, res) => {
    const { title, memberIds = [], avatar = null } = req.body || {};
    const chat = core.createGroup(req.user.id, title, memberIds, avatar);
    res.json({ chat: core.chatView(chat, req.user.id) });
  }));

  api.get('/chats/:id', auth, wrap((req, res) => {
    const chat = store.getChat(req.params.id);
    if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Чат не найден' });
    res.json({ chat: core.chatView(chat, req.user.id) });
  }));

  api.patch('/chats/:id', auth, wrap((req, res) => {
    const chat = core.updateChat(req.user.id, req.params.id, req.body || {});
    res.json({ chat: core.chatView(chat, req.user.id) });
  }));

  api.post('/chats/:id/members', auth, wrap((req, res) => {
    const chat = core.addMembers(req.user.id, req.params.id, (req.body || {}).userIds || []);
    res.json({ chat: core.chatView(chat, req.user.id) });
  }));

  api.delete('/chats/:id/members/:userId', auth, wrap((req, res) => {
    const chat = core.removeMember(req.user.id, req.params.id, req.params.userId);
    res.json({ chat: core.chatView(chat, req.user.id) });
  }));

  api.delete('/chats/:id', auth, wrap((req, res) => {
    core.deleteChat(req.user.id, req.params.id);
    res.json({ ok: true });
  }));

  api.get('/chats/:id/messages', auth, wrap((req, res) => {
    const chat = store.getChat(req.params.id);
    if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Чат не найден' });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = req.query.before || null;
    const messages = before ? store.messagesBefore(chat.id, before, limit) : store.lastMessages(chat.id, limit);
    const hasMore = store.messageIds(chat.id).indexOf(messages[0]?.id) > 0;
    res.json({
      messages: messages.map((m) => core.publicMessage(m)),
      hasMore,
      chat: core.chatView(chat, req.user.id),
      seq: store.seq,
    });
  }));

  api.post('/chats/:id/messages', auth, wrap((req, res) => {
    const b = req.body || {};
    const msg = core.sendMessage({
      chatId: req.params.id, authorId: req.user.id, text: b.text,
      attachments: Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : [],
      replyTo: b.replyTo || null, clientId: b.clientId || null,
    });
    res.json({ message: core.publicMessage(msg) });
  }));

  api.post('/chats/:id/read', auth, wrap((req, res) => {
    const read = core.markRead(req.user.id, req.params.id, (req.body || {}).lastMessageId || null);
    res.json({ read });
  }));

  api.get('/chats/:id/search', auth, wrap((req, res) => {
    const chat = store.getChat(req.params.id);
    if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Чат не найден' });
    const q = cleanText(req.query.q || '', 64).toLowerCase();
    if (!q) return res.json({ results: [] });
    const results = store.messageIds(chat.id)
      .map((id) => store.getMessage(id))
      .filter((m) => m && !m.deleted && m.text.toLowerCase().includes(q))
      .slice(-100)
      .reverse()
      .slice(0, 50)
      .map((m) => core.publicMessage(m));
    res.json({ results });
  }));

  /**
   * История чатов: все сообщения из всех чатов пользователя (для панели «История»).
   * Параметры: q — поиск по тексту, chatId — только один чат, limit/offset — порции.
   */
  api.get('/history', auth, wrap((req, res) => {
    const q = cleanText(req.query.q || '', 64).toLowerCase();
    const onlyChat = String(req.query.chatId || '');
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const chats = store.chatsOf(req.user.id);
    const rows = [];
    for (const chat of chats) {
      if (onlyChat && chat.id !== onlyChat) continue;
      for (const id of store.messageIds(chat.id)) {
        const m = store.getMessage(id);
        if (!m || m.deleted) continue;
        if (m.system) continue;
        if (q && !String(m.text || '').toLowerCase().includes(q)) continue;
        rows.push({
          chatId: chat.id,
          chatTitle: chat.type === 'direct'
            ? ((store.getUser((chat.members || []).find((x) => x !== req.user.id)) || {}).displayName || chat.title || 'Личный чат')
            : (chat.title || 'Группа'),
          chatType: chat.type,
          message: core.publicMessage(m),
        });
      }
    }
    rows.sort((a, b) => (b.message.createdAt || 0) - (a.message.createdAt || 0));
    res.json({
      total: rows.length,
      chats: chats.length,
      messages: rows.slice(offset, offset + limit),
      hasMore: rows.length > offset + limit,
    });
  }));

  /* --------------------------------------------------------------- сообщения */

  api.patch('/messages/:id', auth, wrap((req, res) => {
    const m = core.editMessage(req.user.id, req.params.id, (req.body || {}).text);
    res.json({ message: core.publicMessage(m) });
  }));

  api.delete('/messages/:id', auth, wrap((req, res) => {
    core.deleteMessage(req.user.id, req.params.id);
    res.json({ ok: true });
  }));

  api.post('/messages/:id/reactions', auth, wrap((req, res) => {
    const m = core.toggleReaction(req.user.id, req.params.id, (req.body || {}).emoji || '+1');
    res.json({ message: core.publicMessage(m) });
  }));

  api.post('/messages/:id/pin', auth, wrap((req, res) => {
    core.pinMessage(req.user.id, req.params.id);
    res.json({ ok: true });
  }));

  /* ---------------------------------------------------------------- загрузка */

  api.post('/upload', auth, express.raw({ type: '*/*', limit: config.maxUploadMb * 1024 * 1024 }), wrap((req, res) => {
    const raw = req.body;
    if (!raw || !raw.length) return res.status(400).json({ error: 'Пустой файл' });
    const originalName = decodeURIComponent(req.headers['x-file-name'] || 'file');
    const mime = String(req.headers['x-file-mime'] || 'application/octet-stream').slice(0, 80);
    const id = newId('f');
    const ext = path.extname(originalName).slice(0, 8) || MIME_EXT[mime] || '.bin';
    const stored = id + ext;
    fs.mkdirSync(config.uploadDir, { recursive: true });
    fs.writeFileSync(path.join(config.uploadDir, stored), raw);
    const meta = { id, stored, name: cleanText(originalName, 120), mime, size: raw.length, ownerId: req.user.id, url: `/uploads/${stored}`, createdAt: Date.now() };
    store.data.uploadedFiles[id] = meta;
    store.save();
    const duration = Number(req.headers['x-duration']) || 0;
    const width = Number(req.headers['x-width']) || 0;
    const height = Number(req.headers['x-height']) || 0;
    res.json({ file: { id, url: meta.url, name: meta.name, mime, size: meta.size, duration, width, height } });
  }));

  return api;
}

module.exports = { createApi };
