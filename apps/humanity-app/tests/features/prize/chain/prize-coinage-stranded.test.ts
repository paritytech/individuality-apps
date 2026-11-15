// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The post-claim sweep is the only thing that moves a prize off product
 * account zero, so a claim the user walks away from strands the funds there
 * with nobody left to shift them. Boot-time recovery is the second chance —
 * and because the host signs for whatever balance it is pointed at, what it
 * must never do is guess: it reads the draw-paying assets' actual balances on
 * the prize account and tops up exactly those, once per asset. The host
 * refuses a second concurrent top-up per source (`SourceBusy`), which is
 * ordinary rather than exceptional, so one asset's refusal may not cost the
 * others their recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as individualityModule from "@humanity/shared/chain/individuality.ts";
import type { PeopleAirdropsStanding } from "@humanity/shared/chain/individuality.ts";
import type * as prizeAccountModule from "@features/prize/chain/prize-account.ts";
import type { PrizeAccount } from "@features/prize/chain/prize-account.ts";

type AssetEntry = { balance: bigint } | undefined;

const mocks = vi.hoisted(() => ({
  resolvePrizeAccount: vi.fn<() => Promise<PrizeAccount | null>>(),
  getPeopleClient: vi.fn<() => Promise<unknown>>(),
  getValue:
    vi.fn<
      (
        assetId: unknown,
        address: string,
        options: { at: string; signal: AbortSignal },
      ) => Promise<AssetEntry>
    >(),
  readPeopleAirdropsStanding: vi.fn(),
  topUp: vi.fn<(args: { amount: bigint; derivationIndex: number }) => Promise<void>>(),
}));

// Stops the real `@parity/product-sdk/host` from loading behind the real
// `prize-account.ts` below; nothing here is ever called.
vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getAccountsProvider: vi.fn(),
  getPaymentManager: vi.fn(),
}));
// Only the resolver is faked: `PRIZE_ACCOUNT_INDEX` stays the real constant so
// the derivation index asserted below is the one the claim pays into, not a
// number this file made up.
vi.mock("@features/prize/chain/prize-account.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof prizeAccountModule>();
  return { ...actual, resolvePrizeAccount: mocks.resolvePrizeAccount };
});
vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: mocks.getPeopleClient,
}));
vi.mock("@humanity/shared/chain/individuality.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof individualityModule>();
  return { ...actual, readPeopleAirdropsStanding: mocks.readPeopleAirdropsStanding };
});
// `sweepPrizeIntoCoinage` runs for real; only the host hop is stubbed, so the
// payload the recovery hands it is under test.
vi.mock("@humanity/shared/chain/coinage-top-up.ts", () => ({
  topUpCoinageFromProductAccount: mocks.topUp,
}));

import {
  readStrandedPrizes,
  sweepStrandedPrizes,
  type StrandedPrize,
} from "@features/prize/chain/prize-coinage.ts";

const BEST_HASH = `0x${"0e".repeat(32)}`;
const PRIZE_ADDRESS = "5PrizeProductAccountZero";
const DRAW_PREFIX = "706f703a70656f706c652d61697264726f70733a20202020";

/**
 * Prize asset ids are XCM locations whose junctions carry `bigint`s — which
 * `JSON.stringify` refuses outright — and the same asset arrives as a fresh
 * object per draw. Hence a factory rather than a shared constant: dedupe has
 * to work structurally, never on reference identity.
 */
const usdAsset = (): unknown => ({
  parents: 1,
  interior: { X2: [{ Parachain: 1000 }, { GeneralIndex: 1_984n }] },
});
const otherAsset = (): unknown => ({
  parents: 1,
  interior: { X2: [{ Parachain: 1000 }, { GeneralIndex: 42n }] },
});

const assetKey = (assetId: unknown): string =>
  JSON.stringify(assetId, (_, value: unknown) =>
    typeof value === "bigint" ? `${value}n` : value,
  );

const fakeClient = {
  client: { marker: "people-client" },
  api: { query: { Assets: { Account: { getValue: mocks.getValue } } } },
};

type Draw = PeopleAirdropsStanding["draws"][number];

