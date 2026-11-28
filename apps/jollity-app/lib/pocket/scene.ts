// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE POCKET'S SCENE: the collectables screen's way into the Pocket, an open book at the foot of the screen. Drag the book's cover
 * across to close it: every piece its edge sweeps past drops through the middle of the screen into its cell, and let
 * go past CLAIM_AT the cover shuts by itself on the rest and lands with a thud. Let go short and the book stays open:
 * the pieces the cover took fly back out to the scene. Once shut, the book grows into the middle of the screen.
 *
 * Framework-free (architecture rule 6), the way lib/collectables-scene/engine.ts sits behind the collectables scene: the
 * component (components/pocket/pocket-claim.tsx) renders the book's markup, hands its elements here, forwards the
 * presses, and hears back what React draws (the cells' pieces, the shut) and what the collectables screen wants to know (a piece
 * taken or given back, how far the cover has closed, the claim). The geometry is ./book, the motion ./motion and the
 * effects canvas ./fx; this runs the frame loop over them and writes the book, the cover, the flights and the
 * sprites.
 *
 * A piece the Pocket takes leaves the scene (`onTake`) and is the Pocket's to draw from then on: one still wrapped
 * flies in its shell from where the scene drew it, an opened one as the flat art that carries `data-collectables-piece`.
 */
import {
  BOOK,
  CLAIM_AT,
  bookAt,
  cellAt,
  cellOrder,
  claims,
  clamp01,
  coverFor,
  grabs,
  lerp,
  seg,
  smooth,
  sweeps,
  type Book,
  type Point,
  type Size,
} from "./book"
import { FLIGHT, LANDING, confettiFor, coverFall, flightAt, follow, invitation, squash, thud, type Bit } from "./motion"
import { paintPocketFx } from "./fx"
import { wrappingExpected } from "../wrapping/availability"
import { ensureFields } from "../wrapping/fieldCache"
import { BASE, materialFor, wrappingPhase } from "../wrapping/materials"
import type { WrappingRenderer } from "../wrapping/renderer"

/** the book comes up from below between these, s after the pieces began to float */
const BOOK_IN_FROM = 1.2
const BOOK_IN_TO = 1.9
/** how far up the book peeks at rest, of the way from peeking to fully up (./book openY) */
const PEEK_AT = 0.45
/** per s: the held cover trailing the finger (it has weight), the cover swinging back open, the book lifting */
const HELD_RATE = 11
const OPEN_RATE = 6
const LIFT_RATE = 8
/** with nothing opened yet, the invitation starts this long after the float began, s */
const LATE = 5
/** the finish's pieces leave this far apart, s */
const FINISH_STAGGER = 0.06
/** let go short of the point: the pieces the cover took fly home this far apart, the last taken first, s */
const BACK_STAGGER = 0.05
/** let go short of the point: a cell's landing glow goes out over this, ms, as its piece leaves */
const LANDING_FADE_MS = 160
/** the falling cover lands this long before the last piece is in, s */
const LAND_EARLY = 0.04
/** the cover lies still this long after the thud before the book grows, s */
const SHUT_AFTER = 0.5
/** after the book is shut: it grows into the middle between these, s */
const GROW_FROM = 0.05
const GROW_TO = 1
const CONFETTI = 46
/** after the book is shut: everything fades, ms, and the collectables screen goes on */
export const FADE_AT_MS = 2550
const FADE_MS = 300
/** a press this near a piece, of its box, is the piece's: the scene's own hit test */
const PIECE_HIT = 0.575
/** the cover's perspective, px: upright, its free edge comes about 14% bigger toward you */
const COVER_DEPTH = 1460
/** how much bigger the cover's free edge comes toward you, upright (what COVER_DEPTH makes of it), with a little to spare */
const COVER_TOWARD = 0.16
/** how far the cover's free edge lifts off the table as it stands, and more while it is held, px */
const COVER_LIFT = 16
const HELD_LIFT = 10
/** the squash of a landing, as keyframes over LANDING */
const SQUASH_FRAMES = Array.from({ length: 25 }, (_, i) => {
  const q = squash((i / 24) * LANDING)
  return { transform: `scale(${(1 + q).toFixed(4)}, ${(1 - q).toFixed(4)})` }
})

