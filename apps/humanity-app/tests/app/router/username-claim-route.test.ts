// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type * as TanStackRouter from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanStackRouter>();
  return { ...actual, createHashHistory: actual.createMemoryHistory };
});

import { router, routeTree } from "@app/router/index.tsx";

describe("username claim route", () => {
  it("exposes a stable direct-link path", () => {
    expect(router.matchRoutes("/claim-username").at(-1)?.routeId).toBe(
      "/claim-username",
    );
  });

  it("registers the direct link as an explicit route, not the catch-all", () => {
    expect(router.routesById["/claim-username"].options.component).not.toBe(
      router.routesById["/$"].options.component,
    );
    expect(routeTree.children).toBeDefined();
  });
});
