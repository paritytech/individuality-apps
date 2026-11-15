// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  decodeAbsenceGracePolicy,
  toPersonhoodParticipant,
} from "@humanity/shared/chain/individuality.ts";
import {
  deriveHumanityCardState,
  type HumanityCardParticipant,
  type HumanityCardSnapshot,
  type HumanityCardState,
} from "@humanity/shared/card/humanity-card-state.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import { type HexString } from "@humanity/shared/chain/host-api.ts";
import type { PersonhoodRingKeyLookup } from "@humanity/shared/identity/personhood-ring-key.ts";
import {
  readRingStandingForKey,
  type PersonRingStanding,
  type ReadOptions,
  type RingMembershipChain,
} from "@humanity/shared/chain/ring-membership.ts";

/**
 * Re-exported for the callers that decoded the policy here before the SDK
 * owned it. The SDK's decoder also enforces the runtime's own invariants
 * (`window <= 8`, `allowedMisses < window`), so a byte order swapped by a
 * metadata change fails loudly instead of silently disabling Caution for
 * everyone.
 */
export { decodeAbsenceGracePolicy };
export type { AbsenceGracePolicy } from "@humanity/shared/chain/individuality.ts";

/** The raw `Score.Participants` value exactly as papi decodes it. */
export interface RawStreak {
  type: string;
  value: number;
}

/** The raw `Score.Participants` recognition value exactly as papi decodes it. */
export interface RawRecognition {
  type: string;
  value: bigint | undefined;
}

/** The raw PAPI-shaped participant; every field is treated as untrusted.
 *  Wider than the SDK's `RawParticipant`, which drops the three fields its
 *  derivation has no use for. */
export interface RawParticipant {
  score: number;
  streak: RawStreak;
  attendance_history: number;
  credit: bigint;
  cashed_out: boolean;
  reached_personhood: boolean;
  has_ever_reached_personhood: boolean;
  recognition: RawRecognition;
  last_attended_game?: number | undefined;
}

/**
 * Maps a raw PAPI participant to the frontend-shaped
 * `HumanityCardParticipant`.
 *
 * The SDK's `toPersonhoodParticipant` does the decoding — including rejecting
 * a streak or recognition variant a runtime upgrade added, which must fail
 * loudly rather than map to something plausible. `has_ever_reached_personhood`
 * is added on top: the SDK drops it, and the debug panel reports it.
 */
export function toHumanityCardParticipant(
  raw: RawParticipant,
): HumanityCardParticipant {
  return {
    ...toPersonhoodParticipant(raw),
    hasEverReachedPersonhood: raw.has_ever_reached_personhood,
  };
}

/** The raw `PeopleLite.LitePeople` value exactly as papi decodes it. */
export interface RawLitePerson {
  ring_vrf_key: string;
  method: { type: string; value?: string };
}

/**
 * How the runtime recognised this person's Devicehood.
 *
 * Devicehood names the *state*, not the proof that reached it: a registration
 * fee gets there with no device attestation at all, which is why this is a
 * union and not a boolean. The runtime has a third method (`Voucher`) written
 * but commented out, so an unknown variant must fail loudly rather than pick
 * one of these.
 */
export type DevicehoodMethod =
  | { kind: "unique-device"; attester: string }
  | { kind: "fee" };

/** A person's Devicehood, as `PeopleLite.LitePeople` records it. */
export interface Devicehood {
  /** The key `Members.Members(<people-lite>, key)` is keyed by, and the only
   *  de facto proof of Devicehood. Written in the same call as the ring's
   *  `add_members`, so this record's presence and ring membership agree. */
  ringVrfKey: string;
  method: DevicehoodMethod;
}

/**
 * Decodes the lite-person record the SDK deliberately reads as `unknown`
 * ("presence is the signal"), which throws away both of its fields.
 *
 * We want both: the method, because whether a person proved a device or paid
 * a fee is the only thing on chain that says how they got here; and the key,
 * because it is the one input a Devicehood ring-position read takes.
 */