/** One piece the Pocket can take, by its place in the list: its art, and whether it is rare (its shell's material). */
export interface PocketArt {
  image: string
  rare: boolean
}

/** Where the collectables scene draws a piece this frame, in viewport px (components/collectables/collectables-scene's PieceSpot). */
export interface RingSpot {
  index: number
  cx: number
  cy: number
  size: number
  rotation: number
  /** broken open: drawn as its plain art, which carries `data-collectables-piece` */
  opened: boolean
  /** the Pocket has it: the scene keeps its place but does not draw it */
  taken?: boolean
}

/** The book's markup, as the component rendered it. */
export interface PocketElements {
  /** the Pocket's box, the whole screen: the scene draws in its coordinates */
  root: HTMLElement
  book: HTMLElement
  /** the cover, its inside (the first half of the cells) and its outside, and the gold edge it shows past the point */
  cover: HTMLElement
  inner: HTMLElement
  outer: HTMLElement
  edge: HTMLElement
  /** the flights' layer, cut where the cover lies over the page; the effects and the shells draw on canvases in it */
  flights: HTMLElement
  fx: HTMLCanvasElement | null
  shells: HTMLCanvasElement | null
  /** by piece index, the flat art that flies; by cell, the cell a piece lands in. Read as they are each time, so a
   *  list the component fills in later is seen. */
  sprites: readonly (HTMLImageElement | null | undefined)[]
  cells: readonly (HTMLElement | null | undefined)[]
}

export interface PocketSceneOptions {
  /** the pieces as the scene starts; setPieces keeps them current */
  pieces: readonly PocketArt[]
  /** where the collectables scene draws its pieces, read every frame */
  ring: () => readonly RingSpot[]
  /** the collectables screen's surface: an opened piece's flat art is found in it by `data-collectables-piece` */
  surface: () => ParentNode | null
  /** the cells changed: `filled[n]` is the piece in cellOrder's n-th cell (a hole: none), and the first `landed`
   *  of them are in */
  onCells: (filled: readonly number[], landed: number) => void
  /** the book is shut: every piece is in and the thud has rung out */
  onShut: () => void
  /** a piece left the scene for the Pocket, which draws it from now on */
  onTake: (index: number) => void
  /** a piece the Pocket gave back (the book left open): the scene draws it again, opened if it was opened in the book */
  onReturn: (index: number, opened: boolean) => void
  /** how far the cover has closed, 0 to 1, as it moves */
  onCover: (closed: number) => void
  /** the player closed the book: past the point, or Claim all */
  onClaim: () => void
}

export interface PocketScene {
  /** one frame at `now`, the frame clock in ms (run calls it on every animation frame) */
  step(now: number): void
  /** run the frames until destroy */
  run(): void
  /** the pieces changed (more claims came in) */
  setPieces(pieces: readonly PocketArt[]): void
  /** a press at `at`, viewport px: true when it grabbed the cover, and nothing else should hear it */
  press(at: Point, pointer: number): boolean
  /** the pointer moved to `x`, viewport px */
  move(pointer: number, x: number): void
  /** the pointer went up or was cancelled */
  release(pointer: number): void
  /** the cover is held */
  holding(): boolean
  /** every piece left goes in and the cover falls shut: the player's own claim (Claim all) or the screen's word */
  finish(fromPlayer: boolean): void
  /** stop the frames and let the shells' renderer go */
  destroy(): void
}

interface Flight {
  from: Point
  /** the art's side as it left the scene, px */
  art: number
  rotation: number
  pinned: HTMLImageElement | null
  opened: boolean
}

