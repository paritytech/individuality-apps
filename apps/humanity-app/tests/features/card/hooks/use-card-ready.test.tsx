// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useCardReady } from "@features/card/hooks/use-card-ready.ts";
import { resetForegroundSessionForTests } from "@shared/session/foreground-session.ts";

const CARD_KEY = ["chain", "humanity-card", "alice.42", "5Game", "no-jollity-account"];
const IDENTITY_KEY = ["chain", "humanity-user-id"];

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** A read the test settles by hand, so what lands and when is explicit. */
function controlledRead<T>() {
  const pending: ((value: T) => void)[] = [];
  return {
    queryFn: () => new Promise<T>((resolve) => pending.push(resolve)),
    settle: async (value: T) => {
      await act(async () => {
        for (const resolve of pending.splice(0)) resolve(value);
      });
    },
  };
}

function withClient(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  resetForegroundSessionForTests();
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
});

describe("useCardReady", () => {
  it("waits for the card read of this session, and again after each return into view", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const card = controlledRead<string>();
    const { result } = renderHook(
      () => {
        useQuery({ queryKey: CARD_KEY, queryFn: card.queryFn, staleTime: Infinity });
        return useCardReady();
      },
      { wrapper: withClient(client) },
    );
    expect(result.current).toEqual({ sessionId: 1, ready: false });

    await card.settle("card");
    expect(result.current).toEqual({ sessionId: 1, ready: true });

    setVisibility("hidden");
    setVisibility("visible");
    expect(result.current).toEqual({ sessionId: 2, ready: false });

    void client.refetchQueries({ queryKey: CARD_KEY });
    await card.settle("card again");
    await waitFor(() => expect(result.current).toEqual({ sessionId: 2, ready: true }));
  });

  it("does not take a card hydrated from before the session for the current one", () => {
    const client = new QueryClient();
    const { result } = renderHook(
      () => {
        useQuery({
          queryKey: CARD_KEY,
          queryFn: () => Promise.resolve("live"),
          initialData: "persisted",
          initialDataUpdatedAt: Date.now() - 60_000,
          staleTime: Infinity,
        });
        return useCardReady();
      },
      { wrapper: withClient(client) },
    );
    expect(result.current.ready).toBe(false);
  });

  it("is ready once a read of this session failed, so the error can show", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => {
        useQuery({ queryKey: CARD_KEY, queryFn: () => Promise.reject(new Error("no bridge")) });
        return useCardReady();
      },
      { wrapper: withClient(client) },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it("settles on the host holding no identity, when there is no card to read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const identity = controlledRead<null>();
    const { result } = renderHook(
      () => {
        useQuery({ queryKey: IDENTITY_KEY, queryFn: identity.queryFn, staleTime: Infinity });
        // The card observer exists but never reads without an identity.
        useQuery({ queryKey: [...CARD_KEY.slice(0, 2), "none"], queryFn: () => Promise.resolve("never"), enabled: false });
        return useCardReady();
      },
      { wrapper: withClient(client) },
    );
    expect(result.current.ready).toBe(false);

    await identity.settle(null);
    expect(result.current.ready).toBe(true);
  });

  it("ignores a card query nothing on screen observes any more", async () => {
    const client = new QueryClient();
    client.setQueryData([...CARD_KEY.slice(0, 2), "alice.42", "pending-game-account"], "old");
    const card = controlledRead<string>();
    const { result } = renderHook(
      () => {
        useQuery({ queryKey: CARD_KEY, queryFn: card.queryFn, staleTime: Infinity });
        return useCardReady();
      },
      { wrapper: withClient(client) },
    );
    expect(result.current.ready).toBe(false);
    await card.settle("card");
    expect(result.current.ready).toBe(true);
  });
});
