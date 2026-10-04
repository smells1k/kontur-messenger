'use strict';
/**
 * Небольшой модуль безопасности: ограничение частоты запросов и безопасные
 * имена загружаемых файлов.
 *
 * Зачем: у мессенджера нет внешней защиты (он живёт на домашнем компьютере
 * и может быть открыт в интернет через --tunnel), поэтому базовые барьеры —
 * подбор пароля, флуд сообщениями, заливка «бесконечных» файлов и загрузка
 * скриптов под видом картинок — должны стоять внутри.
 */
const path = require('path');

/* ------------------------------------------------------------------ лимиты */

/**
 * Ограничитель частоты: считает обращения по ключу в окне windowMs.
 * Возвращает функцию check(key) → { ok, retryAfter }.
 */
function rateLimiter({ windowMs = 60_000, max = 60, name = 'requests' } = {}) {
  const hits = new Map();
  return {
    name,
    windowMs,
    max,
    /** Отметить обращение. */
    hit(key) {
      const now = Date.now();
      let rec = hits.get(key);
      if (!rec || rec.reset <= now) {
        rec = { count: 0, reset: now + windowMs };
        hits.set(key, rec);
      }
      rec.count++;
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      }
      return { ok: rec.count <= max, retryAfter: Math.max(1, Math.ceil((rec.reset - now) / 1000)), count: rec.count };
    },
    /** Успешное действие снимает накопленные неудачи (например, верный пароль). */
    reset(key) { hits.delete(key); },
  };
}

/** Адрес клиента с учётом туннеля (Cloudflare) — иначе все просьбы шли бы «от одного». */
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------ имена файлов */

const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/bmp': '.bmp', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
  'audio/webm': '.weba', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/opus': '.opus',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'text/csv': '.csv',
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip', 'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z', 'application/gzip': '.gz', 'application/x-tar': '.tar',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt', 'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/json': '.json', 'application/xml': '.xml',
};

/** Расширения, которые браузер может ВЫПОЛНИТЬ или отрисовать как страницу. */
const DANGEROUS_EXT = new Set([
  '.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml', '.xsl', '.xslt',
  '.js', '.mjs', '.cjs', '.jsx', '.php', '.phtml', '.php3', '.php4', '.php5', '.phar',
  '.asp', '.aspx', '.jsp', '.jspx', '.cgi', '.pl', '.py', '.rb', '.sh', '.bash', '.zsh',
  '.bat', '.cmd', '.com', '.exe', '.dll', '.scr', '.msi', '.jar', '.vbs', '.vbe', '.hta',
  '.ps1', '.psm1', '.psd1', '.reg', '.wsf', '.wsh', '.lnk', '.url', '.hta', '.htaccess',
]);

/** Типы, которые можно показывать прямо в переписке (картинка, видео, звук, pdf). */
const INLINE_MIME = /^(image\/(png|jpe?g|webp|gif|bmp|avif)|video\/(mp4|webm|quicktime)|audio\/|application\/pdf)/i;

/**
 * Безопасное расширение для сохранённого файла.
 * Имя из браузера не заслуживает доверия: «отчёт.html» превратился бы
 * в страницу, которую сервер отдаёт с того же адреса, — то есть в чужой скрипт
 * в вашем домене. Поэтому опасные расширения заменяются на нейтральные.
 */
function safeUploadExt(originalName, mime) {
  let ext = String(path.extname(String(originalName || '')) || '').toLowerCase();
  ext = ext.replace(/[^.a-z0-9]/g, '').slice(0, 9);
  if (DANGEROUS_EXT.has(ext)) ext = '';
  if (!ext) ext = MIME_EXT[String(mime || '').toLowerCase().split(';')[0].trim()] || '';
  if (DANGEROUS_EXT.has(ext)) ext = '';
  if (!ext) ext = '.bin';
  return ext;
}

/** Отдавать файл вложением (скачиванием), а не открывать в окне браузера. */
function forceDownload(mime) {
  return !INLINE_MIME.test(String(mime || ''));
}

module.exports = { rateLimiter, clientIp, MIME_EXT, DANGEROUS_EXT, safeUploadExt, forceDownload };
