// video-stream.ts — page-side bridge for the streaming service worker.
//
// The worker (public/sia-stream-sw.js) intercepts requests to
// `/__sia_stream__/<id>`, parses the Range header, and forwards them here
// over a MessageChannel. We satisfy them by calling
// `sdk.download(obj, { offset, length })` and piping chunks back. This lets
// a regular <video> element seek by issuing native HTTP byte-range requests.

import type {
  Host,
  PinnedObject,
  Sdk,
  ShardProgress,
} from '@siafoundation/sia-storage'

const STREAM_PREFIX = '/__sia_stream__/'

type Entry = {
  obj: PinnedObject
  contentType: string
}

const objectMap = new Map<string, Entry>()
let registeredSdk: Sdk | null = null
let listenerAttached = false
let registerPromise: Promise<void> | null = null

// Pub-sub for shard download events. Subscribers (e.g. the globe) receive
// every ShardProgress that flows through the streaming bridge so they can
// visualize which hosts are actively serving the video.
type ShardListener = (progress: ShardProgress) => void
const shardListeners = new Set<ShardListener>()

export function subscribeShardDownloads(listener: ShardListener): () => void {
  shardListeners.add(listener)
  return () => {
    shardListeners.delete(listener)
  }
}

// Host list cache, scoped to the current Sdk instance. The indexer doesn't
// change often, and the host list is shared across every video on the page,
// so a single fetch per session is plenty.
let hostsCache: Promise<Host[]> | null = null
let hostsCacheSdk: Sdk | null = null

export function getHosts(sdk: Sdk): Promise<Host[]> {
  if (hostsCacheSdk !== sdk || !hostsCache) {
    hostsCacheSdk = sdk
    // The indexer caps `limit` at 500. If the network grows past that
    // we'd need to paginate via `offset`; for now a single page is
    // enough for every Sia indexer in operation.
    hostsCache = sdk
      .hosts({ country: undefined, limit: 500, offset: undefined })
      .catch((err) => {
        hostsCache = null // allow retry on next call
        throw err
      })
  }
  return hostsCache
}

/** Tell the bridge which Sdk instance to use for downloads. */
export function setStreamSdk(sdk: Sdk | null) {
  registeredSdk = sdk
  // Sdk swap invalidates the host cache.
  if (sdk !== hostsCacheSdk) {
    hostsCache = null
    hostsCacheSdk = null
  }
}

/**
 * Registers the streaming service worker (idempotent) and wires up the
 * message listener that handles range requests.
 */
export function ensureStreamWorker(): Promise<void> {
  if (registerPromise) return registerPromise
  if (!('serviceWorker' in navigator)) {
    return Promise.reject(
      new Error('Service workers are required to stream video.'),
    )
  }
  registerPromise = (async () => {
    await navigator.serviceWorker.register('/sia-stream-sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    // First-install case: SW is active but doesn't yet control this page.
    // Wait for it to take over so subsequent fetches go through it.
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        )
      })
    }
    if (!listenerAttached) {
      navigator.serviceWorker.addEventListener('message', onWorkerMessage)
      listenerAttached = true
    }
  })()
  return registerPromise
}

/** Returns a stream URL for an object id. */
export function streamUrlFor(objectId: string): string {
  return `${STREAM_PREFIX}${encodeURIComponent(objectId)}`
}

/**
 * Registers an object as available for streaming and returns its stream URL.
 * Call `unregisterStreamObject(obj.id())` when done to allow it to be GC'd.
 */
export function registerStreamObject(
  obj: PinnedObject,
  contentType: string,
): string {
  const id = obj.id()
  objectMap.set(id, {
    obj,
    contentType: contentType || 'application/octet-stream',
  })
  return streamUrlFor(id)
}

export function unregisterStreamObject(objectId: string) {
  objectMap.delete(objectId)
}

type RangeRequest = {
  type: 'sia-range-request'
  objectId: string
  start: number
  end: number
}

function onWorkerMessage(event: MessageEvent) {
  const data = event.data as RangeRequest | undefined
  if (!data || data.type !== 'sia-range-request') return
  const port = event.ports[0]
  if (!port) return
  serveRange(data, port).catch((err) => {
    try {
      port.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } catch {}
    try {
      port.close()
    } catch {}
  })
}

async function serveRange(req: RangeRequest, port: MessagePort) {
  const sdk = registeredSdk
  const entry = objectMap.get(req.objectId)
  if (!sdk || !entry) {
    port.postMessage({
      type: 'error',
      message: 'object not registered for streaming',
    })
    port.close()
    return
  }

  const totalSize = entry.obj.size()
  const start = Math.max(0, req.start)
  const requestedEnd =
    req.end === -1 ? totalSize - 1 : Math.min(req.end, totalSize - 1)
  if (start > requestedEnd) {
    port.postMessage({ type: 'error', message: 'invalid range' })
    port.close()
    return
  }
  const length = requestedEnd - start + 1

  // Send headers first so the SW can build its Response immediately, then
  // chunks flow as they arrive.
  port.postMessage({
    type: 'metadata',
    contentType: entry.contentType,
    contentLength: length,
    totalSize,
  })

  let cancelled = false
  port.onmessage = (e) => {
    if (e.data?.type === 'cancel') cancelled = true
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    const stream = sdk.download(entry.obj, {
      maxInflight: 10,
      offset: start,
      length,
      onShardDownloaded: (progress: ShardProgress) => {
        for (const listener of shardListeners) {
          try {
            listener(progress)
          } catch {
            // listener errors must not break the download
          }
        }
      },
    }) as ReadableStream<Uint8Array>
    reader = stream.getReader()
    while (!cancelled) {
      const { done, value } = await reader.read()
      if (done) break
      // Copy so we own a transferable buffer (the SDK's view may alias
      // WASM memory). new Uint8Array(typedArray) copies.
      const copy = new Uint8Array(value)
      port.postMessage({ type: 'chunk', bytes: copy }, [copy.buffer])
    }
    if (cancelled && reader) {
      reader.cancel().catch(() => {})
    }
    port.postMessage({ type: 'end' })
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    try {
      port.close()
    } catch {}
  }
}