function draw(index: number, assetId: unknown): Draw {
  return {
    drawIndex: BigInt(index),
    event: {
      eventId: `0x${DRAW_PREFIX}${index.toString(16).padStart(16, "0")}`,
      status: "Claiming",
      phase: "Claiming",
      prize: { assetId: assetId as Draw["event"]["prize"]["assetId"], assetAmount: 1_000_000n, maxWinners: 1, winnerCapPermill: 0 },
      registrationStarts: 1_800_000_000,
      drawTime: 1_800_003_600,
      endTime: 1_800_007_200,
      totalParticipants: 1,
      effectiveWinners: 1,
      claimed: 0,
      source: null,
    },
    slot: null,
    registered: null,
    won: null,
  };
}

/** The draws on chain, as the SDK reads them at the best block. */
function onChain(draws: Draw[]): void {
  mocks.readPeopleAirdropsStanding.mockResolvedValue({
    ok: true,
    value: {
      at: { blockHash: BEST_HASH, blockNumber: 9 },
      account: PRIZE_ADDRESS,
      alias: { airdropsContext: `0x${"ab".repeat(32)}`, binding: { tag: "Unbound" } },
      draws,
    },
  });
}

/** The SDK's answer when the client reports no best block to pin. */
function noBestBlock(): void {
  mocks.readPeopleAirdropsStanding.mockResolvedValue({
    ok: false,
    error: new Error("the chain client reported no best block"),
  });
}

/**
 * `Assets.Account` holds no entry for an account that never held the asset, so
 * `undefined` — not `{ balance: 0n }` — is the real shape of "nothing here".
 * Pass `undefined` for that case and `0n` for a drained entry.
 */
function holdings(...entries: [assetId: unknown, balance: bigint | undefined][]): void {
  const table: Record<string, bigint | undefined> = Object.fromEntries(
    entries.map(([assetId, balance]) => [assetKey(assetId), balance]),
  );
  mocks.getValue.mockImplementation((assetId) => {
    const balance = table[assetKey(assetId)];
    return Promise.resolve(balance == null ? undefined : { balance });
  });
}

beforeEach(() => {
  mocks.resolvePrizeAccount.mockResolvedValue({
    address: PRIZE_ADDRESS,
  } as unknown as PrizeAccount);
  mocks.getPeopleClient.mockResolvedValue(fakeClient);
  onChain([draw(1, usdAsset())]);
  holdings([usdAsset(), undefined]);
  mocks.topUp.mockResolvedValue(undefined);
});

afterEach(() => {
  mocks.resolvePrizeAccount.mockReset();
  mocks.getPeopleClient.mockReset();
  mocks.getValue.mockReset();
  mocks.readPeopleAirdropsStanding.mockReset();
  mocks.topUp.mockReset();
});

const freshSignal = (): AbortSignal => new AbortController().signal;

describe("readStrandedPrizes", () => {
  it("reports no answer, not an empty one, outside a host container", async () => {
    mocks.resolvePrizeAccount.mockResolvedValue(null);

    await expect(readStrandedPrizes(freshSignal())).resolves.toBeNull();

    expect(mocks.getPeopleClient).not.toHaveBeenCalled();
  });

  it("reads each distinct prize asset once, at the best block", async () => {
    onChain([
      draw(1, usdAsset()),
      draw(2, usdAsset()),
      draw(3, otherAsset()),
    ]);
    holdings([usdAsset(), undefined], [otherAsset(), undefined]);
    const signal = freshSignal();

    await readStrandedPrizes(signal);

    expect(mocks.readPeopleAirdropsStanding).toHaveBeenCalledWith(
      expect.objectContaining({
        individuality: fakeClient.api,
        raw: { individuality: fakeClient.client },
      }),
      { account: PRIZE_ADDRESS, signal },
    );
    // Two draws pay in the same asset: a per-draw read would make three
    // storage calls and three top-ups for one balance.
    expect(mocks.getValue).toHaveBeenCalledTimes(2);
    // Same pin as the draw list, and the caller's signal: a balance read left
    // unbound would keep a dead subscription reconnecting after unmount.
    expect(mocks.getValue).toHaveBeenCalledWith(usdAsset(), PRIZE_ADDRESS, {
      at: BEST_HASH,
      signal,
    });
    expect(mocks.getValue).toHaveBeenCalledWith(otherAsset(), PRIZE_ADDRESS, {
      at: BEST_HASH,
      signal,
    });
  });

  it("keeps only the assets the prize account actually holds", async () => {
    onChain([
      draw(1, usdAsset()),
      draw(2, otherAsset()),
    ]);
    holdings([usdAsset(), 5_000_000n], [otherAsset(), undefined]);

    await expect(readStrandedPrizes(freshSignal())).resolves.toEqual([
      { assetId: usdAsset(), amount: 5_000_000n },
    ]);
  });

  it("fails loudly when People Chain reports no best block", async () => {
    noBestBlock();

    await expect(readStrandedPrizes(freshSignal())).rejects.toThrow(/best block/i);
  });
});

