// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DRAW, LOADED AHEAD — one read of a game's prize draw, shared by whoever
 * asks first and whoever asks next.
 *
 * The game session starts it on the confirm screen (lib/game-session.ts), a
 * few seconds before the report lands and the player is sent to /prize-draw.
 * The draw page then picks up the same load: when it has already resolved,
 * the page's very first render is the wheel, with no loading frame to flash.
 *
 * The load polls until the draw is DRAWN, because the ceremony reads the
 * winners and never the phase: a draw still in flight would land a real
 * winner on "no win". While it polls it says so (`waiting`), which is the one
 * moment the page has something true to tell the player — the chain is still
 * drawing — rather than a guess made by a timer.
 *
 * A DRAWN READ IS NOT TAKEN AT ITS WORD when it looks wrong. The chain is
 * right, but the read of it can come back short: an Android host has been
 * seen returning the draw without the player's own ticket, which the
 * chain held the whole time, and the screen said "You weren't in this draw".
 * So a read with no draw at all, a registration list shorter than the
 * chain's own count, or no ticket for the player in a list that cannot be
 * told complete is read again a few times (`DOUBT_RETRY_MS`). A COMPLETE
 * list without the player is the answer, not a misread: every entry the
 * chain counts is there, and reading it again only keeps a spectator on a
 * black screen for seconds. Nor is a missing
 * ticket this phone's own sign-up already found missing doubted
 * (lib/draw/draw-miss: left out on purpose, #167, or a draw it could not
 * enter): a sign-up never gains a ticket later. A consistently empty read is
 * kept as the settled no-draw answer, so the payoff can skip that screen. An incomplete drawn
 * read is shown once but never cached: the next ask reads afresh instead of
 * inheriting it. Every read is logged with what it saw, so a phone's log says
 * which of these it was.
 *
 * HELD, NOT LEAKED. Each `loadDraw` holds the load until its `release()`:
 * the session's preload until the confirm screen goes, the page's host until
 * the page does. A draw still drawing is read again only while someone holds
 * it; one let go of by all stops at its next read, which leaves the route
 * change from the confirm screen to the draw a whole poll to pick it up.
 *
 * Framework-free (architecture rule 6): the page and the session subscribe.
 */
import type { GameSource } from "../game-source"
import type { PrizeDrawView } from "./prize-draw"
import { devLog } from "../debug/log-store"
import { describeError } from "../host/error-detail"
import { drawMissFor } from "./draw-miss"

/** what the draw page renders once the load has an answer */
export type DrawLoadResult =
  | { kind: "none" }
  | { kind: "ready"; draw: PrizeDrawView }
  /** no player identity here (outside a host) */
  | null

/** how often a not-yet-drawn draw is re-read — about one People block */
const POLL_MS = 3000
/** stop polling after this many reads (~3 minutes): a load nobody is waiting
 *  on must not poll forever. It then stays `waiting` — never resolving to a
 *  draw that is not drawn, which would land a real winner on "no win" — and
 *  the page's Continue is the way on. */
const MAX_READS = 60
/** the waits before re-reading a drawn read that looks wrong (see the header) */
const DOUBT_RETRY_MS = [1000, 2000, 4000]

/** what is wrong with a read, if anything looks it: the reason, or null.
 *  `ticketExpected` false: the player is known to hold none. */
export function doubtOf(draws: readonly PrizeDrawView[], draw: PrizeDrawView | undefined, ticketExpected = true): string | null {
  if (draws.length === 0 || !draw) return "no draw came back"
  const total = draw.totalEntries
  const listed = draw.listedEntries
  if (total !== undefined && listed !== undefined && listed < total) return `the entry list came back short (${listed} of ${total})`
  // every entry the chain counts is listed: a player not in it is not in the draw
  const complete = total !== undefined && listed !== undefined && listed === total
  if (!draw.userTicket && ticketExpected && !complete) return "no ticket for this player in the entries"
  return null
}

export interface DrawLoad {
  readonly promise: Promise<DrawLoadResult>
  /** the answer, once there is one */
  readonly result: DrawLoadResult | undefined
  /** the chain has said the draw is not drawn yet, and the load is polling */
  readonly waiting: boolean
  /** called whenever `waiting` or `result` changes; returns the unsubscribe */
  subscribe(listener: () => void): () => void
  /** one `loadDraw` caller is done with it (see the header: HELD, NOT LEAKED) */
  release(): void
}

const loads = new Map<string, DrawLoad & { hold(): void }>()
const keyOf = (gameIndex: number | undefined, player: string | undefined) => `${gameIndex ?? "last"}:${player ?? ""}`

