'use strict';
/**
 * Встроенный бот: отвечает в личке, понимает команды и умеет «оживлять» демо-группу.
 */
const { cleanText } = require('./util');

class AssistantBot {
  constructor(core, store, { debug = false } = {}) {
    this.core = core;
    this.store = store;
    this.debug = debug;
    this.pending = new Set();
  }

  get userId() { return this.core.botUserId || null; }

  onMessage({ chat, message, author }) {
    const botId = this.userId;
    if (!botId || author.id === botId) return;
    const mentioned = new RegExp(`@${this.store.getUser(botId).username}\\b`, 'i').test(message.text || '');
    if (chat.type === 'group') {
      if (!mentioned) return;
      if (!chat.members.includes(botId)) this.core.addBotToChat(botId, chat.id);
    }
    const body = (message.text || '').trim();
    const reply = this.buildReply(body, author, chat.type === 'group');
    this.scheduleReply(chat.id, reply, 400 + Math.random() * 900, { replyTo: message.id });
  }

  scheduleReply(chatId, text, delayMs = 700, extra = {}) {
    const key = `${chatId}:${text}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      try {
        this.core.sendMessage({ chatId, authorId: this.userId, text, ...extra });
      } catch (err) { if (this.debug) console.error('[bot]', err.message); }
    }, delayMs);
    if (timer.unref) timer.unref();
  }

  buildReply(raw, author, isGroup) {
    const cmd = raw.toLowerCase();
    const first = cleanText(author.displayName, 30).split(' ')[0];
    const rid = () => Math.floor(Math.random() * 9000 + 1000);

    if (cmd.startsWith('/help') || cmd.startsWith('/start') || cmd === 'помощь' || cmd === 'help') {
      return [
        `Привет, ${first}! Я встроенный бот мессенджера 🎧`,
        '',
        'Что я умею:',
        '/help — это сообщение',
        '/time — текущее время сервера',
        '/roll 100 — случайное число',
        '/id — ваш ID и ID чата',
        '/stats — статистика сервера',
        '/echo текст — повторю за вами',
        '/ping — проверка связи',
        '/me текст — действие от вашего имени',
        '',
        'В группе напишите @' + this.store.getUser(this.userId).username + ' и вопрос — отвечу.😉',
      ].join('\n');
    }
    if (cmd.startsWith('/time')) return `🕒 Время сервера: ${new Date().toLocaleString('ru-RU')} (${new Date().toISOString()})`;
    if (cmd.startsWith('/date')) return `📅 Сегодня ${new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
    if (cmd.startsWith('/roll')) {
      const max = Math.max(2, Math.min(1e9, parseInt(cmd.split(/\s+/)[1] || '6', 10) || 6));
      return `🎲 Выпало: ${Math.floor(Math.random() * max) + 1} (из ${max})`;
    }
    if (cmd.startsWith('/id')) return `🆔 Вы: ${author.id}\n💬 Логин: @${author.username}`;
    if (cmd.startsWith('/stats')) {
      const s = this.store.data;
      return [
        '📊 Статистика сервера:',
        `• Пользователей: ${Object.keys(s.users).length}`,
        `• Чатов: ${Object.keys(s.chats).length}`,
        `• Сообщений: ${Object.keys(s.messages).length}`,
        `• Событий синхронизации: ${s.seq}`,
        `• Версия: 1.0.0`,
      ].join('\n');
    }
    if (cmd.startsWith('/ping')) return `🏓 Понг! Задержка минимальная, я рядом.`;
    if (cmd.startsWith('/echo ')) return raw.slice(6);
    if (cmd.startsWith('/me ')) return `* ${author.displayName} ${raw.slice(4)}`;
    if (!raw) return `👋 ${first}, я на связи. Напишите /help, чтобы увидеть команды.`;

    const greetings = ['привет', 'здравствуй', 'хай', 'ку', 'hello', 'добрый день', 'добрый вечер', 'доброе утро'];
    if (greetings.some((g) => cmd.includes(g))) {
      return [`Привет, ${first}! 👋`, 'Как дела? Могу показать, что умею: /help 😊', 'Рад тебя видеть! Что нового? 🚀'][Math.floor(Math.random() * 3)];
    }
    if (/как дела|как ты|как жизнь|how are you/.test(cmd)) return [`Отлично — сервер работает, сообщения летают ✅`, `Всё хорошо! А у тебя как? 😊`, `Стабильно: CPU спокоен, база целая 💪`][Math.floor(Math.random() * 3)];
    if (/спасибо|благодар|thanks|спс/.test(cmd)) return ['Всегда пожалуйста! 🙌', 'Рад помочь 😊', 'Обращайся! 🤝'][Math.floor(Math.random() * 3)];
    if (/пока|до свидания|bye/.test(cmd)) return ['До связи! 👋', 'Пока-пока! ✨', 'Удачи! Буду тут, если понадоблюсь 🤖'][Math.floor(Math.random() * 3)];
    if (cmd.includes('emoji') || cmd.includes('эмодзи')) return 'Вот немного настроения: 😀 😎 🥳 🚀 ❤️ 🔥 🎧 🌈 🍕 ⚡️';
    if (cmd.endsWith('?')) return [`Хороший вопрос 🤔 Попробуйте /help — вдруг там есть ответ.`, `Спросите ещё раз чуть иначе — подумаю 🧠`, `Я пока умею немного, но учусь быстро. Мой список команд: /help`][Math.floor(Math.random() * 3)];
    if (raw.length > 3) {
      const variants = [
        `Принято: «${cleanText(raw, 60)}» ${isGroup ? '(в группе)' : ''}`.trim(),
        `Записал в журнал 📝 Событие #${rid()}`,
        `Понял вас, ${first}! Если нужна помощь — /help 🤖`,
        `Интересная мысль 💡 Кстати, файлы и картинки можно просто перетащить в чат.`,
        `Сообщение получено ✅ Доставка, синхронизация и уведомления работают.`,
      ];
      return variants[Math.floor(Math.random() * variants.length)];
    }
    return `👍 ${['Хорошо', 'Ок', 'Понял', 'Принято'][Math.floor(Math.random() * 4)]}!`;
  }

  /** Редкие сообщения в демо-группу, чтобы чат выглядел живым. */
  startAmbient(chatId, botId) {
    const phrases = [
      'Всем привет! Напоминаю: файлы можно кинуть прямо в окно чата 📎',
      'Проверка связи 📡 Сообщения синхронизируются между всеми устройствами.',
      'Кстати, эффекты: нажмите и удерживайте сообщение — там реакции, ответ, редактирование 💬',
      'Совет дня: кнопка 🎥 — видеозвонок на весь экран, 📞 — только звук.',
      'Эмодзи-панель открывается справа от поля ввода 😀',
      'Можно создать группу: значок «+» в списке чатов 🗂',
    ];
    let i = 0;
    const timer = setInterval(() => {
      const chat = this.store.getChat(chatId);
      if (!chat) return;
      const last = this.store.lastMessage(chatId);
      if (last && Date.now() - last.createdAt < 1000 * 60 * 4) return;
      try {
        this.core.sendMessage({ chatId, authorId: botId, text: phrases[i++ % phrases.length] });
      } catch {}
    }, 1000 * 60 * 2);
    if (timer.unref) timer.unref();
    return timer;
  }
}

module.exports = { AssistantBot };
