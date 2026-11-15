// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fromHex } from "@parity/product-sdk/host";

import { probeResourcesAlias } from "@humanity/shared/chain/resources-alias.ts";
import {
  PERSONHOOD_CONTEXT_INDEX,
  devicehoodRingLocation,
  membershipRingLocation,
  personhoodContext,
} from "@humanity/shared/chain/individuality.ts";
import { resolveNetwork } from "@humanity/shared/chain/networks.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";

const mocks = vi.hoisted(() => ({
  getAccountsProvider: vi.fn(),
}));

// Real `findRingVrfKeyHandle`: a stub would assert nothing about selection.
vi.mock("@humanity/shared/chain/host-api.ts", async () => {
  const host = await import("@parity/product-sdk/host");
  return {
    getAccountsProvider: mocks.getAccountsProvider,
    findRingVrfKeyHandle: host.findRingVrfKeyHandle,
    toHex: host.toHex,
  };
});

const NETWORK = resolveNetwork("paseo-next-v2");
const PEOPLE_RING = membershipRingLocation(NETWORK);

// Derived, never pasted: a hex literal kept tests green while upgrades failed.
const DERIVED_CONTEXT = personhoodContext(NETWORK.dotnsSuffix, "resources");

const ALIAS_BYTES = new Uint8Array(32).fill(0xc3);

// The Devicehood ring: differs from PEOPLE_RING only in the collection id, not
// the chain, which is exactly the confusion this preflight has to catch.
const OTHER_RING = devicehoodRingLocation(NETWORK);

const KEY_OWNER = personhoodProductId(NETWORK);
const KEY_HANDLE = { dotNsIdentifier: KEY_OWNER, derivationIndex: 0 };

function resultAsync<T>(value: T | Error) {
  return {
    match: async (ok: (v: T) => unknown, err: (e: unknown) => unknown) =>
      value instanceof Error ? err(value) : ok(value as T),
  };
}

// A host refusal: the domain error arrives under `tag`.
function refusal(tag: string) {
  return {
    match: async (_ok: (v: never) => unknown, err: (e: unknown) => unknown) =>
      err({ tag }),
  };
}

interface ProviderOptions {
  /** Empty means an empty registry. */
  rings?: (typeof PEOPLE_RING)[];
  /** Defaults to agreeing with the derived context. */
  hostContext?: string;
  listRefusal?: string;
  aliasRefusal?: string;
}

