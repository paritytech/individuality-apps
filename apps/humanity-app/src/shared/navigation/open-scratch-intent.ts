// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Whether the page was opened to scratch: the Pocket card's scratch link
 * (`pocketScratchDeeplink`) loads the page as `https://<product>?card=humanity&open=scratch`.
 *
 * Read once, the first time it is asked, and taken out of the address bar so a
 * reload or a back step does not open the scratch again. The routes are in the
 * hash, so the query before it is free for this and dropping it leaves the
 * route as it was.
 */
import { OPEN_PARAM, OPEN_SCRATCH } from "@humanity/shared/pocket/pocket-card-link.ts";

let pending: boolean | null = null;

function readAndStrip(): boolean {
  if (typeof window === "undefined") return false;
  const url = new URL(window.location.href);
  if (url.searchParams.get(OPEN_PARAM) !== OPEN_SCRATCH) return false;
  url.searchParams.delete(OPEN_PARAM);
  window.history.replaceState(window.history.state, "", url.toString());
  return true;
}

/** Whether a scratch was asked for and not yet handled. */
export function openScratchPending(): boolean {
  pending ??= readAndStrip();
  return pending;
}

/** Marks the request handled, whether the scratch opened or there was none to open. */
export function settleOpenScratch(): void {
  pending = false;
}

/** Exposed for tests so each case starts from a fresh load. */
export function __resetOpenScratchIntentForTests(): void {
  pending = null;
}
