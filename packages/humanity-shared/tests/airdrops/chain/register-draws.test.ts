// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  clearPendingRegistration,
  hasPendingRegistration,
  setPendingRegistration,
} from "@humanity/shared/airdrops/chain/pending-registration.ts";
import * as pendingRegistration from "@humanity/shared/airdrops/chain/pending-registration.ts";
import {
  forgetNotAttestedDevice,
  RegisterDrawsError,
  registerForDraws,
} from "@humanity/shared/airdrops/chain/register-draws.ts";
import { NotAttestedDeviceError } from "@humanity/shared/airdrops/chain/ensure-airdrop-alias.ts";
import { emptyRegistry } from "@humanity/shared/airdrops/domain/daily-dollar-registry.ts";
import type { DailyDollarRegistry, Hex32 } from "@individuality/daily-dollar";
import { TransactionSubmissionError } from "@humanity/shared/chain/transaction-submission.ts";

import {
  ADDRESS,
  ALIAS,
  eventIds,
  installRegisterHarness,
  MAX_BATCH,
  PERSON_SIGNER,
  registerHarnessApi,
  storage,
  TX_HASH,
  type RegisterHarnessMocks,
} from "./register-draws-harness.ts";

const mocks = vi.hoisted(
  (): RegisterHarnessMocks & {
    updateDailyDollarRegistry: Mock<
      (
        accountAddress: string,
        update: (current: DailyDollarRegistry) => DailyDollarRegistry,
      ) => Promise<DailyDollarRegistry>
    >;
  } => ({
    resolveAirdropAccount: vi.fn(),
    ensureAirdropAlias: vi.fn(),
    getPeopleClient: vi.fn(),
    watchTransactionSubmission: vi.fn(),
    updateDailyDollarRegistry: vi.fn(),
  }),
);
const logMocks = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@humanity/shared/airdrops/chain/airdrop-account.ts", () => ({
  resolveAirdropAccount: mocks.resolveAirdropAccount,
}));
vi.mock("@humanity/shared/airdrops/chain/ensure-airdrop-alias.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@humanity/shared/airdrops/chain/ensure-airdrop-alias.ts")
    >();
  return {
    ...actual,
    ensureAirdropAlias: mocks.ensureAirdropAlias,
  };
});
vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: mocks.getPeopleClient,
}));
vi.mock("@humanity/shared/airdrops/storage/daily-dollar-registry-store.ts", () => ({
  updateDailyDollarRegistry: mocks.updateDailyDollarRegistry,
}));
vi.mock("@humanity/shared/chain/transaction-submission.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@humanity/shared/chain/transaction-submission.ts")
    >();
  return {
    ...actual,
    watchTransactionSubmission: mocks.watchTransactionSubmission,
  };
});
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => logMocks,
}));

/** What the shared watcher reports when the finality deadline fires. */
const UNCONFIRMED_DETAIL = "no finalized block within 120000 ms";

/** The daily-dollar registry the store mock holds for the current test, so
 *  the assertions run through the real reducers rather than through a
 *  restatement of them. */
let registry: DailyDollarRegistry = emptyRegistry(ADDRESS);

beforeEach(() => {
  installRegisterHarness(mocks);
  forgetNotAttestedDevice();
  registry = emptyRegistry(ADDRESS);
  mocks.updateDailyDollarRegistry.mockImplementation(async (_address, update) => {
    registry = update(registry);
    return registry;
  });
});

afterEach(() => {
  for (const id of eventIds(64)) {
    clearPendingRegistration([id], ALIAS, TX_HASH);
  }
  vi.unstubAllGlobals();
});

