/* ==========================================================================
   Мессенджер «Контур» — клиент
   Разделы: утилиты → состояние → REST/WS → список чатов → сообщения →
            вложения → эмодзи → панели → модалки → звонки (call.js) → старт
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pad = (n) => String(n).padStart(2, '0');
  const now = () => Date.now();

  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtDay(ts) {
    const d = new Date(ts);
    const today = dayKey(now()), yest = dayKey(now() - 864e5);
    const key = dayKey(ts);
    if (key === today) return 'Сегодня';
    if (key === yest) return 'Вчера';
    const opts = { day: 'numeric', month: 'long' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('ru-RU', opts);
  }
  function fmtChatTime(ts) {
    if (!ts) return '';
    if (dayKey(ts) === dayKey(now())) return fmtTime(ts);
    if (dayKey(ts) === dayKey(now() - 864e5)) return 'вчера';
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }
  function fmtBytes(n) {
    if (!n) return '';
    const u = ['Б', 'КБ', 'МБ', 'ГБ'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
  }
  function fmtLastSeen(user) {
    if (!user) return '';
    if (user.online) return 'онлайн';
    if (!user.lastSeen) return 'был(а) недавно';
    const diff = now() - user.lastSeen;
    if (diff < 60e3) return 'был(а) недавно';
    if (diff < 3600e3) return `был(а) ${Math.round(diff / 60e3)} мин назад`;
    if (dayKey(user.lastSeen) === dayKey(now())) return `был(а) в ${fmtTime(user.lastSeen)}`;
    return `был(а) ${fmtDay(user.lastSeen).toLowerCase()}`;
  }
  const EMOJI_ONLY_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D|\s){1,12}$/u;
  function markup(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(https?:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return (parts[0][0] || '?').toUpperCase() + (parts[1] ? parts[1][0].toUpperCase() : '');
  }
  function avatarURL(user) {
    if (!user) return null;
    const a = user.avatar;
    if (!a) return null;
    if (a.startsWith('data:') || a.startsWith('http') || a.startsWith('/')) return a;
    return null;
  }
  function avatarHTML(user, extraCls = '', withStatus = false, id = '') {
    const cls = `avatar ${extraCls}`.trim();
    const idAttr = id ? ` id="${id}"` : '';
    if (!user) return `<div class="${cls}"${idAttr}>?</div>`;
    const url = avatarURL(user);
    const emojiAv = !url && user.avatar && !/^[a-z0-9\s]{1,3}$/i.test(user.avatar) ? user.avatar : null;
    const bg = url ? '' : `background:linear-gradient(135deg, ${user.color || '#6c8cff'}, ${shade(user.color || '#6c8cff', -28)})`;
    const inner = url ? `<img src="${esc(url)}" alt="">` : (emojiAv ? `<span>${esc(emojiAv)}</span>` : esc(initials(user.displayName || user.username)));
    const status = withStatus && !user.isBot ? `<span class="status-dot ${user.online ? 'online' : ''}"></span>` : '';
    return `<div class="${cls} ${emojiAv ? 'emoji-av' : ''}"${idAttr} style="${bg}" title="${esc(user.displayName || '')}"><span class="av-inner">${inner}</span>${status}</div>`;
  }
  function shade(hex, percent) {
    const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return hex;
    const f = (v) => Math.max(0, Math.min(255, parseInt(v, 16) + percent));
    return `#${[m[1], m[2], m[3]].map((c) => f(c).toString(16).padStart(2, '0')).join('')}`;
  }

  /* ------------------------------------------------------------------ state */
  const S = {
    token: localStorage.getItem('k.token') || null,
    me: null,
    users: new Map(),
    chats: new Map(),
    messages: new Map(),
    activeId: null,
    seq: 0,
    online: new Set(),
    typing: new Map(),
    drafts: new Map(),
    replyTo: null,
    editing: null,
    pendingFiles: [],
    outbox: JSON.parse(localStorage.getItem('k.outbox') || '[]'),
    filter: 'all',
    demoMode: false,        // включает сервер флагом --demo (демо-аккаунты и бот)
    usersCache: [],
    call: null,
    settings: Object.assign({ theme: 'dark', notifications: true, sounds: true, enterSends: true, previews: true },
      JSON.parse(localStorage.getItem('k.settings') || '{}')),
  };
  const conn = { ws: null, state: 'offline', retry: 0, timer: null, ping: 0, sent: 0 };
  const lists = () => S.messages;

  function saveOutbox() { localStorage.setItem('k.outbox', JSON.stringify(S.outbox.slice(-200))); }
  function saveSettings() { localStorage.setItem('k.settings', JSON.stringify(S.settings)); }
  function seqKey() { return 'k.seq.' + (S.me ? S.me.id : 'anon'); }

  /* ------------------------------------------------------------- кэш IndexedDB */
  const idb = {
    db: null,
    async open() {
      if (this.db) return this.db;
      return new Promise((resolve) => {
        try {
          const req = indexedDB.open('kontur', 1);
          req.onupgradeneeded = () => { req.result.createObjectStore('messages', { keyPath: 'chatId' }); };
          req.onsuccess = () => { this.db = req.result; resolve(this.db); };
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    },
    async put(chatId, messages) {
      const db = await this.open(); if (!db) return;
      try { db.transaction('messages', 'readwrite').objectStore('messages').put({ chatId, messages: messages.slice(-300) }); } catch {}
    },
    async get(chatId) {
      const db = await this.open(); if (!db) return null;
      return new Promise((resolve) => {
        try {
          const r = db.transaction('messages').objectStore('messages').get(chatId);
          r.onsuccess = () => resolve(r.result ? r.result.messages : null);
          r.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    },
  };

  /* --------------------------------------------------------------------- REST */
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, S.token ? { Authorization: 'Bearer ' + S.token } : {}, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error((data && data.error) || ('HTTP ' + res.status)), { status: res.status, data });
    return data || {};
  }

  function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
      xhr.setRequestHeader('X-File-Mime', file.type || 'application/octet-stream');
      if (file._duration) xhr.setRequestHeader('X-Duration', String(Math.round(file._duration)));
      xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
          else reject(new Error(data.error || 'Ошибка загрузки'));
        } catch (err) { reject(err); }
      };
      xhr.onerror = () => reject(new Error('Сеть недоступна'));
      xhr.send(file);
    });
  }

  /* ------------------------------------------------------------------- тосты */
  function toast(text, kind = '', ms = 3800) {
    const node = document.createElement('div');
    node.className = 'toast ' + kind;
    node.textContent = text;
    $('#toasts').appendChild(node);
    setTimeout(() => { node.style.opacity = '0'; node.style.transform = 'translateX(20px)'; node.style.transition = '.3s'; }, ms - 300);
    setTimeout(() => node.remove(), ms);
  }

  /* ------------------------------------------------------------------ звуки */
  let audioCtx = null;
  function beep(kind = 'in') {
    if (!S.settings.sounds) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const notes = kind === 'in' ? [[880, 0], [1240, .11]] : kind === 'out' ? [[660, 0], [520, .1]] : [[520, 0], [780, .12], [1040, .24]];
      for (const [freq, off] of notes) {
        const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t + off);
        gain.gain.linearRampToValueAtTime(.08, t + off + .02);
        gain.gain.exponentialRampToValueAtTime(.0001, t + off + .28);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t + off); osc.stop(t + off + .3);
      }
    } catch {}
  }

  /* --------------------------------------------------------------------- чаты */
  function upsertChat(chat) { if (chat) { S.chats.set(chat.id, chat); } }
  function getChat(id) { return S.chats.get(id); }
  function chatList() {
    return [...S.chats.values()].sort((a, b) => (b.lastMessage ? b.lastMessage.createdAt : b.updatedAt) - (a.lastMessage ? a.lastMessage.createdAt : a.updatedAt));
  }
  function previewText(msg) {
    if (!msg) return 'Нет сообщений';
    if (msg.system) return msg.text;
    const atts = msg.attachments || [];
    const kind = atts[0] && atts[0].kind;
    const prefix = atts.length ? ({ image: '🖼 Фото', video: '🎬 Видео', voice: '🎤 Голосовое', audio: '🎵 Аудио' }[kind] || '📎 Файл') + (msg.text ? ': ' : '') : '';
    return prefix + (msg.text || '');
  }
  function matchFilter(chat) {
    if (S.filter === 'unread') return chat.unread > 0;
    if (S.filter === 'groups') return chat.type === 'group';
    if (S.filter === 'bots') return chat.members.some((m) => m.isBot);
    if (S.filter === 'saved') return chat.type === 'direct' && chat.memberIds.length === 1;
    return true;
  }

  function renderChats() {
    const q = ($('#search').value || '').trim().toLowerCase();
    const clearBtn = $('#btn-search-clear');
    if (clearBtn) clearBtn.hidden = !q;
    const items = chatList().filter((c) => {
      if (!matchFilter(c)) return false;
      if (!q) return true;
      if (c.title.toLowerCase().includes(q)) return true;
      return (c.members || []).some((m) => (m.displayName + ' ' + m.username).toLowerCase().includes(q));
    });
    const box = $('#chat-list');
    if (!items.length) {
      box.innerHTML = `<div style="padding:26px;text-align:center;color:var(--text-2);font-size:13.5px">
        ${q ? 'Ничего не найдено' : (S.filter === 'unread' ? 'Все прочитано 🎉' : 'Чатов пока нет')}</div>`;
      return;
    }
    box.innerHTML = items.map((c) => {
      const last = c.lastMessage;
      const typingUsers = typingNames(c.id);
      const preview = typingUsers.length
        ? `<span class="typing-mini">${esc(typingUsers[0])} печатает…</span>`
        : `<span class="chat-item-preview">${last && last.author ? `<span class="author">${esc(last.authorId === (S.me && S.me.id) ? 'Вы' : last.author.displayName.split(' ')[0])}:</span> ` : ''}${esc(previewText(last)).slice(0, 90)}</span>`;
      const avatar = c.type === 'direct' && c.peer
        ? avatarHTML(c.peer, '', true)
        : `<div class="avatar" style="background:linear-gradient(135deg, ${c.color}, ${shade(c.color, -30)})">${esc(initials(c.title))}</div>`;
      return `<div class="chat-item ${c.id === S.activeId ? 'active' : ''}" data-chat="${c.id}">
        ${avatar}
        <div class="chat-item-body">
          <div class="chat-item-top">
            <span class="chat-item-name">${esc(c.title)}${c.isDemo ? '' : ''}${c.type === 'group' ? ' <span style="opacity:.5;font-size:12px">#' + c.members.length + '</span>' : ''}</span>
            <span class="chat-item-time">${last ? fmtChatTime(last.createdAt) : ''}</span>
          </div>
          <div class="chat-item-bottom">
            ${preview}
            ${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    updateTitle();
  }

  function updateTitle() {
    const total = [...S.chats.values()].reduce((a, c) => a + (c.unread || 0), 0);
    document.title = (total ? `(${total}) ` : '') + 'Мессенджер «Контур»';
  }

  async function loadChats() {
    try {
      const data = await api('/chats');
      const keep = new Set();
      for (const c of data.chats) { upsertChat(c); keep.add(c.id); }
      for (const id of [...S.chats.keys()]) if (!keep.has(id)) { S.chats.delete(id); if (S.activeId === id) closeChat(); }
      renderChats();
      if (S.activeId) renderChatHeader();
    } catch (err) { console.warn('loadChats', err.message); }
  }

  async function openChat(chatId) {
    if (!chatId) return;
    S.activeId = chatId;
    document.body.classList.add('chat-open');
    $('#app').classList.add('chat-open');
    $('#empty-state').hidden = true;
    $('#chat-view').hidden = false;
    $('#search-bar').hidden = true;
    $('#search-results').hidden = true;

    const cached = await idb.get(chatId);
    if (cached && cached.length && !(lists().get(chatId) || []).length) lists().set(chatId, cached);
    renderChatHeader();
    renderPinned();
    renderMessages(true);
    $('#input').value = S.drafts.get(chatId) || '';
    autoGrow();
    resizeInput();
    renderChats();

    try {
      const data = await api(`/chats/${chatId}/messages?limit=60`);
      upsertChat(data.chat);
      mergeMessages(chatId, data.messages);
      S.hasMore = S.hasMore || {};
      S.hasMore[chatId] = data.hasMore;
      renderMessages(true);
      renderPinned();
      renderChatHeader();
      renderChats();
      idb.put(chatId, lists().get(chatId));
      markRead();
    } catch (err) {
      if (err.status === 404) { toast('Чат недоступен', 'err'); closeChat(); }
      else toast('Не удалось загрузить историю: ' + err.message, 'err');
    }
    if (window.innerWidth > 760) $('#input').focus();
  }

  function closeChat() {
    S.activeId = null;
    document.body.classList.remove('chat-open');
    $('#app').classList.remove('chat-open');
    $('#chat-view').hidden = true;
    $('#empty-state').hidden = false;
    renderChats();
  }

  function normalize(m) {
    if (m && m.attachments) m.attachments = m.attachments.map((a) => Object.assign({ kind: guessKind(a) }, a));
    return m;
  }
  function guessKind(att) {
    if (att.kind) return att.kind;
    const mime = att.mime || '';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return (att.duration && att.duration < 65 && att.name && /voice|голос/i.test(att.name)) ? 'voice' : 'audio';
    return 'file';
  }

  /* ---------------------------------------------------------------- сообщения */
  function getList(chatId) { return lists().get(chatId) || []; }

  /**
   * Добавляет сообщения в список чата, склеивая по id.
   * Именно тут раньше появлялись дубли: при клике на цитату ответа
   * история догружалась и приклеивалась заново.
   */
  function mergeMessages(chatId, incoming) {
    const map = new Map();
    for (const m of getList(chatId)) map.set(m.id, m);
    for (const raw of incoming || []) {
      const m = normalize(raw);
      const existing = map.get(m.id);
      map.set(m.id, existing ? Object.assign(existing, m) : m);
    }
    const list = [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
    lists().set(chatId, list.slice(-800));
    return list;
  }

  function upsertMessage(msg) {
    msg = normalize(msg);
    const list = getList(msg.chatId);
    const byId = list.findIndex((m) => m.id === msg.id);
    if (byId >= 0) { list[byId] = Object.assign(list[byId], msg); }
    else {
      const byClient = msg.clientId ? list.findIndex((m) => m.clientId && m.clientId === msg.clientId) : -1;
      if (byClient >= 0) list[byClient] = Object.assign({}, msg);
      else list.push(msg);
      list.sort((a, b) => a.createdAt - b.createdAt);
    }
    lists().set(msg.chatId, list.slice(-600));
    if (msg.chatId === S.activeId) renderMessages();
    const chat = getChat(msg.chatId);
    if (chat && (!chat.lastMessage || msg.createdAt >= chat.lastMessage.createdAt)) {
      chat.lastMessage = msg;
      chat.updatedAt = msg.createdAt;
      renderChats();
    }
  }

  function isNearBottom() {
    const box = $('#messages');
    return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  }
  function scrollToBottom(smooth) {
    const box = $('#messages');
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
  function scrollToMessage(id) {
    const node = $(`[data-msg="${id}"]`);
    if (!node) return false;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('highlight');
    setTimeout(() => node.classList.remove('highlight'), 1700);
    return true;
  }

  function msgHTML(m, prev, chat) {
    const mine = S.me && m.authorId === S.me.id;
    if (m.deleted) return '';
    if (m.system) return `<div class="msg-system"><span>${esc(m.text)}</span></div>`;
    const list = getList(m.chatId);
    const idx = list.findIndex((x) => x.id === m.id);
    let dayHTML = '';
    if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) {
      const sep = `<div class="day-sep"><span>${fmtDay(m.createdAt)}</span></div>`;
      dayHTML = (list[idx - 1] && list[idx - 1].unreadMark) ? sep : sep;
    }
    const grouped = prev && prev.authorId === m.authorId && prev.createdAt && (m.createdAt - prev.createdAt) < 5 * 60e3 && dayKey(prev.createdAt) === dayKey(m.createdAt) && !prev.system;
    const author = m.author || { displayName: 'Неизвестный', color: '#888' };
    const isEmojiOnly = m.text && EMOJI_ONLY_RE.test(m.text.trim());
    const atts = (m.attachments || []).map((a) => attachmentHTML(a)).join('');
    const showAuthor = chat.type === 'group' && !mine && !grouped;

    // галочки доставки/прочтения
    let ticks = '';
    if (mine) {
      const others = chat.memberIds.filter((id) => id !== m.authorId);
      const states = chat.readStates || {};
      const readByAll = others.length > 0 && others.every((id) => {
        const st = states[id];
        if (!st || !st.lastMessageId) return false;
        const ids = getList(chat.id).map((x) => x.id);
        return ids.indexOf(st.lastMessageId) >= ids.indexOf(m.id);
      });
      ticks = `<span class="ticks ${readByAll ? 'read' : ''}" title="${readByAll ? 'Прочитано' : 'Доставлено'}">${readByAll ? '✓✓' : '✓'}</span>`;
    }
    const reactions = Object.entries(m.reactions || {}).map(([emo, users]) => {
      const mineR = S.me && users.includes(S.me.id);
      return `<span class="reaction ${mineR ? 'mine' : ''}" data-react="${esc(emo)}" data-id="${m.id}" title="${users.length}">${esc(emo)} ${users.length}</span>`;
    }).join('');
    const reply = m.replyTo ? replyQuoteHTML(m.replyTo) : '';
    const pending = m.pending ? ' pending' : '';

    return `${dayHTML}<div class="msg ${mine ? 'own' : ''} ${grouped ? 'grouped' : ''}${pending}" data-msg="${m.id}">
      ${grouped ? '<div class="avatar msg-avatar hidden"></div>' : avatarHTML(author, 'msg-avatar', chat.type === 'direct')}
      <div class="bubble">
        <div class="msg-actions">
          <button data-act="react" data-id="${m.id}" title="Реакция">😊</button>
          <button data-act="reply" data-id="${m.id}" title="Ответить">↩</button>
          ${mine ? `<button data-act="edit" data-id="${m.id}" title="Изменить">✏️</button>` : ''}
          <button data-act="pin" data-id="${m.id}" title="Закрепить">📌</button>
          <button data-act="more" data-id="${m.id}" title="Ещё">⋯</button>
        </div>
        ${showAuthor ? `<div class="bubble-head"><span class="bubble-author">${esc(author.displayName)}${author.isBot ? ' 🤖' : ''}</span></div>` : ''}
        ${reply}
        ${atts}
        ${m.text ? `<div class="bubble-text ${isEmojiOnly ? 'emoji-only' : ''}">${markup(m.text)}</div>` : ''}
        <div class="bubble-meta">
          ${m.editedAt ? '<span class="edited">изменено</span>' : ''}
          <span>${fmtTime(m.createdAt)}</span>${ticks}
        </div>
        ${reactions ? `<div class="reactions">${reactions}</div>` : ''}
      </div>
    </div>`;
  }

  function replyQuoteHTML(reply) {
    const author = reply.author ? reply.author.displayName : 'Сообщение';
    const text = reply.text || (reply.attachments && reply.attachments.length ? '📎 вложение' : '');
    return `<div class="reply-quote" data-jump="${reply.id}"><b>${esc(author)}</b><span>${esc(text).slice(0, 180)}</span></div>`;
  }

  function attachmentHTML(a) {
    const url = esc(a.url);
    const name = esc(a.name || 'файл');
    if (a.kind === 'image') return `<div class="att-image"><img src="${url}" alt="${name}" loading="lazy" data-lightbox="${url}"></div>`;
    if (a.kind === 'video') return `<div class="att-video"><video src="${url}" controls preload="metadata"></video></div>`;
    if (a.kind === 'voice') return `<div class="att-voice"><button data-voice="${url}">▶</button><audio src="${url}" preload="metadata"></audio><span>${fmtDuration(a.duration)} · голосовое</span></div>`;
    if (a.kind === 'audio') return `<div class="att-audio"><audio src="${url}" controls preload="metadata"></audio><span style="font-size:12.5px">${name}</span></div>`;
    const ext = (a.name || '').split('.').pop().slice(0, 4).toUpperCase();
    return `<a class="att-file" href="${url}" download="${name}" target="_blank" rel="noopener">
      <div class="f-ico">${esc(ext || 'FILE')}</div>
      <div><div class="f-name">${name}</div><div class="f-size">${fmtBytes(a.size)}</div></div>
    </a>`;
  }

  function renderMessages(resetScroll) {
    const chatId = S.activeId;
    if (!chatId) return;
    const chat = getChat(chatId) || { type: 'direct', memberIds: [], readStates: {} };
    const list = getList(chatId);
    const stick = resetScroll ? true : isNearBottom();
    const html = [];
    let prev = null;
    for (const m of list) {
      html.push(msgHTML(m, prev, chat));
      prev = m;
    }
    $('#messages-inner').innerHTML = html.join('');
    S.hasMore = S.hasMore || {};
    $('#btn-load-more').hidden = !S.hasMore[chatId];
    if (stick) scrollToBottom(false);
    $('#btn-scroll-down').hidden = true;
  }

  /* ------------------------------------------------------------ заголовок чата */
  function renderChatHeader() {
    const chat = getChat(S.activeId);
    if (!chat) return;
    const isDirect = chat.type === 'direct';
    const peer = chat.peer;
    const avEl = $('#chat-avatar');
    if (avEl) avEl.outerHTML = isDirect && peer
      ? avatarHTML(peer, 'sm', true, 'chat-avatar')
      : `<div class="avatar sm" id="chat-avatar" style="background:linear-gradient(135deg, ${chat.color}, ${shade(chat.color, -30)})">${esc(initials(chat.title))}</div>`;
    $('#chat-name').textContent = chat.title;
    const typing = typingNames(chat.id);
    const sub = $('#chat-sub');
    if (typing.length) { sub.textContent = typing.slice(0, 3).join(', ') + ' печатает…'; sub.classList.add('typing'); }
    else {
      sub.classList.remove('typing');
      const online = chat.members.filter((m) => m.online).length;
      sub.textContent = isDirect
        ? fmtLastSeen(peer)
        : `${chat.members.length} участников · ${online} онлайн`;
    }
    $('#chat-view').dataset.type = chat.type;
    $('#btn-call-audio').hidden = false;
  }

  function renderPinned() {
    const chat = getChat(S.activeId);
    const bar = $('#pin-bar');
    if (!chat || !(chat.pinnedMessages || []).length) { bar.hidden = true; return; }
    const id = chat.pinnedMessages[0];
    const msg = getList(chat.id).find((m) => m.id === id);
    if (!msg) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<span class="pin-ico">📌</span><div class="pin-body"><div class="pin-title">Закреплённое сообщение (${chat.pinnedMessages.length})</div>
      <div class="pin-text">${esc((msg.author ? msg.author.displayName + ': ' : '') + (msg.text || '📎 вложение'))}</div></div>`;
    bar.onclick = () => scrollToMessage(id);
  }

  /* -------------------------------------------------------------- отправка */
  function makeClientId() { return 'tmp_' + Math.random().toString(36).slice(2) + now().toString(36); }

  function sendMessage() {
    const chatId = S.activeId;
    if (!chatId) return;
    const text = $('#input').value.trim();
    const files = S.pendingFiles.filter((f) => f.uploaded);
    const stillUploading = S.pendingFiles.some((f) => !f.uploaded);
    if (stillUploading) { toast('Дождитесь загрузки файлов…'); return; }

    if (S.editing) {
      const id = S.editing;
      S.editing = null;
      $('#composer-hint').textContent = '';
      wsSend({ type: 'message:edit', payload: { id, text } });
      const list = getList(chatId);
      const m = list.find((x) => x.id === id);
      if (m) { m.text = text; m.editedAt = now(); renderMessages(); }
      $('#input').value = ''; S.drafts.set(chatId, ''); autoGrow();
      return;
    }
    if (!text && !files.length) return;

    postMessage(chatId, text, files.map((f) => ({
      id: f.id, url: f.url, name: f.name, mime: f.mime, size: f.size,
      duration: f._duration || 0, width: f.width || 0, height: f.height || 0, kind: f.kind,
    })));
    S.pendingFiles = [];
    renderUploadPreview();
    $('#input').value = '';
    S.drafts.set(chatId, '');
    autoGrow();
  }

  /** Единая точка отправки: оптимистичная отрисовка + сокет/офлайн-очередь. */
  function postMessage(chatId, text, attachments, opts = {}) {
    const replyTo = opts.replyTo !== undefined ? opts.replyTo : S.replyTo;
    const payload = {
      type: 'message:send',
      payload: { chatId, text, attachments, replyTo, clientId: makeClientId() },
    };
    const clientId = payload.payload.clientId;
    const optimistic = {
      id: clientId, chatId, authorId: S.me.id, author: S.me, text: text || '',
      attachments, replyTo: replyTo ? replyQuoteData(replyTo) : null,
      reactions: {}, createdAt: now(), pending: true, clientId,
    };
    lists().set(chatId, getList(chatId).concat([optimistic]).sort((a, b) => a.createdAt - b.createdAt));

    if (conn.ws && conn.ws.readyState === 1) {
      if (!wsSend(payload)) queueOffline(payload.payload);
    } else {
      queueOffline(payload.payload);
    }
    S.replyTo = null;
    renderReplyPreview();
    beep('out');
    if (chatId === S.activeId) { renderMessages(false); scrollToBottom(true); }
    return clientId;
  }

  function replyQuoteData(id) {
    const m = getList(S.activeId).find((x) => x.id === id);
    if (!m) return null;
    return { id: m.id, author: m.author || S.me, text: m.text || '', attachments: m.attachments || [] };
  }

  function queueOffline(payload) {
    S.outbox.push(payload);
    saveOutbox();
    showOfflineBanner(true);
  }

  function flushOutbox() {
    if (!S.outbox.length) return;
    const items = S.outbox.slice();
    S.outbox = [];
    saveOutbox();
    for (const p of items) wsSend({ type: 'message:send', payload: p });
    toast(`Отправлено отложенных сообщений: ${items.length}`, 'ok');
  }

  function wsSend(obj) {
    if (!conn.ws || conn.ws.readyState !== 1) return false;
    try { conn.ws.send(JSON.stringify(obj)); conn.sent++; return true; } catch { return false; }
  }
  // модуль звонков (call.js) пользуется тем же соединением
  window.__konturSend = wsSend;

  function request(type, payload) {
    const requestId = 'r' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingRequests.delete(requestId); reject(new Error('Таймаут запроса')); }, 8000);
      pendingRequests.set(requestId, { resolve, reject, timer });
      if (!wsSend({ type, payload, requestId })) { clearTimeout(timer); pendingRequests.delete(requestId); reject(new Error('Нет соединения')); }
    });
  }
  const pendingRequests = new Map();

  /* ------------------------------------------------------------------- вебсокет */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(S.token || '')}`;
    let ws;
    try { ws = new WebSocket(url); } catch { return scheduleReconnect(); }
    conn.ws = ws;
    setConnState('connecting');

    ws.onopen = () => {
      conn.retry = 0;
      setConnState('online');
      const since = Number(localStorage.getItem(seqKey()) || 0);
      wsSend({ type: 'sync', payload: { since } });
      flushOutbox();
      for (const c of S.chats.values()) if (c.offlinePending) delete c.offlinePending;
      renderChats();
    };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleEvent(msg);
    };
    ws.onclose = () => { setConnState('offline'); scheduleReconnect(); };
    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    if (conn.timer) return;
    const delay = Math.min(15000, 800 * Math.pow(1.6, conn.retry++));
    conn.timer = setTimeout(() => { conn.timer = null; if (S.token) connect(); }, delay);
    setConnState('offline');
  }

  function setConnState(state) {
    conn.state = state;
    const banner = $('#offline-banner');
    banner.hidden = state === 'online';
    if (state === 'connecting') banner.textContent = '🔄 Соединение…';
    if (state === 'offline') banner.textContent = '⚡️ Нет соединения с сервером — сообщения отправятся автоматически';
    const st = $('#me-status');
    if (st && S.me) { st.textContent = state === 'online' ? 'онлайн' : (state === 'connecting' ? 'подключение…' : 'офлайн'); st.classList.toggle('online', state === 'online'); }
  }

  function setSeq(seq) {
    if (seq && seq > S.seq) { S.seq = seq; localStorage.setItem(seqKey(), String(seq)); }
  }

  function handleEvent(msg) {
    const p = msg.payload || {};
    if (msg.seq) setSeq(msg.seq);
    switch (msg.type) {
      case 'hello': break;
      case 'ready': {
        S.me = p.me;
        applyTheme();
        $('#me-name').textContent = p.me.displayName;
        $('#me-avatar').outerHTML = avatarHTML(p.me, '', true, 'me-avatar');
        setSeq(p.seq);
        if (p.devices > 1) toast(`Устройств в сети: ${p.devices} — синхронизация включена`);
        if (p.calls && p.calls.length) {
          const c = p.calls[0];
          const chat = getChat(c.chatId);
          const el = document.createElement('div');
          el.innerHTML = `<div class="toast">🎥 В чате «${esc(chat ? chat.title : 'группа')}» идёт звонок. <button class="btn sm primary" id="join-call">Присоединиться</button></div>`;
          $('#toasts').appendChild(el.lastChild);
          $('#join-call').onclick = () => { el.lastChild.remove(); openChat(c.chatId); wsSend({ type: 'call:join', payload: { callId: c.id } }); };
        }
        break;
      }
      case 'sync:events': for (const ev of (p.events || [])) applyRemote(ev.type, ev.payload, true); break;
      case 'sync:done': setSeq(p.to); loadChats().then(() => { if (S.activeId) refreshActiveMessages(); }); break;
      case 'ok': {
        const r = pendingRequests.get(p.requestId);
        if (r) { clearTimeout(r.timer); pendingRequests.delete(p.requestId); r.resolve(p); }
        break;
      }
      case 'error': {
        toast(p.message || 'Ошибка', 'err');
        const r = pendingRequests.get(p.requestId);
        if (r) { clearTimeout(r.timer); pendingRequests.delete(p.requestId); r.reject(new Error(p.message)); }
        if (p.request === 'message:send' && p.payload && p.payload.clientId) removeOptimistic(p.payload.clientId);
        break;
      }
      case 'message:ack': {
        const list = getList(p.chatId);
        const m = list.find((x) => (x.clientId && x.clientId === p.clientId) || x.id === p.clientId);
        if (m) { m.id = p.id; m.pending = false; }
        break;
      }
      case 'pong': conn.ping = now() - (p.ts || now()); break;
      case 'server:shutdown': toast('Сервер перезапускается…'); break;
      default: applyRemote(msg.type, p, false);
    }
  }

  function removeOptimistic(clientId) {
    for (const [chatId, list] of S.messages) {
      const idx = list.findIndex((m) => m.clientId === clientId);
      if (idx >= 0) { list.splice(idx, 1); if (chatId === S.activeId) renderMessages(); }
    }
  }

  function applyRemote(type, p, isSync) {
    switch (type) {
      case 'message:new': {
        const wasActive = p.message.chatId === S.activeId;
        const nearBottom = isNearBottom();
        delete p.message.pending;
        upsertMessage(p.message);
        if (p.chat) { upsertChat(Object.assign(p.chat, { unread: wasActive && document.hasFocus() ? 0 : p.chat.unread })); renderChats(); if (wasActive) { renderChatHeader(); renderPinned(); } }
        if (!isSync && p.message.authorId !== (S.me && S.me.id)) {
          beep('in');
          if (!wasActive || !document.hasFocus()) notify(p.message, p.chat || getChat(p.message.chatId));
          if (wasActive && document.hasFocus()) markRead();
        }
        if (wasActive) {
          if (nearBottom || p.message.authorId === (S.me && S.me.id)) { renderMessages(false); scrollToBottom(true); }
          else $('#btn-scroll-down').hidden = false;
        }
        const list = getList(p.message.chatId);
        idb.put(p.message.chatId, list);
        clearTyping(p.message.chatId, p.message.authorId);
        break;
      }
      case 'message:updated': upsertMessage(p.message); break;
      case 'chat:upsert': upsertChat(p.chat); renderChats(); if (p.chat && p.chat.id === S.activeId) { renderChatHeader(); renderPinned(); } break;
      case 'chat:new': if (!S.chats.has(p.chatId)) loadChats(); break;
      case 'chat:refresh': loadChats(); if (p.chatId === S.activeId) refreshActiveMessages(); break;
      case 'chat:removed': S.chats.delete(p.chatId); if (S.activeId === p.chatId) closeChat(); renderChats(); break;
      case 'read': {
        const chat = getChat(p.chatId);
        if (chat) { chat.readStates = chat.readStates || {}; chat.readStates[p.userId] = { lastMessageId: p.lastMessageId, ts: p.ts }; renderMessages(); }
        break;
      }
      case 'typing': {
        if (p.userId === (S.me && S.me.id)) break;
        const map = S.typing.get(p.chatId) || new Map();
        const prev = map.get(p.userId);
        if (prev && prev.timer) clearTimeout(prev.timer);
        if (p.state) {
          const entry = { name: (p.displayName || 'Кто-то').split(' ')[0], timer: null };
          entry.timer = setTimeout(() => { map.delete(p.userId); onTypingChanged(p.chatId); }, 6000);
          map.set(p.userId, entry);
        } else map.delete(p.userId);
        S.typing.set(p.chatId, map);
        onTypingChanged(p.chatId);
        break;
      }
      case 'presence': {
        if (p.online) S.online.add(p.userId); else S.online.delete(p.userId);
        const u = S.users.get(p.userId);
        if (u) { u.online = !!p.online; u.lastSeen = p.lastSeen; }
        for (const chat of S.chats.values()) {
          for (const m of chat.members) if (m.id === p.userId) { m.online = !!p.online; m.lastSeen = p.lastSeen; }
          if (chat.peer && chat.peer.id === p.userId) { chat.peer.online = !!p.online; chat.peer.lastSeen = p.lastSeen; }
        }
        if (S.activeId) { renderChatHeader(); renderPanel(); }
        renderChats();
        break;
      }
      case 'call:incoming': case 'call:ended': case 'call:peer-joined': case 'call:peer-left':
      case 'call:peer-declined': case 'call:signal': case 'call:started': case 'call:joined':
      case 'call:state':
        if (window.K && K.calls) K.calls.onEvent(type, p);
        break;
      default: break;
    }
  }

  async function refreshActiveMessages() {
    if (!S.activeId) return;
    try {
      const data = await api(`/chats/${S.activeId}/messages?limit=60`);
      lists().set(S.activeId, data.messages.map(normalize));
      S.hasMore[S.activeId] = data.hasMore;
      upsertChat(data.chat);
      renderMessages();
      renderPinned();
      renderChatHeader();
      idb.put(S.activeId, lists().get(S.activeId));
    } catch {}
  }

  function typingNames(chatId) {
    const map = S.typing.get(chatId);
    if (!map) return [];
    return [...map.values()].map((v) => (typeof v === 'string' ? v : v.name));
  }

  function onTypingChanged(chatId) {
    renderTypingLine();
    renderChats();
    if (chatId === S.activeId) renderChatHeader();
  }

  function clearTyping(chatId, userId) {
    const map = S.typing.get(chatId);
    if (map && map.has(userId)) {
      const entry = map.get(userId);
      if (entry && entry.timer) clearTimeout(entry.timer);
      map.delete(userId);
      onTypingChanged(chatId);
    }
  }

  function renderTypingLine() {
    const line = $('#typing-line');
    const names = S.activeId ? typingNames(S.activeId) : [];
    if (!names.length) { line.textContent = ''; return; }
    line.textContent = names.length === 1 ? `${names[0]} печатает…` : `${names.slice(0, 3).join(', ')} печатают…`;
  }

  let typingTimer = null, typingSent = 0;
  function notifyTyping() {
    if (!S.activeId) return;
    const t = now();
    if (t - typingSent > 2500) { typingSent = t; wsSend({ type: 'typing', payload: { chatId: S.activeId, state: true } }); }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { typingSent = 0; wsSend({ type: 'typing', payload: { chatId: S.activeId, state: false } }); }, 3000);
  }

  function markRead() {
    if (!S.activeId || !document.hasFocus()) return;
    const list = getList(S.activeId);
    const last = list[list.length - 1];
    const chat = getChat(S.activeId);
    if (!chat || !last) return;
    if ((chat.myRead && chat.myRead.lastMessageId) === last.id) return;
    chat.myRead = { lastMessageId: last.id, ts: now() };
    chat.unread = 0;
    wsSend({ type: 'chat:read', payload: { chatId: S.activeId, lastMessageId: last.id } });
    renderChats();
  }

  function notify(message, chat) {
    if (!S.settings.notifications) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const title = (chat && chat.title) || (message.author ? message.author.displayName : 'Новое сообщение');
      const body = (message.text || previewText(message)).slice(0, 140);
      const n = new Notification(title, { body, icon: '/icon-192.png', tag: message.chatId, silent: true });
      n.onclick = () => { window.focus(); openChat(message.chatId); n.close(); };
    } catch {}
  }

  /* ------------------------------------------------------------- композер UI */
  function autoGrow() {
    const ta = $('#input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }
  function resizeInput() { autoGrow(); }
  function renderReplyPreview() {
    const box = $('#reply-preview');
    if (!S.replyTo) { box.hidden = true; return; }
    const list = S.activeId ? getList(S.activeId) : [];
    const m = list.find((x) => x.id === S.replyTo);
    box.hidden = false;
    $('#reply-title').textContent = 'Ответ ' + (m && m.author ? m.author.displayName : '');
    $('#reply-body').textContent = m ? (m.text || '📎 вложение').slice(0, 120) : '';
  }
  function renderUploadPreview() {
    const box = $('#upload-preview');
    if (!S.pendingFiles.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = S.pendingFiles.map((f, i) => `
      <div class="upload-item ${f.error ? 'err' : ''}" data-up="${i}">
        ${f.mime && f.mime.startsWith('image/') && f.preview ? `<img src="${f.preview}" alt="">` : '<span style="font-size:20px">📎</span>'}
        <span class="u-name">${esc(f.name)}</span>
        <span class="u-size">${f.uploaded ? fmtBytes(f.size) : (f.progress ? Math.round(f.progress * 100) + '%' : '…')}</span>
        <button class="u-remove" data-remove="${i}">✕</button>
        <div class="u-bar" style="width:${Math.round((f.progress || 0) * 100)}%"></div>
      </div>`).join('');
  }

  async function addFiles(fileList, opts = {}) {
    const files = [...fileList].slice(0, 10);
    for (const file of files) {
      if (file.size > 100 * 1024 * 1024) { toast(`Файл ${file.name} больше 100 МБ`, 'err'); continue; }
      const item = { name: file.name || 'файл', mime: file.type || '', size: file.size, progress: 0, uploaded: false, _duration: file._duration, kind: opts.kind || guessKind({ mime: file.type, name: file.name, duration: file._duration }) };
      if (item.mime.startsWith('image/')) item.preview = URL.createObjectURL(file);
      S.pendingFiles.push(item);
      renderUploadPreview();
      try {
        const meta = await uploadFile(file, (p) => { item.progress = p; renderUploadPreview(); });
        Object.assign(item, meta, { uploaded: true, progress: 1, kind: item.kind });
      } catch (err) {
        item.error = true;
        toast('Ошибка загрузки ' + item.name + ': ' + err.message, 'err');
        S.pendingFiles = S.pendingFiles.filter((f) => f !== item);
      }
      renderUploadPreview();
    }
  }

  /* ---------------------------------------------------------------- голосовые */
  let recorder = null, recChunks = [], recStart = 0, recTimer = null;
  async function toggleVoice() {
    const btn = $('#btn-voice');
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recChunks = [];
      recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
      recorder.onstop = async () => {
        clearInterval(recTimer);
        btn.classList.remove('recording');
        $('#composer-hint').textContent = '';
        stream.getTracks().forEach((t) => t.stop());
        const duration = (now() - recStart) / 1000;
        if (duration < .6) { toast('Слишком короткая запись'); return; }
        const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
        const name = `голосовое-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.webm`;
        const file = new File([blob], name, { type: blob.type });
        file._duration = duration;
        // голосовое уходит сразу, отдельным сообщением — как в обычных мессенджерах
        const chatId = S.activeId;
        if (!chatId) return;
        toast('Отправляю голосовое…');
        try {
          const meta = await uploadFile(file);
          postMessage(chatId, '', [{
            id: meta.id, url: meta.url, name: meta.name || name, mime: meta.mime, size: meta.size,
            duration: Math.round(duration), kind: 'voice',
          }]);
        } catch (err) { toast('Не удалось отправить голосовое: ' + err.message, 'err'); }
      };
      recorder.start();
      recStart = now();
      btn.classList.add('recording');
      recTimer = setInterval(() => { $('#composer-hint').textContent = `● Запись ${fmtDuration((now() - recStart) / 1000)} — нажмите 🎤 ещё раз, чтобы остановить`; }, 200);
    } catch (err) { toast('Нет доступа к микрофону: ' + err.message, 'err'); }
  }

  /* ------------------------------------------------------------------- эмодзи */
  const EMOJI_RECENT_KEY = 'k.emoji.recent';
  function recentEmoji() { return JSON.parse(localStorage.getItem(EMOJI_RECENT_KEY) || '[]'); }
  function pushRecentEmoji(e) {
    const list = [e, ...recentEmoji().filter((x) => x !== e)].slice(0, 40);
    localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify(list));
  }
  function renderEmojiPanel(query) {
    const cats = window.EMOJI_CATEGORIES || [];
    const q = (query || '').trim().toLowerCase();
    const grid = $('#emoji-grid');
    if (q) {
      const hits = [];
      for (const cat of cats) for (const item of cat.items) {
        if (item.e === q || (item.k || []).some((k) => k.includes(q)) || (item.s || '').includes(q)) hits.push(item);
        if (hits.length > 240) break;
      }
      grid.innerHTML = hits.length
        ? `<div class="emoji-row">${hits.map((i) => `<button class="emoji-cell" data-emoji="${esc(i.e)}" title="${esc((i.k || []).join(', '))}">${i.e}</button>`).join('')}</div>`
        : '<div class="emoji-empty">Ничего не нашлось 🤷</div>';
      return;
    }
    const recents = recentEmoji();
    const blocks = [];
    if (recents.length) blocks.push(`<div class="emoji-cat-title">Недавние</div><div class="emoji-row">${recents.map((e) => `<button class="emoji-cell" data-emoji="${esc(e)}">${e}</button>`).join('')}</div>`);
    for (const cat of cats) {
      blocks.push(`<div class="emoji-cat-title" id="ecat-${esc(cat.name.replace(/\W+/g, '-'))}">${esc(cat.name)}</div>
        <div class="emoji-row">${cat.items.map((i) => `<button class="emoji-cell" data-emoji="${esc(i.e)}" title="${esc((i.k || []).slice(0, 5).join(', '))}">${i.e}</button>`).join('')}</div>`);
    }
    grid.innerHTML = blocks.join('');
  }
  function renderEmojiCats() {
    const cats = window.EMOJI_CATEGORIES || [];
    const icons = ['😀', '🧑', '🐶', '🍔', '✈️', '⚽', '💡', '❤️', '🏁'];
    $('#emoji-cats').innerHTML = cats.map((c, i) => `<button data-cat="${esc(c.name.replace(/\W+/g, '-'))}" title="${esc(c.name)}">${icons[i] || '🙂'}</button>`).join('');
  }
  function insertAtCursor(text) {
    const ta = $('#input');
    const start = ta.selectionStart || 0, end = ta.selectionEnd || 0;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    ta.focus();
    autoGrow();
    if (S.activeId) S.drafts.set(S.activeId, ta.value);
  }

  /* -------------------------------------------------------------------- панель */
  function renderPanel() {
    const chat = getChat(S.activeId);
    const body = $('#panel-body');
    if (!chat) { body.innerHTML = ''; return; }
    const isDirect = chat.type === 'direct';
    const media = [];
    for (const list of [getList(chat.id)]) for (const m of list) for (const a of m.attachments || []) if (a.kind === 'image') media.push(a);
    const isAdmin = (chat.admins || []).includes(S.me && S.me.id);
    body.innerHTML = `
      <div class="panel-profile">
        ${isDirect && chat.peer ? avatarHTML(chat.peer, 'xl', true) : `<div class="avatar xl" style="background:linear-gradient(135deg, ${chat.color}, ${shade(chat.color, -30)})">${esc(initials(chat.title))}</div>`}
        <h3>${esc(chat.title)}</h3>
        <p>${isDirect && chat.peer ? '@' + esc(chat.peer.username) + ' · ' + esc(fmtLastSeen(chat.peer)) : esc(chat.members.length + ' участников')}</p>
        ${isDirect && chat.peer && chat.peer.bio ? `<p style="margin-top:8px">${esc(chat.peer.bio)}</p>` : ''}
      </div>
      ${chat.type === 'group' ? `
      <div class="panel-section">
        <h4>Название группы</h4>
        <div class="row-gap">
          <input id="group-title" value="${esc(chat.title)}" style="flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg-3);outline:none">
          <button class="btn sm primary" id="btn-save-title">Ок</button>
        </div>
      </div>
      <div class="panel-section">
        <h4>Аватар группы</h4>
        <div class="emoji-av-row" id="group-av">${['🚀', '🎧', '🔥', '🌈', '🍕', '💼', '🎮', '🐱', '⚽', '🎬'].map((e) => `<button data-gav="${e}">${e}</button>`).join('')}</div>
        <div class="row-gap" style="margin-top:8px">
          <button class="btn ghost sm" id="group-av-upload">📷 Загрузить своё фото</button>
          ${chat.avatar ? '<button class="btn ghost sm" id="group-av-reset">↩ Убрать фото</button>' : ''}
        </div>
      </div>` : ''}
      <div class="panel-section">
        <h4>Участники (${chat.members.length})</h4>
        ${chat.members.map((m) => `
          <div class="member-row" data-user="${m.id}">
            ${avatarHTML(m, 'sm', true)}
            <div class="m-body">
              <div class="m-name">${esc(m.displayName)}${m.isBot ? ' 🤖' : ''}${(chat.admins || []).includes(m.id) ? ' <span style="font-size:11px;color:var(--accent)">админ</span>' : ''}</div>
              <div class="m-sub ${m.online ? 'online' : ''}">${m.id === (S.me && S.me.id) ? 'это вы' : esc(m.online ? 'онлайн' : fmtLastSeen(m))}</div>
            </div>
            ${chat.type === 'group' && m.id !== (S.me && S.me.id) && isAdmin ? `<button class="icon-btn tiny" data-kick="${m.id}" title="Исключить">✕</button>` : ''}
          </div>`).join('')}
      </div>
      ${chat.type === 'group' ? `<div class="panel-section panel-actions">
        <button class="btn ghost sm" id="btn-add-members">➕ Добавить участников</button>
        <button class="btn ghost sm" id="btn-leave">🚪 Покинуть группу</button>
      </div>` : `<div class="panel-section panel-actions">
        <button class="btn ghost sm" id="btn-call-from-panel">🎥 Позвонить</button>
        <button class="btn ghost sm" id="btn-delete-chat">🗑 Удалить чат у себя</button>
      </div>`}
      ${chat.pinnedMessages && chat.pinnedMessages.length ? `<div class="panel-section"><h4>Закреплённые</h4>${chat.pinnedMessages.map((id) => {
        const m = getList(chat.id).find((x) => x.id === id); if (!m) return '';
        return `<div class="member-row" data-jump="${id}" style="cursor:pointer"><div class="m-body"><div class="m-name">${esc((m.author ? m.author.displayName : '') + ': ' + ((m.text || '').slice(0, 60) || '📎'))}</div><div class="m-sub">${fmtTime(m.createdAt)}</div></div></div>`;
      }).join('')}</div>` : ''}
      ${media.length ? `<div class="panel-section"><h4>Медиа (${media.length})</h4>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px">${media.slice(-9).map((a) => `<img src="${esc(a.url)}" data-lightbox="${esc(a.url)}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;cursor:zoom-in">`).join('')}</div></div>` : ''}
      <div class="panel-section">
        <h4>Мои действия</h4>
        <button class="btn ghost sm" id="btn-media-toggle" style="width:100%">🔔 Уведомления в этом чате</button>
      </div>`;
  }

  /* -------------------------------------------------------------- модальные окна */
  function openModal(html, onMount) {
    $('#modal-box').innerHTML = html;
    $('#modal').hidden = false;
    if (onMount) onMount($('#modal-box'));
  }
  function closeModal() { $('#modal').hidden = true; $('#modal-box').innerHTML = ''; }

  function openUsersPicker(mode) {
    openModal(`
      <div class="modal-head"><h3>${mode === 'group' ? 'Новая группа' : 'Новый чат'}</h3><button class="icon-btn tiny" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="search-wrap" style="margin-bottom:10px">
          <svg class="search-ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input id="people-q" placeholder="Поиск людей…">
        </div>
        <div id="people-list" class="muted-text">Загрузка…</div>
        ${mode === 'group' ? `<label class="field" style="margin-top:12px"><span>Название группы</span><input id="g-title" placeholder="Например: Друзья 🎉"></label>` : ''}
      </div>
      <div class="modal-foot">
        <button class="btn ghost" id="m-cancel">Отмена</button>
        <button class="btn primary" id="m-ok">${mode === 'group' ? 'Создать группу' : 'Написать'}</button>
      </div>`, (box) => {
      const selected = new Set();
      const render = (q = '') => {
        const users = S.usersCache.filter((u) => !q || (u.displayName + ' ' + u.username).toLowerCase().includes(q.toLowerCase()));
        $('#people-list').innerHTML = users.length ? users.map((u) => `
          <div class="user-row ${selected.has(u.id) ? 'selected' : ''}" data-pick="${u.id}">
            ${avatarHTML(u, 'sm', true)}
            <div class="u-body"><div class="u-name">${esc(u.displayName)}${u.isBot ? ' 🤖' : ''}</div><div class="u-login">@${esc(u.username)}</div></div>
            <div class="check">${selected.has(u.id) ? '✓' : ''}</div>
          </div>`).join('') : '<div class="muted-text">Пользователи не найдены</div>';
      };
      api('/users').then((d) => { S.usersCache = d.users; for (const u of d.users) S.users.set(u.id, u); render(); }).catch(() => { $('#people-list').innerHTML = '<div class="muted-text">Не удалось загрузить список</div>'; });
      box.addEventListener('click', (e) => {
        const row = e.target.closest('[data-pick]');
        if (row) {
          const id = row.dataset.pick;
          if (mode === 'group') { selected.has(id) ? selected.delete(id) : selected.add(id); render($('#people-q').value); }
          else { startDirect(id); closeModal(); }
        }
        if (e.target.closest('#m-close') || e.target.closest('#m-cancel')) closeModal();
        if (e.target.closest('#m-ok')) {
          if (mode === 'group') {
            const title = $('#g-title').value.trim() || 'Новая группа';
            api('/chats/group', { method: 'POST', body: { title, memberIds: [...selected] } })
              .then((d) => { upsertChat(d.chat); renderChats(); openChat(d.chat.id); closeModal(); toast('Группа создана 🎉', 'ok'); })
              .catch((err) => toast(err.message, 'err'));
          } else {
            const first = [...selected][0];
            if (first) { startDirect(first); closeModal(); } else toast('Выберите собеседника');
          }
        }
      });
      box.addEventListener('input', (e) => { if (e.target.id === 'people-q') render(e.target.value); });
    });
  }

  async function startDirect(userId) {
    try {
      const d = await api('/chats/direct', { method: 'POST', body: { userId } });
      upsertChat(d.chat);
      renderChats();
      openChat(d.chat.id);
    } catch (err) { toast(err.message, 'err'); }
  }

  function openSettings() {
    openModal(`
      <div class="modal-head"><h3>Настройки</h3><button class="icon-btn tiny" id="m-close">✕</button></div>
      <div class="modal-body">
        <div class="panel-profile">
          <div class="settings-avatar">
            <div id="s-avatar-preview" title="Нажмите, чтобы загрузить своё фото"></div>
            <span class="muted-text" style="font-size:12px">Нажмите на аватар, чтобы загрузить своё фото</span>
          </div>
          <h3 style="margin-top:8px">${esc(S.me ? S.me.displayName : '')}</h3>
          <p>@${esc(S.me ? S.me.username : '')}</p>
        </div>
        <div class="panel-section">
          <h4>Профиль</h4>
          <label class="field"><span>Отображаемое имя</span><input id="s-name" value="${esc(S.me ? S.me.displayName : '')}"></label>
          <label class="field"><span>О себе</span><input id="s-bio" value="${esc((S.me && S.me.bio) || '')}" placeholder="Пара слов о вас"></label>
          <label class="field"><span>Email</span><input id="s-email" value="${esc((S.me && S.me.email) || '')}" placeholder="you@example.com"></label>
          <div class="row-gap" style="align-items:center">
            <span class="muted-text">Аватар:</span>
            ${['🦊', '🐼', '🐱', '🚀', '🎧', '🌈', '🔥', '🍕', '🧑‍💻'].map((e) => `<button class="btn sm ghost" data-av="${e}">${e}</button>`).join('')}
            <button class="btn sm ghost" id="s-av-upload">📷 Загрузить</button>
          </div>
        </div>
        <div class="panel-section">
          <h4>Интерфейс</h4>
          <div class="switch-row"><span>Тёмная тема</span><label class="switch"><input type="checkbox" id="s-theme" ${S.settings.theme === 'dark' ? 'checked' : ''}><span></span></label></div>
          <div class="switch-row"><span>Уведомления на рабочем столе</span><label class="switch"><input type="checkbox" id="s-notify" ${S.settings.notifications ? 'checked' : ''}><span></span></label></div>
          <div class="switch-row"><span>Звуки сообщений</span><label class="switch"><input type="checkbox" id="s-sounds" ${S.settings.sounds ? 'checked' : ''}><span></span></label></div>
          <div class="switch-row"><span>Enter отправляет сообщение</span><label class="switch"><input type="checkbox" id="s-enter" ${S.settings.enterSends ? 'checked' : ''}><span></span></label></div>
        </div>
        <div class="panel-section">
          <h4>Звук и видео</h4>
          <div class="device-row"><label>Микрофон</label><select id="d-mic"><option>по умолчанию</option></select></div>
          <div class="device-row"><label>Камера</label><select id="d-cam"><option>по умолчанию</option></select></div>
          <div class="device-row"><label>Динамики</label><select id="d-out"><option>по умолчанию</option></select></div>
          <div class="row-gap" style="margin-top:6px">
            <button class="btn ghost sm" id="d-perm">🔄 Обновить список устройств</button>
            <button class="btn ghost sm" id="d-test">🎤 Проверить микрофон</button>
          </div>
          <div class="mic-meter" id="d-meter" hidden><i></i></div>
          <div class="muted-text" id="d-hint" style="margin-top:6px">Устройства выбираются для звонков. Список подтянется после разрешения доступа.</div>
        </div>
        <div class="panel-section">
          <h4>Служебное</h4>
          <div class="row-gap">
            <button class="btn ghost sm" id="s-devices">📱 Устройства</button>
            <button class="btn ghost sm" id="s-sync">🔄 Полная синхронизация</button>
            <button class="btn ghost sm" id="s-clear">🧹 Очистить локальные данные</button>
            <button class="btn ghost sm" id="s-logout">🚪 Выйти</button>
          </div>
          <div id="s-info" class="muted-text" style="margin-top:10px"></div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn ghost" id="m-close2">Закрыть</button><button class="btn primary" id="s-save">Сохранить</button></div>`,
      (box) => {
        let avatar = S.me ? S.me.avatar : null;
        const avPreview = $('#s-avatar-preview');
        if (avPreview) avPreview.innerHTML = avatarHTML(S.me, 'lg', true);
        const pickAvatarFile = () => {
          const inp = document.createElement('input');
          inp.type = 'file'; inp.accept = 'image/*';
          inp.onchange = async () => {
            const f = inp.files[0]; if (!f) return;
            try {
              toast('Загружаю картинку…');
              const meta = await uploadFile(f, () => {});
              avatar = meta.url;
              if (avPreview) avPreview.innerHTML = avatarHTML(Object.assign({}, S.me, { avatar }), 'lg', true);
              toast('Готово — нажмите «Сохранить»', 'ok');
            } catch (err) { toast(err.message, 'err'); }
          };
          inp.click();
        };
        box.addEventListener('click', async (e) => {
          if (e.target.closest('#s-avatar-preview')) { pickAvatarFile(); return; }
          if (e.target.closest('#d-save-devices')) { /* на случай старой вёрстки */ }
          const av = e.target.closest('[data-av]');
          if (av) { avatar = av.dataset.av; toast('Аватар выбран — не забудьте сохранить'); }
          if (e.target.closest('#s-av-upload')) {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'image/*';
            inp.onchange = async () => {
              const f = inp.files[0]; if (!f) return;
              try {
                const meta = await uploadFile(f, () => {});
                avatar = meta.url;
                toast('Картинка загружена — нажмите «Сохранить»', 'ok');
              } catch (err) { toast(err.message, 'err'); }
            };
            inp.click();
          }
          if (e.target.closest('#m-close') || e.target.closest('#m-close2')) closeModal();
          if (e.target.closest('#d-perm') || e.target.closest('#s-av-upload')) { /* ниже */ }
          if (e.target.closest('#d-perm')) { askDevicesPermission(); }
          if (e.target.closest('#d-test')) { testMicrophone(); }
          if (e.target.closest('#s-clear')) {
            try {
              for (const k of Object.keys(localStorage)) if (k.startsWith('k.')) localStorage.removeItem(k);
              indexedDB.deleteDatabase('kontur');
              toast('Локальный кэш, черновики и настройки очищены — перезагружаю…', 'ok');
              setTimeout(() => location.reload(), 900);
            } catch (err) { toast('Не удалось очистить: ' + err.message, 'err'); }
          }
          if (e.target.closest('#s-save')) {
            try {
              const body = { displayName: $('#s-name').value, bio: $('#s-bio').value, email: $('#s-email').value, avatar };
              saveDevicesFromForm();
              const d = await api('/me', { method: 'PATCH', body });
              S.me = d.user;
              $('#me-name').textContent = S.me.displayName;
              $('#me-avatar').outerHTML = avatarHTML(S.me, '', true, 'me-avatar');
              toast('Профиль сохранён ✅', 'ok');
              closeModal();
            } catch (err) { toast(err.message, 'err'); }
          }
          if (e.target.closest('#s-theme')) { S.settings.theme = $('#s-theme').checked ? 'dark' : 'light'; saveSettings(); applyTheme(); }
          if (e.target.closest('#s-notify')) { S.settings.notifications = $('#s-notify').checked; saveSettings(); if (S.settings.notifications) askNotifyPermission(); }
          if (e.target.closest('#s-sounds')) { S.settings.sounds = $('#s-sounds').checked; saveSettings(); }
          if (e.target.closest('#s-enter')) { S.settings.enterSends = $('#s-enter').checked; saveSettings(); }
          if (e.target.closest('#s-logout')) { logout(); }
          if (e.target.closest('#s-sync')) { fullResync(); }
          if (e.target.closest('#s-devices')) {
            wsSend({ type: 'device:list' });
            toast('Запрошен список устройств…');
          }
        });
        fillDeviceList();
        api('/server/info').then((info) => {
          $('#s-info').innerHTML = `Сервер: <b>${esc(info.name)}</b> v${esc(info.version)} · пользователей: ${info.users}, чатов: ${info.chats}, сообщений: ${info.messages}<br>Событий синхронизации: ${S.seq} · задержка: ${conn.ping} мс`;
        }).catch(() => {});
      });
  }

  function fullResync() {
    localStorage.setItem(seqKey(), '0');
    S.seq = 0;
    lists().clear();
    for (const c of S.chats.keys()) idb.put(c, []);
    wsSend({ type: 'sync', payload: { since: 0 } });
    loadChats();
    refreshActiveMessages();
    toast('Запущена полная синхронизация 🔄', 'ok');
  }

  /* ------------------------------------------------------- устройства ввода */

  async function askDevicesPermission() {
    const hint = $('#d-hint');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      for (const t of stream.getTracks()) t.stop();
      if (hint) hint.textContent = 'Доступ выдан — список устройств обновлён.';
    } catch (err) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const t of stream.getTracks()) t.stop();
        if (hint) hint.textContent = 'Микрофон доступен, камера — нет.';
      } catch (err2) {
        if (hint) hint.textContent = 'Нет доступа к устройствам: ' + err2.message + '. По http:// вне localhost браузер запрещает доступ — включите HTTPS (флаг --https на сервере).';
        toast('Нет доступа к микрофону/камере', 'err');
        return;
      }
    }
    await fillDeviceList();
  }

  async function fillDeviceList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
    const groups = {
      'd-mic': ['audioinput', S.settings.devices && S.settings.devices.audioIn],
      'd-cam': ['videoinput', S.settings.devices && S.settings.devices.videoIn],
      'd-out': ['audiooutput', S.settings.devices && S.settings.devices.audioOut],
    };
    for (const [id, [kind, selected]] of Object.entries(groups)) {
      const sel = document.getElementById(id);
      if (!sel) continue;
      const list = devices.filter((d) => d.kind === kind);
      sel.innerHTML = '<option value="">по умолчанию</option>' + list.map((d, i) =>
        `<option value="${esc(d.deviceId)}">${esc(d.label || (kind === 'audioinput' ? 'Микрофон ' : kind === 'videoinput' ? 'Камера ' : 'Устройство ') + (i + 1))}</option>`).join('');
      if (selected) sel.value = selected;
      if (!list.length) sel.innerHTML = '<option value="">нет доступных устройств</option>';
    }
    const outSel = document.getElementById('d-out');
    if (outSel && !(outSel.setSinkId || HTMLMediaElement.prototype.setSinkId)) {
      outSel.disabled = true;
      outSel.innerHTML = '<option value="">выбор выхода не поддерживается браузером</option>';
    }
  }

  function saveDevicesFromForm() {
    S.settings.devices = {
      audioIn: ($('#d-mic') || {}).value || '',
      videoIn: ($('#d-cam') || {}).value || '',
      audioOut: ($('#d-out') || {}).value || '',
    };
    saveSettings();
    applyAudioOutput();
  }

  /** Направляем звук звонка на выбранное устройство вывода (если браузер умеет). */
  function applyAudioOutput() {
    const id = S.settings.devices && S.settings.devices.audioOut;
    if (!id) return;
    for (const el of $$('audio, video')) {
      if (typeof el.setSinkId === 'function') el.setSinkId(id).catch(() => {});
    }
  }

  let micTest = null;
  async function testMicrophone() {
    const meter = $('#d-meter');
    const hint = $('#d-hint');
    if (micTest) {                                   // повторный клик — остановить
      clearInterval(micTest.timer);
      try { micTest.ctx.close(); } catch {}
      for (const t of micTest.stream.getTracks()) t.stop();
      micTest = null;
      if (meter) { meter.hidden = true; meter.querySelector('i').style.width = '0%'; }
      return;
    }
    try {
      const deviceId = ($('#d-mic') || {}).value;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      if (meter) meter.hidden = false;
      if (hint) hint.textContent = 'Говорите — полоска должна двигаться. Повторное нажатие останавливает проверку.';
      micTest = {
        stream, ctx,
        timer: setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
          const bar = meter && meter.querySelector('i');
          if (bar) bar.style.width = Math.min(100, Math.round(peak * 190)) + '%';
        }, 80),
      };
    } catch (err) { toast('Микрофон недоступен: ' + err.message, 'err'); }
  }

  function askNotifyPermission() {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }

  function applyTheme() {
    document.documentElement.dataset.theme = S.settings.theme === 'light' ? 'light' : 'dark';
  }

  function logout() {
    try { conn.ws && conn.ws.close(); } catch {}
    for (const k of Object.keys(localStorage)) if (k.startsWith('k.')) localStorage.removeItem(k);
    try { indexedDB.deleteDatabase('kontur'); } catch {}
    location.reload();
  }

  /* ------------------------------------------------------------- контекст-меню */
  function openContextMenu(x, y, items) {
    const menu = $('#context-menu');
    menu.innerHTML = items.map((it) => it.html || `<button class="${it.danger ? 'danger' : ''}" data-mi="${it.id}">${it.icon || ''} ${esc(it.label)}</button>`).join('');
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 10) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 10) + 'px';
    $('#menu-overlay').hidden = false;
    const close = () => { menu.hidden = true; $('#menu-overlay').hidden = true; menu.innerHTML = ''; menu.removeEventListener('click', onClick); $('#menu-overlay').removeEventListener('click', close); };
    const onClick = (e) => {
      const btn = e.target.closest('[data-mi]');
      if (!btn) return;
      const item = items.find((i) => i.id === btn.dataset.mi);
      close();
      if (item && item.run) item.run();
    };
    menu.addEventListener('click', onClick);
    $('#menu-overlay').addEventListener('click', close);
  }

  function messageContextMenu(m, x, y) {
    const mine = m.authorId === (S.me && S.me.id);
    const chat = getChat(S.activeId);
    const isAdmin = chat && (chat.admins || []).includes(S.me && S.me.id);
    const quick = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '🙏'];
    openContextMenu(x, y, [
      { html: `<div class="emoji-quick">${quick.map((e) => `<button data-mi="react:${e}">${e}</button>`).join('')}</div>` },
      { id: 'reply', icon: '↩', label: 'Ответить', run: () => { S.replyTo = m.id; renderReplyPreview(); $('#input').focus(); } },
      { id: 'copy', icon: '📋', label: 'Копировать текст', run: () => { navigator.clipboard.writeText(m.text || '').then(() => toast('Скопировано', 'ok'), () => toast('Не удалось скопировать', 'err')); } },
      ...(mine ? [{ id: 'edit', icon: '✏️', label: 'Изменить', run: () => { S.editing = m.id; $('#input').value = m.text; autoGrow(); $('#composer-hint').textContent = 'Редактирование сообщения — Enter, чтобы сохранить, Esc — отмена'; $('#input').focus(); } }] : []),
      { id: 'pin', icon: '📌', label: 'Закрепить / открепить', run: () => wsSend({ type: 'message:pin', payload: { id: m.id } }) },
      { id: 'forward', icon: '➡️', label: 'Переслать', run: () => forwardMessage(m) },
      ...((mine || isAdmin) ? [{ id: 'del', icon: '🗑', label: 'Удалить', danger: true, run: () => { wsSend({ type: 'message:delete', payload: { id: m.id } }); const list = getList(m.chatId); const i = list.findIndex((x) => x.id === m.id); if (i >= 0) { list.splice(i, 1); renderMessages(); } } }] : []),
    ].map((it) => it.id && it.id.startsWith('react:') ? { id: it.id, html: '' } : it));
  }

  function forwardMessage(m) {
    openModal(`
      <div class="modal-head"><h3>Переслать в…</h3><button class="icon-btn tiny" id="m-close">✕</button></div>
      <div class="modal-body"><div id="fwd-list"></div></div>`, (box) => {
      const chats = chatList();
      $('#fwd-list').innerHTML = chats.map((c) => `<div class="user-row" data-fwd="${c.id}">
        ${c.type === 'direct' && c.peer ? avatarHTML(c.peer, 'sm') : `<div class="avatar sm" style="background:${c.color}">${esc(initials(c.title))}</div>`}
        <div class="u-body"><div class="u-name">${esc(c.title)}</div><div class="u-login">${c.type === 'group' ? c.members.length + ' участников' : 'личный чат'}</div></div>
      </div>`).join('');
      box.addEventListener('click', async (e) => {
        if (e.target.closest('#m-close')) { closeModal(); return; }
        const row = e.target.closest('[data-fwd]');
        if (!row) return;
        const chatId = row.dataset.fwd;
        try {
          await api(`/chats/${chatId}/messages`, { method: 'POST', body: { text: m.text, attachments: m.attachments } });
          toast('Переслано ✅', 'ok');
        } catch (err) { toast(err.message, 'err'); }
        closeModal();
      });
    });
  }

  /* -------------------------------------------------------------- обработчики */
  function bindUI() {
    // авторизация
    $$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => {
      $$('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const mode = tab.dataset.mode;
      $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
      $('#field-display').hidden = mode === 'login';
      $('#auth-error').hidden = true;
    }));

    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = $('.auth-tab.active').dataset.mode;
      const body = { username: $('#auth-username').value.trim(), password: $('#auth-password').value, displayName: $('#auth-display').value.trim() };
      try {
        const d = await api('/auth/' + (mode === 'login' ? 'login' : 'register'), { method: 'POST', body });
        finishLogin(d.token);
      } catch (err) {
        $('#auth-error').hidden = false;
        $('#auth-error').textContent = err.message;
      }
    });

    $('#btn-demo').addEventListener('click', async () => {
      if (!S.demoMode) { toast('Демо-режим выключен на сервере', 'err'); return; }
      try {
        const d = await api('/auth/demo', { method: 'POST', body: {} });
        const names = (d.demoAccounts || []).map((u) => u.displayName + ' (@' + u.username + ')').join(', ');
        finishLogin(d.token, `Вы вошли как ${d.user.displayName}. Можно войти с другого браузера как ${names} — пароль demo1234.`);
      } catch (err) { toast(err.message, 'err'); }
    });

    // сайдбар
    $('#search').addEventListener('input', renderChats);
    $('#btn-search-clear') && $('#btn-search-clear').addEventListener('click', () => { $('#search').value = ''; renderChats(); });
    $('#chat-filter').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $$('#chat-filter .chip').forEach((c) => c.classList.toggle('active', c === chip));
      S.filter = chip.dataset.filter;
      renderChats();
    });
    $('#chat-list').addEventListener('click', (e) => {
      const item = e.target.closest('[data-chat]');
      if (item) openChat(item.dataset.chat);
    });
    $('#chat-list').addEventListener('contextmenu', (e) => {
      const item = e.target.closest('[data-chat]');
      if (!item) return;
      e.preventDefault();
      const chat = getChat(item.dataset.chat);
      if (!chat) return;
      openContextMenu(e.clientX, e.clientY, [
        { id: 'read', icon: '✅', label: 'Отметить прочитанным', run: () => { const list = getList(chat.id); wsSend({ type: 'chat:read', payload: { chatId: chat.id, lastMessageId: list[list.length - 1] && list[list.length - 1].id } }); chat.unread = 0; renderChats(); } },
        { id: 'del', icon: '🗑', label: 'Удалить чат у себя', danger: true, run: () => api('/chats/' + chat.id, { method: 'DELETE' }).then(() => { S.chats.delete(chat.id); if (S.activeId === chat.id) closeChat(); renderChats(); }).catch((err) => toast(err.message, 'err')) },
      ]);
    });
    $('#btn-new-chat').addEventListener('click', () => openUsersPicker('direct'));
    $('#btn-new-chat-2').addEventListener('click', () => openUsersPicker('group'));
    $('#btn-profile').addEventListener('click', () => { if (S.me) openSettings(); });
    $('#btn-menu').addEventListener('click', (e) => {
      openContextMenu(e.clientX, e.clientY, [
        { id: 'new', icon: '➕', label: 'Новый чат', run: () => openUsersPicker('direct') },
        { id: 'group', icon: '👥', label: 'Новая группа', run: () => openUsersPicker('group') },
        { id: 'theme', icon: '🌗', label: 'Сменить тему', run: () => { S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); } },
        { id: 'settings', icon: '⚙️', label: 'Настройки', run: () => openSettings() },
        ...(S.demoMode ? [{ id: 'demo', icon: '🧪', label: 'Демо-данные и аккаунты', run: () => showDemoInfo() }] : []),
        { id: 'about', icon: 'ℹ️', label: 'О сборке (.exe / LAN)', run: () => showAbout() },
      ]);
    });

    // чат
    $('#btn-back').addEventListener('click', closeChat);
    $('#btn-chat-info').addEventListener('click', () => togglePanel(true));
    $('#btn-panel').addEventListener('click', () => togglePanel());
    $('#btn-panel-close').addEventListener('click', () => togglePanel(false));
    $('#btn-call-video').addEventListener('click', () => callWith('video'));
    $('#btn-call-audio').addEventListener('click', () => callWith('audio'));
    $('#btn-search-chat').addEventListener('click', () => {
      const bar = $('#search-bar');
      bar.hidden = !bar.hidden;
      if (!bar.hidden) $('#chat-search-input').focus();
    });
    $('#btn-chat-search-close').addEventListener('click', () => {
      $('#search-bar').hidden = true;
      $('#search-results').hidden = true;
      $('#messages').style.filter = '';
    });
    $('#chat-search-input').addEventListener('input', debounce(async (e) => {
      const q = e.target.value.trim();
      if (!S.activeId) return;
      if (!q) { $('#search-results').hidden = true; return; }
      try {
        const d = await api(`/chats/${S.activeId}/search?q=${encodeURIComponent(q)}`);
        $('#search-results').hidden = false;
        $('#chat-search-count').textContent = d.results.length ? `${d.results.length} найдено` : 'ничего';
        $('#search-results').innerHTML = d.results.map((m) => `
          <div class="search-hit" data-jump="${m.id}">
            <div class="hit-top"><span>${esc(m.author ? m.author.displayName : '')}</span><span>${fmtDateFull(m.createdAt)}</span></div>
            <div class="hit-text">${markup(m.text).replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>')}</div>
          </div>`).join('') || '<div class="search-hit muted-text">Ничего не найдено</div>';
      } catch (err) { toast(err.message, 'err'); }
    }, 250));
    $('#search-results').addEventListener('click', (e) => {
      const hit = e.target.closest('[data-jump]');
      if (!hit) return;
      const id = hit.dataset.jump;
      loadContextAround(id);
    });

    $('#btn-load-more').addEventListener('click', loadMoreHistory);
    $('#messages').addEventListener('click', onMessagesClick);
    $('#messages').addEventListener('contextmenu', (e) => {
      const node = e.target.closest('[data-msg]');
      if (!node) return;
      const m = getList(S.activeId).find((x) => x.id === node.dataset.msg);
      if (!m || m.system) return;
      e.preventDefault();
      messageContextMenu(m, e.clientX, e.clientY);
    });
    $('#messages').addEventListener('scroll', () => {
      $('#btn-scroll-down').hidden = isNearBottom();
      if ($('#messages').scrollTop < 80) $('#btn-load-more').hidden = !(S.hasMore && S.hasMore[S.activeId]);
      markRead();
    });
    $('#btn-scroll-down').addEventListener('click', () => scrollToBottom(true));

    // композер
    const input = $('#input');
    input.addEventListener('input', () => { autoGrow(); if (S.activeId) S.drafts.set(S.activeId, input.value); notifyTyping(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && S.settings.enterSends) { e.preventDefault(); sendMessage(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !S.settings.enterSends) { e.preventDefault(); sendMessage(); }
      if (e.key === 'Escape') {
        if (S.editing) { S.editing = null; input.value = ''; $('#composer-hint').textContent = ''; }
        else if (S.replyTo) { S.replyTo = null; renderReplyPreview(); }
      }
      if (e.key === 'ArrowUp' && !input.value.trim() && !S.editing) {
        const list = getList(S.activeId).filter((m) => m.authorId === (S.me && S.me.id) && !m.system);
        const last = list[list.length - 1];
        if (last) { S.editing = last.id; input.value = last.text; autoGrow(); }
      }
    });
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    $('#btn-send').addEventListener('click', sendMessage);
    $('#btn-attach').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true;
      inp.onchange = () => addFiles(inp.files);
      inp.click();
    });
    $('#btn-voice').addEventListener('click', toggleVoice);
    $('#btn-reply-cancel').addEventListener('click', () => { S.replyTo = null; renderReplyPreview(); });
    $('#upload-preview').addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) { S.pendingFiles.splice(Number(rm.dataset.remove), 1); renderUploadPreview(); }
    });

    // эмодзи
    $('#btn-emoji').addEventListener('click', () => toggleEmoji());
    $('#btn-emoji-close').addEventListener('click', () => toggleEmoji(false));
    $('#emoji-grid').addEventListener('click', (e) => {
      const cell = e.target.closest('[data-emoji]');
      if (!cell) return;
      pushRecentEmoji(cell.dataset.emoji);
      insertAtCursor(cell.dataset.emoji);
    });
    $('#emoji-cats').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      $$('#emoji-cats button').forEach((b) => b.classList.toggle('active', b === btn));
      const target = document.getElementById('ecat-' + btn.dataset.cat);
      if (target) target.scrollIntoView({ block: 'start' });
    });
    $('#emoji-q').addEventListener('input', debounce((e) => renderEmojiPanel(e.target.value), 120));

    // drag & drop
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => { if (!S.activeId) return; e.preventDefault(); dragDepth++; $('#drag-overlay').hidden = false; });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drag-overlay').hidden = true; });
    document.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; $('#drag-overlay').hidden = true;
      if (!S.activeId) return;
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    // модалки, лайтбокс
    $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
    $('#messages').addEventListener('click', (e) => {
      const img = e.target.closest('[data-lightbox]');
      if (img) { $('#lightbox-img').src = img.dataset.lightbox; $('#lightbox').hidden = false; }
      const voice = e.target.closest('[data-voice]');
      if (voice) {
        const audio = voice.parentElement.querySelector('audio');
        if (audio.paused) { audio.play(); voice.textContent = '⏸'; } else { audio.pause(); voice.textContent = '▶'; }
      }
    });
    $('#lightbox-close').addEventListener('click', () => { $('#lightbox').hidden = true; });
    $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').hidden = true; });

    // клавиатура
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); $('#lightbox').hidden = true; $('#context-menu').hidden = true; $('#menu-overlay').hidden = true; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && S.activeId) { e.preventDefault(); $('#search-bar').hidden = false; $('#chat-search-input').focus(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hasFocus()) { markRead(); renderChats(); } });
    window.addEventListener('online', () => { if (!conn.ws || conn.ws.readyState !== 1) connect(); });
    window.addEventListener('focus', markRead);

    // панель: делегирование
    $('#panel-body').addEventListener('click', async (e) => {
      const chat = getChat(S.activeId);
      if (!chat) return;
      if (e.target.closest('#btn-save-title')) {
        try { const d = await api('/chats/' + chat.id, { method: 'PATCH', body: { title: $('#group-title').value } }); upsertChat(d.chat); renderChatHeader(); renderPanel(); toast('Название обновлено', 'ok'); } catch (err) { toast(err.message, 'err'); }
      }
      const gav = e.target.closest('[data-gav]');
      if (gav) { try { const d = await api('/chats/' + chat.id, { method: 'PATCH', body: { avatar: gav.dataset.gav } }); upsertChat(d.chat); renderChatHeader(); renderPanel(); } catch (err) { toast(err.message, 'err'); } }
      if (e.target.closest('#group-av-upload')) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*';
        inp.onchange = async () => {
          const f = inp.files[0]; if (!f) return;
          try {
            toast('Загружаю фото группы…');
            const meta = await uploadFile(f, () => {});
            const d = await api('/chats/' + chat.id, { method: 'PATCH', body: { avatar: meta.url } });
            upsertChat(d.chat); renderChatHeader(); renderPanel(); renderChats();
            toast('Аватар группы обновлён ✅', 'ok');
          } catch (err) { toast(err.message, 'err'); }
        };
        inp.click();
      }
      if (e.target.closest('#group-av-reset')) {
        try {
          const d = await api('/chats/' + chat.id, { method: 'PATCH', body: { avatar: null } });
          upsertChat(d.chat); renderChatHeader(); renderPanel(); renderChats();
        } catch (err) { toast(err.message, 'err'); }
      }
      const kick = e.target.closest('[data-kick]');
      if (kick) { try { await api(`/chats/${chat.id}/members/${kick.dataset.kick}`, { method: 'DELETE' }); toast('Участник исключён'); } catch (err) { toast(err.message, 'err'); } }
      if (e.target.closest('#btn-add-members')) {
        const current = new Set(chat.memberIds);
        openModal(`<div class="modal-head"><h3>Добавить участников</h3><button class="icon-btn tiny" id="m-close">✕</button></div>
          <div class="modal-body"><div id="add-list" class="muted-text">Загрузка…</div></div>
          <div class="modal-foot"><button class="btn ghost" id="m-cancel">Отмена</button><button class="btn primary" id="m-ok">Добавить</button></div>`, (box) => {
          const sel = new Set();
          api('/users').then((d) => {
            const users = d.users.filter((u) => !current.has(u.id));
            $('#add-list').innerHTML = users.map((u) => `<div class="user-row" data-pick="${u.id}">${avatarHTML(u, 'sm')}<div class="u-body"><div class="u-name">${esc(u.displayName)}</div><div class="u-login">@${esc(u.username)}</div></div><div class="check"></div></div>`).join('');
          });
          box.addEventListener('click', async (ev) => {
            const row = ev.target.closest('[data-pick]');
            if (row) { const id = row.dataset.pick; sel.has(id) ? sel.delete(id) : sel.add(id); row.classList.toggle('selected'); row.querySelector('.check').textContent = sel.has(id) ? '✓' : ''; }
            if (ev.target.closest('#m-close') || ev.target.closest('#m-cancel')) closeModal();
            if (ev.target.closest('#m-ok')) {
              try { await api(`/chats/${chat.id}/members`, { method: 'POST', body: { userIds: [...sel] } }); toast('Участники добавлены ✅', 'ok'); } catch (err) { toast(err.message, 'err'); }
              closeModal();
            }
          });
        });
      }
      if (e.target.closest('#btn-leave')) {
        try { await api('/chats/' + chat.id, { method: 'DELETE' }); closeChat(); loadChats(); toast('Вы покинули группу'); } catch (err) { toast(err.message, 'err'); }
      }
      if (e.target.closest('#btn-delete-chat')) { try { await api('/chats/' + chat.id, { method: 'DELETE' }); S.chats.delete(chat.id); closeChat(); renderChats(); toast('Чат удалён у вас'); } catch (err) { toast(err.message, 'err'); } }
      if (e.target.closest('#btn-call-from-panel')) callWith('video');
      if (e.target.closest('[data-jump]')) scrollToMessage(e.target.closest('[data-jump]').dataset.jump);
      if (e.target.closest('#btn-media-toggle')) toast('Уведомления в этом чате: ' + (getChat(S.activeId).unread ? 'есть непрочитанные' : 'тихо'));
    });
  }

  function fmtDateFull(ts) {
    return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function onMessagesClick(e) {
    const act = e.target.closest('[data-act]');
    if (act) {
      const m = getList(S.activeId).find((x) => x.id === act.dataset.id);
      if (!m) return;
      const a = act.dataset.act;
      if (a === 'reply') { S.replyTo = m.id; renderReplyPreview(); $('#input').focus(); }
      if (a === 'edit') { S.editing = m.id; $('#input').value = m.text; autoGrow(); $('#composer-hint').textContent = 'Редактирование — Enter сохранит, Esc отменит'; $('#input').focus(); }
      if (a === 'pin') wsSend({ type: 'message:pin', payload: { id: m.id } });
      if (a === 'react') { showQuickReactions(act, m); }
      if (a === 'more') { const r = act.getBoundingClientRect(); messageContextMenu(m, r.left, r.bottom + 4); }
      return;
    }
    const react = e.target.closest('[data-react]');
    if (react) { wsSend({ type: 'message:react', payload: { id: react.dataset.id, emoji: react.dataset.react } }); return; }
    const jump = e.target.closest('[data-jump]');
    if (jump && !jump.classList.contains('reply-quote')) { scrollToMessage(jump.dataset.jump); return; }
    if (jump) {
      const id = jump.dataset.jump;
      if (!scrollToMessage(id)) { loadContextAround(id); }
    }
  }

  function showQuickReactions(anchor, m) {
    const r = anchor.getBoundingClientRect();
    const emojis = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '🙏', '👌', '🤔'];
    const items = emojis.map((e) => ({ html: '', id: 'q:' + e }));
    const menu = $('#context-menu');
    menu.innerHTML = `<div class="emoji-quick">${emojis.map((e) => `<button data-mi="q:${e}">${e}</button>`).join('')}</div>`;
    menu.hidden = false;
    menu.style.left = Math.min(r.left, window.innerWidth - 260) + 'px';
    menu.style.top = Math.max(10, r.top - 54) + 'px';
    $('#menu-overlay').hidden = false;
    const close = () => { menu.hidden = true; $('#menu-overlay').hidden = true; };
    menu.onclick = (ev) => {
      const b = ev.target.closest('[data-mi]');
      if (!b) return;
      wsSend({ type: 'message:react', payload: { id: m.id, emoji: b.dataset.mi.slice(2) } });
      close();
    };
    $('#menu-overlay').onclick = close;
  }

  async function loadMoreHistory() {
    const chatId = S.activeId;
    if (!chatId) return;
    const list = getList(chatId);
    const before = list[0] && list[0].id;
    if (!before) return;
    const box = $('#messages');
    const prevHeight = box.scrollHeight;
    try {
      const d = await api(`/chats/${chatId}/messages?limit=60&before=${before}`);
      mergeMessages(chatId, d.messages);
      S.hasMore[chatId] = d.hasMore;
      renderMessages(true);
      box.scrollTop = box.scrollHeight - prevHeight;
    } catch (err) { toast(err.message, 'err'); }
  }

  async function loadContextAround(messageId) {
    const chatId = S.activeId;
    if (!chatId) return;
    if (scrollToMessage(messageId)) return;                       // сообщение уже в ленте — просто прыгаем
    const d = await api(`/chats/${chatId}/messages?limit=60&before=${messageId}`);
    mergeMessages(chatId, d.messages);                            // склейка по id: дублей не будет
    renderMessages(true);
    setTimeout(() => scrollToMessage(messageId), 60);
  }

  function syncPanelClasses() {
    const app = $('#app');
    app.classList.toggle('with-panel', !$('#panel').hidden);
    app.classList.toggle('with-emoji', !$('#emoji-panel').hidden);
    // на узких экранах панели открываются поверх чата — закрываем вторую
    if (window.innerWidth <= 1100) {
      if (!$('#panel').hidden) $('#emoji-panel').hidden = true;
      app.classList.remove('with-emoji');
      if (!$('#emoji-panel').hidden) { $('#panel').hidden = true; app.classList.remove('with-panel'); }
    }
  }

  function togglePanel(force) {
    const panel = $('#panel');
    const show = typeof force === 'boolean' ? force : panel.hidden;
    if (show) { $('#emoji-panel').hidden = true; renderPanel(); }   // одновременно — только одна панель
    panel.hidden = !show;
    syncPanelClasses();
  }

  function toggleEmoji(force) {
    const p = $('#emoji-panel');
    const show = typeof force === 'boolean' ? force : p.hidden;
    if (show) { $('#panel').hidden = true; }
    p.hidden = !show;
    syncPanelClasses();
  }

  function showDemoInfo() {
    openModal(`<div class="modal-head"><h3>🧪 Демо-данные</h3><button class="icon-btn tiny" id="m-close">✕</button></div>
      <div class="modal-body">
        <p class="muted-text">В базе есть демо-пользователи и группа «Общий чат 🚀» с историей, реакциями и файлом. Пароль у всех: <code>demo1234</code></p>
        <div id="demo-list"></div>
        <p class="muted-text">Открой сервер ещё в одном браузере/окне и войди другим пользователем — увидишь синхронизацию и звонки между «устройствами».</p>
      </div>
      <div class="modal-foot"><button class="btn ghost" id="m-close2">Ок</button></div>`, (box) => {
      box.addEventListener('click', (e) => { if (e.target.closest('#m-close') || e.target.closest('#m-close2')) closeModal(); });
      api('/auth/demo/users').then((d) => {
        $('#demo-list').innerHTML = d.accounts.map((u) => `<div class="user-row"><div class="avatar sm" style="background:${u.color}">${esc(initials(u.displayName))}</div>
          <div class="u-body"><div class="u-name">${esc(u.displayName)}</div><div class="u-login">@${esc(u.username)} · пароль demo1234</div></div></div>`).join('');
      }).catch(() => {});
    });
  }

  function showAbout() {
    openModal(`<div class="modal-head"><h3>ℹ️ О мессенджере</h3><button class="icon-btn tiny" id="m-close">✕</button></div>
      <div class="modal-body">
        <p><b>Мессенджер «Контур» 1.0</b> — сервер на Node.js (Express + WebSocket), клиенты: веб-интерфейс и Windows-приложения.</p>
        <ul class="muted-text" style="line-height:1.7;padding-left:18px">
          <li>Синхронизация: журнал событий + WebSocket, история в локальном кэше (IndexedDB)</li>
          <li>Звонки: WebRTC (аудио/видео/демонстрация экрана)</li>
          <li>Файлы до 100 МБ, голосовые сообщения, эмодзи (1870+), реакции, ответы, закрепления</li>
          <li>Группы, админы, read-receipts, «печатает…», поиск, тёмная тема</li>
        </ul>
        <p class="muted-text">Друзья в одной сети подключаются по адресу из окна сервера: <code>http://&lt;IP&gt;:4000</code></p>
      </div>
      <div class="modal-foot"><button class="btn ghost" id="m-close2">Закрыть</button></div>`, (box) => {
      box.addEventListener('click', (e) => { if (e.target.closest('#m-close') || e.target.closest('#m-close2')) closeModal(); });
    });
  }

  function callWith(kind) {
    if (!S.activeId) { toast('Выберите чат'); return; }
    if (!window.K || !K.calls) { toast('Модуль звонков не загружен', 'err'); return; }
    K.calls.start(S.activeId, kind);
  }

  function finishLogin(token, hint) {
    S.token = token;
    localStorage.setItem('k.token', token);
    boot();
    if (hint) toast(hint, 'ok', 9000);
  }

  /* ---------------------------------------------------------------------- старт */
  async function boot() {
    if (!S.token) return;
    try {
      const d = await api('/me');
      S.me = d.user;
    } catch { localStorage.removeItem('k.token'); S.token = null; return; }
    $('#auth-screen').hidden = true;
    $('#app').hidden = false;
    $('#me-name').textContent = S.me.displayName;
    $('#me-avatar').outerHTML = avatarHTML(S.me, '', true, 'me-avatar');
    setConnState('connecting');
    applyTheme();
    renderEmojiCats();
    renderEmojiPanel('');
    connect();
    loadChats();
    if ('Notification' in window && Notification.permission === 'default') setTimeout(askNotifyPermission, 4000);
  }

  async function init() {
    applyTheme();
    try {
      const info = await api('/server/info');
      $('#server-url').textContent = location.host || 'localhost';
      $('#server-status').textContent = `сервер на связи · v${info.version}`;
      S.demoMode = !!info.demoMode;
      const demoBlock = $('#demo-block');
      if (demoBlock) demoBlock.hidden = !S.demoMode;
      if (S.demoMode) {
        $('#demo-hint').innerHTML = `Демо-аккаунты: <b>anya</b>, <b>boris</b>, <b>vera</b>, <b>gleb</b> · пароль <b>demo1234</b> · бот <b>@bot</b>`;
        $('#demo-hint').hidden = false;
      }
      if (!S.demoMode && !S.token) $('#server-status').textContent = `сервер на связи · v${info.version} · регистрация открыта`;
    } catch {
      $('#server-status').textContent = 'сервер недоступен';
      $('#server-url').textContent = location.host || 'localhost';
    }
    bindUI();
    window.addEventListener('beforeunload', () => { try { conn.ws && conn.ws.close(); } catch {} });
    if (S.token) boot();
    if (location.hash === '#demo' && !S.token && S.demoMode) $('#btn-demo').click();
  }

  window.K = { S, api, toast, beep, avatarHTML, esc, markup, initials, shade, fmtTime, fmtDay, fmtBytes, fmtDuration, previewText, getChat, getList, renderChats, renderPanel, renderChatHeader, upsertChat, api_: api, uploadFile, openChat, renderMessages, scrollToBottom, loadContextAround, mergeMessages, togglePanel, toggleEmoji, postMessage, fillDeviceList, openSettings };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
