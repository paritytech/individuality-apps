// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* A hex colour, taken apart. Nothing here knows what it is colouring. */

/* the marker's colour, split: '#rrggbb' for the canvas and the shader, its
   alpha (an 8-digit hex carries one; 3-, 4- and 6-digit forms are fine too),
   and the ink to write on it — black on a light colour, white on a dark one
   (whichever WCAG contrast is higher) */
const colorMemo = new Map()
export function parseColor(hex) {
  const hit = colorMemo.get(hex)
  if (hit) return hit
  let h = String(hex).replace('#', '')
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) h = 'ff2a2aff'
  const rgb = `#${h.slice(0, 6)}`
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
  const lin = (c) => {
    const v = parseInt(c, 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const L = 0.2126 * lin(h.slice(0, 2)) + 0.7152 * lin(h.slice(2, 4)) + 0.0722 * lin(h.slice(4, 6))
  const ink = (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#000' : '#fff'
  const c = { hex, rgb, alpha, ink }
  colorMemo.set(hex, c)
  return c
}
