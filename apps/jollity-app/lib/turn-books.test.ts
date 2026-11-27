// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The turn books' contract (lib/turn-books.ts, the spec's seven clauses) as
 * properties over generated event sequences. A small seeded generator drives
 * the pure functions the way useGameSession does — a tick every half second
 * or a jump (a throttled or frozen page), backward chain-clock steps, taps,
 * bans and undos on the open turn, decoded frames, a relaunch whose stored
 * books land before or after the 3 s release, and a genuine late join — and
 * every clause is checked after every step. A failure prints its seed.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { calculateSnapshot, hostSeat } from "@jollity/game-chain/game"
import type { GameSnapshot, GameTimingInfo } from "@jollity/game-chain"
import type { ChainClockState, PlayerId } from "./game-source"
import type { Vote } from "./game-session"
import type { StoredVotes } from "./game-votes"
import type { AutoSeals, TurnVotes } from "./game-roster"
import { markVideoRoleSeen } from "./video-role-history"
import {
  banPlayer,
  castTap,
  emptyTurnBooks,
  remountClockState,
  restoreBooks,
  sealablePlayers,
  topUpBooks,
  tickBooks,
  unbanPlayer,
  type TurnBooks,
  type TurnBooksStep,
  type TurnClock,
  type TurnWorld,
} from "./turn-books"

// ── the game: 2 rounds of 4 seats; round 1 has an empty chair ──────────────
// Round r runs [55r, 55r + 48) after G, 4 turns of 12 s; the last turn ends
// at G + 103. B sits in round 0 alone; C changes seat between the rounds, so
// a seat-keyed ban would follow the wrong person.
const G = 1_000_000
const STRIDE = 4
const timing: GameTimingInfo = { gameDate: G, reportEnds: G + 200, rounds: 2, maxGroupSize: STRIDE }
const ME = "me"
const B = "bob"
const C = "carol"
const D = "dave"
const GHOST = "ghost:1:3"
const SEATS: (PlayerId | undefined)[][] = [
  [ME, B, C, D],
  [C, ME, D, GHOST],
]
const groupSize = (round: number) => SEATS[round].filter((id) => id !== GHOST).length
const OTHERS = [B, C, D]

const candidates = (round: number, roundTurn: number): PlayerId[] =>
  (SEATS[round] ?? [])
    .filter((_, seat) => seat !== hostSeat(roundTurn, groupSize(round)))
    .filter((id): id is PlayerId => id !== undefined && id !== ME && id !== GHOST)
const host = (round: number, roundTurn: number): PlayerId | "none" =>
  SEATS[round]?.[hostSeat(roundTurn, groupSize(round))] ?? "none"
/** a world whose bans and votes are the given books' own: what the hook
 *  hands in once every update has rendered (a timer tick, a gesture) */
const worldOf = (books: TurnBooks): TurnWorld => worldAsRendered(books.banned, books.turnVotes)
/** the world as the hook hands it in: the bans and the votes AS LAST
 *  RENDERED, which can trail the books inside one flush (see the restore) */
const worldAsRendered = (banned: ReadonlySet<PlayerId>, renderedVotes: TurnVotes): TurnWorld => ({
  stride: STRIDE,
  candidates,
  host,
  banned,
  renderedVotes,
})
const members = (round: number) => (SEATS[round] ?? []).filter((id): id is PlayerId => !!id && id !== ME && id !== GHOST)

/** the turns that ended before chain second `t` */
const completedAt = (t: number): number => {
  const s = calculateSnapshot(t, timing)
  return s.kind === "round"
    ? s.round * STRIDE + s.hostPosition
    : s.kind === "between-rounds"
      ? s.nextRound * STRIDE
      : s.kind === "reporting" || s.kind === "finished"
        ? timing.rounds * STRIDE
        : 0
}
const activeTurn = (s: GameSnapshot | undefined) => (s?.kind === "round" ? s.round * STRIDE + s.hostPosition : -1)

/** the hook's save (lib/game-votes) */
const saved = (books: TurnBooks): StoredVotes => ({
  gameIndex: 7,
  account: ME,
  turnVotes: books.turnVotes,
  banned: [...books.banned],
  overrides: {},
  autoSeals: books.autoSeals,
  banVotes: books.banVotes,
  firstOpenedTurn: books.firstOpenedTurn,
  videoRoleHistory: books.videoRoleHistory,
})

// ── a seeded generator ──────────────────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  }
}

type Event =
  | { kind: "tick"; dt: number; frozeAway: boolean }
  | { kind: "frame"; id: PlayerId }
  | { kind: "tap"; id: PlayerId; verdict: Vote }
  | { kind: "ban"; id: PlayerId }
  | { kind: "unban"; id: PlayerId }
  | { kind: "restore" }

type Mode = "warm" | "relaunch" | "late"

/** one page's life: the books and what the hook around them knows */
interface Life {
  books: TurnBooks
  t: number
  mode: Mode
  /** the source's clockState */
  clock: () => ChainClockState | undefined
  restorePending: boolean
  restored: boolean
  viaDoor: boolean
  /** the last snapshot a tick published, and how far that tick got */
  snap: GameSnapshot | undefined
  stage: "cold" | "held" | "ran" | undefined
  /** what the player did: `turn:id` -> the verdict their last gesture left */
  gestures: Map<string, Vote | undefined>
  /** what the player did in the life before a relaunch, which comes back
   *  with the stored books */
  carried: Map<string, Vote | undefined>
  /** the bans the last tick was handed (as rendered, which may lag) */
  tickBanned: ReadonlySet<PlayerId>
}

const key = (turn: number, id: PlayerId) => `${turn}:${id}`

/** the clause checks, run by every step */
type Check = (before: TurnBooks, after: TurnBooks, event: Event, life: Life, stored: StoredVotes | null) => void

function settled(life: Life): boolean {
  const state = life.clock()
  return (
    life.stage === "ran" &&
    (life.mode === "warm" || life.restored) &&
    (state?.coldStartedAt === undefined || life.books.coldReconciled)
  )
}

/** may the player gesture at `id` now: the hook's votable on a live round,
 *  and a banned tile takes no gesture */
