// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE CHEST SCREEN — what /chest shows, and when it lets go, as one pure
 * reducer. Its host (./chest-screen-host) runs the commands and the claims
 * feed, and the page renders `chestScreenView` with the vessel it draws (the
 * bubble): the logic does not know which.
 *
 *  C1. Opened: the payoff hears chest-opened, the backstop wait is armed
 *      (lib/slow-payoff SLOW_PAYOFF_MS, from the open) and the feed starts.
 *  C2. The vessel is up as soon as its seed is known (the player and the
 *      game), before any claim: there is no loading ring. With no player, the
 *      screen says so at once.
 *  C3. The seed is set once, so the vessel arrives once.
 *  C4. The first answer with claims: collecting. The payoff hears
 *      chest-result once, with the read's tag and the claims it found. A read
 *      that had failed is reported recovered.
 *  C5. A failed read, or claims earned but not readable yet: still waiting,
 *      the vessel up and empty, the rereads running (lib/chest-reread) while
 *      the restart card is down. Each reread reads at once, whatever the
 *      payoff is doing, and the payoff hears it (chest-reread-due); the
 *      load-chest it may answer with is that same read.
 *  C6. Nothing for this game (in the Pocket already, too old to prove, or
 *      why it is empty; no player): the reason and Continue, and the payoff
 *      hears chest-result.
 *  C7. Claims that come while the game settles (`came`) and the settle's own
 *      read (`settled`) are added by hash, never removed or reordered. The
 *      settle's read makes the chest all in, and refreshes whether some could
 *      not be shown. Nothing says more are coming: they just fly in.
 *  C8. The vessel opens when `chestShouldOpen` says so (lib/chest-collect:
 *      everything in and flown in; COLLECT_MS after it landed, with
 *      something in; or on the first claim after that), or on a tap once
 *      something is in. Once open, it stays open.
 *  C9. Nothing read by the end of the collect wait (COLLECT_MS after the
 *      vessel landed), or by the backstop wait if it never landed: taking
 *      longer than usual, the rewards will be in the chat. The payoff hears
 *      payoff-stalled chest.slow, and a Continue under the vessel leaves
 *      without the chest (chest-skip). Claims that come after it are
 *      collected as ever, and the Continue stays.
 *  C10. A stuck host while waiting puts up the restart card, for good: the
 *      feed, the timers and the rereads stop, and the payoff hears
 *      chest-result, then payoff-stalled chest.load.
 *  C11. The way on: Continue as soon as the vessel has opened; past the slow
 *      wait (C9), Continue even if it never opens.
 *  C12. Continue on the chest: one that is all in is seen (mark-seen), and
 *      the album closes it into the Pocket; the album's end leaves
 *      (chest-continue). On a nothing screen it leaves at once, seen unless
 *      there was no player. Pressed again after leaving, it leaves again (the
 *      host retries the hand-off). A hand-off the host refuses brings the
 *      album's Continue back (`refusals`), so there is always one to press.
 *  C13. A pick on a changeable piece is dealt and saved.
 *  C14. A stale epoch is inert; unmounted stops everything, and nothing
 *      after it acts.
 */
import { canChangePick, normalizeCreditHash, withPicks, type ChestItem, type ChestPicks, type ChestView } from "@jollity/collectables"
import { chestShouldOpen, COLLECT_MS } from "../chest-collect"
import { emptyReason, type ChestEmptyReason } from "../chest-reason"
import { chestRestartVisible, type ChestStallReason } from "../chest-reread"
import type { RestartCardReason } from "../chain-health"
import { chestFacts } from "../journeys/payoff-facts"
import type { PayoffInput, PayoffTag } from "../payoff-machine"
import { SLOW_PAYOFF_MS } from "../slow-payoff"
import type { Attrs } from "../telemetry"

/** at most this many pieces in the vessel (the scene's MAX_PIECES) */
const SHOWN_PIECES = 10

/** why there is nothing to collect this game */
export type NothingWhy = ChestEmptyReason | "pocketed" | "pruned" | "no-identity"

/** a read, as the screen takes it */
export type ChestAnswer =
  | { kind: "claims"; game: number | null; seed: string; items: ChestItem[]; settling: boolean; partial: boolean }
  /** a read that failed, or claims earned that cannot be read yet: read again */
  | { kind: "waiting"; game: number | null; failed: boolean }
  | { kind: "nothing"; game: number | null; why: NothingWhy }

/** the shared health verdict, as the hook reads it */
export interface ChestHealth {
  lost: boolean
  reason?: RestartCardReason
  stall: ChestStallReason
}

