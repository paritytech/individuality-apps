// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Hash history is REQUIRED — this app runs inside the Polkadot Desktop webview
 * and in a web iframe, neither of which drives path-based history reliably.
 */

import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useSearch,
} from "@tanstack/react-router";

import { PrizePage } from "@features/prize/pages/PrizePage.tsx";
import { UsernameClaimPage } from "@features/card/pages/UsernameClaimPage.tsx";
import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";
// Keep this static so Vite removes ConnectionStatus when DEBUG_PANEL folds off.
import { ConnectionStatus } from "@features/status/pages/ConnectionStatus.tsx";
import { DebugPage } from "@features/debug/DebugPage.tsx";
import { RootLayout } from "./layouts.tsx";

const rootRoute = createRootRoute({ component: RootLayout });

/**
 * `strict: false` reads the demo param from whichever route matched, so the
 * card screen is mountable from the catch-all as well as from "/".
 */
const HINT_IDS = ["card", "register", "stripe"] as const;
type HintParam = "1" | (typeof HINT_IDS)[number];

function validatePrizeSearch(search: Record<string, unknown>): {
  demo: string | undefined;
  /** DEV-only: `hint=1` shows the next onboarding hint on a fixture, a hint
   *  name shows that one. Optional, so navigations that only carry `demo`
   *  need not mention it. */
  hint?: HintParam;
} {
  const raw = search["hint"];
  // The router JSON-parses search values, so `hint=1` arrives as a number.
  const hint: HintParam | undefined =
    raw === "1" || raw === 1
      ? "1"
      : typeof raw === "string" && (HINT_IDS as readonly string[]).includes(raw)
        ? (raw as HintParam)
        : undefined;
  return {
    demo: typeof search["demo"] === "string" ? search["demo"] : undefined,
    ...(hint == null ? {} : { hint }),
  };
}

function CardScreen({ screen = "home" }: { screen?: "home" | "daily" }) {
  const search = useSearch({ strict: false });
  const demoHint = search.hint == null ? false : search.hint === "1" ? true : search.hint;
  return <PrizePage demo={search.demo} demoHint={demoHint} routeScreen={screen} />;
}

const prizeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validatePrizeSearch,
  component: CardScreen,
});

function ScratchScreen() {
  return <CardScreen screen="daily" />;
}

const scratchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scratch",
  validateSearch: validatePrizeSearch,
  component: ScratchScreen,
});

const usernameClaimRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/claim-username",
  component: UsernameClaimPage,
});

const statusRoute = DEBUG_PANEL
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: "/status",
      component: ConnectionStatus,
    })
  : null;

const debugRoute = DEBUG_PANEL
  ? createRoute({
      getParentRoute: () => rootRoute,
      path: "/debug",
      component: DebugPage,
    })
  : null;

/**
 * Any unmatched hash path — including `/status` in a build where the
 * diagnostic route folded out — renders the card.
 *
 * Deliberately a component and not a `beforeLoad` redirect: a thrown redirect
 * only settles once the router's load cycle runs it, whereas matching this
 * route is unconditional. The user must never reach a diagnostic dump or a
 * not-found screen, so the fallback may not depend on a lifecycle firing.
 */
const fallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  component: CardScreen,
});

export const routeTree = rootRoute.addChildren([
  prizeRoute,
  scratchRoute,
  usernameClaimRoute,
  fallbackRoute,
  ...(statusRoute == null ? [] : [statusRoute]),
  ...(debugRoute == null ? [] : [debugRoute]),
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
