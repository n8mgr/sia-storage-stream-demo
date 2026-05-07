import type { AppMetadata } from '@siafoundation/sia-storage'

// biome-ignore format: long hex literal
export const APP_KEY = 'ea20dbfcae940fb18e29eb40002e1c14e27f5cf7f75b32f3bd43d627670e08e4'
export const APP_NAME = 'video-stream'
export const DEFAULT_INDEXER_URL = 'https://sia.storage'
export const APP_META: AppMetadata = {
  appId: APP_KEY,
  name: APP_NAME,
  description: 'Video Stream Demo',
  serviceUrl: 'https://sia.storage',
  logoUrl: undefined,
  callbackUrl: undefined,
}

// Erasure coding parameters — passed to sdk.upload() and encodedSize().
export const DATA_SHARDS = 10
export const PARITY_SHARDS = 20
