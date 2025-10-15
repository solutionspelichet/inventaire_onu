// SW minimal pour installabilité (pas de cache de données)
// Ne met en cache aucun appel API.

self.addEventListener('install', (e) => {
  // immédiat
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  // prise de contrôle
  e.waitUntil(self.clients.claim());
});