/** A piece the Pocket holds, or has queued, or is giving back. */
export interface Take {
  /** when it leaves the scene, s */
  at: number
  /** its place in the order the cells fill (./book cellOrder) */
  order: number
  flight: Flight | null
  started: boolean
  landed: boolean
  /** given back (the cover let go short): when it starts home, s; −1 while it is the Pocket's */
  back: number
  /** it had landed: it was opened in the book, and goes back out open */
  openIn: boolean
}

interface Drawn {
  index: number
  flight: Flight
  at: Point
  scale: number
  rotate: number
  u: number
  /** on its way back out of the book: whole from the start, no fade */
  going: boolean
  /** …and opened there: it goes as its plain art, no shell */
  open: boolean
}

/** The cover's motion, as coverStep reads it. */
export interface CoverMotion {
  cov: number
  covV: number
  covTarget: number
  lift: number
  /** the pointer holding the cover, or null */
  grab: number | null
  finishing: boolean
  still: boolean
}

/**
 * One frame of the cover (while the book is open): held, it trails the finger; let go short, it swings back open;
 * past the point it falls shut by itself, faster and faster, and waits just short of shut until `lastIn`, when the
 * last piece is in (s). The book lifts while the cover is held, falling, or anything but open.
 */
export function coverStep(c: CoverMotion, dt: number, t: number, lastIn: number): { cov: number; covV: number; lift: number } {
  let { cov, covV } = c
  if (c.finishing) {
    if (c.still) cov = 1
    else ({ cov, v: covV } = coverFall({ cov, v: covV }, dt, t < lastIn - LAND_EARLY))
  } else {
    const held = c.grab !== null
    cov = follow(cov, held ? c.covTarget : 0, held ? HELD_RATE : OPEN_RATE, dt)
    covV = 0
  }
  const lift = follow(c.lift, c.grab !== null || c.finishing || cov > 0.02 ? 1 : 0, LIFT_RATE, dt)
  return { cov, covV, lift }
}

/** What poseAt reads of the scene. */
export interface PoseState {
  cov: number
  lift: number
  grab: number | null
  finishing: boolean
  still: boolean
  /** a piece has been opened in the scene: the invitation need not wait */
  opened: boolean
  /** when the cover landed, and when the book shut (s); -1 before */
  thudAt: number
  shutAt: number
}

/** Where the book is at `t` (s), as ./book bookAt takes it, how far closed its cover is drawn, and the invitation's finger. */
export interface Pose {
  bookIn: number
  grown: number
  peek: number
  closed: number
  dip: number
  ghost: { a: number; u: number } | null
}

/**
 * The book at `t`: it comes up from below, peeks, lifts while its cover is in play, and once shut grows into the
 * middle. Every few seconds while nobody holds it, the cover lifts a little and a finger shows where to take it (not
 * before LATE unless a piece has been opened). After the landing the cover bounces and the book dips (./motion thud).
 */
export function poseAt(s: PoseState, t: number): Pose {
  const floating = s.shutAt < 0
  const bookIn = floating ? smooth(seg(t, BOOK_IN_FROM, BOOK_IN_TO)) : 1
  const grown = floating ? 0 : s.still ? 1 : smooth(seg(t, s.shutAt + GROW_FROM, s.shutAt + GROW_TO))
  const peek = floating ? lerp(PEEK_AT, 1, smooth(s.lift)) : 1
  let closed = floating ? s.cov : 1
  let dip = 0
  let ghost: { a: number; u: number } | null = null
  if (floating && !s.still && s.grab === null && !s.finishing && s.cov < 0.02 && bookIn > 0.95 && (s.opened || t > LATE)) {
    const invite = invitation(t)
    closed += invite.lift
    ghost = invite.ghost
  }
  if (s.thudAt >= 0 && !s.still) ({ closed, dip } = thud(t - s.thudAt))
  return { bookIn, grown, peek, closed, dip, ghost }
}

