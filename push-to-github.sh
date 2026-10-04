#!/usr/bin/env bash
# =============================================================================
# Публикация мессенджера «Контур» на GitHub — одной командой.
#
# Вариант 1 (репозиторий ещё не создан) — нужен токен GitHub с правом «repo»:
#   TOKEN=ghp_xxxxxxxx bash push-to-github.sh мой-логин/kontur-messenger
#
# Вариант 2 (репозиторий уже создан вручную):
#   bash push-to-github.sh https://github.com/мой-логин/kontur-messenger.git
#
# Что делает: коммитит исходники, пушит ветку main, публикует релиз v1.0.0
# и прикладывает к нему собранный release/KonturServer.exe.
# Токен нигде не сохраняется: используется только в командной строке.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

ARG="${1:-}"
VERSION="1.0.0"
TAG="v$VERSION"

if [ -z "$ARG" ]; then
  echo "Использование:"
  echo "  TOKEN=ghp_xxx bash push-to-github.sh логин/репозиторий"
  echo "  bash push-to-github.sh https://github.com/логин/репозиторий.git"
  exit 1
fi

# ── 1. локальный коммит ──────────────────────────────────────────────────────
git config user.name  >/dev/null 2>&1 || git config user.name "Kontur Messenger"
git config user.email >/dev/null 2>&1 || git config user.email "kontur@example.com"
[ -d .git ] || git init -q
git add -A
git commit -q -m "Мессенджер «Контур» $VERSION: сервер Node.js, веб-клиент, .exe для Windows" || echo "• коммитить нечего — всё уже сохранено"
git branch -M main

# ── 2. адрес репозитория (и, при необходимости, создание) ────────────────────
if [[ "$ARG" == http* ]]; then
  CLONE_URL="$ARG"
  API_REPO="${ARG#https://github.com/}"; API_REPO="${API_REPO%.git}"
else
  API_REPO="$ARG"
  CLONE_URL="https://github.com/$API_REPO.git"
  if [ -z "${TOKEN:-}" ]; then
    echo "❌ Для создания репозитория нужен TOKEN (право «repo»)."
    exit 1
  fi
  echo "▶︎ Создаю репозиторий $API_REPO…"
  curl -sS -X POST https://api.github.com/user/repos \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -d "{\"name\":\"${API_REPO##*/}\",\"description\":\"Мессенджер на Node.js: сервер, веб-клиент и .exe. Синхронизация, группы, файлы, видео, эмодзи\",\"private\":false,\"has_issues\":true}" \
    | grep -q '"full_name"' && echo "   ✓ репозиторий создан" || echo "   • репозиторий, возможно, уже существует — продолжаю"
fi

# ── 3. пуш ветки ─────────────────────────────────────────────────────────────
echo "▶︎ Отправляю код в $CLONE_URL…"
if [ -n "${TOKEN:-}" ]; then
  git push -f "https://x-access-token:${TOKEN}@github.com/${API_REPO}.git" main
else
  git push -u origin main 2>/dev/null || git push -f "$CLONE_URL" main
fi
echo "   ✓ код опубликован"

# ── 4. релиз с .exe ──────────────────────────────────────────────────────────
if [ -f release/KonturServer.exe ]; then
  if [ -z "${TOKEN:-}" ]; then
    echo "ℹ Чтобы приложить .exe к релизу, повторите с TOKEN=… либо загрузите вручную:"
    echo "   https://github.com/$API_REPO/releases/new"
    exit 0
  fi
  echo "▶︎ Публикую релиз $TAG с KonturServer.exe…"
  RELEASE_ID=$(curl -sS -X POST "https://api.github.com/repos/$API_REPO/releases" \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"Мессенджер «Контур» $VERSION\",\"body\":\"Windows: скачайте KonturServer.exe и запустите. Демо-вход: anya / demo1234.\"}" \
    | sed -n 's/.*"id": \([0-9]*\).*/\1/p' | head -1)
  if [ -z "$RELEASE_ID" ]; then
    echo "   ⚠️ не удалось создать релиз (тег $TAG уже существует?) — загрузите .exe вручную"
  else
    curl -sS -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \
      --data-binary @release/KonturServer.exe \
      "https://uploads.github.com/repos/$API_REPO/releases/$RELEASE_ID/assets?name=KonturServer.exe" \
      | grep -q '"browser_download_url"' && echo "   ✓ .exe приложен к релизу"
  fi
fi

echo ""
echo "✅ Готово: https://github.com/$API_REPO"
echo "   • GitHub Actions сам пересоберёт .exe при пуше тега:  git tag v1.0.1 && git push --tags"
