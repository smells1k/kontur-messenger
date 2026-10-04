#!/usr/bin/env bash
# =============================================================================
# Сборка Windows-приложения KonturServer.exe
#
# Внутрь .exe «зашивается» всё: Node.js 20, сервер (Express + WebSocket)
# и веб-клиент. На компьютере с Windows не нужно ничего устанавливать.
#
# Запуск:  bash scripts/make-windows-exe.sh          (из корня проекта)
# Итог:    release/KonturServer.exe  +  release/web/
#
# Переменные окружения:
#   BUILD_LINUX_TOO=1  — дополнительно собрать ту же сборку под Linux (для тестов)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
STAGE="$ROOT/build/staging"          # временная папка (в git не попадает)

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
BUILD_DATE="$(date +%Y-%m-%d)"
echo "▶︎ Подготовка staging… (версия $VERSION, сборка $BUILD_DATE)"
rm -rf "$STAGE"; mkdir -p "$STAGE" release
mkdir -p "$STAGE/server" "$STAGE/web"

cp server/server.js server/package.json "$STAGE/server/"
[ -f server/package-lock.json ] && cp server/package-lock.json "$STAGE/server/" || true
cp -r server/src "$STAGE/server/src"

cp -r web/. "$STAGE/web/"
cp launcher/src/main.js "$STAGE/launcher.js"

# версия «зашивается» внутрь сборки, чтобы её было видно и в .exe, и в браузере
cat > "$STAGE/server/src/version.js" <<JS
'use strict';
module.exports = { version: '$VERSION', builtAt: '$BUILD_DATE', label: '$VERSION (сборка $BUILD_DATE)' };
JS
cat > "$STAGE/web/js/build-info.js" <<JS
// Версия клиента (генерируется при сборке)
window.KONTUR_BUILD = { version: '$VERSION', date: '$BUILD_DATE' };
JS

cat > "$STAGE/package.json" <<JSON
{
  "name": "kontur-server",
  "version": "$VERSION",
  "description": "Мессенджер «Контур» — сервер и веб-клиент в одном .exe",
  "bin": "launcher.js",
  "main": "launcher.js",
  "dependencies": { "express": "^5.2.1", "ws": "^8.18.0" }
}
JSON

# конфигурация pkg: всё, что нужно «зашить» в .exe
cat > "$STAGE/pkg.config.json" <<'JSON'
{
  "scripts": ["launcher.js", "server/**/*.js"],
  "assets": ["web/**/*"]
}
JSON

echo "▶︎ Ставлю зависимости внутрь сборки (express, ws)…"
cd "$STAGE"
npm install --omit=dev --no-audit --no-fund --silent

echo "▶︎ Собираю исполняемый файл под Windows x64 (pkg / Node 20)…"
npx --yes @yao-pkg/pkg launcher.js \
  --config pkg.config.json \
  --targets node20-win-x64 \
  --output "$ROOT/release/KonturServer.exe" \
  --compress GZip \
  --public-packages "*" \
  --public

if [ "${BUILD_LINUX_TOO:-0}" = "1" ]; then
  echo "▶︎ Собираю такую же версию под Linux (для проверки сборки тестами)…"
  npx --yes @yao-pkg/pkg launcher.js --config pkg.config.json --targets node20-linux-x64 \
    --output "$ROOT/release/KonturServer-linux" --compress GZip --public-packages "*" --public >/dev/null 2>&1 || true
fi

cd "$ROOT"
echo "▶︎ Кладу рядом веб-клиент и инструкцию…"
rm -rf release/web; cp -r web release/web
[ -f README-KLIENT.txt ] && cp README-KLIENT.txt release/ || true
[ -f scripts/reset-data.bat ] && cp scripts/reset-data.bat release/reset-data.bat || true
[ -f scripts/connect-to-server.bat ] && cp scripts/connect-to-server.bat release/connect-to-server.bat || true
[ -f scripts/reset-data.js ] && cp scripts/reset-data.js release/reset-data.js || true
[ -f "OBNOVLENIE-I-OCHISTKA.txt" ] && cp "OBNOVLENIE-I-OCHISTKA.txt" release/ || true

echo ""
echo "✅ Готово!"
ls -lh release/KonturServer.exe | awk '{print "   release/KonturServer.exe — " $5}'
echo "   release/web/  — веб-клиент (та же папка, что отдаёт сервер)"
echo "   release/reset-data.bat   — двойной клик = полная зачистка базы"
echo "   версия сборки: $VERSION ($BUILD_DATE)"
echo ""
echo "Как это работает на Windows:"
echo "   1) копируете папку release на компьютер с Windows (или только .exe — клиент распакуется сам);"
echo "   2) двойной клик по KonturServer.exe → сервер поднимается, окно мессенджера открывается само;"
echo "   3) в консоли сервера виден адрес в локальной сети, например http://192.168.1.10:4000 —"
echo "      его открывают друзья в той же сети, и переписка синхронизируется;"
echo "   4) история и файлы: %LOCALAPPDATA%\\Kontur\\data"
