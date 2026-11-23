#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// BAKE THE TICK OF A VOTE.   node scripts/bake-vote-tick.mjs
//
// While the results of a game are pending, the card shows ten circles that
// fill amber with a tick as the votes on the player come in. The iOS card host
// draws no icon, so the tick is a picture of the Check icon of lucide at the
// stroke of the design, in the ink of the main surface.
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runInChrome } from "./lib/headless.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, "..", "public", "chat-card", "vote-tick.png")

const SIZE = 16
const SCALE = 3
const VIEWBOX = 24
const CHECK = "M20 6 9 17l-5-5"
const STROKE = 3.4
// --palette-zinc-950 of the chat design, which --bg-surface-main names.
const INK = "#0B0C0F"

const PAGE = `<!doctype html><meta charset="utf-8">
<script>
const spec = ${JSON.stringify({ SIZE, SCALE, VIEWBOX, CHECK, STROKE, INK })}
try {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = spec.SIZE * spec.SCALE
  const ctx = canvas.getContext("2d")
  ctx.scale((spec.SIZE * spec.SCALE) / spec.VIEWBOX, (spec.SIZE * spec.SCALE) / spec.VIEWBOX)
  ctx.lineWidth = spec.STROKE
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.strokeStyle = spec.INK
  ctx.stroke(new Path2D(spec.CHECK))
  window.__bake = canvas.toDataURL("image/png")
} catch (e) {
  window.__bake = { error: String(e && e.stack || e) }
}
</script>`

const dataUrl = await runInChrome({ html: PAGE, result: "__bake" })
writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"))
console.log(`wrote ${path.relative(process.cwd(), out)} (${SIZE}x${SIZE} at ${SCALE}x)`)
