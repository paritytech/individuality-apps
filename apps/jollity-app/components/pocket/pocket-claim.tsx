// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/* eslint-disable @next/next/no-img-element -- gateway collectable art and a static cover asset */

/**
 * The chest's way into the Pocket: an open book at the foot of the screen. Drag the book's cover across to close
 * it: every piece its edge sweeps past drops through the middle of the screen into its cell, and let go past CLAIM_AT the cover shuts by itself on the rest and lands with a thud. The book then grows
 * into the middle of the screen under "Added to your Pocket", everything fades, and the chest goes on by itself;
 * only a hand-off the host refused puts up a Continue.
 *
 * The geometry is lib/pocket/book and the motion lib/pocket/motion. A press on the book grabs the cover unless it
 * lands on a piece, which stays the scene's to look at. A piece the Pocket takes leaves the scene (`onTake`) and is
 * the Pocket's to draw from then on: one still wrapped flies in its shell from where the scene drew it, an opened
 * one as the flat art that carries `data-chest-piece`. The puff, the ghost finger and the confetti are
 * drawn on one canvas over the book (lib/pocket/fx.ts), and only while there is something to draw.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react"
import { asset } from "@/lib/asset"
import { Button } from "@/components/ui/button"
import { orbTint, type PieceSpot } from "@/components/chest/chest-scene"
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
  onCover as cellsOnCover,
  seg,
  smooth,
  sweeps,
  type Book,
  type Point,
} from "@/lib/pocket/book"
import {
  FLIGHT,
  LANDING,
  confettiFor,
  coverFall,
  flightAt,
  follow,
  invitation,
  squash,
  thud,
  type Bit,
} from "@/lib/pocket/motion"
import { paintPocketFx } from "@/lib/pocket/fx"
import { wrappingExpected } from "@/lib/wrapping/availability"
import { ensureFields } from "@/lib/wrapping/fieldCache"
import { BASE, materialFor, wrappingPhase } from "@/lib/wrapping/materials"
import type { WrappingRenderer } from "@/lib/wrapping/renderer"

/** the book comes up from below between these, s after the pieces began to float */
const BOOK_IN_FROM = 1.2
const BOOK_IN_TO = 1.9
/** how far up the book peeks at rest, of the way from peeking to fully up (lib/pocket/book openY) */
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
/** the falling cover lands this long before the last piece is in, s */
const LAND_EARLY = 0.04
/** the cover lies still this long after the thud before the book grows, s */
const SHUT_AFTER = 0.5
/** after the book is shut: it grows into the middle between these, s */
const GROW_FROM = 0.05
const GROW_TO = 1
const CONFETTI = 46
/** after the book is shut: everything fades, ms, and the chest goes on */
const FADE_AT_MS = 2550
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

interface Flight {
  from: Point
  /** the art's side as it left the scene, px */
  art: number
  rotation: number
  pinned: HTMLImageElement | null
  opened: boolean
}

