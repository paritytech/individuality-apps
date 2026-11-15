// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One chain read of this account's people-airdrop standing, pinned to a
 * single best block so alias, draws and participation cannot disagree.
 *
 * The read itself is the SDK's `readPeopleAirdropsStanding`: the airdrop
 * alias, every `PeopleAirdrops` draw, and per draw the slot-derived
 * registration and the win, all at one block. This module only folds that
 * into the {@link AirdropStanding} the registry and the screens are written
 * against.
 *
 * Extracted from `useAirdropStanding` so the headless worker — which has no
 * React and no query client — runs exactly the same read the UI does. The
 * hook keeps the session-scoped `claimed` refinement on top; that memory is
 * per-consumer, not a property of the chain.
 */
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import {
  individualityChain,
  readPeopleAirdropsStanding,
  type PeopleAirdropsStanding,
} from "@humanity/shared/chain/individuality.ts";
import type {
  AirdropStanding,
  Hex32,
} from "@individuality/daily-dollar";

/**
 * The SDK's standing in the app's shape. An alias bound under another
 * context reads as no alias with that context, so the screens can tell it
 * apart from an account that was never bound.
 */
export function toAirdropStanding(standing: PeopleAirdropsStanding): AirdropStanding {
  const { binding, airdropsContext } = standing.alias;
  return {
    accountAddress: standing.account,
    alias: binding.tag === "Bound" ? (binding.alias as Hex32) : null,
    airdropsContext: airdropsContext as Hex32,
    aliasContext:
      binding.tag === "Bound"
        ? (airdropsContext as Hex32)
        : binding.tag === "OtherContext"
          ? (binding.context as Hex32)
          : null,
    contextMatches: binding.tag === "Bound",
    atBlockHash: standing.at.blockHash as Hex32,
    participations: standing.draws.map(({ drawIndex, event, slot, registered, won }) => ({
      draw: {
        eventId: event.eventId as Hex32,
        drawIndex,
        status: event.status,
        registrationStartsSeconds: event.registrationStarts,
        drawTimeSeconds: event.drawTime,
        endTimeSeconds: event.endTime,
        prizeAmount: event.prize.assetAmount,
        assetId: event.prize.assetId,
        maxWinners: event.prize.maxWinners,
        totalParticipants: event.totalParticipants,
        effectiveWinners: event.effectiveWinners,
        claimed: event.claimed,
      },
      slot: slot as Hex32 | null,
      registered,
      winner: won,
      claimed: null,
    })),
  };
}

/**
 * Read the full standing for `accountAddress`. A failed or aborted read
 * rejects, so a cancelled query or a stopped worker tick never reads as an
 * empty standing.
 */
export async function loadAirdropStanding(
  accountAddress: string,
  signal: AbortSignal,
): Promise<AirdropStanding> {
  const { client, api } = await getPeopleClient();
  signal.throwIfAborted();

  const result = await readPeopleAirdropsStanding(individualityChain(client, api), {
    account: accountAddress,
    signal,
  });
  if (!result.ok) throw result.error;
  return toAirdropStanding(result.value);
}
