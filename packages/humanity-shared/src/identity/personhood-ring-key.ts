// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The person's own ring-VRF public key, from the host.
 *
 * Membership is ring inclusion, and `Members.Members` is keyed by the key —
 * so the key is the only thing needed to ask the ring about a person. Every
 * other route to it goes through chain state that nobody is obliged to write:
 * `People.AccountToPersonalId` needs a `set_personal_id_account` the person
 * had no reason to send, and both roads into the ring write `account: None`.
 *
 * The keys are declared under {@link personhoodProductId} — `peopl.<tld>`,
 * this network's personhood product, which is what this app is opened as.
 * That makes them *our own* keys to the host: listing needs no consent,
 * registering mints exactly them, and signing is accepted. A refusal is
 * therefore a fault, not a state — see {@link PersonhoodRingKeyError}.
 *
 * Why the network suffix and not the literal `peopl.dot`: every host derives
 * and enrols people under `peopl.<tld>` — the iOS app always did, and current
 * truapi hosts do too — so on a test network the `peopl.dot` key
 * is a person nobody is. See `product-domain.ts` for the measurement.
 */
import {
  getAccountsProvider,
  toHex,
  type AccountsProvider,
  type HexString,
  type RegisteredRingVrfKey,
  type RingLocation,
} from "@humanity/shared/chain/host-api.ts";
import {
  isPersonhoodProduct,
  personhoodProductId,
} from "@humanity/shared/identity/product-domain.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";

import {
  devicehoodRingLocation,
  membershipRingLocation,
} from "@humanity/shared/chain/individuality.ts";
import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";
import { ringIdentifier, type RingName } from "@humanity/shared/chain/ring-membership.ts";

const logger = loggerFor("identity", "personhood-ring-key");

/** The host failed to answer for a key it holds on our behalf. */
export class PersonhoodRingKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PersonhoodRingKeyError";
  }
}

function ringLocation(network: NetworkConfig, ring: RingName): RingLocation {
  return ring === "people"
    ? membershipRingLocation(network)
    : devicehoodRingLocation(network);
}

/**
 * Match a registered key to a ring by its collection identifier.
 *
 * Deliberately *not* a deep compare of the whole {@link RingLocation}. Live
 * hosts declare the same ring with different junction lists — an identity
 * created by an older CLI registered `[CollectionId]` while this
 * app builds `[PalletInstance, CollectionId]` — and the collection id is the
 * part that names the ring. The chain id is checked because a host can hold
 * keys for more than one chain.
 */
export function declaresRing(
  key: RegisteredRingVrfKey,
  expected: RingLocation,
  collectionId: HexString,
): boolean {
  const wanted = collectionId.toLowerCase();
  return key.rings.some(
    (location) =>
      location.chainId.toLowerCase() === expected.chainId.toLowerCase() &&
      location.junctions.some(
        (junction) =>
          junction.tag === "CollectionId" &&
          junction.value.toLowerCase() === wanted,
      ),
  );
}

/**
 * RFC-0022 fixes which index is which person key: `//peopl.<tld>//index_bytes(0)`
 * is the full person key (Membership), `index_bytes(1)` the light one
 * (Devicehood). The host derives from the index; the ring is only declared.
 */
const PERSONHOOD_KEY_INDEX: Record<RingName, number> = {
  people: 0,
  "people-lite": 1,
};

/**
 * The host answered `Unsupported`: it has no RFC-0024 key registry at all.
 *
 * That is the native iOS host (the Swift TrUAPI, not the Rust core): its
 * container maps `account_list_ring_vrf_keys`, `account_register_ring_vrf_key`
 * and `account_ring_vrf_sign` to an unsupported slot, and picks the person key
 * itself by ring inside `create_proof` / `get_alias`. Not a refusal of *our*
 * key — there is nothing to refuse — so it is a state, not a fault: the card
 * falls back to the account walk, as it did before the key read existed.
 */
export function isUnsupportedByHost(error: unknown): boolean {
  if (typeof error !== "object" || error == null) return false;
  const tagged = error as { tag?: unknown; value?: unknown };
  if (tagged.tag === "Unsupported") return true;
  return isUnsupportedByHost(tagged.value);
}

const UNSUPPORTED = Symbol("host has no ring-VRF registry");

async function listOurKeys(
  provider: AccountsProvider,
  owner: string,
): Promise<RegisteredRingVrfKey[] | typeof UNSUPPORTED> {
  return provider.listRingVrfKeys(owner, "PublicKey").match(
    (value) => value,
    (error) => {
      if (isUnsupportedByHost(error)) return UNSUPPORTED;
      throw new PersonhoodRingKeyError(
        `host refused the ${owner} ring-VRF keys`,
        { cause: error },
      );
    },
  );
}

