// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { DotnsNameClaimRecord } from "@features/card/domain/dotns-name-claim.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { NETWORK_SCOPE } from "@shared/chain/query-persistence.ts";

const PREFIX = `humanity:dotns-name-claim:${NETWORK_SCOPE}:`;
const VERSION = 1;
const logger = loggerFor("card", "dotns-name-claim-store");

const STATUSES: Record<DotnsNameClaimRecord["status"], true> = {
  sending: true,
  sent: true,
  stopped: true,
};

const listeners = new Set<() => void>();

/** Re-render hook for the debug panel; the record itself is read on demand. */
export function subscribeDotnsNameClaim(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readDotnsNameClaim(owner: string): DotnsNameClaimRecord | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + owner);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      record?: { status?: unknown; at?: unknown; label?: unknown };
    } | null;
    const record = parsed?.record;
    if (
      parsed?.version !== VERSION ||
      record == null ||
      typeof record.at !== "number" ||
      typeof record.label !== "string" ||
      typeof record.status !== "string" ||
      !(record.status in STATUSES)
    ) {
      return null;
    }
    return record as DotnsNameClaimRecord;
  } catch {
    return null;
  }
}

export function writeDotnsNameClaim(owner: string, record: DotnsNameClaimRecord): void {
  try {
    window.localStorage.setItem(PREFIX + owner, JSON.stringify({ version: VERSION, record }));
  } catch (error: unknown) {
    logger.warning("could not remember the dotNS claim: {error}", { error });
  }
  for (const listener of [...listeners]) listener();
}

export function clearDotnsNameClaim(owner: string): void {
  try {
    window.localStorage.removeItem(PREFIX + owner);
  } catch (error: unknown) {
    logger.warning("could not forget the dotNS claim: {error}", { error });
  }
  for (const listener of [...listeners]) listener();
}
