// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The stripe share the Pocket card last drew, kept in the product's storage.
 *
 * The host shows a card's last face the moment it comes on screen, before the
 * worker draws anything, so that face is where an animation has to start: a
 * worker that eased from empty would snap a full stripe back to nothing and
 * fill it again every time the card appeared. Remembering the share means an
 * unchanged standing does not move, and progress made while the card was off
 * screen fills in from where the person last saw it.
 */
import { getLocalKvStore } from "@humanity/shared/storage/local-kv.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("pocket", "last-fill");

export const POCKET_LAST_FILL_KEY = "pocket:last-fill";

/** The share last drawn, 0 to 1, or null when the card has never drawn a stripe. */
export async function readLastFill(): Promise<number | null> {
  try {
    const store = await getLocalKvStore();
    const raw = await store.getJSON<unknown>(POCKET_LAST_FILL_KEY);
    return typeof raw === "number" && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null;
  } catch (error: unknown) {
    logger.warning("pocket last fill read failed: {error}", { error });
    return null;
  }
}

export async function writeLastFill(share: number): Promise<void> {
  try {
    const store = await getLocalKvStore();
    await store.setJSON(POCKET_LAST_FILL_KEY, share);
  } catch (error: unknown) {
    logger.warning("pocket last fill write failed: {error}", { error });
  }
}
