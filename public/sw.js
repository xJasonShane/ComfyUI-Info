/**
 * ComfyUI·Info 离线 Service Worker（F2）。
 * 应用本体是单个 HTML 文件（全部 JS/CSS 已内联），页面新鲜即版本新鲜，缓存策略：
 * 导航请求 network-first——在线始终取最新入口页并回填缓存（保证每次部署后用户拿到新版本），
 * 离线 / 网络失败回退缓存快照；其余同源 GET（图标等基本不变的静态资源）走 cache-first。
 * 仅在 https / localhost 环境注册（index.html 内守卫），file:// 单文件版不受影响。
 */
const CACHE = 'comfyui-info-v3'

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
  // 导航请求 network-first：在线拿最新入口页并回填缓存，离线 / 网络失败回退缓存快照
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put('./index.html', copy))
          }
          return res
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./'))),
    )
    return
  }
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          // 404 / 5xx 不入缓存：cache-first 会把坏响应固化到下次 bump 版本才清掉
          if (!res.ok) return res
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
          return res
        }),
    ),
  )
})
