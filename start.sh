#!/usr/bin/env bash
# Запуск мессенджера из исходников
set -e
cd "$(dirname "$0")"
if [ ! -d server/node_modules ]; then
  echo "▶︎ Первый запуск: ставлю зависимости…"
  (cd server && npm install --no-audit --no-fund)
fi
exec node server/server.js --open "$@"
