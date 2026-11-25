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
import { FLOW, PALETTE } from "./proto/scenes/wheel/config.js"
import { cuesFor } from "./proto/scenes/wheel/slit/sequence.js"
import { NAME_IN } from "./proto/scenes/wheel/slit/walk.js"
import { stretchesFor, warpFor } from "./proto/scenes/wheel/timing.js"
import { PRIZE } from "./proto/render-utils/prize/config.js"
import { createLoop as createLoopJs } from "./proto/render-utils/loop.js"
import { readUrl } from "./proto/render-utils/url.js"
import { DPR_CAP } from "./proto/render-utils/layout.js"
import { keepBakes, releaseBakes } from "./baked-coin"
import { nameCache, rowLabels, rowName } from "./names"
import { slotHex, winnersByRule } from "./rule"
import { registerExplore, STAGE_TIMELINE, type WheelExplore, type WheelTimeline } from "./explore"
import { createNameTicker, type NameTicker } from "./name-ticker"

/* THE DRAW'S PACE, set on the scene's config from outside, before anything
   below reads it:
   - who's playing and the winners are walked through a little slower (the
     scene's own: 600 / 2500 / 250 / 600 ms);
   - who's playing runs along the top of the screen (the scene's own: 183,
     over the wedge), its names a little bigger (stage.css).
   THE WHEEL STANDS before it turns. Its
   tickets come on as the coin spirals in, the coin lands on a still wheel,
   and the wheel stays still WHEEL_STANDS_MS more before it spins (with
   friends, until their row has lit each of them: standsFor), so the
   player sees the wheel first (the scene starts it as the coin lands). The
   draw's timeline, at the bottom, takes the player back to any point of the
   spin once it is over (explore.ts): let go, it stays there (at the very end, it lands).
   The player's friends (WheelDraw.friends: their contacts, by name) are
   marked on the wheel as their names are read, a colour each, FRIENDS_MAX at most */
const WHEEL_STANDS_MS = 1500
const TICKETS_BEFORE_LANDING_MS = 1200
/* with friends in the draw, the wheel stands until their row (before the
   spin, the JOLLITY friends edits under ./proto) has gone through them: it comes on
   FRIENDS_AFTER_LANDING_MS after your coin is down, goes through the friends
   (the ticker's TICK_* below; FRIEND_CYCLE_MS each for the "friends" row),
   shows them all for FRIENDS_TAIL_MS, and then the wheel turns (standsFor) */
const FRIENDS_AFTER_LANDING_MS = 400
/* a draw marks at most this many friends: each one is visited before the
   spin, so every one more holds the wheel a little longer */
const FRIENDS_MAX = 6
const FRIEND_CYCLE_MS = 1200
const FRIENDS_TAIL_MS = 600
/* how the friends are shown before the spin: "ticker", a strip of every name
   round the wheel that rests on you and scrolls fast through everyone in
   between to each friend (./name-ticker.ts); "all", who's playing's own row
   visiting each friend; "friends", a row of only the friends */
const FRIENDS_ROW: "ticker" | "all" | "friends" = "ticker"
/* the ticker: on you this long, then to each friend a fast scroll of
   TICK_SCROLL_MS and a rest of TICK_HOLD_MS on them */
