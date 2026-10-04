'use strict';
/** Демо-данные: пользователи, группы, история сообщений — чтобы мессенджер сразу «жил». */
const fs = require('fs');
const path = require('path');
const { newId } = require('./util');

const DEMO_PASSWORD = 'demo1234';

function ago(minutes) { return Date.now() - minutes * 60 * 1000; }

function seedDemo({ store, core, uploadDir }) {
  if (Object.keys(store.data.users).length) return { skipped: true };

  const mk = (username, displayName, bio) => {
    const u = store.createUser({ username, displayName, password: DEMO_PASSWORD, bio });
    u.isDemo = true;
    return u;
  };

  const anya = mk('anya', 'Аня Орлова', 'Дизайнер интерфейсов 💅 Люблю кофе и тёмные темы');
  const boris = mk('boris', 'Борис Ким', 'Backend, Node.js, WebRTC. Всегда онлайн 🔌');
  const vera = mk('vera', 'Вера Соколова', 'Продакт-менеджер. Пишу ТЗ и шучу про дедлайны 📅');
  const gleb = mk('gleb', 'Глеб Дроздов', 'QA. Ломаю то, что вы собрали 🔨');
  const bot = store.createUser({ username: 'bot', displayName: 'Мессенджер Бот', password: DEMO_PASSWORD, bio: 'Встроенный помощник: /help', isBot: true });
  bot.isDemo = true;
  core.botUserId = bot.id;

  store.save();

  /* --- демо-файл для вложения --- */
  let demoFile = null;
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    const id = newId('f');
    const stored = id + '.txt';
    const content = [
      'План на неделю (демо-файл)',
      '==========================',
      '1. Собрать прототип мессенджера — готово',
      '2. Проверить синхронизацию на двух устройствах',
      '3. Позвонить по видео внутри сети',
      '4. Пригласить команду и создать группу',
      '',
      'Файл создан автоматически демо-данными сервера.',
    ].join('\n');
    fs.writeFileSync(path.join(uploadDir, stored), content);
    demoFile = { id, url: `/uploads/${stored}`, name: 'план-на-неделю.txt', mime: 'text/plain', size: Buffer.byteLength(content) };
    store.data.uploadedFiles[id] = { ...demoFile, stored, ownerId: bot.id, createdAt: Date.now() };
  } catch (err) {
    console.error('[seed] не удалось создать демо-файл:', err.message);
  }

  /* --- чаты --- */
  const common = store.createChat({
    type: 'group', title: 'Общий чат 🚀', memberIds: [anya.id, boris.id, vera.id, gleb.id, bot.id],
    createdBy: anya.id, isDemo: true,
  });
  const team = store.createChat({
    type: 'group', title: 'Команда проекта', memberIds: [anya.id, boris.id, vera.id, bot.id],
    createdBy: boris.id, isDemo: true,
  });
  const aB = store.createChat({ type: 'direct', memberIds: [anya.id, boris.id], createdBy: anya.id, isDemo: true });
  const aV = store.createChat({ type: 'direct', memberIds: [anya.id, vera.id], createdBy: vera.id, isDemo: true });
  const aG = store.createChat({ type: 'direct', memberIds: [anya.id, gleb.id], createdBy: anya.id, isDemo: true });

  /* --- история --- */
  const write = (chat, authorId, text, minutes, extra = {}) => {
    const m = store.addMessage({ chatId: chat.id, authorId, text, createdAt: ago(minutes), ...extra });
    return m;
  };

  write(common, anya.id, 'Всем привет! Собрали мессенджер: сервер на Node.js, клиенты — веб и .exe 🎉', 640);
  const m2 = write(common, boris.id, 'Синхронизация работает: отключи сеть, напиши, включи — всё подтянется из журнала событий 🔄', 622);
  write(common, vera.id, 'Проверила на телефоне и на ноутбуке — история одинаковая 👍', 615);
  write(common, bot.id, 'Напоминаю: /help покажет мои команды, а в группе можно обратиться ко мне через @bot 🤖', 610);
  write(common, gleb.id, 'Видеозвонки проверил: картинка чистая, звук тоже. Экран шарится 🖥️', 590);
  if (demoFile) {
    write(common, anya.id, 'Вот план на неделю, кому интересно 📎', 585, { attachments: [demoFile] });
  }
  write(common, vera.id, 'Предлагаю созвон в 18:00 по местному ⏰', 120);
  const lastCommon = write(common, boris.id, 'Поддерживаю! Кнопка 🎥 в шапке чата — создаём звонок, все в группе получат приглашение.', 118);

  write(team, boris.id, 'Собираю релиз 1.0: осталось проверить восстановление соединения.', 300);
  write(team, anya.id, 'Иконку и цвета поправила, тёмная тема стала мягче 🌙', 280);
  write(team, vera.id, 'Дедлайн — пятница, напоминаю всем 😅', 260);
  write(team, bot.id, 'Записал: дедлайн пятница. Событие #4821', 259);

  write(aB, anya.id, 'Борис, привет! Глянешь мой макет вечером?', 200);
  write(aB, boris.id, 'Привет! Да, конечно. В 20:00 удобно?', 196);
  write(aB, anya.id, 'Отлично 🙌 Скину ссылку на файл', 195);
  const lastAB = write(aB, boris.id, 'Обновил: теперь сообщение можно редактировать и удалять. И реакции на долгое нажатие 👆', 40);

  write(aV, vera.id, 'Аня, у нас завтра демо для заказчика?', 90);
  write(aV, anya.id, 'Да! Покажем группы, звонки и синхронизацию 😎', 88);
  write(aV, vera.id, 'Супер, готовлю сценарий 🎬', 30);

  write(aG, gleb.id, 'Нашёл баг: если офлайн отправить сообщение, оно уходило с "часиками". Сейчас ждёт сеть и уходит ✅', 70);
  write(aG, anya.id, 'Красота! Спасибо 🙏', 65);

  /* --- реакции, правка, системное сообщение --- */
  m2.reactions = { '👍': [anya.id, vera.id], '🔥': [gleb.id] };
  lastCommon.reactions = { '🎥': [anya.id, vera.id, gleb.id] };
  lastAB.editedAt = Date.now() - 30 * 1000;
  store.addMessage({ chatId: common.id, authorId: anya.id, system: true, text: 'Аня Орлова создал(а) группу «Общий чат 🚀»', createdAt: ago(641) });

  /* --- непрочитанные для любого демо-пользователя: отметки чтения --- */
  for (const chat of [common, team, aB, aV, aG]) {
    for (const member of chat.members) {
      store.data.reads[`${chat.id}:${member}`] = { lastMessageId: null, ts: Date.now() };
    }
    // у любого пользователя будет немного непрочитанного — так интереснее смотреть демо
    const ids = store.messageIds(chat.id);
    const keep = ids.slice(-3, -1); // последние пару сообщений считаем непрочитанными
    for (const member of chat.members.slice(0, 2)) {
      if (keep.length) store.data.reads[`${chat.id}:${member}`] = { lastMessageId: keep[keep.length - 1], ts: Date.now() };
    }
  }

  store.save();
  store.flush();
  return { users: [anya, boris, vera, gleb, bot], chats: [common, team, aB, aV, aG], password: DEMO_PASSWORD };
}

module.exports = { seedDemo, DEMO_PASSWORD };
