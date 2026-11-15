// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A first-time alias bind is proof-authorised and can be replay-sensitive.
 * Keep an unknown broadcast locked across reloads so the SPA never submits a
 * second overlapping `set_alias_account` while the first may still finalize.
 */
const STORAGE_PREFIX = "humanity:pending-airdrop-alias:";

interface PendingAliasBinding {
  accountAddress: string;
  txHash: string;
}

const memoryFallback = new Map<string, PendingAliasBinding>();

function key(accountAddress: string, txHash: string): string {
  return `${STORAGE_PREFIX}${accountAddress}:${txHash}`;
}

function valid(value: unknown): value is PendingAliasBinding {
  if (value == null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accountAddress === "string" &&
    record.accountAddress.length > 0 &&
    typeof record.txHash === "string" &&
    /^0x[0-9a-f]+$/i.test(record.txHash)
  );
}

function read(storageKey: string): PendingAliasBinding | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function setPendingAliasBinding(
  accountAddress: string,
  txHash: string,
): void {
  const record = { accountAddress, txHash };
  if (!valid(record)) return;
  const storageKey = key(accountAddress, txHash);
  memoryFallback.set(storageKey, record);
  try {
    localStorage.setItem(storageKey, JSON.stringify(record));
  } catch {
    // Module memory retains the lock when persistent storage is unavailable.
  }
}

export function clearPendingAliasBinding(
  accountAddress: string,
  txHash: string,
): void {
  const storageKey = key(accountAddress, txHash);
  if (memoryFallback.get(storageKey)?.txHash === txHash) {
    memoryFallback.delete(storageKey);
  }
  try {
    if (read(storageKey) != null) localStorage.removeItem(storageKey);
  } catch {
    // Persistent storage is unavailable; module memory was handled above.
  }
}

export function hasPendingAliasBinding(accountAddress: string): boolean {
  const prefix = `${STORAGE_PREFIX}${accountAddress}:`;
  for (const [storageKey, record] of memoryFallback) {
    if (storageKey.startsWith(prefix) && record.accountAddress === accountAddress) {
      return true;
    }
  }
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const storageKey = localStorage.key(index);
      if (storageKey == null || !storageKey.startsWith(prefix)) continue;
      if (read(storageKey)?.accountAddress === accountAddress) return true;
    }
  } catch {
    // Persistent storage is unavailable; module memory was handled above.
  }
  return false;
}
