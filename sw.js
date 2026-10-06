// Service worker dell'app infermieri: serve solo per le notifiche sul telefono
// (nessuna cache: la pagina si scarica sempre aggiornata).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// ═══ NOTIFICHE SUL TELEFONO (Web Push) ═══
// Le manda il motore su GitHub (.github/motore): arrivano anche ad app chiusa.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'Turni 118';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: 'icon-118-192.png',
    badge: 'icon-118-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
