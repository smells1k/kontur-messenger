#!/usr/bin/env bash
# =============================================================================
# Сборка полноценного десктопного приложения для Windows (Electron + NSIS).
# Требует интернет: скачивает Electron и winCodeSign (~200 МБ).
# NSIS-инсталлятор на Linux собирается только при наличии wine —
# поэтому основной путь: собрать на Windows или использовать portable-цель.
#
#   bash scripts/make-windows-exe.sh        # сначала сервер (KonturServer.exe)
#   bash scripts/build-electron-win.sh      # потом приложение
#
# Результат: release-desktop/Kontur-Setup-1.0.0.exe, Kontur-Portable-1.0.0.exe
#
# Переменные:
#   PORTABLE_ONLY=1 — собирать только portable (без wine, работает из Linux)
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ ! -f release/KonturServer.exe ]; then
  echo "⚠️  KonturServer.exe ещё не собран — собираю сервер…"
  bash scripts/make-windows-exe.sh
fi

cd desktop
echo "▶︎ Устанавливаю electron и electron-builder (это может занять несколько минут)…"
npm install --no-audit --no-fund

TARGETS="--win nsis portable --x64"
[ "${PORTABLE_ONLY:-0}" = "1" ] && TARGETS="--win portable --x64"

echo "▶︎ Собираю приложение под Windows x64…"
npx electron-builder $TARGETS

echo ""
echo "✅ Готово: смотрите папку release-desktop/"
ls -lh ../release-desktop 2>/dev/null || true
