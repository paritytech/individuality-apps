// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { Binary, Enum } from "polkadot-api";

import {
  readAtFinalized,
  type SnapshotAt,
} from "@humanity/shared/chain/finalized-snapshot.ts";
import { usernameSigningContext } from "@humanity/shared/chain/username-signing-context.ts";
import { getPeopleClient, type PeopleApi } from "@humanity/shared/chain/client.ts";
import { tracedRead } from "@humanity/shared/chain/chain-read.ts";
import {
  probeDevicehoodRing,
  toDeviceKeyCheck,
  toHumanityCardResult,
  type RawParticipant,
  type DeviceKeyCheck,
  type RawLitePerson,
  type ResolvedHumanityCard,
} from "@humanity/shared/card/humanity-card-data.ts";
import {
  readRingStanding,
  readRingStandingForKey,
  type PersonRingStanding,
  type ReadOptions,
} from "@humanity/shared/chain/ring-membership.ts";
import type { HexString } from "@humanity/shared/chain/host-api.ts";
import {
  readDeclaredRingKey,
  readPersonhoodRingKey,
} from "@humanity/shared/identity/personhood-ring-key.ts";
import { personhoodProductId } from "@humanity/shared/identity/product-domain.ts";
import { GAME_ACCOUNT_INDEX } from "@humanity/shared/identity/game-account.ts";
import type { HumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";
import { describeError } from "@humanity/shared/chain/error-detail.ts";
import {
  resolveNetwork,
  type NetworkConfig,
} from "@humanity/shared/chain/networks.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { linkedCardIdentity } from "@humanity/shared/card/linked-card-identity.ts";

const logger = loggerFor("card", "humanity-card");

export type AccountUnavailable = {
  kind: "account-unavailable";
  primaryUsername?: string;
  accountAddress?: string;
  candidateAccount?: null;
};

export type HumanityCardResult = AccountUnavailable | ResolvedHumanityCard;

export interface HumanityCardReadArgs {
  identity: HumanityUserId;
  /** The candidate account at the configured `GAME_ACCOUNT_INDEX`. */
  gameAccount: string | null;
  signal: AbortSignal;
}

/** A ring-VRF key the host holds for us, `null` when it holds none. */
type RingKey = HexString | null;

/**
 * Where this person's Membership key stands with the `people` ring.
 *
 * The key-first read answers on its own. The account walk is the fallback,
 * for runs with no host and for a host that has never been told this
 * person's Membership key: it depends on a `set_personal_id_account` most
 * people never send, which is why it is second. Two accounts are worth
 * trying — the candidate account is what the binding names in practice, and
 * the username owner is the other account we hold, when the name is
 * registered at all.
 */
async function readMembershipStanding(
  api: PeopleApi,
  ringKey: RingKey,
  gameAccount: string,
  ownerAccount: string | null,
  at: ReadOptions,
): Promise<PersonRingStanding | null> {
  if (ringKey != null)
    return tracedRead("ring.standing", () =>
      readRingStandingForKey(api, ringKey, "people", at),
    );
  const fromGameAccount = await tracedRead("ring.standing", () =>
    readRingStanding(api, gameAccount, "people", at),
  );
  if (fromGameAccount != null) return fromGameAccount;
  return ownerAccount == null
    ? null
    : tracedRead("ring.standing", () =>
        readRingStanding(api, ownerAccount, "people", at),
      );
}

/**
 * Where this person's Devicehood key stands with the `people-lite` ring.
 *
 * Same shape as Membership, with a narrower fallback: the lite ring's keys
 * hang off `PeopleLite.LitePeople`, so the owner account reaches the key
 * directly and no personal-id binding is involved. Without a key and without
 * a registered name the question is unanswerable, which is `null`.
 */

/**
 * The score pallet keys a participant by whichever identity signed up:
 * `Game.sign_up_with_account_lite_invite` — our road — writes
 * `Account(game account)`, while `Game.sign_up_with_alias`, the road a person
 * who already holds a full key takes, writes `Person(alias)` through
 * `Score::onboard_externally_recognized`. That alias is the person's
 * contextual alias in `Score.score_context()`, and `People.AccountToAlias` is
 * the only bridge from an account we hold to it.
 *
 * A binding under any other context — Resources, airdrops — is a different
 * alias and can never be the Person key, so it is skipped rather than looked
 * up. Lite people are not read: `sign_up_with_lite_invite` also lands on an
 * `Account` key, and `ensure_person` never accepts a lite alias.
 *
 * Returns the first record found across the given bindings, or `null`.
 */
async function readAliasKeyedParticipant(
  api: PeopleApi,
  bindings: ReadonlyArray<
    { ca: { context: string; alias: string } } | undefined
  >,
  at: ReadOptions,
): Promise<RawParticipant | null> {
  const scoreContext = (
    await tracedRead("Score.score_context", () => api.constants.Score.score_context())
  ).toLowerCase();
  for (const binding of bindings) {
    if (binding == null) continue;
    if (binding.ca.context.toLowerCase() !== scoreContext) {
      logger.debug(
        "alias binding is not in the score context; context={context} alias={alias}",
        { context: binding.ca.context, alias: binding.ca.alias },
      );
      continue;
    }
    const participant = await tracedRead("Score.Participants", () =>
      api.query.Score.Participants.getValue(Enum("Person", binding.ca.alias), at),
    );
    if (participant != null) return participant;
  }
  return null;
}

/**
 * Whether this device can ever complete a lite bind for this person: the
 * host's own declared lite key held against the chain's attested key.
 *
 * Never throws. `readDeclaredRingKey` still can, on the same host faults
 * every other ring-VRF read does — but a diagnostic that cannot answer must
 * not look like an answer, so a refusal here becomes `unknown` rather than
 * failing the whole card read.
 */
async function resolveDeviceKeyCheck(
  network: NetworkConfig,
  litePerson: RawLitePerson | null,
): Promise<DeviceKeyCheck | null> {
  if (litePerson == null) return null;
  try {
    const hostKey = await readDeclaredRingKey(network, "people-lite");
    return toDeviceKeyCheck(hostKey, personhoodProductId(network), litePerson);
  } catch (error) {
    return { kind: "unknown", reason: describeError(error) };
  }
}

/** One finalized read of the person's card. Throws on chain/host failure; the caller bounds it (`runBoundedChainRead`). */
export async function readHumanityCard({
  identity,
  gameAccount,
  signal,
}: HumanityCardReadArgs): Promise<HumanityCardResult> {
  const { client, api } = await getPeopleClient();
  signal.throwIfAborted();
  // The DotNS username only names the card. An unregistered name has
  // no owner account on chain, which costs the card its display
  // address and the two reads keyed by an account — never its state.
  const usernameOwner = (at: SnapshotAt): Promise<string | undefined> =>
    tracedRead("Resources.UsernameOwnerOf", () =>
      api.query.Resources.UsernameOwnerOf.getValue(
        Binary.fromText(identity.username),
        at,
      ),
    );

  if (gameAccount == null) {
    const owner = await readAtFinalized(client, signal, usernameOwner);
    return {
      kind: "account-unavailable",
      primaryUsername: identity.primaryUsername,
      accountAddress: owner ?? undefined,
      candidateAccount: null,
    };
  }

  // Host reads before pinning: they do not depend on the block, and
  // every millisecond spent after pinning risks the pin lapsing.
  const network = resolveNetwork(envConfig.chain.network);
  const [membershipKey, devicehoodKey] = await Promise.all([
    readPersonhoodRingKey(network, "people"),
    readPersonhoodRingKey(network, "people-lite"),
  ]);
  signal.throwIfAborted();
  return readAtFinalized(client, signal, async (at) => {
    // What the card is, the rings say. Membership is inclusion of this
    // person's key #0 in the `people` ring; Devicehood is inclusion of
    // key #1 in `people-lite`. The score is one road into the
    // Membership ring and not the fact itself, so a person recognised
    // by any other method (the sudo faucet today, further DIMs later)
    // reads as a Member all the same, and the score only says how a
    // Member is attending. Attendance itself lives under whichever key
    // the person signed up with — see `readAliasKeyedParticipant`.
    //
    // Both rings are asked about the person's *own* key first.
    // `Members.Members` is keyed by the ring-VRF key, so with a key in
    // hand a ring is one point read and needs nothing else on chain.
    // The host gives us the keys because we are the product they
    // belong to, and it throws rather than shrugging if it refuses.
    const [
      ownerAccount,
      accountParticipant,
      gameAccountAlias,
      personhoodThreshold,
      absenceGraceRatio,
      signingContext,
    ] = await Promise.all([
      usernameOwner(at),
      tracedRead("Score.Participants", () =>
        api.query.Score.Participants.getValue(Enum("Account", gameAccount), at),
      ),
      tracedRead("People.AccountToAlias", () =>
        api.query.People.AccountToAlias.getValue(gameAccount, at),
      ),
      tracedRead("Score.PersonhoodThreshold", () =>
        api.query.Score.PersonhoodThreshold.getValue(at),
      ),
      tracedRead("Score.AbsenceGraceRatio", () =>
        api.query.Score.AbsenceGraceRatio.getValue(at),
      ),
      usernameSigningContext(client, at),
    ]);
    signal.throwIfAborted();

    // The lite record, linked full name, owner alias and account-fallback
    // ring reads all key off the owner account, so they wait for it.
    const owner = ownerAccount ?? null;
    // The lite record is the only input the devicehood probe and the device
    // key check need, so both chain off it here rather than wait for the
    // whole wave and the alias fallback: one fewer generation on the read.
    const litePersonRead =
      owner == null
        ? Promise.resolve(null)
        : tracedRead("PeopleLite.LitePeople", () =>
            api.query.PeopleLite.LitePeople.getValue(owner, at),
          );
    const devicehoodRingRead = litePersonRead.then((lite) =>
      tracedRead("devicehood.probe", () => probeDevicehoodRing(api, lite ?? null, at)),
    );
    const deviceKeyCheckRead = litePersonRead.then((lite) =>
      resolveDeviceKeyCheck(network, lite ?? null),
    );
    const [litePerson, consumer, ownerAlias, membershipStanding] =
      await Promise.all([
        litePersonRead,
        owner == null
          ? null
          : tracedRead("Resources.Consumers", () =>
              api.query.Resources.Consumers.getValue(owner, at),
            ),
        // The game account was already asked in the first batch.
        owner == null || owner === gameAccount
          ? undefined
          : tracedRead("People.AccountToAlias", () =>
              api.query.People.AccountToAlias.getValue(owner, at),
            ),
        readMembershipStanding(api, membershipKey, gameAccount, owner, at),
      ]);
    signal.throwIfAborted();

    // One person holds one record: the account key is our own road, and
    // only when it is empty is the alias key worth a further read. The
    // game account is the binding an app-made person would name; the
    // username owner is the other account we hold.
    const participant =
      accountParticipant ??
      (await readAliasKeyedParticipant(
        api,
        [gameAccountAlias, ownerAlias],
        at,
      ));
    signal.throwIfAborted();

    logger.debug(
      "resolved card identities; owner={owner} gameAccount={gameAccount} " +
        "gameAccountIndex={gameAccountIndex} " +
        "participantKey={participantKey} lastAttendedGame={lastAttendedGame} " +
        "hasMembershipKey={hasMembershipKey} hasDevicehoodKey={hasDevicehoodKey}",
      {
        owner,
        gameAccount,
        gameAccountIndex: GAME_ACCOUNT_INDEX,
        participantKey:
          participant == null
            ? "none"
            : accountParticipant != null
              ? "account"
              : "person",
        lastAttendedGame: participant?.last_attended_game ?? null,
        hasMembershipKey: membershipKey != null,
        hasDevicehoodKey: devicehoodKey != null,
      },
    );

    const cardIdentity = linkedCardIdentity(
      identity,
      consumer?.full_username,
    );
    const devicehoodRing = await devicehoodRingRead;
    // Coverage in the log as well as the panel: it is the figure that
    // separates a ring the chain is still building from a host refusing
    // to prove for a key the chain has fully enrolled, and a pasted log
    // should answer that without the panel.
    const placed =
      devicehoodRing.kind === "placed" ? devicehoodRing.standing : null;
    logger.debug(
      "placed the devicehood key in the lite ring; outcome={outcome} " +
        "key={key} position={position} coverage={coverage}",
      {
        outcome: devicehoodRing.kind,
        key:
          devicehoodRing.kind === "no-record"
            ? null
            : devicehoodRing.ringVrfKey,
        position:
          placed == null ? null : (placed.position?.kind ?? "no-entry"),
        coverage:
          placed?.ring == null
            ? null
            : `${placed.ring.includedKeys}/${placed.ring.totalKeys}`,
      },
    );

    // Whether this device can ever complete a lite bind for this
    // person: the host's own declared lite key held against the key
    // the chain attested. A pre-flight fact, not a proof outcome — the
    // sign-up's bind (the SDK's `bindGameSeat`, run by
    // `@individuality/sign-up`) asks the host for the key again right
    // before it binds. Same pinned block, no extra host
    // call beyond the one read-only key lookup, and never throws.
    const deviceKeyCheck = await deviceKeyCheckRead;
    logger.info(
      "checked the device's declared lite key against the chain's " +
        "attested key; outcome={outcome} hostKey={hostKey} chainKey={chainKey}",
      {
        outcome: deviceKeyCheck?.kind ?? "not-applicable",
        hostKey:
          deviceKeyCheck?.kind === "mismatch" ? deviceKeyCheck.hostKey : null,
        chainKey:
          deviceKeyCheck?.kind === "mismatch" ? deviceKeyCheck.chainKey : null,
      },
    );

    const card = toHumanityCardResult({
      primaryUsername: cardIdentity.primaryUsername,
      ownerAccount: owner,
      gameAccount,
      rawParticipant: participant ?? null,
      participantKey: participant == null ? null : accountParticipant != null ? "account" : "person",
      litePerson: litePerson ?? null,
      isUpgradedIdentity: cardIdentity.isUpgraded,
      personhoodThreshold,
      absenceGraceRatio,
      membershipStanding,
      devicehoodRing,
      deviceKeyCheck,
    });
    return { ...card, usernameUpgradeSupported: signingContext != null };
  });
}
