/* 穗芽英语离线壳：版本号变化时旧缓存会自动清理。 */
const VERSION = 'v4'
const SHELL_CACHE = `suiya-shell-${VERSION}`
const ASSET_CACHE = `suiya-assets-${VERSION}`
const MEDIA_CACHE = 'suiya-media-v1'
const CACHE_NAMES = new Set([SHELL_CACHE, ASSET_CACHE, MEDIA_CACHE])

const SCOPE = self.registration.scope
const INDEX_URL = new URL('./index.html', SCOPE).href
const ROOT_URL = new URL('./', SCOPE).href
const MANIFEST_URL = new URL('./manifest.webmanifest', SCOPE).href
const ASSET_LIST_URL = new URL('./asset-manifest.json', SCOPE).href
const OFFLINE_ICONS = [
  new URL('./icons/icon.svg', SCOPE).href,
  new URL('./icons/icon-192.png', SCOPE).href,
  new URL('./icons/icon-512.png', SCOPE).href,
  new URL('./icons/icon-maskable-512.png', SCOPE).href,
  new URL('./icons/apple-touch-icon.png', SCOPE).href,
]

const OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>穗芽英语 · 暂时离线</title>
<style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#F8F3E8;color:#1E2927;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;text-align:center;padding:24px}div{max-width:320px}h1{font-size:22px;margin:0 0 8px}p{font-size:14px;line-height:1.7;color:#6C7773;margin:0}span{font-size:28px}</style>
</head><body><div><span>🌱</span><h1>暂时离线了</h1><p>请联网打开一次穗芽英语，缓存好课程后就能离线学习。</p></div></body></html>`

function absolute(path) {
  return new URL(path, SCOPE).href
}

async function cacheShell() {
  const shell = await caches.open(SHELL_CACHE)
  const assets = await caches.open(ASSET_CACHE)

  try {
    const htmlResponse = await fetch(INDEX_URL, { cache: 'reload' })
    if (htmlResponse.ok) {
      const html = await htmlResponse.clone().text()
      await shell.put(INDEX_URL, htmlResponse.clone())
      await shell.put(ROOT_URL, htmlResponse)
      await precacheBuildAssets(html, assets)
    }
  } catch {
    /* 安装时网络不稳，已缓存的内容仍然可用 */
  }

  await Promise.allSettled([MANIFEST_URL, ...OFFLINE_ICONS].map((url) => shell.add(url)))
}

async function precacheBuildAssets(html, cache) {
  const assetUrls = new Set()
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(match[1], INDEX_URL)
    if (url.href.startsWith(SCOPE)) assetUrls.add(url.href)
  }

  try {
    const response = await fetch(ASSET_LIST_URL, { cache: 'reload' })
    if (response.ok) {
      const manifest = await response.json()
      for (const asset of manifest.assets ?? []) {
        assetUrls.add(new URL(asset, ASSET_LIST_URL).href)
      }
    }
  } catch {
    /* 资源清单缺失时仍按 HTML 引用的入口缓存 */
  }

  await Promise.allSettled([...assetUrls].map((url) => cache.add(url)))

  const cssUrls = [...assetUrls].filter((url) => /\.css(?:\?|$)/.test(url))
  const nested = new Set()
  await Promise.allSettled(
    cssUrls.map(async (cssUrl) => {
      const response = await fetch(cssUrl, { cache: 'reload' })
      if (!response.ok) return
      const css = await response.text()
      for (const match of css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
        if (/^data:/.test(match[2])) continue
        nested.add(new URL(match[2], cssUrl).href)
      }
    }),
  )
  await Promise.allSettled([...nested].map((url) => cache.add(url)))
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name.startsWith('suiya-') && !CACHE_NAMES.has(name)).map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

async function networkFirstNavigation(request) {
  const shell = await caches.open(SHELL_CACHE)
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 4200))

  try {
    const response = await Promise.race([fetch(request), timeout])
    if (response && response.ok) {
      await shell.put(INDEX_URL, response.clone())
      await shell.put(ROOT_URL, response.clone())
      return response
    }
  } catch {
    /* 离线或网络失败，走缓存 */
  }

  return (
    (await shell.match(INDEX_URL)) ||
    (await shell.match(ROOT_URL)) ||
    new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  )
}

function partialResponse(cached, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return null
  const size = Number(cached.headers.get('Content-Length') ?? 0)
  if (!size) return null
  let start
  let end
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!suffix) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start >= size || end < start) return null
  return cached.arrayBuffer().then((buffer) => {
    const body = buffer.slice(start, end + 1)
    return new Response(body, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    })
  })
}

async function audioResponse(request) {
  const cache = await caches.open(MEDIA_CACHE)
  // 离线包按完整 URL 缓存整段音频，Range 请求需从整段内容切片返回。
  const cached = await cache.match(request.url, { ignoreVary: true })
  const range = request.headers.get('range')
  if (cached) {
    if (!range) return cached
    const partial = await partialResponse(cached, range)
    return partial || cached
  }

  const response = await fetch(request)
  // 206 不能写入 Cache Storage，否则 respondWith 会直接失败。
  if (response.status === 200) {
    await cache.put(request.url, response.clone()).catch(() => {})
  }
  return response
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request, { ignoreVary: true })
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone())
      return response
    })
    .catch(() => null)

  return cached || (await network) || Response.error()
}

function isAudio(url) {
  return /\/audio\//.test(url.pathname) || /\.(?:mp3|m4a|wav|ogg)$/i.test(url.pathname)
}

function isStatic(url) {
  return /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico|webmanifest|json)$/i.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('/sw.js')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }

  if (isAudio(url)) {
    event.respondWith(audioResponse(request))
    return
  }

  if (isStatic(url)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE))
  }
})
