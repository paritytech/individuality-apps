// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pending register-for-draw submissions are isolated by event id and alias.
 *
 *  Keyed by (alias, eventId): the alias is the stable on-chain registrant,
 *  and the people-airdrop event id is what the runtime validates. Two open
 *  draws at once (a common state — every active draw a person enters is a
 *  separate on-chain registration) must coexist in this store; locking one
 *  per account would strand every other draw the same person was queueing.
 *
 *  Why this exists at all: `PeopleAirdrops.register` is free on success but
 *  pays on failure, and is all-or-nothing per call. A background loop that
 *  re-submits a doomed batch every 12 s silently drains the product account.
 *  A marker set on broadcast and cleared only on finalized success (or on a
 *  finalized failure that itself clears it) is the only thing standing
 *  between the standing query refetch and that drain. An `unknown` result
 *  must KEEP the marker, exactly as `pending-daily-claim.ts` does, so a
 *  reload does not resubmit while the chain is still confirming. */
const STORAGE_PREFIX = "humanity:pending-register:";

interface PendingRegisterRecord {
  eventId: string;
  /** Historical field name; stores the stable alias registrant key. */
  accountAddress: string;
  txHash: string;
}

const memoryFallback = new Map<string, PendingRegisterRecord>();

function readStorage(key: string): PendingRegisterRecord | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isPendingRegisterRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPendingRegisterRecord(value: unknown): value is PendingRegisterRecord {
  if (value == null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventId === "string" &&
    /^0x[0-9a-f]+$/i.test(record.eventId) &&
    typeof record.accountAddress === "string" &&
    record.accountAddress.length > 0 &&
    typeof record.txHash === "string" &&
    /^0x[0-9a-f]+$/i.test(record.txHash)
  );
}

/**
 * Write one pending-register marker per submitted event id, attached to the
 * broadcast hash. Multiple ids from one batch land as multiple records (one
 * per event id); clearing one id never touches another.
 *
 * No-op when the record is malformed — a corrupt caller must never write a
 * key the `has*` reader cannot recognize.
 */
export function setPendingRegistration(
  eventIds: string[],
  accountAddress: string,
  txHash: string,
): void {
  for (const eventId of eventIds) {
    const record = { eventId, accountAddress, txHash };
    if (!isPendingRegisterRecord(record)) continue;
    const key = `${STORAGE_PREFIX}${eventId}:${accountAddress}:${txHash}`;
    memoryFallback.set(key, record);
    try {
      localStorage.setItem(key, JSON.stringify(record));
    } catch {
      // Module memory retains the marker when persistent storage is unavailable.
    }
  }
}

/**
 * Remove only this attempt's broadcast markers — pre-broadcast errors must
 * leave existing markers alone, and a sibling id's marker must not be wiped
 * by a clear call that names a different event id. `txHash` is part of the
 * key so clearing a wrong hash never silently unlocks the identity.
 */
export function clearPendingRegistration(
  eventIds: string[],
  accountAddress: string,
  txHash: string,
): void {
  for (const eventId of eventIds) {
    const key = `${STORAGE_PREFIX}${eventId}:${accountAddress}:${txHash}`;
    if (memoryFallback.get(key)?.txHash === txHash) {
      memoryFallback.delete(key);
    }
    try {
      if (readStorage(key) != null) {
        localStorage.removeItem(key);
      }
    } catch {
      // Persistent storage is unavailable; module memory was handled above.
    }
  }
}

/** True when any unresolved hash for `(eventId, alias)` is persisted. */
export function hasPendingRegistration(
  eventId: string,
  accountAddress: string,
): boolean {
  const prefix = `${STORAGE_PREFIX}${eventId}:${accountAddress}:`;
  const matchesIdentity = (
    record: PendingRegisterRecord,
    targetEventId: string,
    targetAccount: string,
  ): boolean =>
    record.eventId === targetEventId &&
    record.accountAddress === targetAccount;

  for (const [key, record] of memoryFallback) {
    if (key.startsWith(prefix) && matchesIdentity(record, eventId, accountAddress)) {
      return true;
    }
  }
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key == null || !key.startsWith(prefix)) continue;
      const record = readStorage(key);
      if (record != null && matchesIdentity(record, eventId, accountAddress)) {
        return true;
      }
    }
  } catch {
    // A storage failure leaves only the module-memory fallback above.
  }
  return false;
}
