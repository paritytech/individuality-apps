// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// THE WRAPPING'S FIELDS, BUILT OFF THE MAIN THREAD. One art in (an
// ImageBitmap, transferred), its field set out (the typed arrays, transferred).
// The build is ~90 ms of a low-end phone's time per art, and the collectables screen asks for
// up to ten while its bubble collects; here it costs the page no frames.
// wrapping/fieldsOffThread.ts is the other end.

import { COLOUR_N, FIELD_N, fieldsFromPixels } from './fields'

interface Ask {
  id: number
  bitmap: ImageBitmap
  reliefBlur: number
}

const read = (bitmap: ImageBitmap, n: number): Uint8ClampedArray => {
  const c = new OffscreenCanvas(n, n)
  const cx = c.getContext('2d', { willReadFrequently: true })
  if (!cx) throw new Error('wrapping/fields.worker: no 2d context')
  cx.drawImage(bitmap, 0, 0, n, n)
  return cx.getImageData(0, 0, n, n).data
}

self.onmessage = (event: MessageEvent<Ask>) => {
  const { id, bitmap, reliefBlur } = event.data
  try {
    const fields = fieldsFromPixels(read(bitmap, FIELD_N), read(bitmap, COLOUR_N), reliefBlur)
    bitmap.close()
    self.postMessage({ id, fields }, { transfer: [fields.sdf.buffer, fields.colour.buffer] })
  } catch (error) {
    bitmap.close()
    self.postMessage({ id, error: String(error) })
  }
}