/** How the cover is drawn `closed` of the way shut: its CSS, and the turn's sine and cosine and lift for the flights' cut. */
export interface CoverLook {
  sn: number
  cs: number
  /** how far its free edge stands off the table, px */
  lift: number
  /** the book's --shadow and --shadow-w: the cover's shade on the page as it comes down onto it */
  shadow: string
  shadowWidth: string
  transform: string
  /** the cover's --light, --shade-in and --shade-out */
  light: string
  shadeIn: string
  shadeOut: string
  /** its inside faces you (the cover is still more open than upright) */
  inside: boolean
}

/**
 * The cover turned like a page lifting: it comes toward you as it stands, lifts off the table at its free edge (more
 * while `held`), catches the light near upright, and shades the page as it comes down onto it.
 */
export function coverLook(closed: number, held: boolean): CoverLook {
  const turned = clamp01(closed)
  const sn = Math.sin(Math.PI * turned)
  const cs = Math.cos(Math.PI * turned)
  const lift = (COVER_LIFT + (held ? HELD_LIFT : 0)) * sn
  return {
    sn,
    cs,
    lift,
    shadow: cs < 0 ? (clamp01(-cs * 1.6) * 0.5 * (1 - sn * 0.4)).toFixed(3) : "0",
    shadowWidth: `${(BOOK.width * Math.max(0, -cs) + 24 * sn).toFixed(1)}px`,
    transform: `perspective(${COVER_DEPTH}px) rotateY(${((turned - 1) * 180).toFixed(2)}deg) skewY(${(-Math.atan(lift / BOOK.width)).toFixed(4)}rad)`,
    light: (0.22 * sn ** 3).toFixed(3),
    shadeIn: (0.28 * sn).toFixed(3),
    shadeOut: (0.22 * sn).toFixed(3),
    inside: cs > 0,
  }
}

/**
 * The pieces go INTO the book: where the cover lies over the page (past upright, `look.cs` < 0), a piece flying in
 * goes under it. The flights' layer is the whole `stage` with the cover's place cut out, as a CSS clip-path, so a
 * piece is never drawn over the cover to vanish when it lands.
 */
export function flightsClip(book: Book, stage: Size, look: Pick<CoverLook, "sn" | "cs" | "lift">): string {
  const x0 = book.sx
  const x1 = book.sx + book.pw * -look.cs + 2
  const half = (book.ph / 2) * (1 + COVER_TOWARD * look.sn) + look.lift * book.sc + 4
  const y0 = book.sy - half
  const y1 = book.sy + half
  return `path(evenodd, "M0 0H${stage.width}V${stage.height}H0Z M${x0.toFixed(1)} ${y0.toFixed(1)}H${x1.toFixed(1)}V${y1.toFixed(1)}H${x0.toFixed(1)}Z")`
}

/** How far along its way into its cell a piece is at `t`, 0 (where it left the scene) to 1 (in): given back, it runs
 *  the same way backwards from when it starts home. Reduced motion (`still`): there at once. */
export function progress(piece: Pick<Take, "at" | "back">, t: number, still: boolean): number {
  if (piece.back >= 0) return 1 - (still ? 1 : seg(t, piece.back, piece.back + FLIGHT))
  return still ? 1 : seg(t, piece.at, piece.at + FLIGHT)
}

/** The cells with `index` in the `order`-th one. */
export function fillCell(filled: readonly number[], order: number, index: number): number[] {
  const next = [...filled]
  next[order] = index
  return next
}

/** The cells with the `order`-th one emptied, if it still holds `index`. */
export function emptyCell(filled: readonly number[], order: number, index: number): number[] {
  const next = [...filled]
  if (next[order] === index) delete next[order]
  return next
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

/** The book's furniture fades out, then the collectables screen goes on. */
export function fadeAndGo(shownEls: readonly (HTMLElement | null | undefined)[], onDone: () => void): void {
  const shown = shownEls.filter((el): el is HTMLElement => !!el)
  if (shown.length === 0) return onDone()
  const fades = shown.map((el) =>
    el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: FADE_MS,
      easing: "ease-in",
      fill: "forwards",
    }),
  )
  void fades[0]!.finished.then(
    () => onDone(),
    () => {},
  )
}

