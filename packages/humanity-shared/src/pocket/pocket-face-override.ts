// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A simulated standing for the Pocket card, handed from the app's debug panel
 * to the worker that draws the card.
 *
 * The two never share a runtime: the app is a page, the worker a headless
 * script the host keeps warm. What they share is the product's host storage,
 * which is how the daily-dollar registry already travels between them, so a
 * scenario picked in the panel is written there and the worker, while its card
 * is on screen, reads it back and draws that instead of the standing it would
 * derive. Cleared when the panel goes back to reading from chain.
 *
 * Only a debug-panel build reads or writes this: the key is namespaced to the
 * product and only the product can write its own storage, but a release worker
 * has no business honouring a stored override at all.
 */
import { getLocalKvStore } from "@humanity/shared/storage/local-kv.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import type { PocketFaceState } from "@humanity/shared/pocket/humanity-face.ts";

const logger = loggerFor("pocket", "face-override");

export const POCKET_FACE_OVERRIDE_KEY = "pocket:face-override";

const KNOWN_KIND: Record<PocketFaceState["kind"], true> = {
  "not-enrolled": true,
  devicehood: true,
  candidate: true,
  "membership-ready": true,
  member: true,
  caution: true,
  suspended: true,
};

function isFaceKind(kind: string): kind is PocketFaceState["kind"] {
  return Object.hasOwn(KNOWN_KIND, kind);
}

/**
 * The override as stored, or null when nothing is simulated or the value is
 * not one. The kind is what is checked: the fields are the panel's own, from
 * the same build, and the face tolerates a missing number by drawing less.
 */
export function sanitizePocketFaceState(raw: unknown): PocketFaceState | null {
  if (raw == null || typeof raw !== "object" || !("kind" in raw)) return null;
  if (typeof raw.kind !== "string" || !isFaceKind(raw.kind)) return null;
  // Narrowed by kind above; the rest of the shape is this build's own writing.
  const state: PocketFaceState = raw as PocketFaceState;
  return state;
}

export async function readPocketFaceOverride(): Promise<PocketFaceState | null> {
  try {
    const store = await getLocalKvStore();
    return sanitizePocketFaceState(await store.getJSON<unknown>(POCKET_FACE_OVERRIDE_KEY));
  } catch (error: unknown) {
    logger.warning("pocket face override read failed: {error}", { error });
    return null;
  }
}

export async function writePocketFaceOverride(state: PocketFaceState | null): Promise<void> {
  try {
    const store = await getLocalKvStore();
    if (state == null) {
      await store.remove(POCKET_FACE_OVERRIDE_KEY);
    } else {
      await store.setJSON(POCKET_FACE_OVERRIDE_KEY, state);
    }
  } catch (error: unknown) {
    logger.warning("pocket face override write failed: {error}", { error });
  }
}
