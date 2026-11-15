// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

describe("withTimeout", () => {
  it("passes through a value that settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, "too slow")).resolves.toBe(
      7,
    );
  });

  it("passes through a rejection unchanged", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("upstream")), 1_000, "too slow"),
    ).rejects.toThrow("upstream");
  });

  it("rejects with the given message when the promise never settles", async () => {
    const { promise: pending } = Promise.withResolvers<never>();
    await expect(
      withTimeout(pending, 20, "no response from chain"),
    ).rejects.toThrow("no response from chain");
  });

  it("runs onTimeout exactly once on deadline and never lets its throw mask the timeout", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn(() => {
        throw new Error("cleanup exploded");
      });
      const { promise: pending } = Promise.withResolvers<never>();
      const result = withTimeout(pending, 20, "too slow", onTimeout);
      const rejected = expect(result).rejects.toThrow("too slow");
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run onTimeout when the promise settles in time", async () => {
    const onTimeout = vi.fn();
    await withTimeout(Promise.resolve(7), 1_000, "too slow", onTimeout);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not run onTimeout when the promise rejects first", async () => {
    const onTimeout = vi.fn();
    await expect(
      withTimeout(Promise.reject(new Error("upstream")), 1_000, "too slow", onTimeout),
    ).rejects.toThrow("upstream");
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
