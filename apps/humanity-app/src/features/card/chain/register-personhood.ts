// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Full-personhood registration: `Score.register(Some((memberKey, proof)))`.
 *
 * The last step from a score that reached the threshold to a member of the
 * people ring. Older iOS wallets sent this themselves; now the personhood
 * product does,
 * which is the only party a host lets mint and sign with the full person key.
 *
 * Three parties, kept apart on purpose:
 * - the CANDIDATE game account (`resolveGameAccount`) is the origin: the
 *   pallet reads `Score.Participants[Account(signer)]` and nothing else, so it
 *   signs, rides the fee-free `ScoreAsParticipant` extension, and is the
 *   account the proof of ownership names;
 * - our own `people` ring-VRF key (index 0, `peopl.<tld>`) is the member key;
 * - `registerMessage(candidate)` — 50 raw bytes — is what that key signs.
 *
 * Every way this stops is a typed outcome: a host that cannot do ring-VRF
 * (the native iOS host answers `Unsupported`) is a state the home explains,
 * not an error string anybody parses.
 */
import type { PeopleApi } from "@humanity/shared/chain/client.ts";
import type { PolkadotClient } from "polkadot-api";

import {
  getAccountsProvider,
  toHex,
  type AccountsProvider,
  type RegisteredRingVrfKey,
} from "@humanity/shared/chain/host-api.ts";
import {
  individualityChain,
  membershipRingLocation,
  readRegistrationEligibility,
  registerMessage,
  registerPersonhoodTx,
  withScoreParticipant,
} from "@humanity/shared/chain/individuality.ts";
import { describeError, hostError } from "@humanity/shared/chain/error-detail.ts";
import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";
import { ringIdentifier } from "@humanity/shared/chain/ring-membership.ts";
import {
  submissionDetail,
  TransactionSubmissionError,
  watchTransactionSubmission,
} from "@humanity/shared/chain/transaction-submission.ts";
import type { GameAccount } from "@humanity/shared/identity/game-account.ts";
import {
  declaresRing,
  isUnsupportedByHost,
  registerPersonhoodRingKey,
} from "@humanity/shared/identity/personhood-ring-key.ts";
import {
  isPersonhoodProduct,
  personhoodProductId,
} from "@humanity/shared/identity/product-domain.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";

const logger = loggerFor("card", "register-personhood");

/** Per host registry call; a dropped call must not hang the button. */
const HOST_TIMEOUT_MS = 10_000;
/** The signature may wait on the person approving it in the wallet. */
const SIGN_TIMEOUT_MS = 60_000;
const SIGNING_TIMEOUT_MS = 60_000;
const FINALITY_TIMEOUT_MS = 120_000;
const MEMBER_KEY_BYTES = 32;
const PROOF_BYTES = 64;

/** Plain copy for each stop; the technical cause travels as `detail`. */
const REGISTER_FAILURE_MESSAGE =
  "We couldn't finish making you a member. Try again shortly.";
export const REGISTER_UNSUPPORTED_MESSAGE =
  "Your Polkadot app can't finish this yet. Update it and try again.";
export const REGISTER_REFUSED_MESSAGE =
  "Your Polkadot app didn't approve this. Try again when you're ready.";
const REGISTER_UNAVAILABLE_MESSAGE =
  "Finishing your membership isn't available from here.";
const FINALITY_FAILURE_MESSAGE =
  "We couldn't confirm your membership. Try again shortly.";

export interface RegisterPersonhoodArgs {
  api: PeopleApi;
  client: PolkadotClient;
  network: NetworkConfig;
  /** The candidate game account: origin, signer, and the account the proof
   *  of ownership names. Resolved by the caller, which keys its
   *  never-twice record by it. */
  candidate: GameAccount;
  /** Called with a short line as each stage starts, for a live readout
   *  (the debug panel). The same facts also go to the log. */
  onStage?: (stage: string) => void;
}

export type RegisterPersonhoodOutcome =
  /** Sent. `confirmed` is false when it was broadcast but finality was not
   *  seen in time: the card read decides, and nothing may send it again. */
  | { kind: "registered"; confirmed: boolean; txHash: string; candidate: string }
  /** Re-read before sending: the chain has nothing to register for this
   *  candidate (already recognised, suspended, or below the threshold). */
  | { kind: "not-ready"; detail: string }
  /** The host has no ring-VRF registry or signer (native iOS today). */
  | { kind: "unsupported-host"; reason: string; detail: string }
  /** This deploy is not `peopl` (a preview under another label): it must never mint the key. */
  | { kind: "not-personhood-product"; reason: string; detail: string }
  /** The host or the person declined a key, signature or transaction. */
  | { kind: "refused"; reason: string; detail: string }
  | { kind: "failed"; reason: string; detail: string };

