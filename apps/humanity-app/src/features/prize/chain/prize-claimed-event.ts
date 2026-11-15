// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Reads the awarded amount out of a finalized claim's own chain events.
 *
 *  `PeopleAirdrops.claim` takes no amount — it names the draw event id
 *  and the destination, and the runtime decides the payout. The
 *  authoritative figure is therefore the `Airdrop.PrizeClaimed` event
 *  emitted by the claim, never the `Airdrop.Events.info.prize.asset_amount`
 *  the UI read beforehand: that one is the SCHEDULED per-winner prize,
 *  a prediction that can diverge from what was actually transferred.
 *
 *  Pure and structurally typed so it can be tested without PAPI. */

/** One decoded runtime event, exactly as papi hands them to a tx observer. */
export interface ClaimChainEvent {
  readonly type: string;
  readonly value?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Hex comparison is case-insensitive: the encoder's case is not a contract. */
function sameHex(left: unknown, right: string): boolean {
  return (
    typeof left === "string" && left.toLowerCase() === right.toLowerCase()
  );
}

/**
 * Total awarded to `beneficiary` for `eventId` across the claim's events.
 *
 * `null` when the claim emitted no matching `PrizeClaimed` — a distinct case
 * from a zero award, and one the caller must not paper over: a dispatch that
 * finalized `ok` with no payout event means our understanding of the runtime
 * is wrong, and banking a predicted amount there would invent money.
 *
 * Amounts are summed rather than taking the first match, so a runtime that
 * ever splits an award across events still totals correctly.
 */
export function awardedFromClaimEvents(
  events: readonly ClaimChainEvent[] | undefined,
  eventId: string,
  beneficiary: string,
): bigint | null {
  if (events == null) return null;
  let total: bigint | null = null;
  for (const event of events) {
    if (event?.type !== "Airdrop") continue;
    const inner = asRecord(event.value);
    if (inner?.type !== "PrizeClaimed") continue;
    const payload = asRecord(inner.value);
    if (payload == null) continue;
    if (!sameHex(payload.event_id, eventId)) continue;
    if (payload.beneficiary !== beneficiary) continue;
    if (typeof payload.amount !== "bigint" || payload.amount < 0n) continue;
    total = (total ?? 0n) + payload.amount;
  }
  return total;
}
