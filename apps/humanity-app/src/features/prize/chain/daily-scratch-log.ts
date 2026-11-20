// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Which airdrop events this identity has already scratched open.
 *
 *  Separate from the winnings ledger on purpose. The outcome is predetermined
 *  on chain, so scratching is the consuming action — it happens for a win and
 *  a miss alike — while the winnings ledger records money and must stay
 *  idempotent per event. Folding "scratched" into it as a zero amount would
 *  make the later win record a no-op and silently drop the prize from the
 *  tally.
 *
 *  Keyed by event id, which encodes game index + airdrop index: a new airdrop
 *  (tomorrow) or a new game yields a new id, hence a new card. Backed by host
 *  key-value storage, so it survives reloads. */
import { dailyDollarScratchStore } from "@individuality/shared-records";

import { getHostLocalStorage } from "@humanity/shared/chain/host-api.ts";
import { getLocalKvStore } from "@humanity/shared/storage/local-kv.ts";

const sharedScratches = dailyDollarScratchStore(getHostLocalStorage);

const LOG_PREFIX = "daily-scratch";

/** eventId → unix seconds the card was scratched open. */
type ScratchLog = Record<string, number>;

function logKey(accountAddress: string): string {
  return `${LOG_PREFIX}:${accountAddress}`;
}

function isEventId(value: string): boolean {
  return /^0x[0-9a-f]+$/i.test(value);
}

/** Persisted data is untrusted: keep only well-formed entries. */
function toLog(value: unknown): ScratchLog {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const log: ScratchLog = {};
  for (const [eventId, at] of Object.entries(value)) {
    if (isEventId(eventId) && typeof at === "number" && Number.isFinite(at)) {
      log[eventId] = at;
    }
  }
  return log;
}

async function readLog(accountAddress: string): Promise<ScratchLog> {
  const store = await getLocalKvStore();
  return toLog(await store.getJSON(logKey(accountAddress)));
}

/** Mark an event scratched. Idempotent: the first scratch is the one kept. */
export async function recordDailyScratch(
  accountAddress: string,
  eventId: string,
): Promise<void> {
  if (accountAddress.length === 0 || !isEventId(eventId)) return;
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Jollity's chat reads this to grey its Scratch button; a failed write must not lose the local log.
  await sharedScratches.markScratched(eventId, nowSeconds).catch(() => undefined);
  const log = await readLog(accountAddress);
  if (log[eventId] != null) return;
  log[eventId] = nowSeconds;
  const store = await getLocalKvStore();
  await store.setJSON(logKey(accountAddress), log);
}

/** True once this event's card has been scratched open by this identity. */
export async function hasScratchedDailyPrize(
  accountAddress: string,
  eventId: string,
): Promise<boolean> {
  const log = await readLog(accountAddress);
  return log[eventId] != null;
}

/** Drop one entry. Mirrors the other ledgers so tests can reset identities. */
export async function clearDailyScratch(
  accountAddress: string,
  eventId: string,
): Promise<void> {
  const log = await readLog(accountAddress);
  if (log[eventId] == null) return;
  delete log[eventId];
  const store = await getLocalKvStore();
  await store.setJSON(logKey(accountAddress), log);
}
