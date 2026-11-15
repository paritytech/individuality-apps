// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pending username upgrades are isolated by expected lite address and
 *  broadcast transaction hash. The lite identity is the only stable per-user
 *  key while a fresh standalone username is being registered. A marker is
 *  written on first broadcast (`broadcast`), advanced to `included` once the
 *  claim is in a best block, and retired by the finalized card read, the
 *  best-block reconciliation, a failed outcome, or era expiry; until then a
 *  reload still sees it and disables resubmission. Each marker records the
 *  era checkpoint after which its signed transaction can no longer be
 *  included.
 *
 *  A claim that is known not to have gone through leaves a failed record per
 *  address so the claim page can say so; the next broadcast replaces it. */
const STORAGE_PREFIX = "humanity:pending-username-upgrade:";
const FAILED_STORAGE_PREFIX = "humanity:failed-username-upgrade:";

export type PendingUpgradePhase = "broadcast" | "included";

export interface PendingUpgradeRecord {
  address: string;
  fullUsername: string;
  txHash: string;
  /** Era checkpoint (finalized start block + mortality period) after which
   *  the signed transaction can no longer be included. */
  expiresAtBlock: number;
  phase: PendingUpgradePhase;
  /** Broadcast time in ms since epoch; 0 for records persisted before it
   *  was tracked. */
  broadcastAt: number;
}

export interface FailedUpgradeRecord {
  address: string;
  fullUsername: string;
}

const memoryFallback = new Map<string, PendingUpgradeRecord>();
const failedMemoryFallback = new Map<string, FailedUpgradeRecord>();
const listeners = new Set<() => void>();
let stateVersion = 0;

const FULL_USERNAME_PATTERN = /^[a-z]{6,32}$/;

function identityPrefix(address: string): string {
  return `${STORAGE_PREFIX}${address}:`;
}

function upgradeKey(address: string, txHash: string): string {
  return `${identityPrefix(address)}${txHash}`;
}

function failedKey(address: string): string {
  return `${FAILED_STORAGE_PREFIX}${address}`;
}

function notify(): void {
  stateVersion += 1;
  for (const listener of [...listeners]) listener();
}

/** Normalizes a stored marker, defaulting fields absent from legacy records. */
function parsePendingUpgradeRecord(value: unknown): PendingUpgradeRecord | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const phase = record.phase === undefined ? "broadcast" : record.phase;
  const broadcastAt = record.broadcastAt === undefined ? 0 : record.broadcastAt;
  if (
    typeof record.address !== "string" ||
    record.address.length === 0 ||
    typeof record.fullUsername !== "string" ||
    !FULL_USERNAME_PATTERN.test(record.fullUsername) ||
    typeof record.txHash !== "string" ||
    !/^0x[0-9a-f]+$/i.test(record.txHash) ||
    typeof record.expiresAtBlock !== "number" ||
    !Number.isInteger(record.expiresAtBlock) ||
    record.expiresAtBlock <= 0 ||
    (phase !== "broadcast" && phase !== "included") ||
    typeof broadcastAt !== "number" ||
    !Number.isFinite(broadcastAt) ||
    broadcastAt < 0
  ) {
    return null;
  }
  return {
    address: record.address,
    fullUsername: record.fullUsername,
    txHash: record.txHash,
    expiresAtBlock: record.expiresAtBlock,
    phase,
    broadcastAt,
  };
}

function parseFailedUpgradeRecord(value: unknown): FailedUpgradeRecord | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.address !== "string" ||
    record.address.length === 0 ||
    typeof record.fullUsername !== "string" ||
    !FULL_USERNAME_PATTERN.test(record.fullUsername)
  ) {
    return null;
  }
  return { address: record.address, fullUsername: record.fullUsername };
}

function readStoredJson<T>(
  key: string,
  parse: (value: unknown) => T | null,
): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return parse(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Module memory retains the value when persistent storage is unavailable.
  }
}