function gestureTurn(life: Life, id: PlayerId): { turn: number; round: number; roundTurn: number } | undefined {
  const s = life.snap
  if (!settled(life) || s?.kind !== "round") return undefined
  if (!candidates(s.round, s.hostPosition).includes(id)) return undefined
  if (life.books.videoRoleHistory[id] === undefined) return undefined
  return { turn: s.round * STRIDE + s.hostPosition, round: s.round, roundTurn: s.hostPosition }
}

/** one tick of the hook's interval (or its effect's immediate one) */
function runTick(life: Life, frozeAway: boolean, world: TurnWorld): void {
  const snap = calculateSnapshot(life.t, timing)
  const ticked = tickBooks(
    life.books,
    snap,
    {
      timing,
      state: life.clock(),
      restorePending: life.restorePending,
      frozeAway,
      chainSeen: () => true,
      viaDoor: () => life.viaDoor,
    },
    world,
  )
  life.books = ticked.books
  life.stage = ticked.stage
  life.tickBanned = world.banned
  if (ticked.stage !== "cold") life.snap = snap
}

/** apply one event the way the hook does, then run the checks */
function step(life: Life, event: Event, checks: Check[], stored: StoredVotes | null): void {
  const before = life.books
  switch (event.kind) {
    case "tick": {
      // a timer tick: every earlier update has flushed and rendered
      life.t += event.dt
      runTick(life, event.frozeAway, worldOf(life.books))
      break
    }
    case "frame": {
      const s = life.snap
      const inRound = settled(life) && s?.kind === "round" && members(s.round).includes(event.id)
      // a frame counts only in a shared open turn (#602)
      if (!inRound) return
      const boundary = inRound ? activeTurn(s) : null
      const marked = markVideoRoleSeen(life.books.videoRoleHistory, event.id, boundary)
      if (marked.changed) life.books = { ...life.books, videoRoleHistory: marked.history }
      break
    }
    case "tap": {
      const open = gestureTurn(life, event.id)
      if (!open || life.books.banned.has(event.id)) return
      life.books = castTap(life.books, open.turn, open.round, event.id, event.verdict).books
      life.gestures.set(key(open.turn, event.id), event.verdict)
      break
    }
    case "ban": {
      const open = gestureTurn(life, event.id)
      if (!open || life.books.banned.has(event.id)) return
      life.books = castTap(banPlayer(life.books, event.id), open.turn, open.round, event.id, "notperson", "ban").books
      life.gestures.set(key(open.turn, event.id), "notperson")
      break
    }
    case "unban": {
      if (!life.books.banned.has(event.id)) return
      const s = life.snap
      const open = settled(life) && s?.kind === "round"
        ? { turn: activeTurn(s), round: s.round, roundTurn: s.hostPosition }
        : undefined
      life.books = unbanPlayer(life.books, event.id, open, worldOf(life.books)).books
      if (open) life.gestures.set(key(open.turn, event.id), undefined)
      break
    }
    case "restore": {
      if (life.restored) return
      // ONE FLUSH, in the hook's effect order: the merged books render (the
      // rendered votes refresh, an effect declared before the tick's), the
      // tick effect re-runs at once when its deps moved (voteRestoreReleased
      // on a prompt read, firstOpenedTurn) and ticks with the roster's bans
      // NOT yet refreshed, then the roster refreshes and the top-up runs on
      // the votes rendered before that tick.
      const pre = life.books
      const released = !life.restorePending
      const merged = restoreBooks(pre, stored, released).books
      life.books = merged
      life.restored = true
      life.restorePending = false
      if (!released || merged.firstOpenedTurn !== pre.firstOpenedTurn)
        runTick(life, false, worldAsRendered(pre.banned, merged.turnVotes))
      life.books = topUpBooks(life.books, worldAsRendered(merged.banned, merged.turnVotes)).books
      break
    }
  }
  if (TRACE)
    console.log(
      life.mode,
      (life.t - G).toFixed(1),
      JSON.stringify(event),
      life.stage,
      JSON.stringify({
        prev: life.books.prevTurn,
        last: life.books.lastSealedTurn,
        sealed: [...life.books.sealed],
        votes: life.books.turnVotes,
        seen: life.books.videoRoleHistory,
        banned: [...life.books.banned],
        first: life.books.firstOpenedTurn,
        cold: life.books.coldReconciled,
        boundary: life.books.coldReadyBoundary,
      }),
    )
  for (const check of checks) check(before, life.books, event, life, stored)
}
/** TURN_BOOKS_SEED=<seed> replays one seed with a trace of every step */
const TRACE = process.env.TURN_BOOKS_SEED !== undefined

function randomEvent(r: ReturnType<typeof rng>, life: Life): Event {
  const roll = r.next()
  // a live chain clock steps back inside the game (#390); a step back over
  // T-0, or over a late joiner's load, is pinned on its own below
  const floor = life.mode === "late" ? (life.clock()?.coldStartedAt ?? G) : G
  const back = [-3, -8, -14].filter((dt) => life.t + dt >= floor)
  if (roll < 0.55) {
    const dt = r.pick([0.5, 0.5, 0.5, 0.5, 0.5, 2, 6, 12, 30, ...back])
    return { kind: "tick", dt, frozeAway: dt >= 10 }
  }
  if (roll < 0.72) return { kind: "frame", id: r.pick(OTHERS) }
  if (roll < 0.88) return { kind: "tap", id: r.pick(OTHERS), verdict: r.pick(["person", "notperson"] as const) }
  if (roll < 0.94) return { kind: "ban", id: r.pick(OTHERS) }
  return { kind: "unban", id: r.pick(OTHERS) }
}

function newLife(mode: Mode, t: number, books: TurnBooks = emptyTurnBooks()): Life {
  return {
    books,
    t,
    mode,
    clock: () => ({ ready: true }),
    restorePending: false,
    restored: mode === "warm",
    viaDoor: false,
    snap: undefined,
    stage: undefined,
    gestures: new Map(),
    carried: new Map(),
    tickBanned: new Set(),
  }
}

/** a page present from before the game, run until chain second `until` */
function runWarm(r: ReturnType<typeof rng>, until: number, checks: Check[]): Life {
  const life = newLife("warm", G - 20)
  step(life, { kind: "tick", dt: 0, frozeAway: false }, checks, null)
  while (life.t < until) step(life, randomEvent(r, life), checks, null)
  return life
}

