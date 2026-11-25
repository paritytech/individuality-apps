// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE COLLECTABLES SCREEN'S CLAIMS FEED: the first read; while the game settles, the claims
 * as they land; then the settle's own read (`runCollectablesFeed`). One run per
 * player and game is SHARED (`holdCollectablesFeed`): the prize draw starts it on
 * its way to the collectables screen (the payoff's load-collectables), and the collectables screen takes it over
 * and hears what it already found, then the rest. Only a run that found
 * claims, or has not answered yet, is shared: one that answered without
 * claims has ended on a reading that may be stale by now, so the collectables reads
 * afresh. With no game known there is nothing to tell runs apart by, so none
 * is shared. A run is let go when nobody holds it, after the grace its last
 * holder asked for.
 */
import type { CollectablesItem, CollectablesPicks, CollectablesView } from "@jollity/collectables"
import type { GameSource } from "../game-source"
import { classifyCollectables, type CollectablesAnswer } from "./collectables-screen"

/** The waits between the settle's own reads when one fails, ms; past the
 *  last, every wait is the last. Each read waits for the settle, which the
 *  feed has already watched land, so a retry is for a read that failed, and it
 *  keeps trying for as long as the run is held: until then the collectables screen is not
 *  all in, so it is neither seen nor given the settle's claims. */
export const SETTLED_RETRY_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

export type CollectablesFeedEvent =
  | { type: "answered"; answer: CollectablesAnswer; picks: CollectablesPicks; stash: CollectablesPicks }
  | { type: "came"; items: CollectablesItem[] }
  | { type: "settled"; items: CollectablesItem[]; partial: boolean }

export interface CollectablesFeedReads {
  /** the URL's ?game=, or the game the session remembered */
  game: number | undefined
  /** the ?player= URL override (honoured in every build) */
  player: string | undefined
  read(
    source: GameSource,
    options: { player?: string; gameIndex?: number; signal: AbortSignal; afterSettle?: boolean; holdWhileVoting?: boolean },
  ): Promise<CollectablesView | null>
  /** the claims that land while the game settles; resolves once it has settled */
  watch(
    source: GameSource,
    options: { player?: string; gameIndex: number; shown: string[]; onItems: (items: CollectablesItem[]) => void; signal: AbortSignal },
  ): Promise<void>
  picks(): Promise<[CollectablesPicks, CollectablesPicks]>
  /** resolves after `ms`, or as soon as `signal` aborts */
  wait(ms: number, signal: AbortSignal): Promise<void>
  log(message: string, data?: unknown, level?: "info" | "warn"): void
}

/** One run of the feed, each finding handed to `emit`, until it is done or `signal` aborts. */
export async function runCollectablesFeed(source: GameSource, reads: CollectablesFeedReads, emit: (event: CollectablesFeedEvent) => void, signal: AbortSignal): Promise<void> {
  const { player } = reads
  try {
    // the first read always answers, so whoever waits on it (a reread) hears back:
    // a read that throws is a failed read, and picks that throw are none
    const failedRead = (game: number | undefined) => (error: unknown): CollectablesAnswer => {
      if (!signal.aborted) reads.log("the chest read threw", { detail: String(error) }, "warn")
      return { kind: "waiting", game: game ?? null, failed: true }
    }
    const [first, [picks, stash]] = await Promise.all([
      reads.read(source, { player, gameIndex: reads.game, signal }).then(classifyCollectables, failedRead(reads.game)),
      reads.picks().catch((): [CollectablesPicks, CollectablesPicks] => [new Map(), new Map()]),
    ])
    if (signal.aborted) return
    emit({ type: "answered", answer: first, picks, stash })
    let answer = first
    if (answer.kind === "waiting" && answer.voting) {
      const gameIndex = answer.game ?? reads.game
      answer = await reads.read(source, { player, gameIndex, holdWhileVoting: true, signal }).then(classifyCollectables, failedRead(gameIndex))
      if (signal.aborted) return
      emit({ type: "answered", answer, picks, stash })
    }
    if (answer.kind !== "claims" || !answer.settling || answer.game === null) return
    const game = answer.game
    await reads.watch(source, { player, gameIndex: game, shown: answer.items.map((item) => item.hash), onItems: (items) => emit({ type: "came", items }), signal })
    for (let attempt = 1; !signal.aborted; attempt++) {
      const settled = await reads.read(source, { player, gameIndex: game, afterSettle: true, signal }).catch(() => null)
      if (signal.aborted) return
      if (settled && !settled.failed) return emit({ type: "settled", items: settled.items, partial: settled.partial === true })
      reads.log("the chest read after the settle failed", { game, attempt, detail: settled?.failed ?? null }, "warn")
      await reads.wait(SETTLED_RETRY_MS[Math.min(attempt, SETTLED_RETRY_MS.length) - 1]!, signal)
    }
  } catch (error) {
    if (signal.aborted) return
    reads.log("the chest feed stopped", { detail: String(error) }, "warn")
  }
}

interface SharedRun {
  heard: CollectablesFeedEvent[]
  listeners: Set<(event: CollectablesFeedEvent) => void>
  holders: number
  controller: AbortController
  grace: ReturnType<typeof setTimeout> | null
}
const runs = new Map<string, SharedRun>()

/**
 * Hold the shared run for this player and game, starting it if nobody has:
 * `listener` hears what it already found, then each finding as it comes.
 * Returns the release; `graceMs` keeps the run going that long after the last
 * holder lets go (the draw's, so the collectables screen can take it over).
 */
export function holdCollectablesFeed(
  source: GameSource,
  reads: CollectablesFeedReads,
  listener: ((event: CollectablesFeedEvent) => void) | null,
  graceMs = 0,
): () => void {
  // no game known: nothing tells this run from another collectables screen's, so it is the holder's own
  if (reads.game === undefined) {
    if (!listener) return () => {}
    const controller = new AbortController()
    void runCollectablesFeed(source, reads, listener, controller.signal)
    return () => controller.abort()
  }
  const key = `${reads.player ?? ""}|${reads.game}`
  let run = runs.get(key)
  // a run that answered without claims has ended on a reading that may be
  // stale by now (a failed read, claims not readable yet): read afresh
  if (run && !replayable(run)) {
    retire(key, run)
    run = undefined
  }
  if (!run) {
    const created: SharedRun = { heard: [], listeners: new Set(), holders: 0, controller: new AbortController(), grace: null }
    runs.set(key, created)
    void runCollectablesFeed(source, reads, (event) => {
      created.heard.push(event)
      created.listeners.forEach((hear) => hear(event))
    }, created.controller.signal)
    run = created
  }
  const held = run
  if (held.grace) clearTimeout(held.grace)
  held.grace = null
  held.holders += 1
  if (listener) {
    held.heard.forEach(listener)
    held.listeners.add(listener)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (listener) held.listeners.delete(listener)
    held.holders -= 1
    if (held.holders > 0) return
    const letGo = () => {
      if (held.holders > 0) return
      held.controller.abort()
      if (runs.get(key) === held) runs.delete(key)
    }
    if (graceMs > 0) held.grace = setTimeout(letGo, graceMs)
    else letGo()
  }
}

/** a run worth handing over: still reading, or it found claims (and follows them) */
function replayable(run: SharedRun): boolean {
  const first = run.heard[0]
  return !first || (first.type === "answered" && first.answer.kind === "claims")
}

function retire(key: string, run: SharedRun): void {
  if (run.grace) clearTimeout(run.grace)
  run.grace = null
  run.controller.abort()
  if (runs.get(key) === run) runs.delete(key)
}

/** for tests: no run outlives its test */
export function resetCollectablesFeedsForTest(): void {
  for (const run of runs.values()) {
    if (run.grace) clearTimeout(run.grace)
    run.controller.abort()
  }
  runs.clear()
}