/** Removes `key` from storage only when it holds a value `parse` accepts. */
function removeStoredJson<T>(
  key: string,
  parse: (value: unknown) => T | null,
): boolean {
  try {
    if (readStoredJson(key, parse) == null) return false;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function writePendingRecord(record: PendingUpgradeRecord): void {
  const key = upgradeKey(record.address, record.txHash);
  memoryFallback.set(key, record);
  writeStoredJson(key, record);
}

function removeFailedRecord(address: string): boolean {
  const removedFromMemory = failedMemoryFallback.delete(address);
  const removedFromStorage = removeStoredJson(
    failedKey(address),
    parseFailedUpgradeRecord,
  );
  return removedFromMemory || removedFromStorage;
}

export function setPendingUsernameUpgrade(
  address: string,
  fullUsername: string,
  txHash: string,
  expiresAtBlock: number,
): void {
  const record = parsePendingUpgradeRecord({
    address,
    fullUsername,
    txHash,
    expiresAtBlock,
    phase: "broadcast",
    broadcastAt: Date.now(),
  });
  if (record == null) return;
  writePendingRecord(record);
  removeFailedRecord(address);
  notify();
}

/** Advances an existing marker to `included`; a missing marker stays absent. */
export function markPendingUsernameUpgradeIncluded(
  address: string,
  txHash: string,
): void {
  const key = upgradeKey(address, txHash);
  const record =
    readStoredJson(key, parsePendingUpgradeRecord) ?? memoryFallback.get(key);
  if (record == null || record.phase === "included") return;
  writePendingRecord({ ...record, phase: "included" });
  notify();
}

export function clearPendingUsernameUpgrade(
  address: string,
  txHash: string,
): void {
  const key = upgradeKey(address, txHash);
  const removedFromMemory = memoryFallback.delete(key);
  const removedFromStorage = removeStoredJson(key, parsePendingUpgradeRecord);
  if (removedFromMemory || removedFromStorage) notify();
}

/** A marker no longer gates once the finalized block has reached its
 *  era-checkpoint expiry; expired markers are removed eagerly on inspection.
 *  Only a finite nonnegative checkpoint can expire a marker — anything else
 *  is treated as "no block known" and leaves the marker locked. */
function isUpgradeExpired(
  record: PendingUpgradeRecord,
  finalizedBlock?: number,
): boolean {
  return (
    finalizedBlock != null &&
    Number.isFinite(finalizedBlock) &&
    finalizedBlock >= 0 &&
    finalizedBlock >= record.expiresAtBlock
  );
}

function isNewer(
  candidate: PendingUpgradeRecord,
  current: PendingUpgradeRecord | null,
): boolean {
  if (current == null) return true;
  if (candidate.broadcastAt !== current.broadcastAt) {
    return candidate.broadcastAt > current.broadcastAt;
  }
  return candidate.expiresAtBlock > current.expiresAtBlock;
}

/** Newest unexpired marker for `address` (by broadcast time, then era
 *  checkpoint). Persisted copies win over module memory so another tab's
 *  phase advance is seen. */
export function readPendingUsernameUpgrade(
  address: string,
  finalizedBlock?: number,
): PendingUpgradeRecord | null {
  const prefix = identityPrefix(address);
  const candidates = new Map<string, PendingUpgradeRecord>();
  for (const [key, record] of memoryFallback) {
    if (key.startsWith(prefix) && record.address === address) {
      candidates.set(key, record);
    }
  }
  try {
    // Snapshot keys first: removing while indexing would skip entries.
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key != null && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      const record = readStoredJson(key, parsePendingUpgradeRecord);
      if (record != null && record.address === address) {
        candidates.set(key, record);
      }
    }
  } catch {
    // A storage failure leaves only the module-memory candidates above.
  }

  let newest: PendingUpgradeRecord | null = null;
  let removedExpired = false;
  for (const [key, record] of candidates) {
    if (isUpgradeExpired(record, finalizedBlock)) {
      memoryFallback.delete(key);
      removeStoredJson(key, parsePendingUpgradeRecord);
      removedExpired = true;
      continue;
    }
    if (isNewer(record, newest)) newest = record;
  }
  if (removedExpired) notify();
  return newest;
}

export function hasPendingUsernameUpgrade(
  address: string,
  finalizedBlock?: number,
): boolean {
  return readPendingUsernameUpgrade(address, finalizedBlock) != null;
}

export function recordFailedUsernameUpgrade(
  address: string,
  fullUsername: string,
): void {
  const record = parseFailedUpgradeRecord({ address, fullUsername });
  if (record == null) return;
  failedMemoryFallback.set(address, record);
  writeStoredJson(failedKey(address), record);
  notify();
}

export function readFailedUsernameUpgrade(
  address: string,
): FailedUpgradeRecord | null {
  const stored = readStoredJson(failedKey(address), parseFailedUpgradeRecord);
  if (stored != null && stored.address === address) return stored;
  return failedMemoryFallback.get(address) ?? null;
}

export function clearFailedUsernameUpgrade(address: string): void {
  if (removeFailedRecord(address)) notify();
}

/** Same-tab change feed for every marker and failed-record mutation. */
export function subscribeUsernameUpgradeState(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic snapshot token for `useSyncExternalStore`; bumps per notification. */
export function getUsernameUpgradeStateVersion(): number {
  return stateVersion;
}