export type ChestTimer = "slow" | "collect"

interface Vessel {
  landed: boolean
  /** COLLECT_MS have passed since it landed */
  waited: boolean
  /** pieces that have flown in */
  collected: number
  /** it has opened (asked, or tapped) */
  open: boolean
}

export interface ChestScreenState {
  /** the feed in flight; its answers carry this */
  epoch: number
  phase: "new" | "waiting" | "collecting" | "nothing" | "closed"
  seed: string | null
  game: number | null
  claims: ChestItem[]
  picks: ChestPicks
  stash: ChestPicks
  settling: boolean
  allIn: boolean
  partial: boolean
  why: NothingWhy | null
  /** a read failed and its recovery is not reported yet */
  failed: boolean
  rereads: boolean
  /** nothing came in time (C9) */
  slow: boolean
  restart: { reason: RestartCardReason | undefined } | null
  resultSent: boolean
  vessel: Vessel
  /** the album is closing the chest into the Pocket */
  closing: boolean
  /** hand-offs the host refused while the album was up */
  refusals: number
}

export type ChestScreenEvent =
  | { type: "opened" }
  /** the source resolved: the vessel's seed, or none for no player */
  | { type: "source"; seed: string | null; game: number | null }
  | { type: "answered"; epoch: number; answer: ChestAnswer; tag: PayoffTag; picks?: ChestPicks; stash?: ChestPicks }
  | { type: "came"; epoch: number; items: ChestItem[] }
  | { type: "settled"; epoch: number; items: ChestItem[]; partial: boolean }
  | { type: "health"; health: ChestHealth }
  | { type: "timer"; timer: ChestTimer }
  | { type: "reread-due" }
  /** the payoff's load-chest: its answer to chest-reread-due, whose read has already gone (C5) */
  | { type: "load-chest" }
  /** what the vessel reports */
  | { type: "landed" }
  | { type: "collected"; count: number }
  | { type: "vessel-opened" }
  /** what the player does */
  | { type: "cta" }
  | { type: "album-done" }
  /** the host would not open Humanity */
  | { type: "hand-off-refused" }
  | { type: "pick"; index: number; collectionId: number }
  | { type: "unmounted" }

export type ChestScreenCommand =
  /** `tag: "capture"` is the payoff's tag as it stands */
  | { kind: "payoff"; input: PayoffInput; tag?: PayoffTag | "capture"; facts?: Attrs }
  /** start the claims feed (the first read, then what comes, then the settle's read) */
  | { kind: "read"; epoch: number }
  | { kind: "stop-feed" }
  | { kind: "arm-timer"; timer: ChestTimer; ms: number }
  | { kind: "clear-timer"; timer: ChestTimer }
  | { kind: "rereads"; on: boolean }
  | { kind: "read-recovered" }
  | { kind: "mark-seen"; game: number }
  | { kind: "leave"; via: "chest-continue" | "chest-skip" }
  | { kind: "save-pick"; hash: string; collectionId: number }
  | { kind: "log"; message: string; data?: Record<string, unknown> }

export interface ChestScreenTransition {
  state: ChestScreenState
  commands: ChestScreenCommand[]
}

const NO_VESSEL: Vessel = { landed: false, waited: false, collected: 0, open: false }

export function startChestScreen(): ChestScreenState {
  return {
    epoch: 0,
    phase: "new",
    seed: null,
    game: null,
    claims: [],
    picks: new Map(),
    stash: new Map(),
    settling: false,
    allIn: false,
    partial: false,
    why: null,
    failed: false,
    rereads: false,
    slow: false,
    restart: null,
    resultSent: false,
    vessel: NO_VESSEL,
    closing: false,
    refusals: 0,
  }
}

/** A read's view, as the screen takes it (C4–C6); null is no player. */
export function classifyChest(view: ChestView | null): ChestAnswer {
  if (!view) return { kind: "nothing", game: null, why: "no-identity" }
  const game = view.gameIndex
  if (view.items.length)
    return {
      kind: "claims",
      game,
      seed: view.seed,
      items: view.items,
      settling: view.settling === true,
      partial: view.partial === true,
    }
  if (view.failed) return { kind: "waiting", game, failed: true }
  if (view.pending) return { kind: "waiting", game, failed: false }
  if (view.claimed) return { kind: "nothing", game, why: "pocketed" }
  if (view.unprovable) return { kind: "nothing", game, why: "pruned" }
  return { kind: "nothing", game, why: emptyReason(view) }
}

