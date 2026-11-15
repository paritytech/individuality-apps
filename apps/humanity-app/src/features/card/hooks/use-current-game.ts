// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useQuery } from "@tanstack/react-query";
import { Enum } from "polkadot-api";


import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import { fromPapi, readCurrentGame } from "@humanity/shared/chain/individuality.ts";
import { fromHex } from "@humanity/shared/chain/host-api.ts";
import type { QueryView } from "@shared/chain/query-view.ts";
import type { QueryTimestamps } from "@shared/session/foreground-session.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { readLiteSignUpVerdict } from "@features/card/chain/lite-signup-read.ts";
import { toCurrentGameResult } from "@features/card/chain/current-game-data.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import type { PlayerIdentities } from "@humanity/shared/card/humanity-card-data.ts";


const logger = loggerFor("card", "current-game");

/** `players` also takes the alias key, which a recognized person is keyed by
 *  too, but reading it would change what "registered" answers.
 *
 *  `liteMemberKey` is the person's Devicehood ring-VRF key, already resolved by
 *  the card read (`PeopleLite.LitePeople.ring_vrf_key`) — passing it costs no
 *  extra round trip and turns the SDK's opt-in `Members.Members` check on, so
 *  a non-member reads as `NotLiteMember` here instead of surfacing as a host
 *  refusal halfway through the bind. `0x`-prefixed hex as the record carries
 *  it; `null` when the chain has no Devicehood record for this person, in
 *  which case the check stays ours and is skipped. */
function readGameForCard(
  identities: PlayerIdentities,
  liteMemberKey: string | null,
  signal: AbortSignal,
): Promise<CurrentGameResult> {
  return runBoundedChainRead(
    signal,
    async (childSignal): Promise<CurrentGameResult> => {
      const { client, api, network } = await getPeopleClient();
      childSignal.throwIfAborted();

      const at = await client.getFinalizedBlock();
      // Every read here is a finalized one, so "best" is pinned to the same block.
      const pinned = { getFinalizedBlock: async () => at, getBestBlocks: async () => [at] };

      const [read, registeredAtBest, liteSignUp] = await Promise.all([
        readCurrentGame(fromPapi(pinned, api), {
          signal: childSignal,
          players: [{ tag: "Account", accountAddress: identities.accountAddress }],
        }),
        // DIM2 confirms a sign-up at the best block, and the finalized read
        // trails it by a few blocks (more on paseo). Without this a person
        // back from registering would be offered Register again.
        registeredAtBestBlock(api, identities.accountAddress),
        readLiteSignUpVerdict({
          api,
          client: pinned,
          network,
          seatAccount: identities.accountAddress,
          // The SDK keys `Members.Members` from the 32 bytes, not the hex.
          ...(liteMemberKey == null
            ? {}
            : { liteMemberKey: fromHex(liteMemberKey) }),
          signal: childSignal,
        }),
      ]);
      if (!read.ok) {
        throw read.error;
      }
      const game =
        registeredAtBest &&
        read.value.tag === "Running" &&
        read.value.registration.tag === "NotRegistered"
          ? { ...read.value, registration: { tag: "Registered" as const } }
          : read.value;

      const result = toCurrentGameResult(
        game,
        Math.floor(Date.now() / 1000),
        liteSignUp,
      );
      logger.info(
        "resolved current game; index={resultIndex} kind={kind} at=#{blockNumber} registered={registered} seatVerdict={seatVerdict}",
        {
          resultIndex: result.gameIndex,
          kind: result.kind,
          blockNumber: read.value.at.blockNumber,
          registered: result.kind === "game" ? result.registered : "n/a",
          seatVerdict:
            liteSignUp == null
              ? "unknown"
              : `canSignUp=${liteSignUp.canSignUp} needsBind=${liteSignUp.needsBind}`,
        },
      );
      return result;
    },
  );
}

/** Whether the best block already holds the account's sign-up. Only ever
 *  adds a registration the finalized read has not caught up with: a failed
 *  read answers false and leaves the finalized answer standing. */
async function registeredAtBestBlock(
  api: Awaited<ReturnType<typeof getPeopleClient>>["api"],
  accountAddress: string,
): Promise<boolean> {
  try {
    const player = await api.query.Game.Players.getValue(Enum("Account", accountAddress), {
      at: "best",
    });
    return player?.registered === true;
  } catch {
    return false;
  }
}

/** How often the game is re-read while a sign-up started elsewhere is on its
 *  way, so the block turns to "Registered" within a block of it landing. */
const SIGNUP_IN_FLIGHT_REFETCH_MS = 3_000;

/**
 * Live current-game state for the card's candidate account. `signUpInFlight`
 * re-reads every few seconds instead of every half minute.
 */
export function useCurrentGame(
  cardResult: HumanityCardResult | null | undefined,
  enabled = true,
  signUpInFlight = false,
): QueryView<CurrentGameResult> & QueryTimestamps {
  const identities =
    cardResult?.kind === "card" ? cardResult.playerIdentities : null;
  // Already on the resolved card — the Devicehood record the card read decodes
  // carries it — so reading it here adds no host or chain round trip.
  const liteMemberKey =
    cardResult?.kind === "card"
      ? (cardResult.devicehood?.ringVrfKey ?? null)
      : null;
  const query = useQuery<CurrentGameResult>({
    queryKey: [
      "chain",
      "current-game",
      identities?.accountAddress ?? "none",
      // A Devicehood record that lands after the first read must re-ask, or
      // the seat verdict keeps answering with the membership gate switched off.
      liteMemberKey ?? "no-lite-key",
    ],
    enabled: enabled && identities != null,
    retry: false,
    staleTime: 0,
    refetchInterval: signUpInFlight ? SIGNUP_IN_FLIGHT_REFETCH_MS : 30_000,
    refetchIntervalInBackground: true,
    queryFn: ({ signal }): Promise<CurrentGameResult> => {
      if (identities == null) {
        // Unreachable while `enabled` gates the query; kept for narrowing.
        return Promise.resolve({ kind: "account-unavailable" });
      }
      return readGameForCard(identities, liteMemberKey, signal);
    },
  });
  return query;
}
