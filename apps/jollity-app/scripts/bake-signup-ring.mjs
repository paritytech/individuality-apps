#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// BAKE THE PROGRESS RING OF REGISTER.   node scripts/bake-signup-ring.mjs
//
// A sign-up from the chat runs through steps, and the Register pill shows how
// far it got as a ring that fills. The iOS card host draws no arc, so each
// step is a picture, drawn here in the dark ink of the Register label on a
// faint track of the same ink, and the card lays the one for the step over
// the pill.
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runInChrome } from "./lib/headless.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, "..", "public", "chat-card")

// Every tenth of the ring but the empty and the full, which SIGNUP_RING of
// apps/jollity-worker/src/card/game-card.ts names one by one.
const STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90]
const SIZE = 22
const STROKE = 3
const SCALE = 3
// --fg-primary-inverted of the chat design, the ink of the Register label.
const INK = "rgb(9,9,11)"
const TRACK = "rgba(9,9,11,0.2)"

const PAGE = `<!doctype html><meta charset="utf-8">
<script>
const spec = ${JSON.stringify({ STEPS, SIZE, STROKE, SCALE, INK, TRACK })}
try {
  window.__bake = spec.STEPS.map((step) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = spec.SIZE * spec.SCALE
    const ctx = canvas.getContext("2d")
    ctx.scale(spec.SCALE, spec.SCALE)
    const centre = spec.SIZE / 2
    const radius = centre - spec.STROKE / 2
    ctx.lineWidth = spec.STROKE
    ctx.strokeStyle = spec.TRACK
    ctx.beginPath()
    ctx.arc(centre, centre, radius, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = spec.INK
    ctx.lineCap = "round"
    ctx.beginPath()
    ctx.arc(centre, centre, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * step) / 100)
    ctx.stroke()
    return canvas.toDataURL("image/png")
  })
} catch (e) {
  window.__bake = { error: String(e && e.stack || e) }
}
</script>`

const dataUrls = await runInChrome({ html: PAGE, result: "__bake" })
STEPS.forEach((step, index) => {
  const out = path.join(outDir, `signup-ring-${step}.png`)
  writeFileSync(out, Buffer.from(dataUrls[index].split(",")[1], "base64"))
  console.log(`wrote ${path.relative(process.cwd(), out)} (${SIZE}x${SIZE} at ${SCALE}x)`)
})