/** claims added by hash, in the order they came (C7) */
function adding(claims: ChestItem[], items: ChestItem[]): ChestItem[] {
  const have = new Set(claims.map((item) => item.hash))
  const fresh = items.filter((item) => !have.has(item.hash) && have.add(item.hash))
  return fresh.length ? [...claims, ...fresh] : claims
}

/** the pieces in the vessel, picks dealt */
const piecesOf = (state: ChestScreenState): ChestItem[] => withPicks(state.claims.slice(0, SHOWN_PIECES), state.picks, state.stash)
const shownOf = (state: ChestScreenState) => Math.min(SHOWN_PIECES, state.claims.length)

/** the vessel is asked to open, or has (C8) */
function opens(state: ChestScreenState): boolean {
  if (state.vessel.open) return true
  if (state.phase !== "collecting") return false
  return chestShouldOpen({ landed: state.vessel.landed, waited: state.vessel.waited, collected: state.vessel.collected, shown: shownOf(state), allIn: state.allIn })
}

/** what the payoff hears with each screen (lib/journeys/payoff-facts) */
function factsOf(state: ChestScreenState): Attrs | null {
  if (state.restart) return chestFacts({ kind: "restart", gameIndex: null, reason: "chain-lost" })
  if (state.phase === "collecting")
    return chestFacts({ kind: "ready", gameIndex: state.game, seed: state.seed ?? "", items: state.claims, settling: state.settling })
  if (state.phase !== "nothing" || !state.why) return null
  if (state.why === "no-identity") return chestFacts({ kind: "no-identity" })
  if (state.why === "pocketed") return chestFacts({ kind: "pocketed", gameIndex: state.game })
  if (state.why === "pruned") return chestFacts({ kind: "pruned", gameIndex: state.game, unprovable: 0 })
  return chestFacts({ kind: "empty", gameIndex: state.game, reason: state.why })
}

/** chest-result, once (C4, C6, C10) */
function result(state: ChestScreenState, tag: PayoffTag | "capture"): ChestScreenTransition {
  const facts = factsOf(state)
  if (state.resultSent || !facts) return { state, commands: [] }
  return { state: { ...state, resultSent: true }, commands: [{ kind: "payoff", input: { type: "chest-result" }, tag, facts }] }
}

const inert = (state: ChestScreenState): ChestScreenTransition => ({ state, commands: [] })

/** the vessel's reports and their timers */
function onVessel(state: ChestScreenState, event: Extract<ChestScreenEvent, { type: "landed" | "collected" | "vessel-opened" }>): ChestScreenTransition {
  const vessel = state.vessel
  switch (event.type) {
    case "landed":
      if (vessel.landed) return inert(state)
      return { state: { ...state, vessel: { ...vessel, landed: true } }, commands: [{ kind: "arm-timer", timer: "collect", ms: COLLECT_MS }] }
    case "collected":
      if (event.count <= vessel.collected) return inert(state)
      return { state: { ...state, vessel: { ...vessel, collected: event.count } }, commands: [] }
    case "vessel-opened": {
      if (vessel.open || vessel.collected === 0) return inert(state)
      const by = opens(state) ? (state.allIn ? "all in" : "the wait") : "a tap"
      return {
        state: { ...state, vessel: { ...vessel, open: true } },
        commands: [{ kind: "log", message: "the vessel opened", data: { by, collected: vessel.collected, shown: shownOf(state) } }],
      }
    }
  }
}