/** A hand-off the host refused: the furniture comes back, so there is a Continue to press. */
export function fadeBack(shownEls: readonly (HTMLElement | null | undefined)[]): void {
  for (const el of shownEls)
    el?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: FADE_MS,
      easing: "ease-out",
      fill: "forwards",
    })
}

/** Start the Pocket on the book's elements. It draws nothing until run (or step) and stops for good on destroy. */
export function createPocketScene(els: PocketElements, opts: PocketSceneOptions): PocketScene {
  let art = opts.pieces
  let count = art.length
  let order = cellOrder(count)
  let shells: WrappingRenderer | null = null
  let disposed = false
  let frame = 0
  const sim = {
    t: 0,
    last: 0,
    cov: 0,
    covV: 0,
    covTarget: 0,
    grab: null as number | null,
    finishing: false,
    lift: 0,
    opened: false,
    thudAt: -1,
    thudBook: null as Book | null,
    shutAt: -1,
    takes: new Map<number, Take>(),
    taken: 0,
    book: null as Book | null,
    confetti: [] as Bit[],
    said: -1,
    painted: false,
    still: reducedMotion(),
    // the pieces in the order they were taken (the n-th fills cellOrder's n-th cell), and how many have landed
    filled: [] as number[],
    landed: 0,
  }

  const cells = (filled: number[], landed = sim.landed) => {
    sim.filled = filled
    sim.landed = landed
    opts.onCells(filled, landed)
  }

  // the Pocket's box (it is the whole screen): measured when it changes size, not read every frame
  const box = { left: 0, top: 0, width: 0, height: 0 }
  const measure = () => {
    const r = els.root.getBoundingClientRect()
    box.left = r.left
    box.top = r.top
    box.width = els.root.clientWidth
    box.height = els.root.clientHeight
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null
  observer?.observe(els.root)

  const onPiece = (at: Point) =>
    opts
      .ring()
      .some((spot) => !sim.takes.has(spot.index) && Math.hypot(spot.cx - at.x, spot.cy - at.y) <= spot.size * PIECE_HIT)

  const fromPin = (index: number, from: DOMRect): Flight | null => {
    const pinned = opts.surface()?.querySelector<HTMLImageElement>(`img[data-collectables-piece="${index}"]`)
    if (!pinned) return null
    const rect = pinned.getBoundingClientRect()
    if (rect.width === 0) return null
    const style = getComputedStyle(pinned)
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    return {
      from: { x: rect.left - from.left + rect.width / 2, y: rect.top - from.top + rect.height / 2 },
      art: Math.max(1, rect.width - padding),
      rotation: 0,
      pinned,
      opened: true,
    }
  }

  const fromRing = (index: number, from: DOMRect): Flight | null => {
    const spot = opts.ring().find((s) => s.index === index)
    if (!spot) return null
    return {
      from: { x: spot.cx - from.left, y: spot.cy - from.top },
      art: spot.size * BASE.fit,
      rotation: spot.rotation,
      pinned: null,
      opened: spot.opened,
    }
  }

  /** queue a piece for the book: it leaves the scene at `at` */
  const take = (index: number, at: number) => {
    if (sim.takes.has(index)) return
    sim.takes.set(index, { at, order: sim.taken++, flight: null, started: false, landed: false, back: -1, openIn: false })
  }

  /** it leaves the scene: from here on the Pocket draws it, from where the scene last did */
  const start = (index: number, piece: Take) => {
    piece.started = true
    const from = els.root.getBoundingClientRect()
    const flight = fromPin(index, from) ?? fromRing(index, from)
    piece.flight = flight
    const sprite = els.sprites[index]
    if (flight && sprite) {
      Object.assign(sprite.style, {
        left: `${flight.from.x - flight.art / 2}px`,
        top: `${flight.from.y - flight.art / 2}px`,
        width: `${flight.art}px`,
        height: `${flight.art}px`,
      })
    }
    if (flight?.pinned) flight.pinned.style.visibility = "hidden"
    cells(fillCell(sim.filled, piece.order, index))
    opts.onTake(index)
  }

  /** a cell's landing glow and ring, faded out quickly from wherever they are */
  const fadeLanding = (slot: HTMLElement | null | undefined) => {
    for (const el of slot?.querySelectorAll<HTMLElement>(".pocket-cell-glow, .pocket-cell-ring") ?? []) {
      const from = getComputedStyle(el).opacity
      for (const running of el.getAnimations()) running.cancel()
      if (Number(from) > 0.01) el.animate([{ opacity: from }, { opacity: 0 }], { duration: LANDING_FADE_MS })
    }
  }

  /** it is in its cell: a squash, and a breath of its colour */
  const land = (piece: Take) => {
    piece.landed = true
    cells(sim.filled, Math.max(sim.landed, piece.order + 1))
    navigator.vibrate?.(8)
    const slot = els.cells[order[piece.order] ?? -1]
    if (!slot || sim.still) return
    slot.querySelector("img")?.animate(SQUASH_FRAMES, { duration: LANDING * 1000 })
    slot.querySelector(".pocket-cell-glow")?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LANDING * 1000 })
    slot.querySelector(".pocket-cell-ring")?.animate([{ opacity: 0.6 }, { opacity: 0 }], { duration: LANDING * 1000 })
  }

  /** past the point (or the screen's word): every piece left goes in, and the cover falls shut */
  const finish = (fromPlayer: boolean) => {
    if (sim.finishing || sim.shutAt >= 0) return
    sim.finishing = true
    sim.grab = null
    // one on its way home turns round: it goes in from where the scene has it
    for (const [index, piece] of sim.takes) if (piece.back >= 0) home(index, piece)
    let k = 0
    for (let index = 0; index < art.length; index++) take(index, sim.t + (sim.still ? 0 : FINISH_STAGGER * k++))
    if (fromPlayer) opts.onClaim()
  }

  /* LET GO SHORT, the book stays open: nothing the cover took is kept. Each piece flies back out of its cell to where
     the scene floats it, the last taken first, and is the scene's again when it gets there; one still queued never
     left */
  const giveBack = () => {
    const out = [...sim.takes.entries()].filter(([, piece]) => piece.back < 0).sort(([, a], [, b]) => b.order - a.order)
    let k = 0
    for (const [index, piece] of out) {
      if (!piece.started) {
        sim.takes.delete(index)
        continue
      }
      piece.back = sim.t + (sim.still ? 0 : BACK_STAGGER * k++)
      piece.openIn = piece.landed
      // its landing's breath of colour is over: a glow left on a cell it is leaving reads as a stray square
      if (piece.landed) fadeLanding(els.cells[order[piece.order] ?? -1])
    }
  }

  /** home: the scene has it again */
  const home = (index: number, piece: Take) => {
    sim.takes.delete(index)
    if (piece.flight?.pinned) piece.flight.pinned.style.visibility = ""
    const sprite = els.sprites[index]
    if (sprite) sprite.style.opacity = "0"
    cells(emptyCell(sim.filled, piece.order, index))
    opts.onReturn(index, piece.openIn)
    // all home: the cells fill from the first again
    if (!sim.takes.size && !sim.finishing) {
      sim.taken = 0
      cells([], 0)
    }
  }

  const letGo = () => {
    if (sim.grab === null) return
    sim.grab = null
    if (claims(sim.cov)) finish(true)
    else giveBack()
  }

  const step = (now: number) => {
    const s = sim
    const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 0
    s.last = now
    s.t += dt
    const t = s.t
    if (!box.width) measure()
    const stage = { width: box.width, height: box.height }
    const floating = s.shutAt < 0
    const spots = opts.ring()
    if (spots.some((spot) => spot.opened)) s.opened = true
    const takes = [...s.takes.entries()]

    // the cover: held, it trails the finger; let go short, it swings back open; past the point it falls shut by
    // itself, faster and faster, and waits just short of shut until the last piece is in
    if (floating) {
      const lastIn = s.finishing ? Math.max(0, ...takes.map(([, piece]) => piece.at + FLIGHT)) : 0
      Object.assign(s, coverStep(s, dt, t, lastIn))
    }
    const landing = floating && s.finishing && s.cov >= 1 && s.thudAt < 0
    if (landing) {
      s.thudAt = t
      navigator.vibrate?.([12, 30, 20])
      if (!s.still) els.book.classList.add("is-shimmering")
    }

    // where the book is, and how far closed its cover is drawn
    const { bookIn, grown, peek, closed, dip, ghost } = poseAt(s, t)
    const book = bookAt({ stage, bookIn, peek, cov: s.cov, shut: !floating, grown, dip })
    s.book = book
    if (landing) s.thudBook = book

    // every piece the cover's edge sweeps past drops through the middle of the screen into its cell
    if (floating && !s.finishing && s.cov > 0.04) {
      for (const spot of spots) if (!s.takes.has(spot.index) && sweeps(spot.cx, book, s.cov)) take(spot.index, t)
    }
    // a claim that came in after the finish began goes in too
    if (s.finishing && floating) for (let index = 0; index < art.length; index++) if (!s.takes.has(index)) take(index, t)
    for (const [index, piece] of s.takes) if (!piece.started && t >= piece.at) start(index, piece)
    // where each piece the Pocket holds would be in the scene: its way home
    const homes = new Map(spots.filter((spot) => spot.taken).map((spot) => [spot.index, spot]))

    const midX = stage.width / 2
    const flying: Drawn[] = []
    for (const [index, piece] of [...s.takes]) {
      if (!piece.started) continue
      // on its way home: the way it came, backwards, out of its cell
      const going = piece.back >= 0
      if (piece.landed && !going) continue
      const sprite = els.sprites[index]
      const u = progress(piece, t, s.still)
      const flight = piece.flight
      if (going && t >= piece.back && piece.landed) {
        // out of its cell: the cell is empty now, the flight draws it
        piece.landed = false
        cells(emptyCell(s.filled, piece.order, index))
      }
      if (going && u <= 0) {
        home(index, piece)
        continue
      }
      if (!going && u >= 1) {
        land(piece)
        if (sprite) sprite.style.opacity = "0"
        continue
      }
      if (!flight) continue
      if (going && t < piece.back) continue
      const cell = cellAt(piece.order, count, book, closed)
      const back = going ? homes.get(index) : undefined
      const from = back ? { x: back.cx - box.left, y: back.cy - box.top } : flight.from
      const { at, k } = flightAt(from, cell, midX, u)
      const drawn = {
        index,
        flight,
        at,
        scale: lerp(1, cell.side / flight.art, k),
        rotate: flight.rotation * (1 - k),
        u,
        going,
        open: going && piece.openIn,
      }
      flying.push(drawn)
      if (sprite) {
        const shelled = !flight.pinned && !flight.opened && !drawn.open && !!shells?.has(art[index]?.image ?? "")
        sprite.style.transform = `translate(${at.x - flight.from.x}px, ${at.y - flight.from.y}px) rotate(${drawn.rotate}deg) scale(${drawn.scale})`
        sprite.style.opacity = shelled ? "0" : going ? "1" : String(1 - seg(u, 0.9, 1))
      }
    }

    // shut: the thud has rung out and every piece is in
    const allIn = s.takes.size >= count && takes.every(([, piece]) => piece.landed)
    if (floating && s.thudAt >= 0 && t >= s.thudAt + (s.still ? 0 : SHUT_AFTER) && allIn) {
      s.shutAt = t
      s.cov = 1
      s.confetti = s.still ? [] : confettiFor(CONFETTI)
      opts.onShut()
    }

    // the book, and its cover turned like a page lifting
    const look = coverLook(closed, s.grab !== null)
    els.book.style.transform = `translate(${book.sx}px, ${book.sy - BOOK.height / 2}px) scale(${book.sc})`
    els.book.style.setProperty("--shadow", look.shadow)
    els.book.style.setProperty("--shadow-w", look.shadowWidth)
    els.cover.style.transform = look.transform
    els.cover.style.setProperty("--light", look.light)
    els.cover.style.setProperty("--shade-in", look.shadeIn)
    els.cover.style.setProperty("--shade-out", look.shadeOut)
    els.inner.style.visibility = look.inside ? "visible" : "hidden"
    els.outer.style.visibility = look.inside ? "hidden" : "visible"
    // past the point, a gold edge on the cover, so you know it will shut
    els.edge.style.opacity = floating && s.grab !== null && s.cov >= CLAIM_AT ? "0.9" : "0"
    // the pieces go INTO the book: under the cover where it lies over the page, never over it
    if (floating && look.cs < 0) els.flights.style.clipPath = flightsClip(book, stage, look)
    else if (els.flights.style.clipPath) els.flights.style.clipPath = ""

    const reported = floating ? s.cov : 1
    if (Math.abs(reported - s.said) > 0.002) {
      s.said = reported
      opts.onCover(reported)
    }

    paintPocketFx(els.fx, stage, t, book, ghost, s)

    if (shells) {
      const renderer = shells
      const entries = flying.flatMap(({ index, flight, at, scale, rotate, u, going, open }) => {
        const src = art[index]?.image
        if (!src || flight.pinned || flight.opened || open || !renderer.has(src)) return []
        return [
          {
            id: String(index),
            url: src,
            material: materialFor(src, !!art[index]?.rare),
            phase: wrappingPhase(index),
            brk: 0,
            hit: [0.5, 0.5] as const,
            moving: true,
            place: {
              cx: at.x,
              cy: at.y,
              size: (flight.art / BASE.fit) * scale,
              rotation: rotate,
              opacity: going ? 1 : 1 - seg(u, 0.9, 1),
            },
          },
        ]
      })
      renderer.draw(entries, now)
    }
  }

  // the shells the wrapped pieces fly in: one renderer for the life of the Pocket, for the pieces it starts with
  const shellsCanvas = els.shells
  if (shellsCanvas && wrappingExpected()) {
    const first = art
    void import("../wrapping/renderer").then(({ WrappingRenderer: Renderer }) => {
      if (disposed) return
      try {
        shells = new Renderer(shellsCanvas)
      } catch {
        return
      }
      for (const { image } of first) {
        if (!image) continue
        void ensureFields(image)
          .then((entry) => {
            if (!disposed) shells?.upload(image, entry, entry.image)
          })
          .catch(() => {})
      }
    })
  }

  return {
    step,
    run() {
      if (disposed || frame) return
      const loop = (now: number) => {
        step(now)
        frame = requestAnimationFrame(loop)
      }
      frame = requestAnimationFrame(loop)
    },
    setPieces(pieces) {
      art = pieces
      if (pieces.length !== count) {
        count = pieces.length
        order = cellOrder(count)
      }
    },
    press(at, pointer) {
      if (sim.grab !== null || sim.finishing || sim.shutAt >= 0 || !sim.book) return false
      if (onPiece(at) || !grabs(at, sim.book)) return false
      sim.grab = pointer
      sim.covTarget = coverFor(at.x, sim.book)
      return true
    },
    move(pointer, x) {
      if (sim.grab !== pointer || !sim.book) return
      sim.covTarget = coverFor(x, sim.book)
    },
    release(pointer) {
      if (sim.grab === pointer) letGo()
    },
    holding: () => sim.grab !== null,
    finish,
    destroy() {
      disposed = true
      cancelAnimationFrame(frame)
      frame = 0
      observer?.disconnect()
      shells?.dispose()
      shells = null
    },
  }
}
