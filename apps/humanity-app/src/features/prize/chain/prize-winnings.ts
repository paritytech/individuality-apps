// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Finalized prize wins are isolated by the HUMAN identity account — the
 *  account the user's card belongs to, not the payout account that signed
 *  the claim.
 *
 *  Backed by host key-value storage. That store has no key enumeration, so a
 *  whole account's ledger lives under a single key as `eventId → amount`
 *  rather than one key per win. Keying by event id is what keeps a claim
 *  idempotent: the same event can never be counted twice, however many times
 *  it is recorded. */
import { getLocalKvStore } from "@humanity/shared/storage/local-kv.ts";

const LEDGER_PREFIX = "prize-winnings";

/** eventId → winner's prize in asset base units, as decimal digits. */
type PrizeWinLedger = Record<string, string>;

function ledgerKey(accountAddress: string): string {
  return `${LEDGER_PREFIX}:${accountAddress}`;
}

function isEventId(value: string): boolean {
  return /^0x[0-9a-f]+$/i.test(value);
}

function isAmount(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

/** Persisted data is untrusted: keep only well-formed `eventId → amount`
 *  pairs and silently drop anything else, so one corrupt entry cannot break
 *  the whole tally. */
function toLedger(value: unknown): PrizeWinLedger {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const ledger: PrizeWinLedger = {};
  for (const [eventId, amount] of Object.entries(value)) {
    if (isEventId(eventId) && isAmount(amount)) ledger[eventId] = amount;
  }
  return ledger;
}

async function readLedger(accountAddress: string): Promise<PrizeWinLedger> {
  const store = await getLocalKvStore();
  return toLedger(await store.getJSON(ledgerKey(accountAddress)));
}

async function writeLedger(
  accountAddress: string,
  ledger: PrizeWinLedger,
): Promise<void> {
  const store = await getLocalKvStore();
  await store.setJSON(ledgerKey(accountAddress), ledger);
}

export interface RecordPrizeWinArgs {
  /** HUMAN identity account address (the card's account). */
  accountAddress: string;
  /** Airdrop event id the win came from. */
  eventId: string;
  /** Winner's prize in asset base units. */
  amount: bigint;
}

/** Record one claimed win. Money only: a miss never enters this ledger — the
 *  "already scratched" fact lives in `daily-scratch-log.ts`, precisely so this
 *  stays idempotent per event without a zero-amount entry blocking the real
 *  amount later.
 *
 *  Idempotent per (accountAddress, eventId): the first recording of an event
 *  is the one that counts, so a replayed claim can never inflate the total. */
export async function recordPrizeWin({
  accountAddress,
  eventId,
  amount,
}: RecordPrizeWinArgs): Promise<void> {
  if (accountAddress.length === 0 || amount < 0n || !isEventId(eventId)) return;
  const ledger = await readLedger(accountAddress);
  if (ledger[eventId] != null) return;
  ledger[eventId] = amount.toString();
  await writeLedger(accountAddress, ledger);
}

/** Sum every recorded win for the account, in asset base units. */
export async function totalPrizeWinnings(
  accountAddress: string,
): Promise<bigint> {
  const ledger = await readLedger(accountAddress);
  let total = 0n;
  for (const amount of Object.values(ledger)) total += BigInt(amount);
  return total;
}

/** True once this event's win has been claimed and banked for the account.
 *  Distinct from "scratched" — see `daily-scratch-log.ts`. */
export async function hasSettledDailyPrize(
  accountAddress: string,
  eventId: string,
): Promise<boolean> {
  const ledger = await readLedger(accountAddress);
  return ledger[eventId] != null;
}

/** Remove one recorded win. Mirrors `clearPendingDailyClaim` so tests can
 *  reset the identities they touch. */
export async function clearPrizeWin(
  accountAddress: string,
  eventId: string,
): Promise<void> {
  const ledger = await readLedger(accountAddress);
  if (ledger[eventId] == null) return;
  delete ledger[eventId];
  await writeLedger(accountAddress, ledger);
}
