/**
 * Commons service worker.
 *
 * Two jobs, and deliberately no more:
 *   1. Make the app open instantly, and open at all with no signal — the shell
 *      is cached, so a member on a bus sees the app rather than a browser error.
 *   2. Never serve stale community content. Posts and people always come from
 *      the network; only the shell is cached.
 *   3. Show a push notification when the server sends one, and open the right
 *      page when it is tapped. The server never sends more than a name, a
 *      verb, a title and a link.
 *
 * Bump SHELL_VERSION whenever commons.js or commons.css changes, or returning
 * members keep the old file until their cache is evicted.
 */
const SHELL_VERSION = 'commons-shell-v8';

const SHELL = [
  '/',
  '/commons.css',
  '/commons.js',
  '/ambient.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline.html',
  // The faces the whole product is set in, so an offline open looks right.
  '/fonts/instrument-serif.woff2',
  '/fonts/instrument-serif-italic.woff2',
  '/fonts/public-sans-400.woff2',
  '/fonts/public-sans-600.woff2',
  '/fonts/public-sans-700.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_VERSION)
      // Individually, so one missing file cannot fail the whole install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The live-updates stream must never be intercepted — a cached response
  // would end the connection and the page would stop updating.
  if (url.pathname === '/api/community/stream') return;

  // Community data is always fresh or nothing. Showing yesterday's posts as if
  // they were current would be worse than showing an error.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: try the network, fall back to the cached shell, then to a
  // page that explains what happened.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_VERSION).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? caches.match('/offline.html'))),
    );
    return;
  }

  // Static assets: cache first, and refresh the copy in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const fresh = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_VERSION).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? fresh;
    }),
  );
});

// ---------------------------------------------------------------- push

self.addEventListener('push', (event) => {
  let data = { title: 'Commons', body: '', url: '/', tag: undefined };
  try { data = { ...data, ...event.data.json() }; } catch { /* a bare push with no body */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag,
    renotify: Boolean(data.tag),
    data: { url: data.url },
  }));
});

// Tapping it focuses an open Commons window on that page, or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (same) return same.navigate(url).then((w) => w?.focus());
      return self.clients.openWindow(url);
    }),
  );
});
