// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The Pocket card's face, moved out of the way while a full-screen surface is
 * up.
 *
 * Under an open Pocket card the host draws the card's face above the page. A
 * full-screen surface (the Daily Dollar scratch card, and any other that opts
 * in through `<Screen hideCardFace>`) asks the host to move it away, so the
 * page gets the whole screen and a `resize`; when the last such surface closes
 * the face comes back.
 *
 * Holds are counted here, in one place, so overlapping surfaces cannot flicker
 * the face: the first hold sends `shown: false`, the last release sends
 * `shown: true`. The release waits one tick, so a surface that replaces
 * another (a route change, a StrictMode remount) takes the hold over without
 * the face coming back in between.
 *
 * The face is never ours to keep (Pocket modality RFC): the user can drag it
 * back at any time, and nothing here undoes that. One request each way, and a
 * single retry when the host says the user was mid-drag, never a loop.
 *
 * Every refusal is a normal outcome, not an error: the page is not under an
 * open card (`NotPresented`), the host does not serve the call (browser, iOS
 * before the face API, Android release builds), or it declines. They are
 * logged at debug and never reach the UI; the page keeps its usual height,
 * which every screen already fits.
 */
import { useEffect } from "react";

import { getTruApi } from "@humanity/shared/chain/host-api.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

const logger = loggerFor("card-face");

/** How long to wait before the one retry after the host answers `UserMoving`:
 *  long enough for a drag to settle, short enough to land while the surface
 *  is still arriving. */
export const FACE_RETRY_MS = 500;

let holds = 0;
/** Whether the host was last asked to hide the face. */
let hidden = false;
/** Bumped on every request that changes what was last asked for, so a
 *  `UserMoving` answer to an older request can never schedule, or fire, a
 *  retry for a hide that has since been superseded. */
let generation = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let pendingShow: ReturnType<typeof setTimeout> | null = null;

function clearRetry(): void {
  if (retry == null) return;
  clearTimeout(retry);
  retry = null;
}

/**
 * Take a hold on the face being hidden. Returns its release, which is safe to
 * call more than once.
 */
export function holdCardFaceHidden(): () => void {
  holds += 1;
  if (pendingShow != null) {
    clearTimeout(pendingShow);
    pendingShow = null;
  }
  if (!hidden) {
    hidden = true;
    const hide = ++generation;
    const current = () => hidden && hide === generation;
    void setFaceShown(false, () => {
      if (!current()) return;
      clearRetry();
      retry = setTimeout(() => {
        retry = null;
        if (current()) void setFaceShown(false);
      }, FACE_RETRY_MS);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds > 0) return;
    pendingShow = setTimeout(() => {
      pendingShow = null;
      if (holds > 0 || !hidden) return;
      hidden = false;
      generation += 1;
      clearRetry();
      void setFaceShown(true);
    }, 0);
  };
}

/** Hold the face hidden while `active`; release it when `active` turns false
 *  or the caller unmounts. */
export function useCardFaceHidden(active: boolean): void {
  useEffect(() => (active ? holdCardFaceHidden() : undefined), [active]);
}

/** One `expandedCard.setFaceShown` call. `onUserMoving` runs when the host
 *  reports a drag in progress (the request had no effect); every other
 *  refusal, and a host with no TrUAPI at all, ends here as a debug line. */
async function setFaceShown(shown: boolean, onUserMoving?: () => void): Promise<void> {
  try {
    const truApi = await getTruApi();
    if (truApi == null) {
      logger.debug("No host API; the card face stays as it is (shown: {shown})", { shown });
      return;
    }
    const result = await truApi.expandedCard.setFaceShown({ shown });
    if (result.isOk()) {
      logger.debug("Card face {state}", { state: shown ? "shown" : "hidden" });
      return;
    }
    const error = result.error;
    const reason = error.tag === "Domain" ? error.value.value.tag : error.tag;
    if (reason === "UserMoving" && onUserMoving != null) {
      logger.debug("Card face is being dragged; retrying once (shown: {shown})", { shown });
      onUserMoving();
      return;
    }
    logger.debug("Host left the card face as it is (shown: {shown}): {reason}", { shown, reason });
  } catch (error) {
    logger.debug("Card face request failed (shown: {shown}): {error}", { shown, error });
  }
}

/** Test-only: forget every hold and pending request. */
export function __resetCardFaceForTests(): void {
  holds = 0;
  hidden = false;
  generation = 0;
  clearRetry();
  if (pendingShow != null) clearTimeout(pendingShow);
  pendingShow = null;
}
