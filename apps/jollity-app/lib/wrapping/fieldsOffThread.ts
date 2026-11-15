// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The main thread's end of wrapping/fields.worker.ts: `buildFields`, off the
// main thread where it can be, on it where it cannot (no Worker, no
// OffscreenCanvas, or the worker failed to start). One worker at a time, let go
// when the chest leaves (stopFieldsWorker).

import { buildFields, type WrappingFields } from './fields'

type Pending = { resolve: (fields: WrappingFields) => void; reject: (error: Error) => void }

let worker: Worker | null | undefined
const pending = new Map<number, Pending>()
let nextId = 0

function start(): Worker | null {
  if (worker !== undefined) return worker
  worker = null
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null
  try {
    const w = new Worker(new URL('./fields.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (event: MessageEvent<{ id: number; fields?: WrappingFields; error?: string }>) => {
      const { id, fields, error } = event.data
      const ask = pending.get(id)
      pending.delete(id)
      if (!ask) return
      if (fields) ask.resolve(fields)
      else ask.reject(new Error(`wrapping/fields.worker: ${error}`))
    }
    // a worker that cannot run hands every build back to the main thread
    w.onerror = () => {
      worker = null
      for (const ask of pending.values()) ask.reject(new Error('wrapping/fields.worker: failed'))
      pending.clear()
    }
    worker = w
  } catch {
    worker = null
  }
  return worker
}

/** Let the worker go once nothing waits on it. Its heap holds the builds'
 *  scratch arrays until its own GC runs, which nothing on the page can force
 *  (measured: 3 to 19 MB still held through the chest), and they go with it.
 *  The next build starts a new one. */
export function stopFieldsWorker(): void {
  if (!worker || pending.size) return
  worker.terminate()
  worker = undefined
}

/** The field set for a decoded, CORS-clean image. */
export async function buildFieldsOffThread(img: HTMLImageElement, reliefBlur = 3): Promise<WrappingFields> {
  const w = start()
  if (w) {
    try {
      const bitmap = await createImageBitmap(img)
      return await new Promise<WrappingFields>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        w.postMessage({ id, bitmap, reliefBlur }, [bitmap])
      })
    } catch {
      // falls through to the main thread
    }
  }
  return buildFields(img, reliefBlur)
}
