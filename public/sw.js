/**
 * ComfyUI·Info 离线 Service Worker（F2）。
 * 应用本体是单个 HTML 文件（全部 JS/CSS 已内联），缓存策略极简：
 * 同源 GET 走 cache-first，未命中回源并回填；导航请求离线时兜底到入口页。
 * 仅在 https / localhost 环境注册（index.html 内守卫），file:// 单文件版不受影响。
 */
const CACHE = 'comfyui-info-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg']))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  // 导航请求：命中缓存直接用，否则回源；离线且未命中时兜底入口页
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              const copy = res.clone()
              caches.open(CACHE).then((c) => c.put('./index.html', copy))
              return res
            })
            .catch(() => caches.match('./')),
      ),
    )
    return
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
          return res
        }),
    ),
  )
})