interface Take {
  /** when it leaves the scene, s */
  at: number
  /** its place in the order the cells fill (lib/pocket/book cellOrder) */
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

export interface PocketPiece {
  image: string
  rare: boolean
  /** its rarity tier, whose colour (the scene's orb tint) is its landing */
  tier?: string
}

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches

/** the book's furniture fades out, then the chest goes on */
function fadeAndGo(shownEls: HTMLDivElement[], onDone: () => void) {
  const shown = shownEls.filter(Boolean)
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

export function PocketClaim({
  surface,
  pieces,
  ring,
  onTake,
  onReturn,
  onCover,
  hidden,
  claimed,
  refusals,
  onClaim,
  onDone,
}: {
  surface: RefObject<HTMLElement | null>
  pieces: PocketPiece[]
  ring: RefObject<PieceSpot[]>
  /** a piece left the scene for the Pocket, which draws it from now on */
  onTake: (index: number) => void
  /** a piece the Pocket gave back (the book left open): the scene draws it again, opened if it was opened in the book */
  onReturn?: (index: number, opened: boolean) => void
  /** how far the cover has closed, 0 to 1, as it moves */
  onCover?: (closed: number) => void
  hidden: boolean
  claimed: boolean
  refusals: number
  onClaim: () => void
  onDone: () => void
}) {
  const [shut, setShut] = useState(false)
  // the pieces in the order they were taken (the n-th fills cellOrder's n-th
  // cell), and how many have landed
  const [filled, setFilled] = useState<number[]>([])
  const [landed, setLanded] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<HTMLDivElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const edgeRef = useRef<HTMLElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const flightsRef = useRef<HTMLDivElement>(null)
  const shellsRef = useRef<HTMLCanvasElement>(null)
  const shownRef = useRef<HTMLDivElement[]>([])
  const slotRefs = useRef<(HTMLDivElement | null)[]>([])
  const spriteRefs = useRef<(HTMLImageElement | null)[]>([])
  const renderer = useRef<WrappingRenderer | null>(null)
  const callbacks = useRef({ onClaim, onDone, onTake, onCover, onReturn })
  const hiddenRef = useRef(hidden)
  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])
  const sim = useRef({
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
    still: false,
  })

  useEffect(() => {
    callbacks.current = { onClaim, onDone, onTake, onCover, onReturn }
  }, [onClaim, onDone, onTake, onCover, onReturn])

  const art = pieces
    .slice(0, 10)
    .map((piece, index) => ({ ...piece, index, tint: orbTint(piece) }))
  const count = art.length
  const half = cellsOnCover(count)
  const order = cellOrder(count)

  const onPiece = (at: Point) =>
    (ring.current ?? []).some(
      (spot) =>
        !sim.current.takes.has(spot.index) &&
        Math.hypot(spot.cx - at.x, spot.cy - at.y) <= spot.size * PIECE_HIT,
    )

  const fromPin = (index: number, box: DOMRect): Flight | null => {
    const pinned = surface.current?.querySelector<HTMLImageElement>(
      `img[data-chest-piece="${index}"]`,
    )
    if (!pinned) return null
    const rect = pinned.getBoundingClientRect()
    if (rect.width === 0) return null
    const style = getComputedStyle(pinned)
    const padding =
      parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    return {
      from: {
        x: rect.left - box.left + rect.width / 2,
        y: rect.top - box.top + rect.height / 2,
      },
      art: Math.max(1, rect.width - padding),
      rotation: 0,
      pinned,
      opened: true,
    }
  }

  const fromRing = (index: number, box: DOMRect): Flight | null => {
    const spot = ring.current?.find((s) => s.index === index)
    if (!spot) return null
    return {
      from: { x: spot.cx - box.left, y: spot.cy - box.top },
      art: spot.size * BASE.fit,
      rotation: spot.rotation,
      pinned: null,
      opened: spot.opened,
    }
  }

  /** queue a piece for the book: it leaves the scene at `at` */
  const take = (index: number, at: number) => {
    const s = sim.current
    if (s.takes.has(index)) return
    s.takes.set(index, {
      at,
      order: s.taken++,
      flight: null,
      started: false,
      landed: false,
      back: -1,
      openIn: false,
    })
  }

  /** it leaves the scene: from here on the Pocket draws it, from where the scene last did */
  const start = (index: number, piece: Take) => {
    piece.started = true
    const box = rootRef.current!.getBoundingClientRect()
    const flight = fromPin(index, box) ?? fromRing(index, box)
    piece.flight = flight
    const sprite = spriteRefs.current[index]
    if (flight && sprite) {
      Object.assign(sprite.style, {
        left: `${flight.from.x - flight.art / 2}px`,
        top: `${flight.from.y - flight.art / 2}px`,
        width: `${flight.art}px`,
        height: `${flight.art}px`,
      })
    }
    if (flight?.pinned) flight.pinned.style.visibility = "hidden"
    setFilled((was) => {
      const next = [...was]
      next[piece.order] = index
      return next
    })
    callbacks.current.onTake(index)
  }

