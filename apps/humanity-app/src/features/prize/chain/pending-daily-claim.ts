// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pending submissions are isolated by airdrop EVENT and product account.
 *
 *  Keyed by event id, never by game: a game schedules one airdrop per day and
 *  their claim windows overlap (~72h windows, ~24h apart), so a game-wide key
 *  would let an unresolved claim from an earlier day lock every later day's
 *  ticket. The event id already encodes both the game and the airdrop index. */
const STORAGE_PREFIX = "humanity:pending-daily-claim:";

interface PendingClaimRecord {
  eventId: string;
  accountAddress: string;
  txHash: string;
}

const memoryFallback = new Map<string, PendingClaimRecord>();

function identityPrefix(eventId: string, accountAddress: string): string {
  return `${STORAGE_PREFIX}${eventId}:${accountAddress}:`;
}

function claimKey(
  eventId: string,
  accountAddress: string,
  txHash: string,
): string {
  return `${identityPrefix(eventId, accountAddress)}${txHash}`;
}

function isPendingClaimRecord(value: unknown): value is PendingClaimRecord {
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

function readStorage(key: string): PendingClaimRecord | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isPendingClaimRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setPendingDailyClaim(
  eventId: string,
  accountAddress: string,
  txHash: string,
): void {
  const record = { eventId, accountAddress, txHash };
  if (!isPendingClaimRecord(record)) return;
  const key = claimKey(eventId, accountAddress, txHash);
  memoryFallback.set(key, record);
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Module memory retains the marker when persistent storage is unavailable.
  }
}

export function clearPendingDailyClaim(
  eventId: string,
  accountAddress: string,
  txHash: string,
): void {
  const key = claimKey(eventId, accountAddress, txHash);
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

function matchesIdentity(
  record: PendingClaimRecord,
  eventId: string,
  accountAddress: string,
): boolean {
  return record.eventId === eventId && record.accountAddress === accountAddress;
}

export function hasPendingDailyClaim(
  eventId: string,
  accountAddress: string,
): boolean {
  const prefix = identityPrefix(eventId, accountAddress);
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
