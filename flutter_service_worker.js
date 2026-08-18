// This worker replaces legacy Flutter PWA workers that may still control the
// /naspet/ preview. New Naspet previews do not register it; it exists only so
// already-registered workers can update, clear their own scoped caches, and
// release open clients.

function isWithinNaspetScope(url) {
  const scopeUrl = new URL(self.registration.scope);
  return new URL(url, scopeUrl).pathname.startsWith(scopeUrl.pathname);
}

async function clearNaspetCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.map(async (key) => {
    const cache = await caches.open(key);
    const requests = await cache.keys();
    const naspetRequests = requests.filter((request) =>
      isWithinNaspetScope(request.url)
    );
    await Promise.all(
      naspetRequests.map((request) => cache.delete(request))
    );
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearNaspetCaches();
    await self.clients.claim();

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    await Promise.all(clients
      .filter((client) => isWithinNaspetScope(client.url))
      .map((client) => {
        const nextUrl = new URL(client.url);
        nextUrl.searchParams.set('naspet_cache_reset', 'legacy-worker');
        return client.navigate(nextUrl.toString());
      }));
  })());
});
