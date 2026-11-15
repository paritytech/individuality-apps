// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Which game's caution-day sheet this device has already answered. One
 *  sheet per game: once it is put away, for either reason, the home stays
 *  quiet until the next game. Read synchronously like the other per-device
 *  flags, so a returning visit never sees it flash. Keyed on the network
 *  alone, so a query-cache schema bump does not raise the sheet again. */
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { NETWORK_SCOPE } from "@shared/chain/query-persistence.ts";

const KEY = `humanity-prizes:caution-sheet:${NETWORK_SCOPE}`;
const VERSION = 1;

const logger = loggerFor("card", "caution-sheet-store");

let cached: number | null | undefined;

/** The game index whose sheet was put away, or null. */
export function readCautionSheetAnswered(): number | null {
  if (cached !== undefined) return cached;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw == null ? null : JSON.parse(raw);
    const record = parsed as { version?: unknown; gameIndex?: unknown } | null;
    cached =
      record != null && record.version === VERSION && typeof record.gameIndex === "number"
        ? record.gameIndex
        : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function answerCautionSheet(gameIndex: number): void {
  cached = gameIndex;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ version: VERSION, gameIndex }));
  } catch (error: unknown) {
    logger.warning("could not remember the caution sheet: {error}", { error });
  }
}

export function resetCautionSheetStoreForTests(): void {
  cached = undefined;
}
