// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Traverse DIM2's ordinary permission gate. No version file is configured here;
// the stale-build check is off. Refuse an update screen if one nevertheless appears.
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserPage } from "@parity/product-lab/ports/browser";
export async function reachHome(page: BrowserPage, signal: AbortSignal) {
  const started = Date.now();
  let homeSince: number | undefined;
  let last = "no document";
  while (Date.now() - started < 300_000) {
    signal.throwIfAborted();
    const state = await page.evaluate(() => {
      const home = document.querySelector('[data-testid="home"][data-source="host"][data-account]');
      const button = location.pathname.startsWith("/permissions") ? document.querySelector<HTMLButtonElement>("footer button") : null;
      return { home: !!home, update: !!document.querySelector('[data-testid="home-update"]'),
        button: button?.textContent?.trim(), disabled: button?.disabled,
        text: document.body.innerText.slice(0, 500) };
    }, undefined).catch(() => null);
    if (state) {
      last = state.text;
      if (state.update) throw new Error("DIM2's real stale-build gate requires an update: " + last);
      if (state.home) { homeSince ??= Date.now(); if (Date.now() - homeSince >= 15_000) return; }
      else homeSince = undefined;
      if (state.button === "Try again") throw new Error("DIM2 permission gate refused: " + last);
      if (state.button === "Allow access" && !state.disabled) await page.locator("footer button").click();
    }
    await delay(250, undefined, { signal });
  }
  throw new Error("DIM2 did not reach its host home: " + last);
}