export function toDevicehood(raw: RawLitePerson): Devicehood {
  return {
    ringVrfKey: raw.ring_vrf_key,
    method: devicehoodMethod(raw.method),
  };
}

function devicehoodMethod(raw: RawLitePerson["method"]): DevicehoodMethod {
  switch (raw.type) {
    case "UniqueDevice":
      if (raw.value == null) {
        // The variant carries the attester account; without it the record is
        // not the shape the metadata promises.
        throw new Error("unique-device recognition without an attester");
      }
      return { kind: "unique-device", attester: raw.value };
    case "Fee":
      return { kind: "fee" };
    default:
      // Same policy as streak and recognition: a variant added by a runtime
      // upgrade fails with a fixed message that echoes no chain data.
      throw new Error("unknown recognition method variant");
  }
}

/**
 * Where the *chain-recorded* Devicehood key stands with the lite ring.
 *
 * The key is the one `PeopleLite.LitePeople` holds, never one the host
 * derives for us: only an attested key is ever enrolled in the lite ring, and
 * `PeopleLite.attest` is a call the SPA cannot make. A key we derive ourselves
 * therefore answers about a key no ring can contain, which reads exactly like
 * "not a member" and is why this probe takes the record's key and nothing else.
 *
 * The three arms are kept apart because collapsing them is the ambiguity that
 * cost this investigation days: "the ring has no entry for this key" is a fact
 * about the chain, while "there was no key to ask about" and "the ask failed"
 * are facts about us, and only the first says anything about membership.
 */
export type DevicehoodRingProbe =
  /** `Members.Members` answered for the record's key. `standing.position`
   *  being `null` is the ring's own "no entry", and is answered, not unknown. */
  | {
      readonly kind: "placed";
      readonly ringVrfKey: string;
      readonly standing: PersonRingStanding;
    }
  /** No `PeopleLite.LitePeople` record, so there was no key to place and no
   *  read was issued. Says nothing about the ring. */
  | { readonly kind: "no-record" }
  /** The read threw. A diagnostic outcome, never a negative answer. */
  | {
      readonly kind: "failed";
      readonly ringVrfKey: string;
      readonly error: string;
    };

/**
 * Place the Devicehood key in the lite ring, on the block the card already
 * pinned — same `options`, so the standing and the record it came from agree.
 *
 * Never throws: a probe that cannot run is a diagnostic outcome, not a
 * failure the card read has to handle (the convention `resources-alias.ts`
 * states). The card is worth rendering either way, and a failed read must
 * never reach the panel wearing the ring's own "no entry".
 *
 * Takes the raw record rather than a decoded `Devicehood`: the key is the
 * only field a ring read consumes, and `toDevicehood` rejects an unknown
 * recognition method — a judgement about the *method* that has no business
 * suppressing the ring standing.
 */
export async function probeDevicehoodRing(
  chain: RingMembershipChain,
  litePerson: RawLitePerson | null,
  options: ReadOptions,
): Promise<DevicehoodRingProbe> {
  if (litePerson == null) return { kind: "no-record" };
  const ringVrfKey = litePerson.ring_vrf_key;
  try {
    return {
      kind: "placed",
      ringVrfKey,
      standing: await readRingStandingForKey(
        chain,
        ringVrfKey,
        "people-lite",
        options,
      ),
    };
  } catch (error: unknown) {
    return { kind: "failed", ringVrfKey, error: describeError(error) };
  }
}

/**
 * Whether this host holds the lite member key the chain attested for the
 * person — the precondition for any proof-authorized lite bind.
 *
 * `mismatch` and `no-host-key` are both permanent for this device: neither
 * key the host could ever declare for the lite ring is the one
 * `PeopleLite.attest` enrolled, and no retry changes that. `unknown` is the
 * opposite kind of fact — nothing could be asked or answered — and must
 * never be read as either verdict; see `readDeclaredRingKey`.
 */
