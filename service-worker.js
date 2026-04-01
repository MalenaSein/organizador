// ─── ORGANIZADOR PERSONAL — Service Worker v3 ────────────────────────────────
// Soporta: cache offline + Firebase Cloud Messaging (notificaciones push)

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ── Firebase config (igual que en index.html) ─────────────────────────────────
firebase.initializeApp({
  apiKey:            "AIzaSyB3ghd87bGn-Ovl4dTTqod4C3OK4PIc0fs",
  authDomain:        "organizador-42dc3.firebaseapp.com",
  projectId:         "organizador-42dc3",
  storageBucket:     "organizador-42dc3.firebasestorage.app",
  messagingSenderId: "615484579948",
  appId:             "1:615484579948:web:024befa3447c4af3d2f849"
});

const messaging = firebase.messaging();

// ── Notificaciones en background (app cerrada / en segundo plano) ─────────────
messaging.onBackgroundMessage(payload => {
  const { title, body, icon, badge, data } = payload.notification || payload.data || {};

  self.registration.showNotification(title || '📅 Recordatorio', {
    body:    body  || 'Tenés un evento próximo.',
    icon:    icon  || '/organizador/icons/icon-192.png',
    badge:   badge || '/organizador/icons/icon-192.png',
    tag:     data?.eventId || 'organizador-notif',
    renotify: true,
    data:    data  || {},
    actions: [
      { action: 'open',    title: '📋 Ver evento' },
      { action: 'dismiss', title: 'Cerrar' },
    ],
  });
});

// ── Click en notificación → abrir la app ─────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();

  if (e.action === 'dismiss') return;

  const urlToOpen = '/organizador/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Si ya hay una pestaña abierta, enfocala
      for (const client of windowClients) {
        if (client.url.includes('/organizador') && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no, abrir nueva
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});

// ─── CACHE OFFLINE ────────────────────────────────────────────────────────────
const CACHE = 'organizador-v3';
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
      .catch(() => {}) // no fallar si algún asset no existe
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

  // Network-first para la página principal
  if (url.pathname === '/organizador/' || url.pathname === '/organizador/index.html') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first para el resto
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});