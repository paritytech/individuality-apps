// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Where a person's key stands with a ring — the chain's own answer to whether
 * they are a Member.
 *
 * Membership is ring inclusion and nothing else. The score is one road into
 * the Membership ring, not the road: `DummyDim.recognize_personhood` puts a
 * key there under sudo without ever touching `Score.Participants`, and every
 * further method (DIM1, DIM3) is expected to arrive the same way. So a card
 * that reads Membership off the score answers "how did you get here" when the
 * question is "are you here", and misses everyone who came another way.
 *
 * There are two ways in, and they differ in what they need to know.
 *
 * **By key** — one lookup, and the right one:
 *
 *   Members.Members(<ring>, ringVrfKey) → RingPosition
 *
 * The key comes from the host (see `personhood-ring-key.ts`), so this asks
 * the ring directly about the person's own key and needs nothing else.
 *
 * **By account** — three lookups, and a binding nobody is obliged to make:
 *
 *   People.AccountToPersonalId[account] → PersonalId
 *     → People.People[id].key          → the ring-VRF key
 *     → Members.Members(<ring>, key)   → RingPosition
 *
 * A `PersonRecord` is written with `account: None` by both roads — `Score
 * .register` and the sudo faucet — so `AccountToPersonalId` holds an entry
 * only where someone additionally called `People.set_personal_id_account`. On
 * previewnet that was 3 of 8 people when this was written. `set_personal_id
 * _account` exists so a person can *act* as themselves in an extrinsic — the
 * ring-VRF key has no nonce and signing openly with it would defeat the ring
 * — and it was never meant as a membership index. Using it as one is why this
 * read came second. It stays as the fallback for runs with no host.
 *
 * Either way, a key the ring reports as `Included` gets one more group of
 * reads, on the caller's block:
 *
 *   Members.RingKeysStatus(<ring>, index) → { total, included }
 *   Members.Root(<ring>, index)           → { revision }
 *   Members.StaleRings(<ring>)            → the rings awaiting a rebuild
 *
 * because `Included` is a slot assignment and not a promise that a proof can
 * be made. A host refusing to prove for a key the chain has placed is either
 * reading a ring the chain has not finished building, or proving with a key
 * of its own; those three reads are what tells the two apart, and nothing in
 * `Members.Members` does.
 *
 * Chain-only and papi-shaped on purpose — no host, no React — because this is
 * the shape `@parity/product-sdk/individuality` would take it in. The SDK has
 * no equivalent today: `peopleRing`/`litePeopleRing` are pure location math,
 * and the one `Members` read it does own (`readLiteSignUpRequirement`) is
 * lite-only, opt-in, and types the value as `{ type: string }` — presence,
 * with the position thrown away.
 */
import type { TypedApi } from "polkadot-api";
import type { people } from "@polkadot-api/descriptors";

import { toHex, type HexString } from "@humanity/shared/chain/host-api.ts";
import { ringCollectionId } from "@parity/product-sdk/individuality";

type PeopleApi = TypedApi<typeof people>;

/**
 * papi's per-read options — the pinned block and abort signal. Taken from the
 * descriptors so the caller passes the same `{ at, signal }` it uses for every
 * other read on the card's pinned block.
 */
export type ReadOptions = Parameters<
  PeopleApi["query"]["People"]["AccountToPersonalId"]["getValue"]
>[1];

/** The 32-byte ring-VRF key type the descriptors use for a person's key. */
export type PersonKey = NonNullable<
  Awaited<ReturnType<PeopleApi["query"]["People"]["People"]["getValue"]>>
>["key"];

/** The two rings, in the collection names the runtime keys them under. */
export type RingName = "people" | "people-lite";

/**
 * A ring's 32-byte collection identifier, hex for the storage key.
 *
 * Network-independent: the identifiers are `pop:polkadot.network/people` and
 * `…/people-lite`, space-padded to 32 bytes, on every chain. Verified against
 * previewnet, whose `Members.Members` keys carry exactly these.
 */
export function ringIdentifier(ring: RingName): HexString {
  return toHex(ringCollectionId(ring));
}

/**
 * `Members.Members` — where a key stands with a ring.
 *
 * `Onboarding` is a real waiting room, not a failure: the key is queued and
 * the ring is rebuilt by an offchain worker, so a person can be recognised
 * and still unable to prove it. That gap is what Membership Ready names.
 *
 * `absent` is this module's own, and not a variant of the runtime's enum: the
 * ring has no entry for a key we *do* hold. It is an answer — "this person is
 * not in this ring" — and the card acts on it. Not knowing the key at all is
 * the other, unanswerable case, and it is a missing standing rather than a
 * position (see {@link readRingStanding}).
 *
 * `Included` is a *slot assignment* and nothing more — `ring_index` /
 * `ring_page` / `ring_position` say where the runtime filed the key, not that
 * the root a proof is checked against covers it. Whether it does is a
 * property of the ring, not of the key: see `RingBuildState`.
 */
