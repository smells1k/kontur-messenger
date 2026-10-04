'use strict';
/**
 * Генерация web/js/emoji-data.js.
 *
 * Отбираем только «безопасные» эмодзи, которые рисуются одним символом
 * и есть в стандартных шрифтах Windows/macOS/Android — чтобы в панели
 * не было пустых квадратиков (тофу).
 *
 * Что отбрасываем:
 *   • составные последовательности (ZWJ) — 👨‍👩‍👧, 👩‍💻 и прочие «дуо»;
 *   • модификаторы тона кожи (🏻🏼🏽🏾🏿);
 *   • эмодзи-флаги (на Windows рисуются буквами);
 *   • keycap-последовательности (1️⃣, #️⃣);
 *   • всё, что появилось в Unicode позже 13.0 (старые шрифты показывают квадрат).
 *
 * Запуск:  node scripts/generate-emoji.js   (нужен пакет emoji-datasource в server/)
 */
const fs = require('fs');
const path = require('path');

function loadDatasource() {
  const candidates = ['emoji-datasource', '../server/node_modules/emoji-datasource', './node_modules/emoji-datasource'];
  for (const c of candidates) {
    try { return require(c); } catch (err) { /* пробуем следующий путь */ }
  }
  console.error('Нужен пакет emoji-datasource:  cd server && npm i -D emoji-datasource');
  process.exit(1);
}
const datasource = loadDatasource();

const SKIN_TONES = new Set(['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF']);
const MAX_VERSION = 13.0;

const CATEGORY_ORDER = [
  'Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink',
  'Travel & Places', 'Activities', 'Objects', 'Symbols',
];
const CATEGORY_TITLES = {
  'Smileys & Emotion': 'Смайлы и эмоции',
  'People & Body': 'Люди и жесты',
  'Animals & Nature': 'Животные и природа',
  'Food & Drink': 'Еда и напитки',
  'Travel & Places': 'Путешествия и места',
  'Activities': 'Активности',
  'Objects': 'Предметы',
  'Symbols': 'Символы',
};

const versionNum = (v) => (v ? parseFloat(String(v)) : 0);

function keep(entry) {
  const parts = String(entry.unified).split('-');
  if (parts.some((p) => SKIN_TONES.has(p))) return false;         // тон кожи
  if (parts.includes('200D')) return false;                        // ZWJ-«дуо» и профессии
  if (parts.includes('20E3')) return false;                        // keycap
  if (/^1F1E6/.test(parts[0])) return false;                       // флаги
  const meaningful = parts.filter((p) => p !== 'FE0F' && p !== 'FE0E');
  if (meaningful.length !== 1) return false;                       // составные
  if (versionNum(entry.added_in) > MAX_VERSION) return false;      // слишком новые
  if (entry.obsoleted_by) return false;
  return true;
}

const cats = new Map();
let dropped = 0;
for (const entry of datasource) {
  if (!keep(entry)) { dropped++; continue; }
  const ch = entry.unified.split('-').filter((p) => p !== 'FE0F')
    .map((h) => String.fromCodePoint(parseInt(h, 16))).join('');
  const cat = entry.category;
  if (!CATEGORY_ORDER.includes(cat)) { dropped++; continue; }
  if (!cats.has(cat)) cats.set(cat, []);
  cats.get(cat).push({
    e: ch,
    s: entry.short_name,
    k: [...new Set([...(entry.short_names || []).slice(0, 6), entry.short_name])].filter(Boolean),
    t: entry.sort_order,
  });
}

const out = CATEGORY_ORDER.filter((c) => cats.has(c)).map((c) => ({
  name: CATEGORY_TITLES[c] || c,
  key: c,
  items: cats.get(c).sort((a, b) => a.t - b.t).map(({ e, s, k }) => ({ e, s, k })),
}));

const total = out.reduce((n, c) => n + c.items.length, 0);
const target = path.resolve(__dirname, '..', 'web', 'js', 'emoji-data.js');
fs.writeFileSync(target, 'window.EMOJI_CATEGORIES=' + JSON.stringify(out) + ';\n');

console.log('✅ Эмодзи-набор обновлён');
for (const c of out) console.log(`   ${c.name.padEnd(22)} ${String(c.items.length).padStart(4)}`);
console.log(`   итого: ${total} (отброшено как неподдерживаемые: ${dropped})`);
console.log(`   файл: ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} КБ)`);
