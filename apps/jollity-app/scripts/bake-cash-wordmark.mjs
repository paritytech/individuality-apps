#!/usr/bin/env node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// BAKE THE CASH WORDMARK OF THE CHAT'S WON TICKET.   node scripts/bake-cash-wordmark.mjs
//
// The app draws a prize as a lockup, the amount and then the CASH wordmark
// (#431): on the draw's chip (lib/draw/wheel/stage.css) the wordmark is the
// design system's cash-logo font in its small caps form, at the amount's own
// size, in 65% of its colour. The chat's host draws text in its own typeface
// only, so the won ticket of the chat card draws the amount as text and the
// wordmark as this picture beside it, set the same way.
//
// The picture is one line of the ticket's amount: the height of its line,
// with the wordmark sitting on the line's baseline, so a row that centres it
// beside the amount puts the two on one baseline. The ink is the ticket's
// (`bg.surface.main` of the dark theme, zinc-950, as the card's wonTicket
// says) at 65%.
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runInChrome } from "./lib/headless.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const out = path.join(repo, "public", "chat-card", "cash-wordmark.png")

// The amount is `headline.large`, which the card takes as 24 on a line of 32
// with its baseline 25 down (wonTicket in apps/jollity-worker/src/card/game-card.ts)
const FONT_PX = 24
const LINE = 32
const BASELINE = 25
// "c" draws the small caps form, as the chip and a lockup do (components/prize-text.tsx)
const GLYPH = "c"
const INK = "rgba(9, 9, 11, 0.65)"
const SCALE = 3

const PAGE = `<!doctype html><meta charset="utf-8">
<script>
const spec = ${JSON.stringify({ FONT_PX, LINE, BASELINE, GLYPH, INK, SCALE })}
;(async () => {
  try {
    const face = new FontFace("cash-logo", "url(/app/fonts/cash-logo-regular.otf)")
    document.fonts.add(await face.load())
    const probe = document.createElement("canvas").getContext("2d")
    probe.font = spec.FONT_PX + "px cash-logo"
    const m = probe.measureText(spec.GLYPH)
    // as wide as the ink, from where the glyph's ink starts
    const left = Math.floor(m.actualBoundingBoxLeft)
    const width = Math.ceil(m.actualBoundingBoxRight + m.actualBoundingBoxLeft)
    const canvas = document.createElement("canvas")
    canvas.width = width * spec.SCALE
    canvas.height = spec.LINE * spec.SCALE
    const ctx = canvas.getContext("2d")
    ctx.scale(spec.SCALE, spec.SCALE)
    ctx.font = spec.FONT_PX + "px cash-logo"
    ctx.fillStyle = spec.INK
    ctx.fillText(spec.GLYPH, left, spec.BASELINE)
    window.__bake = { png: canvas.toDataURL("image/png"), width, height: spec.LINE }
  } catch (e) {
    window.__bake = { error: String((e && e.stack) || e) }
  }
})()
</script>`

const baked = await runInChrome({ html: PAGE, root: repo, result: "__bake" })
if (baked.error) throw new Error(baked.error)
writeFileSync(out, Buffer.from(baked.png.split(",")[1], "base64"))
console.log(`wrote ${path.relative(process.cwd(), out)}: ${baked.width}x${baked.height} pt at ${SCALE}x`)