function makeProvider(options: ProviderOptions = {}) {
  const rings = options.rings ?? [PEOPLE_RING];
  return {
    listRingVrfKeys: vi.fn(() =>
      options.listRefusal != null
        ? refusal(options.listRefusal)
        : resultAsync(rings.length === 0 ? [] : [{ handle: KEY_HANDLE, rings }]),
    ),
    getProductAccountAlias: vi.fn(() =>
      options.aliasRefusal != null
        ? refusal(options.aliasRefusal)
        : resultAsync({
            context: fromHex(options.hostContext ?? DERIVED_CONTEXT),
            alias: ALIAS_BYTES,
          }),
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("probeResourcesAlias", () => {
  it("passes the selected key handle and an Index-tagged suffix to the host", async () => {
    // Both 0.23 breaks at once: the required handle, and `Index` for `Left`.
    const provider = makeProvider();
    mocks.getAccountsProvider.mockResolvedValue(provider);

    await probeResourcesAlias(NETWORK);

    expect(provider.getProductAccountAlias).toHaveBeenCalledWith(
      KEY_HANDLE,
      {
        productId: `peopl.${NETWORK.dotnsSuffix}`,
        suffix: { tag: "Index", value: PERSONHOOD_CONTEXT_INDEX.resources },
      },
      PEOPLE_RING,
    );
  });

  it("looks the key up under this network's personhood product", async () => {
    const provider = makeProvider();
    mocks.getAccountsProvider.mockResolvedValue(provider);

    const diagnostics = await probeResourcesAlias(NETWORK);

    // `peopl.<suffix>`, the id the phone derives people under and the id this
    // app is opened as. A different owner returns an empty list — which this
    // probe would report as "no key registered" rather than as a wrong lookup.
    expect(provider.listRingVrfKeys).toHaveBeenCalledWith("peopl.paseo");
    expect(diagnostics.keyOwner).toBe("peopl.paseo");
  });

  it("reports a match when the host derives the context this build expects", async () => {
    mocks.getAccountsProvider.mockResolvedValue(makeProvider());

    const diagnostics = await probeResourcesAlias(NETWORK);

    expect(diagnostics.outcome).toBe("match");
    expect(diagnostics.hostContext).toBe(DERIVED_CONTEXT);
    expect(diagnostics.derivedContext).toBe(DERIVED_CONTEXT);
    expect(diagnostics.alias).toBe(`0x${"c3".repeat(32)}`);
  });

  it("reports a mismatch when the host binds a different context", async () => {
    const other = `0x${"b2".repeat(32)}`;
    mocks.getAccountsProvider.mockResolvedValue(
      makeProvider({ hostContext: other }),
    );

    const diagnostics = await probeResourcesAlias(NETWORK);

    expect(diagnostics.outcome).toBe("context-mismatch");
    expect(diagnostics.hostContext).toBe(other);
    expect(diagnostics.derivedContext).toBe(DERIVED_CONTEXT);
  });

  it("reports no-ring-key when the registry holds no key for the people ring", async () => {
    const provider = makeProvider({ rings: [OTHER_RING] });
    mocks.getAccountsProvider.mockResolvedValue(provider);

    const diagnostics = await probeResourcesAlias(NETWORK);

    expect(diagnostics.outcome).toBe("no-ring-key");
    expect(diagnostics.keyOwner).toBe(KEY_OWNER);
    expect(provider.getProductAccountAlias).not.toHaveBeenCalled();
  });

  it("reports no-ring-key on an empty registry", async () => {
    mocks.getAccountsProvider.mockResolvedValue(makeProvider({ rings: [] }));

    expect((await probeResourcesAlias(NETWORK)).outcome).toBe("no-ring-key");
  });

  it("names which host call refused", async () => {
    // One `rejected` outcome covers both calls, so the error must name which.
    mocks.getAccountsProvider.mockResolvedValue(
      makeProvider({ listRefusal: "NotConnected" }),
    );
    const listRejected = await probeResourcesAlias(NETWORK);

    mocks.getAccountsProvider.mockResolvedValue(
      makeProvider({ aliasRefusal: "KeyNotInRing" }),
    );
    const aliasRejected = await probeResourcesAlias(NETWORK);

    expect(listRejected.outcome).toBe("rejected");
    expect(aliasRejected.outcome).toBe("rejected");
    expect(listRejected.error).not.toBe(aliasRejected.error);
    expect(listRejected.error).toContain("listRingVrfKeys");
    expect(listRejected.error).toContain("NotConnected");
    expect(aliasRejected.error).toContain("getProductAccountAlias");
    expect(aliasRejected.error).toContain("KeyNotInRing");
  });

  it("keeps the reason from the host's catch-all refusal", async () => {
    mocks.getAccountsProvider.mockResolvedValue({
      listRingVrfKeys: vi.fn(() => ({
        match: async (_ok: (v: never) => unknown, err: (e: unknown) => unknown) =>
          err({ tag: "Unknown", value: { reason: "bridge timeout after 30s" } }),
      })),
    });

    const diagnostics = await probeResourcesAlias(NETWORK);

    expect(diagnostics.outcome).toBe("rejected");
    expect(diagnostics.error).toContain("bridge timeout after 30s");
  });

  it("separates a thrown call from a deliberate refusal", async () => {
    mocks.getAccountsProvider.mockResolvedValue({
      listRingVrfKeys: vi.fn(() => resultAsync([{ handle: KEY_HANDLE, rings: [PEOPLE_RING] }])),
      // An older adapter: the method is simply absent.
    });

    const diagnostics = await probeResourcesAlias(NETWORK);

    expect(diagnostics.outcome).toBe("threw");
    expect(diagnostics.error).toContain("TypeError");
    expect(diagnostics.keyOwner).toBe(KEY_OWNER);
  });

  it("reports unavailable when there is no host container", async () => {
    mocks.getAccountsProvider.mockResolvedValue(null);

    const diagnostics = await probeResourcesAlias(NETWORK);

    expect(diagnostics.outcome).toBe("unavailable");
    expect(diagnostics.derivedContext).toBe(DERIVED_CONTEXT);
  });
});
