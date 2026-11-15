#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// BAKE THE PRIZE TICKET OF THE CHAT RESULTS CARD.   node scripts/bake-prize-ticket.mjs
//
// The chat design draws a won draw as a ticket: a rainbow radial gradient
// with a notch cut out of each side (the chat card design's ticket,
// `.cu-ticket`). The iOS card host draws no gradient
// and cuts no shape, so the card lays the ticket as a picture under its text,
// as the rare glow of a collectible tile is. The picture is drawn here with
// the values of that CSS, at the width of the card of the design, and the card
// stretches it to its own width. The notches are transparent, so the surface
// under the card shows through them.
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runInChrome } from "./lib/headless.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, "..", "public", "chat-card", "prize-ticket.png")

// .cu-ticket: a 12px label, a 32px amount and a 16px line on lines of 20, 40
// and 20, inside 16px by 20px padding with 12px gaps, which is the 136 height.
// It sits inside the 343px card of the design with its 20px padding.
const WIDTH = 303
const HEIGHT = 136
const RADIUS = 16
const NOTCH = { width: 12, height: 28, radius: 14 }
const SCALE = 2
const GRADIENT = {
  center: [49, 36],
  radii: [296, 295],
  stops: [
    [0, "rgb(184,208,42)"],
    [0.051, "rgb(199,181,77)"],
    [0.102, "rgb(215,154,112)"],
    [0.153, "rgb(230,127,148)"],
    [0.203, "rgb(246,100,183)"],
    [0.253, "rgb(229,139,200)"],
    [0.303, "rgb(211,177,218)"],
    [0.402, "rgb(176,254,253)"],
    [0.615, "rgb(171,252,178)"],
    [0.719, "rgb(209,222,135)"],
    [0.823, "rgb(247,192,93)"],
    [0.912, "rgb(207,219,91)"],
    [1, "rgb(167,246,88)"],
  ],
}

const PAGE = `<!doctype html><meta charset="utf-8">
<script>
const spec = ${JSON.stringify({ WIDTH, HEIGHT, RADIUS, NOTCH, SCALE, GRADIENT })}
try {
  const canvas = document.createElement("canvas")
  canvas.width = spec.WIDTH * spec.SCALE
  canvas.height = spec.HEIGHT * spec.SCALE
  const ctx = canvas.getContext("2d")
  ctx.scale(spec.SCALE, spec.SCALE)
  ctx.beginPath()
  ctx.roundRect(0, 0, spec.WIDTH, spec.HEIGHT, spec.RADIUS)
  ctx.clip()
  const [cx, cy] = spec.GRADIENT.center
  const [rx, ry] = spec.GRADIENT.radii
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, ry / rx)
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  for (const [at, color] of spec.GRADIENT.stops) gradient.addColorStop(at, color)
  ctx.fillStyle = gradient
  ctx.fillRect(-cx, (-cy * rx) / ry, spec.WIDTH, (spec.HEIGHT * rx) / ry)
  ctx.restore()
  // A 14px radius on a 12px wide notch is scaled down by CSS to fit, so each
  // notch is a 12 by 28 box with 12px corners on its inner side.
  const { width, height } = spec.NOTCH
  const radius = Math.min(spec.NOTCH.radius, width)
  const top = (spec.HEIGHT - height) / 2
  ctx.globalCompositeOperation = "destination-out"
  ctx.beginPath()
  ctx.roundRect(0, top, width, height, [0, radius, radius, 0])
  ctx.roundRect(spec.WIDTH - width, top, width, height, [radius, 0, 0, radius])
  ctx.fill()
  window.__bake = canvas.toDataURL("image/png")
} catch (e) {
  window.__bake = { error: String(e && e.stack || e) }
}
</script>`

const dataUrl = await runInChrome({ html: PAGE, result: "__bake" })
writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"))
console.log(`wrote ${path.relative(process.cwd(), out)} (${WIDTH}x${HEIGHT} at ${SCALE}x)`)