  /** it is in its cell: a squash, and a breath of its colour */
  const land = (piece: Take) => {
    const s = sim.current
    piece.landed = true
    setLanded((was) => Math.max(was, piece.order + 1))
    navigator.vibrate?.(8)
    const slot = slotRefs.current[order[piece.order] ?? -1]
    if (!slot || s.still) return
    slot
      .querySelector("img")
      ?.animate(SQUASH_FRAMES, { duration: LANDING * 1000 })
    slot
      .querySelector(".pocket-cell-glow")
      ?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: LANDING * 1000 })
    slot
      .querySelector(".pocket-cell-ring")
      ?.animate([{ opacity: 0.6 }, { opacity: 0 }], {
        duration: LANDING * 1000,
      })
  }

  /** past the point (or the screen's word): every piece left goes in, and the cover falls shut */
  const finish = (fromPlayer: boolean) => {
    const s = sim.current
    if (s.finishing || s.shutAt >= 0) return
    s.finishing = true
    s.grab = null
    // one on its way home turns round: it goes in from where the scene has it
    for (const [index, piece] of s.takes)
      if (piece.back >= 0) home(index, piece)
    let k = 0
    for (const { index } of art)
      take(index, s.t + (s.still ? 0 : FINISH_STAGGER * k++))
    if (fromPlayer) callbacks.current.onClaim()
  }

  /* LET GO SHORT, the book stays open: nothing the cover took is kept. Each
     piece flies back out of its cell to where the scene floats it, the last
     taken first, and is the scene's again when it gets there; one still
     queued never left */
  const giveBack = () => {
    const s = sim.current
    const out = [...s.takes.entries()]
      .filter(([, piece]) => piece.back < 0)
      .sort(([, a], [, b]) => b.order - a.order)
    let k = 0
    for (const [index, piece] of out) {
      if (!piece.started) {
        s.takes.delete(index)
        continue
      }
      piece.back = s.t + (s.still ? 0 : BACK_STAGGER * k++)
      piece.openIn = piece.landed
    }
  }
  /** home: the scene has it again */
  const home = (index: number, piece: Take) => {
    const s = sim.current
    s.takes.delete(index)
    if (piece.flight?.pinned) piece.flight.pinned.style.visibility = ""
    const sprite = spriteRefs.current[index]
    if (sprite) sprite.style.opacity = "0"
    setFilled((was) => {
      const next = [...was]
      if (next[piece.order] === index) delete next[piece.order]
      return next
    })
    callbacks.current.onReturn?.(index, piece.openIn)
    // all home: the cells fill from the first again
    if (!s.takes.size && !s.finishing) {
      s.taken = 0
      setFilled([])
      setLanded(0)
    }
  }

  const letGo = () => {
    const s = sim.current
    if (s.grab === null) return
    s.grab = null
    if (claims(s.cov)) finish(true)
    else giveBack()
  }

  // the Pocket's box (it is the whole screen): measured when it changes size, not read every frame
  const boxRef = useRef({ left: 0, top: 0, width: 0, height: 0 })
  const measureBox = () => {
    const root = rootRef.current
    if (!root) return
    const r = root.getBoundingClientRect()
    boxRef.current = {
      left: r.left,
      top: r.top,
      width: root.clientWidth,
      height: root.clientHeight,
    }
  }

  const step = (now: number) => {
    const s = sim.current
    const root = rootRef.current
    const bookEl = bookRef.current
    const coverEl = coverRef.current
    if (!root || !bookEl || !coverEl) return
    const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 0
    s.last = now
    s.t += dt
    const t = s.t
    if (!boxRef.current.width) measureBox()
    const stage = {
      width: boxRef.current.width,
      height: boxRef.current.height,
    }
    const floating = s.shutAt < 0
    const spots = ring.current ?? []
    if (spots.some((spot) => spot.opened)) s.opened = true
    const takes = [...s.takes.entries()]

    // the cover: held, it trails the finger; let go short, it swings back
    // open; past the point it falls shut by itself, faster and faster, and
    // waits just short of shut until the last piece is in
    if (floating) {
      if (s.finishing) {
        const lastIn = Math.max(
          0,
          ...takes.map(([, piece]) => piece.at + FLIGHT),
        )
        if (s.still) s.cov = 1
        else
          ({ cov: s.cov, v: s.covV } = coverFall(
            { cov: s.cov, v: s.covV },
            dt,
            t < lastIn - LAND_EARLY,
          ))
      } else {
        const held = s.grab !== null
        s.cov = follow(
          s.cov,
          held ? s.covTarget : 0,
          held ? HELD_RATE : OPEN_RATE,
          dt,
        )
        s.covV = 0
      }
      s.lift = follow(
        s.lift,
        s.grab !== null || s.finishing || s.cov > 0.02 ? 1 : 0,
        LIFT_RATE,
        dt,
      )
    }
    const landing = floating && s.finishing && s.cov >= 1 && s.thudAt < 0
    if (landing) {
      s.thudAt = t
      navigator.vibrate?.([12, 30, 20])
      if (!s.still) bookEl.classList.add("is-shimmering")
    }

    // where the book is, and how far closed its cover is drawn
    const bookIn = floating ? smooth(seg(t, BOOK_IN_FROM, BOOK_IN_TO)) : 1
    const grown = floating
      ? 0
      : s.still
        ? 1
        : smooth(seg(t, s.shutAt + GROW_FROM, s.shutAt + GROW_TO))
    const peek = floating ? lerp(PEEK_AT, 1, smooth(s.lift)) : 1
    let closed = floating ? s.cov : 1
    let dip = 0
    let ghost: { a: number; u: number } | null = null
    // the invitation: every few seconds the cover lifts a little and a finger shows where to take it
    if (
      floating &&
      !s.still &&
      s.grab === null &&
      !s.finishing &&
      s.cov < 0.02 &&
      bookIn > 0.95 &&
      (s.opened || t > LATE)
    ) {
      const invite = invitation(t)
      closed += invite.lift
      ghost = invite.ghost
    }
    if (s.thudAt >= 0 && !s.still) ({ closed, dip } = thud(t - s.thudAt))
    const book = bookAt({
      stage,
      bookIn,
      peek,
      cov: s.cov,
      shut: !floating,
      grown,
      dip,
    })
    s.book = book
    if (landing) s.thudBook = book

    // every piece the cover's edge sweeps past drops through the middle of the screen into its cell
    if (floating && !s.finishing && s.cov > 0.04) {
      for (const spot of spots)
        if (!s.takes.has(spot.index) && sweeps(spot.cx, book, s.cov))
          take(spot.index, t)
    }
    // a claim that came in after the finish began goes in too
    if (s.finishing && floating)
      for (const { index } of art) if (!s.takes.has(index)) take(index, t)
    for (const [index, piece] of s.takes)
      if (!piece.started && t >= piece.at) start(index, piece)
    // where each piece the Pocket holds would be in the scene: its way home
    const homes = new Map(
      spots.filter((spot) => spot.taken).map((spot) => [spot.index, spot]),
    )

    const midX = stage.width / 2
    const rootBox = boxRef.current
    const flying: Drawn[] = []
    for (const [index, piece] of [...s.takes]) {
      if (!piece.started) continue
      // on its way home: the way it came, backwards, out of its cell
      const going = piece.back >= 0
      if (piece.landed && !going) continue
      const sprite = spriteRefs.current[index]
      const u = going
        ? 1 - (s.still ? 1 : seg(t, piece.back, piece.back + FLIGHT))
        : s.still
          ? 1
          : seg(t, piece.at, piece.at + FLIGHT)
      const flight = piece.flight
      if (going && t >= piece.back && piece.landed) {
        // out of its cell: the cell is empty now, the flight draws it
        piece.landed = false
        setFilled((was) => {
          const next = [...was]
          if (next[piece.order] === index) delete next[piece.order]
          return next
        })
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
      const from = back
        ? { x: back.cx - rootBox.left, y: back.cy - rootBox.top }
        : flight.from
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
        const shelled =
          !flight.pinned &&
          !flight.opened &&
          !drawn.open &&
          !!renderer.current?.has(art[index]?.image ?? "")
        sprite.style.transform = `translate(${at.x - flight.from.x}px, ${at.y - flight.from.y}px) rotate(${drawn.rotate}deg) scale(${drawn.scale})`
        sprite.style.opacity = shelled
          ? "0"
          : going
            ? "1"
            : String(1 - seg(u, 0.9, 1))
      }
    }

    // shut: the thud has rung out and every piece is in
    const allIn =
      s.takes.size >= count && takes.every(([, piece]) => piece.landed)
    if (
      floating &&
      s.thudAt >= 0 &&
      t >= s.thudAt + (s.still ? 0 : SHUT_AFTER) &&
      allIn
    ) {
      s.shutAt = t
      s.cov = 1
      s.confetti = s.still ? [] : confettiFor(CONFETTI)
      setShut(true)
    }

    // the book and its cover, turned like a page lifting: it comes toward
    // you as it stands, lifts off the table at its free edge, catches the
    // light near upright, and shades the page as it comes down onto it
    const turned = clamp01(closed)
    const sn = Math.sin(Math.PI * turned)
    const cs = Math.cos(Math.PI * turned)
    const lift = (COVER_LIFT + (s.grab !== null ? HELD_LIFT : 0)) * sn
    bookEl.style.transform = `translate(${book.sx}px, ${book.sy - BOOK.height / 2}px) scale(${book.sc})`
    bookEl.style.setProperty(
      "--shadow",
      cs < 0 ? (clamp01(-cs * 1.6) * 0.5 * (1 - sn * 0.4)).toFixed(3) : "0",
    )
    bookEl.style.setProperty(
      "--shadow-w",
      `${(BOOK.width * Math.max(0, -cs) + 24 * sn).toFixed(1)}px`,
    )
    coverEl.style.transform = `perspective(${COVER_DEPTH}px) rotateY(${((turned - 1) * 180).toFixed(2)}deg) skewY(${(-Math.atan(lift / BOOK.width)).toFixed(4)}rad)`
    coverEl.style.setProperty("--light", (0.22 * sn ** 3).toFixed(3))
    coverEl.style.setProperty("--shade-in", (0.28 * sn).toFixed(3))
    coverEl.style.setProperty("--shade-out", (0.22 * sn).toFixed(3))
    innerRef.current!.style.visibility = cs > 0 ? "visible" : "hidden"
    outerRef.current!.style.visibility = cs > 0 ? "hidden" : "visible"
    // past the point, a gold edge on the cover, so you know it will shut
    edgeRef.current!.style.opacity =
      floating && s.grab !== null && s.cov >= CLAIM_AT ? "0.9" : "0"
    // the pieces go INTO the book: where the cover lies over the page, a piece
    // flying in goes under it (the cover's place is cut out of the flights'
    // layer), never over it to vanish when it lands
    const flightsEl = flightsRef.current!
    if (floating && cs < 0) {
      const x0 = book.sx
      const x1 = book.sx + book.pw * -cs + 2
      const half = (book.ph / 2) * (1 + COVER_TOWARD * sn) + lift * book.sc + 4
      const y0 = book.sy - half
      const y1 = book.sy + half
      flightsEl.style.clipPath = `path(evenodd, "M0 0H${stage.width}V${stage.height}H0Z M${x0.toFixed(1)} ${y0.toFixed(1)}H${x1.toFixed(1)}V${y1.toFixed(1)}H${x0.toFixed(1)}Z")`
    } else if (flightsEl.style.clipPath) flightsEl.style.clipPath = ""

    const reported = floating ? s.cov : 1
    if (Math.abs(reported - s.said) > 0.002) {
      s.said = reported
      callbacks.current.onCover?.(reported)
    }

    paintPocketFx(fxRef.current, stage, t, book, ghost, sim.current)

    const shells = renderer.current
    if (shells) {
      const entries = flying.flatMap(
        ({ index, flight, at, scale, rotate, u, going, open }) => {
          const src = art[index]?.image
          if (
            !src ||
            flight.pinned ||
            flight.opened ||
            open ||
            !shells.has(src)
          )
            return []
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
        },
      )
      shells.draw(entries, now)
    }
  }

  const handlers = useRef({ step, finish, letGo, onPiece })
  useEffect(() => {
    handlers.current = { step, finish, letGo, onPiece }
  })

  // the box again whenever the Pocket changes size
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      const r = root.getBoundingClientRect()
      boxRef.current = {
        left: r.left,
        top: r.top,
        width: root.clientWidth,
        height: root.clientHeight,
      }
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    sim.current.still = reducedMotion()
    let frameId = 0
    const loop = (now: number) => {
      handlers.current.step(now)
      frameId = requestAnimationFrame(loop)
    }
    frameId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frameId)
  }, [])

  useEffect(() => {
    if (claimed) handlers.current.finish(false)
  }, [claimed])

  useEffect(() => {
    const canvas = shellsRef.current
    if (!canvas || !wrappingExpected()) return
    let disposed = false
    void import("@/lib/wrapping/renderer").then(
      ({ WrappingRenderer: Renderer }) => {
        if (disposed) return
        try {
          renderer.current = new Renderer(canvas)
        } catch {
          return
        }
        for (const { image } of art) {
          if (!image) continue
          void ensureFields(image)
            .then((entry) => {
              if (!disposed)
                renderer.current?.upload(image, entry, entry.image)
            })
            .catch(() => {})
        }
      },
    )
    return () => {
      disposed = true
      renderer.current?.dispose()
      renderer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one renderer for the life of the Pocket
  }, [])

  // a press on the book grabs the cover, unless it lands on a piece; the
  // scene never hears a press the cover took
  useEffect(() => {
    const area = surface.current
    if (!area) return

    const onDown = (event: PointerEvent) => {
      const s = sim.current
      if (
        hiddenRef.current ||
        s.grab !== null ||
        s.finishing ||
        s.shutAt >= 0 ||
        !s.book
      )
        return
      if ((event.target as Element | null)?.closest("button, a, [role=button]"))
        return
      const at = { x: event.clientX, y: event.clientY }
      if (handlers.current.onPiece(at) || !grabs(at, s.book)) return
      event.stopPropagation()
      s.grab = event.pointerId
      s.covTarget = coverFor(at.x, s.book)
    }

    const onMove = (event: PointerEvent) => {
      const s = sim.current
      if (s.grab !== event.pointerId || !s.book) return
      s.covTarget = coverFor(event.clientX, s.book)
    }

    const onUp = (event: PointerEvent) => {
      if (sim.current.grab === event.pointerId) handlers.current.letGo()
    }

    const onTouchMove = (event: TouchEvent) => {
      if (sim.current.grab !== null && event.cancelable) event.preventDefault()
    }

    area.addEventListener("pointerdown", onDown, { capture: true })
    area.addEventListener("touchmove", onTouchMove, { passive: false })
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      area.removeEventListener("pointerdown", onDown, { capture: true })
      area.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
  }, [surface])

  useEffect(() => {
    if (refusals === 0) return
    for (const el of shownRef.current)
      el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: FADE_MS,
        easing: "ease-out",
        fill: "forwards",
      })
  }, [refusals])

  const leave = () => fadeAndGo(shownRef.current, callbacks.current.onDone)

  // the book shut: on by itself once it has had its moment, no Continue to
  // press. A hand-off the host refused (`refusals`) puts the Continue up
  // instead, so there is one to press
  useEffect(() => {
    if (!shut || refusals > 0) return
    const timer = setTimeout(
      () => fadeAndGo(shownRef.current, callbacks.current.onDone),
      FADE_AT_MS,
    )
    return () => clearTimeout(timer)
  }, [shut, refusals])

  const pieceAt = (place: number) => {
    const index = filled[place]
    return index === undefined ? undefined : art[index]
  }

  const cell = (j: number) => {
    const place = order.indexOf(j)
    const piece = pieceAt(place)
    return (
      <div
        key={j}
        ref={(el) => {
          slotRefs.current[j] = el
        }}
        className="pocket-cell"
        data-landed={place >= 0 && place < landed ? "" : undefined}
        style={piece ? ({ "--tint": piece.tint } as CSSProperties) : undefined}
      >
        <i className="pocket-cell-glow" />
        <i className="pocket-cell-ring" />
        {piece?.image ? (
          <img src={piece.image} alt="" draggable={false} decoding="async" />
        ) : null}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`pocket-claim${shut ? " is-shut" : ""}${hidden ? " is-hidden" : ""}`}
      data-testid="pocket-claim"
      data-shut={shut ? "true" : "false"}
    >
      <div
        ref={(el) => {
          if (el) shownRef.current[0] = el
        }}
        aria-hidden="true"
      >
        <div ref={bookRef} className="pocket-book">
          <div className="pocket-book-page">
            <div className="pocket-book-grid">
              {art.slice(half).map((_, k) => cell(half + k))}
            </div>
            <i className="pocket-book-shadow" />
          </div>
          <div ref={coverRef} className="pocket-book-cover">
            <div
              ref={innerRef}
              className="pocket-book-face pocket-book-face--inner"
            >
              <div className="pocket-book-grid">
                {art.slice(0, half).map((_, k) => cell(k))}
              </div>
              <i className="pocket-book-light" />
              <i className="pocket-book-shade" />
            </div>
            <div
              ref={outerRef}
              className="pocket-book-face pocket-book-face--outer"
            >
              <img
                src={asset("/assets/album-cover.webp")}
                alt=""
                draggable={false}
              />
              <i className="pocket-book-light" />
              <i className="pocket-book-shade" />
            </div>
            <i ref={edgeRef} className="pocket-book-edge" />
          </div>
        </div>
      </div>
      <div ref={flightsRef} className="pocket-flights">
        <canvas ref={fxRef} className="pocket-fx" aria-hidden="true" />
        {art.map(({ image }, k) =>
          image ? (
            <img
              key={k}
              ref={(el) => {
                spriteRefs.current[k] = el
              }}
              className="pocket-flight"
              src={image}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
          ) : null,
        )}
        <canvas ref={shellsRef} className="pocket-shells" aria-hidden="true" />
      </div>
      <div
        ref={(el) => {
          if (el) shownRef.current[1] = el
        }}
      >
        <h1 className="pocket-title" aria-hidden={!shut}>
          Added to your Pocket
        </h1>
      </div>
      {shut && refusals > 0 ? (
        <div
          ref={(el) => {
            if (el) shownRef.current[2] = el
          }}
          className="pocket-foot"
        >
          <Button size="lg" className="w-full max-w-sm" onClick={leave}>
            Continue
          </Button>
        </div>
      ) : shut ? null : (
        <button
          type="button"
          className="pocket-claim-without-gesture"
          onClick={() => handlers.current.finish(true)}
        >
          Claim all
        </button>
      )}
    </div>
  )
}
