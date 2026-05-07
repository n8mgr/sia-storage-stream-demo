// sia-stream-sw.js — service worker that turns HTTP range requests into
// postMessage round-trips back to the page, where the SDK can satisfy them
// with `sdk.download(obj, { offset, length })`.
//
// The page registers an object via `registerStreamObject(obj, contentType)`
// in src/lib/video-stream.ts, which yields a URL like
// `/__sia_stream__/<encoded-id>`. Setting that as a <video src> kicks off
// the normal browser byte-range dance, which we intercept here.

const STREAM_PREFIX = '/__sia_stream__/'

self.addEventListener('install', (event) => {
  // Activate immediately on first install so we can serve streams without
  // a hard reload.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(STREAM_PREFIX)) return
  event.respondWith(handleStream(event))
})

/** @param {FetchEvent} event */
async function handleStream(event) {
  const url = new URL(event.request.url)
  const objectId = decodeURIComponent(url.pathname.slice(STREAM_PREFIX.length))
  const range = event.request.headers.get('Range')

  // Parse `Range: bytes=START-END?`. Suffix ranges (`bytes=-N`) are not
  // emitted by browser <video> elements in practice, so we don't bother.
  let start = 0
  let end = -1
  let hasRange = false
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range)
    if (m) {
      hasRange = true
      start = parseInt(m[1], 10)
      if (m[2] !== '') end = parseInt(m[2], 10)
    }
  }

  // Find a window client to forward the request to. `event.clientId` is
  // most reliable, but it's empty for some preflight cases — fall back to
  // any matching window.
  let client = event.clientId
    ? await self.clients.get(event.clientId)
    : null
  if (!client) {
    const windows = await self.clients.matchAll({ type: 'window' })
    client = windows[0] || null
  }
  if (!client) {
    return new Response('No active client to stream from.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  // MessageChannel: port1 stays here, port2 is shipped to the page.
  const { port1, port2 } = new MessageChannel()

  /** @type {ReadableStreamDefaultController<Uint8Array>} */
  let streamController
  let metaResolve
  let metaReject
  const metaPromise = new Promise((resolve, reject) => {
    metaResolve = resolve
    metaReject = reject
  })

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller
    },
    cancel() {
      try {
        port1.postMessage({ type: 'cancel' })
      } catch {}
      try {
        port1.close()
      } catch {}
    },
  })

  port1.onmessage = (e) => {
    const msg = e.data
    if (!msg) return
    switch (msg.type) {
      case 'metadata':
        metaResolve(msg)
        break
      case 'chunk':
        try {
          streamController.enqueue(new Uint8Array(msg.bytes))
        } catch {}
        break
      case 'end':
        try {
          streamController.close()
        } catch {}
        try {
          port1.close()
        } catch {}
        break
      case 'error':
        try {
          streamController.error(new Error(msg.message))
        } catch {}
        metaReject(new Error(msg.message))
        try {
          port1.close()
        } catch {}
        break
    }
  }

  client.postMessage(
    { type: 'sia-range-request', objectId, start, end },
    [port2],
  )

  let meta
  try {
    meta = await metaPromise
  } catch (err) {
    return new Response(`Range error: ${err.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  const headers = new Headers({
    'Content-Type': meta.contentType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(meta.contentLength),
    'Cache-Control': 'no-store',
  })

  if (hasRange) {
    const last = start + meta.contentLength - 1
    headers.set('Content-Range', `bytes ${start}-${last}/${meta.totalSize}`)
    return new Response(stream, { status: 206, headers })
  }

  return new Response(stream, { status: 200, headers })
}
