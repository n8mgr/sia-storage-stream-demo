import type { PinnedObject } from '@siafoundation/sia-storage'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { setStreamSdk } from '../../lib/video-stream'
import { useAuthStore } from '../../stores/auth'
import { VideoPlayer } from './VideoPlayer'

type FileMetadata = {
  name: string
  type: string
  size: number
  createdAt?: number
  updatedAt?: number
}

function decodeMetadata(bytes: Uint8Array): FileMetadata | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as FileMetadata
  } catch {
    return null
  }
}

/**
 * /watch/:id — fetches the object by hex id via `sdk.object(id)` and
 * renders the streaming player. Works on cold load (refresh, share link)
 * because the object handle is rehydrated from the indexer rather than
 * passed through React state.
 */
export function WatchPage() {
  const { id } = useParams<{ id: string }>()
  const sdk = useAuthStore((s) => s.sdk)
  const [object, setObject] = useState<PinnedObject | null>(null)
  const [metadata, setMetadata] = useState<FileMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Keep the streaming bridge wired to the live Sdk on this page too —
  // landing here directly skips VideoZone, where the wiring otherwise
  // happens.
  useEffect(() => {
    setStreamSdk(sdk)
    return () => setStreamSdk(null)
  }, [sdk])

  useEffect(() => {
    if (!sdk || !id) return
    let cancelled = false
    setError(null)
    setObject(null)
    setMetadata(null)
    ;(async () => {
      try {
        const obj = await sdk.object(id)
        if (cancelled) return
        const meta = decodeMetadata(obj.metadata())
        setObject(obj)
        setMetadata(meta)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sdk, id])

  return (
    <div className="flex-1 p-6 space-y-4 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <Link
          to="/"
          className="text-xs text-neutral-500 hover:text-neutral-900 transition-colors"
        >
          ← Library
        </Link>
        <span className="text-[11px] text-neutral-400 font-mono" title={id}>
          {id?.slice(0, 12)}…
        </span>
      </div>

      {error ? (
        <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          Failed to load object: {error}
        </div>
      ) : !object || !metadata ? (
        <div className="p-8 text-center text-neutral-500 text-sm">Loading…</div>
      ) : (
        <VideoPlayer
          object={object}
          contentType={metadata.type || 'video/webm'}
        />
      )}
    </div>
  )
}
