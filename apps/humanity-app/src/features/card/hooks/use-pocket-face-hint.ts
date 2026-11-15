// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Hands each fresh card read to the worker that draws the Pocket card.
 *
 * The worker reads the chain for its face once a minute; the app reads the card
 * every 12 seconds and again the moment a registration or a name claim lands,
 * since those flows invalidate the card query. Writing the face of that read to
 * the product's storage (`pocket-face-hint.ts`) is what lets the Pocket card
 * follow within the worker's two-second poll instead of a minute later.
 *
 * Only a live read is handed over, never the durable snapshot or a hydrated
 * cache entry the app has not read since mount (the caller decides `live`),
 * and only when it changes the face: the worker draws a hint only if it is
 * newer than its own read, and the write never replaces a later read's.
 */
import { useEffect } from "react";

import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import type { PocketFace } from "@humanity/shared/pocket/humanity-face.ts";
import { sameFace, writePocketFaceHint } from "@humanity/shared/pocket/pocket-face-hint.ts";
import { pocketFaceOf } from "@humanity/shared/pocket/pocket-face-state.ts";

/** The last face handed over by any card hook on the page, so two mounted
 *  readers of the same card do not each write it. */
let handedOver: PocketFace | null = null;

export function usePocketFaceHint(
  card: HumanityCardResult | undefined,
  /** When the read behind `card` landed; 0 for no read in this session. */
  readAt: number,
  live: boolean,
): void {
  // The face as a string, so the effect runs when what it says changes, not
  // whenever the card hook hands back a new object.
  const key = live && readAt > 0 && card?.kind === "card" ? JSON.stringify(pocketFaceOf(card)) : null;
  useEffect(() => {
    if (key == null) return;
    const face = JSON.parse(key) as PocketFace;
    if (handedOver != null && sameFace(handedOver, face)) return;
    handedOver = face;
    void writePocketFaceHint({ face, readAt });
  }, [key, readAt]);
}

export function resetPocketFaceHintForTests(): void {
  handedOver = null;
}
