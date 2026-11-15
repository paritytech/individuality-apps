// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { vi, type Mock } from "vitest";

import { buildDrawEventId } from "@humanity/shared/airdrops/chain/draw-event-id.ts";
import type { Hex32 } from "@individuality/daily-dollar";

/**
 * Shape of the locally-defined `mocks` namespace the test file wires against
 * its `vi.mock` factories. Defined here so the harness and the test agree on
 * the exact set of fakes without exporting the namespace itself (which would
 * cross a `vi.mock` hoist boundary and trip the
 * "Cannot access '__vi_import_N__' before initialization" error).
 */
export interface RegisterHarnessMocks {
  resolveAirdropAccount: Mock<() => Promise<unknown>>;
  ensureAirdropAlias: Mock<() => Promise<unknown>>;
  getPeopleClient: Mock<() => Promise<unknown>>;
  watchTransactionSubmission: Mock<
    (
      tx: unknown,
      signer: unknown,
      options: unknown,
      watchOptions?: { onBroadcast?: (txHash: string) => void },
    ) => Promise<unknown>
  >;
}

export const ADDRESS = "5Alice";
export const ALIAS = `0x${"cd".repeat(32)}`;
export const TX_HASH = `0x${"ab".repeat(32)}`;
export const MAX_BATCH = 16;
export const PERSON_SIGNER = { kind: "alias-with-account-signer" };

export class FakeHostLocalStorage {
  private readonly entries: Record<string, string> = {};
  get length(): number {
    return Object.keys(this.entries).length;
  }
  key(index: number): string | null {
    return Object.keys(this.entries)[index] ?? null;
  }
  keys(): string[] {
    return Object.keys(this.entries);
  }
  getItem(key: string): string | null {
    return this.entries[key] ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries[key] = value;
  }
  removeItem(key: string): void {
    delete this.entries[key];
  }
}

/** Real `PeopleAirdrops` draw ids: the SDK refuses any other id before signing. */
export function eventIds(count: number): Hex32[] {
  return Array.from(
    { length: count },
    (_, index) => buildDrawEventId(BigInt(index + 1)),
  );
}

export interface FakeApi {
  tx: { PeopleAirdrops: { register: ReturnType<typeof vi.fn> } };
  constants: {
    PeopleAirdrops: { MaxRegisterBatch: ReturnType<typeof vi.fn> };
  };
}

function makeApi(): FakeApi {
  return {
    tx: {
      PeopleAirdrops: {
        register: vi.fn((args: { event_ids: Hex32[] }) => ({
          kind: "register-tx",
          event_ids: args.event_ids,
        })),
      },
    },
    constants: {
      PeopleAirdrops: {
        MaxRegisterBatch: vi.fn(async () => MAX_BATCH),
      },
    },
  };
}

function makeSigner() {
  return {
    publicKey: new Uint8Array(32).fill(0x22),
    signBytes: vi.fn(),
    signTx: vi.fn(),
  };
}

export const storage: FakeHostLocalStorage = new FakeHostLocalStorage();

/**
 * The fake api the harness handed to `getPeopleClient` for the current test.
 *
 * A test that needs to reconfigure a chain constant (e.g. make
 * `MaxRegisterBatch` reject) reaches it through here rather than through
 * `getPeopleClient.mock.results[0]`: that array is empty until the call under
 * test actually happens, and `vi.clearAllMocks()` wipes it between tests, so
 * reading it is both order-dependent and usually `undefined`.
 */
let currentApi: FakeApi | null = null;

export function registerHarnessApi(): FakeApi {
  if (currentApi == null) {
    throw new Error("registerHarnessApi: call installRegisterHarness first");
  }
  return currentApi;
}

/** Wipe every persisted entry between tests so the storage is fresh. */
function resetRegisterStorage(): void {
  for (const key of storage.keys()) {
    storage.removeItem(key);
  }
}

export function installRegisterHarness(mocks: RegisterHarnessMocks): void {
  vi.clearAllMocks();
  resetRegisterStorage();
  vi.stubGlobal("localStorage", storage);
  const signer = makeSigner();
  mocks.resolveAirdropAccount.mockResolvedValue({
    address: ADDRESS,
    signer,
  });
  mocks.ensureAirdropAlias.mockResolvedValue({
    alias: ALIAS,
    signer: PERSON_SIGNER,
  });
  currentApi = makeApi();
  mocks.getPeopleClient.mockResolvedValue({
    api: currentApi,
    client: { getBestBlocks: vi.fn().mockResolvedValue([]) },
    network: {},
    wsUrl: "",
  });
  mocks.watchTransactionSubmission.mockImplementation(
    async (
      _tx: unknown,
      _signer: unknown,
      _options: unknown,
      watchOptions?: { onBroadcast?: (txHash: string) => void },
    ) => {
      watchOptions?.onBroadcast?.(TX_HASH);
      return { status: "finalized", txHash: TX_HASH };
    },
  );
}