type Stop = Exclude<RegisterPersonhoodOutcome, { kind: "registered" | "not-ready" }>;

function stop(kind: Stop["kind"], detail: string): Stop {
  const reason =
    kind === "unsupported-host"
      ? REGISTER_UNSUPPORTED_MESSAGE
      : kind === "not-personhood-product"
        ? REGISTER_UNAVAILABLE_MESSAGE
        : kind === "refused"
          ? REGISTER_REFUSED_MESSAGE
          : REGISTER_FAILURE_MESSAGE;
  // A deploy that is not the personhood product never may send this: worth
  // seeing in the panel, but not an error.
  if (kind === "not-personhood-product") {
    logger.warning("Score.register skipped ({kind}): {detail}", { kind, detail });
  } else {
    logger.error("Score.register stopped ({kind}): {detail}", { kind, detail });
  }
  return { kind, reason, detail };
}

type KeyListing =
  | { kind: "listed"; key: RegisteredRingVrfKey | undefined }
  | { kind: "unsupported"; detail: string }
  | { kind: "refused"; detail: string };

async function listPeopleKey(
  provider: AccountsProvider,
  network: NetworkConfig,
): Promise<KeyListing> {
  const owner = personhoodProductId(network);
  const ring = membershipRingLocation(network);
  return withTimeout(
    provider.listRingVrfKeys(owner, "PublicKey").match<KeyListing>(
      (keys) => {
        const key = keys.find((entry) => declaresRing(entry, ring, ringIdentifier("people")));
        logger.info(
          "stage list-key: {owner} holds {total} ring-VRF key(s), people key {found}",
          { owner, total: keys.length, found: key == null ? "absent" : "present" },
        );
        return { kind: "listed", key };
      },
      (error) =>
        isUnsupportedByHost(error)
          ? { kind: "unsupported", detail: `listRingVrfKeys: ${hostError(error)}` }
          : { kind: "refused", detail: `listRingVrfKeys: ${hostError(error)}` },
    ),
    HOST_TIMEOUT_MS,
    "the host never answered listRingVrfKeys",
  );
}

/**
 * Mint (or reuse) our full person key, sign the candidate's register message
 * with it, and send `Score.register` from the candidate account.
 */
