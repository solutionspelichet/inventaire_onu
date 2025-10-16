// service-worker.js — minimal, scope racine, contrôle immédiat
const CACHE = 'static-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=3',
  './app.js?v=3',
  './manifest.webmanifest?v=1',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// pass-through simple (serre les assets si dispo)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
