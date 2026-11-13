// WR Timing service worker. Live timing can't work offline, so nothing is
// cached: when a page can't load (no signal in the paddock), show a small
// "waiting for connection" screen that reloads itself once the phone is back
// online, instead of the browser's error page.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07080c"><title>WR Timing</title>
<style>html,body{height:100%;margin:0;background:#07080c;color:#e8eaf0;font:16px system-ui,sans-serif}
body{display:grid;place-items:center;text-align:center}img{width:72px;height:72px;border-radius:16px}
p{color:#9aa0ae;margin:.4rem 0}b{display:block;margin-top:1rem;font-size:1.2rem}</style></head>
<body><div><img src="/icons/wr-192.png" alt=""><b>No connection</b>
<p>WR Timing reconnects as soon as you have signal.</p></div>
<script>addEventListener('online',()=>location.reload());setInterval(()=>location.reload(),5000)</script>
</body></html>`

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  e.respondWith(
    fetch(e.request).catch(() => new Response(OFFLINE, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })),
  )
})
