// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

import { probeLiteKeyOwners } from "@features/debug/lite-key-owner-probe.ts";
import { devicehoodRingLocation } from "@humanity/shared/chain/individuality.ts";
import {
  candidateProductDomain,
  resolveNetwork,
} from "@humanity/shared/chain/networks.ts";
import { ringIdentifier } from "@humanity/shared/chain/ring-membership.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";

const mocks = vi.hoisted(() => ({
  getAccountsProvider: vi.fn(),
}));

// Real `toHex`: a stub would assert nothing about the disclosed hex.
vi.mock("@humanity/shared/chain/host-api.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAccountsProvider: mocks.getAccountsProvider,
}));

const NETWORK = resolveNetwork("paseo-next-v2");
const LITE_RING = devicehoodRingLocation(NETWORK);
const LITE_COLLECTION_ID = ringIdentifier("people-lite");

const PEOPL_OWNER = personhoodProductId(NETWORK);
const DIM2_OWNER = candidateProductDomain(NETWORK);

const ATTESTED_KEY = `0x${"8c".repeat(32)}`;
const OTHER_KEY = `0x${"93".repeat(32)}`;

const bytes = (hex: string) =>
  Uint8Array.from((hex.slice(2).match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** A `Result`-alike with the two-arg `.match` shape the host provider
 *  returns — named so `provider` below can type its lookup table without
 *  reaching for `ReturnType`. */
interface HostResult<T> {
  match: <R>(onOk: (value: T) => R, onErr: (error: unknown) => R) => Promise<R>;
}
const ok = <T>(value: T): HostResult<T> => ({
  match: async (onOk) => onOk(value),
});
const err = (error: unknown): HostResult<never> => ({
  match: async (_onOk, onErr) => onErr(error),
});

/** A registered entry declaring the lite ring, disclosing `keyHex` unless
 *  `undisclosed`. Collection id alone, not the full junction list:
 *  exercises the same loose ring match `declaresRing` uses elsewhere,
 *  where a host can declare a ring with fewer junctions than this app
 *  builds. */
function liteEntry(keyHex: string, undisclosed = false) {
  return {
    handle: {},
    publicKey: undisclosed ? undefined : bytes(keyHex),
    rings: [
      { chainId: LITE_RING.chainId, junctions: [{ tag: "CollectionId", value: LITE_COLLECTION_ID }] },
    ],
  };
}

/** A registered entry that declares some other ring — never the lite one. */
function foreignRingEntry(keyHex: string) {
  return {
    handle: {},
    publicKey: bytes(keyHex),
    rings: [
      {
        chainId: LITE_RING.chainId,
        junctions: [{ tag: "CollectionId", value: `0x${"ff".repeat(32)}` }],
      },
    ],
  };
}

function provider(byOwner: Record<string, () => HostResult<unknown>>) {
  const listRingVrfKeys = vi.fn((owner: string) => byOwner[owner]?.() ?? ok([]));
  return {
    listRingVrfKeys,
    registerRingVrfKey: vi.fn(),
    createRingVRFProof: vi.fn(),
    ringVrfSign: vi.fn(),
  };
}

beforeEach(() => {
  mocks.getAccountsProvider.mockReset();
});

describe("probeLiteKeyOwners", () => {
  it("lists both candidate owners with public-key disclosure", async () => {
    const host = provider({});
    mocks.getAccountsProvider.mockResolvedValue(host);

    await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    expect(host.listRingVrfKeys).toHaveBeenCalledWith(PEOPL_OWNER, "PublicKey");
    expect(host.listRingVrfKeys).toHaveBeenCalledWith(DIM2_OWNER, "PublicKey");
    expect(host.listRingVrfKeys).toHaveBeenCalledTimes(2);
  });

  it("never mints a proof or registers a key on any path", async () => {
    const host = provider({
      [PEOPL_OWNER]: () => ok([liteEntry(ATTESTED_KEY)]),
    });
    mocks.getAccountsProvider.mockResolvedValue(host);

    await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    expect(host.registerRingVrfKey).not.toHaveBeenCalled();
    expect(host.createRingVRFProof).not.toHaveBeenCalled();
    expect(host.ringVrfSign).not.toHaveBeenCalled();
  });

  it("names peopl as the verdict when its registry discloses the attested key", async () => {
    mocks.getAccountsProvider.mockResolvedValue(
      provider({
        [PEOPL_OWNER]: () => ok([liteEntry(ATTESTED_KEY)]),
        [DIM2_OWNER]: () => ok([]),
      }),
    );

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    expect(diagnostics.verdict).toEqual({ holder: "peopl", owner: PEOPL_OWNER });
    const peopl = diagnostics.reports.find((r) => r.label === "peopl");
    expect(peopl?.outcome).toBe("ok");
    expect(peopl?.entries).toEqual([
      { key: ATTESTED_KEY, declaresLiteRing: true, matchesAttested: true },
    ]);
  });

  it("names dim2 as the verdict when only its registry discloses the key", async () => {
    mocks.getAccountsProvider.mockResolvedValue(
      provider({
        [DIM2_OWNER]: () => ok([liteEntry(ATTESTED_KEY)]),
      }),
    );

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    expect(diagnostics.verdict).toEqual({ holder: "dim2", owner: DIM2_OWNER });
  });

  it("reports no holder when no probed owner discloses the attested key", async () => {
    mocks.getAccountsProvider.mockResolvedValue(
      provider({
        [PEOPL_OWNER]: () => ok([liteEntry(OTHER_KEY)]),
      }),
    );

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    expect(diagnostics.verdict).toEqual({ holder: null });
  });

  it("keeps a rejected owner from affecting owners that succeeded", async () => {
    mocks.getAccountsProvider.mockResolvedValue(
      provider({
        [PEOPL_OWNER]: () => ok([liteEntry(ATTESTED_KEY)]),
        [DIM2_OWNER]: () => err({ tag: "Rejected" }),
      }),
    );

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    const peopl = diagnostics.reports.find((r) => r.label === "peopl");
    const dim2 = diagnostics.reports.find((r) => r.label === "dim2");
    expect(peopl?.outcome).toBe("ok");
    expect(diagnostics.verdict).toEqual({ holder: "peopl", owner: PEOPL_OWNER });
    expect(dim2?.outcome).toBe("rejected");
    expect(dim2?.error).toContain("Rejected");
  });

  it("treats NotConnected and Unknown as call errors, not owner refusals", async () => {
    mocks.getAccountsProvider.mockResolvedValue(
      provider({
        [PEOPL_OWNER]: () => err({ tag: "NotConnected" }),
        [DIM2_OWNER]: () => err({ tag: "Unknown", value: { reason: "bridge timeout" } }),
      }),
    );

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    const peopl = diagnostics.reports.find((r) => r.label === "peopl");
    const dim2 = diagnostics.reports.find((r) => r.label === "dim2");
    expect(peopl?.outcome).toBe("error");
    expect(dim2?.outcome).toBe("error");
    expect(dim2?.error).toContain("bridge timeout");
  });

  it("marks an entry with no disclosure explicitly, and it never matches", async () => {
    mocks.getAccountsProvider.mockResolvedValue(
      provider({
        [PEOPL_OWNER]: () => ok([liteEntry(ATTESTED_KEY, true)]),
      }),
    );

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    const peopl = diagnostics.reports.find((r) => r.label === "peopl");
    expect(peopl?.entries).toEqual([
      { key: null, declaresLiteRing: true, matchesAttested: false },
    ]);
    expect(diagnostics.verdict).toEqual({ holder: null });
  });

  it("flags an entry that declares a different ring than people-lite", async () => {
    mocks.getAccountsProvider.mockResolvedValue(
      provider({
        [PEOPL_OWNER]: () => ok([foreignRingEntry(ATTESTED_KEY)]),
      }),
    );

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    const peopl = diagnostics.reports.find((r) => r.label === "peopl");
    expect(peopl?.entries[0]?.declaresLiteRing).toBe(false);
    // Still names the holder: ring declaration and disclosure are reported
    // separately from the key match itself.
    expect(diagnostics.verdict).toEqual({ holder: "peopl", owner: PEOPL_OWNER });
  });

  it("reports every owner as errored, never throwing, with no host container", async () => {
    mocks.getAccountsProvider.mockResolvedValue(null);

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    expect(diagnostics.reports).toHaveLength(2);
    expect(diagnostics.reports.every((r) => r.outcome === "error")).toBe(true);
    expect(diagnostics.verdict).toEqual({ holder: null });
  });

  it("isolates a throwing owner from the others instead of failing the whole probe", async () => {
    const listRingVrfKeys = vi.fn((owner: string) => {
      if (owner === DIM2_OWNER) throw new TypeError("bridge dropped the frame");
      return ok(owner === PEOPL_OWNER ? [liteEntry(ATTESTED_KEY)] : []);
    });
    mocks.getAccountsProvider.mockResolvedValue({ listRingVrfKeys });

    const diagnostics = await probeLiteKeyOwners(NETWORK, ATTESTED_KEY);

    const peopl = diagnostics.reports.find((r) => r.label === "peopl");
    const dim2 = diagnostics.reports.find((r) => r.label === "dim2");
    expect(peopl?.outcome).toBe("ok");
    expect(dim2?.outcome).toBe("error");
    expect(dim2?.error).toContain("TypeError");
    expect(diagnostics.verdict).toEqual({ holder: "peopl", owner: PEOPL_OWNER });
  });
});
