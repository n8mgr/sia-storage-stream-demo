# Sia Storage Stream Demo

Streams encrypted video from the [Sia](https://sia.tech) storage network straight to a `<video>` element, with native byte-range seeking, a 3D globe visualizing which hosts are serving each shard, and a rolling shard-download log.

```bash
bun install
bun dev    # http://localhost:5173
```

## What it demonstrates

- **End-to-end encrypted streaming** — files are encrypted in the browser, erasure-coded, and stored across Sia hosts. The indexer never sees plaintext.
- **Native HTTP-style seeking** — the `<video>` element issues `Range: bytes=N-` requests; a service worker turns each one into `sdk.download(obj, { offset, length })` and pipes the bytes back.
- **Live host visualization** — every host that holds a shard for the playing video appears on a rotating globe. Each shard arrival pulses its source host and draws a fading arc from your IP-geolocated position.
- **Shard-by-shard latency view** — rolling log of the last 10 shard downloads, color-coded by elapsed ms.

## How streaming + seek works end-to-end

```
<video src="/__sia_stream__/<id>">
   │
   │  Range: bytes=N-
   ▼
public/sia-stream-sw.js  (service worker)
   │
   │  postMessage({ objectId, start, end }, [port])
   ▼
src/lib/video-stream.ts  (page-side bridge)
   │
   │  sdk.download(obj, { offset: start, length, onShardDownloaded })
   ▼
@siafoundation/sia-storage  (WASM, runs in the page)
   │
   ▼
Sia hosts (WebTransport, direct from the browser)
```

Each ranged `download` call streams bytes back through the message channel into the SW's `Response` body, with `Content-Range` set so the browser treats it as a normal HTTP partial-content response. Scrubbing the video re-runs the dance from the new offset; no full-file buffer is held anywhere.

## Project layout

```
src/
├── App.tsx                      # BrowserRouter: / and /watch/:id, both auth-gated
├── lib/
│   ├── constants.ts             # APP_KEY, indexer URL, erasure-coding params
│   └── video-stream.ts          # SW bridge + subscribeShardDownloads + getHosts cache
├── stores/                      # Zustand: auth + toast
├── components/
│   ├── auth/                    # connect / approve / recovery screens
│   └── video/
│       ├── VideoZone.tsx        # / — drop-zone upload + library list
│       ├── WatchPage.tsx        # /watch/:id — sdk.object(id) → VideoPlayer
│       ├── VideoPlayer.tsx      # <video> + Globe + ShardLog
│       ├── Globe.tsx            # cobe globe; pulses hosts as shards arrive
│       └── ShardLog.tsx         # last 10 shard downloads (latency, host, slab/shard)
public/
└── sia-stream-sw.js             # Range-request → page bridge service worker
tools/transcode/                 # Dockerized ffmpeg pipeline for prepping streamable WebM
```

## Auth flow (inherited from the Sia starter)

```
loading → connect → approve → recovery → connected
```

1. **Connect** — enter an indexer URL (default `https://sia.storage`).
2. **Approve** — visit the response URL in a second tab to authorize.
3. **Recovery** — generate or enter a 12-word BIP-39 phrase. The `AppKey` (ed25519 user key) is derived from it deterministically and persisted as hex in `localStorage`.
4. **Connected** — the SDK is ready. Returning users skip steps 1-3 via `Builder.connected(appKey)`.

## Customization

- **App identity** — `APP_KEY` and `APP_META` in [src/lib/constants.ts](src/lib/constants.ts). Changing `APP_KEY` makes prior uploads invisible to the app (it's the namespace).
- **Erasure coding** — `DATA_SHARDS` / `PARITY_SHARDS` in the same file. Default 10 / 20 means each slab's data lives on 30 hosts; any 10 of them can reconstruct it.
- **Replace the library page** — `<VideoZone />` is the post-auth landing in [src/App.tsx](src/App.tsx). Read it first if you're swapping in your own UI; it shows the upload → pin → metadata → list cycle.
- **Indexer host limit** — `getHosts` in [src/lib/video-stream.ts](src/lib/video-stream.ts) requests 500 (the indexer's max per call). If a network ever exceeds that, paginate via `offset`.

## Preparing video for streaming

Cues at the front of the file matter for fast scrubbing — without them the browser has to read to the end of the file before the first seek. The bundled tool produces a streaming-friendly VP9 WebM:

```bash
docker build -t sia-transcode tools/transcode
docker run --rm -v "$HOME/Downloads:/work" sia-transcode \
  /work/source.mov /work/streamable.webm 8 fast
```

`8` = target Mbps; `fast` = libvpx-vp9 preset (also `balanced`, `quality`). See [tools/transcode/README.md](tools/transcode/README.md). For maximum encode speed on macOS, skip the container and use VideoToolbox H.264 directly:

```bash
ffmpeg -i source.mov -vf "scale=1920:-2" \
  -c:v h264_videotoolbox -b:v 8M -maxrate 12M \
  -g 120 -keyint_min 120 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -movflags +faststart \
  streamable.mp4
```

The streaming worker is byte-format-blind, but the `<video>` element isn't — pick a codec all your target browsers can decode. H.264 + AAC in MP4 plays everywhere; VP9 + Opus in WebM works on every modern browser.

## Build & deploy

### Local production build

```bash
bun run build   # TypeScript + Vite → dist/
```

### Docker

```bash
docker build -t sia-storage-stream-demo .
docker run --rm -p 8080:80 sia-storage-stream-demo
# http://localhost:8080
```

The container is a multi-stage build (Bun → nginx:alpine, ~95 MB final). Nginx is configured for SPA fallback (`/watch/:id` deep links), no-cache on the service worker, and long-cache on hashed asset bundles. See [Dockerfile](Dockerfile) and [docker/nginx.conf](docker/nginx.conf).

### GHCR

A GitHub Actions workflow ([.github/workflows/docker.yml](.github/workflows/docker.yml)) builds and pushes `linux/amd64` + `linux/arm64` images on every push to `main`, every tag, and on manual dispatch. Pulls assume the package is public; if not, set the package visibility under your repo's *Packages* settings.

```bash
docker pull ghcr.io/n8mgr/sia-storage-stream-demo:latest
docker run --rm -p 8080:80 ghcr.io/n8mgr/sia-storage-stream-demo:latest
```

> **Service workers require HTTPS in production.** Run behind a TLS-terminating proxy (Caddy, Traefik, nginx, an ingress); plain HTTP from a non-localhost host fails to register the SW and the streaming path silently breaks.

## Commands

```bash
bun install                            # Install deps
bun dev                                # Vite dev server
bun run build                          # tsc + Vite production build
bun run check                          # Biome lint + format check (--write to fix)
bun x playwright test e2e/smoke.spec.ts # App-loads-without-errors smoke
```

## Tech stack

- [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org) + [Vite](https://vite.dev)
- [Tailwind CSS 4](https://tailwindcss.com) for styling
- [Zustand](https://zustand.docs.pmnd.rs) for state, [React Router 7](https://reactrouter.com/) for routes
- [Biome](https://biomejs.dev) for lint + format
- [@siafoundation/sia-storage](https://www.npmjs.com/package/@siafoundation/sia-storage) — Sia SDK (encryption, erasure coding, host transfers via WASM)
- [cobe](https://github.com/shuding/cobe) — 5KB WebGL globe

## Learn more

- [Sia Documentation](https://docs.sia.tech)
- [@siafoundation/sia-storage on npm](https://www.npmjs.com/package/@siafoundation/sia-storage)