/** a page that loads at `loadAt` inside the game: a cold clock that becomes
 *  ready a few ticks later, and a stored read that lands before or after the
 *  3 s release. `stored` null with no door is a genuine late join. */
function runCold(
  r: ReturnType<typeof rng>,
  mode: "relaunch" | "late",
  loadAt: number,
  stored: StoredVotes | null,
  viaDoor: boolean,
  gestures: Map<string, Vote | undefined>,
  checks: Check[],
): Life {
  const life = newLife(mode, loadAt)
  life.viaDoor = viaDoor
  life.carried = new Map(gestures)
  life.restored = false
  life.restorePending = true
  const readyAfter = r.int(0, 8)
  let mountTicks = 0
  life.clock = () => (mountTicks >= readyAfter ? { ready: true, coldStartedAt: loadAt } : { ready: false })
  const releaseAt = 6 // the 3 s release, in half-second ticks
  const restoreAt = r.int(0, 14)
  for (let i = 0; i < 16; i++) {
    if (i === restoreAt) step(life, { kind: "restore" }, checks, stored)
    if (i === releaseAt && !life.restored) life.restorePending = false
    step(life, { kind: "tick", dt: 0.5, frozeAway: false }, checks, stored)
    mountTicks++
  }
  while (life.t < G + 125) step(life, randomEvent(r, life), checks, stored)
  return life
}

/** every scenario: warm games, relaunches and late joins */
function scenarios(seed: number, checks: Check[]): void {
  const r = rng(seed)
  const kind = r.pick(["warm", "relaunch", "late"] as const)
  if (kind === "warm") {
    runWarm(r, G + 125, checks)
    return
  }
  if (kind === "late") {
    runCold(r, "late", G + r.int(0, 110), null, false, new Map(), checks)
    return
  }
  // a relaunch: a first life killed at some point of the game, its books saved
  const killAt = G + r.int(-15, 100)
  const first = runWarm(r, killAt, [])
  const stored = r.next() < 0.85 ? saved(first.books) : null
  runCold(r, "relaunch", Math.max(killAt, G) + r.int(0, 25), stored, r.next() < 0.5, first.gestures, checks)
}

const SEEDS = TRACE ? [Number(process.env.TURN_BOOKS_SEED)] : Array.from({ length: 400 }, (_, i) => 0x5eed + i * 7919)
const forAll = (checks: Check[]) => {
  for (const seed of SEEDS) {
    try {
      scenarios(seed, checks)
    } catch (error) {
      throw new Error(`seed ${seed}: ${(error as Error).message}`)
    }
  }
}
const verdict = (books: TurnBooks, turn: number, id: PlayerId) => books.turnVotes[turn]?.[id]
const newlySealed = (before: TurnBooks, after: TurnBooks) => [...after.sealed].filter((turn) => !before.sealed.has(turn))
const ensure = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message)
}

