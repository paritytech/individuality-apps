// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE TURN BOOKS — the game session's turn bookkeeping as pure functions
 * (#547).
 *
 * `useGameSession` stays the runner: it holds ONE books value (a ref, the
 * authority, mirrored into React state for the render), and hands every
 * event to `turnBooks(books, event, world)`:
 *
 *  - `tick` from the tick, with the snapshot and the clock reading;
 *  - `restore` from the stored-votes read (#429, #567, #570);
 *  - `top-up` from the effect that runs after the merged books render;
 *  - `tap`, `ban` and `unban` from the gestures.
 *
 * Each event has its own exported function as well (tickBooks, restoreBooks,
 * topUpBooks, castTap, banPlayer, unbanPlayer), which the tests drive.
 *
 * Each returns the next books and the TRAIL: the vote-trail rows the session
 * logs (tag "vote"), in order, interleaved with the two commands the tick
 * issues (the away latch and the cold-skip count), because the away latch
 * writes a trail row of its own and must land between the rows in that
 * order. Nothing here reads a clock, storage or the network: every such read
 * is handed in (`TurnClock`, `TurnWorld`).
 *
 * The entry takes an event union, not a clock state: the tick's context is
 * wider than a clock state, and the gestures write the same books.
 *
 * THE CONTRACT (seven clauses; lib/turn-books.test.ts states each as a
 * property over generated event sequences):
 *  1. Monotone seals: the sealed set only grows, a turn is sealed at most
 *     once, and a backward snapshot (a defensive case: the shown game time
 *     never moves back) re-opens a turn but never seals one.
 *  2. Missed turns are rejects: once settled, every ended turn from the
 *     player's entry on holds a verdict for each co-player eligible in it.
 *  3. Late join is not charged: a turn that ended before a genuine late
 *     joiner's load holds no verdict.
 *  4. Taps win: no seal or merge files NotPerson over the player's Person.
 *  5. The ban holds by account: every turn opened after a ban holds a
 *     deliberate NotPerson for the banned, eligible, untapped player.
 *  6. Monotone evidence: a video boundary never moves later, and a pending
 *     observation binds to the first trustworthy turn that opens after it.
 *  7. Idempotence: the same reading twice changes nothing.
 *
 * The hook's refs are fields here. Where the hook reads a value AS LAST
 * RENDERED (the votes, the bans, the roster), the world hands that rendered
 * value in, so the reducer sees exactly what the hook's closures see.
 */
import { calculateSnapshot } from "@jollity/game-chain/game"
import type { GameSnapshot, GameTimingInfo } from "@jollity/game-chain"
import type { ChainClockState, PlayerId } from "./game-source"
import type { Vote } from "./game-session"
import type { StoredVotes } from "./game-votes"
import { sealTurnVotes, type AutoSeals, type TurnVotes } from "./game-roster"
import {
  bindPendingVideoRoles,
  mergeVideoRoleHistory,
  videoRoleEligible,
  type VideoRoleHistory,
} from "./video-role-history"

/** every game-scoped value the turn bookkeeping reads or writes */
export interface TurnBooks {
  /** votes are PER TURN, keyed `round * stride + hostPosition`, all stored */
  turnVotes: TurnVotes
  /** the default NotPerson each sealed turn filed, by turn key */
  autoSeals: AutoSeals
  /** the deliberate NotPerson votes a ban wrote, by turn key */
  banVotes: AutoSeals
  /** the turns this page (or the stored books) sealed */
  sealed: ReadonlySet<number>
  /** bumped by a seal that changes no vote (nobody to cast for), so the save
   *  still writes it: the stored seals are the record of the turns a page
   *  lived through, which the away check reads (#599) */
  sealEpoch: number
  /** how many turns this page sealed, for the report-built telemetry */
  turnsSealed: number
  /** the turn the last tick had open, -1 for none */
  prevTurn: number
  /** the last turn sealed (or skipped past), -1 for none */
  lastSealedTurn: number
  /** this page was alive before turn 0: the sealing loop may start at 0 */
  presentBeforeFirstTurn: boolean
  /** the first turn this page opened (or the stored books name) */
  firstOpenedTurn: number | undefined
  /** the first turn THIS page opened itself (openTurn observed it), never
   *  merged with the stored books: restoreBooks may lower firstOpenedTurn to
   *  a turn this page never lived through, so a floor that runs on this
   *  page's own evidence starts here, not there (archive#1504) */
  pageFirstOpenedTurn: number | undefined
  /** the first turn the STORED books say this player opened in this game:
   *  proof of a rejoin, as opposed to a genuine late join (#527) */
  restoredFirstOpenedTurn: number | undefined
  /** the turns the stored books hold sealed, once the stored read has
   *  answered (undefined until then): the turns some page lived through */
  restoredSealed: ReadonlySet<number> | undefined
  /** decoded-frame history (#426, #562) */
  videoRoleHistory: VideoRoleHistory
  /** THE BAN SET. Keyed by the player, never by the seat: the chain deals a
   *  fresh permutation of seats every round, so a seat-keyed ban would follow
   *  the chair instead of the person. */
  banned: ReadonlySet<PlayerId>
  /** the cold clock's one retroactive reconcile has run */
  coldReconciled: boolean
  /** the turns completed when the clock first settled: the re-run after a
   *  slow stored read reconciles up to the same boundary, and the turns after
   *  it, which this page attended, are sealed by the tick as it moves (#570) */
  coldReadyBoundary: number | undefined
  coldSkipRecorded: boolean
  /** the turns this page sealed before a late stored read merged and the
   *  stored books did not: topped up once the merged books render (#567) */
  topUpTurns: readonly number[]
  topUpEpoch: number
}

export function emptyTurnBooks(): TurnBooks {
  return {
    turnVotes: {},
    autoSeals: {},
    banVotes: {},
    sealed: new Set(),
    sealEpoch: 0,
    turnsSealed: 0,
    prevTurn: -1,
    lastSealedTurn: -1,
    presentBeforeFirstTurn: false,
    firstOpenedTurn: undefined,
    pageFirstOpenedTurn: undefined,
    restoredFirstOpenedTurn: undefined,
    restoredSealed: undefined,
    videoRoleHistory: {},
    banned: new Set(),
    coldReconciled: false,
    coldReadyBoundary: undefined,
    coldSkipRecorded: false,
    topUpTurns: [],
    topUpEpoch: 0,
  }
}

/** one entry of the trail: a vote-trail row, or a command the runner issues
 *  at that point between the rows */
export type TurnBooksStep =
  | { kind: "row"; message: string; data: Record<string, unknown> }
  /** the away latch (#201, #599): the runner's markAway, which logs a row */
  | { kind: "away" }
  /** a telemetry count, `recordCount(metric, value, {})` */
  | { kind: "count"; metric: string; value: number }

export interface TurnBooksResult {
  books: TurnBooks
  trail: TurnBooksStep[]
}

/** the tick's result: how far it got. `cold`: the clock is not ready, the
 *  snapshot is not published. `held`: published, but the bookkeeping waits
 *  for the stored read. `ran`: the bookkeeping ran. */
export interface TurnTickResult extends TurnBooksResult {
  stage: "cold" | "held" | "ran"
}

export interface RemountClockState {
  /** undefined before the first tick, a second when that tick qualifies, null otherwise */
  boundarySecond: number | null
  /** the source state, with the captured boundary exposed as a cold start only after restore */
  state: ChainClockState | undefined
}

/**
 * Preserve one exact remount boundary across the asynchronous stored-votes read.
 * Only the first tick qualifies: it must already be inside the live game
 * (round, gap or reporting), with a ready warm clock. A real cold start and
 * every later tick leave no remount boundary. The override is exposed only
 * after stored first-turn or waiting-room-door evidence proves this is a
 * rejoin, not a late join.
 */
export function remountClockState(
  boundarySecond: number | null | undefined,
  state: ChainClockState | undefined,
  snapshot: GameSnapshot,
  tickSecond: number,
  restoredFirstOpenedTurn: number | undefined,
  restoredViaDoor = false,
): RemountClockState {
  const boundary =
    boundarySecond !== undefined
      ? boundarySecond
      : state?.ready &&
          state.coldStartedAt === undefined &&
          (snapshot.kind === "round" || snapshot.kind === "between-rounds" || snapshot.kind === "reporting")
        ? tickSecond
        : null
  return {
    boundarySecond: boundary,
    state:
      typeof boundary === "number" &&
      (restoredFirstOpenedTurn !== undefined || restoredViaDoor) &&
      state?.ready &&
      state.coldStartedAt === undefined
        ? { ...state, coldStartedAt: boundary }
        : state,
  }
}

/** what the tick reads besides the snapshot */
export interface TurnClock {
  timing: GameTimingInfo
  /** the source's `clockState()`; undefined for a source without one */
  state: ChainClockState | undefined
  /** an account whose stored read has not answered nor been released yet */
  restorePending: boolean
  /** the page froze for at least the away threshold between this tick and
   *  the last (the GAME clock jumped), outside the confirm stage. A frozen
   *  page fires no event; the runner measures the gap. */
  frozeAway: boolean
  /** the game source has registered its clock (`chainNowMs() !== null`) */
  chainSeen: () => boolean
  /** this device came through the waiting-room door for this game (#532) */
  viaDoor: () => boolean
}

/** the game's roster, AS LAST RENDERED: the tick's interval outlives the
 *  render, and the hook refreshes these after every commit */
export interface TurnWorld {
  /** the turn key's stride: `maxGroupSize`, fixed for the game */
  stride: number
  /** who turn `roundTurn` of `round` could judge: every seat holder of that
   *  round's group but its host, you and the empty chairs, in seat order.
   *  Read in THAT turn's round, never the one on screen: at a round change
   *  the tick runs before the render that draws the new group. */
  candidates: (round: number, roundTurn: number) => PlayerId[]
  /** the turn's host, for the trail */
  host: (round: number, roundTurn: number) => PlayerId | "none"
  /** the bans as last rendered */
  banned: ReadonlySet<PlayerId>
  /** the votes as last rendered: the seal's trail and its auto list are
   *  computed from these, while the write merges onto the latest books */
  renderedVotes: TurnVotes
}

/** who a turn's SEAL can reject: everyone who was there to judge and whose
 *  video made them eligible in that turn (#426) */
export function sealablePlayers(
  books: Pick<TurnBooks, "videoRoleHistory">,
  world: Pick<TurnWorld, "candidates">,
  round: number,
  roundTurn: number,
  globalTurn: number,
): PlayerId[] {
  return world
    .candidates(round, roundTurn)
    .filter((id) => videoRoleEligible(books.videoRoleHistory, id, globalTurn))
}

/** which players turn `roundTurn` of `round` must open already rejected */
function bannedRejects(
  books: Pick<TurnBooks, "videoRoleHistory">,
  world: Pick<TurnWorld, "candidates" | "banned">,
  round: number,
  roundTurn: number,
  globalTurn: number,
): Partial<Record<PlayerId, Vote>> {
  const rejects: Partial<Record<PlayerId, Vote>> = {}
  if (world.banned.size === 0) return rejects
  for (const id of sealablePlayers(books, world, round, roundTurn, globalTurn))
    if (world.banned.has(id)) rejects[id] = "notperson"
  return rejects
}

function hasBanVote(books: Pick<TurnBooks, "banVotes">, turn: number, id: PlayerId): boolean {
  return books.banVotes[turn]?.includes(id) ?? false
}

function setBanVote(books: TurnBooks, turn: number, id: PlayerId, written: boolean): void {
  const current = books.banVotes[turn] ?? []
  const next = written
    ? current.includes(id) ? current : [...current, id]
    : current.filter((other) => other !== id)
  if (next.length === current.length && next.every((other, index) => other === current[index])) return
  books.banVotes = { ...books.banVotes, [turn]: next }
}

function samePlayerLists(left: AutoSeals, right: AutoSeals): boolean {
  const turns = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...turns].every((turnKey) => {
    const turn = Number(turnKey)
    const a = left[turn] ?? []
    const b = right[turn] ?? []
    return a.length === b.length && a.every((id) => b.includes(id))
  })
}

const FIELDS = Object.keys(emptyTurnBooks()) as (keyof TurnBooks)[]

/** the input books when nothing changed, so a quiet tick re-renders nothing */
function settle(before: TurnBooks, after: TurnBooks): TurnBooks {
  return FIELDS.every((field) => Object.is(before[field], after[field])) ? before : after
}

/**
 * THE TICK. The hook ticks the real state machine twice a second once there
 * is a game, and hands each snapshot here.
 *
 * The gap has no active turn, but it must not erase how far this mounted
 * session got. If its timers then sleep, the return tick resumes replay
 * after the last sealed turn. A fresh mount keeps prevTurn and lastSealedTurn
 * at -1 and does not invent votes for turns the player never attended.
 */
export function tickBooks(
  books: TurnBooks,
  snap: GameSnapshot,
  clock: TurnClock,
  world: TurnWorld,
): TurnTickResult {
  const b: TurnBooks = { ...books }
  const trail: TurnBooksStep[] = []
  const row = (message: string, data: Record<string, unknown>) => trail.push({ kind: "row", message, data })
  const done = (stage: TurnTickResult["stage"]): TurnTickResult => ({ books: settle(books, b), trail, stage })
  const { timing, state: clockState } = clock
  const stride = world.stride

  // a turn closed → everyone votable you did NOT accept is auto-rejected,
  // stored like any other vote so the confirm prediction sees it
  const sealTurn = (turn: number, opened: Partial<Record<PlayerId, Vote>> = {}) => {
    if (turn < 0) return
    if (b.sealed.has(turn)) {
      b.lastSealedTurn = Math.max(b.lastSealedTurn, turn)
      return
    }
    const round = Math.floor(turn / stride)
    const players = sealablePlayers(b, world, round, turn % stride, turn)
    // A throttled tick may open and seal this turn in one pass, before React
    // commits the opened ban rejects into the rendered votes. Carry those
    // rejects into the seal so they stay deliberate ban votes, not
    // auto-rejections.
    const votes = { ...opened, ...(world.renderedVotes[turn] ?? {}) }
    const { auto, tapped } = sealTurnVotes(votes, players)
    b.autoSeals = { ...b.autoSeals, [turn]: auto }
    b.sealed = new Set(b.sealed).add(turn)
    b.lastSealedTurn = Math.max(b.lastSealedTurn, turn)
    b.turnsSealed++
    row("turn sealed", { turn, round, host: world.host(round, turn % stride), tapped, auto })
    if (players.length === 0) {
      b.sealEpoch++
      return
    }
    const current = b.turnVotes
    const sealed = { ...opened, ...(current[turn] ?? {}) }
    for (const id of players) sealed[id] ??= "notperson"
    b.turnVotes = { ...current, [turn]: sealed }
  }
  // a turn opened → every banned member who is votable in it is rejected
  // again, with no second tap. The ban outlives the turn that cast it. The
  // pending video evidence binds to this turn first (#426): an observation
  // made before a trustworthy turn existed belongs to the first one opened.
  const openTurn = (
    turn: number,
    round: number,
    roundTurn: number,
    observed = false,
  ): Partial<Record<PlayerId, Vote>> => {
    if (observed) {
      b.firstOpenedTurn = b.firstOpenedTurn ?? turn
      b.pageFirstOpenedTurn = b.pageFirstOpenedTurn ?? turn
    }
    const bound = bindPendingVideoRoles(b.videoRoleHistory, turn)
    if (bound.changed) b.videoRoleHistory = bound.history
    const rejects = bannedRejects(b, world, round, roundTurn, turn)
    for (const id of Object.keys(rejects)) {
      const existing = b.turnVotes[turn]?.[id]
      if (existing === undefined) setBanVote(b, turn, id, true)
    }
    if (Object.keys(rejects).length > 0)
      b.turnVotes = { ...b.turnVotes, [turn]: { ...rejects, ...(b.turnVotes[turn] ?? {}) } }
    return rejects
  }
  const openGlobalTurn = (turn: number) => openTurn(turn, Math.floor(turn / stride), turn % stride)
  // Replay every completed turn between the last tick and this one. A page
  // suspended across several turns gets one tick on return; each missed
  // turn must still open (ban rejects) and seal (defaults) in order.
  const sealThrough = (completedExclusive: number) => {
    const previous = b.prevTurn
    const lastProcessed = previous >= 0 ? previous : b.lastSealedTurn
    // The entry floor comes from monotone evidence, as in the model
    // (turn-books.definition.ts), never from prevTurn: a backward tick
    // rewrites it, so it must not decide how far this page got or whether it
    // attended (#390 gaps 1, 3). Not clamped by coldReadyBoundary: the
    // rejoin replay would then seal nothing (#1178).
    // Unless the page was present before turn 0 (the cold reconcile sets
    // that flag before it replays), a page that opened a turn itself seals
    // nothing below the first turn IT opened, whatever its cursor: a
    // restored firstOpenedTurn is not evidence this page attended the turns
    // after it, so it never lowers that floor, and with no cursor it does
    // not open one either (archive#1504). Only a page that opened no turn
    // and holds a cursor falls back to the merged firstOpenedTurn.
    const floor = b.presentBeforeFirstTurn
      ? 0
      : (b.pageFirstOpenedTurn ?? (lastProcessed < 0 ? undefined : b.firstOpenedTurn) ?? -1)
    if ((lastProcessed < 0 && floor < 0) || completedExclusive <= lastProcessed) return
    if (previous >= 0 && previous >= floor) sealTurn(previous)
    for (let missed = Math.max(floor, lastProcessed + 1); missed < completedExclusive; missed++) {
      const rejects = openGlobalTurn(missed)
      sealTurn(missed, rejects)
    }
  }
  const activeTurn = (s: GameSnapshot): number => (s.kind === "round" ? s.round * stride + s.hostPosition : -1)
  const completedTurns = (s: GameSnapshot): number =>
    s.kind === "round"
      ? activeTurn(s)
      : s.kind === "between-rounds"
        ? s.nextRound * stride
        : s.kind === "reporting" || s.kind === "finished"
          ? timing.rounds * stride
          : 0

  if (clockState && !clockState.ready) {
    // Defensive: a clock that is not ready cannot place a turn (only test
    // sources model one; the shipped source's clock is ready at once). Keep
    // the last trustworthy screen and forget its turn bookkeeping;
    // publishing this snapshot could regress a reloaded live game to the
    // waiting room and tear its mesh down.
    b.prevTurn = -1
    return done("cold")
  }
  // Replaying genuine pre-load misses must merge with restored votes, not
  // win the initial storage race and cause the restore to be discarded.
  if (clockState?.coldStartedAt !== undefined && clock.restorePending) return done("held")
  let reconciledColdNow = false
  if (clockState?.coldStartedAt !== undefined && !b.coldReconciled) {
    // THE COLD RECONCILE: the clock became ready inside the running game, so
    // the turns that ended before the load, and while the clock settled, are
    // decided once, here. It runs again after a stored read that lands past
    // the 3 s release (restoreBooks resets it), up to the boundary this first
    // pass saw, never the clock of now (#570).
    const loaded = calculateSnapshot(clockState.coldStartedAt, timing)
    const beforeLoad = completedTurns(loaded)
    const beforeReady = b.coldReadyBoundary ?? completedTurns(snap)
    b.coldReadyBoundary = beforeReady
    // A REJOIN WAS IN THIS GAME BEFORE; a genuine late join never was.
    // Evidence, any of: the stored books name a first-opened turn
    // (restoredFirstOpenedTurn — a provisional open of this very page,
    // firstOpenedTurn, proves nothing alone), or this device came through
    // the waiting room (a crash in the connect phase saved no first turn).
    // presentBeforeFirstTurn is the separate "alive before turn 0" flag
    // the sealing loop reads. The rejoin sat out every turn that ended
    // before the load AND while the clock settled, so all of them seal as
    // NotPerson (missed turn stays a reject, #527). The late join keeps
    // those players unseen.
    const storedOpened = b.restoredFirstOpenedTurn
    const viaDoor = clock.viaDoor()
    const rejoinFrom = storedOpened ?? (viaDoor ? 0 : undefined)
    const rejoined = rejoinFrom !== undefined && beforeReady > rejoinFrom
    // A REJOIN AFTER TURNS NO PAGE LIVED THROUGH WAS AWAY (#201, #599): a
    // page killed in the background comes back visible and clear of the
    // latch, and its missed turns are sealed NotPerson below, the default
    // verdicts #201 keeps from being auto-filed. A turn the stored books
    // hold sealed had a page alive to its end; one before this load that
    // they do not hold had none. Judged only once the stored read
    // answered. A first-time late join is not marked (an open question).
    const held = b.restoredSealed
    if (rejoined && held && rejoinFrom !== undefined)
      for (let turn = rejoinFrom; turn < beforeLoad; turn++)
        if (!held.has(turn)) {
          const round = Math.floor(turn / stride)
          const needsDefault = sealablePlayers(b, world, round, turn % stride, turn)
            .some((id) => !world.banned.has(id) && world.renderedVotes[turn]?.[id] === undefined)
          if (!needsDefault) continue
          trail.push({ kind: "away" })
          break
        }
    const replaysPreLoad = b.firstOpenedTurn !== undefined && beforeLoad > b.firstOpenedTurn
    if (rejoined || replaysPreLoad) {
      // The clock can turn ready before the game window lands (two reads
      // in game-source), so this page may already have opened, and even
      // sealed, a turn on its own (a tick outside a round clears prevTurn
      // but keeps lastSealedTurn). Restart the replay from the evidence, as
      // the released read does; restored and live seals stay as they are
      // (#1178).
      if (b.prevTurn >= 0 || b.lastSealedTurn >= 0) {
        b.prevTurn = -1
        b.lastSealedTurn = -1
      }
      b.presentBeforeFirstTurn = true
      b.lastSealedTurn = Math.max(b.lastSealedTurn, (rejoinFrom ?? b.firstOpenedTurn ?? 0) - 1)
      sealThrough(rejoined ? beforeReady : beforeLoad)
    } else {
      // A genuine late join keeps those players unseen. Advance the book
      // without inventing votes for turns before this page existed.
      b.lastSealedTurn = Math.max(b.lastSealedTurn, beforeLoad - 1)
    }
    const skippedCold = rejoined ? 0 : Math.max(0, beforeReady - beforeLoad)
    if (skippedCold > 0) {
      b.lastSealedTurn = Math.max(b.lastSealedTurn, beforeReady - 1)
      if (!b.coldSkipRecorded) {
        trail.push({ kind: "count", metric: "turn.skipped_cold", value: skippedCold })
        row("turns skipped while clock settled", { from: beforeLoad, to: beforeReady, count: skippedCold })
        b.coldSkipRecorded = true
      }
    }
    b.coldReconciled = true
    reconciledColdNow = true
  }
  // a frozen page fires no event: the GAME clock jumping between two ticks
  // is the only sign (the runner measures it), and the cold reconcile's own
  // tick is not one
  if (!reconciledColdNow && clock.frozeAway) trail.push({ kind: "away" })
  if (
    (snap.kind === "idle" || snap.kind === "waiting-room") &&
    clock.chainSeen() &&
    b.prevTurn < 0 &&
    b.lastSealedTurn < 0
  )
    b.presentBeforeFirstTurn = true
  const turn = activeTurn(snap)
  const completed = completedTurns(snap)
  // Two non-round snapshots both use -1 as their active turn. A page can
  // sleep in the gap and wake in reporting, so compare their completed
  // boundary too; otherwise that whole last round looks unchanged. Whether
  // the replay then seals anything is sealThrough's own gate: a restored
  // firstOpenedTurn alone opens nothing while this page holds no position.
  const missedNonRoundBoundary =
    turn < 0 &&
    (b.prevTurn >= 0 || b.lastSealedTurn >= 0 || b.presentBeforeFirstTurn || b.firstOpenedTurn !== undefined) &&
    completed > b.lastSealedTurn + 1
  if (turn !== b.prevTurn || missedNonRoundBoundary) {
    if (turn >= 0 && snap.kind === "round") {
      if (turn > b.prevTurn) sealThrough(turn)
      // Should a snapshot ever move back (the shown game time never does,
      // lib/clock-sync.ts), it revisits an older turn; it does not complete
      // the newer turn we just left. Sealing only on forward progress keeps
      // both turns' original evidence intact (#390).
      openTurn(turn, snap.round, snap.hostPosition, true)
      b.prevTurn = turn
    } else {
      if (completed > b.prevTurn) sealThrough(completed)
      b.prevTurn = -1
    }
  }
  return done("ran")
}

/**
 * THE RESTORE MERGE (lib/game-votes): the votes, seals, bans, first-opened
 * turn and video history stored for this game come back and merge with
 * whatever this page already holds. (The confirm overrides, their #871
 * provenance and the stored away latch are not turn books: the runner
 * merges them.) `released`: the 3 s release already let the cold reconcile
 * run without them, so it is re-armed here and runs again on the next tick.
 */
export function restoreBooks(books: TurnBooks, stored: StoredVotes | null, released: boolean): TurnBooksResult {
  const b: TurnBooks = { ...books }
  const trail: TurnBooksStep[] = []
  b.restoredSealed = new Set(stored ? Object.keys(stored.autoSeals).map(Number) : [])
  if (stored) {
    b.videoRoleHistory = mergeVideoRoleHistory(b.videoRoleHistory, stored.videoRoleHistory)
    // A STORED TAP BEATS A LOCAL DEFAULT, A LOCAL TAP BEATS A STORED DEFAULT
    // (#429). Compared against the local pre-restore seals.
    const localAutoSeals = b.autoSeals
    const current = b.turnVotes
    const merged = { ...stored.turnVotes }
    const mergedAuto: AutoSeals = { ...stored.autoSeals }
    const mergedBanVotes: AutoSeals = { ...(stored.banVotes ?? {}) }
    for (const [turnKey, votes] of Object.entries(current)) {
      const turn = Number(turnKey)
      const storedVotes = merged[turn] ?? {}
      const currentAuto = new Set(localAutoSeals[turn] ?? [])
      const storedAuto = new Set(stored.autoSeals[turn] ?? [])
      const combined = { ...storedVotes }
      for (const [id, vote] of Object.entries(votes)) {
        if (currentAuto.has(id) && storedVotes[id] !== undefined && !storedAuto.has(id)) continue
        combined[id] = vote
        const localBanVote = hasBanVote(b, turn, id)
        const banIds = mergedBanVotes[turn] ?? []
        mergedBanVotes[turn] = localBanVote
          ? banIds.includes(id) ? banIds : [...banIds, id]
          : banIds.filter((banId) => banId !== id)
        // The local verdict is a tap (or deliberate ban), not a default.
        // When it replaces a stored default, its provenance must replace the
        // stored auto-seal marker too; otherwise the books contradict their
        // own verdict and a later restore can misclassify the tap (#1214).
        if (!currentAuto.has(id) && storedAuto.has(id))
          mergedAuto[turn] = (mergedAuto[turn] ?? []).filter((autoId) => autoId !== id)
      }
      merged[turn] = combined
    }
    b.turnVotes = merged
    b.banned = new Set([...stored.banned, ...b.banned])
    for (const [turnKey, ids] of Object.entries(localAutoSeals)) {
      const turn = Number(turnKey)
      const storedVotes = stored.turnVotes[turn] ?? {}
      const storedAuto = new Set(stored.autoSeals[turn] ?? [])
      mergedAuto[turn] = [
        ...(mergedAuto[turn] ?? []),
        ...ids.filter((id) => storedVotes[id] === undefined || storedAuto.has(id)),
      ].filter((id, index, all) => all.indexOf(id) === index)
    }
    b.autoSeals = mergedAuto
    if (!samePlayerLists(b.banVotes, mergedBanVotes)) b.banVotes = mergedBanVotes
    // A turn this page sealed before the merge was sealed on its own
    // history alone, which on a slow relaunch is empty. The stored books
    // can make more co-players eligible in it; taken before the union
    // below, which marks every turn sealed.
    const topUp = [...b.sealed].filter((turn) => stored.autoSeals[turn] === undefined)
    if (topUp.length > 0) {
      b.topUpTurns = topUp
      b.topUpEpoch++
    }
    const sealed = Object.keys(stored.autoSeals).map(Number)
    b.sealed = new Set([...sealed, ...b.sealed])
    const storedFirst = stored.firstOpenedTurn ?? (sealed.length > 0 ? Math.min(...sealed) : undefined)
    b.restoredFirstOpenedTurn = storedFirst
    const currentFirst = b.firstOpenedTurn
    b.firstOpenedTurn =
      currentFirst === undefined ? storedFirst : storedFirst === undefined ? currentFirst : Math.min(currentFirst, storedFirst)
  }
  if (released) {
    // The bounded pass lacked stored attendance evidence. Re-run it now;
    // restored seals make this idempotent and the cold skip is re-applied,
    // up to the boundary the first pass saw, never the clock of now (#570).
    // Keep the live progress cursors: the cold pass resets them itself when
    // restored evidence needs a replay, while a late joiner still needs them
    // to seal turns attended after the three-second release.
    b.coldReconciled = false
  }
  return { books: settle(books, b), trail }
}

/**
 * THE LATE RESTORE'S TOP-UP (#567). A turn sealed before a slow stored read
 * merged is sealed again on the merged books, exactly as a prompt read would
 * have sealed it: the stored ban rejects that turn's banned co-players, every
 * other eligible one still undecided defaults to NotPerson. It only adds:
 * a vote already cast, a tap above all, stays. The runner calls it after the
 * merged books have rendered, so the world it hands in carries the merged
 * history, bans and votes.
 */
export function topUpBooks(books: TurnBooks, world: TurnWorld): TurnBooksResult {
  const turns = books.topUpTurns
  const stride = world.stride
  if (turns.length === 0 || stride <= 0) return { books, trail: [] }
  const b: TurnBooks = { ...books, topUpTurns: [] }
  const trail: TurnBooksStep[] = []
  const adds: TurnVotes = {}
  for (const turn of turns) {
    const round = Math.floor(turn / stride)
    const rejects = bannedRejects(b, world, round, turn % stride, turn)
    for (const id of Object.keys(rejects)) {
      const existing = b.turnVotes[turn]?.[id]
      if (existing === undefined) setBanVote(b, turn, id, true)
    }
    const cast = world.renderedVotes[turn] ?? {}
    const { votes, auto } = sealTurnVotes({ ...rejects, ...cast }, sealablePlayers(b, world, round, turn % stride, turn))
    const added = Object.fromEntries(Object.entries(votes).filter(([id]) => cast[id] === undefined))
    if (Object.keys(added).length === 0) continue
    adds[turn] = added
    const already = b.autoSeals[turn] ?? []
    b.autoSeals = {
      ...b.autoSeals,
      [turn]: [...already, ...auto.filter((id) => !already.includes(id))],
    }
    trail.push({
      kind: "row",
      message: "turn topped up",
      data: { turn, round, auto, rejected: Object.keys(rejects).filter((id) => cast[id] === undefined) },
    })
  }
  if (Object.keys(adds).length > 0) {
    const current = b.turnVotes
    const next = { ...current }
    for (const [turnKey, added] of Object.entries(adds)) next[Number(turnKey)] = { ...added, ...(current[Number(turnKey)] ?? {}) }
    b.turnVotes = next
  }
  return { books: settle(books, b), trail }
}

/**
 * A TAP in the open turn `turn` of `round`. The gesture carries the verdict.
 *
 * A REPLAYED SEALED TURN (#569). A snapshot that moves back (a defensive
 * case: the shown game time never does) re-opens a turn the page already
 * sealed (#390 seals forward only). A real tap or ban on it wins over the
 * seal's default, so the player
 * leaves that turn's autoSeals entry and the trail counts only the defaults
 * that still stand (autoTurns, countReport.autoOnly). The entry's key stays,
 * even empty: it is the record that the turn was sealed (restore, top-up,
 * away check). The tap still needs the co-player seen (votable, #603).
 */
export function castTap(
  books: TurnBooks,
  turn: number,
  round: number,
  id: PlayerId,
  verdict: Vote,
  source: "player" | "ban" = "player",
): TurnBooksResult {
  const b: TurnBooks = { ...books }
  const trail: TurnBooksStep[] = [{ kind: "row", message: "tap", data: { turn, round, target: id, verdict } }]
  const auto = b.autoSeals[turn]
  if (b.sealed.has(turn) && auto?.includes(id)) {
    b.autoSeals = { ...b.autoSeals, [turn]: auto.filter((other) => other !== id) }
    trail.push({ kind: "row", message: "seal overridden", data: { turn, target: id } })
  }
  const existingIsDeliberateNotPerson = b.turnVotes[turn]?.[id] === "notperson" && !auto?.includes(id)
  const existingBanVote = hasBanVote(b, turn, id)
  setBanVote(b, turn, id, source === "ban" && (!existingIsDeliberateNotPerson || existingBanVote))
  b.turnVotes = { ...b.turnVotes, [turn]: { ...(b.turnVotes[turn] ?? {}), [id]: verdict } }
  return { books: b, trail }
}

/** THE BAN, by account: every later turn opened rejects `id` (openTurn). The
 *  runner casts this turn's reject as a tap right after. */
export function banPlayer(books: TurnBooks, id: PlayerId): TurnBooks {
  return { ...books, banned: new Set(books.banned).add(id) }
}

/**
 * The undo chip. It clears the ban AND takes back the reject the ban cast
 * this turn — a banned tile takes no gesture, so that reject can only have
 * come from the ban itself. `open`: the turn on screen, if one is open.
 *
 * ON A REPLAYED SEALED TURN (#569) the undo never deletes a sealed vote.
 * A vote the seal filed itself (the ban re-applied on the replay does not
 * overwrite it) stays as it is. A reject the ban cast in place of the
 * seal's default goes back to that default, and back into autoSeals: it
 * is exactly what the seal files for a player left undecided. A vote the
 * seal never covered (the co-player was not yet eligible in that turn)
 * is taken back as in an open turn.
 */
export function unbanPlayer(
  books: TurnBooks,
  id: PlayerId,
  open: { turn: number; round: number; roundTurn: number } | undefined,
  world: Pick<TurnWorld, "candidates" | "renderedVotes">,
): TurnBooksResult {
  const b: TurnBooks = { ...books }
  const trail: TurnBooksStep[] = []
  if (b.banned.has(id)) {
    const next = new Set(b.banned)
    next.delete(id)
    b.banned = next
  }
  const turnKey = open?.turn ?? -1
  const cast = open !== undefined && hasBanVote(b, turnKey, id)
  if (open && cast && b.sealed.has(turnKey)) {
    if (b.autoSeals[turnKey]?.includes(id)) {
      setBanVote(b, turnKey, id, false)
      return { books: b, trail }
    }
    if (sealablePlayers(b, world, open.round, open.roundTurn, turnKey).includes(id)) {
      b.autoSeals = { ...b.autoSeals, [turnKey]: [...(b.autoSeals[turnKey] ?? []), id] }
      trail.push({ kind: "row", message: "seal restored", data: { turn: turnKey, round: open.round, target: id } })
      b.turnVotes = { ...b.turnVotes, [turnKey]: { ...(b.turnVotes[turnKey] ?? {}), [id]: "notperson" } }
      setBanVote(b, turnKey, id, false)
      // the votes may read the same: the save must still carry the seal
      b.sealEpoch++
      return { books: b, trail }
    }
  }
  if (open && cast) trail.push({ kind: "row", message: "tap", data: { turn: turnKey, round: open.round, target: id, verdict: "undecided" } })
  const current = b.turnVotes[turnKey]
  if (cast && current && current[id] !== undefined) {
    const next = { ...current }
    delete next[id]
    b.turnVotes = { ...b.turnVotes, [turnKey]: next }
  }
  if (cast) setBanVote(b, turnKey, id, false)
  return { books: settle(books, b), trail }
}

/** every event the turn books take */
export type TurnBooksEvent =
  | { kind: "tick"; snapshot: GameSnapshot; clock: TurnClock }
  | { kind: "restore"; stored: StoredVotes | null; released: boolean }
  | { kind: "top-up" }
  | { kind: "tap"; turn: number; round: number; id: PlayerId; verdict: Vote; source?: "player" | "ban" }
  | { kind: "ban"; id: PlayerId }
  | { kind: "unban"; id: PlayerId; open: { turn: number; round: number; roundTurn: number } | undefined }

/** THE ENTRY: one event in, the next books and the trail out. A tick also
 *  says how far it got (`stage`). */
export function turnBooks(books: TurnBooks, event: TurnBooksEvent, world: TurnWorld): TurnBooksResult & { stage?: TurnTickResult["stage"] } {
  switch (event.kind) {
    case "tick":
      return tickBooks(books, event.snapshot, event.clock, world)
    case "restore":
      return restoreBooks(books, event.stored, event.released)
    case "top-up":
      return topUpBooks(books, world)
    case "tap":
      return castTap(books, event.turn, event.round, event.id, event.verdict, event.source)
    case "ban":
      return { books: banPlayer(books, event.id), trail: [] }
    case "unban":
      return unbanPlayer(books, event.id, event.open, world)
  }
}
