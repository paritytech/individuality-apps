// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@humanity/shared/chain/host-api.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAccountsProvider: vi.fn(),
}));
const env = vi.hoisted(() => ({ productLabel: "peopl-preview-pr98" }));
vi.mock("@humanity/shared/config/env.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@humanity/shared/config/env.ts")>();
  return {
    ...actual,
    envConfig: {
      ...actual.envConfig,
      host: {
        get productLabel() {
          return env.productLabel;
        },
        productSubname: "",
      },
    },
  };
});

import { getAccountsProvider } from "@humanity/shared/chain/host-api.ts";
import { NETWORKS } from "@humanity/shared/chain/networks.ts";
import { ringIdentifier } from "@humanity/shared/chain/ring-membership.ts";
import {
  PersonhoodRingKeyError,
  readDeclaredRingKey,
  readPersonhoodRingKey,
  registerPersonhoodRingKey,
} from "@humanity/shared/identity/personhood-ring-key.ts";

const network = NETWORKS.previewnet;
const genesis = network.peopleChain.genesisHash;

/** A Devicehood key as previewnet's lite ring holds it, `Included`. */
const DEVICEHOOD_KEY =
  "0x8cfe8ae1de37175d75d56dec04d7bf5cc13d6bf7366bda892e8e19569256d836";
const MEMBERSHIP_KEY =
  "0xec8b667e199157ef193f6a287f3092422e32da0531d375e102396444cb0cbe96";

const bytes = (hex: string) =>
  Uint8Array.from(
    (hex.slice(2).match(/../g) ?? []).map((pair) => parseInt(pair, 16)),
  );

/** A `Result`-alike with the `.match` shape the host provider returns. */
const ok = <T>(value: T) => ({
  match: <R>(onOk: (value: T) => R) => onOk(value),
});
const err = <E>(error: E) => ({
  match: <R>(_onOk: unknown, onErr: (error: E) => R) => onErr(error),
});

function registered(publicKey: string, collectionId: string, junctions = 2) {
  return {
    handle: {},
    publicKey: bytes(publicKey),
    rings: [
      {
        chainId: genesis,
        junctions:
          junctions === 2
            ? [
                { tag: "PalletInstance", value: 67 },
                { tag: "CollectionId", value: collectionId },
              ]
            : [{ tag: "CollectionId", value: collectionId }],
      },
    ],
  };
}

function provider(listRingVrfKeys: unknown, registerRingVrfKey?: unknown) {
  vi.mocked(getAccountsProvider).mockResolvedValue({
    listRingVrfKeys,
    registerRingVrfKey,
  } as never);
}

