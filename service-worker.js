// service-worker.js — cache hors ligne de l'application.
// Pour publier une nouvelle version : changer VERSION (le cache précédent est supprimé à l'activation).
const VERSION = 'lab-v4';
const LIBS = 'lab-libs';   // bibliothèques CDN (MapLibre) : conservées entre les versions
const SHELL = [
  './', './index.html', './manifest.json',
  './css/ic.css', './css/style.css', './css/pwa.css',
  './storage-ns.js', './pwa.js', './geo-perm.js', './models.js', './routing.js', './icon-util.js', './qr-util.js', './contexts.js',
  './network-store.js', './demo-network.js', './ui-form.js', './ticket-search.js',
  './ctx-feed.js', './ctx-calendar.js', './detect.js', './ctx-detect.js', './ctx-feed-pages.js', './ctx-feed-data.js', './server-data.js',
  './smap.js', './gl-map.js', './carte-detect.js', './ctx-carte.js', './ctx-reglages.js', './bang.js',
  './pictos/mainpicto.svg', './pictos/bus.svg', './pictos/car.svg', './pictos/metro.svg',
  './pictos/train.svg', './pictos/tramway.svg', './pictos/velo-libre-service.svg',
  './pictos/velo.svg', './pictos/voiture.svg',
  './icons/icon-192x192.png', './icons/icon-512x512.png', './icons/icon-maskable-512x512.png',
  './icons/icon-256x256.png', './icons/icon-menu.svg', './icons/icon-preferences.svg',
  './icons/map-busstop-mono.svg', './icons/map-cursor-b.svg', './icons/map-location.svg',
  './icons/map-ways-mono.svg',
  './icons/delete-svgrepo-com.svg', './icons/copy-svgrepo-com.svg'
];

self.addEventListener('install', event => {
  // Un fichier manquant ne doit pas faire échouer toute l'installation
  event.waitUntil(caches.open(VERSION).then(cache =>
    Promise.all(SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => null)))));
  // Pas de skipWaiting automatique : la page propose « Mettre à jour » (message SKIP_WAITING)
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== LIBS).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // MapLibre (CDN) : cache d'abord, pour fonctionner hors ligne après le premier chargement
    if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/maplibre-gl@')) {
      event.respondWith(caches.open(LIBS).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      }));
    }
    return;                                                  // autres origines : réseau seul
  }

  // Tout (pages et ressources) : réseau d'abord, cache seulement en secours (hors ligne / serveur lent).
  // Évite de mélanger d'anciens et de nouveaux fichiers pendant le développement.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
      ]);
      if (res && res.ok) cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(req.mode === 'navigate' ? './index.html' : req, { ignoreSearch: true });
      if (hit) return hit;
      throw e;
    }
  })());
});
