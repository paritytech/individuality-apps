// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The debug store outlives builds like every other browser state. A scenario
 *  id persisted by an older build (`lite`, until 2026-09-04) must hydrate to
 *  no scenario, and an older build's `open`/`pos` (the draggable dock, until
 *  2026-09-15) must not resurrect a panel or a dock anchor this build has no
 *  affordance for, while the rest of the persisted state and every action
 *  stay. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../prize/chain/pending-daily-claim.fixtures.ts";

vi.mock("@humanity/shared/chain/connection.ts", () => ({ getProviderDiagnostics: () => ({}) }));
vi.mock("@humanity/shared/identity/game-account.ts", () => ({ getGameAccountDiagnostics: () => ({}) }));
vi.mock("@humanity/shared/chain/resources-alias.ts", () => ({ getResourcesAliasDiagnostics: () => ({}) }));
vi.mock("@humanity/shared/chain/host-api.ts", () => ({ isInsideContainerSync: () => false }));

// The store persists through `localStorage`. Own the storage rather than
// borrow the runtime's: Node 25 ships an experimental Web Storage global
// that shadows jsdom's and has no `clear()` without `--localstorage-file`.
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("debug store hydration", () => {
  it("drops a persisted scenario and dock state this build no longer has, keeping the rest", async () => {
    window.localStorage.setItem(
      "humanity-prizes:debug",
      JSON.stringify({
        state: { open: true, pos: { x: 1, y: 2 }, scenario: "lite" },
        version: 0,
      }),
    );

    const { useDebugStore } = await import("@features/debug/debug-store.ts");
    const state = useDebugStore.getState();

    expect(state.scenario).toBeNull();
    expect(state.open).toBe(false);
    // `pos` is gone from the state shape, so the persisted value must not
    // survive as a stray key either.
    expect("pos" in state).toBe(false);
    expect(typeof state.setScenario).toBe("function");
  });

  it("keeps a persisted scenario this build knows", async () => {
    window.localStorage.setItem(
      "humanity-prizes:debug",
      JSON.stringify({ state: { scenario: "member" }, version: 0 }),
    );

    const { useDebugStore } = await import("@features/debug/debug-store.ts");

    expect(useDebugStore.getState().scenario).toBe("member");
  });

  it("clamps a persisted candidate progress and fills what is missing", async () => {
    window.localStorage.setItem(
      "humanity-prizes:debug",
      JSON.stringify({ state: { candidateProgress: { score: 40 } }, version: 0 }),
    );

    const { useDebugStore } = await import("@features/debug/debug-store.ts");

    expect(useDebugStore.getState().candidateProgress).toEqual({ score: 10, threshold: 10 });
  });

  it("snaps persisted member weeks to a tier and defaults them when missing", async () => {
    window.localStorage.setItem(
      "humanity-prizes:debug",
      JSON.stringify({ state: { memberWeeks: 60 }, version: 0 }),
    );
    const { useDebugStore } = await import("@features/debug/debug-store.ts");
    expect(useDebugStore.getState().memberWeeks).toBe(52);

    vi.resetModules();
    window.localStorage.setItem("humanity-prizes:debug", JSON.stringify({ state: {}, version: 0 }));
    const fresh = await import("@features/debug/debug-store.ts");
    expect(fresh.useDebugStore.getState().memberWeeks).toBe(2);
  });

  it("keeps a persisted promotion style it knows and drops one it does not", async () => {
    window.localStorage.setItem(
      "humanity-prizes:debug",
      JSON.stringify({ state: { promotionStyle: "sweep" }, version: 0 }),
    );
    const { useDebugStore } = await import("@features/debug/debug-store.ts");
    expect(useDebugStore.getState().promotionStyle).toBe("sweep");

    vi.resetModules();
    window.localStorage.setItem(
      "humanity-prizes:debug",
      JSON.stringify({ state: { promotionStyle: "confetti" }, version: 0 }),
    );
    const fresh = await import("@features/debug/debug-store.ts");
    const { DEFAULT_PROMOTION_STYLE } = await import("@features/card/domain/promotion-style.ts");
    expect(fresh.useDebugStore.getState().promotionStyle).toBe(DEFAULT_PROMOTION_STYLE);
  });
});
