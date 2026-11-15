// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The debug gate must remove both the diagnostic route and its only user path. */
import type * as TanStackRouter from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.stubEnv("VITE_DEBUG_PANEL", "false");
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanStackRouter>();
  return { ...actual, createHashHistory: actual.createMemoryHistory };
});

import { router, routeTree } from "@app/router/index.tsx";

/** The leaf route a path resolves to, which is what the user ends up seeing. */
function matchedRouteId(path: string): string | undefined {
  return router.matchRoutes(path).at(-1)?.routeId;
}

describe("status route", () => {
  it("omits the diagnostic route when diagnostics are disabled", () => {
    expect(
      (routeTree.children ?? []).map((route) => route.path),
    ).not.toContain("/status");
  });

  it("falls the gated-out diagnostic path through to the catch-all", () => {
    expect(matchedRouteId("/status")).toBe("/$");
  });

  it("falls an unknown path through to the catch-all", () => {
    expect(matchedRouteId("/unknown/deep/path")).toBe("/$");
  });

  it("renders the card screen from the catch-all, not a not-found screen", () => {
    // Component identity is the contract: whatever "/" shows, an unmatched
    // path shows too. A redirect could silently not run; a match cannot.
    expect(router.routesById["/$"].options.component).toBe(
      router.routesById["/"].options.component,
    );
    expect(router.routesById["/$"].options.component).toBeTypeOf("function");
  });

  it("still resolves the card route itself", () => {
    expect(matchedRouteId("/")).toBe("/");
  });
});
