// UberSDR Service Worker
// Minimal service worker to satisfy PWA install criteria.
// Strategy: network-first for all requests — this is a live SDR app,
// so we never want stale data. We only cache the app shell for offline
// fallback so the user sees a useful message rather than a blank page.

// Bumped whenever SHELL_ASSETS changes: the activate handler deletes every
// cache that is not this one, which is how a stale shell is got rid of.
const CACHE_NAME = 'ubersdr-shell-v3';

// App-shell assets to pre-cache on install.
//
// The v2 interface first, because that is where the installed app opens — see
// start_url in handleManifest. v1's shell is kept beside it: it is still served,
// still linked, and an offline launch of either should say so rather than fail.
//
// addAll is all-or-nothing, so every path here has to exist. A typo does not
// degrade the cache, it stops the worker installing at all — and with it the
// install prompt this worker is here to earn.
const SHELL_ASSETS = [
  '/v2/',
  '/v2/dist/v2.css',
  '/v2/dist/v2.js',
  '/v2/vendor/react.production.min.js',
  '/v2/vendor/react-dom.production.min.js',
  '/opus-decoder.min.js',
  '/',
  '/style.css',
  '/app.js',
  '/images/android-chrome-192x192.png',
  '/images/android-chrome-512x512.png',
];

// ── Install: pre-cache shell assets ──────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  // Activate immediately without waiting for old tabs to close
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// ── Fetch: network-first, fall back to cache ──────────────────────────────────
self.addEventListener('fetch', (event) => {
  // Only handle GET requests; let everything else pass through
  if (event.request.method !== 'GET') return;

  // Don't intercept WebSocket upgrades, API/SSE streams, or addon requests.
  // Addon paths are prefixed with /addon/ and may contain their own streaming
  // API endpoints (SSE, audio) that must not be intercepted.
  const url = new URL(event.request.url);
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/addon/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/sse')
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache a clone of successful responses for the shell assets
        if (response.ok && SHELL_ASSETS.includes(url.pathname)) {
          const clone = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, clone))
            .catch(() => {}); // ignore storage errors
        }
        return response;
      })
      .catch(() =>
        // Network failed — serve from cache if available
        caches.match(event.request).then(
          (cached) =>
            // A redirected response cannot be returned for a navigation: the
            // browser rejects it and shows its own network error page, and that
            // rejection happens inside respondWith where the catch below can't
            // reach it. '/' is pre-cached and redirects to /v2/ whenever the v2
            // interface is enabled, so this case is reachable — fall through to
            // the offline message instead.
            (cached && !cached.redirected ? cached : null) ||
            new Response('<h1>UberSDR</h1><p>You are offline. Please reconnect to use UberSDR.</p>', {
              headers: { 'Content-Type': 'text/html' },
            })
        )
      )
      // Safety net: ensure respondWith never rejects, even if caches.match() fails
      .catch(() =>
        new Response('<h1>UberSDR</h1><p>You are offline. Please reconnect to use UberSDR.</p>', {
          headers: { 'Content-Type': 'text/html' },
        })
      )
  );
});
