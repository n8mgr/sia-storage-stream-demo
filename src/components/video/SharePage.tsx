import type { PinnedObject } from '@siafoundation/sia-storage'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { setStreamSdk } from '../../lib/video-stream'
import { useAuthStore } from '../../stores/auth'
import { VideoPlayer } from './VideoPlayer'

type FileMetadata = {
  name?: string
  type?: string
  size?: number
}

function decodeMetadata(bytes: Uint8Array): FileMetadata | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as FileMetadata
  } catch {
    return null
  }
}

/**
 * /share#<encoded-sia-url>
 *
 * The sia:// share URL embeds the decryption key in its own fragment so it
 * never leaves the client. We put the whole sia:// URL inside our fragment
 * (URL-encoded) so the same privacy property holds — the receiving app
 * server only sees the path `/share`, never the share URL or the key.
 *
 * URL-encoding matters here: a raw sia://...#... in a fragment means a
 * second `#` mid-string, and while browsers typically include it,
 * intermediate URL parsers (proxies, history APIs, copy-to-clipboard
 * libraries) can mangle it. encodeURIComponent on the way in,
 * decodeURIComponent on the way out — round-trips cleanly.
 */
export function SharePage() {
  const sdk = useAuthStore((s) => s.sdk)
  const [object, setObject] = useState<PinnedObject | null>(null)
  const [metadata, setMetadata] = useState<FileMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Wire the streaming bridge to the live Sdk on this page too — landing
  // here directly skips VideoZone, where the wiring otherwise happens.
  useEffect(() => {
    setStreamSdk(sdk)
    return () => setStreamSdk(null)
  }, [sdk])

  // The indexer URL the current session connected to. We use it to
  // reconstruct compact share fragments (which are missing the host).
  const indexerUrl = useAuthStore((s) => s.indexerUrl)

  useEffect(() => {
    if (!sdk) return
    const hash = window.location.hash.slice(1) // drop the leading `#`
    if (!hash) {
      setError('No share link found in URL.')
      return
    }
    let payload: string
    try {
      payload = decodeURIComponent(hash)
    } catch {
      setError('Share link is malformed (not URL-decodable).')
      return
    }

    // Two formats are accepted:
    //   1. Compact: `/path?query#key` — host omitted; we paste the
    //      receiver's connected indexer in. Sender uses this when both
    //      sides share an indexer (common in-app case).
    //   2. Full sia URL: `sia://host/path?query#key` — passthrough; lets
    //      the link stay portable across indexers.
    let shareUrl: string
    if (payload.startsWith('sia:')) {
      shareUrl = payload
    } else if (payload.startsWith('/')) {
      let host: string
      try {
        host = new URL(indexerUrl).host
      } catch {
        setError(
          `Connected indexer URL is invalid (${indexerUrl}); cannot expand compact share link.`,
        )
        return
      }
      shareUrl = `sia://${host}${payload}`
    } else {
      setError('Share link payload not recognized.')
      return
    }

    let cancelled = false
    setError(null)
    setObject(null)
    setMetadata(null)
    ;(async () => {
      try {
        const obj = await sdk.sharedObject(shareUrl)
        if (cancelled) return
        const meta = decodeMetadata(obj.metadata())
        setObject(obj)
        setMetadata(meta ?? {})
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sdk, indexerUrl])

  return (
    <div className="flex-1 p-4 space-y-3 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <Link
          to="/"
          className="text-xs text-neutral-500 hover:text-neutral-100 transition-colors"
        >
          ← Library
        </Link>
        <span className="text-[11px] text-neutral-500 font-mono uppercase tracking-wider">
          shared
        </span>
      </div>

      {error ? (
        <div className="px-4 py-2.5 bg-red-950/40 border border-red-900 rounded-lg text-red-300 text-sm">
          Failed to open share link: {error}
        </div>
      ) : !object ? (
        <div className="p-8 text-center text-neutral-500 text-sm">Loading…</div>
      ) : (
        <VideoPlayer
          object={object}
          contentType={metadata?.type || 'video/webm'}
        />
      )}
    </div>
  )
}
