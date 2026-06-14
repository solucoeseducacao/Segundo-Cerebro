const CACHE = 'sc-v6';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
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
  if (e.request.url.includes('firestore') || e.request.url.includes('googleapis')) return;

  // HTML principal: network-first — sempre busca versão mais recente na rede
  // Só usa cache se estiver completamente offline
  const isHTML = e.request.destination === 'document' ||
                 e.request.url.endsWith('/') ||
                 e.request.url.endsWith('/index.html');

  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.o