describe("registerForDraws chunking at the runtime bound", () => {
  it("chunks 17 event ids into one full chunk plus a one-id tail", async () => {
    const ids = eventIds(17);
    const result = await registerForDraws({ eventIds: ids });
    expect(result).toHaveLength(2);
    expect(result[0]?.eventIds).toHaveLength(MAX_BATCH);
    expect(result[1]?.eventIds).toEqual([ids[MAX_BATCH]]);
  });

  it("chunks 32 event ids into two full chunks and stops there", async () => {
    const ids = eventIds(32);
    const result = await registerForDraws({ eventIds: ids });
    expect(result).toHaveLength(2);
    expect(result[0]?.eventIds).toHaveLength(MAX_BATCH);
    expect(result[1]?.eventIds).toHaveLength(MAX_BATCH);
  });

  it("passes a single id through as one chunk without padding", async () => {
    const ids = eventIds(1);
    const result = await registerForDraws({ eventIds: ids });
    expect(result).toHaveLength(1);
    expect(result[0]?.eventIds).toEqual(ids);
  });

  it("emits an empty result for an empty input", async () => {
    await expect(registerForDraws({ eventIds: [] })).resolves.toEqual([]);
  });

  it("passes event_ids through unmodified and submits every chunk", async () => {
    const ids = eventIds(17);
    const result = await registerForDraws({ eventIds: ids });
    expect(result.flatMap((chunk) => chunk.eventIds)).toEqual(ids);
    expect(mocks.watchTransactionSubmission).toHaveBeenCalledTimes(2);
  });

  it("falls back to the documented batch bound when MaxRegisterBatch is missing", async () => {
    // The constant read is the only source of the bound; when it throws,
    // `register-draws.ts` must still chunk at the runtime's documented 16 —
    // asserting the resulting 16 + 1 shape is what proves the fallback value,
    // where merely asserting "did not throw" would pass for any bound.
    registerHarnessApi().constants.PeopleAirdrops.MaxRegisterBatch.mockRejectedValue(
      new Error("not available"),
    );
    const ids = eventIds(17);
    const result = await registerForDraws({ eventIds: ids });
    expect(result).toHaveLength(2);
    expect(result[0]?.eventIds).toHaveLength(16);
    expect(result[1]?.eventIds).toEqual([ids[16]]);
  });
});

describe("registerForDraws pending markers", () => {
  it("sets one marker per event id at broadcast and clears it on finalized", async () => {
    const ids = eventIds(2);
    const setSpy = vi.spyOn(pendingRegistration, "setPendingRegistration");
    await registerForDraws({ eventIds: ids });
    // Broadcast happened for both event ids.
    expect(setSpy).toHaveBeenCalledWith(
      expect.arrayContaining(ids),
      ALIAS,
      TX_HASH,
    );
    // Finalize cleared both markers.
    for (const id of ids) {
      expect(hasPendingRegistration(id, ALIAS)).toBe(false);
    }
    expect(storage.keys()).toHaveLength(0);
  });

  it("keeps the marker when finality is unknown", async () => {
    mocks.watchTransactionSubmission.mockImplementation(
      async (
        _tx,
        _signer,
        _options,
        watchOptions?: { onBroadcast?: (txHash: string) => void },
      ) => {
        watchOptions?.onBroadcast?.(TX_HASH);
        return {
          status: "unknown",
          txHash: TX_HASH,
          detail: UNCONFIRMED_DETAIL,
        };
      },
    );
    const ids = eventIds(2);
    const result = await registerForDraws({ eventIds: ids });
    expect(result.every((chunk) => chunk.status === "unknown")).toBe(true);
    for (const id of ids) {
      expect(hasPendingRegistration(id, ALIAS)).toBe(true);
    }
    expect(logMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("{detail}"),
      expect.objectContaining({ detail: UNCONFIRMED_DETAIL }),
    );
  });
});

