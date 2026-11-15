// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { devLog } from "./debug/log-store"
import { readStoredJSON, writeStoredJSON, writeStoredString } from "./host/storage"
import { recordCount, recordDistribution } from "./telemetry"
import type { ChainHealthResult, ChainHealthWhere } from "./chain-health"

const RESTART_PENDING_KEY = "jollity.chain-restart-pending"

let storageQueue: Promise<void> = Promise.resolve()
let delayedShownAt: number | undefined

function serial<T>(operation: () => Promise<T>): Promise<T> {
  const next = storageQueue.then(operation, operation)
  storageQueue = next.then(() => undefined, () => undefined)
  return next
}

/** Remember the card in host storage. A full app close is the prescribed fix,
 * so in-memory state cannot attribute the first probe after the reopen. */
async function rememberRestartAdviceUnlocked(where: ChainHealthWhere, surface: "card" | "bar"): Promise<void> {
  // Only the blocking card asks the player to close and reopen. The in-game
  // bar is advisory while play continues, so persisting it would make an
  // unrelated later app open look like a completed restart.
  if (surface === "card") await writeStoredJSON(RESTART_PENDING_KEY, Date.now())
  recordCount(surface === "card" ? "chain.restart_card_shown" : "chain.restart_bar_shown", 1, {
    "chain.health.where": where,
  })
}

/** Attribute the opening probe after a shown restart prompt. Waiting-room,
 * handover and background re-checks happen without a restart and must not
 * spend this marker. */
async function recordRestartFollowupUnlocked(
  where: ChainHealthWhere,
  result: ChainHealthResult,
): Promise<{ pending: boolean; succeeded: boolean | null }> {
  const shownAt = await readStoredJSON(RESTART_PENDING_KEY)
  if (typeof shownAt !== "number") return { pending: false, succeeded: null }
  await writeStoredString(RESTART_PENDING_KEY, "")
  const succeeded = result.outcome === "healthy"
  recordCount("chain.restart_card_next_probe", 1, {
    "chain.health.where": where,
    "chain.restart_card_next_probe": String(succeeded),
  })
  devLog(
    "chain",
    succeeded
      ? "restart card's next probe succeeded"
      : "restart card's next probe did not succeed",
    { where, shownAt, outcome: result.outcome },
    succeeded ? "info" : "warn",
  )
  return { pending: true, succeeded }
}

/** Apply one completed probe and its potential new card as one storage
 * transaction. Different probe locations may finish together; no healthy
 * result can clear the old marker only to have an earlier loss recreate it. */
export function applyRestartProbe(
  where: ChainHealthWhere,
  result: ChainHealthResult,
  showAdvice: boolean | "bar",
): Promise<{ pending: boolean; succeeded: boolean | null }> {
  return serial(async () => {
    // Only the app-open probe is evidence of a real close/reopen. Periodic
    // waiting, handover and re-check probes leave the durable marker alone.
    const followup =
      where === "open"
        ? await recordRestartFollowupUnlocked(where, result)
        : { pending: false, succeeded: null }
    if (showAdvice) await rememberRestartAdviceUnlocked(where, showAdvice === "bar" ? "bar" : "card")
    return followup
  })
}

/** The silent-host card becomes restart advice only after its reconnecting
 * minute expires. Persist and count that transition exactly like immediate
 * known-loss advice, without consuming an earlier reopen marker. */
export function recordRestartCardShown(where: ChainHealthWhere): Promise<void> {
  delayedShownAt = Date.now()
  return serial(() => rememberRestartAdviceUnlocked(where, "card"))
}

/** The card was reset by a return from the background, not cleared by a
 *  probe: its delayed advice no longer times anything. */
export function forgetRestartCardTiming(): void {
  delayedShownAt = undefined
}

/** A card cleared by a healthy probe, without a restart: how long it held
 *  the player. The re-checks' own outcomes are the chain.health samples
 *  tagged "recheck". */
export function recordRestartCardCleared(where: ChainHealthWhere, visibleMs?: number): void {
  const elapsed = visibleMs ?? (delayedShownAt === undefined ? undefined : Date.now() - delayedShownAt)
  delayedShownAt = undefined
  if (elapsed === undefined) return
  recordDistribution("chain.restart_card_visible_ms", Math.max(0, elapsed), "millisecond", {
    "chain.health.where": where,
  })
}
