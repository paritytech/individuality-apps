// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The claim runs under a shared mutation key, so a reader elsewhere can
 *  tell a claim is in flight in this tab. */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@features/card/chain/upgrade-lite-username.ts", () => ({
  upgradeLiteUsername: vi.fn(() => Promise.withResolvers<never>().promise),
  UsernameUpgradeError: class extends Error {},
}));

import {
  USERNAME_UPGRADE_MUTATION_KEY,
  useLiteUsernameUpgrade,
} from "@features/card/hooks/use-lite-username-upgrade.ts";

const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client }, children);

afterEach(() => {
  client.clear();
});

describe("useLiteUsernameUpgrade", () => {
  it("runs the claim under the shared mutation key", () => {
    const { result } = renderHook(() => useLiteUsernameUpgrade(), { wrapper });
    act(() => {
      result.current.submit({
        expectedLiteAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        currentLiteUsername: "marlow.42",
        fullUsername: "marlow",
      });
    });
    expect(client.isMutating({ mutationKey: USERNAME_UPGRADE_MUTATION_KEY })).toBe(1);
  });
});
