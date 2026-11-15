// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE WHEEL'S STAGE — the draw through the slit in ./proto (see
 * ./proto/README.md), run on a real draw: the coin dragged into a lit slit that bends into the
 * wheel's circle, the coin round it and onto your ticket, the spin under the
 * wedge, then who's playing along the top (every holder's name, ./names.ts),
 * the winners lit one by one and you last, and the prize or Not this time.
 * The page's own Continue is the way out: pressed on a win, the host moves on;
 * on a loss the tickets fall first.
 *
 * This file starts the one scene in ./proto: it builds the stage's
 * furniture inside `host`, sets the scene's config tables from the
 * draw (the ticket list, the target, the winner count, the prize's words) and
 * starts the clock. The scene's own changes for this app are marked
 * `JOLLITY:` under ./proto; they feed the chain's tickets and target in where
 * the scene would otherwise hash a seed (draw.js buildRing).
 *
 * Framework-free (architecture rule 6): ./stage-runner mounts it for the draw
 * screen's host (lib/draw/draw-screen-host.ts, started from
 * draw-screen-deps.ts), in the element components/draw/wheel-stage.tsx
 * renders, and forwards nothing but the draw. CLIENT
 * ONLY — the code in ./proto reads `matchMedia` at import — so it is always loaded
 * with `import()`, and its CSS is imported by the host, which is not.
 */
// the stylesheets load with the PAGE (components/draw/wheel-stage.tsx), not
// with this chunk: a style that arrives after the page paints lets the page's
// own furniture show unstyled until it does
import { createSlit as createSlitJs, slitParams } from "./proto/scenes/wheel/slit/scene.js"
import { SLIT } from "./proto/scenes/wheel/slit/config.js"
import { FLOW } from "./proto/scenes/wheel/config.js"
import { cuesFor } from "./proto/scenes/wheel/slit/sequence.js"
import { NAME_IN } from "./proto/scenes/wheel/slit/walk.js"
import { stretchesFor, warpFor } from "./proto/scenes/wheel/timing.js"
import { PRIZE } from "./proto/render-utils/prize/config.js"
import { createLoop as createLoopJs } from "./proto/render-utils/loop.js"
import { readUrl } from "./proto/render-utils/url.js"
import { DPR_CAP } from "./proto/render-utils/layout.js"
import { keepBakes, releaseBakes } from "./baked-coin"
import { nameCache, rowLabels } from "./names"
import { slotHex, winnersByRule } from "./rule"

/** what the stage is handed: the chain's draw, already checked by rule.ts */
export interface WheelDraw {
  /** every entry's slot, hex */
  tickets: readonly string[]
  /** the player's slot, one of `tickets` — or "" for a SPECTATOR: a player
   *  who is not in the draw watches it, with no disc, coin or ending of theirs */
  mine: string
  /** the draw's target, hex */
  target: string
  /** the chain's outcome for the player (false for a spectator): only the
   *  ending they will see is built */
  won: boolean
  winners: number
  /** the prize's words: `prefix` + `amount` on the chip, `unit` under the
   *  amount on the coin and after it in small caps */
  prize: { amount: string; unit: string; prefix: string }
  /** the name on a ticket (its slot, hex), null for none: every ticket's is
   *  read as the stage mounts, for who's playing (./names.ts). Without it the
   *  row shows each ticket's code */
  names?: (ticket: string) => Promise<string | null>
}

/** Where the stage's own story is, for the log of a stage that never ended:
 *  which step it never got past, and whether frames and the GL were alive. */
export type WheelProgress = Record<string, string | number | boolean | null>

export interface WheelStage {
  /** a stage mounted held (`WheelOptions.held`) plays on from the frame it stood at */
  release(): void
  progress(): WheelProgress
  destroy(): void
}

