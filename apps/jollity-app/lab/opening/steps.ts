// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { fail } from "@parity/product-lab";
import { step } from "@parity/product-lab/steps";
import type { BrowserPage } from "@parity/product-lab/ports/browser";
import { opened } from "./session.ts";
export interface OpeningObservation {
  home: boolean; status: string | null; register: boolean; source: string | null; account: string | null; registered: string | null;
}
export function assertOpening(seen: OpeningObservation, account: string, registered: string) {
  if (!seen.home || !seen.status || !seen.register) fail("screen-mismatch", "DIM2 home, status or Register control is missing");
  if (seen.source !== "host" || seen.account !== account) fail("screen-mismatch", "DIM2 home does not render its host account");
  if (seen.registered !== registered) fail("screen-mismatch", `DIM2 registered ${JSON.stringify(seen.registered)} does not match ${JSON.stringify(registered)}`);
}
export async function observeOpening(page: BrowserPage): Promise<OpeningObservation> {
  return page.evaluate(() => {
    const home = document.querySelector<HTMLElement>('[data-testid="home"]');
    const status = document.querySelector<HTMLElement>('[data-testid="home-status"]');
    const register = document.querySelector<HTMLElement>('[data-testid="home-register"]');
    return { home: !!home?.getClientRects().length, status: status?.getClientRects().length ? status.textContent?.trim() ?? null : null,
      register: !!register?.getClientRects().length, source: home?.getAttribute("data-source") ?? null,
      account: home?.getAttribute("data-account") ?? null, registered: home?.getAttribute("data-registered") ?? null };
  }, undefined);
}
step('{actor} sees DIM2 registered as {string}', async ({ lab }, name, expected) => {
  const state = opened.get(lab.actor(String(name)).id);
  if (!state) throw new Error("No owned DIM2 host session");
  for (const id of ["home", "home-status", "home-register"]) await state.page.getByTestId(id).waitFor({ state: "visible", timeout: 120_000 });
  const seen = await observeOpening(state.page);
  await lab.attach({ opening: seen, expected: String(expected) });
  assertOpening(seen, state.account, String(expected));
}, { timeoutMs: 380_000 });
step("{actor} reloads DIM2", async ({ lab }, name) => {
  const state = opened.get(lab.actor(String(name)).id);
  if (!state) throw new Error("No owned DIM2 host session");
  await state.reload();
}, { timeoutMs: 320_000 });
step("{actor} has a readable DIM2 lite proof", async ({ lab }, name) => {
  const state = opened.get(lab.actor(String(name)).id);
  if (!state) throw new Error("No owned DIM2 host session");
  await lab.attach({ liteProof: await state.proof() });
}, { timeoutMs: 130_000 });
step("the opening fork has advancing finalized heads", async ({ lab }) => {
  const state = opened.get(lab.actor("Ada").id);
  if (!state) throw new Error("No owned DIM2 host session");
  await lab.attach({ chains: await state.heads() });
}, { timeoutMs: 260_000 });