const TICK_FIRST_MS = 1000
const TICK_SCROLL_MS = 600
const TICK_HOLD_MS = 750
const standsFor = (friends: number, spectator: boolean) => {
  if (!friends) return WHEEL_STANDS_MS
  const visit =
    FRIENDS_ROW === "ticker"
      ? TICK_FIRST_MS + (friends - (spectator ? 1 : 0)) * (TICK_SCROLL_MS + TICK_HOLD_MS)
      : friends * FRIEND_CYCLE_MS
  return Math.max(WHEEL_STANDS_MS, FRIENDS_AFTER_LANDING_MS + visit + FRIENDS_TAIL_MS)
}
Object.assign(SLIT, {
  namesWalkMs: 900,
  walkWinnersMaxMs: 4000,
  nameSlideMs: 350,
  walkMs: 800,
  spinStartMs: WHEEL_STANDS_MS,
  ticketsBeforeSeatMs: TICKETS_BEFORE_LANDING_MS,
  pauseOnSlider: true,
  namesY: 80,
  // where you and your friends are: a ring round each marked ticket (the
  // scene's own toggle, off there), and on a big wheel, where every ticket is
  // a speck, the marked ones a little bigger
  rings: true,
  markMinPx: 5,
  // before the spin, your friends' names on who's playing's own row, each lit this long in turn, its line drawn down over this
  friendCycleMs: FRIEND_CYCLE_MS,
  friendsAfterSeatMs: FRIENDS_AFTER_LANDING_MS,
  friendLineDrawMs: 300,
  // how: on who's playing's own row, every name in it, the friends highlighted
  // and visited ('all'), or a row of only the friends ('friends')
  friendsRow: FRIENDS_ROW,
  friendNameA: 0.6,
  tickFirstMs: TICK_FIRST_MS,
  tickScrollMs: TICK_SCROLL_MS,
  tickHoldMs: TICK_HOLD_MS,
  spinStartMaxMs: 60_000,
})

/** a colour each for the player's friends on the wheel: the scene's own
 *  family palette, less its blues (yours is the cyan), round again past six */
const FRIEND_COLOURS = (PALETTE as string[]).filter((colour) => colour !== "#00ffd5" && colour !== "#2a6bff")

/** how often, in frames, the stage looks whether the coin has gone in */
const STARTED_EVERY = 10

/** the event that tells the stage it is covered (detail true) or not: the
 *  page's hold dispatches it from inside the stage, and it bubbles here */
export const STAGE_COVERED = "jollity:stage-covered"
/** the event that zooms the wheel out to the whole of it: the player's own
 *  ticket tapped for them, as a tap while zoomed in does (the page's hold,
 *  after a win). The listener sets `detail.done` when it took it */
export const STAGE_ZOOM_OUT = "jollity:zoom-out"

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
  /** the player's friends, by name (as who's playing reads them, `names`):
   *  a ticket whose name is one of these is a friend's, marked on the wheel in
   *  a colour of its own, its name on the row in it, and visited before the
   *  spin. Any number may come (all of the player's contacts): the wheel
   *  stands only for the ones it finds among its entrants. None found: no
   *  friends shown, and the wheel stands its usual time */
  friends: readonly string[]
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
  /** the JOLLITY names edit: write who's playing again, with the names that came since */
  names: { refresh: () => void }
  /** the JOLLITY friends edit: the ticker's visit has begun, its stops held: a friend found after is marked, not visited */
  friendsHeld: () => boolean
  /** the JOLLITY timeline edit: where the draw is along the spin, and the page's hand on it */
  timeline: {
    at: () => number
    started: () => boolean
    scrub: (at: number) => boolean
    release: () => void
    busy: () => boolean
  }
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
      /** the player's slot */
      mine: number
      /** who's playing: each name's ticket on the stage now, nominal px */
      names: { tickets: { k: number; x: number; y: number }[] } | null
      /** a tap on the stage, nominal px: the slot it took, or null if the wheel takes none now */
      tap: (x: number, y: number) => number | null
      /** the JOLLITY explore edits: every ticket where it is drawn now (nominal px), whose it is, and the player's zoom */
      ticketsNow?: () => { k: number; x: number; y: number; r: number; won: boolean; you: boolean }[] | null
      whoIs?: (k: number) => { name: string } | null
      pick?: (k: number) => boolean
      userView?: { s: number; tx: number; ty: number }
      viewScale?: number
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
  /** the player's friends found so far: a ticket's index in `values`, and its
   *  colour (the list grows as their names are read) */
  friends: { index: number; colour: string }[]
  /** every name round the wheel, before the spin (./name-ticker.ts; friendsRow "ticker") */
  ticker: NameTicker | null
  /** the stage's own Continue pressed on a win (hidden under the page's
   *  hold), or the fall played out on a loss: once */
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
  /** the JOLLITY hold edit: the clock stands still, and goes on from there */
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
// The stage starts at the level this device last held. The best is 2× supersampling
// with no MSAA. While frames are slow, it steps down: to MSAA, then to less density.
// It never steps back up within a draw.
/** what the stage may draw with, best first (2×: the scene's own ceiling, DPR_CAP in ./proto/render-utils/layout.js) */
const LEVELS = [
  { dpr: 2, ss: 2, msaa: false },
  { dpr: 2, ss: 1, msaa: true },
  { dpr: 2, ss: 1, msaa: false },
  { dpr: 1.5, ss: 1, msaa: false },
  { dpr: 1.25, ss: 1, msaa: false },
  { dpr: 1, ss: 1, msaa: false },
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
/** RESTING, once the draw is over (ended, nothing up, the wheel not on its
 *  way back): the picture does not change unless something changes it, so
 *  it is drawn only for a while after each poke (a zoom, a ticket picked, a
 *  name in, a resize, the hold uncovering it or asking for a frame to read),
 *  then not at all. These are the frames each poke buys */
const REST_SETTLE_FRAMES = 90
const POKE_FRAMES = 30
const PICK_FRAMES = 120
/** the event that asks a resting stage for frames (the hold, before it reads the stage's canvases) */
export const STAGE_POKE = "jollity:stage-poke"
/** per opening: a level held under the flip page, whose GL was the whole
 *  screen, says nothing about the slit's, a window the size of the coin.
 *  A new key when LEVELS change, so a stored index never points at another level */
const LEVEL_KEY = "jollity.draw.level.slit.v2"

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
    DPR_CAP.ss = LEVELS[level]!.ss
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
    const was = LEVELS[level]!
    level++
    apply()
    try {
      localStorage.setItem(LEVEL_KEY, String(level))
    } catch {
      // kept for this draw only
    }
    settle = SETTLE_FRAMES
    // a new density or supersampling: the stage re-measures on resize
    const now = LEVELS[level]!
    if (now.dpr !== was.dpr || now.ss !== was.ss) window.dispatchEvent(new Event("resize"))
  }
}

