// Offline support. Our own files: network first (so updates land), cache as fallback.
// Pinned CDN files (three, MindAR, fonts): cache first.
const CACHE = 'memory-graph-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'cloud.js', 'sync.js', 'friends.js', 'privacy.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const CDN = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const store = res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  };
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(store).catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(store)));
  }
});