// ./proto's surface, as this file uses it — JS, so named here once
interface ProtoScene {
  frame: (t: number, dt: number) => void
  dispose: () => void
  /** the JOLLITY names patch: write who's playing again, with the names that came since */
  names: { refresh: () => void }
  debug: () => {
    slit: {
      /** the page's Continue: on the stage, and pressed */
      continue: { shown: boolean; continued: boolean; pill: boolean }
      /** the ticket list dealt and the wheel laid out */
      ready: boolean
      /** the wheel has been drawn at least once */
      painted: boolean
      /** seconds on the story's clock since the hand-over (-Infinity: not handed over) */
      s: number
      /** 0..1 through the spin */
      phase: number
      spun: boolean
      landed: boolean
      /** the prize's coin brought up */
      upload: { done: boolean }
    }
  }
}
/** what the scene's JOLLITY edits read on a real draw */
interface ChainDraw {
  values: Uint8Array[]
  target: Uint8Array
  spectator: boolean
  won: boolean
  /** who's playing: the label of the ticket at this index of `values` */
  nameOf: (index: number) => string
  /** Continue pressed on a win, or the fall played out on a loss: once */
  onDone: () => void
  /** the page's Continue went up */
  onContinueShown: () => void
}
type CreateSlit = (ctx: { dom: unknown; loop: unknown }, opts: { opening: "slit"; chainDraw: ChainDraw }) => ProtoScene
const createSlit = createSlitJs as unknown as CreateSlit
interface ProtoLoop {
  onFrame: ((t: number, dt: number) => void) | null
  start(): void
  stop(): void
  /** the JOLLITY hold patch: the clock stands still, and goes on from there */
  hold(): void
  release(): void
}
const createLoop = createLoopJs as unknown as (opts: { stats: { fps: number } }) => ProtoLoop

const bytes = (hex: string): Uint8Array => {
  const body = slotHex(hex)
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}


/**
 * Bound the app's wait using the scene's own animation clocks (./proto). The known
 * run is the slit's hand-over to the spin, the slow-motion-adjusted spin, who's
 * playing walked through to you, then the slower winning ending up to its
 * Continue. Two full runs tolerate a heavily throttled phone; the named floor
 * covers startup and shader work, which are outside those animation clocks.
 */
const WHEEL_STARTUP_FLOOR_MS = 5000
const wheelCues = cuesFor(SLIT)
const wheelStretches = stretchesFor({ totalS: SLIT.autoSpinS, upS: SLIT.upS, downS: SLIT.spinS })
const wheelWarp = warpFor({
  durS: wheelStretches.upS + wheelStretches.cruiseS + wheelStretches.downS,
  startS: (SLIT.autoSpinS * SLIT.sloMoAtPct) / 100,
  factor: SLIT.sloMo ? SLIT.sloMoSpeed : 1,
})
const wheelWalkMs = SLIT.namesWalkMs + NAME_IN * 1000 + SLIT.walkWinnersMaxMs + SLIT.walkMs
const prizeBurstMs = PRIZE.confetti
  ? PRIZE.confettiKind === "discs"
    ? PRIZE.discBurstAtMs
    : PRIZE.confettiAtMs
  : PRIZE.chipAtMs + PRIZE.textFadeMs
export const WHEEL_KNOWN_RUN_MS = Math.ceil(
  wheelCues.spin * 1000 + wheelWarp.realDurS * 1000 + wheelWalkMs + FLOW.prizeAfterMs + prizeBurstMs + FLOW.backAfterBurstMs,
)
export const WHEEL_PROGRESS_TIMEOUT_MS = WHEEL_KNOWN_RUN_MS * 2 + WHEEL_STARTUP_FLOOR_MS

// ── the quality the stage draws at ─────────────────────────────────────────
// The draw is GPU-bound on phones (A16: coin 21 fps with 4× MSAA, 60 without).
// The stage starts at the level this device last held and steps down while
// frames are slow, MSAA first, then density; never back up within a draw.
/** what the stage may draw with, best first (2×: the scene's own ceiling, DPR_CAP in ./proto/render-utils/layout.js) */
const LEVELS = [
  { dpr: 2, msaa: true },
  { dpr: 2, msaa: false },
  { dpr: 1.5, msaa: false },
  { dpr: 1.25, msaa: false },
  { dpr: 1, msaa: false },
] as const
/** the median frame slower than this is a GPU that cannot keep up: under ~45 fps */
const SLOW_FRAME_MS = 22
/** the frames one decision reads, and the frames passed over after a mount or a step */
const WINDOW_FRAMES = 40
const SETTLE_FRAMES = 45
/** a HELD stage's picture does not change, so it is drawn only until it has
 *  settled (its eased alphas and the row's slide run on frame time), then not
 *  again until something makes it stale: a resize, which clears the canvases,
 *  or a face that loaded late */
const HELD_SETTLE_FRAMES = 30
/** per opening: a level held under the flip page, whose GL was the whole
 *  screen, says nothing about the slit's, a window the size of the coin */
