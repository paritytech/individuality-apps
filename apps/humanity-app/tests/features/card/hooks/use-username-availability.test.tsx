// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Availability as the person types: nothing is read until typing pauses,
 *  the answer shown is always for the name in the field, a failed read is
 *  never "available" and can be tried again, and a name is taken when owned
 *  or reserved by anyone but this lite identity at the front of the queue.
 *  When only expired entries stand ahead of this lite identity's own, they
 *  are removed in the background, once, and the name is read again. */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  owner: vi.fn(),
  queue: vi.fn(),
  duration: vi.fn(),
  now: vi.fn(),
}));
const cleanup_ = vi.hoisted(() => ({ clear: vi.fn() }));

vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: () =>
    Promise.resolve({
      api: {
        query: {
          Resources: {
            UsernameOwnerOf: { getValue: reads.owner },
            UsernameReservationQueue: { getValue: reads.queue },
            UsernameReservationDuration: { getValue: reads.duration },
          },
          Timestamp: { Now: { getValue: reads.now } },
        },
      },
    }),
}));

vi.mock("@features/card/chain/clear-expired-reservations.ts", () => ({
  clearExpiredReservations: cleanup_.clear,
}));

import {
  resetReservationCleanupsForTests,
  useUsernameAvailability,
} from "@features/card/hooks/use-username-availability.ts";

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client }, children);

beforeEach(() => {
  client = new QueryClient();
  reads.owner.mockReset().mockResolvedValue(undefined);
  reads.queue.mockReset().mockResolvedValue([]);
  // 30 days, read at 10 000 000 s: an entry joined at 1 s lapsed long ago, one
  // joined at 9 999 000 s is still fresh.
  reads.duration.mockReset().mockResolvedValue(2_592_000n);
  reads.now.mockReset().mockResolvedValue(10_000_000_000n);
  cleanup_.clear.mockReset().mockResolvedValue({ status: "cleared", removed: 1 });
  resetReservationCleanupsForTests();
});

// Unmount every view: vitest globals are off, so testing-library does not
// clean up on its own. A view left mounted keeps its debounce timer, and one
// that fires in a later test reads through the shared mocks and can swallow
// that test's `mockRejectedValueOnce`.
afterEach(() => {
  cleanup();
  client.clear();
});

const LITE = "5LiteSelf";
const OTHER = "5Someone";

const mount = (name: string) =>
  renderHook((props: { name: string }) => useUsernameAvailability(props.name, true, LITE), {
    wrapper,
    initialProps: { name },
  });

