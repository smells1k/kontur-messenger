'use strict';
/**
 * Версия сборки. В исходниках берётся из server/package.json,
 * при сборке .exe — генерируется скриптом scripts/make-windows-exe.sh
 * (чтобы версия была видна и внутри упакованного файла).
 */
let version = '1.0.7';
let builtAt = '';

try {
  const pkg = require('../package.json');
  version = pkg.version || version;
} catch { /* запуск из упакованного .exe */ }

try {
  const root = require('../../package.json');
  if (!builtAt) builtAt = root.buildDate || '';
} catch { /* нет — не страшно */ }

if (process.env.KONTUR_VERSION) version = String(process.env.KONTUR_VERSION);
if (process.env.KONTUR_BUILD_DATE) builtAt = String(process.env.KONTUR_BUILD_DATE);

module.exports = { version, builtAt, label: builtAt ? `${version} (сборка ${builtAt})` : version };
