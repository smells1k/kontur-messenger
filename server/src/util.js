'use strict';
const crypto = require('crypto');

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Короткий, сортируемый по времени идентификатор. */
function newId(prefix) {
  const ts = Date.now().toString(36);
  let rnd = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) rnd += ALPHABET[b % 36];
  return `${prefix}_${ts}${rnd}`;
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Простой самодостаточный JWT (HS256) без внешних зависимостей. */
function signToken(payload, secret, ttlMs = 30 * 24 * 3600 * 1000) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

const AVATAR_COLORS = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
function colorFor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function cleanText(text, max = 4096) {
  return String(text == null ? '' : text).replace(/\u0000/g, '').slice(0, max).trim();
}

function isSafeId(id) {
  return typeof id === 'string' && /^[a-z]{1,8}_[a-z0-9]{4,40}$/i.test(id);
}

module.exports = { newId, hashPassword, verifyPassword, signToken, verifyToken, colorFor, cleanText, isSafeId, AVATAR_COLORS };
