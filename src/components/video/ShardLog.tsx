import { useEffect, useState } from 'react'
import { subscribeShardDownloads } from '../../lib/video-stream'

type Entry = {
  hostKey: string
  elapsedMs: number
  shardSize: number
  slabIndex: number
  shardIndex: number
  receivedAt: number
  // Stable id so React doesn't reuse rows when the buffer shifts.
  id: number
}

const MAX_ENTRIES = 10

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`
}

function elapsedColor(ms: number): string {
  // Latency banding: green <300ms (great), amber <800ms (ok), red >=800ms.
  if (ms < 300) return 'text-green-400'
  if (ms < 800) return 'text-amber-400'
  return 'text-red-400'
}

let nextId = 1

/**
 * Rolling log of the last N shard download events. Subscribes to the
 * shared `subscribeShardDownloads` pub-sub the Globe also uses — both views show
 * the same events from the same source.
 */
export function ShardLog() {
  const [entries, setEntries] = useState<Entry[]>([])

  useEffect(() => {
    const unsubscribe = subscribeShardDownloads((p) => {
      setEntries((prev) => {
        const entry: Entry = {
          hostKey: p.hostKey,
          elapsedMs: p.elapsedMs,
          shardSize: p.shardSize,
          slabIndex: p.slabIndex,
          shardIndex: p.shardIndex,
          receivedAt: Date.now(),
          id: nextId++,
        }
        return [entry, ...prev].slice(0, MAX_ENTRIES)
      })
    })
    return unsubscribe
  }, [])

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider px-1">
        Recent shards
      </div>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden">
        {entries.length === 0 ? (
          <div className="px-3 py-2 text-xs text-neutral-500 font-mono">
            waiting for shard downloads…
          </div>
        ) : (
          <div className="divide-y divide-neutral-800/70 font-mono text-xs">
            {entries.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[5rem_5rem_1fr_auto] gap-3 items-center px-3 py-1.5"
              >
                <span className={`tabular-nums ${elapsedColor(e.elapsedMs)}`}>
                  {e.elapsedMs} ms
                </span>
                <span className="text-neutral-400 tabular-nums">
                  {formatBytes(e.shardSize)}
                </span>
                <span className="text-neutral-500 truncate" title={e.hostKey}>
                  slab {e.slabIndex} · shard {e.shardIndex} ·{' '}
                  <span className="text-neutral-300">
                    {e.hostKey.slice(0, 16)}…
                  </span>
                </span>
                <span className="text-neutral-500 text-[10px] tabular-nums">
                  {new Date(e.receivedAt).toLocaleTimeString([], {
                    hour12: false,
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
