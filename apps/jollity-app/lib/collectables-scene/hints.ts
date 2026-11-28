// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE HINTS: what the collectables screen shows a player who has gone still,
 * in place of words. A ghost finger (./finger), the Pocket's own look, taps
 * where the next thing is: the bubble once a tap can open it, a wrapped piece,
 * the piece zoomed in on, an opened one (its collection swaps). One lesson at a
 * time, only after the player has been still a while, a few times at most, and
 * never again once they have done it. The words at the top come back only as a
 * fallback, after a long stillness (HINT.fallbackMs).
 *
 * The book's finger and this one take turns rather than both playing: the
 * book waits for INVITE_LATE before anything is opened (the look hint plays
 * only before it), and for INVITE_AFTER_OPEN after the first piece is opened
 * (the swap hint plays only inside it). Zoomed in, the book is hidden.
 *
 * Not a state machine (AGENTS.md, the house rule 1 and 7): the stages the
 * hints follow are the scene's own (the bubble, the float, a zoom, an opened
 * piece), which the collectables screen's reducer and the engine already hold.
 * What is left is a pure decision (nextHint, pickTarget, hintWords) over a
 * spacing guard and per-lesson latches, tested directly and by property. The
 * host (armHints) is framework-free (architecture rule 6): the component says
 * what the screen shows, forwards the engine's events, and renders the finger.
 */
import { INVITE_AFTER_OPEN, INVITE_LATE } from "@/lib/pocket/motion"
import { FINGER_MS, type Finger } from "./finger"

export type HintKind = "bubble" | "look" | "unwrap" | "swap"

export const HINT = {
  /** still this long before a hint plays, ms */
  idleMs: 2600,
  /** zoomed in on a wrapped piece the next tap is the whole lesson: it comes sooner, ms */
  unwrapIdleMs: 1800,
  /** one hint starts at most this often, ms */
  everyMs: 4600,
  /** how long one hint plays, ms (the finger's own) */
  playMs: FINGER_MS,
  /** the pieces out of the pop take this long to reach their places: a piece is shown only once it is there, ms */
  settleMs: 2000,
  /** a piece that moved less than this between two looks has come to rest, px */
  stillPx: 4,
  /** the screen is looked at this often, ms */
  lookEveryMs: 250,
  /** how many times each lesson is shown, at most */
  plays: { bubble: 3, look: 3, unwrap: 3, swap: 1 } as Record<HintKind, number>,
  /** the words at the top come back after this long without a press, ms */
  fallbackMs: 12_000,
} as const

// ── THE DECISION (pure) ──────────────────────────────────────────────────────

/** what the decision reads of the screen and of the hints so far */
export interface HintState {
  /** ms, any clock the rest of these times share */
  now: number
  /** the last press anywhere on the screen, ms */
  pressedAt: number
  /** when the last hint started, ms (-Infinity: none yet) */
  lastHintAt: number
  /** the bubble is blown, has not popped, and the screen is not opening it anyway */
  bubbleUp: boolean
  /** a tap on the bubble opens it: something has come into it */
  canOpen: boolean
  /** when the pieces began to float (the pop), ms; null before */
  floatingSince: number | null
  /** the pieces have come to rest (a moving piece would carry the target away from the finger) */
  piecesStill: boolean
  /** when the first piece was opened, ms; null before */
  firstOpenedAt: number | null
  /** zoomed in on a piece, and whether that piece is still wrapped */
  zoomed: boolean
  zoomedWrapped: boolean
  /** floating pieces the player can still unwrap, and the opened ones */
  wrapped: number
  opened: number
  /** lessons the player has done themselves */
  learned: ReadonlySet<HintKind>
  /** how many times each has been shown */
  shown: Readonly<Partial<Record<HintKind, number>>>
}

const left = (s: HintState, kind: HintKind) => !s.learned.has(kind) && (s.shown[kind] ?? 0) < HINT.plays[kind]

