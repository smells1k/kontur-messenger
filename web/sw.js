/* ==========================================================================
   Мессенджер «Контур» — служебный скрипт приложения (офлайн-оболочка).

   Задача: чтобы «Контур» можно было поставить как обычное приложение
   (телефон и ПК) и чтобы при пропаже сервера открывалась хотя бы оболочка.

   Правила простые и безопасные:
     • запросы к серверу (/api, /ws, /uploads, /health) НИКОГДА не кэшируются —
       иначе можно увидеть чужую или устаревшую переписку;
     • страница и статика: сначала сеть, при отсутствии сети — копия из кэша;
     • кэш чистится при обновлении версии сервера.
   ========================================================================== */
'use strict';

const CACHE = 'kontur-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/build-info.js',
  '/js/emoji-data.js',
  '/js/app.js',
  '/js/call.js',
  '/js/ui.js',
  '/icon-192.png',
  '/icon-512.png',
  '/favicon-32.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                       // чужие адреса не трогаем
  if (/^\/(api|ws|health|uploads)\b/.test(url.pathname)) return;    // данные сервера — только живьём

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
