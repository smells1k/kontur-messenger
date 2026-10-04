# API мессенджера «Контур»

Базовый адрес: `http://<сервер>:4000` · WebSocket: `ws://<сервер>:4000/ws?token=<JWT>`

Авторизация в REST — заголовок `Authorization: Bearer <token>`. Токен выдаётся при входе
и живёт 30 дней (самодостаточный JWT, HS256, секрет — `data/secret.key`).

---

## REST

### Служебное
| Метод | Путь | Описание |
|---|---|---|
| GET | `/health` | `{ok, uptime, users, seq}` — проверка живости |
| GET | `/api/server/info` | имя, версия, число пользователей/чатов/сообщений, режимы |

### Вход и профиль
| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/api/auth/register` | `{username, displayName, password, email?}` → `{token, user}` |
| POST | `/api/auth/login` | `{username, password}` → `{token, user}` |
| POST | `/api/auth/demo` | `{}` → `{token, user, demoAccounts[]}` — вход под демо-аккаунтом |
| GET | `/api/auth/demo/users` | список демо-аккаунтов (без паролей) |
| GET | `/api/me` | `{user}` |
| PATCH | `/api/me` | `{displayName?, bio?, email?, phone?, avatar?}` |

### Люди
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/users?q=` | поиск пользователей (до 60) |
| GET | `/api/contacts` | собеседники из личных чатов |

### Чаты
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/chats` | все чаты пользователя + `seq` журнала |
| POST | `/api/chats/direct` | `{userId}` → личный чат (создаётся при необходимости) |
| POST | `/api/chats/group` | `{title, memberIds[], avatar?}` |
| GET | `/api/chats/:id` | чат |
| PATCH | `/api/chats/:id` | `{title?, avatar?}` (для групп) |
| POST | `/api/chats/:id/members` | `{userIds[]}` — добавить |
| DELETE | `/api/chats/:id/members/:userId` | исключить участника |
| DELETE | `/api/chats/:id` | выйти из группы / скрыть личный чат у себя |

### Сообщения
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/chats/:id/messages?limit=50&before=<id>` | история, `{messages[], hasMore, chat, seq}` |
| POST | `/api/chats/:id/messages` | `{text, attachments?, replyTo?, clientId?}` |
| POST | `/api/chats/:id/read` | `{lastMessageId}` — отметка прочтения |
| GET | `/api/chats/:id/search?q=` | поиск по тексту сообщений |
| PATCH | `/api/messages/:id` | `{text}` — правка (только свои) |
| DELETE | `/api/messages/:id` | удаление (автор или админ группы) |
| POST | `/api/messages/:id/reactions` | `{emoji}` — поставить/снять реакцию |
| POST | `/api/messages/:id/pin` | закрепить/открепить |

### Файлы
| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/upload` | тело — сырые байты; заголовки `X-File-Name` (URL-encoded), `X-File-Mime`, `X-Duration`, `X-Width`, `X-Height` |

Ответ: `{file: {id, url, name, mime, size, duration, width, height}}`. Файл доступен по `GET /uploads/<файл>`.
Ограничение размера — `--max-upload` (по умолчанию 100 МБ).

---

## WebSocket

Обмен JSON-сообщениями: `{type, payload, requestId?}`.

### Команды клиента
| Тип | payload | Ответ сервера |
|---|---|---|
| `auth` | `{token, since}` или токен в `?token=` | `ready` (+ догонка `sync:events`) |
| `sync` | `{since}` | `sync:events` (пачки по 500), `sync:done` |
| `ping` | `{}` | `pong` |
| `presence:list` | — | `presence:list` (кто онлайн) |
| `typing` | `{chatId, state}` | получателям: `typing` |
| `message:send` | `{chatId, text, attachments, replyTo, clientId}` | `message:ack` `{clientId, id}` + всем `message:new` |
| `message:edit` | `{id, text, requestId}` | `ok` / `error` |
| `message:delete` | `{id}` | `ok` |
| `message:react` | `{id, emoji}` | `ok` + всем `message:updated` |
| `message:pin` | `{id}` | `ok` |
| `chat:read` | `{chatId, lastMessageId}` | участникам: `read` |
| `call:invite` | `{chatId, kind: 'video'\|'audio'}` | инициатору `call:started`, остальным `call:incoming` |
| `call:join` | `{callId}` | `call:joined` `{call, existingPeers}` |
| `call:decline` / `call:leave` | `{callId}` | `call:peer-declined` / `call:peer-left`, `call:ended` |
| `call:state` | `{callId, state:{muted,camera,screen}}` | участникам `call:state` |
| `call:signal` | `{callId, to, data}` | адресату `call:signal` (SDP/ICE/bye) |
| `device:list` | — | `device:list` (устройства этого пользователя) |

### События сервера
`ready`, `sync:events`, `sync:done`, `message:new`, `message:updated`, `message:ack`,
`chat:new`, `chat:upsert`, `chat:refresh`, `chat:removed`, `read`, `typing`, `presence`,
`call:incoming`, `call:started`, `call:joined`, `call:peer-joined`, `call:peer-left`,
`call:peer-declined`, `call:state`, `call:signal`, `call:ended`, `device:list`, `ok`, `error`, `pong`.

### Синхронизация: как это работает
1. Каждое «долгоживущее» событие получает номер `seq` и попадает в журнал (`data/events`, последние 40 000).
2. Клиент хранит последний применённый `seq` локально (ключ `k.seq.<userId>`).
3. При подключении отправляется `sync {since: <последний seq>}`; сервер отдаёт все события пользователя с `seq > since`.
4. Клиент применяет их так же, как «живые» события → состояние совпадает на всех устройствах.

Сигналинг звонков (SDP/ICE) намеренно **не** пишется в журнал: это эфемерные данные,
и заодно экономится место. Активные звонки перечисляются в `ready.calls`.

---

## Пример: отправить сообщение из скрипта

```js
const WebSocket = require('ws');
const base = 'http://localhost:4000';

const { token } = await fetch(base + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'anya', password: 'demo1234' }),
}).then((r) => r.json());

const { chats } = await fetch(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json());

const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
ws.on('open', () => ws.send(JSON.stringify({
  type: 'message:send',
  payload: { chatId: chats[0].id, text: 'Привет из скрипта 👋', clientId: 'c1' },
})));
ws.on('message', (raw) => console.log(JSON.parse(raw.toString())));
```

## Пример: свой бот

Бот — обычный аккаунт. Слушайте `message:new` и отвечайте `message:send`.
Готовый каркас — `server/src/bots.js` (класс `AssistantBot`).