export type RingPosition =
  | {
      readonly kind: "onboarding";
      /** Which `OnboardingQueue` page the key is parked on. */
      readonly queuePage: number;
      readonly queuedAtSeconds: number;
    }
  | {
      readonly kind: "included";
      readonly ringIndex: number;
      readonly ringPage: number;
      readonly ringPosition: number;
    }
  | { readonly kind: "suspended" }
  | { readonly kind: "absent" };

/**
 * The raw `Members.Members` value, taken from the descriptors rather than
 * spelled out: a metadata change that reshapes the enum then fails the build
 * here instead of silently falling through `toRingPosition`.
 */
export type RawRingPosition = NonNullable<
  Awaited<ReturnType<PeopleApi["query"]["Members"]["Members"]["getValue"]>>
>;

/**
 * Decode a ring position. Always answers: an empty storage entry is `absent`,
 * which is the ring saying it does not hold this key — not a failure to ask.
 */
export function toRingPosition(
  raw: RawRingPosition | undefined | null,
): RingPosition {
  if (raw == null) return { kind: "absent" };
  switch (raw.type) {
    case "Onboarding":
      return {
        kind: "onboarding",
        queuePage: raw.value.queue_page,
        queuedAtSeconds: Number(raw.value.queued_at),
      };
    case "Included":
      return {
        kind: "included",
        ringIndex: raw.value.ring_index,
        ringPage: raw.value.ring_page,
        ringPosition: raw.value.ring_position,
      };
    case "Suspended":
      return { kind: "suspended" };
  }
}

/**
 * How far along the ring holding a key actually is — the half of membership
 * `Members.Members` does not answer.
 *
 * A key can be `Included` while the ring's root does not cover it, and the
 * two failures that look identical from the app read differently here:
 *
 * - `includedKeys < totalKeys`, or the ring in `Members.StaleRings`: the
 *   chain has not finished building. Slots are assigned, the root is behind,
 *   and a proof for the key legitimately cannot be produced yet. Transient.
 * - full coverage, not stale, a root revision present: the chain is done, so
 *   a host that still refuses to prove is refusing for a reason of its own —
 *   a different registered key, or a stale ring snapshot on its side.
 *
 * Distinguishing those took three agents and a hand-driven chain walk once.
 */
export interface RingBuildState {
  /** The ring the key was assigned to, repeated here so a row can stand alone. */
  readonly ringIndex: number;
  /** `RingKeysStatus.total` — keys assigned to the ring, built or not. */
  readonly totalKeys: number;
  /** `RingKeysStatus.included` — of those, how many the root covers. */
  readonly includedKeys: number;
  /** `RingKeysStatus.immutable_since`, once the ring is sealed. */
  readonly immutableSinceSeconds: number | null;
  /** `Root.revision`, the build counter a proof is tagged with. `null` when
   *  the ring has no root at all, which is a ring never yet built. */
  readonly rootRevision: number | null;
  /** Present in `Members.StaleRings`: queued for a rebuild, so the current
   *  root is known-behind rather than merely suspected. */
  readonly stale: boolean;
}

/** Which of the two reads placed the key. Reported, not inferred: a card that
 *  answered from the account binding answered about a *bound* person, and that
 *  is a narrower claim than answering from the person's own key. */
export type RingStandingSource = "personhood-key" | "account-binding";

/** Where a person's key stands with a ring, and how that was established. */
export interface PersonRingStanding {
  readonly source: RingStandingSource;
  /** Only the account walk learns this; the key-first read never needs it. */
  readonly personalId: bigint | null;
  /** The person's ring-VRF key. */
  readonly ringVrfKey: PersonKey;
  /** Where the key stands. Always present: a ring with no entry for it is
   *  `absent`, which is an answer. A standing that could not be established
   *  at all is a missing standing, not a missing position. */
  readonly position: RingPosition;
  /** The standing of the ring the key was assigned to — `null` unless
   *  `position` is `included`, because no other case names a ring. */
  readonly ring: RingBuildState | null;
}

/**
 * Every read either path needs, and nothing else — each `getValue` taken
 * straight off the generated descriptors, so a stub in a test satisfies the
 * real signatures and a metadata change breaks the build rather than the app.
 */
export interface RingMembershipChain {
  readonly query: {
    readonly People: {
      readonly AccountToPersonalId: {
        getValue: PeopleApi["query"]["People"]["AccountToPersonalId"]["getValue"];
      };
      readonly People: {
        getValue: PeopleApi["query"]["People"]["People"]["getValue"];
      };
    };
    readonly Members: {
      readonly Members: {
        getValue: PeopleApi["query"]["Members"]["Members"]["getValue"];
      };
      readonly RingKeysStatus: {
        getValue: PeopleApi["query"]["Members"]["RingKeysStatus"]["getValue"];
      };
      readonly Root: {
        getValue: PeopleApi["query"]["Members"]["Root"]["getValue"];
      };
      /** Read as entries, not by key: `StaleRings` is a set, so its value is
       *  `null` either way and only the presence of the key carries the fact.
       *  Scoped to one collection, which the chain keeps small — previewnet
       *  holds none at all in the steady state. */
      readonly StaleRings: {
        getEntries: PeopleApi["query"]["Members"]["StaleRings"]["getEntries"];
      };
    };
    readonly PeopleLite: {
      readonly LitePeople: {
        getValue: PeopleApi["query"]["PeopleLite"]["LitePeople"]["getValue"];
      };
    };
  };
}

