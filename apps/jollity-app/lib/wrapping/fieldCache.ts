// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Part of the wrapping effect: its names are Wrapping*, except the shader exports (SHELL_*).
// One art URL in, one built field set out, once per URL.
//
// The build costs real time (an exact euclidean distance transform over
// 256x256, twice, plus four box blurs), so it must never run twice for the
// same picture. The chest scene warms this cache while the bubble collects, so
// the fields are ready before the chest opens.
//
// THE IMAGE STAYS ON THE ENTRY. The renderer uploads it as `uItem`, and the
// element is already decoded here, so the renderer waits for nothing.
//
// CORS is the reason this loader exists. `buildFields` calls `getImageData` and
// the renderer calls `texImage2D` from the same element. Both throw a
// `SecurityError` on a tainted image. The gateway sends
// `access-control-allow-origin: *`, so `crossOrigin = 'anonymous'` is enough.
//
// A CORS request and a plain request do not share a cache entry. The display
// images in this app (the chest pins, the Pocket claim, the picker) are plain
// `<img>`s without `crossOrigin`, so the wrapping pays for a second download
// of the same art (about 400 kB). Setting `crossOrigin="anonymous"` on every
// display image would remove it, as long as the gateway keeps the header.

import { AsyncCache } from '@/lib/async-cache'
import { loadImage } from '@/lib/dom/image'
import { type WrappingFields } from './fields'
import { buildFieldsOffThread, stopFieldsWorker } from './fieldsOffThread'

/** What the cache hands back. It is the pure field set plus the decoded art. */
export interface WrappingFieldEntry extends WrappingFields {
  /** The URL this entry was built from. */
  url: string
  /** The decoded, CORS-clean art. The renderer uploads it as `uItem`. */
  image: HTMLImageElement
  /** How long the build took, in milliseconds. It runs in a worker where it
   *  can (fieldsOffThread.ts), so this is the wait, not main-thread time. */
  buildMs: number
}

/** How many field sets stay in memory. A chest holds up to ten, so twelve
 *  leaves room for a replayed flow without churn. Each entry costs about
 *  272 kB of typed arrays plus the decoded image. The chest empties it as it
 *  unmounts (`releaseFields`), so the bound holds within one showing. */
const CACHE_MAX = 12

/** URL -> the in-flight or settled build, least recently asked-for evicted first */
const cache = new AsyncCache<WrappingFieldEntry>({ max: CACHE_MAX })

/** The dev probe. `window.__wrappingFields` maps an art URL to its build time and
 *  its mask bounds. Read it in the console once the chest has built its art. */
function recordProbe(url: string, ms: number, bbox: readonly [number, number, number, number]): void {
  const w = window as unknown as {
    __wrappingFields?: Record<string, { ms: number; bbox: readonly number[] }>
  }
  if (!w.__wrappingFields) w.__wrappingFields = {}
  w.__wrappingFields[url] = { ms, bbox }
}

/** Let go of every field set and the decoded art it holds, and of the idle
 *  worker that built them. The chest screen is the only reader and calls
 *  this as it unmounts, so a showing's ten images and their typed arrays do
 *  not outlive it for the whole session. A build still in flight finishes for
 *  its own callers and is not kept. */
export function releaseFields(): void {
  cache.clear()
  stopFieldsWorker()
}

/** Build the field set for one art URL, or hand back the build already made.
 *
 *  The promise is memoised, so ten callers for one URL share one build. A
 *  rejected build is dropped from the cache, so a later caller may retry. */
export function ensureFields(url: string): Promise<WrappingFieldEntry> {
  // decoded before the build, so `drawImage` never waits on the decoder.
  // Built in a worker where possible (wrapping/fieldsOffThread.ts), so buildMs
  // is the wait, not main-thread time
  return cache.ensure(url, async () => {
    const image = await loadImage(url, { crossOrigin: 'anonymous', decode: true })
    const t0 = performance.now()
    const fields = await buildFieldsOffThread(image)
    const buildMs = performance.now() - t0
    recordProbe(url, buildMs, fields.bbox)
    return { ...fields, url, image, buildMs }
  })
}
