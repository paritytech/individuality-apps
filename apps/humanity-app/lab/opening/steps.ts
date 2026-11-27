// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { fail } from "@parity/product-lab";
import { step } from "@parity/product-lab/steps";
import type { BrowserPage } from "@parity/product-lab/ports/browser";
import { opened } from "./session.ts";

export interface OpeningObservation {
  home: boolean;
  card: boolean;
  username: string | null;
  label: string | null;
}
export function assertOpening(seen: OpeningObservation, username: string, label: string): void {
  if (!seen.home) fail("screen-mismatch", "Humanity home is missing");
  if (!seen.card) fail("screen-mismatch", "Humanity membership card is missing");
  if (seen.username !== username) fail("screen-mismatch", `Card username ${JSON.stringify(seen.username)} does not match the provisioned username`);
  if (seen.label !== label) fail("screen-mismatch", `Card label ${JSON.stringify(seen.label)} does not match ${JSON.stringify(label)}`);
}
export async function observeOpening(page: BrowserPage): Promise<OpeningObservation> {
  return page.evaluate(() => {
    const seen: Record<string, string | null> = {};
    // Keep this callback self-contained when the TS runner serializes it into the browser.
    for (const id of ["humanity-home", "membership-card", "card-username", "card-label"]) {
      const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      seen[id] = element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden" ? element.textContent?.trim() ?? "" : null;
    }
    return { home: seen["humanity-home"] !== null, card: seen["membership-card"] !== null,
      username: seen["card-username"] ?? null, label: seen["card-label"] ?? null };
  }, undefined);
}
step('{actor} sees the Humanity card labelled {string}', async ({ lab }, name, expected) => {
  const state = opened.get(lab.actor(String(name)).id);
  if (!state) throw new Error("No owned Humanity host session");
  await state.page.getByTestId("humanity-home").waitFor({ state: "visible", timeout: 120_000 });
  await state.page.getByTestId("membership-card").waitFor({ state: "visible", timeout: 120_000 });
  const seen = await observeOpening(state.page);
  await lab.attach({ opening: seen, expected: String(expected) });
  assertOpening(seen, state.username, String(expected));
}, { timeoutMs: 260_000 });
step("{actor} reloads Humanity", async ({ lab }, name) => {
  const state = opened.get(lab.actor(String(name)).id);
  if (!state) throw new Error("No owned Humanity host session");
  await state.reload();
}, { timeoutMs: 120_000 });
step("{actor} shows the inline card for a host without Pocket", async ({ lab }, name) => {
  const state = opened.get(lab.actor(String(name)).id);
  if (!state) throw new Error("No owned Humanity host session");
  await state.showCard();
  await lab.attach({ presentation: "Existing Shown control; live chain card, no simulated scenario" });
}, { timeoutMs: 120_000 });
step("the opening fork has advancing finalized heads", async ({ lab }) => {
  const state = opened.get(lab.actor("Ada").id);
  if (!state) throw new Error("No owned Humanity host session");
  await lab.attach({ chains: await state.heads() });
}, { timeoutMs: 260_000 });
