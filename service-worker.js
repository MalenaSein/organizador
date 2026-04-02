importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyB3ghd87bGn-Ovl4dTTqod4C3OK4PIc0fs",
  authDomain:        "organizador-42dc3.firebaseapp.com",
  projectId:         "organizador-42dc3",
  storageBucket:     "organizador-42dc3.firebasestorage.app",
  messagingSenderId: "615484579948",
  appId:             "1:615484579948:web:024befa3447c4af3d2f849"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || '📅 Recordatorio', {
    body: body || 'Tenés un evento próximo.',
    icon: '/organizador/icons/icon-192.png',
    badge: '/organizador/icons/icon-192.png',
    tag: 'organizador-notif',
    renotify: true,
    actions: [
      { action: 'open',    title: '📋 Ver evento' },
      { action: 'dismiss', title: 'Cerrar' },
    ],
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/organizador/');
    })
  );
});

const CACHE = 'organizador-v5';
// Rutas relativas al scope del SW — con GitHub Pages vive en /organizador/
const ASSETS = [
  '/organizador/',
  '/organizador/index.html',
  '/organizador/manifest.json',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .catch(() => {}) // no bloquear si algo falla
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Para la página principal, intentar red primero y caché como fallback
  if (url.pathname === '/organizador/' || url.pathname === '/organizador/index.html') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Para el resto: caché primero, luego red
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});