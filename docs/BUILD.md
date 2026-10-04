# Сборка и распространение

## Что получается в итоге

| Артефакт | Что это | Размер | Кому |
|---|---|---|---|
| `release/KonturServer.exe` | сервер + веб-клиент внутри одного `.exe` (Node.js 20 внутри) | ≈56 МБ | Windows, «просто запустить» |
| `release/web/` | веб-клиент (можно открыть в любом браузере) | 0,5 МБ | телефоны, планшеты, любой ПК |
| `release-desktop/Kontur-Setup-1.0.0.exe` | установщик Electron-приложения (ярлыки, деинсталляция) | ≈95 МБ | Windows, «как настоящая программа» |
| `release-desktop/Kontur-Portable-1.0.0.exe` | portable Electron-приложение | ≈90 МБ | Windows, без установки |
| Docker-образ | сервер для NAS/сервера | ≈180 МБ | Linux, круглосуточный хост |

---

## 1. `KonturServer.exe` (pkg)

```bash
bash scripts/make-windows-exe.sh
```

Что происходит по шагам:
1. в `build/staging/` собирается компактный проект: `launcher.js` + `server/` + `web/`;
2. `npm install --omit=dev` — внутрь попадают только `express` и `ws`;
3. `@yao-pkg/pkg` зашивает Node.js 20, код и ассеты (`--config pkg.config.json`:
   `scripts` — JS-файлы, `assets` — вся папка `web/`);
4. рядом с `.exe` кладётся `web/` и `README-KLIENT.txt`.

Сборка работает из Linux/macOS без wine: `pkg` скачивает официальные prebuilt-бинари Node для Windows.

**Проверка сборки без Windows:** скрипт дополнительно собирает `release/KonturServer-linux`
из того же кода — можно запустить и убедиться, что всё работает:

```bash
./release/KonturServer-linux --port 4200 --data /tmp/kontur --no-open
curl localhost:4200/api/server/info
cd server && node test/smoke.js http://localhost:4200 && node test/client-smoke.js http://localhost:4200
```

### Иконка
Иконки лежат в `assets/` (`.ico` — мультиразмерный для Windows, `.png` — для веба и Electron).
Сгенерировать заново из картинки:

```bash
python3 - <<'PY'
from PIL import Image
src = Image.open('assets/icon-1024.png')
src.save('assets/icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
PY
```

Иконка `.exe` при сборке через `pkg` не подменяется (это особенность pkg). Хотите свою иконку
на `.exe` — либо используйте Electron-сборку (там иконка применяется), либо подмените ресурс
утилитой `rcedit` после сборки:

```bash
npx rcedit release/KonturServer.exe --set-icon assets/icon.ico
```
(на Linux работает через wine, на Windows — напрямую).

## 2. Electron-приложение

```bash
bash scripts/build-electron-win.sh     # сначала соберёт сервер, потом приложение
```

Что важно знать:
- первый запуск скачает Electron и `winCodeSign` (нужен интернет);
- сборка **NSIS-инсталлятора** на Linux требует wine — либо собирайте на Windows,
  либо используйте только portable-цель: `npx electron-builder --win portable`;
- код сервера и веб-клиент кладутся в ресурсы приложения (`extraResources`), поэтому клиент
  умеет сам поднимать локальный сервер через `ELECTRON_RUN_AS_NODE` — Node.js пользователю не нужен;
- иконка берётся из `desktop/icons/icon.ico`, ярлыки создаются установщиком.

## 3. Docker (рекомендуется для постоянного сервера)

```yaml
# docker-compose.yml
services:
  kontur:
    build: .
    ports: ["4000:4000"]
    volumes: ["./docker-data:/data"]
    restart: unless-stopped
```

```bash
docker compose up -d
# адрес: http://<IP сервера>:4000 , данные: ./docker-data
```

Для интернета — поставьте перед контейнером nginx/Caddy с сертификатом:

```nginx
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # обязательно для WebSocket
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    client_max_body_size 200M;                   # лимит загрузки файлов
}
```

## 4. Ручная раздача без Node.js у клиентов

`release/web/` — обычная статика. Если сервер уже где-то работает, веб-клиент можно отдать
любым способом (nginx, `python3 -m http.server`), но проще открыть адрес сервера: он сам раздаёт клиент.

## Чек-лист перед раздачей друзьям

- [ ] Открыт порт 4000 в брандмауэре (частные сети).
- [ ] В консоли сервера виден адрес вида `http://192.168.x.x:4000`.
- [ ] С другого устройства: открывается страница входа, «Демо-вход» работает.
- [ ] Отправка сообщения с двух устройств — сообщение появляется у обоих.
- [ ] Звонок: в браузере нужен доступ к камере/микрофону (по HTTPS или localhost;
      по `http://` в локальной сети Chrome разрешает `getUserMedia` для частных IP).
- [ ] Для звонков вне домашней сети нужен свой TURN (см. `docs/ARCHITECTURE.md`).
