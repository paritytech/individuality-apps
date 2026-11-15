// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A canvas the page never shows: drawn into, read or encoded, then let go.
 *
 * A canvas holds its pixels until the collector gets to it, which on a phone
 * can be long after the work is done; across a game the scratch canvases of a
 * few bakes added up to real memory. `release()` frees them at once.
 * `readback` asks for a CPU-backed canvas, for one whose pixels are read
 * (`getImageData`): a GPU canvas reads its pixels back from the GPU each time.
 */
export class ScratchCanvas {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D

  constructor(width: number, height = width, { readback = false }: { readback?: boolean } = {}) {
    this.canvas = document.createElement("canvas")
    this.canvas.width = width
    this.canvas.height = height
    const ctx = this.canvas.getContext("2d", readback ? { willReadFrequently: true } : undefined)
    if (!ctx) throw new Error("no 2d context")
    this.ctx = ctx
  }

  get width() {
    return this.canvas.width
  }

  get height() {
    return this.canvas.height
  }

  /** every pixel, RGBA */
  pixels(): Uint8ClampedArray {
    return this.ctx.getImageData(0, 0, this.width, this.height).data
  }

  release() {
    releaseCanvas(this.canvas)
  }
}

/** free a canvas's pixels now, not whenever the collector gets to it */
export function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = canvas.height = 0
}