/** Pure transition: no clock, no I/O. */
export function chestScreenStep(state: ChestScreenState, event: ChestScreenEvent): ChestScreenTransition {
  if (state.phase === "closed") return inert(state)
  if (event.type === "unmounted")
    return {
      state: { ...state, phase: "closed", epoch: state.epoch + 1 },
      commands: [
        { kind: "stop-feed" },
        { kind: "clear-timer", timer: "slow" },
        { kind: "clear-timer", timer: "collect" },
        ...(state.rereads ? [{ kind: "rereads" as const, on: false }] : []),
      ],
    }
  if (state.phase === "new") {
    if (event.type !== "opened") return inert(state)
    return {
      state: { ...state, phase: "waiting", epoch: 1 },
      commands: [
        { kind: "payoff", input: { type: "chest-opened" } },
        { kind: "arm-timer", timer: "slow", ms: SLOW_PAYOFF_MS },
        { kind: "read", epoch: 1 },
      ],
    }
  }

  switch (event.type) {
    case "opened":
      return inert(state)
    case "source": {
      // C10: the restart card stays up, whatever the source says after it
      if (state.seed !== null || state.phase !== "waiting" || state.restart) return inert(state)
      if (event.seed === null) return nothing(state, "no-identity", event.game, "capture")
      return { state: { ...state, seed: event.seed, game: event.game }, commands: [] }
    }
    case "answered": {
      if (event.epoch !== state.epoch || state.phase !== "waiting" || state.restart) return inert(state)
      const answer = event.answer
      const picked = { ...(event.picks ? { picks: event.picks } : {}), ...(event.stash ? { stash: event.stash } : {}) }
      if (answer.kind === "nothing") return nothing({ ...state, ...picked }, answer.why, answer.game, event.tag)
      if (answer.kind === "waiting") {
        const next = { ...state, ...picked, game: answer.game ?? state.game, failed: state.failed || answer.failed, rereads: true }
        return { state: next, commands: state.rereads ? [] : [{ kind: "rereads", on: true }] }
      }
      const collecting: ChestScreenState = {
        ...state,
        ...picked,
        phase: "collecting",
        seed: state.seed ?? answer.seed,
        game: answer.game,
        claims: adding([], answer.items),
        settling: answer.settling,
        allIn: !answer.settling,
        partial: answer.partial,
        failed: false,
        rereads: false,
      }
      const commands: ChestScreenCommand[] = []
      if (state.failed) commands.push({ kind: "read-recovered" })
      if (state.rereads) commands.push({ kind: "rereads", on: false })
      const told = result(collecting, event.tag)
      return { state: told.state, commands: [...commands, ...told.commands] }
    }
    case "came": {
      // C7: claims come only while the game settles; a chest all in takes no more (and an open vessel stays open, C8)
      if (event.epoch !== state.epoch || state.phase !== "collecting" || state.allIn) return inert(state)
      const claims = adding(state.claims, event.items)
      return claims === state.claims ? inert(state) : { state: { ...state, claims }, commands: [] }
    }
    case "settled": {
      if (event.epoch !== state.epoch || state.phase !== "collecting" || state.allIn) return inert(state)
      return {
        state: { ...state, claims: adding(state.claims, event.items), allIn: true, partial: event.partial },
        commands: [],
      }
    }
    case "health": {
      const { lost, stall } = event.health
      if (state.restart || state.phase !== "waiting" || !chestRestartVisible("loading", lost, stall)) return inert(state)
      const reason: RestartCardReason | undefined = lost ? (event.health.reason ?? "chain-lost") : stall
      const up: ChestScreenState = { ...state, restart: { reason }, rereads: false, epoch: state.epoch + 1 }
      const told = result(up, "capture")
      return {
        state: told.state,
        commands: [
          { kind: "stop-feed" },
          { kind: "clear-timer", timer: "slow" },
          ...(state.rereads ? [{ kind: "rereads" as const, on: false }] : []),
          ...told.commands,
          { kind: "payoff", input: { type: "payoff-stalled", stage: "chest.load" } },
        ],
      }
    }
    case "timer": {
      let next = state
      if (event.timer === "collect") {
        if (!state.vessel.landed || state.vessel.waited) return inert(state)
        next = { ...state, vessel: { ...state.vessel, waited: true } }
        // C9: the collect wait ran out with something read: it opens on that (C8)
        if (state.phase !== "waiting") return { state: next, commands: [] }
      }
      if (next.slow || next.restart) return next === state ? inert(state) : { state: next, commands: [] }
      // C9: nothing read yet; the payoff hears it only then (the backstop also gives a way on while collecting, C11)
      return {
        state: { ...next, slow: true },
        commands: next.phase === "waiting" ? [{ kind: "payoff", input: { type: "payoff-stalled", stage: "chest.slow" } }] : [],
      }
    }
    case "reread-due": {
      // C5: read again now, whatever the payoff is doing; it hears the reread first, so the read carries its new epoch
      if (!state.rereads || state.phase !== "waiting") return inert(state)
      const epoch = state.epoch + 1
      return { state: { ...state, epoch }, commands: [{ kind: "payoff", input: { type: "chest-reread-due" } }, { kind: "read", epoch }] }
    }
    case "load-chest":
      // the payoff's answer to the reread: that read has already gone
      return inert(state)
    case "landed":
    case "collected":
    case "vessel-opened": {
      // the vessel lands while it waits or collects; pieces fly in, and it
      // opens, only once there are claims, after it has landed
      const live = state.phase === "collecting" || (state.phase === "waiting" && event.type === "landed" && !state.restart)
      if (!live || (event.type !== "landed" && !state.vessel.landed)) return inert(state)
      return onVessel(state, event)
    }
    case "cta":
      return cta(state)
    case "album-done":
      if (state.phase !== "collecting" || !state.closing) return inert(state)
      return { state, commands: [{ kind: "leave", via: "chest-continue" }] }
    case "hand-off-refused":
      // C12: the album's Continue comes back; elsewhere it never went
      if (state.phase !== "collecting" || !state.closing) return inert(state)
      return { state: { ...state, refusals: state.refusals + 1 }, commands: [] }
    case "pick": {
      if (state.phase !== "collecting") return inert(state)
      const item = piecesOf(state)[event.index]
      if (!item || !canChangePick(item)) return inert(state)
      const hash = normalizeCreditHash(item.hash)
      if (!hash) return inert(state)
      return {
        state: { ...state, picks: new Map(state.picks).set(hash, event.collectionId) },
        commands: [{ kind: "save-pick", hash: item.hash, collectionId: event.collectionId }],
      }
    }
  }
}