const LEVEL_KEY = "jollity.draw.level.slit"

function heldLevel(): number {
  try {
    const kept = Number(localStorage.getItem(LEVEL_KEY))
    if (Number.isInteger(kept) && kept >= 0 && kept < LEVELS.length) return kept
  } catch {
    // no storage: the best
  }
  return 0
}

/** reads each frame's time and lowers the stage's quality while the median frame is slow */
function qualityGovernor() {
  let level = heldLevel()
  const apply = () => {
    DPR_CAP.max = LEVELS[level]!.dpr
    DPR_CAP.msaa = LEVELS[level]!.msaa
  }
  apply()
  let settle = SETTLE_FRAMES
  const frames: number[] = []
  return (dtS: number) => {
    if (settle > 0) {
      settle--
      return
    }
    frames.push(dtS * 1000)
    if (frames.length < WINDOW_FRAMES) return
    const median = [...frames].sort((a, b) => a - b)[frames.length >> 1]!
    frames.length = 0
    if (median <= SLOW_FRAME_MS || level === LEVELS.length - 1) return
    const was = LEVELS[level]!.dpr
    level++
    apply()
    try {
      localStorage.setItem(LEVEL_KEY, String(level))
    } catch {
      // kept for this draw only
    }
    settle = SETTLE_FRAMES
    // a new density: the stage re-measures on resize
    if (LEVELS[level]!.dpr !== was) window.dispatchEvent(new Event("resize"))
  }
}

/** how the stage is mounted, and what it tells its host as it happens */
export interface WheelOptions {
  /** the stage comes up on the frame its story opens on and stays there, its
   *  clock held, until `release()` — a spectator's draw under the intro that
   *  explains it (components/draw/wheel-stage.tsx), so the draw they then
   *  watch is the very picture they were looking at */
  held?: boolean
  /** the stage's Continue is offered: once you have been lit, or, for a
   *  spectator, once the winners have been walked through. Once. The host
   *  shows its own Continue only if the stage fails */
  onEnded?: () => void
  /** the player is through: the stage's Continue pressed (a win, a
   *  spectator's draw), or the fall it starts played out (a loss). Once. The
   *  host moves on */
  onDone?: () => void
}

/** Mount the wheel's stage in `host` for one draw. A stage that cannot build
 *  (no WebGL, say) throws and leaves `host` as it was. */
export function mountWheel(host: HTMLElement, draw: WheelDraw, options: WheelOptions = {}): WheelStage {
  const before = new Set(host.children)
  try {
    return mountStage(host, draw, options)
  } catch (error) {
    // a stage that throws while it builds (no WebGL, say) leaves nothing of
    // itself in the host: the page's own words stand there instead
    for (const child of [...host.children]) if (!before.has(child)) child.remove()
    throw error
  }
}

