import type { Host, PinnedObject } from '@siafoundation/sia-storage'
import createGlobe, { type Arc, type Marker } from 'cobe'
import { useEffect, useRef, useState } from 'react'
import { getHosts, subscribeShardDownloads } from '../../lib/video-stream'
import { useAuthStore } from '../../stores/auth'

// Cached coarse user location from IP geolocation. Lifted to module scope
// so multiple Globe instances share one fetch.
let userLocationPromise: Promise<[number, number] | null> | null = null
function getUserLocation(): Promise<[number, number] | null> {
  if (userLocationPromise) return userLocationPromise
  userLocationPromise = (async () => {
    try {
      const res = await fetch('https://ipapi.co/json/')
      if (!res.ok) return null
      const data = (await res.json()) as {
        latitude?: unknown
        longitude?: unknown
      }
      const lat = typeof data.latitude === 'number' ? data.latitude : null
      const lon = typeof data.longitude === 'number' ? data.longitude : null
      if (lat === null || lon === null) return null
      return [lat, lon]
    } catch {
      return null
    }
  })()
  return userLocationPromise
}

type Props = {
  /**
   * Restrict the globe to hosts that hold at least one shard of this
   * object. Any of these hosts could end up serving a request, so they're
   * all "potential providers." Omit to show every host the indexer knows
   * about.
   */
  object?: PinnedObject
}

// How long a host's "I just served a shard" pulse lasts.
const PULSE_MS = 1500
// Marker sizes in cobe's internal units.
const IDLE_SIZE = 0.018
const PEAK_SIZE = 0.075
const USER_SIZE = 0.05

// Colors are [r, g, b] floats in 0..1.
const IDLE_COLOR: [number, number, number] = [0.45, 0.55, 0.7]
const HOT_COLOR: [number, number, number] = [0.4, 1, 0.5]
// Amber dot for "you are here."
const USER_COLOR: [number, number, number] = [1, 0.7, 0.2]
// Arc base color (dim) and active color (bright cyan).
const ARC_DIM: [number, number, number] = [0.3, 0.45, 0.7]
const ARC_HOT: [number, number, number] = [0.4, 1, 0.7]

type Pulse = {
  hostKey: string
  startedAt: number // performance.now()
}

/**
 * Renders a 3D globe of all known hosts, pulsing each host as the streaming
 * bridge reports a shard arriving from it. Subscribes to the shared
 * `subscribeShardDownloads` pub-sub in src/lib/video-stream.ts.
 */
