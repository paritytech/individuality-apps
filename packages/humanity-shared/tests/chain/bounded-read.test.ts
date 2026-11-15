// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";

describe("runBoundedChainRead", () => {
  it("returns the operation result when it settles in time", async () => {
    const parent = new AbortController();
    await expect(
      runBoundedChainRead(parent.signal, (signal) => {
        expect(signal.aborted).toBe(false);
        return Promise.resolve("stored-value");
      }),
    ).resolves.toBe("stored-value");
  });

  it("propagates an upstream rejection unchanged", async () => {
    const parent = new AbortController();
    const upstreamError = new Error("upstream read failed");
    await expect(
      runBoundedChainRead(parent.signal, () => Promise.reject(upstreamError)),
    ).rejects.toBe(upstreamError);
  });

  it("aborts only its child signal when a read misses its deadline", async () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      let childSignal: AbortSignal | undefined;
      const result = runBoundedChainRead(
        parent.signal,
        (signal) => {
          childSignal = signal;
          return Promise.withResolvers<string>().promise;
        },
        1_000,
      );

      const timedOut = expect(result).rejects.toThrow(
        "People Chain did not respond in time.",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await timedOut;

      expect(childSignal).not.toBe(parent.signal);
      expect(childSignal?.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts only its child signal when the parent aborts", async () => {
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    const abortError = new Error("PAPI unsubscribed the read");
    const result = runBoundedChainRead(parent.signal, (signal) => {
      childSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError), { once: true });
      });
    });

    parent.abort();

    await expect(result).rejects.toBe(abortError);
    expect(childSignal).not.toBe(parent.signal);
    expect(childSignal?.aborted).toBe(true);
  });

  it("rejects with AbortError without running an already-aborted operation", async () => {
    const parent = new AbortController();
    parent.abort();
    const operation = vi.fn(() => Promise.resolve("unreachable"));

    await expect(runBoundedChainRead(parent.signal, operation)).rejects.toMatchObject({
      name: "AbortError",
      message: "Chain read aborted",
    });
    expect(operation).not.toHaveBeenCalled();
  });
});
