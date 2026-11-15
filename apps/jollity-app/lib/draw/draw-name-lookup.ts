// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE NAME ON A TICKET, as who's playing on the draw's wheel asks for it
 * (#456, ./wheel/names.ts): the holder's DotNS name (../player-names.ts).
 *
 * Every chain read is a `draw.name_lookup` count and a `draw.name_lookup_ms`
 * time in Sentry, by `name.outcome` (the lookup's reason: named, no-store,
 * no-note, not-for-account, no-username; or no-holder, no-dotns, read-failed)
 * and `name.ticket` (winner, other); a read that failed says why in
 * `name.error`.
 */
import { describeError } from "../host/error-detail"
import { devLog } from "../debug/log-store"
import { recordCount, recordDistribution } from "../telemetry"
import type { DrawWheel } from "./prize-draw"
import { slotHex, winnersByRule } from "./wheel/rule"
import type { NameReason } from "@individuality/name-link"
import { dotnsReader, nameReadError, readerTrouble, type NameReadError } from "../player-names"

/** the holder of a ticket, as the chain lists it (slot → SS58), whatever spelling the slot has */
const holderOf = (wheel: DrawWheel, slot: string) =>
  Object.entries(wheel.holders ?? {}).find(([held]) => slotHex(held) === slot)?.[1]

/** the slots this draw's rule picks, once per wheel */
const winnersOf = new WeakMap<DrawWheel, Set<string>>()
function isWinner(wheel: DrawWheel, slot: string): boolean {
  let winners = winnersOf.get(wheel)
  if (!winners) {
    winners = new Set(winnersByRule(wheel.tickets, wheel.target, wheel.winners))
    winnersOf.set(wheel, winners)
  }
  return winners.has(slot)
}

type NameLookupOutcome = NameReason | "no-holder" | "no-dotns" | "read-failed"

/** one chain read of a ticket's name, for Sentry */
function counted(wheel: DrawWheel, slot: string, outcome: NameLookupOutcome, startedAt: number, error?: NameReadError): void {
  const attrs = {
    "name.outcome": outcome,
    "name.ticket": isWinner(wheel, slot) ? "winner" : "other",
    ...(error ? { "name.error": error } : {}),
  }
  recordCount("draw.name_lookup", 1, attrs)
  recordDistribution("draw.name_lookup_ms", Date.now() - startedAt, "millisecond", attrs)
}

/** the name on a ticket of this draw, or null for a ticket nobody has named */
export async function readDrawName(wheel: DrawWheel, ticket: string): Promise<string | null> {
  const startedAt = Date.now()
  const slot = slotHex(ticket)
  const holder = holderOf(wheel, slot)
  if (!holder) counted(wheel, slot, "no-holder", startedAt)
  else {
    const reader = await dotnsReader()
    if (!reader) counted(wheel, slot, "no-dotns", startedAt, readerTrouble())
    else {
      try {
        const { name, why, reason } = await reader.lookup(holder)
        devLog("draw", `DotNS name for a ticket: ${why}`, { shown: name !== null })
        counted(wheel, slot, reason, startedAt)
        if (name) return name
      } catch (error) {
        devLog("draw", "DotNS name read failed", { detail: describeError(error) }, "warn")
        counted(wheel, slot, "read-failed", startedAt, nameReadError(error))
      }
    }
  }
  return null
}