function keyFor(
  keys: RegisteredRingVrfKey[],
  network: NetworkConfig,
  ring: RingName,
): RegisteredRingVrfKey | undefined {
  const expected = ringLocation(network, ring);
  return keys.find((key) => declaresRing(key, expected, ringIdentifier(ring)));
}

/**
 * Bring our own key for `ring` into existence in the host's registry.
 *
 * RFC-0024: the entropy lets a host *derive* any index, but only registration
 * makes a key exist — it is what `listRingVrfKeys` answers with and what the
 * proof and signing calls resolve. The personhood product is the one meant to
 * register these two, and nothing else does: the wallet derives keys for its
 * own allowance proofs and never registers them, so a fresh wallet answers
 * `[]` until we call this. Host-local and idempotent, no chain write.
 *
 * `registerRingVrfKey` has no owner parameter — it mints under the *calling*
 * product. The calling product is this deploy's name, which is
 * {@link personhoodProductId} exactly when the deploy label is `peopl`
 * ({@link isPersonhoodProduct}); a preview under another label is not, and must not mint. The
 * check after the fact is against a misconfigured host session: the minted
 * key must show up under the owner we list, or the host is not running us as
 * the personhood product (a dev host started under another `--product-id`).
 */
async function registerOurKey(
  provider: AccountsProvider,
  network: NetworkConfig,
  ring: RingName,
): Promise<HexString> {
  const owner = personhoodProductId(network);
  const index = PERSONHOOD_KEY_INDEX[ring];
  const minted = await provider
    .registerRingVrfKey(index, ringLocation(network, ring))
    .match(
      (value) => toHex(value),
      (error) => {
        throw new PersonhoodRingKeyError(
          `host refused to register our ${ring} key (index ${index})`,
          { cause: error },
        );
      },
    );
  const keys = await listOurKeys(provider, owner);
  const listed =
    keys === UNSUPPORTED ? undefined : keyFor(keys, network, ring);
  const owned =
    listed?.publicKey != null && toHex(listed.publicKey) === minted;
  if (!owned) {
    throw new PersonhoodRingKeyError(
      `registered a ${ring} key the host does not list under ${owner}; ` +
        `this host session is not the personhood product (run the dev host as ${owner})`,
    );
  }
  logger.info("registered our {ring} key (index {index}) with the host", {
    ring,
    index,
  });
  return minted;
}

/**
 * The outcome of {@link registerPersonhoodRingKey}: a minted key, the
 * product label's gate closing the door, or a host refusal — never a thrown
 * {@link PersonhoodRingKeyError}, so a caller that already has its own
 * explanation for "nothing to prove with" never has to parse this error's
 * message to decide whether to use it.
 */
export type LiteRingKeyRegistration =
  | { readonly kind: "registered"; readonly key: HexString }
  | { readonly kind: "not-personhood-product" }
  | { readonly kind: "refused"; readonly detail: string };

/**
 * Register our own key for `ring` on this host, for a caller that already
 * knows the host holds no handle for it and wants to recover in place.
 *
 * Applies the same {@link isPersonhoodProduct} gate
 * {@link readPersonhoodRingKey} applies before its own Membership-ring
 * self-heal, and otherwise defers entirely to {@link registerOurKey} — the
 * same {@link PERSONHOOD_KEY_INDEX} mapping and post-mint ownership check,
 * never duplicated here. `not-personhood-product` mirrors
 * {@link readPersonhoodRingKey}'s treatment of the gate: a state, not a
 * fault. A host refusal or a stray-key ownership mismatch — both raised by
 * {@link registerOurKey} as {@link PersonhoodRingKeyError} — comes back as
 * `refused` with that error's message, rather than escaping as a throw, so
 * a caller can fold it into its own explanation instead of surfacing it
 * verbatim.
 */
export async function registerPersonhoodRingKey(
  provider: AccountsProvider,
  network: NetworkConfig,
  ring: RingName,
): Promise<LiteRingKeyRegistration> {
  if (!isPersonhoodProduct()) return { kind: "not-personhood-product" };
  try {
    const key = await registerOurKey(provider, network, ring);
    return { kind: "registered", key };
  } catch (error) {
    if (error instanceof PersonhoodRingKeyError) {
      return { kind: "refused", detail: error.message };
    }
    throw error;
  }
}

