import {
  encodedSize,
  PinnedObject,
  type ShardProgress,
} from '@siafoundation/sia-storage'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { APP_KEY, DATA_SHARDS, PARITY_SHARDS } from '../../lib/constants'
import { setStreamSdk } from '../../lib/video-stream'
import { useAuthStore } from '../../stores/auth'
import { useToastStore } from '../../stores/toast'
import { DevNote } from '../DevNote'
import { ShareDialog } from './ShareDialog'

type FileMetadata = {
  name: string
  type: string
  size: number
  createdAt?: number
  updatedAt?: number
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`
}

function decodeMetadata(bytes: Uint8Array): FileMetadata | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as FileMetadata
  } catch {
    return null
  }
}

function isVideo(meta: FileMetadata): boolean {
  if (meta.type?.startsWith('video/')) return true
  return /\.(webm|mp4|mov|m4v|ogg|ogv|mkv)$/i.test(meta.name ?? '')
}

type VideoFile = {
  id: string
  metadata: FileMetadata
  object: PinnedObject
}

type UploadProgress = {
  fileName: string
  fileSize: number
  shardsDone: number
  bytesUploaded: number
  encodedTotal: number
}

const isPlaceholderKey = APP_KEY.startsWith('{' + '{')

export function VideoZone() {
  const sdk = useAuthStore((s) => s.sdk)
  const navigate = useNavigate()
  const addToast = useToastStore((s) => s.addToast)
  const [videos, setVideos] = useState<VideoFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [activeUpload, setActiveUpload] = useState<UploadProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sharingFile, setSharingFile] = useState<VideoFile | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Keep the streaming bridge wired to the live Sdk.
  useEffect(() => {
    setStreamSdk(sdk)
    return () => setStreamSdk(null)
  }, [sdk])

  const loadVideos = useCallback(async () => {
    if (!sdk) return
    try {
      const events = await sdk.objectEvents(undefined, 200)
      const loaded: VideoFile[] = []
      for (const event of events) {
        if (event.deleted || !event.object) continue
        const meta = decodeMetadata(event.object.metadata())
        if (meta?.name && isVideo(meta)) {
          loaded.push({ id: event.id, metadata: meta, object: event.object })
        }
      }
      setVideos(loaded)
    } catch (e) {
      console.error('Failed to load videos:', e)
    }
  }, [sdk])

  useEffect(() => {
    loadVideos()
  }, [loadVideos])

  async function uploadFile(file: File) {
    if (!sdk) return
    setUploading(true)
    setError(null)
    const encodedTotal = encodedSize(file.size, DATA_SHARDS, PARITY_SHARDS)
    setActiveUpload({
      fileName: file.name,
      fileSize: file.size,
      shardsDone: 0,
      bytesUploaded: 0,
      encodedTotal,
    })

    try {
      // Read the file as a stream — never `await file.arrayBuffer()` on a
      // video. It buffers the whole file into JS memory and re-opens the
      // OS handle later for `file.stream()`, which on large or networked
      // files surfaces as `NotReadableError`. If you want a content hash,
      // tee `file.stream()` and digest one branch incrementally.
      const object = new PinnedObject()
      let shardsDone = 0
      let bytesUploaded = 0
      const pinnedObject = await sdk.upload(object, file.stream(), {
        maxInflight: 10,
        dataShards: DATA_SHARDS,
        parityShards: PARITY_SHARDS,
        onShardUploaded: (progress: ShardProgress) => {
          shardsDone++
          bytesUploaded += progress.shardSize
          setActiveUpload({
            fileName: file.name,
            fileSize: file.size,
            shardsDone,
            bytesUploaded,
            encodedTotal,
          })
        },
      })

      const metadata: FileMetadata = {
        name: file.name,
        type: file.type || 'video/webm',
        size: file.size,
        createdAt: Date.now(),
      }

      pinnedObject.updateMetadata(
        new TextEncoder().encode(JSON.stringify(metadata)),
      )
      await sdk.pinObject(pinnedObject)
      await sdk.updateObjectMetadata(pinnedObject)

      setVideos((prev) => [
        { id: pinnedObject.id(), metadata, object: pinnedObject },
        ...prev,
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
      setActiveUpload(null)
    }
  }

  async function handleFiles(fileList: FileList) {
    for (const file of Array.from(fileList)) {
      await uploadFile(file)
    }
  }

  async function shareVideo(file: VideoFile, validDays: number) {
    if (!sdk) return
    try {
      const validUntil = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
      const siaUrl = sdk.shareObject(file.object, validUntil)

      // Drop the indexer host out of the sia:// URL. We assume the
      // recipient's app uses the same indexer this user connected to
      // (SharePage reconstructs `sia://<their-indexer-host>${compact}`).
      // If parsing ever fails (URL grammar drift), fall back to embedding
      // the full sia URL — slightly longer but always works.
      let compact: string
      try {
        const parsed = new URL(siaUrl)
        if (parsed.protocol !== 'sia:' || !parsed.hash) {
          throw new Error('unexpected share URL shape')
        }
        compact = `${parsed.pathname}${parsed.search}${parsed.hash}`
      } catch {
        compact = siaUrl
      }

      // Privacy: the secret lives in our fragment, mirroring the sia://
      // URL's own fragment. Browsers never send fragments to servers, and
      // URL-encoding the inner `#` keeps the value round-tripping cleanly
      // through clipboard / history APIs / proxies.
      const shareUrl = `${window.location.origin}/share#${encodeURIComponent(compact)}`
      await navigator.clipboard.writeText(shareUrl)
      const dayLabel = validDays === 1 ? 'day' : 'days'
      addToast(`Share link copied (valid ${validDays} ${dayLabel})`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Share failed')
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  const uploadPercent = activeUpload
    ? Math.min(
        100,
        Math.round(
          (activeUpload.bytesUploaded / activeUpload.encodedTotal) * 100,
        ),
      )
    : 0

  return (
    <div className="flex-1 p-4 space-y-4 max-w-7xl mx-auto w-full">
      {isPlaceholderKey && (
        <DevNote title="Replace Your App Key">
          <p>
            You&apos;re using the template placeholder. Set your own key in{' '}
            <code className="text-amber-300">src/lib/constants.ts</code>.
          </p>
        </DevNote>
      )}

      <DevNote title="Streaming Video with Range Requests">
        <p>
          The <code className="text-amber-300">VideoPlayer</code> sets a{' '}
          <code className="text-amber-300">&lt;video&gt;</code> src to a virtual{' '}
          <code className="text-amber-300">/__sia_stream__/&lt;id&gt;</code>{' '}
          URL. A service worker (
          <code className="text-amber-300">public/sia-stream-sw.js</code>)
          intercepts the browser&apos;s native byte-range requests and forwards
          them to the page over a <code>MessageChannel</code>; the page calls{' '}
          <code className="text-amber-300">
            sdk.download(obj, {`{ offset, length }`})
          </code>{' '}
          and pipes the chunks back. Seeking the scrubber triggers a fresh
          ranged download — no full-file buffer required.
        </p>
      </DevNote>

      {error && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-red-950/40 border border-red-900 rounded-lg text-red-300 text-sm">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-200 text-xs ml-4 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Dropzone */}
      <label
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        className={`relative block border-2 border-dashed rounded-xl p-8 text-center transition-all duration-150 ${
          uploading
            ? 'border-neutral-700 cursor-default'
            : dragOver
              ? 'border-green-600 bg-green-600/5 cursor-pointer'
              : 'border-neutral-700 hover:border-neutral-600 cursor-pointer'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          multiple
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />

        {activeUpload ? (
          <div className="space-y-4">
            <p className="text-neutral-300 text-sm">
              Uploading{' '}
              <span className="text-neutral-100">{activeUpload.fileName}</span>{' '}
              <span className="text-neutral-500">
                ({formatBytes(activeUpload.fileSize)})
              </span>
            </p>
            <div className="w-full max-w-xs mx-auto bg-neutral-800 rounded-full h-1.5 overflow-hidden">
              {activeUpload.shardsDone === 0 ? (
                <div className="bg-green-600 h-full rounded-full w-1/4 animate-indeterminate" />
              ) : (
                <div
                  className="bg-green-600 h-full rounded-full transition-all duration-300"
                  style={{ width: `${uploadPercent}%` }}
                />
              )}
            </div>
            <p className="text-neutral-500 text-xs font-mono">
              {activeUpload.shardsDone} shards &middot;{' '}
              {formatBytes(
                (activeUpload.bytesUploaded / activeUpload.encodedTotal) *
                  activeUpload.fileSize,
              )}{' '}
              / {formatBytes(activeUpload.fileSize)}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <svg
              className="w-8 h-8 mx-auto text-neutral-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14m-9-4h6a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4a2 2 0 012-2z" />
            </svg>
            <p className="text-neutral-400 text-sm">
              Drop a video here or click to browse
            </p>
            <p className="text-neutral-500 text-xs">
              webm, mp4, mov &middot; encrypted &amp; stored on the Sia network
            </p>
          </div>
        )}
      </label>

      {/* Video list */}
      {videos.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            {videos.length} video{videos.length !== 1 ? 's' : ''}
          </h2>
          <div className="divide-y divide-neutral-800/80">
            {videos.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between py-2 group"
              >
                <div className="flex-1 min-w-0 mr-4">
                  <p className="text-sm text-neutral-100 truncate">
                    {file.metadata.name}
                  </p>
                  <p className="text-xs text-neutral-500 mt-0.5">
                    {formatBytes(file.metadata.size)}
                    {file.metadata.type && (
                      <span> &middot; {file.metadata.type}</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => setSharingFile(file)}
                    className="text-xs px-2.5 py-1 rounded-md border border-neutral-700 text-neutral-300 hover:bg-neutral-800 transition-colors"
                    title="Copy a share link"
                  >
                    Share
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate(`/watch/${file.id}`)}
                    className="text-xs px-2.5 py-1 rounded-md border border-neutral-700 text-neutral-300 hover:bg-neutral-800 transition-colors"
                  >
                    Play
                  </button>
                  <span
                    className="text-[11px] text-neutral-500 font-mono group-hover:text-neutral-300 transition-colors"
                    title={file.id}
                  >
                    {file.id.slice(0, 8)}...
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ShareDialog
        open={sharingFile !== null}
        fileName={sharingFile?.metadata.name ?? ''}
        onCancel={() => setSharingFile(null)}
        onConfirm={(days) => {
          const file = sharingFile
          if (!file) return
          setSharingFile(null)
          // Fire-and-forget; shareVideo posts its own toast / error.
          void shareVideo(file, days)
        }}
      />
    </div>
  )
}
