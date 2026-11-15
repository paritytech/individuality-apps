// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
// This suite mounts a React hook, so it needs a DOM; the project default is
// `environment: "node"` (see vite.config.ts). Do not remove.

/**
 * Boot-time prize recovery is a background pass with no UI: the only things it
 * owes anyone are that it fires exactly once per app run — the host answers a
 * second concurrent top-up per source with `SourceBusy`, so a re-firing hook
 * would turn every rerender into a refusal — that it lets go on unmount, and
 * that a prize it failed to recover leaves a trace someone can find.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import type { StrandedPrizeSweep } from "@features/prize/chain/prize-coinage.ts";

const mocks = vi.hoisted(() => ({
  sweepStrandedPrizes:
    vi.fn<(signal: AbortSignal) => Promise<StrandedPrizeSweep>>(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@features/prize/chain/prize-coinage.ts", () => ({
  sweepStrandedPrizes: mocks.sweepStrandedPrizes,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({ loggerFor: () => mocks.logger }));
// `runBoundedChainRead` stays real: it owns the child signal the sweep is
// handed, so stubbing it would hand the hook a signal that never aborts and
// make the unmount test vacuous.

import { useSweepStrandedPrizes } from "@features/prize/hooks/use-sweep-stranded-prizes.ts";

const NOTHING: StrandedPrizeSweep = {
  status: "skipped",
  reason: "nothing-stranded",
};

/**
 * Drain the sweep promise's `.then`/`.catch` chain. Every hop in it — the
 * `Promise.race` inside `runBoundedChainRead`, its `finally`, the hook's own
 * handlers — is a microtask, so yielding the queue a fixed number of times is
 * exact, unlike a guessed delay.
 */
async function drain(): Promise<void> {
  for (let hop = 0; hop < 16; hop += 1) await Promise.resolve();
}

/**
 * Flatten one logger call to searchable text. LogTape takes the amount as an
 * interpolated property (or a lazily built bag), never inside the template, so
 * asserting on the message string alone would miss it.
 */
function callText(args: unknown[]): string {
  return args
    .map((arg) => {
      const value = typeof arg === "function" ? (arg as () => unknown)() : arg;
      if (typeof value === "string") return value;
      return (
        JSON.stringify(value, (_, inner: unknown) =>
          typeof inner === "bigint" ? `${inner}` : inner,
        ) ?? String(value)
      );
    })
    .join(" ");
}

const firstSignal = (): AbortSignal | undefined =>
  mocks.sweepStrandedPrizes.mock.calls[0]?.[0];

beforeEach(() => {
  mocks.sweepStrandedPrizes.mockResolvedValue(NOTHING);
});

afterEach(() => {
  mocks.sweepStrandedPrizes.mockReset();
  mocks.logger.debug.mockReset();
  mocks.logger.info.mockReset();
  mocks.logger.warning.mockReset();
  mocks.logger.error.mockReset();
});

describe("useSweepStrandedPrizes", () => {
  it("sweeps once per mount, not once per render", async () => {
    const mounted = renderHook(() => useSweepStrandedPrizes());

    expect(mocks.sweepStrandedPrizes).toHaveBeenCalledTimes(1);
    expect(firstSignal()).toBeInstanceOf(AbortSignal);

    mounted.rerender();
    mounted.rerender();
    await drain();

    expect(mocks.sweepStrandedPrizes).toHaveBeenCalledTimes(1);
  });

  it("aborts the in-flight sweep on unmount and stays quiet about it", async () => {
    const pending = Promise.withResolvers<StrandedPrizeSweep>();
    mocks.sweepStrandedPrizes.mockReturnValue(pending.promise);

    const mounted = renderHook(() => useSweepStrandedPrizes());
    const signal = firstSignal();
    expect(signal?.aborted).toBe(false);

    mounted.unmount();
    expect(signal?.aborted).toBe(true);

    // The chain read rejects after the component is gone; an unmount is not a
    // failure and must not be reported as one.
    pending.reject(new Error("chain read aborted"));
    await drain();

    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("records the amount the host would not take", async () => {
    const prize = { assetId: { parents: 1 }, amount: 5_000_000n };
    mocks.sweepStrandedPrizes.mockResolvedValue({
      status: "swept",
      sent: [],
      failed: [{ prize, error: new Error("SourceBusy") }],
    });

    renderHook(() => useSweepStrandedPrizes());

    await waitFor(() => {
      expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    });
    // The amount is the whole point of the line: it is what is still stuck on
    // product account zero after this run gave up on it.
    expect(callText(mocks.logger.error.mock.calls[0] ?? [])).toContain("5000000");
  });

  it("reports a sweep that never got off the ground", async () => {
    mocks.sweepStrandedPrizes.mockRejectedValue(
      new Error("People Chain did not respond in time."),
    );

    renderHook(() => useSweepStrandedPrizes());

    await waitFor(() => {
      expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    });
    expect(callText(mocks.logger.error.mock.calls[0] ?? [])).toContain(
      "People Chain did not respond in time.",
    );
  });

  it("logs a skip at debug level, not as a failure", async () => {
    renderHook(() => useSweepStrandedPrizes());

    await waitFor(() => {
      expect(mocks.logger.debug).toHaveBeenCalledTimes(1);
    });
    expect(callText(mocks.logger.debug.mock.calls[0] ?? [])).toContain(
      "nothing-stranded",
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });
});
