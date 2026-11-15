// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

/** The launch opens the name screen once a visit: after it has, the system
 *  back button lands on the home and stays there. A real router and the
 *  real session and auto-open run here; only the name page's reads are
 *  mocked. */
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const TARGET = {
  kind: "available",
  accountAddress: ACCOUNT,
  currentLiteUsername: "marlow.42",
  suggestedUsername: "marlow",
} as const;

vi.mock("@features/card/hooks/use-humanity-card.ts", () => ({
  useHumanityCard: () => ({
    data: {
      kind: "card",
      accountAddress: ACCOUNT,
      primaryUsername: "marlow.42",
      state: { kind: "member", activeWeeks: 3, lastAttendedGame: 42, attendanceHistory: 0xff, window: 8 },
      snapshot: { isUpgradedIdentity: false, participant: { recognition: "NotRecognized" } },
    },
    isPending: false,
    error: null,
  }),
}));
vi.mock("@features/card/hooks/use-username-upgrade-action.ts", () => ({
  useUsernameUpgradeAction: () => ({
    target: TARGET,
    action: {
      identityKey: ACCOUNT,
      suggestedUsername: "marlow",
      pending: false,
      unknown: false,
      confirmed: false,
      onSubmit: () => undefined,
    },
  }),
}));
vi.mock("@features/card/hooks/use-username-availability.ts", async (original) => ({
  ...(await original<typeof import("@features/card/hooks/use-username-availability.ts")>()),
  useUsernameAvailability: (name: string) => ({ status: "available", name }),
}));
vi.mock("@features/card/hooks/use-full-personhood.ts", () => ({
  useFullPersonhood: () => ({ data: false, isPending: false, error: null }),
}));

import { UsernameClaimPage } from "@features/card/pages/UsernameClaimPage.tsx";
import { useAutoOpenHumanityAction } from "@features/prize/hooks/use-auto-open-humanity-action.ts";
import { HumanityActionSessionProvider } from "@shared/navigation/humanity-action-session.tsx";

function Home() {
  useAutoOpenHumanityAction({ enabled: true, ready: true, usernameTarget: TARGET });
  return createElement("p", null, "home");
}

beforeAll(() => {
  window.scrollTo = () => undefined;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(cleanup);

describe("the name screen and the system back", () => {
  it("does not open again once the person goes back", async () => {
    const root = createRootRoute();
    const home = createRoute({ getParentRoute: () => root, path: "/", component: Home });
    const claim = createRoute({ getParentRoute: () => root, path: "/claim-username", component: UsernameClaimPage });
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const router = createRouter({ routeTree: root.addChildren([home, claim]), history });
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(HumanityActionSessionProvider, null, createElement(RouterProvider, { router })),
      ),
    );
    await act(async () => {
      await router.load();
    });
    // The launch opens the name screen.
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/claim-username"));

    await act(async () => {
      history.back();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(router.state.location.pathname).toBe("/");
  });
});
