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
import { DevNote } from '../DevNote'

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
  const [videos, setVideos] = useState<VideoFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [activeUpload, setActiveUpload] = useState<UploadProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    <div className="flex-1 p-6 space-y-5 max-w-5xl mx-auto w-full">
      {isPlaceholderKey && (
        <DevNote title="Replace Your App Key">
          <p>
            You&apos;re using the template placeholder. Set your own key in{' '}
            <code className="text-amber-700">src/lib/constants.ts</code>.
          </p>
        </DevNote>
      )}

      <DevNote title="Streaming Video with Range Requests">
        <p>
          The <code className="text-amber-700">VideoPlayer</code> sets a{' '}
          <code className="text-amber-700">&lt;video&gt;</code> src to a virtual{' '}
          <code className="text-amber-700">/__sia_stream__/&lt;id&gt;</code>{' '}
          URL. A service worker (
          <code className="text-amber-700">public/sia-stream-sw.js</code>)
          intercepts the browser&apos;s native byte-range requests and forwards
          them to the page over a <code>MessageChannel</code>; the page calls{' '}
          <code className="text-amber-700">
            sdk.download(obj, {`{ offset, length }`})
          </code>{' '}
          and pipes the chunks back. Seeking the scrubber triggers a fresh
          ranged download — no full-file buffer required.
        </p>
      </DevNote>

      {error && (
        <div className="flex items-center justify-between px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-600 hover:text-red-900 text-xs ml-4 shrink-0"
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
        className={`relative block border-2 border-dashed rounded-xl p-12 text-center transition-all duration-150 ${
          uploading
            ? 'border-neutral-300 cursor-default'
            : dragOver
              ? 'border-green-600 bg-green-600/5 cursor-pointer'
              : 'border-neutral-300 hover:border-neutral-400 cursor-pointer'
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
            <p className="text-neutral-700 text-sm">
              Uploading{' '}
              <span className="text-neutral-900">{activeUpload.fileName}</span>{' '}
              <span className="text-neutral-500">
                ({formatBytes(activeUpload.fileSize)})
              </span>
            </p>
            <div className="w-full max-w-xs mx-auto bg-neutral-200 rounded-full h-1.5 overflow-hidden">
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
              className="w-8 h-8 mx-auto text-neutral-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14m-9-4h6a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4a2 2 0 012-2z" />
            </svg>
            <p className="text-neutral-600 text-sm">
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
          <div className="divide-y divide-neutral-200/80">
            {videos.map((file) => (
              <div
                key={file.id}
                className="flex items-center justify-between py-3 group"
              >
                <div className="flex-1 min-w-0 mr-4">
                  <p className="text-sm text-neutral-900 truncate">
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
                    onClick={() => navigate(`/watch/${file.id}`)}
                    className="text-xs px-2.5 py-1 rounded-md border border-neutral-300 text-neutral-700 hover:bg-neutral-100 transition-colors"
                  >
                    Play
                  </button>
                  <span
                    className="text-[11px] text-neutral-400 font-mono group-hover:text-neutral-700 transition-colors"
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
    </div>
  )
}
