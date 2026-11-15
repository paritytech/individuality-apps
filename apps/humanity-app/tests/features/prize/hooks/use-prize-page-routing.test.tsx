// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Closing the scratch screen: opened from the home it steps back, so the
 *  system back button cannot bring the scratch card up again; reached from
 *  a link it swaps itself for the home. */
import { act, cleanup, render } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { usePrizePageRouting, type PrizePageRouting } from "@features/prize/hooks/use-prize-page-routing.ts";

let routing: PrizePageRouting | null = null;
function Probe() {
  routing = usePrizePageRouting("live", "home");
  return null;
}

function mount(start: string) {
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: Probe });
  const scratch = createRoute({ getParentRoute: () => root, path: "/scratch", component: Probe });
  const history = createMemoryHistory({ initialEntries: [start] });
  const router = createRouter({ routeTree: root.addChildren([home, scratch]), history });
  render(<RouterProvider router={router} />);
  return { router, history };
}

beforeAll(() => {
  // jsdom has no scrolling; the router restores scroll on every navigation.
  window.scrollTo = () => undefined;
});

afterEach(() => {
  cleanup();
  routing = null;
});

describe("usePrizePageRouting", () => {
  it("steps back to the home it was opened from", async () => {
    const { router, history } = mount("/");
    await act(async () => {
      await router.load();
    });
    await act(async () => {
      routing!.openDaily();
    });
    expect(router.state.location.pathname).toBe("/scratch");
    const entries = history.length;
    await act(async () => {
      routing!.closeDaily();
    });
    expect(router.state.location.pathname).toBe("/");
    // Back, not forward: no new entry behind the home.
    expect(history.length).toBe(entries);
    expect(history.canGoBack()).toBe(false);
  });

  it("swaps a linked scratch screen for the home", async () => {
    const { router, history } = mount("/scratch");
    await act(async () => {
      await router.load();
    });
    const entries = history.length;
    await act(async () => {
      routing!.closeDaily();
    });
    expect(router.state.location.pathname).toBe("/");
    expect(history.length).toBe(entries);
  });
});
