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

  // The user clicked "Play" to mount this component, which is a user gesture
  // that should authorize autoplay-with-sound. Browsers can still reject it
  // (e.g. autoplay policy in the embedding context); swallow the rejection
  // and let the user hit Play again on the controls.
  useEffect(() => {
    if (!src || !videoRef.current) return
    videoRef.current.play().catch(() => {
      /* autoplay blocked — user can click play */
    })
  }, [src])

  if (error) {
    return (
      <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
        {error}
      </div>
    )
  }

  return (
    <div className="space-y-4">
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
        <div className="lg:w-80 lg:shrink-0">
          <Globe object={object} />
        </div>
      </div>
      <ShardLog />
    </div>
  )
}
