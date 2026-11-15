// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The face the app's own card read just produced, handed to the worker that
 * draws the Pocket card.
 *
 * The worker reads the chain for its face once a minute, so without this a
 * change the app has already seen (a registration or a name claim landing) is
 * up to a minute late on the Pocket card. The app and the worker share no
 * runtime, only the product's host storage, which has no change notification:
 * so the app writes the face here whenever its card read changes what the face
 * would show, and the worker, while its card is on screen, polls the key and
 * draws a hint that is newer than its own last read.
 *
 * The worker writes the faces of its own reads here too, and a write never
 * replaces a later read's, so the key holds the newest face either side has
 * read and a card coming back on screen starts from it at once instead of
 * waiting for a chain read. A failed read writes nothing.
 *
 * `readAt` is when the read behind the face started, in epoch milliseconds,
 * on whichever side made it. It is what decides between the two: the worker
 * draws a hint only when it is newer than its own read, and a read of its own
 * that started later replaces the hint again. Neither side is trusted over the
 * other; the later read wins.
 */
import { getLocalKvStore } from "@humanity/shared/storage/local-kv.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import type { PocketFace } from "@humanity/shared/pocket/humanity-face.ts";
import { sanitizePocketFaceState } from "@humanity/shared/pocket/pocket-face-override.ts";

const logger = loggerFor("pocket", "face-hint");

/** How far ahead of this device's clock a stored `readAt` may be. A later one
 *  was written while the clock ran ahead, and would outrank every real read
 *  until the clock caught up, so it is treated as no hint at all. */
const FUTURE_SLACK_MS = 60_000;

export const POCKET_FACE_HINT_KEY = "pocket:face-hint";

export interface PocketFaceHint {
  face: PocketFace;
  /** When the read behind `face` started, epoch milliseconds. */
  readAt: number;
}

function sanitize(raw: unknown): PocketFaceHint | null {
  if (raw == null || typeof raw !== "object") return null;
  if (!("readAt" in raw) || typeof raw.readAt !== "number" || !Number.isFinite(raw.readAt)) return null;
  if (raw.readAt > Date.now() + FUTURE_SLACK_MS) return null;
  if (!("face" in raw) || raw.face == null || typeof raw.face !== "object") return null;
  const face = raw.face as Record<string, unknown>;
  if (typeof face["name"] !== "string") return null;
  const state = sanitizePocketFaceState(face["state"]);
  if (state == null) return null;
  return { face: { name: face["name"], state }, readAt: raw.readAt };
}

export async function readPocketFaceHint(): Promise<PocketFaceHint | null> {
  try {
    const store = await getLocalKvStore();
    return sanitize(await store.getJSON<unknown>(POCKET_FACE_HINT_KEY));
  } catch (error: unknown) {
    logger.warning("pocket face hint read failed: {error}", { error });
    return null;
  }
}

/**
 * Stores `hint` unless the key already holds a face from a later read. Two
 * writers (the app, and one worker render or two) can still interleave within
 * one storage round trip; outside that the key never goes back in time.
 */
export async function writePocketFaceHint(hint: PocketFaceHint): Promise<void> {
  try {
    const store = await getLocalKvStore();
    const stored = sanitize(await store.getJSON<unknown>(POCKET_FACE_HINT_KEY));
    if (stored != null && stored.readAt > hint.readAt) return;
    await store.setJSON(POCKET_FACE_HINT_KEY, hint);
  } catch (error: unknown) {
    logger.warning("pocket face hint write failed: {error}", { error });
  }
}

/** Whether two faces draw the same card, so an unchanged one is not sent again. */
export function sameFace(a: PocketFace, b: PocketFace): boolean {
  return a.name === b.name && JSON.stringify(a.state) === JSON.stringify(b.state);
}