describe("the turn books' contract", () => {
  it("1. monotone seals: the sealed set only grows, each turn once, never on a backward step, and a sealed verdict changes only by the player's gesture", () => {
    forAll([
      (before, after, event, life, stored) => {
        for (const turn of before.sealed) ensure(after.sealed.has(turn), `turn ${turn} unsealed by ${event.kind}`)
        if (event.kind === "tick") {
          ensure(
            after.turnsSealed - before.turnsSealed === newlySealed(before, after).length,
            `a tick sealed a turn twice (${after.turnsSealed - before.turnsSealed} seals, ${newlySealed(before, after).length} new)`,
          )
          if (event.dt < 0) ensure(newlySealed(before, after).length === 0, `a backward step sealed ${newlySealed(before, after)}`)
        }
        const gestured = event.kind === "tap" || event.kind === "ban" || event.kind === "unban"
        for (const turn of before.sealed)
          for (const [id, was] of Object.entries(before.turnVotes[turn] ?? {})) {
            const now = verdict(after, turn, id)
            if (now === was) continue
            if (gestured && turn === activeTurn(life.snap) && id === event.id) continue
            // a merge of two lives: a stored tap beats this page's default
            if (
              event.kind === "restore" &&
              stored !== null &&
              stored.turnVotes[turn]?.[id] === now &&
              !stored.autoSeals[turn]?.includes(id)
            )
              continue
            throw new Error(`sealed turn ${turn}: ${id} went ${was} -> ${now} on ${event.kind}`)
          }
      },
    ])
  })

  it("2. missed turns are rejects: every ended turn from the entry on is sealed, with a verdict for each co-player eligible in it", () => {
    forAll([
      (before, after, event, life, stored) => {
        // each seal, and each top-up after a late restore, covers everyone
        // eligible in its turn
        const covered =
          event.kind === "tick"
            ? newlySealed(before, after)
            : event.kind === "restore"
              ? [
                  // the flush's own tick; the stored seals are the earlier life's
                  ...newlySealed(before, after).filter((turn) => stored?.autoSeals[turn] === undefined),
                  ...(stored ? [...before.sealed].filter((turn) => stored.autoSeals[turn] === undefined) : []),
                ]
              : []
        for (const turn of covered) {
          const round = Math.floor(turn / STRIDE)
          for (const id of sealablePlayers(after, worldOf(after), round, turn % STRIDE, turn))
            ensure(verdict(after, turn, id) !== undefined, `turn ${turn} sealed without a verdict for eligible ${id} (${event.kind})`)
        }
        if (event.kind !== "tick" || !settled(life)) return
        const restoredFirst = after.restoredFirstOpenedTurn
        const entry =
          life.mode === "warm"
            ? after.presentBeforeFirstTurn
              ? 0
              : after.firstOpenedTurn
            : (restoredFirst ?? (life.viaDoor ? 0 : after.coldReadyBoundary))
        if (entry === undefined) return
        for (let turn = entry; turn < completedAt(life.t); turn++)
          ensure(after.sealed.has(turn), `turn ${turn} ended (entry ${entry}, now ${life.t - G}) but is not sealed (${life.mode})`)
      },
    ])
  })

  it("3. late join is not charged: a genuine late joiner's turns that ended before the load hold no verdict", () => {
    forAll([
      (_before, after, _event, life) => {
        if (life.mode !== "late") return
        const state = life.clock()
        if (state?.coldStartedAt === undefined) return
        // a step back may re-live such a turn, and a tap in it is the
        // player's own; nothing else may stand there
        for (let turn = 0; turn < completedAt(state.coldStartedAt); turn++) {
          for (const [id, given] of Object.entries(after.turnVotes[turn] ?? {}))
            ensure(life.gestures.get(key(turn, id)) === given, `late join charged ${id} ${given} in turn ${turn}`)
          // nor is it sealed: a sealed turn is a turn the player answers for
          // (the first answered turn of #520, the away check of #599)
          ensure(!after.sealed.has(turn), `late join sealed turn ${turn}, which ended before the load`)
        }
      },
    ])
  })

  it("4. taps win: no seal, merge or top-up files NotPerson where the player's own gesture said Person", () => {
    forAll([
      (_before, after, event, life, stored) => {
        const carried = life.restored && stored ? [...life.carried] : []
        // this life's last gesture on a turn overrides the earlier life's
        for (const [where, given] of new Map([...carried, ...life.gestures])) {
          if (given !== "person") continue
          const [turn, id] = where.split(":")
          ensure(verdict(after, Number(turn), id) === "person", `Person tap on ${where} became ${verdict(after, Number(turn), id)} (${event.kind})`)
        }
      },
    ])
  })

  it("4. taps win across a merge: a stored tap beats a local default, and a local tap beats a stored default", () => {
    for (const seed of SEEDS) {
      const r = rng(seed)
      // two sets of books for the same turns: each verdict a tap or a default
      const books = (): { votes: TurnVotes; auto: AutoSeals } => {
        const votes: TurnVotes = {}
        const auto: AutoSeals = {}
        for (let turn = 0; turn < 8; turn++) {
          if (r.next() < 0.3) continue
          votes[turn] = {}
          auto[turn] = []
          for (const id of OTHERS) {
            const roll = r.next()
            if (roll < 0.3) continue
            if (roll < 0.6) {
              votes[turn][id] = "notperson"
              auto[turn] = [...auto[turn], id]
            } else votes[turn][id] = r.pick(["person", "notperson"] as const)
          }
        }
        return { votes, auto }
      }
      const local = books()
      const remote = books()
      const mine: TurnBooks = {
        ...emptyTurnBooks(),
        turnVotes: local.votes,
        autoSeals: local.auto,
        sealed: new Set(Object.keys(local.auto).map(Number)),
      }
      const stored = saved({ ...emptyTurnBooks(), turnVotes: remote.votes, autoSeals: remote.auto })
      const merged = restoreBooks(mine, stored, r.next() < 0.5).books
      for (let turn = 0; turn < 8; turn++)
        for (const id of OTHERS) {
          const localTap = local.votes[turn]?.[id] !== undefined && !local.auto[turn]?.includes(id)
          const storedTap = remote.votes[turn]?.[id] !== undefined && !remote.auto[turn]?.includes(id)
          const got = verdict(merged, turn, id)
          if (localTap) {
            ensure(got === local.votes[turn][id], `seed ${seed}: local tap on ${turn}:${id} lost to ${got}`)
            ensure(!merged.autoSeals[turn]?.includes(id), `seed ${seed}: explicit local verdict on ${turn}:${id} kept a stale auto-seal`)
          }
          else if (storedTap) ensure(got === remote.votes[turn][id], `seed ${seed}: stored tap on ${turn}:${id} lost to ${got}`)
        }
    }
  })

  it("5. the ban holds by account: every turn opened after a ban holds a deliberate NotPerson for the banned, eligible, untapped player", () => {
    forAll([
      (before, after, event, life) => {
        if (event.kind !== "tick" && event.kind !== "restore") return
        // the bans the tick was handed: right after a prompt restore they are
        // the pre-restore ones (known gap below), otherwise the books' own
        const banned = life.tickBanned
        const opened = newlySealed(before, after).filter((turn) => turn !== before.prevTurn)
        const active = activeTurn(life.snap)
        const checkTurn = (turn: number, sealed: boolean) => {
          const round = Math.floor(turn / STRIDE)
          for (const id of sealablePlayers(after, worldOf(after), round, turn % STRIDE, turn)) {
            if (!banned.has(id) || life.gestures.get(key(turn, id)) === "person") continue
            ensure(verdict(after, turn, id) === "notperson", `banned ${id} not rejected in opened turn ${turn}`)
            if (sealed) ensure(!after.autoSeals[turn]?.includes(id), `banned ${id} filed as a default in turn ${turn}`)
          }
        }
        for (const turn of opened) checkTurn(turn, true)
        if (event.kind === "tick" && life.stage === "ran" && active >= 0 && active !== before.prevTurn) checkTurn(active, false)
      },
    ])
  })

  it("5. the ban holds by account through a late restore: the stored ban rejects the topped-up turns", () => {
    forAll([
      (before, after, event, _life, stored) => {
        if (event.kind !== "restore" || !stored) return
        const toppedUp = [...before.sealed].filter((turn) => stored.autoSeals[turn] === undefined)
        for (const turn of toppedUp) {
          const round = Math.floor(turn / STRIDE)
          for (const id of sealablePlayers(after, worldOf(after), round, turn % STRIDE, turn)) {
            if (!after.banned.has(id) || verdict(before, turn, id) !== undefined) continue
            ensure(verdict(after, turn, id) === "notperson", `stored ban on ${id} not applied to topped-up turn ${turn}`)
            ensure(!after.autoSeals[turn]?.includes(id), `stored ban on ${id} filed as a default in turn ${turn}`)
          }
        }
      },
    ])
  })

  it("6. monotone evidence: a video boundary never moves later, and a pending observation binds to the first turn opened after it", () => {
    forAll([
      (before, after, event, life) => {
        for (const [id, entry] of Object.entries(before.videoRoleHistory)) {
          const now = after.videoRoleHistory[id]
          ensure(now !== undefined, `${id} unseen again by ${event.kind}`)
          if (typeof entry?.fromTurn === "number")
            ensure(typeof now?.fromTurn === "number" && now.fromTurn <= entry.fromTurn, `${id}'s boundary moved ${entry.fromTurn} -> ${now?.fromTurn}`)
        }
        if (event.kind !== "tick") return
        const opened = [
          ...newlySealed(before, after).filter((turn) => turn !== before.prevTurn),
          ...(life.stage === "ran" && activeTurn(life.snap) >= 0 && activeTurn(life.snap) !== before.prevTurn ? [activeTurn(life.snap)] : []),
        ]
        if (opened.length === 0) return
        const first = Math.min(...opened)
        for (const [id, entry] of Object.entries(before.videoRoleHistory))
          if (entry?.fromTurn === null)
            ensure(after.videoRoleHistory[id]?.fromTurn === first, `pending ${id} bound to ${after.videoRoleHistory[id]?.fromTurn}, not the first opened turn ${first}`)
      },
    ])
  })

  it("7. idempotence: the same snapshot and clock twice changes nothing", () => {
    forAll([
      (_before, after, event, life) => {
        if (event.kind !== "tick") return
        const again = tickBooks(
          after,
          calculateSnapshot(life.t, timing),
          {
            timing,
            state: life.clock(),
            restorePending: life.restorePending,
            frozeAway: false,
            chainSeen: () => true,
            viaDoor: () => life.viaDoor,
          },
          worldOf(after),
        )
        ensure(again.books === after, `a repeated tick changed the books at ${life.t - G}`)
        ensure(again.trail.length === 0, `a repeated tick logged ${JSON.stringify(again.trail)}`)
      },
    ])
  })

  it("7. idempotence: a restore of the books the session already holds changes nothing", () => {
    forAll([
      (_before, after, event, life) => {
        if (event.kind !== "tick" || !settled(life) || !life.restored) return
        const holds = { ...after, restoredSealed: new Set(Object.keys(after.autoSeals).map(Number)) }
        const again = restoreBooks(holds, saved(holds), false)
        const content = (books: TurnBooks) => ({
          turnVotes: books.turnVotes,
          autoSeals: books.autoSeals,
          sealed: [...books.sealed].sort((a, b) => a - b),
          banned: [...books.banned].sort(),
          videoRoleHistory: books.videoRoleHistory,
          firstOpenedTurn: books.firstOpenedTurn,
          topUpEpoch: books.topUpEpoch,
        })
        // known gap, pinned below: books with sealed turns and no opened one
        // come back with the earliest seal as their first-opened turn
        const inferred = holds.firstOpenedTurn === undefined && holds.sealed.size > 0
        expect({ ...content(again.books), firstOpenedTurn: inferred ? undefined : again.books.firstOpenedTurn }).toEqual(content(holds))
        ensure(again.trail.length === 0, "a repeated restore logged")
      },
    ])
  })

  // ── pinned gaps: still open, each pinned as an it.fails below ────────────
  // (#390 gaps 1 and 3 are closed by this branch; the remaining ones are
  // tracked in the follow-up issue for PR #90's review)

  /** a page that opened turn 0, ticked through the given chain seconds */
  const pageAt = (seconds: number[], firstTick = G + 2) => {
    const life = newLife("warm", firstTick)
    life.books = { ...life.books, videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } } }
    const ticks: TurnBooks[] = []
    step(life, { kind: "tick", dt: 0, frozeAway: false }, [], null)
    for (const at of seconds) {
      step(life, { kind: "tick", dt: at - life.t, frozeAway: false }, [], null)
      ticks.push(life.books)
    }
    return { life, ticks }
  }

  it("#390 (clauses 2, 7): a page that steps back from turn 0 over T-0 and freezes still seals turns 0 and 1", () => {
    // Was a known gap until #390. A late joiner opens turn 0, the chain
    // clock steps back into the connect beat: that tick resets prevTurn, but
    // the entry floor in sealThrough reads the monotone firstOpenedTurn, so a
    // page that freezes right then still seals turns 0 and 1 when it wakes in
    // turn 2.
    const { life } = pageAt([G - 5, G + 25])
    expect(life.books.sealed.has(0) && life.books.sealed.has(1)).toBe(true)
  })

  it.fails("known gap (clause 7): a restore of books with sealed turns and no opened one infers the first-opened turn", () => {
    // A relaunch through the door seals the turns it missed without ever
    // opening one; the save stores no firstOpenedTurn, and the restore of
    // those very books falls back to the earliest seal (the format's rule for
    // older entries), so the books change.
    const books: TurnBooks = { ...emptyTurnBooks(), sealed: new Set([2, 3]), autoSeals: { 2: [], 3: [] } }
    const again = restoreBooks(books, saved(books), false)
    expect(again.books.firstOpenedTurn).toBe(books.firstOpenedTurn)
  })

  it("#390 (clause 3): a step back into a turn before a late joiner's load files no defaults there", () => {
    // Was a known gap until #390. A genuine late joiner loads in turn 1.
    // The chain clock steps back into turn 0, which ended before the load; a
    // frame there makes B and C seen from turn 0 (#562 B: decoded in an open
    // turn), but when the clock moves on, the entry floor in sealThrough
    // (firstOpenedTurn = 1) keeps the re-lived turn 0 below the entry: it is
    // never sealed and files no verdicts the late joiner was not charged for.
    const life = newLife("late", G + 13)
    life.restored = true
    life.clock = () => ({ ready: true, coldStartedAt: G + 13 })
    step(life, { kind: "tick", dt: 0, frozeAway: false }, [], null)
    step(life, { kind: "tick", dt: -8, frozeAway: false }, [], null)
    step(life, { kind: "frame", id: B }, [], null)
    step(life, { kind: "tick", dt: 9, frozeAway: false }, [], null)
    expect(life.books.turnVotes[0] ?? {}).toEqual({})
  })

  it("#1178 (clause 2): a relaunch ready before coldStartedAt still seals its missed turns", () => {
    // lib/game-source's clockState() reports ready at the first chain value,
    // but coldStartedAt only once the game window arrives. A relaunch through
    // the door that ticks in between opens turn 3 as a fresh page (prevTurn
    // 3, nothing sealed: it was not present before turn 0). When coldStartedAt
    // lands, the reconcile is a rejoin and restarts the replay from the
    // evidence, so turns 0..2 are sealed NotPerson (#527). Was a known gap
    // until #1178.
    const life = newLife("relaunch", G + 40)
    life.viaDoor = true
    life.restored = true
    life.books = { ...life.books, videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } } }
    let windowArrived = false
    life.clock = () => (windowArrived ? { ready: true, coldStartedAt: G + 40 } : { ready: true })
    step(life, { kind: "tick", dt: 0, frozeAway: false }, [], null)
    step(life, { kind: "tick", dt: 0.5, frozeAway: false }, [], null)
    windowArrived = true
    step(life, { kind: "tick", dt: 0.5, frozeAway: false }, [], null)
    step(life, { kind: "tick", dt: 12, frozeAway: false }, [], null)
    for (const turn of [0, 1, 2]) expect(life.books.sealed.has(turn)).toBe(true)
  })

  it.fails("known gap (clause 5): the reconcile right after a prompt restore seals a stored ban as a default", () => {
    // The hook hands the reducer the bans AS LAST RENDERED, refreshed by an
    // effect declared after the tick's. When a prompt stored read lands, the
    // tick effect re-runs in the same flush and reconciles before that
    // refresh, so the relaunch's missed turns are sealed with the pre-restore
    // bans: the stored ban lands as an auto default (the same NotPerson, but
    // counted as a default in autoSeals and the report-built trail), and the
    // top-up does not revisit those turns. The world below models that lag.
    const stored: StoredVotes = {
      ...saved(emptyTurnBooks()),
      banned: [C],
      firstOpenedTurn: 0,
      videoRoleHistory: { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } },
    }
    const restored = restoreBooks(emptyTurnBooks(), stored, false).books
    const lagging: TurnWorld = { ...worldOf(restored), banned: new Set() }
    const ticked = tickBooks(
      restored,
      calculateSnapshot(G + 40, timing),
      {
        timing,
        state: { ready: true, coldStartedAt: G + 40 },
        restorePending: false,
        frozeAway: false,
        chainSeen: () => true,
        viaDoor: () => false,
      },
      lagging,
    ).books
    for (const turn of [0, 1, 2]) expect(ticked.autoSeals[turn]).not.toContain(C)
  })

})

