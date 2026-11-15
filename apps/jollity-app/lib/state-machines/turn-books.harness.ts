// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * An independent harness for the turn-books reducer.
 *
 * It plays the RUNNER's part only: it builds snapshots with the pure game
 * calculator, hands every event to `turnBooks`, and "commits the render"
 * after each one (the world's rendered votes and bans follow the books),
 * the way `useGameSession` mirrors its ref into React state. Video evidence
 * is the evidence machine's job, so the harness writes it with
 * `markVideoRoleSeen`, as the runner does.
 *
 * Nothing here copies the reducer's logic. The expected verdicts come from
 * `expectedVerdicts`, a small model of the settled verdict rules (the list
 * on `expectedVerdict`).
 */
import { calculateSnapshot } from "@jollity/game-chain/game"
import type { GameSnapshot, GameTimingInfo } from "@jollity/game-chain"
import type { ChainClockState, PlayerId } from "../game-source"
import type { Vote } from "../game-session"
import type { StoredVotes } from "../game-votes"
import type { TurnVotes } from "../game-roster"
import { markVideoRoleSeen } from "../video-role-history"
import {
  emptyTurnBooks,
  turnBooks,
  type TurnBooks,
  type TurnBooksEvent,
  type TurnBooksStep,
  type TurnClock,
  type TurnWorld,
} from "../turn-books"

// ---------------------------------------------------------------- the game

export const ME = "me"
/** Two rounds of a four-seat cap. Round 0: [ME, A, B, C]. Round 1: [D, ME, A, E].
 *  The turn's host is seat `turn % 4`; you never judge yourself or the host. */
const SEATS: PlayerId[][] = [
  [ME, "A", "B", "C"],
  ["D", ME, "A", "E"],
]
export const STRIDE = 4
const ROUNDS = 2
const TURN = 12
const GAP = 7
export const GAME_DATE = 100_000
const ROUND_LEN = STRIDE * TURN
const GAME_LEN = ROUNDS * ROUND_LEN + (ROUNDS - 1) * GAP
const REPORT_ENDS = GAME_DATE + GAME_LEN + 120
export const TIMING: GameTimingInfo = { gameDate: GAME_DATE, reportEnds: REPORT_ENDS, rounds: ROUNDS, maxGroupSize: STRIDE }
export const TOTAL_TURNS = ROUNDS * STRIDE

/** the game second `offset` seconds into turn `pos` of `round` */
export const at = (round: number, pos: number, offset = 1): number => GAME_DATE + round * (ROUND_LEN + GAP) + pos * TURN + offset
/** a second inside the gap before round `round` */
export const inGap = (round: number, offset = 2): number => GAME_DATE + round * (ROUND_LEN + GAP) - GAP + offset
export const REPORTING = GAME_DATE + GAME_LEN + 5
export const WAITING = GAME_DATE - 30

const roundOf = (turn: number): number => Math.floor(turn / STRIDE)
const hostOf = (turn: number): PlayerId => SEATS[roundOf(turn)][turn % STRIDE]
/** who turn `turn` lets you judge: the group but its host and you */
export const candidatesOf = (turn: number): PlayerId[] =>
  SEATS[roundOf(turn)].filter((id, seat) => seat !== turn % STRIDE && id !== ME)

/** the open turn of a snapshot, or -1 */
const openTurnOf = (snap: GameSnapshot): number => (snap.kind === "round" ? snap.round * STRIDE + snap.hostPosition : -1)

// ---------------------------------------------------------------- the page

export interface PageOptions {
  /** this device came through the waiting-room door (#532) */
  door?: boolean
  /** the clock state handed to the tick; undefined = a source without one */
  clockState?: ChainClockState
  /** an account is set and its stored read has not answered yet */
  restorePending?: boolean
  /** the render lags the books: the world is committed only on `commit()` */
  lagRender?: boolean
}

/** one mounted /game page: the books, the rendered world, the trail */
export class Page {
  books: TurnBooks = emptyTurnBooks()
  rendered: { banned: ReadonlySet<PlayerId>; votes: TurnVotes } = { banned: new Set(), votes: {} }
  trail: TurnBooksStep[] = []
  stages: string[] = []
  door: boolean
  clockState: ChainClockState | undefined
  restorePending: boolean
  lagRender: boolean
  /** the second of the last tick */
  now = Number.NaN
  frozeNext = false

  constructor(options: PageOptions = {}) {
    this.door = options.door ?? false
    this.clockState = options.clockState ?? { ready: true }
    this.restorePending = options.restorePending ?? false
    this.lagRender = options.lagRender ?? false
  }

  world(): TurnWorld {
    return {
      stride: STRIDE,
      candidates: (round, roundTurn) => candidatesOf(round * STRIDE + roundTurn),
      host: (round, roundTurn) => hostOf(round * STRIDE + roundTurn),
      banned: this.rendered.banned,
      renderedVotes: this.rendered.votes,
    }
  }

  /** the render commits: the world reads the books as they are now */
  commit(): void {
    this.rendered = { banned: this.books.banned, votes: this.books.turnVotes }
  }

  send(event: TurnBooksEvent): ReturnType<typeof turnBooks> {
    const result = turnBooks(this.books, event, this.world())
    this.books = result.books
    this.trail.push(...result.trail)
    if (result.stage) this.stages.push(result.stage)
    if (!this.lagRender) this.commit()
    return result
  }

  clock(): TurnClock {
    const froze = this.frozeNext
    this.frozeNext = false
    return {
      timing: TIMING,
      state: this.clockState,
      restorePending: this.restorePending,
      frozeAway: froze,
      chainSeen: () => this.clockState?.ready ?? true,
      viaDoor: () => this.door,
    }
  }

  tick(second: number): ReturnType<typeof turnBooks> {
    this.now = second
    return this.send({ kind: "tick", snapshot: calculateSnapshot(second, TIMING), clock: this.clock() })
  }

  /** the turn on screen, or -1 */
  open(): number {
    return Number.isNaN(this.now) ? -1 : openTurnOf(calculateSnapshot(this.now, TIMING))
  }

  tap(id: PlayerId, verdict: Vote, turn = this.open(), source: "player" | "ban" = "player"): void {
    if (turn < 0) throw new Error("tap with no open turn")
    this.send({ kind: "tap", turn, round: roundOf(turn), id, verdict, source })
  }

  /** the ban is two calls in the runner: the ban, then this turn's reject as a tap */
  ban(id: PlayerId): void {
    this.send({ kind: "ban", id })
    const turn = this.open()
    if (turn >= 0) this.tap(id, "notperson", turn, "ban")
  }

  unban(id: PlayerId): void {
    const turn = this.open()
    const open = turn >= 0 ? { turn, round: roundOf(turn), roundTurn: turn % STRIDE } : undefined
    this.send({ kind: "unban", id, open })
  }

  /** a decoded frame (the evidence machine's write). `fromTurn` defaults to the turn on screen. */
  see(id: PlayerId, fromTurn: number | null = this.open()): void {
    this.books = { ...this.books, videoRoleHistory: markVideoRoleSeen(this.books.videoRoleHistory, id, fromTurn).history }
  }

  restore(stored: StoredVotes | null, released: boolean): void {
    this.send({ kind: "restore", stored, released })
    this.restorePending = false
    // the runner tops up once the merged books have rendered
    this.commit()
    if (this.books.topUpTurns.length > 0) this.send({ kind: "top-up" })
  }

  topUp(): void {
    this.commit()
    this.send({ kind: "top-up" })
  }

  /** what the save effect writes for this page */
  save(gameIndex = 7, account = "acct"): StoredVotes {
    return {
      gameIndex,
      account,
      turnVotes: this.books.turnVotes,
      banned: [...this.books.banned],
      overrides: {},
      autoSeals: this.books.autoSeals,
      banVotes: this.books.banVotes,
      firstOpenedTurn: this.books.firstOpenedTurn,
      videoRoleHistory: this.books.videoRoleHistory,
    }
  }

  verdict(turn: number, id: PlayerId): Vote | undefined {
    return this.books.turnVotes[turn]?.[id]
  }

  awayCount(): number {
    return this.trail.filter((step) => step.kind === "away").length
  }
}

/** a page relaunched mid-game onto `stored`: cold clock, read answered or released */
export function relaunch(
  stored: StoredVotes | null,
  loadSecond: number,
  options: { door?: boolean; slowRead?: boolean; readyBeforeWindow?: number } = {},
): Page {
  const page = new Page({ door: options.door, restorePending: true })
  if (options.readyBeforeWindow !== undefined) {
    // #1178: the clock is ready before the game window lands, so the first
    // ticks carry no coldStartedAt
    page.clockState = { ready: true }
    page.restorePending = false
    for (let s = loadSecond; s < loadSecond + options.readyBeforeWindow; s++) page.tick(s)
    page.clockState = { ready: true, coldStartedAt: loadSecond }
    page.restorePending = true
    page.restore(stored, false)
    page.tick(loadSecond + options.readyBeforeWindow)
    return page
  }
  page.clockState = { ready: true, coldStartedAt: loadSecond }
  if (options.slowRead) {
    page.tick(loadSecond) // held
    page.restorePending = false // the 3 s release
    page.tick(loadSecond + 3)
    page.restore(stored, true)
    page.tick(loadSecond + 4)
  } else {
    page.restore(stored, false)
    page.tick(loadSecond)
  }
  return page
}

// ---------------------------------------------------------------- the model

/** the facts the model reads, written by the scenario as it plays */
export interface Truth {
  /** the first turn from which this player is charged; turns before it hold no verdict */
  entry: number
  /** each co-player's video boundary, the final merged history */
  seenFrom: Partial<Record<PlayerId, number>>
  /** the player's own gestures by turn, in order: a tap, or the ban's reject;
   *  `null` is an undo that took the gesture back */
  gestures: Map<number, Map<PlayerId, Vote | null>>
  /** the turns that had ended when the model is read */
  endedThrough: number
}

export function newTruth(entry: number): Truth {
  return { entry, seenFrom: {}, gestures: new Map(), endedThrough: 0 }
}

export function recordGesture(truth: Truth, turn: number, id: PlayerId, verdict: Vote | null): void {
  const turnGestures = truth.gestures.get(turn) ?? new Map<PlayerId, Vote | null>()
  turnGestures.set(id, verdict)
  truth.gestures.set(turn, turnGestures)
}

/**
 * THE SETTLED RULES, per ended turn and co-player:
 *  - before entry (a genuine late join): no verdict (#520);
 *  - the player's own last gesture stands (#569: a real tap wins);
 *  - otherwise a co-player who was seen by that turn files NotPerson: the
 *    default, the ban, and a missed turn (crash, kill, relaunch) alike (#527);
 *  - a co-player not seen by that turn holds nothing in the turn books
 *    (#562; the confirm projection decides them).
 */
function expectedVerdict(truth: Truth, turn: number, id: PlayerId): Vote | undefined {
  if (turn < truth.entry || turn >= truth.endedThrough) return undefined
  const gesture = truth.gestures.get(turn)?.get(id)
  if (gesture) return gesture
  const from = truth.seenFrom[id]
  return from !== undefined && from <= turn ? "notperson" : undefined
}

/** every (turn, co-player) where the reducer disagrees with the model */
export function disagreements(page: Page, truth: Truth): string[] {
  const out: string[] = []
  for (let turn = 0; turn < TOTAL_TURNS; turn++)
    for (const id of candidatesOf(turn)) {
      const want = expectedVerdict(truth, turn, id)
      const got = page.verdict(turn, id)
      if (want !== got) out.push(`turn ${turn} ${id}: model ${want ?? "none"}, reducer ${got ?? "none"}`)
    }
  return out
}

// ---------------------------------------------------------------- randomness

/** mulberry32: a seeded, deterministic generator */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]
export const int = (random: () => number, lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1))
