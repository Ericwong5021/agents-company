const cacheName = "agent-company-install-v1"
const cachePrefix = "agent-company-install-"
const appAssets = [
  "/agent-company-icon-180.png",
  "/agent-company-icon-192.png",
  "/agent-company-icon-512.png",
  "/agent-company-mark.svg",
  "/manifest.webmanifest",
]
const appAssetPaths = new Set(appAssets)

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(appAssets)).then(() => self.skipWaiting()))
})

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !appAssetPaths.has(url.pathname)) return
  event.respondWith(
    fetch(event.request)
      .then(async response => {
        if (response.ok) await caches.open(cacheName).then(cache => cache.put(event.request, response.clone()))
        return response
      })
      .catch(async error => {
        const response = await caches.match(event.request)
        if (response) return response
        throw error
      }),
  )
})