/**
 * Read the standing of the ring a key was assigned to, on the block the
 * caller already pinned.
 *
 * Only for `included`: no other position names a ring, and skipping it keeps
 * the common cases — no entry, unanswerable — at exactly the reads they had.
 * For `included` it costs three reads, issued together, all at the same
 * `options` as the `Members.Members` read they explain. The runtime has no
 * single storage item carrying coverage and revision, so there is nothing to
 * fold them into.
 */
async function readRingBuildState(
  chain: RingMembershipChain,
  ring: RingName,
  position: RingPosition,
  options: ReadOptions,
): Promise<RingBuildState | null> {
  if (position.kind !== "included") return null;
  const collection = ringIdentifier(ring);
  const { ringIndex } = position;
  const [status, root, staleRings] = await Promise.all([
    chain.query.Members.RingKeysStatus.getValue(collection, ringIndex, options),
    chain.query.Members.Root.getValue(collection, ringIndex, options),
    chain.query.Members.StaleRings.getEntries(collection, options),
  ]);
  return {
    ringIndex,
    totalKeys: status.total,
    includedKeys: status.included,
    immutableSinceSeconds:
      status.immutable_since == null ? null : Number(status.immutable_since),
    rootRevision: root?.revision ?? null,
    stale: staleRings.some(({ keyArgs }) => keyArgs[1] === ringIndex),
  };
}

/**
 * Place a key the host handed us, straight from `Members.Members`.
 *
 * Always answers: a key the ring has never held is a standing whose position
 * is `absent`, which is "not in this ring" and not "cannot say".
 */
export async function readRingStandingForKey(
  chain: RingMembershipChain,
  ringVrfKey: PersonKey,
  ring: RingName,
  options: ReadOptions,
): Promise<PersonRingStanding> {
  const raw = await chain.query.Members.Members.getValue(
    ringIdentifier(ring),
    ringVrfKey,
    options,
  );
  const position = toRingPosition(raw);
  return {
    source: "personhood-key",
    personalId: null,
    ringVrfKey,
    position,
    ring: await readRingBuildState(chain, ring, position, options),
  };
}

/**
 * Place `account`'s key in `ring`, or `null` when the chain cannot say.
 *
 * `null` means the question is unanswerable from an account alone — no
 * personal id bound, or no person record behind it — and never "not a
 * member". A key the ring has never held is a `PersonRingStanding` whose
 * position is `absent`, which is a different and answerable fact.
 */
export async function readRingStanding(
  chain: RingMembershipChain,
  account: string,
  ring: RingName,
  options: ReadOptions,
): Promise<PersonRingStanding | null> {
  const personalId = await chain.query.People.AccountToPersonalId.getValue(
    account,
    options,
  );
  if (personalId == null) return null;

  const record = await chain.query.People.People.getValue(personalId, options);
  if (record == null) return null;

  const ringVrfKey = record.key;
  const raw = await chain.query.Members.Members.getValue(
    ringIdentifier(ring),
    ringVrfKey,
    options,
  );
  const position = toRingPosition(raw);
  return {
    source: "account-binding",
    personalId,
    ringVrfKey,
    position,
    ring: await readRingBuildState(chain, ring, position, options),
  };
}

/**
 * Place `account`'s **Devicehood** key in the lite ring, or `null` when the
 * chain cannot say.
 *
 * The lite ring has a shortcut the full ring does not: `PeopleLite.LitePeople`
 * is keyed by account and carries the ring-VRF key it registered, written in
 * the same call as the ring's `add_members`. So one read gets the key and no
 * `set_personal_id_account` binding is needed — this is the account-shaped
 * road to the Devicehood ring, and the only one when the host has no lite key
 * to hand over.
 *
 * `null` is "no lite record for this account", which leaves the ring question
 * unasked rather than answered: a person whose key *is* known and simply not
 * in the ring comes back as `absent`. `personalId` stays `null` because this
 * road never learns one.
 */
export async function readLiteRingStandingForAccount(
  chain: RingMembershipChain,
  account: string,
  options: ReadOptions,
): Promise<PersonRingStanding | null> {
  const litePerson = await chain.query.PeopleLite.LitePeople.getValue(
    account,
    options,
  );
  if (litePerson == null) return null;

  const ringVrfKey = litePerson.ring_vrf_key;
  const raw = await chain.query.Members.Members.getValue(
    ringIdentifier("people-lite"),
    ringVrfKey,
    options,
  );
  const position = toRingPosition(raw);
  return {
    source: "account-binding",
    personalId: null,
    ringVrfKey,
    position,
    ring: await readRingBuildState(chain, "people-lite", position, options),
  };
}
