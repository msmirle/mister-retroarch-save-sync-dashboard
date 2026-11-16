'use strict';

// Bump the version when changing app-shell files so installed apps refresh their offline copy.
const CACHE_PREFIX = 'save-dashboard-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const APP_SHELL = [
  '/',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only app-shell GETs can fall back to cache; scans and health checks always use the network.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin
    || !APP_SHELL.includes(url.pathname)) return;

  event.respondWith(fetch(event.request).catch(async (error) => {
    const cached = await (await caches.open(CACHE_NAME)).match(url.pathname);
    if (cached) return cached;
    throw error;
  }));
});