function mountStage(host: HTMLElement, draw: WheelDraw, { held = false, onEnded, onDone }: WheelOptions): WheelStage {
  // the stage's furniture the scene in ./proto expects: #app, the #gl canvas, #phase
  const app = document.createElement("div")
  app.id = "app"
  const canvas = document.createElement("canvas")
  canvas.id = "gl"
  // the scrub slider the scene drives; the scene draws it as a line along the
  // bottom, which the stage hides (stage.css)
  const phase = document.createElement("input")
  phase.id = "phase"
  phase.type = "range"
  phase.min = "0"
  phase.max = "1"
  phase.step = "0.001"
  phase.value = "0"
  phase.tabIndex = -1
  phase.setAttribute("aria-hidden", "true")
  app.append(canvas, phase)
  host.appendChild(app)
  const dom = {
    app,
    canvas,
    phase,
    mount(tag: string, id: string) {
      const el = document.createElement(tag)
      el.id = id
      app.appendChild(el)
      return el
    },
  }

  // YOU are ticket 0, as ./proto's own ring has it; the rest follow in
  // any order (the ring sorts them by value). A SPECTATOR has no ticket: the
  // chain's tickets go in as they are, and the scene is told there is no
  // "you" in them (the JOLLITY spectator edits under ./proto)
  const mine = slotHex(draw.mine)
  const spectator = mine === ""
  const slots = spectator ? draw.tickets.map(slotHex) : [mine, ...draw.tickets.map(slotHex).filter((slot) => slot !== mine)]
  const values = slots.map(bytes)

  // the scene reads the URL only through `u`, so nothing on the app's own URL
  // (a ?game=) is mistaken for one of its dials. The coin is YOUR ticket, so
  // a spectator's page opens past it, the wheel already turning. Said every
  // time: the page keeps it in module state, and the next mount may be a
  // player's
  const u = readUrl(`?intro=${spectator ? 0 : 1}`)
  slitParams(u)
  Object.assign(SLIT, {
    n: values.length,
    winners: Math.max(1, Math.min(draw.winners, values.length)),
    friends: 0, // no friends' tickets or names on a real draw
    // the prize or the fall is about YOUR ticket: a spectator's draw holds on the winners
    showWinOrLoss: !spectator,
  })
  Object.assign(FLOW, {
    amount: draw.prize.amount,
    unit: draw.prize.unit,
    prefix: draw.prize.prefix,
  })

  // WHO'S PLAYING: every ticket's name, read now, while the coin goes into the
  // slit and the wheel turns; you and the winners first. One read per ticket
  // for the page's life (./names.ts); a name that comes after the row is up is
  // put in
  let scene: ProtoScene | null = null
  const winners = new Set(winnersByRule(draw.tickets, draw.target, SLIT.winners).map(slotHex))
  const first = slots.flatMap((slot, i) => (i === 0 || winners.has(slot) ? [i] : []))
  const labels = rowLabels(slots, nameCache(draw.names), () => scene?.names.refresh(), first)

  const stats = { fps: 0 }
  const loop = createLoop({ stats })
  // set before the scene first measures the stage
  const quality = qualityGovernor()
  let done = false
  let shown = false
  scene = createSlit(
    { dom, loop },
    {
      opening: "slit",
      chainDraw: {
        values,
        target: bytes(draw.target),
        spectator,
        won: !spectator && draw.won,
        nameOf: labels.labelOf,
        onDone: () => {
          if (done) return
          done = true
          onDone?.()
        },
        onContinueShown: () => {
          if (shown) return
          shown = true
          onEnded?.()
        },
      },
    },
  )
  const stage = scene

  let frames = 0
  // HELD: frames left to draw before the picture is still (see HELD_SETTLE_FRAMES)
  let heldFrames = HELD_SETTLE_FRAMES
  const stale = () => {
    heldFrames = HELD_SETTLE_FRAMES
  }
  loop.onFrame = (t, dt) => {
    if (held) {
      if (heldFrames <= 0) return
      heldFrames -= 1
    }
    frames += 1
    quality(dt)
    stage.frame(t, dt)
  }
  if (held) {
    loop.hold()
    addEventListener("resize", stale)
    void document.fonts?.ready.then(stale)
  }
  const release = () => {
    if (!held) return
    held = false
    removeEventListener("resize", stale)
    loop.release()
  }
  loop.start()
  app.classList.add("is-booted")

  const round = (v: number, places: number) => (Number.isFinite(v) ? Number(v.toFixed(places)) : null)
  const progress = (): WheelProgress => {
    const slit = stage.debug().slit
    // the context the stage drew with: it exists by now, so this creates none
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    return {
      frames,
      fps: stats.fps,
      ready: slit.ready,
      painted: slit.painted,
      story_s: round(slit.s, 2),
      phase: round(slit.phase, 3),
      spun: slit.spun,
      landed: slit.landed,
      continue_shown: slit.continue.shown,
      continue_pill: slit.continue.pill,
      continued: slit.continue.continued,
      coin_uploaded: slit.upload.done,
      gl_lost: gl ? gl.isContextLost() : null,
      visibility: document.visibilityState,
      size: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    }
  }

  return {
    release,
    progress,
    destroy() {
      removeEventListener("resize", stale)
      labels.stop()
      loop.stop()
      // the prize's coin, kept for the next draw while its GL context is still here
      keepBakes()
      // The renderer lets go after the bakes are kept and before the context
      // goes, or three logs "Context Lost." on every exit.
      stage.dispose()
      releaseBakes()
      // hand the GL context back: a phone runs out of them long before a page
      // that mounts the draw twice would otherwise notice
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
      gl?.getExtension("WEBGL_lose_context")?.loseContext()
      // three's DFG lookup texture is one for the whole page and keeps a
      // dispose listener per renderer that ever used it, which holds that
      // renderer's context and canvas. Out of #app, the canvas no longer holds
      // the closed draw's tree with it; the lost context itself stays.
      canvas.remove()
      app.remove()
    },
  }
}