// ── the trail: content and order, pinned ────────────────────────────────────
// The hook replays these steps in order (vote rows to the game log, the away
// latch and the counts where they fall), and the extraction was gated on the
// game log being byte-identical to main's for every fv scenario. These pin a
// representative set at the reducer, so that gate holds in CI.
describe("the trail the books hand the session", () => {
  const SEEN = { [B]: { fromTurn: 0 }, [C]: { fromTurn: 0 }, [D]: { fromTurn: 0 } }
  const clockOf = (state: ChainClockState | undefined, over: Partial<TurnClock> = {}): TurnClock => ({
    timing,
    state,
    restorePending: false,
    frozeAway: false,
    chainSeen: () => true,
    viaDoor: () => false,
    ...over,
  })
  /** tick `books` at each chain second, collecting every trail step */
  const play = (books: TurnBooks, at: number[], clock: (t: number) => TurnClock) => {
    const trail: TurnBooksStep[] = []
    for (const t of at) {
      const ticked = tickBooks(books, calculateSnapshot(t, timing), clock(t), worldOf(books))
      books = ticked.books
      trail.push(...ticked.trail)
    }
    return { books, trail }
  }
  const sealed = (turn: number, host: string, person: string[], notperson: string[], auto: string[]) => ({
    kind: "row",
    message: "turn sealed",
    data: { turn, round: Math.floor(turn / STRIDE), host, tapped: { person, notperson }, auto },
  })

  it("a page present from the connect beat: a tap, then the turn's seal with its defaults", () => {
    let { books } = play({ ...emptyTurnBooks(), videoRoleHistory: SEEN }, [G - 5, G + 3], () => clockOf({ ready: true }))
    const tapped = castTap(books, 0, 0, B, "person")
    books = tapped.books
    const { trail } = play(books, [G + 13], () => clockOf({ ready: true }))
    expect(tapped.trail).toEqual([{ kind: "row", message: "tap", data: { turn: 0, round: 0, target: B, verdict: "person" } }])
    expect(trail).toEqual([sealed(0, ME, [B], [], [C, D])])
  })

  it("a freeze across turns: the away latch first, then each missed turn's seal in order, a ban rejecting by account", () => {
    let { books } = play({ ...emptyTurnBooks(), videoRoleHistory: SEEN }, [G - 5, G + 3], () => clockOf({ ready: true }))
    books = castTap(banPlayer(books, C), 0, 0, C, "notperson", "ban").books
    const ticked = tickBooks(books, calculateSnapshot(G + 63, timing), clockOf({ ready: true }, { frozeAway: true }), worldOf(books))
    expect(ticked.trail).toEqual([
      { kind: "away" },
      sealed(0, ME, [], [C], [B, D]),
      sealed(1, B, [], [C], [D]),
      sealed(2, C, [], [], [B, D]),
      sealed(3, D, [], [C], [B]),
    ])
  })

  it("a relaunch through the door after turns no page lived through: away, then every missed turn sealed", () => {
    const stored: StoredVotes = { ...saved(emptyTurnBooks()), autoSeals: { 0: [B, C] }, firstOpenedTurn: 0, videoRoleHistory: SEEN }
    const restored = restoreBooks(emptyTurnBooks(), stored, false)
    expect(restored.trail).toEqual([])
    const { trail } = play(restored.books, [G + 39], () => clockOf({ ready: true, coldStartedAt: G + 30 }, { viaDoor: () => true }))
    expect(trail).toEqual([
      { kind: "away" },
      sealed(1, B, [], [], [C, D]),
      sealed(2, C, [], [], [B, D]),
    ])
  })

  it("a prompt restore race reads the rendered votes before marking missed defaults as away", () => {
    const stored: StoredVotes = {
      ...saved(emptyTurnBooks()),
      turnVotes: { 1: { [C]: "person", [D]: "person" } },
      autoSeals: { 0: [B, C] },
      firstOpenedTurn: 0,
      videoRoleHistory: SEEN,
    }
    const books = restoreBooks(emptyTurnBooks(), stored, false).books
    const ticked = tickBooks(
      books,
      calculateSnapshot(G + 39, timing),
      clockOf({ ready: true, coldStartedAt: G + 30 }, { viaDoor: () => true }),
      worldAsRendered(books.banned, {}),
    )

    expect(ticked.trail).toContainEqual({ kind: "away" })
  })

  it.each([
    { where: "during a round", mountSecond: G + 39, sealed: [0, 1, 2] },
    { where: "during reporting", mountSecond: G + 105, sealed: [0, 1, 2, 3, 4, 5, 6, 7] },
  ])("#1470: a warm-clock /connection-help remount $where seals missed turns", ({ mountSecond, sealed }) => {
    const stored: StoredVotes = {
      ...saved(emptyTurnBooks()),
      turnVotes: { 0: { [C]: "notperson" } },
      banned: [C],
      banVotes: { 0: [C] },
      firstOpenedTurn: 0,
      videoRoleHistory: SEEN,
    }
    const snapshot = calculateSnapshot(mountSecond, timing)
    let books = emptyTurnBooks()
    let clockState = remountClockState(undefined, { ready: true }, snapshot, mountSecond, books.restoredFirstOpenedTurn)
    const boundary = clockState.boundarySecond
    books = tickBooks(books, snapshot, clockOf(clockState.state), worldOf(books)).books
    books = restoreBooks(books, stored, false).books
    clockState = remountClockState(boundary, { ready: true }, snapshot, mountSecond + 0.5, books.restoredFirstOpenedTurn)
    const ticked = tickBooks(
      books,
      snapshot,
      clockOf(clockState.state, { viaDoor: () => true }),
      worldOf(books),
    )

    expect([...ticked.books.sealed]).toEqual(sealed)
    expect(ticked.trail).toContainEqual({ kind: "away" })
    if (mountSecond === G + 39) {
      expect(ticked.books.turnVotes[1]).toEqual({ [C]: "notperson", [D]: "notperson" })
      expect(ticked.books.banVotes[1]).toEqual([C])
      expect(ticked.books.autoSeals[1]).toEqual([D])
      expect(ticked.books.turnVotes[2]).toEqual({ [B]: "notperson", [D]: "notperson" })
      expect(ticked.books.autoSeals[2]).toEqual([B, D])
    }
  })

  it("a via-door /connection-help remount before the first turn restores the missed-turn boundary", () => {
    const stored: StoredVotes = { ...saved(emptyTurnBooks()), videoRoleHistory: SEEN }
    const mountSecond = G + 39
    const snapshot = calculateSnapshot(mountSecond, timing)
    let books = emptyTurnBooks()
    const first = remountClockState(undefined, { ready: true }, snapshot, mountSecond, undefined)
    books = tickBooks(books, snapshot, clockOf(first.state), worldOf(books)).books
    books = restoreBooks(books, stored, false).books
    const restored = remountClockState(
      first.boundarySecond,
      { ready: true },
      snapshot,
      mountSecond + 0.5,
      books.restoredFirstOpenedTurn,
      true,
    )
    const ticked = tickBooks(
      books,
      snapshot,
      clockOf(restored.state, { viaDoor: () => true }),
      worldOf(books),
    )

    expect([...ticked.books.sealed]).toEqual([0, 1, 2])
    expect(ticked.trail).toContainEqual({ kind: "away" })
  })

  it("a page reopened after the game ends files no verdicts for turns it never lived through", () => {
    // Review blocker 1 on PR #90: the stored books name firstOpenedTurn 0 and
    // hold turns 0-1 sealed, but this page reopened after the game finished
    // (no cold start, prevTurn and lastSealedTurn both -1). One tick from the
    // finished snapshot must seal nothing new: a restored firstOpenedTurn
    // alone is not evidence this page attended the later turns.
    const stored: StoredVotes = {
      ...saved(emptyTurnBooks()),
      autoSeals: { 0: [], 1: [] },
      firstOpenedTurn: 0,
      videoRoleHistory: SEEN,
    }
    const restored = restoreBooks(emptyTurnBooks(), stored, false).books
    const ticked = tickBooks(
      restored,
      calculateSnapshot(G + 201, timing),
      clockOf({ ready: true }),
      worldOf(restored),
    )
    expect([...ticked.books.sealed].sort((a, b) => a - b)).toEqual([0, 1])
    for (let turn = 2; turn < STRIDE * timing.rounds; turn++)
      expect(ticked.books.turnVotes[turn] ?? {}).toEqual({})
    expect(ticked.trail.filter((step) => step.kind === "row" && step.message === "turn sealed")).toEqual([])
  })

  it("#1470: the game session applies the captured remount boundary after restore", () => {
    const source = readFileSync(new URL("./game-session.ts", import.meta.url), "utf8")
    expect(source).toContain("remountClockState(")
    expect(source).toContain("booksRef.current.restoredFirstOpenedTurn")
  })

  it.each([
    { name: "round", at: G + 3, state: { ready: true }, boundary: G + 3 },
    { name: "round gap", at: G + 50, state: { ready: true }, boundary: G + 50 },
    { name: "reporting", at: G + 105, state: { ready: true }, boundary: G + 105 },
    { name: "waiting room", at: G - 5, state: { ready: true }, boundary: null },
    { name: "finished", at: G + 201, state: { ready: true }, boundary: null },
    { name: "clock not ready", at: G + 3, state: { ready: false }, boundary: null },
    { name: "real cold start", at: G + 3, state: { ready: true, coldStartedAt: G + 2 }, boundary: null },
  ])("captures only an exact first-tick warm remount boundary in $name", ({ at, state, boundary }) => {
    const result = remountClockState(undefined, state, calculateSnapshot(at, timing), at, undefined)
    expect(result).toEqual({ boundarySecond: boundary, state })
  })

  it("never turns a later ready tick into the remount boundary", () => {
    const snapshot = calculateSnapshot(G + 3, timing)
    const first = remountClockState(undefined, { ready: false }, snapshot, G + 3, undefined)
    const later = remountClockState(first.boundarySecond, { ready: true }, snapshot, G + 3.5, 0)
    expect(later).toEqual({ boundarySecond: null, state: { ready: true } })
  })

  it("a reporting remount with deliberate verdicts for every turn needs no away latch", () => {
    const mountSecond = G + 105
    const snapshot = calculateSnapshot(mountSecond, timing)
    const completeVotes = Object.fromEntries(
      Array.from({ length: STRIDE * timing.rounds }, (_, turn) => [
        turn,
        { [B]: "person" as const, [C]: "person" as const, [D]: "person" as const },
      ]),
    )
    const stored: StoredVotes = {
      ...saved(emptyTurnBooks()),
      turnVotes: completeVotes,
      firstOpenedTurn: 0,
      videoRoleHistory: SEEN,
    }
    let books = emptyTurnBooks()
    const first = remountClockState(undefined, { ready: true }, snapshot, mountSecond, undefined)
    books = tickBooks(books, snapshot, clockOf(first.state), worldOf(books)).books
    books = restoreBooks(books, stored, false).books
    const restored = remountClockState(first.boundarySecond, { ready: true }, snapshot, mountSecond + 0.5, 0)
    const ticked = tickBooks(books, snapshot, clockOf(restored.state), worldOf(books))

    expect(ticked.trail).not.toContainEqual({ kind: "away" })
    expect([...ticked.books.sealed]).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it("a genuine late join: the cold-skip count, then its row, and no seal for the turns before the load", () => {
    const { trail, books } = play(emptyTurnBooks(), [G + 39], () => clockOf({ ready: true, coldStartedAt: G + 15 }))
    expect(trail).toEqual([
      { kind: "count", metric: "turn.skipped_cold", value: 2 },
      { kind: "row", message: "turns skipped while clock settled", data: { from: 1, to: 3, count: 2 } },
    ])
    expect(books.sealed.size).toBe(0)
  })

  it("a late stored read: the re-run seals nothing twice and the top-up applies the stored ban", () => {
    // released at 3 s with no stored evidence: a late join, turns 0..2 skipped
    let { books } = play(emptyTurnBooks(), [G + 39], () => clockOf({ ready: true, coldStartedAt: G + 39 }, { viaDoor: () => true }))
    const stored: StoredVotes = {
      ...saved(emptyTurnBooks()),
      banned: [D],
      firstOpenedTurn: 0,
      autoSeals: { 0: [B, C] },
      turnVotes: { 0: { B: "notperson" } as never },
      videoRoleHistory: SEEN,
    }
    books = restoreBooks(books, stored, true).books
    const topUp = topUpBooks(books, worldOf(books))
    expect(topUp.trail).toEqual([
      { kind: "row", message: "turn topped up", data: { turn: 1, round: 0, auto: [C], rejected: [D] } },
      { kind: "row", message: "turn topped up", data: { turn: 2, round: 0, auto: [B], rejected: [D] } },
    ])
  })

  it("a replayed sealed turn: a tap overrides the seal, an undo of a ban restores it", () => {
    let { books } = play({ ...emptyTurnBooks(), videoRoleHistory: SEEN }, [G - 5, G + 3, G + 13], () => clockOf({ ready: true }))
    // the clock steps back into turn 0, already sealed with B, C, D defaulted
    books = play(books, [G + 8], () => clockOf({ ready: true })).books
    const tap = castTap(books, 0, 0, B, "person")
    expect(tap.trail).toEqual([
      { kind: "row", message: "tap", data: { turn: 0, round: 0, target: B, verdict: "person" } },
      { kind: "row", message: "seal overridden", data: { turn: 0, target: B } },
    ])
    books = castTap(banPlayer(tap.books, C), 0, 0, C, "notperson", "ban").books
    const undo = unbanPlayer(books, C, { turn: 0, round: 0, roundTurn: 0 }, worldOf(books))
    expect(undo.trail).toEqual([{ kind: "row", message: "seal restored", data: { turn: 0, round: 0, target: C } }])
  })

  it("unbanning in a normal open turn clears a ban that overwrote a Person tap", () => {
    let { books } = play({ ...emptyTurnBooks(), videoRoleHistory: SEEN }, [G - 5, G + 3], () => clockOf({ ready: true }))
    books = castTap(books, 0, 0, C, "person").books
    books = castTap(banPlayer(books, C), 0, 0, C, "notperson", "ban").books

    const undo = unbanPlayer(books, C, { turn: 0, round: 0, roundTurn: 0 }, worldOf(books))

    expect(undo.books.turnVotes[0]?.[C]).toBeUndefined()
    expect(undo.books.banVotes[0]).not.toContain(C)
    expect(undo.trail).toEqual([{ kind: "row", message: "tap", data: { turn: 0, round: 0, target: C, verdict: "undecided" } }])
  })

  it("unbanning on a replayed sealed turn preserves an earlier Person tap", () => {
    let { books } = play({ ...emptyTurnBooks(), videoRoleHistory: SEEN }, [G - 5, G + 3], () => clockOf({ ready: true }))
    books = castTap(books, 0, 0, C, "person").books
    books = play(books, [G + 15], () => clockOf({ ready: true })).books
    books = castTap(banPlayer(books, C), 1, 0, C, "notperson", "ban").books

    // Replaying turn 0 reapplies the ban without overwriting its existing tap.
    books = play(books, [G + 8], () => clockOf({ ready: true })).books
    const undo = unbanPlayer(books, C, { turn: 0, round: 0, roundTurn: 0 }, worldOf(books))

    expect(undo.books.turnVotes[0]?.[C]).toBe("person")
    expect(undo.books.autoSeals[0]).not.toContain(C)
  })

  it("unbanning on a replayed sealed turn preserves an earlier NotPerson tap and its seal provenance", () => {
    let { books } = play({ ...emptyTurnBooks(), videoRoleHistory: SEEN }, [G - 5, G + 3], () => clockOf({ ready: true }))
    books = castTap(books, 0, 0, C, "notperson").books
    books = play(books, [G + 15], () => clockOf({ ready: true })).books
    books = castTap(banPlayer(books, C), 1, 0, C, "notperson", "ban").books

    books = play(books, [G + 8], () => clockOf({ ready: true })).books
    const undo = unbanPlayer(books, C, { turn: 0, round: 0, roundTurn: 0 }, worldOf(books))

    expect(undo.books.turnVotes[0]?.[C]).toBe("notperson")
    expect(undo.books.autoSeals[0]).not.toContain(C)
  })

  it("the tick reads the bans as last rendered, never the books' own", () => {
    const { books } = play({ ...emptyTurnBooks(), videoRoleHistory: SEEN }, [G - 5, G + 3], () => clockOf({ ready: true }))
    const next = calculateSnapshot(G + 13, timing)
    const rendered = tickBooks(books, next, clockOf({ ready: true }), { ...worldOf(books), banned: new Set([C]) }).books
    expect(rendered.turnVotes[1]?.[C]).toBe("notperson")
    const unrendered = tickBooks(banPlayer(books, D), next, clockOf({ ready: true }), worldOf(books)).books
    expect(unrendered.turnVotes[1]?.[D]).toBeUndefined()
  })
})