describe("registerForDraws chunk isolation", () => {
  it("runs later chunks after a failing middle chunk and reports the failure", async () => {
    const ids = eventIds(MAX_BATCH * 2 + 5);
    let callIndex = 0;
    mocks.watchTransactionSubmission.mockImplementation(
      async (
        _tx,
        _signer,
        _options,
        watchOptions?: { onBroadcast?: (txHash: string) => void },
      ) => {
        callIndex += 1;
        watchOptions?.onBroadcast?.(TX_HASH);
        if (callIndex === 2) {
          throw new TransactionSubmissionError(
            "signing",
            "raw signing failure",
            "host refused at host_create_transaction",
          );
        }
        return { status: "finalized", txHash: TX_HASH };
      },
    );
    const result = await registerForDraws({ eventIds: ids });
    expect(result).toHaveLength(3);
    expect(result[0]?.status).toBe("finalized");
    expect(result[1]?.status).toBe("failed");
    expect(result[1]?.error).toBeInstanceOf(RegisterDrawsError);
    expect((result[1]?.error as RegisterDrawsError).code).toBe("signing");
    expect(result[2]?.status).toBe("finalized");
  });

  it("throws RegisterDrawsError before any chunk when the airdrop account is missing", async () => {
    mocks.resolveAirdropAccount.mockResolvedValue(null);
    const error = await registerForDraws({ eventIds: eventIds(1) }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(RegisterDrawsError);
    expect((error as RegisterDrawsError).code).toBe("account-missing");
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });
});

describe("registerForDraws on a device that never attested the person", () => {
  const NOT_ATTESTED = new NotAttestedDeviceError(
    "this host holds no full-personhood ring-VRF key under peopl.paseo",
  );

  async function attempt(): Promise<unknown> {
    return registerForDraws({ eventIds: eventIds(1) }).catch((err: unknown) => err);
  }

  it("reports not-attested-device as a warning, never an error", async () => {
    mocks.ensureAirdropAlias.mockRejectedValue(NOT_ATTESTED);
    const error = await attempt();
    expect(error).toBeInstanceOf(RegisterDrawsError);
    expect((error as RegisterDrawsError).code).toBe("not-attested-device");
    expect((error as RegisterDrawsError).cause).toBe(NOT_ATTESTED);
    expect(logMocks.error).not.toHaveBeenCalled();
    expect(logMocks.warning).toHaveBeenCalledTimes(1);
    expect(mocks.watchTransactionSubmission).not.toHaveBeenCalled();
  });

  it("answers the next attempt within the hour from memory, without the host or the chain", async () => {
    mocks.ensureAirdropAlias.mockRejectedValue(NOT_ATTESTED);
    await attempt();
    mocks.resolveAirdropAccount.mockClear();
    mocks.getPeopleClient.mockClear();
    mocks.ensureAirdropAlias.mockClear();
    logMocks.warning.mockClear();

    const error = await attempt();
    expect((error as RegisterDrawsError).code).toBe("not-attested-device");
    expect(mocks.resolveAirdropAccount).not.toHaveBeenCalled();
    expect(mocks.getPeopleClient).not.toHaveBeenCalled();
    expect(mocks.ensureAirdropAlias).not.toHaveBeenCalled();
    expect(logMocks.warning).not.toHaveBeenCalled();
    expect(logMocks.error).not.toHaveBeenCalled();
  });

  it("asks the host again once the memo expires", async () => {
    vi.useFakeTimers();
    try {
      mocks.ensureAirdropAlias.mockRejectedValue(NOT_ATTESTED);
      await attempt();
      vi.advanceTimersByTime(60 * 60 * 1_000);
      mocks.ensureAirdropAlias.mockClear();
      await attempt();
      expect(mocks.ensureAirdropAlias).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the host again after forgetNotAttestedDevice", async () => {
    mocks.ensureAirdropAlias.mockRejectedValue(NOT_ATTESTED);
    await attempt();
    forgetNotAttestedDevice();
    mocks.ensureAirdropAlias.mockClear();
    await attempt();
    expect(mocks.ensureAirdropAlias).toHaveBeenCalledTimes(1);
  });

  it("leaves any other alias failure to the caller's error, keeping the cause", async () => {
    const cause = new Error("Host could not create the airdrop proof (Domain.V1.NotMember).");
    mocks.ensureAirdropAlias.mockRejectedValue(cause);
    const error = await attempt();
    expect((error as RegisterDrawsError).code).toBe("signing");
    expect((error as RegisterDrawsError).cause).toBe(cause);
    // The auto-register hook reports the thrown error at error; a second
    // error here filed every failed bind to Sentry twice.
    expect(logMocks.error).not.toHaveBeenCalled();
    expect(logMocks.warning).toHaveBeenCalledTimes(1);
  });
});

describe("registerForDraws auth composition", () => {
  it("binds the alias once and uses its revision-aware signer for every chunk", async () => {
    await registerForDraws({ eventIds: eventIds(17) });
    expect(mocks.ensureAirdropAlias).toHaveBeenCalledTimes(1);
    expect(mocks.watchTransactionSubmission).toHaveBeenCalledTimes(2);
    for (const call of mocks.watchTransactionSubmission.mock.calls) {
      expect(call[1]).toBe(PERSON_SIGNER);
      expect(call[2]).toEqual({});
    }
  });

  it("ignores a malformed event id without writing a marker", () => {
    setPendingRegistration(["not-a-hex"], ADDRESS, TX_HASH);
    expect(storage.keys()).toHaveLength(0);
  });
});

describe("registerForDraws daily-dollar registry recording", () => {
  it("holds the chunk as submitted while it signs and as registered once it lands", async () => {
    const statesAtSigning: string[] = [];
    mocks.watchTransactionSubmission.mockImplementation(
      async (
        tx: unknown,
        _signer: unknown,
        _options: unknown,
        watchOptions?: { onBroadcast?: (txHash: string) => void },
      ) => {
        // The harness's fake `api.tx.PeopleAirdrops.register` returns exactly
        // this shape; there is no runtime boundary here to validate against.
        const submitted = tx as { event_ids: Hex32[] };
        statesAtSigning.push(
          submitted.event_ids
            .map((id) => registry.draws[id]?.registration.state ?? "absent")
            .join(","),
        );
        watchOptions?.onBroadcast?.(TX_HASH);
        return { status: "finalized", txHash: TX_HASH };
      },
    );

    const ids = eventIds(17);
    await registerForDraws({ eventIds: ids });

    // Two chunks, and each one was already `submitted` in the registry at the
    // moment it was signed: recording after the fact would lose every
    // submission the app did not live to see finalize.
    expect(statesAtSigning).toEqual([
      new Array(MAX_BATCH).fill("submitted").join(","),
      "submitted",
    ]);
    for (const id of ids) {
      expect(registry.draws[id]?.registration.state).toBe("registered");
      expect(registry.draws[id]?.registration.txHash).toBe(TX_HASH);
    }
    expect(
      mocks.updateDailyDollarRegistry.mock.calls.map(([address]) => address),
    ).toEqual([ADDRESS, ADDRESS, ADDRESS, ADDRESS]);
  });

  it("stamps the caller's source on the records it writes", async () => {
    await registerForDraws({ eventIds: eventIds(1), source: "worker" });
    const [record] = Object.values(registry.draws);
    expect(record?.registration.source).toBe("worker");
  });

  it("defaults the source to the app when the caller does not say", async () => {
    await registerForDraws({ eventIds: eventIds(1) });
    const [record] = Object.values(registry.draws);
    expect(record?.registration.source).toBe("app");
  });

  it("records a failing chunk as failed with its message and leaves the others registered", async () => {
    let callIndex = 0;
    mocks.watchTransactionSubmission.mockImplementation(
      async (
        _tx: unknown,
        _signer: unknown,
        _options: unknown,
        watchOptions?: { onBroadcast?: (txHash: string) => void },
      ) => {
        callIndex += 1;
        watchOptions?.onBroadcast?.(TX_HASH);
        if (callIndex === 1) {
          throw new TransactionSubmissionError("signing", "raw signing failure", "signer declined");
        }
        return { status: "finalized", txHash: TX_HASH };
      },
    );

    const ids = eventIds(MAX_BATCH + 1);
    await registerForDraws({ eventIds: ids });

    const states = Object.values(registry.draws).map(
      (record) => record.registration.state,
    );
    expect(states.filter((state) => state === "failed")).toHaveLength(MAX_BATCH);
    expect(states.filter((state) => state === "registered")).toHaveLength(1);
    const failed = Object.values(registry.draws).find(
      (record) => record.registration.state === "failed",
    );
    // The safe copy, not the raw chain failure — the registry is read back by
    // the debug panel and the worker, neither of which should leak internals.
    expect(failed?.registration.error).toBe(
      "We couldn't submit your airdrop registration. Try again shortly.",
    );
    expect(logMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("registration failed"),
      expect.objectContaining({ detail: "signer declined", txHash: TX_HASH }),
    );
  });

  it("records an unknown finality as unknown rather than registered", async () => {
    mocks.watchTransactionSubmission.mockImplementation(
      async (
        _tx: unknown,
        _signer: unknown,
        _options: unknown,
        watchOptions?: { onBroadcast?: (txHash: string) => void },
      ) => {
        watchOptions?.onBroadcast?.(TX_HASH);
        return { status: "unknown", txHash: TX_HASH };
      },
    );
    await registerForDraws({ eventIds: eventIds(1) });
    const [record] = Object.values(registry.draws);
    expect(record?.registration.state).toBe("unknown");
  });

  it("registers regardless of a registry write failure", async () => {
    mocks.updateDailyDollarRegistry.mockRejectedValue(new Error("kv gone"));
    const result = await registerForDraws({ eventIds: eventIds(1) });
    expect(result[0]?.status).toBe("finalized");
  });
});
