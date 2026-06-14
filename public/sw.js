const CACHE = 'sc-v8';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Nunca interceptar requisições Firebase / googleapis / Mercado Pago / Render
  const url = e.request.url;
  if (
    url.includes('firestore') ||
    url.includes('googleapis') ||
    url.includes('firebase') ||
    url.includes('mercadopago') ||
    url.includes('render.com') ||
    url.includes('anthropic') ||
    url.includes('identitytoolkit')
  ) return;

  // HTML principal: network-first — sempre busca versão mais recente na rede
  const isHTML = e.request.destination === 'document' ||
                 url.endsWith('/') ||
                 url.endsWith('/index.html');

  if (isHTML) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
    );
    return;
  }

  // Assets estáticos: cache-first com fallback para rede
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      });
    })
  );
});

// Receber mensagem para forçar atualização
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