describe("sweepStrandedPrizes", () => {
  it("skips when there is no product account to sweep from", async () => {
    mocks.resolvePrizeAccount.mockResolvedValue(null);

    await expect(sweepStrandedPrizes(freshSignal())).resolves.toEqual({
      status: "skipped",
      reason: "no-account",
    });

    expect(mocks.getPeopleClient).not.toHaveBeenCalled();
    expect(mocks.topUp).not.toHaveBeenCalled();
  });

  it("tops the purse up with exactly the stranded balance, from account zero", async () => {
    onChain([
      draw(1, usdAsset()),
      draw(2, otherAsset()),
    ]);
    holdings([usdAsset(), 5_000_000n], [otherAsset(), undefined]);
    const stranded: StrandedPrize = { assetId: usdAsset(), amount: 5_000_000n };

    await expect(sweepStrandedPrizes(freshSignal())).resolves.toEqual({
      status: "swept",
      sent: [stranded],
      failed: [],
    });

    expect(mocks.topUp).toHaveBeenCalledTimes(1);
    // Literal 0, not `PRIZE_ACCOUNT_INDEX`: this is the account
    // `PeopleAirdrops.claim` paid into, so the host must be asked to sign from
    // that same index — a change on either side has to fail here.
    expect(mocks.topUp).toHaveBeenCalledWith({
      amount: 5_000_000n,
      derivationIndex: 0,
    });
  });

  it("asks the host for nothing when no prize is stranded", async () => {
    onChain([
      draw(1, usdAsset()),
      draw(2, otherAsset()),
    ]);
    // A drained entry and a missing one: neither is money to recover.
    holdings([usdAsset(), 0n], [otherAsset(), undefined]);

    await expect(sweepStrandedPrizes(freshSignal())).resolves.toEqual({
      status: "skipped",
      reason: "nothing-stranded",
    });

    expect(mocks.topUp).not.toHaveBeenCalled();
  });

  it("recovers the remaining assets after the host refuses one", async () => {
    onChain([
      draw(1, usdAsset()),
      draw(2, otherAsset()),
    ]);
    holdings([usdAsset(), 3_000n], [otherAsset(), 7_000n]);
    // The host allows one live top-up per source; a second request is refused
    // outright, and that must not cost the other asset its recovery.
    const busy = new Error("SourceBusy");
    mocks.topUp.mockRejectedValueOnce(busy).mockResolvedValue(undefined);

    const outcome = await sweepStrandedPrizes(freshSignal());

    expect(outcome).toEqual({
      status: "swept",
      sent: [{ assetId: otherAsset(), amount: 7_000n }],
      failed: [{ prize: { assetId: usdAsset(), amount: 3_000n }, error: busy }],
    });
    // The caller logs this error object; a wrapped or swallowed one is useless.
    const failed = outcome.status === "swept" ? outcome.failed : [];
    expect(failed[0]?.error).toBe(busy);
    expect(mocks.topUp.mock.calls.map(([args]) => args.amount)).toEqual([
      3_000n,
      7_000n,
    ]);
  });

  it("propagates a failed balance read instead of reporting nothing stranded", async () => {
    noBestBlock();

    await expect(sweepStrandedPrizes(freshSignal())).rejects.toThrow(/best block/i);

    expect(mocks.topUp).not.toHaveBeenCalled();
  });
});