/**
 * The person's ring-VRF public key for `ring`, or `null` when there is none.
 *
 * `null` has three causes and all are legitimate: no host at all (a plain
 * WebSocket build); a host with no key registry to ask (the native iOS
 * host, see {@link isUnsupportedByHost}); or a host holding no key declared
 * for this ring — a real state, since the key that reaches the ring can be
 * put there by a method that never told this host about it. When this deploy is the
 * personhood product the second case is closed by registering the key
 * ourselves, see {@link registerOurKey}.
 *
 * Throws {@link PersonhoodRingKeyError} when the host is present but refuses,
 * or answers without the public key it says it discloses to owners. Those are
 * faults: we are the product these keys belong to.
 */
export async function readPersonhoodRingKey(
  network: NetworkConfig,
  ring: RingName,
): Promise<HexString | null> {
  const provider = await getAccountsProvider();
  if (provider == null) {
    logger.debug("no accounts provider; ring key unavailable");
    return null;
  }

  const keys = await listOurKeys(provider, personhoodProductId(network));
  if (keys === UNSUPPORTED) {
    logger.info(
      "host has no ring-VRF key registry; reading the {ring} ring by account instead",
      { ring },
    );
    return null;
  }
  const match = keyFor(keys, network, ring);
  if (match == null) {
    if (isPersonhoodProduct()) {
      return registerOurKey(provider, network, ring);
    }
    logger.debug(
      "host holds no key declared for the {ring} ring ({count} registered)",
      { ring, count: keys.length },
    );
    return null;
  }
  if (match.publicKey == null) {
    throw new PersonhoodRingKeyError(
      `host disclosed no public key for our own ${ring} key`,
    );
  }
  return toHex(match.publicKey);
}

/**
 * The outcome of asking the host to *declare* its own key for a ring,
 * without ever bringing one into existence.
 *
 * `no-registry` and `not-declared` are kept apart deliberately, the same way
 * a probe keeps a diagnostic apart from a negative answer: `no-registry`
 * says nothing about this device's key for the ring — the host could not be
 * asked at all (no accounts provider, or {@link isUnsupportedByHost}) —
 * while `not-declared` is an actual answer, this host was asked and holds no
 * key declared for the ring. Only `not-declared` licenses a caller to
 * conclude anything about the device.
 */
export type PersonhoodRingKeyLookup =
  | { readonly kind: "found"; readonly key: HexString }
  | { readonly kind: "no-registry" }
  | { readonly kind: "not-declared" };

/**
 * The host's own key declared for `ring`, read-only: never registers one.
 *
 * {@link readPersonhoodRingKey} registers a key when the host declares none,
 * because for the Membership ring that recovery is exactly what the
 * personhood product exists to run. That is never safe here: a key derived
 * on the spot belongs to no ring until `PeopleLite.attest` enrols it, and the
 * SPA never calls `attest` — only the phone does. Registering here would mint
 * a key destined to place nowhere and read as "not a member" forever; commit
 * 8aee3f4 removed exactly that self-registration after it produced a key
 * (`peopl.testnet` index 1) that appeared in zero of the chain's ring
 * entries. This lookup exists to *check* a device's key against the chain's
 * record, a question registering an answer would corrupt.
 *
 * Throws {@link PersonhoodRingKeyError} on the same host faults
 * {@link readPersonhoodRingKey} does: this deploy owns these keys, so a
 * refusal or a disclosure-less answer is a fault, not a state.
 */
export async function readDeclaredRingKey(
  network: NetworkConfig,
  ring: RingName,
): Promise<PersonhoodRingKeyLookup> {
  const provider = await getAccountsProvider();
  if (provider == null) {
    logger.debug("no accounts provider; ring key unavailable");
    return { kind: "no-registry" };
  }

  const keys = await listOurKeys(provider, personhoodProductId(network));
  if (keys === UNSUPPORTED) {
    logger.info(
      "host has no ring-VRF key registry; nothing declared for the {ring} ring",
      { ring },
    );
    return { kind: "no-registry" };
  }
  const match = keyFor(keys, network, ring);
  if (match == null) {
    logger.debug(
      "host holds no key declared for the {ring} ring ({count} registered)",
      { ring, count: keys.length },
    );
    return { kind: "not-declared" };
  }
  if (match.publicKey == null) {
    throw new PersonhoodRingKeyError(
      `host disclosed no public key for our own ${ring} key`,
    );
  }
  return { kind: "found", key: toHex(match.publicKey) };
}