export type DeviceKeyCheck =
  | { readonly kind: "matches"; readonly key: HexString }
  | { readonly kind: "mismatch"; readonly hostKey: HexString; readonly chainKey: HexString }
  | { readonly kind: "no-host-key"; readonly owner: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Compare the host's own declared lite key against the chain's record of it.
 *
 * Pure and host-free on purpose, so the mismatch this exists to catch is
 * testable without a host: the caller resolves `hostKey` with
 * `readDeclaredRingKey` (never `readPersonhoodRingKey`, which registers) and
 * hands the outcome here alongside the `PeopleLite.LitePeople` record the
 * card read already decoded.
 *
 * `null` when there is no record: nothing was attested for this person, so
 * there is no chain key to hold a host key against, and the question does
 * not apply yet. Compares hex case-insensitively, as the two never agree on
 * casing between the host and the chain codec.
 */
export function toDeviceKeyCheck(
  hostKey: PersonhoodRingKeyLookup,
  owner: string,
  litePerson: RawLitePerson | null,
): DeviceKeyCheck | null {
  if (litePerson == null) return null;
  const chainKey = litePerson.ring_vrf_key as HexString;
  switch (hostKey.kind) {
    case "no-registry":
      return {
        kind: "unknown",
        reason: "the host has no ring-VRF key registry to check against",
      };
    case "not-declared":
      return { kind: "no-host-key", owner };
    case "found":
      return chainKey.toLowerCase() === hostKey.key.toLowerCase()
        ? { kind: "matches", key: hostKey.key }
        : { kind: "mismatch", hostKey: hostKey.key, chainKey };
  }
}

/** The identities a card resolves for. Plain serializable on purpose: the
 *  values go straight into react-query keys. */
export interface PlayerIdentities {
  /** SS58-42 RFC-0022 candidate account the weekly game is played on
   *  (`dim2.<tld>` at the configured `GAME_ACCOUNT_INDEX`), never the DotNS
   *  username owner. Registration, the seat verdict and the seat bind all key
   *  off it. */
  accountAddress: string;
}

/** The resolved chain reads that feed the pure card-result assembly. */
export interface HumanityCardReadInputs {
  /** Host name, superseded by its owner's finalized linked full name when present. */
  primaryUsername: string;
  /** SS58-42 account that owns the DotNS username, or `null` when the name is
   *  not registered on chain. Display only: an unregistered name says nothing
   *  about personhood, so it no longer stops the card from resolving. */
  ownerAccount: string | null;
  /** SS58-42 RFC-0022 candidate account (`dim2.<tld>` at the configured
   *  `GAME_ACCOUNT_INDEX`). */
  gameAccount: string;
  /** The raw `Score.Participants` value for whoever signed up: the record under
   *  `Account(game account)` on our road, or `Person(alias)` for a person who
   *  took `Game.sign_up_with_alias`. `null` when neither key holds one. */
  rawParticipant: RawParticipant | null;
  participantKey?: "account" | "person" | null;
  /** The `PeopleLite.LitePeople` value; presence marks a lite person, and the
   *  record itself says how they reached Devicehood. `null` also when there
   *  was no owner account to read it for. */
  litePerson: RawLitePerson | null;
  /** True when the host DotNS label carried no lite `.<digits>` suffix, or the
   *  owner has a finalized linked full name — either way the account upgraded
   *  to a full person and must never render as lite. Feeds the username-claim
   *  flow and the debug panel; the state derivation does not read it. */
  isUpgradedIdentity: boolean;
  /** `Score.PersonhoodThreshold`. */
  personhoodThreshold: number;
  /** Serialized `Score.AbsenceGraceRatio` (`0x` + four hex digits). */
  absenceGraceRatio: string;
  /** Where this person's key stands with the Membership ring, when the chain
   *  can say — `null` when there was no ring key from the host and no account
   *  of theirs is bound to a personal id. See `ring-membership.ts`. */
  membershipStanding: PersonRingStanding | null;
  /** Where the chain-recorded Devicehood key stands with the *lite* ring —
   *  `null` when nothing asked (the mock backend, a debug override, a card
   *  restored from storage), which is not the same as an unplaced key. */
  devicehoodRing: DevicehoodRingProbe | null;
  /** Whether the host's own declared lite key matches the one the chain
   *  attested for this person — `null` when nothing asked (same callers as
   *  `devicehoodRing`), which is not the same as an unanswerable check. */
  deviceKeyCheck: DeviceKeyCheck | null;
}

/** The assembled card arm of `HumanityCardResult`. */
export interface ResolvedHumanityCard {
  kind: "card";
  /** Absent on older cached snapshots; recovery hints must not assume account eligibility. */
  participantKey?: "account" | "person" | null;
  /** Host name, superseded by its owner's finalized linked full name when present. */
  primaryUsername: string;
  /** The account the card shows — the username owner when the name is
   *  registered on chain, else the candidate account. */
  accountAddress: string;
  /** The username owner alone, or null when the name is not registered on
   *  chain: what the code on the card's back says, since it is the account
   *  the Polkadot app's scanner resolves to a person. */
  ownerAccount: string | null;
  /** The resolved participant, null for lite/not-enrolled accounts. */
  participant: HumanityCardParticipant | null;
  /** The person's Devicehood record, null when the chain has none. Carried
   *  next to `snapshot` rather than inside it: the state is not derived from
   *  how Devicehood was reached, only from whether it was. */
  devicehood: Devicehood | null;
  /** The person's Membership-ring standing, null when unanswerable. Kept on
   *  the result as well as the snapshot: the snapshot carries only the ring
   *  *position* the state derives from, while the panel wants the personal id
   *  and key that produced it. */
  membershipStanding: PersonRingStanding | null;
  /** The lite-ring standing of the key on the Devicehood record. A separate
   *  fact from `membershipStanding`, which is a different key in a different
   *  ring: a lite person is normally included here and absent there, and the
   *  panel could not show that while only one of the two was ever read. */
  devicehoodRing: DevicehoodRingProbe | null;
  /** Whether this device can prove for this person on the lite ring — the
   *  precondition a seat bind needs before it should ever be offered. */
  deviceKeyCheck: DeviceKeyCheck | null;
  state: HumanityCardState;
  /** The account the weekly game is read and seated on. */
  playerIdentities: PlayerIdentities;
  /** The exact input `state` was derived from. Carried so a reader can tell
   *  WHY a card is in its state — the threshold and grace policy are
   *  otherwise only visible on the states that happen to quote them. */
  snapshot: HumanityCardSnapshot;
}

/**
 * Pure assembly of the card result from the resolved reads.
 */
export function toHumanityCardResult(
  reads: HumanityCardReadInputs,
): ResolvedHumanityCard {
  const {
    primaryUsername,
    ownerAccount,
    gameAccount,
    rawParticipant,
    litePerson,
    isUpgradedIdentity,
    personhoodThreshold,
    absenceGraceRatio,
    membershipStanding,
    devicehoodRing,
    deviceKeyCheck,
  } = reads;
  const participant =
    rawParticipant == null ? null : toHumanityCardParticipant(rawParticipant);
  const devicehood = litePerson == null ? null : toDevicehood(litePerson);
  const snapshot: HumanityCardSnapshot = {
    isLitePerson: litePerson != null,
    isUpgradedIdentity,
    participant,
    personhoodThreshold,
    policy: decodeAbsenceGracePolicy(absenceGraceRatio),
    membershipRing: membershipStanding?.position ?? null,
    devicehoodRing:
      devicehoodRing?.kind === "placed" ? devicehoodRing.standing.position : null,
  };
  return {
    kind: "card",
    participantKey: reads.participantKey ?? (rawParticipant == null ? null : "account"),
    primaryUsername,
    // An unregistered DotNS name leaves the candidate account as the only
    // one we hold, and the card is about the person, not about the name.
    accountAddress: ownerAccount ?? gameAccount,
    ownerAccount,
    participant,
    devicehood,
    membershipStanding,
    devicehoodRing,
    deviceKeyCheck,
    state: deriveHumanityCardState(snapshot),
    playerIdentities: { accountAddress: gameAccount },
    snapshot,
  };
}
