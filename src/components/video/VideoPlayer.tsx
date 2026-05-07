import type { PinnedObject } from '@siafoundation/sia-storage'
import { useEffect, useRef, useState } from 'react'
import {
  ensureStreamWorker,
  registerStreamObject,
  unregisterStreamObject,
} from '../../lib/video-stream'
import { Globe } from './Globe'
import { ShardLog } from './ShardLog'

type Props = {
  object: PinnedObject
  contentType: string
}

/**
 * Streaming player. Registers the object with the bridge, sets the video
 * `src` to the resulting `/__sia_stream__/<id>` URL, and lets the browser
 * drive the byte-range requests. Seek scrubbing maps directly to ranged
 * `sdk.download` calls behind the scenes. Renders a Globe alongside the
 * video that pulses each host as it serves a shard.
 */
export function VideoPlayer({ object, contentType }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let registeredId: string | null = null

    ;(async () => {
      try {
        await ensureStreamWorker()
        if (cancelled) return
        const url = registerStreamObject(object, contentType)
        registeredId = object.id()
        setSrc(url)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()

    return () => {
      cancelled = true
      if (registeredId) unregisterStreamObject(registeredId)
    }
  }, [object, contentType])

  // Autoplay strategy: try unmuted first (the user clicked "Play" to get
  // here, which usually authorizes autoplay-with-sound). If the browser
  // refuses — common after a route change + service-worker install on
  // first visit, when the user-gesture activation has lapsed — fall back
  // to muted autoplay, which every major browser allows unconditionally.
  // The user can hit the unmute button on the native controls.
  useEffect(() => {
    if (!src || !videoRef.current) return
    const v = videoRef.current
    v.muted = false
    v.play().catch(() => {
      v.muted = true
      v.play().catch(() => {
        /* even muted autoplay blocked — user must click play */
      })
    })
  }, [src])

  if (error) {
    return (
      <div className="px-4 py-2.5 bg-red-950/40 border border-red-900 rounded-lg text-red-300 text-sm">
        {error}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col lg:flex-row gap-4">
        <video
          ref={videoRef}
          src={src ?? undefined}
          controls
          autoPlay
          playsInline
          preload="auto"
          className="flex-1 min-w-0 max-h-[70vh] rounded-lg bg-black"
          onError={() => {
            const v = videoRef.current
            if (!v?.error) return
            setError(
              `Playback error (code ${v.error.code}): ${v.error.message}`,
            )
          }}
        >
          <track kind="captions" />
        </video>
        <div className="lg:w-96 lg:shrink-0">
          <Globe object={object} />
        </div>
      </div>
      <ShardLog />
    </div>
  )
}
