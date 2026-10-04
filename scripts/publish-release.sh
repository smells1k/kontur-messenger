#!/usr/bin/env bash
# =============================================================================
# Публикация релиза на GitHub одной командой.
#
# Запуск:  bash scripts/publish-release.sh <ТОКЕН>
# Токен нужен с правами repo (classic) или Contents: Read and write (fine-grained).
# Токен нигде не сохраняется: используется только в этой команде (git и API).
#
# Что делает:
#   1) проверяет токен и доступ к репозиторию;
#   2) пушит ветку main;
#   3) ставит тег = версии из package.json и пушит его;
#   4) ждёт сборку в GitHub Actions и печатает итог;
#   5) проверяет, что в релизе лежат все файлы.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="${1:-${GH_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "Использование: bash scripts/publish-release.sh <ТОКЕН>"
  echo "Токен: https://github.com/settings/tokens (права repo / Contents: Read and write)"
  exit 1
fi

REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#.*github.com[:/](.+)\.git#\1#' || true)"
[ -n "$REPO" ] || REPO="smells1k/kontur-messenger"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
API="https://api.github.com/repos/$REPO"

echo "▶︎ Репозиторий: $REPO · версия: $VERSION (тег $TAG)"

echo "▶︎ Проверяю токен…"
LOGIN="$(curl -s -H "Authorization: Bearer $TOKEN" https://api.github.com/user | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -1)"
if [ -z "$LOGIN" ]; then
  echo "❌ Токен не подошёл (GitHub ответил 401). Проверьте, что он не отозван и есть права repo."
  exit 1
fi
echo "   ✅ Токен активен, аккаунт: $LOGIN"

echo "▶︎ Пушу ветку main…"
git push "https://$TOKEN@github.com/$REPO.git" HEAD:main
echo "   ✅ main отправлен"

echo "▶︎ Ставлю тег $TAG и отправляю его (это запускает сборку и публикацию релиза)…"
git tag -f "$TAG"
git push -f "https://$TOKEN@github.com/$REPO.git" "$TAG"
echo "   ✅ Тег отправлен — GitHub Actions собирает .exe"

echo "▶︎ Жду сборку (обычно 1–3 минуты)…"
RUN_ID=""
for _ in $(seq 1 30); do
  sleep 10
  RUN_ID="$(curl -s -H "Authorization: Bearer $TOKEN" "$API/actions/runs?per_page=5" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((r['id'] for r in d.get('workflow_runs',[]) if r.get('head_branch')=='$TAG'),''))" 2>/dev/null || true)"
  [ -n "$RUN_ID" ] && break
done
if [ -n "$RUN_ID" ]; then
  STATUS="in_progress"
  for _ in $(seq 1 40); do
    sleep 15
    STATUS="$(curl -s -H "Authorization: Bearer $TOKEN" "$API/actions/runs/$RUN_ID" \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['status'], d['conclusion'])" 2>/dev/null || echo 'unknown')"
    case "$STATUS" in completed*) break;; esac
  done
  echo "   Сборка: $STATUS"
  curl -s -H "Authorization: Bearer $TOKEN" "$API/actions/runs/$RUN_ID/jobs" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
for j in d.get('jobs',[]):
    for s in j.get('steps',[]):
        print('   ', '✓' if s.get('conclusion')=='success' else ('…' if s.get('conclusion') is None else '✗'), s['name'])
" 2>/dev/null || true
else
  echo "   ⚠️ Не нашёл запуск сборки — проверьте вкладку Actions вручную."
fi

echo "▶︎ Проверяю файлы релиза…"
curl -s -H "Authorization: Bearer $TOKEN" "$API/releases/tags/$TAG" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if d.get('message'):
    print('   ⚠️ Релиз ещё не создан:', d['message'])
else:
    print('   ✅ Релиз:', d['html_url'])
    for a in d.get('assets', []):
        print('     •', a['name'], round(a['size']/1048576, 2), 'МБ —', a['browser_download_url'])
" 2>/dev/null || echo "   ⚠️ Не удалось прочитать релиз — откройте https://github.com/$REPO/releases"

echo ""
echo "✅ Готово. Ссылка для скачивания: https://github.com/$REPO/releases/latest"
echo "🔐 Не забудьте отозвать токен: https://github.com/settings/tokens"
