// SW minimal pour installabilité (pas de cache API ni data)
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