/** nothing for this game (C6): the reason and Continue */
function nothing(state: ChestScreenState, why: NothingWhy, game: number | null, tag: PayoffTag | "capture"): ChestScreenTransition {
  const next: ChestScreenState = { ...state, phase: "nothing", why, game: game ?? state.game, rereads: false }
  const told = result(next, tag)
  return {
    state: told.state,
    commands: [
      { kind: "stop-feed" },
      { kind: "clear-timer", timer: "slow" },
      ...(state.rereads ? [{ kind: "rereads" as const, on: false }] : []),
      ...told.commands,
    ],
  }
}

/** Continue (C9, C12) */
function cta(state: ChestScreenState): ChestScreenTransition {
  if (state.restart) return inert(state)
  if (state.phase === "waiting")
    return state.slow ? { state, commands: [{ kind: "leave", via: "chest-skip" }] } : inert(state)
  if (state.phase === "nothing") {
    const seen = state.why !== "no-identity" && state.game !== null
    return { state, commands: [...(seen ? [{ kind: "mark-seen" as const, game: state.game! }] : []), { kind: "leave", via: "chest-continue" }] }
  }
  if (state.phase !== "collecting" || state.closing || !wayOn(state)) return inert(state)
  return {
    state: { ...state, closing: true },
    commands: state.allIn && state.game !== null ? [{ kind: "mark-seen", game: state.game }] : [],
  }
}

/** a way on is offered on the chest (C11) */
const wayOn = (state: ChestScreenState) => state.vessel.open || state.slow

type ChestNotice = "partial" | "slow" | { nothing: NothingWhy }

export type ChestScreenView =
  | { kind: "restart"; reason: RestartCardReason | undefined }
  | {
      kind: "chest"
      game: number | null
      /** what the vessel draws; null before the seed is known, and when there is nothing */
      vessel: null | { seed: string; pieces: ChestItem[]; open: boolean; canOpen: boolean }
      notice: ChestNotice | null
      action: "continue" | "skip" | null
      /** the album over the chest, with the pieces' art, and how many hand-offs it has had refused */
      closing: null | { srcs: string[]; refusals: number }
    }

/** What the page renders: the restart card, or the chest. */
export function chestScreenView(state: ChestScreenState): ChestScreenView {
  if (state.restart) return { kind: "restart", reason: state.restart.reason }
  const base = { kind: "chest" as const, game: state.game }
  if (state.phase === "nothing" && state.why)
    return { ...base, vessel: null, notice: { nothing: state.why }, action: "continue", closing: null }
  if (state.phase === "collecting") {
    const pieces = piecesOf(state)
    return {
      ...base,
      vessel: { seed: state.seed ?? "", pieces, open: opens(state), canOpen: state.vessel.collected > 0 },
      notice: state.vessel.open && state.partial ? "partial" : null,
      action: wayOn(state) ? "continue" : null,
      closing: state.closing ? { srcs: pieces.map((item) => item.image).filter(Boolean), refusals: state.refusals } : null,
    }
  }
  return {
    ...base,
    vessel: state.seed && state.phase === "waiting" ? { seed: state.seed, pieces: [], open: false, canOpen: false } : null,
    notice: state.slow ? "slow" : null,
    action: state.slow ? "skip" : null,
    closing: null,
  }
}

/** the first read is still out, or failed: what the launch stall watches */
export const chestScreenWaiting = (state: ChestScreenState) => state.phase === "waiting" && !state.restart