export function Globe({ object }: Props) {
  const sdk = useAuthStore((s) => s.sdk)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Total hosts in scope (the object's full sector set, or all known hosts
  // if no object is provided).
  const [scopeCount, setScopeCount] = useState<number | null>(null)
  // Subset of scopeCount that we have plottable lat/long for. If the indexer
  // doesn't return a host (offline) or returns placeholder (0,0) coords,
  // it's in scope but invisible on the globe.
  const [plottedCount, setPlottedCount] = useState(0)
  const [activeHostCount, setActiveHostCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // User coords from IP geolocation. Held in a ref so updating it doesn't
  // tear down and rebuild the globe instance.
  const userLocationRef = useRef<[number, number] | null>(null)

  // Fire and forget: try to learn where the user is. The result is cached
  // at module scope so subsequent mounts don't re-fetch.
  useEffect(() => {
    let cancelled = false
    getUserLocation().then((loc) => {
      if (!cancelled) userLocationRef.current = loc
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!sdk || !canvasRef.current) return
    const canvas = canvasRef.current

    let cancelled = false
    let rafId = 0
    let globe: ReturnType<typeof createGlobe> | null = null
    const hostByKey = new Map<string, Host>()
    const pulses: Pulse[] = []
    let phi = 0
    let theta = 0.25 // gentle northern tilt while we don't know where the user is

    /** Camera target that centers a [lat, lon] (in degrees) on the front. */
    function focusFor(loc: [number, number]): { phi: number; theta: number } {
      const lat = (loc[0] * Math.PI) / 180
      const lon = (loc[1] * Math.PI) / 180
      return { phi: -Math.PI / 2 - lon, theta: lat }
    }

    /** Linear interpolation. */
    function lerp(a: number, b: number, t: number) {
      return a + (b - a) * t
    }

    /** Lerp on the angle circle (handles wraparound near ±π). */
    function lerpAngle(a: number, b: number, t: number) {
      let diff = b - a
      while (diff > Math.PI) diff -= 2 * Math.PI
      while (diff < -Math.PI) diff += 2 * Math.PI
      return a + diff * t
    }

    // The set of hosts that hold a sector for this object — the universe
    // of "potential providers." Any of them might serve any range request.
    // Empty set means "no scope; show all known hosts."
    const objectHostKeys = (() => {
      if (!object) return null
      const keys = new Set<string>()
      try {
        for (const slab of object.slabs()) {
          for (const sector of slab.sectors) {
            keys.add(sector.hostKey)
          }
        }
      } catch {
        // slabs() can throw if the object handle is closed — treat as
        // "no scope" so we still draw something.
        return null
      }
      return keys
    })()

    /** Reap expired pulses from the head of the queue. */
    function reapPulses(now: number) {
      while (pulses.length && now - pulses[0].startedAt > PULSE_MS) {
        pulses.shift()
      }
    }

    /** Per-host intensity in [0, 1] from the strongest live pulse. */
    function pulseIntensity(now: number): Map<string, number> {
      const intensity = new Map<string, number>()
      for (const p of pulses) {
        const t = (now - p.startedAt) / PULSE_MS
        // ease-out quadratic decay: full intensity at t=0, 0 at t=1
        const v = (1 - t) * (1 - t)
        const cur = intensity.get(p.hostKey) ?? 0
        if (v > cur) intensity.set(p.hostKey, v)
      }
      return intensity
    }

    function buildMarkers(now: number): Marker[] {
      reapPulses(now)
      const intensity = pulseIntensity(now)

      const markers: Marker[] = []
      for (const [key, host] of hostByKey) {
        const i = intensity.get(key) ?? 0
        const size = IDLE_SIZE + (PEAK_SIZE - IDLE_SIZE) * i
        const color: [number, number, number] = [
          IDLE_COLOR[0] + (HOT_COLOR[0] - IDLE_COLOR[0]) * i,
          IDLE_COLOR[1] + (HOT_COLOR[1] - IDLE_COLOR[1]) * i,
          IDLE_COLOR[2] + (HOT_COLOR[2] - IDLE_COLOR[2]) * i,
        ]
        markers.push({
          location: [host.latitude, host.longitude],
          size,
          color,
        })
      }

      // The "you are here" pin is added last so it draws on top of host
      // markers if they overlap.
      const me = userLocationRef.current
      if (me) {
        markers.push({ location: me, size: USER_SIZE, color: USER_COLOR })
      }
      return markers
    }

    /** Arcs from the user to each host that's currently mid-pulse. */
    function buildArcs(now: number): Arc[] {
      const me = userLocationRef.current
      if (!me) return []
      reapPulses(now)
      const intensity = pulseIntensity(now)
      const arcs: Arc[] = []
      for (const [hostKey, i] of intensity) {
        const host = hostByKey.get(hostKey)
        if (!host) continue
        // Lerp arc color from dim toward hot with the pulse intensity, so
        // it brightens on shard arrival and fades as the pulse decays.
        const color: [number, number, number] = [
          ARC_DIM[0] + (ARC_HOT[0] - ARC_DIM[0]) * i,
          ARC_DIM[1] + (ARC_HOT[1] - ARC_DIM[1]) * i,
          ARC_DIM[2] + (ARC_HOT[2] - ARC_DIM[2]) * i,
        ]
        arcs.push({
          from: me,
          to: [host.latitude, host.longitude],
          color,
        })
      }
      return arcs
    }

    ;(async () => {
      let hosts: Host[] = []
      try {
        hosts = await getHosts(sdk)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (cancelled) return

      // Build a quick lookup by publicKey so we can pull coords for hosts
      // we're scoped to.
      const hostsByKey = new Map<string, Host>()
      for (const h of hosts) hostsByKey.set(h.publicKey, h)

      // The "scope" is what the user expects to see: every host that holds a
      // shard for this object (or every known host, if no object is scoped).
      const scopeKeys = objectHostKeys ?? new Set(hostsByKey.keys())
      setScopeCount(scopeKeys.size)

      // The "plotted" set is the subset we have real coords for. Hosts the
      // indexer didn't return (offline) or with placeholder (0,0) coords
      // are still in scope but invisible on the globe.
      let plotted = 0
      for (const key of scopeKeys) {
        const h = hostsByKey.get(key)
        if (!h) continue
        if (h.latitude === 0 && h.longitude === 0) continue
        hostByKey.set(key, h)
        plotted++
      }
      setPlottedCount(plotted)

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cssSize = canvas.clientWidth || 400
      const size = Math.round(cssSize)

      // If the IP-geo fetch resolved before the host fetch, prime the camera
      // straight to the user's location so we don't see the globe ease in
      // from the prime meridian.
      const initialMe = userLocationRef.current
      if (initialMe) {
        const target = focusFor(initialMe)
        phi = target.phi
        theta = target.theta
      }

      globe = createGlobe(canvas, {
        devicePixelRatio: dpr,
        width: size,
        height: size,
        phi,
        theta,
        dark: 1,
        diffuse: 1.2,
        mapSamples: 16000,
        mapBrightness: 4,
        baseColor: [0.25, 0.27, 0.32],
        markerColor: IDLE_COLOR,
        glowColor: [0.4, 0.55, 0.85],
        arcColor: ARC_DIM,
        arcWidth: 0.4,
        arcHeight: 0.35,
        markers: buildMarkers(performance.now()),
        arcs: buildArcs(performance.now()),
      })

      const tick = () => {
        if (cancelled) return
        const now = performance.now()

        const me = userLocationRef.current
        if (me) {
          // Ease toward the user-centered focus. The lerp factor 0.06 is
          // ~6% per frame, so the camera reaches its target in ~30 frames
          // (half a second at 60fps) — visible but not jarring.
          const target = focusFor(me)
          phi = lerpAngle(phi, target.phi, 0.06)
          theta = lerp(theta, target.theta, 0.06)
        } else {
          // No location yet — slow auto-rotate and tilt back to the default,
          // pausing when many pulses are active so users can see the
          // highlighted hosts without them sliding off.
          const rotationSpeed = pulses.length > 0 ? 0.0006 : 0.002
          phi += rotationSpeed
          theta = lerp(theta, 0.25, 0.06)
        }

        globe?.update({
          phi,
          theta,
          markers: buildMarkers(now),
          arcs: buildArcs(now),
        })
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
    })()

    const unsubscribe = subscribeShardDownloads((p) => {
      if (!hostByKey.has(p.hostKey)) return
      pulses.push({ hostKey: p.hostKey, startedAt: performance.now() })
      // React state update is throttled to one render per frame max via the
      // RAF tick; here we just count the still-alive pulses.
      const now = performance.now()
      const active = new Set<string>()
      for (const pulse of pulses) {
        if (now - pulse.startedAt <= PULSE_MS) active.add(pulse.hostKey)
      }
      setActiveHostCount(active.size)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
      unsubscribe()
      globe?.destroy()
    }
  }, [sdk, object])

  return (
    <div className="space-y-2">
      <div className="relative aspect-square w-full max-w-sm mx-auto">
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{ contain: 'layout paint size' }}
        />
      </div>
      <div className="text-center text-[11px] text-neutral-500 font-mono">
        {error ? (
          <span className="text-red-600">hosts unavailable: {error}</span>
        ) : scopeCount === null ? (
          <span>loading hosts…</span>
        ) : (
          <span>
            {scopeCount} host{scopeCount === 1 ? '' : 's'} in scope
            {plottedCount < scopeCount && (
              <>
                {' '}
                <span
                  className="text-amber-600"
                  title="Hosts the indexer didn't return or with placeholder (0,0) coords"
                >
                  ({scopeCount - plottedCount} unplottable)
                </span>
              </>
            )}{' '}
            &middot;{' '}
            <span className="text-green-600">{activeHostCount} active</span>
          </span>
        )}
      </div>
    </div>
  )
}