/** the load for this game, started if nobody has started it yet */
export function loadDraw(source: GameSource, gameIndex: number | undefined, player?: string): DrawLoad {
  const key = keyOf(gameIndex, player)
  const existing = loads.get(key)
  if (existing) {
    existing.hold()
    devLog("draw", "reusing the draw load already under way", {
      game: gameIndex ?? null,
      has: existing.result === undefined ? (existing.waiting ? "waiting" : "pending") : (existing.result?.kind ?? "no identity"),
    })
    return existing
  }
  devLog("draw", "starting a draw load", { game: gameIndex ?? null, player: player ?? null })

  const listeners = new Set<() => void>()
  let result: DrawLoadResult | undefined
  let waiting = false
  // the callers holding the load: whoever started it, and each who asked since
  let holders = 1
  /** this load is no longer the one handed out for its game */
  function forget(): void {
    if (loads.get(key) === load) loads.delete(key)
  }
  const tell = () => listeners.forEach((listener) => listener())

  // whether the answer still looked wrong after its retries: then it is
  // handed to whoever is waiting, but not kept for the next ask
  let doubtful = false
  // this phone's sign-up already found the player without a ticket: the
  // read is right to show none (never for a ?player= URL override)
  const ticketExpected = player !== undefined || drawMissFor(gameIndex) === undefined
  const promise = (async (): Promise<DrawLoadResult> => {
    let doubts = 0
    for (let reads = 0; ; reads++) {
      const startedAt = Date.now()
      const draws = await source.prizeDrawView({ gameIndex, ...(player ? { player } : {}) })
      if (!draws) return null
      // one ceremony at a time: the first draw that is not already over
      const draw = draws.find((d) => d.phase !== "over") ?? draws[0]
      if (draw?.phase === "waiting") {
        if (!waiting) {
          waiting = true
          tell()
        }
        if (reads >= MAX_READS) return new Promise<never>(() => {})
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
        if (holders === 0) {
          // let go of by all: read no more, and the next ask starts afresh
          forget()
          devLog("draw", "nobody holds the draw load: stopped reading", { game: gameIndex ?? null, reads: reads + 1 })
          return new Promise<never>(() => {})
        }
        continue
      }
      const doubt = doubtOf(draws, draw, ticketExpected)
      devLog(
        "draw",
        `read ${reads + 1}${doubt ? `: ${doubt}` : ""}`,
        {
          game: gameIndex ?? null,
          draws: draws.length,
          phase: draw?.phase ?? null,
          listed: draw?.listedEntries ?? null,
          total: draw?.totalEntries ?? null,
          ticket: Boolean(draw?.userTicket),
          won: draw?.won ?? null,
          wheel: Boolean(draw?.wheel),
          ms: Date.now() - startedAt,
        },
        doubt ? "warn" : "info",
      )
      if (doubt && doubts < DOUBT_RETRY_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, DOUBT_RETRY_MS[doubts]))
        doubts += 1
        continue
      }
      doubtful = doubt !== null
      if (doubtful)
        devLog(
          "draw",
          `still ${doubt} after ${doubts + 1} reads — ${draw ? "shown, not kept" : "accepted as no draw"}`,
          { game: gameIndex ?? null },
          "warn",
        )
      return draw ? { kind: "ready", draw } : { kind: "none" }
    }
  })()
  void promise.then(
    (value) => {
      const doubtfulSuffix = doubtful ? (value?.kind === "none" ? " (confirmed empty)" : " (doubtful, not kept)") : ""
      devLog("draw", `draw load settled: ${value === null ? "no identity" : value.kind}${doubtfulSuffix}`, { game: gameIndex ?? null })
      result = value
      waiting = false
      // A drawn answer that still looks incomplete is shown once and
      // forgotten, so the next ask can recover a ticket or a full entry list.
      // Four consistent empty reads are the settled "no draw" answer: keep
      // that one so the report handoff can skip the draw route altogether.
      if (doubtful && value?.kind !== "none" && loads.get(key) === load) loads.delete(key)
      tell()
    },
    (error: unknown) => {
      devLog("draw", "draw load failed", { game: gameIndex ?? null, detail: describeError(error) }, "error")
      // a failed load is not remembered: the next ask starts a fresh one
      loads.delete(key)
    },
  )

  const load: DrawLoad & { hold(): void } = {
    promise,
    get result() {
      return result
    },
    get waiting() {
      return waiting
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    hold() {
      holders += 1
    },
    release() {
      holders = Math.max(0, holders - 1)
    },
  }
  loads.set(key, load)
  return load
}

/** the answer for this game, if a load has one already — the draw page's
 *  first render reads this, so a preloaded draw opens straight on the wheel */
export function peekDraw(gameIndex: number | undefined, player?: string): DrawLoadResult | undefined {
  return loads.get(keyOf(gameIndex, player))?.result
}