describe("useUsernameAvailability", () => {
  it("waits for typing to pause, then answers for that name", async () => {
    const view = mount("marlow");
    expect(view.result.current).toEqual({ status: "checking", name: "marlow" });
    expect(reads.owner).not.toHaveBeenCalled();
    await waitFor(() => expect(view.result.current).toEqual({ status: "available", name: "marlow" }));
    expect(reads.owner).toHaveBeenCalledTimes(1);
  });

  it("never shows an answer for a name the field no longer holds", async () => {
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current.status).toBe("available"));
    view.rerender({ name: "marlowe" });
    expect(view.result.current).toEqual({ status: "checking", name: "marlowe" });
  });

  it("reads a name reserved by someone else as taken", async () => {
    reads.queue.mockResolvedValue([{ account: OTHER, joined_at: 1n }]);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
  });

  it("reads a name this lite identity holds the front reservation on as available", async () => {
    reads.queue.mockResolvedValue([
      { account: LITE, joined_at: 1n },
      { account: OTHER, joined_at: 2n },
    ]);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "available", name: "marlow" }));
  });

  it("reads a name as taken when this lite identity is queued behind someone else", async () => {
    reads.queue.mockResolvedValue([
      { account: OTHER, joined_at: 9_999_000n },
      { account: LITE, joined_at: 9_999_500n },
    ]);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
  });

  it("reads an owned name as taken even when this lite identity reserved it", async () => {
    reads.owner.mockResolvedValue(OTHER);
    reads.queue.mockResolvedValue([{ account: LITE, joined_at: 1n }]);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
  });

  it("reads a name with no reservation queue as available", async () => {
    reads.queue.mockResolvedValue(undefined);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "available", name: "marlow" }));
  });

  it("keeps answers for different lite identities apart", async () => {
    reads.queue.mockResolvedValue([{ account: LITE, joined_at: 1n }]);
    const view = renderHook(
      (props: { lite: string }) => useUsernameAvailability("marlow", true, props.lite),
      { wrapper, initialProps: { lite: LITE } },
    );
    await waitFor(() => expect(view.result.current.status).toBe("available"));
    view.rerender({ lite: OTHER });
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
  });

  it("never reads a failed check as available, and can try again", async () => {
    reads.owner.mockRejectedValueOnce(new Error("socket closed"));
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current.status).toBe("error"));
    const failed = view.result.current;
    if (failed.status !== "error") throw new Error("expected an error");
    act(() => failed.retry());
    await waitFor(() => expect(view.result.current).toEqual({ status: "available", name: "marlow" }));
  });

  it("removes expired entries ahead of this lite identity, then reads the name again", async () => {
    reads.queue.mockResolvedValueOnce([
      { account: OTHER, joined_at: 1n },
      { account: "5Another", joined_at: 2n },
      { account: LITE, joined_at: 9_999_000n },
    ]);
    reads.duration.mockResolvedValue(0n);
    let finish!: () => void;
    cleanup_.clear.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve({ status: "cleared", removed: 2 }))),
    );
    reads.queue.mockResolvedValue([{ account: LITE, joined_at: 9_999_000n }]);
    const view = mount("marlow");

    await waitFor(() => expect(cleanup_.clear).toHaveBeenCalledWith("marlow", LITE));
    expect(view.result.current).toEqual({ status: "checking", name: "marlow" });

    act(() => finish());
    await waitFor(() => expect(view.result.current).toEqual({ status: "available", name: "marlow" }));
    expect(cleanup_.clear).toHaveBeenCalledTimes(1);
  });

  it("starts the cleanup once even when the queue is still stuck after it", async () => {
    reads.queue.mockResolvedValue([
      { account: OTHER, joined_at: 1n },
      { account: LITE, joined_at: 9_999_000n },
    ]);
    reads.duration.mockResolvedValue(0n);
    cleanup_.clear.mockResolvedValue({ status: "failed", removed: 0, detail: "refused" });
    const view = mount("marlow");

    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
    expect(cleanup_.clear).toHaveBeenCalledTimes(1);
  });

  it("leaves a reservation younger than 30 days alone even when People sets no duration", async () => {
    reads.queue.mockResolvedValue([
      { account: OTHER, joined_at: 9_999_000n },
      { account: LITE, joined_at: 9_999_500n },
    ]);
    reads.duration.mockResolvedValue(0n);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
    expect(reads.duration).toHaveBeenCalled();
    expect(cleanup_.clear).not.toHaveBeenCalled();
  });

  it("leaves a fresh reservation ahead alone", async () => {
    reads.queue.mockResolvedValue([
      { account: OTHER, joined_at: 9_999_000n },
      { account: LITE, joined_at: 9_999_500n },
    ]);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
    expect(cleanup_.clear).not.toHaveBeenCalled();
  });

  it("does nothing when a fresh entry still stands ahead after the expired ones", async () => {
    reads.queue.mockResolvedValue([
      { account: OTHER, joined_at: 1n },
      { account: "5Another", joined_at: 9_999_000n },
      { account: LITE, joined_at: 9_999_500n },
    ]);
    // People sets 5 000 s; Humanity still holds 5Another (joined 1 000 s ago)
    // to the 30-day floor, so only OTHER has lapsed.
    reads.duration.mockResolvedValue(5_000n);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
    expect(reads.duration).toHaveBeenCalled();
    expect(cleanup_.clear).not.toHaveBeenCalled();
  });

  it("never clears a queue this lite identity is not in", async () => {
    reads.queue.mockResolvedValue([{ account: OTHER, joined_at: 1n }]);
    reads.duration.mockResolvedValue(0n);
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current).toEqual({ status: "taken", name: "marlow" }));
    expect(cleanup_.clear).not.toHaveBeenCalled();
    expect(reads.duration).not.toHaveBeenCalled();
  });

  it("passes an abort signal into every read", async () => {
    const view = mount("marlow");
    await waitFor(() => expect(view.result.current.status).toBe("available"));
    expect(reads.owner.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(reads.queue.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
});
