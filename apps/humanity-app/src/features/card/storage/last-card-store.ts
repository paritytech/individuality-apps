// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { PERSIST_CACHE_SCOPE } from "@shared/chain/query-persistence.ts";
import {
  parseLastCard,
  serializeLastCard,
  type LastCardPayload,
  type LastCardSnapshot,
} from "@features/card/domain/last-card-snapshot.ts";
import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";

const LAST_CARD_KEY = `humanity-prizes:last-card:${PERSIST_CACHE_SCOPE}`;

const logger = loggerFor("card", "last-card-store");

let cachedSnapshot: LastCardSnapshot | null | undefined;

/**
 * Uses `window.localStorage` like query persistence: host KV is async, so it
 * cannot provide a first-render fallback without a skeleton flash.
 */
export function readLastCard(): LastCardSnapshot | null {
  if (cachedSnapshot !== undefined) return cachedSnapshot;
  try {
    cachedSnapshot = parseLastCard(window.localStorage.getItem(LAST_CARD_KEY));
  } catch {
    cachedSnapshot = null;
  }
  return cachedSnapshot;
}

/**
 * Writes only a resolved card; blocked or full browser storage is a no-op.
 *
 * A failure is logged rather than swallowed: `JSON.stringify` throws on a
 * `bigint`, so a raw chain value leaking into `ResolvedHumanityCard` would
 * otherwise disable the whole fallback in silence.
 */
export function writeLastCard(
  username: string,
  card: ResolvedHumanityCard,
): void {
  try {
    const raw = serializeLastCard(
      username,
      card as LastCardPayload,
      Date.now(),
    );
    const snapshot = parseLastCard(raw);
    if (snapshot == null) {
      logger.warning("last card rejected its own serialization; fallback unavailable");
      return;
    }
    window.localStorage.setItem(LAST_CARD_KEY, raw);
    cachedSnapshot = snapshot;
  } catch (error: unknown) {
    // Durability is opportunistic; an unavailable browser store must not fail a read.
    logger.warning("could not persist the last card: {error}", { error });
  }
}

/** Drops the durable fallback so the next read must come from chain. */
export function clearLastCard(): void {
  try {
    window.localStorage.removeItem(LAST_CARD_KEY);
  } catch (error: unknown) {
    logger.warning("could not clear the last card: {error}", { error });
  }
  cachedSnapshot = null;
}

/** Drops the stable snapshot reference between isolated test runs. */
export function resetLastCardStore(): void {
  cachedSnapshot = undefined;
}
