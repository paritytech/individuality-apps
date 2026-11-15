// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type * as TanStackRouter from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof TanStackRouter>();
  return { ...actual, createHashHistory: actual.createMemoryHistory };
});

import { router } from "@app/router/index.tsx";

describe("scratch route", () => {
  it("exposes the scratch card as a stable direct-link path", () => {
    expect(router.matchRoutes("/scratch").at(-1)?.routeId).toBe("/scratch");
  });

  it("does not resolve through the catch-all", () => {
    expect(router.routesById["/scratch"].options.component).not.toBe(
      router.routesById["/$"].options.component,
    );
  });
});
