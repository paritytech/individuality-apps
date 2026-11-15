// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
// This suite mounts a React hook, so it needs a DOM; the project default is
// `environment: "node"` (see vite.config.ts). Do not remove.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  DAILY_DOLLAR_REGISTRY_VERSION,
  type AirdropParticipation,
  type AirdropStanding,
  type DailyDollarRegistry,
  type DrawRegistration,
  type Hex32,
} from "@individuality/daily-dollar";
import type * as ReactQuery from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  registerForDraws: vi.fn(),
  invalidateQueries: vi.fn(),
  readDailyDollarRegistry: vi.fn(),
}));

vi.mock("@humanity/shared/airdrops/chain/register-draws.ts", () => ({
  registerForDraws: mocks.registerForDraws,
}));
vi.mock("@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts", () => ({
  readDailyDollarRegistry: mocks.readDailyDollarRegistry,
}));
vi.mock("@features/airdrops/hooks/use-airdrop-standing.ts", () => ({
  AIRDROP_STANDING_QUERY_KEY: ["chain", "airdrops", "standing"] as const,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  };
});
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

import {
  __resetAutoRegisterForTests,
  useAutoRegisterDraws,
} from "@features/airdrops/hooks/use-auto-register-draws.ts";

const TX_HASH = `0x${"ab".repeat(32)}`;
const ACCOUNT_ADDRESS = "5AirdropSubaccount";
const DRAW_PREFIX = "706f703a70656f706c652d61697264726f70733a20202020";
const eventIdAt = (index: number): Hex32 =>
  `0x${DRAW_PREFIX}${index.toString(16).padStart(16, "0")}` as Hex32;
const ZERO_EVENT_ID = eventIdAt(0);

/** Fixed epoch (2027-01-15T08:00:00Z) so the window arithmetic below cannot
 *  drift with the wall clock. `beforeEach` pins `Date.now()` to it. */
const NOW_SECONDS = 1_800_000_000;

function participation(eventId: Hex32): AirdropParticipation {
  return {
    draw: {
      eventId,
      drawIndex: BigInt("0x" + eventId.slice(-16)),
      status: "Registering",
      registrationStartsSeconds: NOW_SECONDS - 60,
      drawTimeSeconds: NOW_SECONDS + 60,
      endTimeSeconds: NOW_SECONDS + 3600,
      prizeAmount: 0n,
      assetId: null,
      maxWinners: 1,
      totalParticipants: 0,
      effectiveWinners: null,
      claimed: null,
    },
    // A derivable slot is a precondition of `pendingRegistrations`: without a
    // salt there is no slot, and a draw with no slot cannot be registered for.
    // `null` here would silently make every assertion below vacuous.
    slot: `0x${"cd".repeat(32)}` as Hex32,
    registered: false,
    winner: null,
    claimed: null,
  };
}

function standingWith(ids: Hex32[], contextMatches = true): AirdropStanding {
  return {
    accountAddress: ACCOUNT_ADDRESS,
    participations: ids.map(participation),
    alias: ZERO_EVENT_ID,
    airdropsContext: ZERO_EVENT_ID,
    aliasContext: contextMatches ? ZERO_EVENT_ID : eventIdAt(99),
    contextMatches,
    atBlockHash: ZERO_EVENT_ID,
  };
}

const EMPTY_REGISTRY: DailyDollarRegistry = {
  version: DAILY_DOLLAR_REGISTRY_VERSION,
  accountAddress: ACCOUNT_ADDRESS,
  draws: {},
  lastTick: null,
};

/** A registry holding one draw with the given registration state — the shape
 *  the worker leaves behind when it submitted while the app was closed. */
function registryHolding(
  eventId: Hex32,
  registration: Partial<DrawRegistration>,
): DailyDollarRegistry {
  return {
    ...EMPTY_REGISTRY,
    draws: {
      [eventId]: {
        eventId,
        drawIndex: "1",
        status: "Registering",
        drawTimeSeconds: NOW_SECONDS + 60,
        endTimeSeconds: NOW_SECONDS + 3600,
        prizeAmount: "0",
        registration: {
          state: "none",
          source: "worker",
          attempts: 0,
          lastAttemptSeconds: null,
          nextAttemptSeconds: null,
          txHash: null,
          error: null,
          ...registration,
        },
        outcome: "pending",
        notifications: [],
        notificationError: null,
        notificationRetrySeconds: null,
        scratchedAtSeconds: null,
        updatedAtSeconds: NOW_SECONDS,
      },
    },
  };
}

