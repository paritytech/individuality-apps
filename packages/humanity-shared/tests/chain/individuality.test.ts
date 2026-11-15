// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { NETWORKS } from "@humanity/shared/chain/networks.ts";
import {
  PERSONHOOD_CONTEXT_INDEX,
  devicehoodRingLocation,
  membershipRingLocation,
  personhoodContext,
  productContext,
} from "@humanity/shared/chain/individuality.ts";

/**
 * Contexts read from Previewnet's People chain
 * (`wss://previewnet.substrate.dev/people`) as the runtime constants
 * `Score.score_context`, `PeopleLite.auth_context` and
 * `PeopleAirdrops.people_airdrops_context`.
 *
 * The derivation itself now belongs to `@parity/product-sdk/individuality`, so
 * what these cases pin is that the SDK's copy still produces the bytes *this*
 * chain publishes. The Resources context — the one the username upgrade needs —
 * is a plain `impl` fn, absent from metadata, and therefore cannot be checked
 * against the chain at all; every personhood context comes out of the same
 * `build_product_context` call, so pinning the three that *are* published pins
 * the derivation that produces the fourth.
 *
 * Previewnet issues `.testnet` names, which is
 * `NETWORKS.previewnet.dotnsSuffix`.
 */
const PREVIEWNET_ON_CHAIN: ReadonlyArray<
  [keyof typeof PERSONHOOD_CONTEXT_INDEX, string]
> = [
  [
    "score",
    "0x643d4ff66aec3089cbadc0d15992c5d03b0d71cb760c07aac62ce6426a547de4",
  ],
  [
    "peopleLiteAuth",
    "0x16558e5be5ca20885120376f1effdcec72e5d0949dfbed1790d1a95990d9a02e",
  ],
  [
    "peopleAirdrops",
    "0x2eecac11fdf3a5d38f702c02437643ab50f66d33d2b298ef1bbdd69dd60bc635",
  ],
];

describe("personhoodContext", () => {
  it.each(PREVIEWNET_ON_CHAIN)(
    "derives the %s context Previewnet publishes",
    (name, onChain) => {
      expect(personhoodContext("testnet", name)).toBe(onChain);
    },
  );

  it("derives the Resources context Previewnet expects", () => {
    // Not readable from metadata; produced by the derivation the cases above
    // prove, at `personhood::RESOURCES` (index 1).
    expect(personhoodContext("testnet", "resources")).toBe(
      "0x7401c93b4b15d2a248158933505cda03df512a24cbd27f1d6f68bf215766ef44",
    );
  });

  it("is the context Previewnet's network config resolves to", () => {
    expect(NETWORKS.previewnet.dotnsSuffix).toBe("testnet");
  });

  it("gives every network its own context", () => {
    const suffixes = Object.values(NETWORKS).map((n) => n.dotnsSuffix);
    const contexts = new Set(
      suffixes.map((suffix) => personhoodContext(suffix, "resources")),
    );

    expect(new Set(suffixes).size).toBe(suffixes.length);
    expect(contexts.size).toBe(suffixes.length);
  });

  it("gives every suffix index its own context", () => {
    const contexts = new Set(
      Object.keys(PERSONHOOD_CONTEXT_INDEX).map((name) =>
        personhoodContext(
          "testnet",
          name as keyof typeof PERSONHOOD_CONTEXT_INDEX,
        ),
      ),
    );

    expect(contexts.size).toBe(Object.keys(PERSONHOOD_CONTEXT_INDEX).length);
  });

  it("refuses a composite suffix rather than colliding on one", () => {
    // "peopl" + ".te.st" and "peopl.te" + ".st" would hash alike, so the
    // derivation rejects a suffix carrying a dot instead of accepting either.
    expect(() => personhoodContext("te.st", "resources")).toThrow();
  });
});

describe("productContext", () => {
  it("takes the full DotNS id, TLD included", () => {
    const suffix = { tag: "Index", value: 1 } as const;

    expect(productContext("peopl.testnet", suffix)).toBe(
      personhoodContext("testnet", "resources"),
    );
    expect(productContext("dim2.testnet", suffix)).not.toBe(
      productContext("peopl.testnet", suffix),
    );
  });
});

describe("ring locations", () => {
  const network = NETWORKS["paseo-next-v2"];

  it("addresses both rings on this network's People chain", () => {
    for (const ring of [
      membershipRingLocation(network),
      devicehoodRingLocation(network),
    ]) {
      expect(ring.chainId).toBe(network.peopleChain.genesisHash);
    }
  });

  it("separates Membership from Devicehood by collection id alone", () => {
    const membership = membershipRingLocation(network);
    const devicehood = devicehoodRingLocation(network);

    expect(membership.junctions).not.toEqual(devicehood.junctions);
    expect(
      membership.junctions.filter((j) => j.tag !== "CollectionId"),
    ).toEqual(devicehood.junctions.filter((j) => j.tag !== "CollectionId"));
  });

  it("emits no PalletInstance junction, so a pallet reindex cannot break it", () => {
    // Every host resolves the `Members` pallet by name and treats the junction
    // as an optional cross-check, so pinning its index here bought nothing and
    // would have gone stale on a `construct_runtime!` change.
    expect(
      membershipRingLocation(network).junctions.map((j) => j.tag),
    ).toEqual(["CollectionId"]);
  });
});