/** how the stage is mounted, and what it tells its host as it happens */
export interface WheelOptions {
  /** the stage comes up on the frame its story opens on and stays there, its
   *  clock held, until `release()` — a spectator's draw under the intro that
   *  explains it (components/draw/wheel-stage.tsx), so the draw they then
   *  watch is the very picture they were looking at */
  held?: boolean
  /** the draw is over and offers its way on: once you have been lit, or,
   *  for a spectator, once the winners have been walked through. Once. The
   *  page then offers its hold (the stage's own Continue is hidden under
   *  [data-hold]); its own Continue shows only if the stage fails */
  onEnded?: () => void
  /** the player is through: the stage's own Continue pressed (a win, a
   *  spectator's draw), or the fall it starts played out (a loss). Once. The
   *  host moves on. Under the page's hold that Continue is hidden, and the
   *  page's `continue` moves on instead */
  onDone?: () => void
  /** the stage is drawn and waits for the player's coin: the time they take is theirs. Once */
  onWaiting?: () => void
  /** the coin went in (a spectator's: the story started by itself): the
   *  animation's own run starts here. Once */
  onStarted?: () => void
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

function mountStage(host: HTMLElement, draw: WheelDraw, { held = false, onEnded, onDone, onWaiting, onStarted }: WheelOptions): WheelStage {
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
  // THE PLAYER'S FRIENDS, BY NAME: a ticket is a friend's once the name read
  // for it (who's playing's, below) is one of theirs. It is marked from then
  // on, a colour each in the order they turn up, FRIENDS_MAX at most; the
  // scene reads this list as it grows
  const friendNames = new Set(draw.friends.map(rowName).filter((name) => name !== ""))
  const friends: { index: number; colour: string }[] = []

  // the scene reads the URL only through `u`, so nothing on the app's own URL
  // (a ?game=) is mistaken for one of its dials. The coin is YOUR ticket, so
  // a spectator's page opens past it, the wheel already turning. Said every
  // time: the page keeps it in module state, and the next mount may be a
  // player's
  const u = readUrl(`?intro=${spectator ? 0 : 1}`)
  slitParams(u)
  Object.assign(SLIT, {
    // the wheel stands its usual time until a friend is found (findFriend; slitParams clamps it to the scene's 2 s: set after)
    spinStartMs: standsFor(0, spectator),
    n: values.length,
    winners: Math.max(1, Math.min(draw.winners, values.length)),
    friends: 0, // the scene's own made-up friends off; real ones come in through chainDraw.friends
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
  // THE ROW'S NAMES FIRST, AND ONLY THEY REDRAW IT: the names the row shows
  // are the ones it asks for as it is built (`nameOf`), so those reads go
  // next, and a name landing redraws the row only if it is in it, at most once
  // a frame. A big draw reads a name for every ticket; were each to rebuild
  // the row, the row would twitch as long as they keep coming
  const inRow = new Set<number>()
  let asked: number[] = []
  let redraw = 0
  const onName = (index: number) => {
    findFriend(index)
    if (inRow.size && !inRow.has(index)) return
    if (redraw) return
    redraw = requestAnimationFrame(() => {
      redraw = 0
      scene?.names.refresh()
      poke(POKE_FRAMES)
    })
  }
  const labels = rowLabels(slots, nameCache(draw.names), onName, first)
  // a name just read is a friend's: the ticket is theirs (never yours)
  const findFriend = (index: number) => {
    if (!friendNames.size || friends.length >= FRIENDS_MAX || slots[index] === mine || friends.some((friend) => friend.index === index)) return
    if (!friendNames.has(labels.labelOf(index))) return
    friends.push({ index, colour: FRIEND_COLOURS[friends.length % FRIEND_COLOURS.length]! })
    // the wheel stands until every friend found is visited: the scene reads the
    // stand each frame, so it may grow until the visit begins (its stops held)
    // or the wheel turns, and never after, or the spin would run back
    if (!scene?.friendsHeld() && !scene?.timeline.started()) SLIT.spinStartMs = standsFor(friends.length, spectator)
    poke(POKE_FRAMES)
  }
  const labelOf = (index: number) => {
    if (!inRow.has(index)) {
      inRow.add(index)
      if (!asked.length)
        queueMicrotask(() => {
          labels.prefer(asked)
          asked = []
        })
      asked.push(index)
    }
    return labels.labelOf(index)
  }

  // every name round the wheel, for the friends' visit before the spin (friendsRow "ticker")
  const ticker = friendNames.size && FRIENDS_ROW === "ticker" ? createNameTicker(app) : null
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
        nameOf: labelOf,
        friends,
        ticker,
        onDone: () => {
          if (done) return
          done = true
          onDone?.()
        },
        onContinueShown: () => {
          if (shown) return
          shown = true
          ended = true
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
    poke(POKE_FRAMES)
  }
  // RESTING (see REST_SETTLE_FRAMES): frames left to draw before the picture is still again
  let ended = false
  let resting = false
  let restFrames = 0
  const poke = (n: number) => {
    restFrames = Math.max(restFrames, n)
  }
  const onPoke = (e: Event) => poke((e as CustomEvent<number | null>).detail ?? POKE_FRAMES)
  host.addEventListener(STAGE_POKE, onPoke)
  const onResize = () => poke(POKE_FRAMES)
  addEventListener("resize", onResize)
  // COVERED: the page's hold (lib/draw/hold/scene) lays its own picture of
  // the stage over it while the player holds, so no frame of the stage is
  // seen meanwhile, and none is drawn (`STAGE_COVERED`, on the stage's element)
  let covered = false
  const cover = (e: Event) => {
    covered = !!(e as CustomEvent<boolean>).detail
    // uncovered: what is under the hold's picture is drawn again
    if (!covered) poke(POKE_FRAMES)
  }
  host.addEventListener(STAGE_COVERED, cover)
  // ZOOM OUT: the player's ticket, where the stage draws it now, tapped
  const zoomOut = (e: Event) => {
    const slit = stage.debug().slit
    const you = slit.names?.tickets.find((t) => t.k === slit.mine)
    if (!you || slit.tap(you.x, you.y) == null) return
    poke(PICK_FRAMES)
    const detail = (e as CustomEvent<{ done: boolean } | null>).detail
    if (detail) detail.done = true
  }
  host.addEventListener(STAGE_ZOOM_OUT, zoomOut)
  // LOOKING ROUND THE WHEEL (./explore.ts): the stage's tickets on the page,
  // and the player's zoom, in CSS px; the stage works in its own px, `viewScale` to one
  const explore: WheelExplore = {
    tickets() {
      const slit = stage.debug().slit
      const all = slit.ticketsNow?.()
      if (!all) return null
      const box = app.getBoundingClientRect()
      const k = slit.viewScale || 1
      return all.map((t) => ({ k: t.k, x: box.left + t.x * k, y: box.top + t.y * k, r: t.r * k, won: t.won, you: t.you }))
    },
    nameOf: (k) => stage.debug().slit.whoIs?.(k)?.name ?? null,
    pick: (k) => {
      poke(PICK_FRAMES)
      return stage.debug().slit.pick?.(k) ?? false
    },
    view() {
      const slit = stage.debug().slit
      const v = slit.userView ?? { s: 1, tx: 0, ty: 0 }
      const k = slit.viewScale || 1
      return { s: v.s, x: v.tx * k, y: v.ty * k }
    },
    setView({ s, x, y }) {
      const slit = stage.debug().slit
      if (!slit.userView) return
      const k = slit.viewScale || 1
      Object.assign(slit.userView, { s, tx: x / k, ty: y / k })
      stale()
    },
    box: () => app.getBoundingClientRect(),
    timeline: () => timelineNow(),
    scrub(at) {
      poke(POKE_FRAMES)
      return stage.timeline.scrub(at)
    },
    scrubEnd() {
      poke(POKE_FRAMES)
      stage.timeline.release()
    },
    busy: () => stage.timeline.busy(),
  }
  const unregisterExplore = registerExplore(app, explore)
  // THE TIMELINE (explore.ts): said to the page as it changes, from the frames the stage draws
  const timelineNow = (): WheelTimeline => ({
    at: stage.timeline.at(),
    started: stage.timeline.started(),
    prizeUp: app.classList.contains("flow-prize-up"),
  })
  let saidTimeline = ""
  const sayTimeline = () => {
    const now = timelineNow()
    const key = `${now.at.toFixed(4)}|${now.started}|${now.prizeUp}`
    if (key === saidTimeline) return
    saidTimeline = key
    app.dispatchEvent(new CustomEvent<WheelTimeline>(STAGE_TIMELINE, { detail: now, bubbles: true }))
  }
  let started = false
  let waiting = false
  const wheelHost = host.closest(".wheel-host") as HTMLElement | null
  loop.onFrame = (t, dt) => {
    if (covered) return
    if (held) {
      if (heldFrames <= 0) return
      heldFrames -= 1
    }
    // over, nothing up and the wheel not on its way back: at rest from here
    if (ended && !resting && !app.classList.contains("flow-prize-up") && wheelHost?.dataset.wheel !== "going") {
      resting = true
      poke(REST_SETTLE_FRAMES)
    }
    if (resting) {
      // the spin played on from the timeline, or a hand on it: drawn until it is still again
      if (stage.timeline.busy()) poke(POKE_FRAMES)
      if (restFrames <= 0) return
      restFrames -= 1
    }
    frames += 1
    quality(dt)
    stage.frame(t, dt)
    sayTimeline()
    // drawn and waiting for the coin, then the story's clock started (the coin
    // went in): each said once, looked at every few frames
    if (!started && frames % STARTED_EVERY === 0) {
      const slit = stage.debug().slit
      if (Number.isFinite(slit.s)) {
        started = true
        onStarted?.()
      } else if (!waiting && slit.painted) {
        waiting = true
        onWaiting?.()
      }
    }
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
      host.removeEventListener(STAGE_COVERED, cover)
      host.removeEventListener(STAGE_ZOOM_OUT, zoomOut)
      host.removeEventListener(STAGE_POKE, onPoke)
      removeEventListener("resize", onResize)
      unregisterExplore()
      labels.stop()
      cancelAnimationFrame(redraw)
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