/** The hint to play now, or null. */
export function nextHint(s: HintState): HintKind | null {
  if (s.now - s.lastHintAt < HINT.everyMs) return null
  const still = s.now - s.pressedAt
  if (s.bubbleUp) return s.canOpen && still >= HINT.idleMs && left(s, "bubble") ? "bubble" : null
  if (s.floatingSince === null) return null
  if (s.zoomed) return s.zoomedWrapped && still >= HINT.unwrapIdleMs && left(s, "unwrap") ? "unwrap" : null
  if (still < HINT.idleMs || !s.piecesStill) return null
  // once something is opened, before the book's finger starts on it
  if (s.opened > 0 && s.firstOpenedAt !== null)
    return s.now - s.firstOpenedAt + HINT.playMs <= INVITE_AFTER_OPEN * 1000 && left(s, "swap") ? "swap" : null
  // nothing opened yet, before the book's finger starts on its own
  const floating = s.now - s.floatingSince
  if (s.wrapped > 0 && floating >= HINT.settleMs && floating + HINT.playMs <= INVITE_LATE * 1000 && left(s, "look")) return "look"
  return null
}

/** How much of the fallback words show, 0–1: none until HINT.fallbackMs without a press, then in over 0.6 s. */
export function fallbackShown(now: number, pressedAt: number): number {
  return Math.max(0, Math.min(1, (now - pressedAt - HINT.fallbackMs) / 600))
}

/** The fallback words at the top, in the order a player meets them, and the line under them. A piece just unwrapped
 *  lets the zoom go as it opens, so there is no line for it. */
export function hintWords(s: { zoomed: boolean; opened: number; late: boolean }): { line: string; sub: string | null } {
  if (s.zoomed) return { line: "Tap again to unwrap it", sub: null }
  if (s.opened > 0) return { line: "Close the book to add them to your Pocket", sub: "Tap one to swap its collection" }
  if (s.late) return { line: "Close the book to add them to your Pocket", sub: null }
  return { line: "Tap a collectable to look closer", sub: null }
}

// ── WHAT IT LOOKS AT, AND WHERE IT TAPS (pure) ───────────────────────────────

/** a piece on the screen (not in the Pocket), canvas px */
export interface HintPiece {
  index: number
  x: number
  y: number
}

/** what the screen shows, as the component reports it each look */
export interface HintLook {
  /** the bubble while it is up and the screen is not opening it anyway; `canOpen`: something has come into it */
  bubble: { canOpen: boolean } | null
  /** when the pieces began to float (the pop), ms; null before */
  floatingSince: number | null
  /** the piece zoomed in on, or -1 */
  focused: number
  pieces: readonly HintPiece[]
  /** the opened pieces, in the order they were opened */
  opened: readonly number[]
  /** the middle of the screen, canvas px */
  middle: { x: number; y: number }
}

export type HintTarget = { kind: "bubble" } | { kind: "piece"; index: number }

/** Every piece is where it was at the last look, within HINT.stillPx (a piece not seen then is not at rest yet). */
export function piecesSettled(before: ReadonlyMap<number, readonly [number, number]>, pieces: readonly HintPiece[]): boolean {
  return (
    pieces.length > 0 &&
    pieces.every((p) => {
      const was = before.get(p.index)
      return was !== undefined && Math.hypot(was[0] - p.x, was[1] - p.y) < HINT.stillPx
    })
  )
}

/** Where `kind` taps: the bubble; the piece zoomed in on; the last one opened that is still out; or the wrapped piece
 *  nearest the middle. Null when there is nothing on the screen to tap. */