/** Drain the sweep. It now reads the daily-dollar registry before it submits,
 *  so a single microtask no longer carries it from effect to submission:
 *  registry read -> session-ledger recheck -> serialized `registerForDraws`. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW_SECONDS * 1000);
  // The attempted-id set and the in-flight promise chain live at module scope,
  // so without this reset a test would inherit whatever a previous one left —
  // and the "does not submit twice" assertion would pass vacuously.
  __resetAutoRegisterForTests();
  mocks.registerForDraws.mockResolvedValue([]);
  mocks.readDailyDollarRegistry.mockResolvedValue(EMPTY_REGISTRY);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoRegisterDraws gating", () => {
  it("does not submit when contextMatches is false and reports the mismatch", async () => {
    const { result } = renderHook(() =>
      useAutoRegisterDraws(standingWith([eventIdAt(1)], false), true),
    );
    await flush();
    expect(mocks.registerForDraws).not.toHaveBeenCalled();
    expect(result.current.lastError).toMatch(/not in the airdrops context/);
    expect(result.current.attempted).toBe(0);
  });

  it("starts registration when the dedicated account has not been bound yet", async () => {
    const unbound = standingWith([eventIdAt(1)], false);
    unbound.alias = null;
    unbound.aliasContext = null;
    unbound.participations = unbound.participations.map((entry) => ({
      ...entry,
      slot: null,
      registered: null,
    }));

    renderHook(() => useAutoRegisterDraws(unbound, true));
    await flush();

    expect(mocks.registerForDraws).toHaveBeenCalledWith({
      eventIds: [eventIdAt(1)],
    });
  });

  it("does not submit when enabled is false", async () => {
    renderHook(() => useAutoRegisterDraws(standingWith([eventIdAt(1)]), false));
    await flush();
    expect(mocks.registerForDraws).not.toHaveBeenCalled();
  });
});

describe("useAutoRegisterDraws session-scoped idempotency", () => {
  it("does not submit the same event id twice across two standing refetches", async () => {
    mocks.registerForDraws.mockImplementation(async () => {
      // `registerForDraws` records the outcome, which the next sweep reads.
      mocks.readDailyDollarRegistry.mockResolvedValue(registryHolding(eventIdAt(1), { state: "registered", attempts: 1 }));
      return [{ eventIds: [eventIdAt(1)], status: "finalized", txHash: TX_HASH }];
    });
    const { rerender } = renderHook(
      ({ standing }) => useAutoRegisterDraws(standing, true),
      { initialProps: { standing: standingWith([eventIdAt(1)]) } },
    );
    await flush();
    rerender({ standing: standingWith([eventIdAt(1)]) });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(1);
  });
});

describe("useAutoRegisterDraws retries", () => {
  it("tries a failed draw again in the same session once its backoff elapses", async () => {
    mocks.registerForDraws.mockImplementation(async () => {
      mocks.readDailyDollarRegistry.mockResolvedValue(
        registryHolding(eventIdAt(1), { state: "failed", attempts: 1, nextAttemptSeconds: NOW_SECONDS + 30 }),
      );
      return [{ eventIds: [eventIdAt(1)], status: "failed", error: new Error("subscription dropped") }];
    });
    const { rerender } = renderHook(({ standing }) => useAutoRegisterDraws(standing, true), {
      initialProps: { standing: standingWith([eventIdAt(1)]) },
    });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(1);

    vi.setSystemTime((NOW_SECONDS + 29) * 1000);
    rerender({ standing: standingWith([eventIdAt(1)]) });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(1);

    vi.setSystemTime((NOW_SECONDS + 30) * 1000);
    rerender({ standing: standingWith([eventIdAt(1)]) });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(2);
  });

  it("tries again 30 s after an attempt threw before any chunk ran, and not on the next refetch", async () => {
    // The host refused before anything was signed, so the registry records nothing.
    mocks.registerForDraws.mockRejectedValueOnce(new Error("createTransaction failed: subscription dropped"));
    const { rerender } = renderHook(({ standing }) => useAutoRegisterDraws(standing, true), {
      initialProps: { standing: standingWith([eventIdAt(1)]) },
    });
    await flush();
    rerender({ standing: standingWith([eventIdAt(1)]) });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(1);

    vi.setSystemTime((NOW_SECONDS + 30) * 1000);
    rerender({ standing: standingWith([eventIdAt(1)]) });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(2);
  });
});

describe("useAutoRegisterDraws registry interlock", () => {
  it("skips an event id the registry already holds as submitted", async () => {
    mocks.readDailyDollarRegistry.mockResolvedValue(
      registryHolding(eventIdAt(1), { state: "submitted", attempts: 1 }),
    );
    const { result } = renderHook(() =>
      useAutoRegisterDraws(standingWith([eventIdAt(1)]), true),
    );
    await flush();
    expect(mocks.readDailyDollarRegistry).toHaveBeenCalledWith(ACCOUNT_ADDRESS);
    expect(mocks.registerForDraws).not.toHaveBeenCalled();
    expect(result.current.attempted).toBe(0);
  });

  it("skips an event id whose recorded failure backoff has not elapsed", async () => {
    mocks.readDailyDollarRegistry.mockResolvedValue(
      registryHolding(eventIdAt(1), {
        state: "failed",
        attempts: 1,
        nextAttemptSeconds: NOW_SECONDS + 600,
        error: "signing failed",
      }),
    );
    renderHook(() => useAutoRegisterDraws(standingWith([eventIdAt(1)]), true));
    await flush();
    expect(mocks.registerForDraws).not.toHaveBeenCalled();
  });

  it("submits an event id whose recorded failure backoff has elapsed", async () => {
    mocks.readDailyDollarRegistry.mockResolvedValue(
      registryHolding(eventIdAt(1), {
        state: "failed",
        attempts: 1,
        nextAttemptSeconds: NOW_SECONDS - 1,
        error: "signing failed",
      }),
    );
    renderHook(() => useAutoRegisterDraws(standingWith([eventIdAt(1)]), true));
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledWith({
      eventIds: [eventIdAt(1)],
    });
  });

  it("submits every candidate when the registry read fails", async () => {
    // The registry is an optimization over the chain's own `registered` flag:
    // a host storage failure must not stop a person being entered in a draw.
    mocks.readDailyDollarRegistry.mockRejectedValue(new Error("kv gone"));
    renderHook(() => useAutoRegisterDraws(standingWith([eventIdAt(1)]), true));
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledWith({
      eventIds: [eventIdAt(1)],
    });
  });

  it("does not read the registry when the standing carries no account", async () => {
    const standing = standingWith([eventIdAt(1)]);
    delete standing.accountAddress;
    renderHook(() => useAutoRegisterDraws(standing, true));
    await flush();
    expect(mocks.readDailyDollarRegistry).not.toHaveBeenCalled();
    expect(mocks.registerForDraws).toHaveBeenCalledWith({
      eventIds: [eventIdAt(1)],
    });
  });
});

describe("useAutoRegisterDraws serialization", () => {
  it("does not overlap two registerForDraws calls when standing changes mid-flight", async () => {
    const { promise: firstInFlight, resolve: resolveFirst } =
      Promise.withResolvers<unknown>();
    mocks.registerForDraws.mockImplementationOnce(async () => {
      await firstInFlight;
      return [{ eventIds: [eventIdAt(1)], status: "finalized", txHash: TX_HASH }];
    });
    mocks.registerForDraws.mockImplementationOnce(async () => [
      { eventIds: [eventIdAt(2)], status: "finalized", txHash: TX_HASH },
    ]);
    const { rerender } = renderHook(
      ({ standing }) => useAutoRegisterDraws(standing, true),
      { initialProps: { standing: standingWith([eventIdAt(1)]) } },
    );
    await flush();
    rerender({ standing: standingWith([eventIdAt(2)]) });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst(undefined);
    });
    await flush();
    expect(mocks.registerForDraws).toHaveBeenCalledTimes(2);
    expect(mocks.registerForDraws).toHaveBeenLastCalledWith({
      eventIds: [eventIdAt(2)],
    });
  });

  it("invalidates the standing query and counts finalized chunks", async () => {
    mocks.registerForDraws.mockResolvedValue([
      { eventIds: [eventIdAt(1)], status: "finalized", txHash: TX_HASH },
    ]);
    const { result } = renderHook(() =>
      useAutoRegisterDraws(standingWith([eventIdAt(1)]), true),
    );
    await flush();
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["chain", "airdrops", "standing"],
    });
    expect(result.current.registered).toBe(1);
  });

  it("counts failed chunks and propagates the safe error message", async () => {
    mocks.registerForDraws.mockResolvedValue([
      {
        eventIds: [eventIdAt(1)],
        status: "failed",
        error: new Error("safe failure copy"),
      },
    ]);
    const { result } = renderHook(() =>
      useAutoRegisterDraws(standingWith([eventIdAt(1)]), true),
    );
    await flush();
    expect(result.current.failed).toBe(1);
    expect(result.current.lastError).toBe("safe failure copy");
  });
});
