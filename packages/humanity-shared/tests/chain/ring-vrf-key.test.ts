// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import { resolveRingVrfKeyHandle } from "@humanity/shared/chain/ring-vrf-key.ts";
import type { AccountsProvider, RingLocation } from "@humanity/shared/chain/host-api.ts";

const RING: RingLocation = {
  chainId: `0x${"11".repeat(32)}`,
  junctions: [{ tag: "CollectionId", value: `0x${"22".repeat(32)}` }],
};
const OTHER_RING: RingLocation = {
  chainId: `0x${"11".repeat(32)}`,
  junctions: [{ tag: "CollectionId", value: `0x${"33".repeat(32)}` }],
};
/** The same ring as {@link RING}, declared the way this app builds it. */
const RING_WITH_PALLET: RingLocation = {
  chainId: RING.chainId,
  junctions: [{ tag: "PalletInstance", value: 50 }, ...RING.junctions],
};

const HANDLE = { handle: "h1" } as never;
const EXACT_HANDLE = { handle: "h2" } as never;

function resultAsync<T>(value: T | Error) {
  return {
    match: async (ok: (v: T) => unknown, err: (e: unknown) => unknown) =>
      value instanceof Error ? err(value) : ok(value as T),
  };
}

function makeProvider(overrides: {
  lists: ReadonlyArray<Array<{ handle: unknown; rings: RingLocation[] }>>;
  register?: Uint8Array | Error;
}) {
  let call = 0;
  return {
    listRingVrfKeys: vi.fn(() =>
      resultAsync(overrides.lists[Math.min(call++, overrides.lists.length - 1)]),
    ),
    registerRingVrfKey: vi.fn(() =>
      resultAsync(overrides.register ?? new Uint8Array(32).fill(7)),
    ),
  } as unknown as AccountsProvider;
}

describe("resolveRingVrfKeyHandle", () => {
  // The host proves only for a location it declared, compared exactly: the
  // `[CollectionId]` ring for a key declared as `[PalletInstance,
  // CollectionId]` answered KeyNotInRing on every claim (2026-10-29).
  it("hands back the host's declared location for a key matched by collection", async () => {
    const provider = makeProvider({
      lists: [[{ handle: HANDLE, rings: [RING_WITH_PALLET] }]],
    });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING),
    ).resolves.toEqual({ handle: HANDLE, ring: RING_WITH_PALLET });
    expect(provider.registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("reuses a key already registered for the ring", async () => {
    const provider = makeProvider({
      lists: [[{ handle: HANDLE, rings: [RING] }]],
    });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING),
    ).resolves.toEqual({ handle: HANDLE, ring: RING });
    expect(provider.registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("registers when the registry has no key for this ring, then lists again", async () => {
    const provider = makeProvider({
      lists: [
        [{ handle: HANDLE, rings: [OTHER_RING] }],
        [{ handle: HANDLE, rings: [RING] }],
      ],
    });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING),
    ).resolves.toEqual({ handle: HANDLE, ring: RING });
    expect(provider.registerRingVrfKey).toHaveBeenCalledOnce();
    expect(provider.listRingVrfKeys).toHaveBeenCalledTimes(2);
  });

  it("registers at the full-People index, not an arbitrary one", async () => {
    const provider = makeProvider({
      lists: [[], [{ handle: HANDLE, rings: [RING] }]],
    });

    await resolveRingVrfKeyHandle(provider, "peopl.test", RING);

    expect(provider.registerRingVrfKey).toHaveBeenCalledWith(0, RING);
  });

  // Sentry 157020769: the host listed the wallet's key for this ring with a
  // different junction list, registering at index 0 handed back that same key,
  // and the second listing still missed it -> "missing".
  it("finds a key declaring the same chain and collection with other junctions", async () => {
    const provider = makeProvider({
      lists: [[{ handle: HANDLE, rings: [RING] }]],
    });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING_WITH_PALLET),
    ).resolves.toEqual({ handle: HANDLE, ring: RING });
    expect(provider.registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("prefers an exact ring location over a same-collection key", async () => {
    const provider = makeProvider({
      lists: [
        [
          { handle: HANDLE, rings: [RING] },
          { handle: EXACT_HANDLE, rings: [RING_WITH_PALLET] },
        ],
      ],
    });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING_WITH_PALLET),
    ).resolves.toEqual({ handle: EXACT_HANDLE, ring: RING_WITH_PALLET });
  });

  it("still fails with stage=missing when only another collection is declared", async () => {
    const provider = makeProvider({
      lists: [[{ handle: HANDLE, rings: [OTHER_RING] }]],
    });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING_WITH_PALLET),
    ).rejects.toEqual(expect.objectContaining({ stage: "missing" }));
  });

  it("fails with stage=missing when registration lands but no handle matches", async () => {
    // Means the ring we registered against is not the ring we asked about,
    // which is a RingLocation mismatch rather than a host refusal.
    const provider = makeProvider({ lists: [[], []] });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING),
    ).rejects.toEqual(expect.objectContaining({ stage: "missing" }));
  });

  it("fails with stage=list when the host declines to list", async () => {
    const provider = {
      listRingVrfKeys: vi.fn(() => resultAsync<never>(new Error("NotConnected"))),
      registerRingVrfKey: vi.fn(),
    } as unknown as AccountsProvider;

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING),
    ).rejects.toEqual(expect.objectContaining({ stage: "list" }));
    expect(provider.registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("fails with stage=register when the host declines to register", async () => {
    const provider = makeProvider({
      lists: [[]],
      register: new Error("Rejected"),
    });

    await expect(
      resolveRingVrfKeyHandle(provider, "peopl.test", RING),
    ).rejects.toEqual(expect.objectContaining({ stage: "register" }));
  });
});