export function pickTarget(kind: HintKind, look: HintLook): HintTarget | null {
  const out = (index: number) => look.pieces.some((p) => p.index === index)
  if (kind === "bubble") return look.bubble ? { kind: "bubble" } : null
  if (kind === "unwrap") return look.focused >= 0 && out(look.focused) ? { kind: "piece", index: look.focused } : null
  if (kind === "swap") {
    const last = [...look.opened].reverse().find(out)
    return last === undefined ? null : { kind: "piece", index: last }
  }
  const opened = new Set(look.opened)
  const away = (p: HintPiece) => Math.hypot(p.x - look.middle.x, p.y - look.middle.y)
  const nearest = look.pieces.filter((p) => !opened.has(p.index)).sort((a, b) => away(a) - away(b))[0]
  return nearest ? { kind: "piece", index: nearest.index } : null
}

// ── THE HOST (framework-free) ─────────────────────────────────────────────────

export interface HintsHost {
  /** what the screen shows now; null while no hint may play (the picker is open, the book's cover moves) */
  look(): HintLook | null
  /** the scene's hooks: where the bubble is (canvas px) and its breath, a piece's rock */
  engine(): { bubbleAt(): { x: number; y: number } | null; pulseBubble(): void; nudge(index: number): void } | null
  /** where a piece is drawn now, canvas px, or null */
  piece(index: number): { x: number; y: number } | null
  finger: Finger
  /** the clock the looks are timed by, ms (performance.now) */
  now?: () => number
  log?: (message: string, data?: unknown) => void
}

export interface Hints {
  /** the player did it themselves: never show that lesson again (and stop it, if it is playing) */
  learned(kind: HintKind): void
  /** how much of the fallback words show at `now` */
  fallback(now: number): number
  /** stop looking, and any hint under way */
  stop(): void
}

/** Arm the hints for one showing of the collectables screen. Any press anywhere stops a hint under way and starts the
 *  stillness over. */
export function armHints(host: HintsHost): Hints {
  const now = host.now ?? (() => performance.now())
  let pressedAt = now()
  let lastAt = -Infinity
  let lastKind: HintKind | null = null
  let firstOpenedAt: number | null = null
  let seen = new Map<number, readonly [number, number]>()
  const learned = new Set<HintKind>()
  const shown: Partial<Record<HintKind, number>> = {}

  const onPress = () => {
    pressedAt = now()
    host.finger.stop()
  }
  addEventListener("pointerdown", onPress, { capture: true, passive: true })

  const tick = setInterval(() => {
    const look = host.look()
    if (!look) return
    const at = now()
    if (look.opened.length && firstOpenedAt === null) firstOpenedAt = at
    const still = piecesSettled(seen, look.pieces)
    seen = new Map(look.pieces.map((p) => [p.index, [p.x, p.y] as const]))
    const opened = new Set(look.opened)
    const kind = nextHint({
      now: at,
      pressedAt,
      lastHintAt: lastAt,
      bubbleUp: look.bubble !== null,
      canOpen: look.bubble?.canOpen ?? false,
      floatingSince: look.floatingSince,
      piecesStill: still,
      firstOpenedAt,
      zoomed: look.focused >= 0,
      zoomedWrapped: look.focused >= 0 && !opened.has(look.focused),
      wrapped: look.pieces.filter((p) => !opened.has(p.index)).length,
      opened: look.pieces.filter((p) => opened.has(p.index)).length,
      learned,
      shown,
    })
    const target = kind && pickTarget(kind, look)
    if (!kind || !target) return
    lastAt = at
    lastKind = kind
    shown[kind] = (shown[kind] ?? 0) + 1
    host.log?.(`hint: ${kind}`, { shown: shown[kind] })
    if (target.kind === "bubble") host.finger.play(() => host.engine()?.bubbleAt() ?? null, () => host.engine()?.pulseBubble())
    else host.finger.play(() => host.piece(target.index), () => host.engine()?.nudge(target.index))
  }, HINT.lookEveryMs)

  return {
    learned(kind) {
      learned.add(kind)
      if (lastKind === kind && now() - lastAt < HINT.playMs) host.finger.stop()
    },
    fallback: (at) => fallbackShown(at, pressedAt),
    stop() {
      clearInterval(tick)
      removeEventListener("pointerdown", onPress, { capture: true })
      host.finger.stop()
    },
  }
}