export async function registerPersonhood({
  api,
  client,
  network,
  candidate,
  onStage,
}: RegisterPersonhoodArgs): Promise<RegisterPersonhoodOutcome> {
  if (!isPersonhoodProduct()) {
    return stop(
      "not-personhood-product",
      `this deploy is not ${personhoodProductId(network)}; it may not mint the full person key`,
    );
  }
  try {
    const provider = await getAccountsProvider();
    if (provider == null) {
      return stop("unsupported-host", "no host accounts provider");
    }

    onStage?.(`candidate ${candidate.address}`);
    logger.info("stage candidate: registering {candidate}", {
      candidate: candidate.address,
    });

    // Asked every time, not trusted from the card: the card may be a cached
    // read, and a registration that already landed must never be re-sent.
    onStage?.("eligibility: reading Score.Participants");
    const chain = individualityChain(client, api);
    const eligibility = await readRegistrationEligibility(chain, {
      registrant: { tag: "Account", accountAddress: candidate.address },
    });
    if (!eligibility.ok) {
      return stop("failed", `eligibility read failed: ${describeError(eligibility.error)}`);
    }
    if (!eligibility.value.readyToRegister) {
      const participant = eligibility.value.participant;
      const detail =
        participant == null
          ? `Score has no participant ${candidate.address}`
          : `participant ${candidate.address} is not ready to register ` +
            `(threshold ${eligibility.value.personhoodThreshold})`;
      logger.info("stage eligibility: nothing to send; {detail}", { detail });
      return { kind: "not-ready", detail };
    }
    logger.info("stage eligibility: ready to register at threshold {threshold}", {
      threshold: eligibility.value.personhoodThreshold,
    });

    onStage?.("list-key: listing the people ring-VRF key");
    let listing = await listPeopleKey(provider, network);
    if (listing.kind === "unsupported") return stop("unsupported-host", listing.detail);
    if (listing.kind === "refused") return stop("refused", listing.detail);
    if (listing.key == null) {
      onStage?.("register-key: minting the people key (index 0)");
      const minted = await withTimeout(
        registerPersonhoodRingKey(provider, network, "people"),
        HOST_TIMEOUT_MS,
        "the host did not register the people key in time",
      );
      logger.info("stage register-key: {outcome}", {
        outcome:
          minted.kind === "registered"
            ? `registered ${minted.key}`
            : minted.kind === "refused"
              ? `refused: ${minted.detail}`
              : "skipped: not the personhood product",
      });
      if (minted.kind === "not-personhood-product") {
        return stop("not-personhood-product", "registerPersonhoodRingKey gate closed");
      }
      if (minted.kind === "refused") return stop("refused", minted.detail);
      listing = await listPeopleKey(provider, network);
      if (listing.kind === "unsupported") return stop("unsupported-host", listing.detail);
      if (listing.kind === "refused") return stop("refused", listing.detail);
    }
    const key = listing.key;
    if (key == null) {
      return stop("failed", "registered the people key but the host still lists none for the ring");
    }
    if (key.publicKey == null || key.publicKey.length !== MEMBER_KEY_BYTES) {
      return stop(
        "failed",
        `host disclosed ${key.publicKey?.length ?? "no"} public-key bytes for the people key`,
      );
    }
    const memberKey = key.publicKey;

    const message = registerMessage(candidate.address);
    onStage?.("sign: ringVrfSign over registerMessage(candidate)");
    logger.info("stage sign: ringVrfSign over {bytes} message bytes for {candidate}", {
      bytes: message.length,
      candidate: candidate.address,
    });
    type Signed =
      | { kind: "signed"; signature: Uint8Array }
      | { kind: "unsupported"; detail: string }
      | { kind: "refused"; detail: string };
    const signed = await withTimeout(
      provider.ringVrfSign(key.handle, message).match<Signed>(
        (signature) => ({ kind: "signed", signature }),
        (error) =>
          isUnsupportedByHost(error)
            ? { kind: "unsupported", detail: `ringVrfSign: ${hostError(error)}` }
            : { kind: "refused", detail: `ringVrfSign: ${hostError(error)}` },
      ),
      SIGN_TIMEOUT_MS,
      "the host never answered ringVrfSign",
    );
    if (signed.kind === "unsupported") return stop("unsupported-host", signed.detail);
    if (signed.kind === "refused") return stop("refused", signed.detail);
    if (signed.signature.length !== PROOF_BYTES) {
      return stop(
        "failed",
        `ringVrfSign returned ${signed.signature.length} bytes, expected ${PROOF_BYTES}`,
      );
    }

    const tx = registerPersonhoodTx(chain, {
      memberKey,
      proofOfOwnership: signed.signature,
    });
    onStage?.("submit: signing and sending Score.register");
    logger.info(
      "stage submit: Score.register from {candidate} with member key {memberKey}",
      { candidate: candidate.address, memberKey: toHex(memberKey) },
    );
    const submission = await watchTransactionSubmission(
      tx,
      withScoreParticipant(candidate.signer),
      {},
      {
        signingTimeoutMs: SIGNING_TIMEOUT_MS,
        finalityTimeoutMs: FINALITY_TIMEOUT_MS,
        signingFailureMessage: REGISTER_REFUSED_MESSAGE,
        finalityFailureMessage: FINALITY_FAILURE_MESSAGE,
        onBroadcast: (txHash) => {
          onStage?.(`broadcast ${txHash}; waiting for finality`);
          logger.info("stage broadcast: {txHash}", { txHash });
        },
      },
    );
    if (submission.status === "unknown") {
      logger.warning("stage settle: unconfirmed {txHash}: {detail}", {
        txHash: submission.txHash,
        detail: submission.detail,
      });
      return {
        kind: "registered",
        confirmed: false,
        txHash: submission.txHash,
        candidate: candidate.address,
      };
    }
    logger.info("stage settle: finalized {txHash}", { txHash: submission.txHash });
    return {
      kind: "registered",
      confirmed: true,
      txHash: submission.txHash,
      candidate: candidate.address,
    };
  } catch (error) {
    if (error instanceof TransactionSubmissionError) {
      return stop(error.code === "signing" ? "refused" : "failed", error.detail);
    }
    return stop("failed", submissionDetail(error) || describeError(error));
  }
}
