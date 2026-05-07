# Sia Starter — AI Assistant Guide

This is a starter for apps backed by the [Sia](https://sia.tech) storage network. Read this before writing code: it contains the mental model, the canonical patterns, and the footguns. If you're about to invent a pattern that isn't here, the odds are you shouldn't.

## Stack

React 19, TypeScript, Vite, Tailwind CSS 4, Zustand, [`@siafoundation/sia-storage`](https://www.npmjs.com/package/@siafoundation/sia-storage).

## Types are the source of truth

The SDK's shape lives in its `.d.ts` files — more current and precise than any prose. Before calling an unfamiliar method, read:

- `node_modules/@siafoundation/sia-storage/dist/index.d.ts` — top-level exports.
- `node_modules/@siafoundation/sia-storage/wasm/sia_storage_wasm.d.ts` — WASM-bound classes with full method signatures.

Don't hallucinate methods. If a method isn't in those files, it doesn't exist.

## Core concepts

**Indexer** — A service that coordinates storage: it tracks which hosts hold which encrypted shards, handles payments, and repairs slabs when hosts disappear. **It sees only ciphertext.** Trusted for availability and correctness of the repair/payment flow, *not* for data privacy. The indexer URL lives in `src/lib/constants.ts`.

**Hosts** — The actual storage providers. The browser talks to them directly over WebTransport for uploads and downloads. Erasure coding means any sufficient subset of hosts is enough to reconstruct a file.

**App** — Identified to the indexer by `APP_KEY` (32-byte hex) + `APP_META` in `src/lib/constants.ts`. Apps are namespaces: objects stored under one `APP_KEY` aren't visible to another.

**User key** — An `AppKey` instance derived from the user's 12-word BIP-39 recovery phrase. It's the encryption key and the indexer-auth identity for that user *within* the app. Persisted as hex in `localStorage` so users don't re-enter the phrase every session.

> **`APP_KEY` vs `AppKey`** — `APP_KEY` (constant, screaming snake) is the *app's* identity in `APP_META.appId`. `AppKey` (class, PascalCase) is the *user's* ed25519 key. They are not the same thing.

**Object** — A file or blob you upload. Represented at rest by a `PinnedObject` handle. Has an ID, a size, one or more slabs, and encrypted metadata.

**Slab / shard** — A file is split into slabs (default ~40 MB each), and each slab is erasure-coded into shards (10 data + 20 parity by default — see `DATA_SHARDS` / `PARITY_SHARDS` in `src/lib/constants.ts`). Shards are what actually ship to hosts.

**Pin** — "This object should persist." An unpinned object is transient. Always `await sdk.pinObject(obj)` after a successful upload, or the indexer will garbage-collect it.

**Metadata** — Encrypted app-defined bytes attached to an object (filename, MIME type, tags, etc.). Call `event.object.metadata()` to read, `pinnedObject.updateMetadata(bytes)` + `sdk.updateObjectMetadata(pinnedObject)` to write. Keep it under a few KB — it's a descriptor, not a payload.

## Auth flow

Step-based, managed by Zustand (`src/stores/auth.ts`):

```
loading → connect → approve → recovery → connected
```

- **loading** — `initSia()` loads WASM; `AuthFlow` checks for a stored user key.
- **connect** — User enters indexer URL. App constructs `new Builder(url, APP_META)` and calls `requestConnection()`.
- **approve** — User visits `builder.responseUrl()` in another tab; the app polls `builder.waitForApproval()`.
- **recovery** — User generates or enters a BIP-39 phrase; `builder.register(phrase)` returns the `Sdk`.
- **connected** — `Sdk` is ready; main UI renders.

**Returning users** skip connect/approve/recovery entirely: `AuthFlow` constructs a `Builder` and calls `builder.connected(appKey)` with the persisted key. Returns an `Sdk` if valid, `undefined` to fall back to `connect`.

**Persistence**: Zustand `persist` middleware writes to `localStorage` under `sia-auth-<first-16-of-APP_KEY>` (keyed by app so two scaffolds on `localhost:5173` don't collide). Persisted: `storedKeyHex`, `indexerUrl`. The live `Sdk` is **not** persisted — it's rehydrated by calling `builder.connected(appKey)` on mount.

## Key files

| File | Role |
|---|---|
| `src/lib/constants.ts` | `APP_KEY`, `APP_NAME`, `APP_META` (`AppMetadata`), indexer default, erasure-coding constants |
| `src/stores/auth.ts` | Zustand store: holds the `Sdk`, persists `storedKeyHex` + `indexerUrl` |
| `src/stores/toast.ts` | Toast notifications (auto-dismiss) |
| `src/components/auth/AuthFlow.tsx` | Orchestrator: `initSia()`, returning-user reconnect |
| `src/components/auth/ConnectScreen.tsx` | `new Builder(url, APP_META).requestConnection()` |
| `src/components/auth/ApproveScreen.tsx` | Polls `builder.waitForApproval()` |
| `src/components/auth/RecoveryScreen.tsx` | Generate / validate phrase → `builder.register()` → `Sdk` |
| `src/components/video/VideoZone.tsx` | Library page (post-auth landing). Drop-zone upload + list of stored videos with Play buttons that route to `/watch/:id`. |
| `src/components/video/WatchPage.tsx` | `/watch/:id` route. Rehydrates the object via `sdk.object(id)` and renders the player. |
| `src/components/video/VideoPlayer.tsx` | Streaming `<video>` + Globe + ShardLog. Registers the object with the streaming bridge so the SW can serve byte ranges. |
| `src/components/video/Globe.tsx` | cobe globe of host locations; pulses each host as a shard arrives. |
| `src/components/video/ShardLog.tsx` | Rolling log of the last 10 shard downloads (latency, host, slab/shard index). |
| `src/lib/video-stream.ts` | Page-side bridge that satisfies the SW's range requests with `sdk.download(obj, { offset, length })`; exposes `subscribeShardDownloads(listener)`. |
| `public/sia-stream-sw.js` | Service worker that intercepts `/__sia_stream__/<id>` and forwards range requests back to the page. |
| `src/components/Navbar.tsx` | Public key + sign out |
| `src/components/DevNote.tsx` | Amber callout — remove or replace for production |
| `src/types/uint8array-hex.d.ts` | Ambient types for TC39 `Uint8Array.{toHex,fromHex}` (drop once TS lib ships them) |

## SDK usage patterns

### Upload → pin → metadata

```ts
import { PinnedObject } from '@siafoundation/sia-storage'
import { DATA_SHARDS, PARITY_SHARDS } from '../../lib/constants'

const object = new PinnedObject()
const pinned = await sdk.upload(object, file.stream(), {
  maxInflight: 10,
  dataShards: DATA_SHARDS,
  parityShards: PARITY_SHARDS,
  onShardUploaded: (p) => {
    // p: { hostKey, shardSize, shardIndex, slabIndex, elapsedMs }
    // shardSize is post-erasure-coding bytes, not source bytes.
  },
})

pinned.updateMetadata(
  new TextEncoder().encode(JSON.stringify({ name: file.name, type: file.type, size: file.size })),
)
await sdk.pinObject(pinned)
await sdk.updateObjectMetadata(pinned)
```

All three calls matter:
1. `upload` writes the encrypted shards to hosts.
2. `pinObject` tells the indexer to keep it (without this, it's eventually GC'd).
3. `updateObjectMetadata` persists the descriptor so other sessions can find it.

### Byte progress (source units, not on-wire units)

`onShardUploaded.shardSize` is on-wire bytes (encoded). To show a progress bar in source-file units, use `encodedSize` as the denominator:

```ts
import { encodedSize } from '@siafoundation/sia-storage'
const encodedTotal = encodedSize(file.size, DATA_SHARDS, PARITY_SHARDS)
const sourceProgress = (bytesUploaded / encodedTotal) * file.size
```

### Download

Returns a `ReadableStream<Uint8Array>`. Buffer or pipe:

```ts
const stream = sdk.download(pinnedObject, { maxInflight: 10 })
const blob = await new Response(stream).blob()
```

### Delete

```ts
await sdk.deleteObject(objectId)
```

### Share / consume a share URL

```ts
const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
const url = sdk.shareObject(pinnedObject, validUntil)
// On the recipient side (can be a different app / no auth needed):
const obj = await sdk.sharedObject(url)
const stream = sdk.download(obj)
```

Share URLs embed the decryption key in the fragment (`#...`) — never sent to the indexer.

### Pack many small files

`sdk.uploadPacked()` batches small files into shared slabs to avoid wasting storage:

```ts
const packed = sdk.uploadPacked({ maxInflight: 10 })
await packed.add(fileA.stream())
await packed.add(fileB.stream())
for (const obj of await packed.finalize()) await sdk.pinObject(obj)
```

## Syncing with the indexer

`sdk.objectEvents(cursor, limit)` is the one sync primitive. Each `ObjectEvent` has `id`, `updatedAt: Date`, `deleted: boolean`, `object: PinnedObject | null`.

Cursor is `{ id: string, after: Date }`. Passing it returns events strictly after that point.

### `updatedAt` bumps

- **User actions from any device using this app key**: `updateObjectMetadata`, `deleteObject`, re-pin.
- **Indexer repairs**: when a host goes offline the indexer migrates shards to healthy hosts and bumps `updatedAt`. Your next poll picks up the repaired state automatically.

Both surface through the same stream, which is why polling `objectEvents` is the pattern every Sia app should implement.

### Cross-device sync

```ts
// Fresh session: no cursor, pull latest N.
const events = await sdk.objectEvents(undefined, 500)
events.forEach(apply)
persistCursor(latest(events))

// Periodic tick: only what changed.
const cursor = loadCursor() // { id, after: Date } or undefined
const events = await sdk.objectEvents(cursor, 200)
events.forEach(apply)
if (events.length) persistCursor(latest(events))
```

Operational tips:
- Persist the cursor in `localStorage` keyed by app key.
- Poll only while the tab is visible (`document.visibilityState === 'visible'`).
- Advance the cursor only after local merge succeeds.
- `event.deleted === true` → evict from local store.

If a specific SDK build rejects the cursor shape (edge cases with `Date` serialization happen), fall back to `undefined` + client-side filter on `event.updatedAt.getTime() > watermarkMs`.

## Gotchas

Things that look right but aren't:

- **Don't persist `Sdk` to storage.** It's a live WASM handle; rehydrate it via `Builder.connected(appKey)` on mount.
- **Don't forget `pinObject`.** A successful `upload` that isn't pinned is a transient object — the indexer will eventually drop it.
- **Don't conflate `APP_KEY` and `AppKey`.** `APP_KEY` is the app identity constant; `AppKey` is the user's key class.
- **Don't stuff large payloads into metadata.** It's a descriptor. Put file bytes in the object, not in metadata.
- **Don't re-bundle or wrap the WASM.** Vite dev needs `optimizeDeps: { exclude: ['@siafoundation/sia-storage'] }` (already set in `vite.config.ts`) because the SDK's `import.meta.url`-relative WASM path breaks under pre-bundling. If you add another bundler (Webpack, Rollup), check the SDK README for the equivalent.
- **Don't call `initSia()` more than once per mount.** It's already called in `AuthFlow`; additional call sites create race conditions.
- **Don't call `builder.waitForApproval()` twice.** React strict mode will remount — `ApproveScreen` guards this with a `pollStarted` ref. Follow that pattern.
- **`onShardUploaded.shardSize` is encoded bytes, not source bytes.** If you sum it, you're measuring on-wire traffic. Use `encodedSize()` for the matching denominator, or scale to source via `(bytes / encodedTotal) * file.size`.
- **Numeric types differ on Node vs browser.** Browser uses `number` (~9 PB safe); Node uses `bigint`. Template is browser-only, so `number` is correct here.
- **Sign-out should clear localStorage.** `useAuthStore.getState().reset()` + `window.location.reload()` is the pattern in `Navbar.tsx`.

## Extending the starter

### Swap out `VideoZone`

`src/App.tsx` routes the post-auth `/` to `<VideoZone />`. Replace it with your own component. Read `VideoZone.tsx` first — it shows the full upload → pin → metadata → list cycle, and the Play button shows the navigate-to-detail-page pattern (`/watch/:id`).

Access the SDK:

```tsx
const sdk = useAuthStore((s) => s.sdk)
if (!sdk) return null
```

### Add routes

Install `react-router-dom`. Gate routes on `step === 'connected'`; render `<AuthFlow />` otherwise.

### Add fields to file metadata

Extend the `FileMetadata` type in `VideoZone.tsx`, write the extra fields in the upload handler, read them back in `loadFiles`. Schema is app-owned — do whatever makes sense. Just keep it small.

### Search / filter

Metadata is encrypted at rest but decrypted client-side, so once you've hydrated from `objectEvents` you can filter/sort/search it in memory like any local list. The indexer can't do this for you (it sees ciphertext) — search is always client-side.

### Multi-device updates

Implement the polling pattern from **Syncing with the indexer**. That's how uploads on one device appear on another.

### Change erasure-coding parameters

Edit `DATA_SHARDS` / `PARITY_SHARDS` in `src/lib/constants.ts`. More parity = survives more host failures at the cost of more on-wire bytes. Keep `VideoZone`'s `encodedSize()` call in sync (it already reads from the same constants).

### Change the app key

`APP_KEY` in `src/lib/constants.ts`. Generate with `crypto.getRandomValues(new Uint8Array(32)).toHex()`. **Changing it makes all previously uploaded data invisible to the app** — app key is the namespace.

## Commands

```bash
bun install     # Install deps
bun dev         # Vite dev server (WASM loads lazily, ~100ms)
bun run build   # tsc + Vite production build
bun run check   # Biome lint + format check (use --write to fix)
bun x playwright test e2e/smoke.spec.ts   # App-loads-without-errors smoke
```

After any substantive change, run `bun run check` (auto-fix with `bun x biome check . --write`) and `bun run build` before committing.