describe("readPersonhoodRingKey", () => {
  beforeEach(() => {
    vi.mocked(getAccountsProvider).mockReset();
    env.productLabel = "peopl-preview-pr98";
  });

  it("asks for our own keys under this network's personhood product", async () => {
    const listRingVrfKeys = vi.fn(() =>
      ok([registered(MEMBERSHIP_KEY, ringIdentifier("people"))]),
    );
    provider(listRingVrfKeys);

    expect(await readPersonhoodRingKey(network, "people")).toBe(MEMBERSHIP_KEY);
    // `peopl.<suffix>`: the id the phone derives people under, and the id
    // this app is opened as — so the keys are ours to the host.
    expect(listRingVrfKeys).toHaveBeenCalledWith("peopl.testnet", "PublicKey");
  });

  it("picks the key declared for the ring asked about", async () => {
    provider(() =>
      ok([
        registered(MEMBERSHIP_KEY, ringIdentifier("people")),
        registered(DEVICEHOOD_KEY, ringIdentifier("people-lite")),
      ]),
    );

    expect(await readPersonhoodRingKey(network, "people-lite")).toBe(
      DEVICEHOOD_KEY,
    );
  });

  it("matches on the collection, not the whole location", async () => {
    // An identity created by an older CLI declared the ring as
    // `[CollectionId]` alone, while this app builds
    // `[PalletInstance, CollectionId]`. Same ring; a deep compare would miss
    // it and report a real Member as unanswerable.
    provider(() =>
      ok([registered(DEVICEHOOD_KEY, ringIdentifier("people-lite"), 1)]),
    );

    expect(await readPersonhoodRingKey(network, "people-lite")).toBe(
      DEVICEHOOD_KEY,
    );
  });

  it("is null when the host holds no key for that ring", async () => {
    // Legitimate: the key that reaches the ring can be put there by a method
    // that never told this host about it.
    provider(() =>
      ok([registered(DEVICEHOOD_KEY, ringIdentifier("people-lite"))]),
    );

    expect(await readPersonhoodRingKey(network, "people")).toBeNull();
  });

  it("is null when the host has no ring-VRF registry, and never registers", async () => {
    // The native iOS host (Swift TrUAPI, not the Rust core) answers every
    // RFC-0024 key call with `Unsupported`; it picks the person key itself
    // inside create_proof / get_alias. Nothing to refuse, so not a fault: the
    // card reads the ring by account instead — even for the personhood
    // product, which must not try to register against such a host.
    env.productLabel = "peopl";
    const registerRingVrfKey = vi.fn();
    provider(() => err({ tag: "Unsupported" }), registerRingVrfKey);

    expect(await readPersonhoodRingKey(network, "people")).toBeNull();
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("treats a nested Unsupported the same way", async () => {
    provider(() => err({ tag: "Domain", value: { tag: "Unsupported" } }));
    expect(await readPersonhoodRingKey(network, "people")).toBeNull();
  });

  it("is null with no host at all", async () => {
    vi.mocked(getAccountsProvider).mockResolvedValue(null as never);
    expect(await readPersonhoodRingKey(network, "people")).toBeNull();
  });

  it("throws when the host refuses", async () => {
    // We are the product these keys belong to, so a refusal is a fault and
    // must not read as "not a member".
    provider(() => err({ tag: "NotConnected" }));

    await expect(readPersonhoodRingKey(network, "people")).rejects.toThrow(
      PersonhoodRingKeyError,
    );
  });

  it("throws when the host answers without the public key", async () => {
    provider(() =>
      ok([
        {
          ...registered(MEMBERSHIP_KEY, ringIdentifier("people")),
          publicKey: undefined,
        },
      ]),
    );

    await expect(readPersonhoodRingKey(network, "people")).rejects.toThrow(
      /disclosed no public key/,
    );
  });

  it("ignores a key registered for another chain", async () => {
    provider(() =>
      ok([
        {
          ...registered(MEMBERSHIP_KEY, ringIdentifier("people")),
          rings: [
            {
              chainId: NETWORKS["paseo-next-v2"].peopleChain.genesisHash,
              junctions: [
                { tag: "CollectionId", value: ringIdentifier("people") },
              ],
            },
          ],
        },
      ]),
    );

    expect(await readPersonhoodRingKey(network, "people")).toBeNull();
  });
  describe("when this deploy is the personhood product", () => {
    beforeEach(() => {
      env.productLabel = "peopl";
    });

    it("registers our own key when the host holds none for the ring", async () => {
      // RFC-0024: only registration brings a key into existence, and the
      // personhood product is the one meant to register these. Nothing else
      // does — a fresh wallet answers `[]` to everyone until we call this.
      const registerRingVrfKey = vi.fn(() => ok(bytes(MEMBERSHIP_KEY)));
      const listRingVrfKeys = vi
        .fn()
        .mockReturnValueOnce(
          ok([registered(DEVICEHOOD_KEY, ringIdentifier("people-lite"))]),
        )
        .mockReturnValueOnce(
          ok([
            registered(DEVICEHOOD_KEY, ringIdentifier("people-lite")),
            registered(MEMBERSHIP_KEY, ringIdentifier("people")),
          ]),
        );
      provider(listRingVrfKeys, registerRingVrfKey);

      expect(await readPersonhoodRingKey(network, "people")).toBe(
        MEMBERSHIP_KEY,
      );
      // Index 0 is the full person key by RFC-0022; the ring is declared.
      expect(registerRingVrfKey).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ chainId: genesis }),
      );
      expect(listRingVrfKeys).toHaveBeenCalledTimes(2);
    });

    it("registers index 1 for the Devicehood ring", async () => {
      const registerRingVrfKey = vi.fn(() => ok(bytes(DEVICEHOOD_KEY)));
      provider(
        vi
          .fn()
          .mockReturnValueOnce(ok([]))
          .mockReturnValueOnce(
            ok([registered(DEVICEHOOD_KEY, ringIdentifier("people-lite"))]),
          ),
        registerRingVrfKey,
      );

      expect(await readPersonhoodRingKey(network, "people-lite")).toBe(
        DEVICEHOOD_KEY,
      );
      expect(registerRingVrfKey).toHaveBeenCalledWith(1, expect.anything());
    });

    it("does not register when the key is already there", async () => {
      const registerRingVrfKey = vi.fn();
      provider(
        () => ok([registered(MEMBERSHIP_KEY, ringIdentifier("people"))]),
        registerRingVrfKey,
      );

      expect(await readPersonhoodRingKey(network, "people")).toBe(
        MEMBERSHIP_KEY,
      );
      expect(registerRingVrfKey).not.toHaveBeenCalled();
    });

    it("throws when the registered key is not listed under our product", async () => {
      // `registerRingVrfKey` mints under the *calling* product. A host
      // session started under some other id mints a valid key that is in no
      // ring, and the listing under `peopl.testnet` never shows it. That is a
      // misconfigured host, not "not a member".
      const STRAY =
        "0x3016fbbdd0ca829e3ec49b38e95c48d0a09989e55481e4b4caa1d04fc8ccf620";
      provider(
        vi
          .fn()
          .mockReturnValueOnce(ok([]))
          .mockReturnValueOnce(ok([])),
        vi.fn(() => ok(bytes(STRAY))),
      );

      await expect(readPersonhoodRingKey(network, "people")).rejects.toThrow(
        /not the personhood product/,
      );
    });

    it("throws when the host refuses to register", async () => {
      provider(
        () => ok([]),
        vi.fn(() => err({ tag: "NotConnected" })),
      );

      await expect(readPersonhoodRingKey(network, "people")).rejects.toThrow(
        /refused to register/,
      );
    });
  });

  it("under another label, a missing key stays null and nothing is registered", async () => {
    // A PR preview is opened as `peopl-preview-pr<N>.testnet`; registering
    // from there would mint a stray under that name. It may read, not mint.
    const registerRingVrfKey = vi.fn();
    provider(() => ok([]), registerRingVrfKey);

    expect(await readPersonhoodRingKey(network, "people")).toBeNull();
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });
});

