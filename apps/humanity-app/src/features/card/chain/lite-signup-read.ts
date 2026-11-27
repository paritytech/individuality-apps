// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PeopleApi } from "@humanity/shared/chain/client.ts";
import {
  fromPapi,
  readLiteSignUpRequirement,
  type FinalizedBlockSource,
} from "@humanity/shared/chain/individuality.ts";
import type { NetworkConfig } from "@humanity/shared/chain/networks.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import type { LiteSignUpVerdict } from "@features/card/domain/lite-signup.ts";

const logger = loggerFor("card", "lite-signup-read");

export interface ReadLiteSignUpVerdictArgs {
  api: PeopleApi;
  /** Pin the same block the caller's other reads use, so one refresh cannot
   *  answer the schedule from one block and the seat verdict from another. */
  client: FinalizedBlockSource;
  network: NetworkConfig;
  /** The DIM2 candidate product account whose seat the game will use. */
  seatAccount: string;
  /** The optional RFC-0022 Devicehood key that makes the membership gate readable. */
  liteMemberKey?: Uint8Array;
  signal: AbortSignal;
}

/**
 * How the lite-ring membership gate was resolved.
 *
 * `blockers` alone distinguishes none of these: a gate that never ran and one
 * the key passed both leave `NotLiteMember` absent. That ambiguity is what let
 * the block offer to bind the seat while the host separately refused to mint
 * the proof, so the verdict names the case rather than leaving it inferred.
 */
type MembershipCheck = "unchecked" | "included" | "not-a-member";

/**
 * Read the lite sign-up gate without treating an unavailable chain answer as a
 * refusal. The SDK pins every storage access from its client, so callers that
 * already pinned related reads may pass a client pinned to that same snapshot.
 */
export async function readLiteSignUpVerdict({
  api,
  client,
  network,
  seatAccount,
  liteMemberKey,
  signal,
}: ReadLiteSignUpVerdictArgs): Promise<LiteSignUpVerdict | null> {
  const chain = fromPapi(client, api);
  const options = {
    account: seatAccount,
    tld: network.dotnsSuffix,
    signal,
    ...(liteMemberKey == null ? {} : { liteMemberKey }),
  };
  // Interpolated, not a field: only interpolated text reaches the debug
  // snapshot, and which case applied is the first thing a reader needs when
  // the verdict later says nothing about membership.
  logger.info(
    "lite sign-up read for {seatAccount}: membership gate {membershipGate}",
    {
      seatAccount,
      membershipGate:
        liteMemberKey == null
          ? "unchecked (no lite member key in state; the host is the first to see a non-member)"
          : "checked (lite member key forwarded to Members.Members)",
    },
  );

  // A read whose signal fired was cancelled, not failed: a foreground refresh
  // restarts the query in flight (`humanity-action-session.tsx`), an unmount
  // drops it, and a missed deadline already rejects the bounded read around
  // this one. Its answer is discarded either way, so it stays out of Sentry.
  const failed = (message: string, error: unknown) => {
    if (signal.aborted) logger.debug("lite sign-up requirement read cancelled");
    else logger.error(message, { error });
    return null;
  };
  let requirement;
  try {
    const result = await readLiteSignUpRequirement(chain, options);
    if (!result.ok) {
      return failed("lite sign-up requirement read failed. error={error}", result.error);
    }
    requirement = result.value;
  } catch (error) {
    return failed("lite sign-up requirement read threw. error={error}", error);
  }

  const { blockers } = requirement;
  const invited = blockers.find(
    (blocker) => blocker.tag === "AnotherAccountInvited",
  );
  const verdict: LiteSignUpVerdict = {
    canSignUp: requirement.canSignUp,
    needsBind:
      blockers.length > 0 &&
      blockers.every((blocker) => blocker.tag === "AliasNotBound"),
    blockers,
    invitedAccount:
      invited?.tag === "AnotherAccountInvited" ? invited.invited : null,
  };

  const membership: MembershipCheck =
    liteMemberKey == null
      ? "unchecked"
      : blockers.some((blocker) => blocker.tag === "NotLiteMember")
        ? "not-a-member"
        : "included";
  logger.info(
    "seat verdict for {seatAccount} under tld={tld}: canSignUp={canSignUp} needsBind={needsBind} membership={membership} blockers={blockers}",
    {
      seatAccount,
      tld: network.dotnsSuffix,
      canSignUp: verdict.canSignUp,
      needsBind: verdict.needsBind,
      membership,
      blockers: blockers.map((blocker) => blocker.tag).join(",") || "none",
    },
  );
  return verdict;
}
