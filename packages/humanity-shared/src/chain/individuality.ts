// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Single facade over `@parity/product-sdk/individuality`, mirroring
 * `host-api.ts`. One import point keeps the SDK surface we depend on visible
 * and swappable while the package is still pre-1.0.
 *
 * The SDK is byte-level throughout — contexts and collection ids come back as
 * `Uint8Array` — while the host's wire types and our chain reads are hex, so
 * the adapters below convert at this boundary and nowhere else.
 */
import {
  PERSONHOOD_CONTEXT_INDEX,
  litePeopleRing,
  peopleRing,
  personhoodContext as personhoodContextBytes,
  productContext as productContextBytes,
  type ContextSuffix,
  type PersonhoodContextName,
} from "@parity/product-sdk/individuality";

import { toHex, type RingLocation } from "@humanity/shared/chain/host-api.ts";

import type { NetworkConfig } from "./networks.ts";

export {
  GameRegistrationError,
  IndividualityDecodeError,
  ProductIndividualityError,
  decodeAbsenceGracePolicy,
  derivePersonhoodState,
  fromPapi,
  missesInWindow,
  parsePeopleAirdropsEventId,
  peopleAirdropsEventId,
  peopleAirdropsRegisterCalls,
  readCurrentGame,
  readPeopleAirdropsSigning,
  readPeopleAirdropsStanding,
  readLiteSignUpRequirement,
  readRegistrationEligibility,
  readScoreContext,
  readyToRegister,
  registerMessage,
  registerPersonhoodTx,
  registrationRetryDelay,
  toCurrentGame,
  toPersonhoodParticipant,
  withAsPerson,
  withLiteAlias,
  withScoreParticipant,
} from "@parity/product-sdk/individuality";
/** The sign-up's host half — the game account and its signer, the draw
 *  tickets and the personhood keys — built from `@parity/product-sdk-host`. */
export { hostGameRegistrationCapabilities } from "@parity/product-sdk/individuality/host";
export type {
  AbsenceGracePolicy,
  CurrentGame,
  FinalizedBlockSource,
  GamePhase,
  LiteSignUpBlocker,
  PersonhoodMetrics,
  PersonhoodParticipant,
  PersonhoodState,
  PeopleAirdropsSigning,
  PeopleAirdropsStanding,
  PlayerRegistration,
  RawGameInfo,
  RawParticipant,
  // Aliased once here: the app owns `CurrentGameResult` in `card/domain`.
  CurrentGameResult as SdkCurrentGameResult,
} from "@parity/product-sdk/individuality";

export { PERSONHOOD_CONTEXT_INDEX };
export type { PersonhoodContextName };

/**
 * The 32-byte proof context of `{ productId, suffix }` as hex — the value the
 * host must echo back as `contextualAlias.context`.
 *
 * @param productId the full DotNS id, TLD included. Never assemble it from a
 *   hardcoded TLD: {@link NetworkConfig.dotnsSuffix} owns that.
 */
export function productContext(
  productId: string,
  suffix: ContextSuffix,
): `0x${string}` {
  return toHex(productContextBytes(productId, suffix));
}

/**
 * The personhood product's ring VRF context for `name` on `network`, as hex.
 *
 * The suffix belongs to the network — see {@link NetworkConfig.dotnsSuffix} —
 * because the same context name on two networks is two different 32-byte
 * values. `Resources.register_person`
 * dispatches only when the signer's alias carries the `resources` context, and
 * that one is a plain `impl` fn rather than a published constant — so nothing
 * but this derivation would catch a change to it before a transaction fails as
 * a bad origin.
 */
export function personhoodContext(
  dotnsSuffix: NetworkConfig["dotnsSuffix"],
  name: PersonhoodContextName,
): `0x${string}` {
  return toHex(personhoodContextBytes(dotnsSuffix, name));
}

/**
 * The **full** people ring on this network's People chain, as the host
 * addresses it for `getProductAccountAlias` and `createRingVRFProof`.
 *
 * `set_alias_account` verifies membership against exactly this collection; the
 * Devicehood ring (`…/people-lite`, {@link devicehoodRingLocation}) is a
 * different ring and cannot satisfy it.
 */
export function membershipRingLocation(network: NetworkConfig): RingLocation {
  return peopleRing(network.peopleChain.genesisHash);
}

/** The lite-people ring — Devicehood — on this network's People chain. */
export function devicehoodRingLocation(network: NetworkConfig): RingLocation {
  return litePeopleRing(network.peopleChain.genesisHash);
}

/**
 * Bind a PAPI client and its typed People API into the shape the SDK's reads
 * and transaction builders take.
 *
 * Every SDK read pins one finalized block and takes it from the client rather
 * than the typed API, so the two travel together or a composed read can
 * silently straddle two blocks. `PolkadotClient.getFinalizedBlock` satisfies
 * the SDK's `FinalizedBlockSource` structurally — the SDK deliberately depends
 * on the shape, not on PAPI.
 */
export { fromPapi as individualityChain } from "@parity/product-sdk/individuality";