describe("readDeclaredRingKey", () => {
  beforeEach(() => {
    vi.mocked(getAccountsProvider).mockReset();
    env.productLabel = "peopl";
  });

  it("finds the key the host already declared for the ring", async () => {
    provider(() =>
      ok([registered(DEVICEHOOD_KEY, ringIdentifier("people-lite"))]),
    );

    expect(await readDeclaredRingKey(network, "people-lite")).toEqual({
      kind: "found",
      key: DEVICEHOOD_KEY,
    });
  });

  it("answers not-declared and never registers, even for the personhood product", async () => {
    // The regression this whole slice exists to prevent: a read-only check
    // must never mint a key. `readPersonhoodRingKey` would register here —
    // this must not, on the exact same host state.
    const registerRingVrfKey = vi.fn();
    provider(() => ok([]), registerRingVrfKey);

    expect(await readDeclaredRingKey(network, "people-lite")).toEqual({
      kind: "not-declared",
    });
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("answers not-declared when the host holds a key, only for another ring", async () => {
    const registerRingVrfKey = vi.fn();
    provider(
      () => ok([registered(MEMBERSHIP_KEY, ringIdentifier("people"))]),
      registerRingVrfKey,
    );

    expect(await readDeclaredRingKey(network, "people-lite")).toEqual({
      kind: "not-declared",
    });
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("answers no-registry when the host has no ring-VRF registry, and never registers", async () => {
    // The native iOS host: `Unsupported` on every RFC-0024 call.
    const registerRingVrfKey = vi.fn();
    provider(() => err({ tag: "Unsupported" }), registerRingVrfKey);

    expect(await readDeclaredRingKey(network, "people-lite")).toEqual({
      kind: "no-registry",
    });
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });

  it("answers no-registry with no host at all", async () => {
    vi.mocked(getAccountsProvider).mockResolvedValue(null as never);
    expect(await readDeclaredRingKey(network, "people-lite")).toEqual({
      kind: "no-registry",
    });
  });

  it("throws when the host refuses to list keys", async () => {
    // We are the product these keys belong to, so a refusal is a fault.
    provider(() => err({ tag: "NotConnected" }));

    await expect(readDeclaredRingKey(network, "people-lite")).rejects.toThrow(
      PersonhoodRingKeyError,
    );
  });

  it("throws when the host answers without the public key", async () => {
    provider(() =>
      ok([
        {
          ...registered(DEVICEHOOD_KEY, ringIdentifier("people-lite")),
          publicKey: undefined,
        },
      ]),
    );

    await expect(readDeclaredRingKey(network, "people-lite")).rejects.toThrow(
      /disclosed no public key/,
    );
  });
});

describe("registerPersonhoodRingKey", () => {
  it("never registers, and answers not-personhood-product, off the personhood product", async () => {
    // A PR preview must not mint under its own label; the check is the same
    // gate `readPersonhoodRingKey` applies before its own self-heal.
    const registerRingVrfKey = vi.fn();
    env.productLabel = "peopl-preview-pr98";

    const result = await registerPersonhoodRingKey(
      { listRingVrfKeys: vi.fn(), registerRingVrfKey } as never,
      network,
      "people-lite",
    );

    expect(result).toEqual({ kind: "not-personhood-product" });
    expect(registerRingVrfKey).not.toHaveBeenCalled();
  });

  describe("when this deploy is the personhood product", () => {
    beforeEach(() => {
      env.productLabel = "peopl";
    });

    it("registers the ring's key and returns it, at RFC-0022's pinned index", async () => {
      const registerRingVrfKey = vi.fn(() => ok(bytes(DEVICEHOOD_KEY)));
      // `registerOurKey` lists exactly once, after minting, for its
      // ownership check — there is no pre-mint list to consume first.
      const listRingVrfKeys = vi
        .fn()
        .mockReturnValue(
          ok([registered(DEVICEHOOD_KEY, ringIdentifier("people-lite"))]),
        );

      const result = await registerPersonhoodRingKey(
        { listRingVrfKeys, registerRingVrfKey } as never,
        network,
        "people-lite",
      );

      expect(result).toEqual({ kind: "registered", key: DEVICEHOOD_KEY });
      // Index 1 is the lite (Devicehood) key by RFC-0022 — the same mapping
      // `registerOurKey` already applies, never duplicated here.
      expect(registerRingVrfKey).toHaveBeenCalledWith(1, expect.anything());
    });

    it("answers refused, with the host's own message, instead of throwing", async () => {
      const result = await registerPersonhoodRingKey(
        {
          listRingVrfKeys: () => ok([]),
          registerRingVrfKey: () => err({ tag: "NotConnected" }),
        } as never,
        network,
        "people-lite",
      );

      expect(result).toEqual({
        kind: "refused",
        detail: expect.stringMatching(/refused to register/),
      });
    });

    it("answers refused when the minted key is not listed under our product", async () => {
      // Same misconfigured-host case `registerOurKey` already guards: a host
      // session started under another `--product-id` mints a key valid for
      // that product's rings, never ours.
      const STRAY =
        "0x3016fbbdd0ca829e3ec49b38e95c48d0a09989e55481e4b4caa1d04fc8ccf620";

      const result = await registerPersonhoodRingKey(
        {
          listRingVrfKeys: vi.fn().mockReturnValue(ok([])),
          registerRingVrfKey: vi.fn(() => ok(bytes(STRAY))),
        } as never,
        network,
        "people-lite",
      );

      expect(result).toEqual({
        kind: "refused",
        detail: expect.stringMatching(/not the personhood product/),
      });
    });
  });
});
