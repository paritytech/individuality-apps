// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Wires the real host handles into {@link PocketCardDeps}. This is the only
 * module in this package that talks to the container, which is what keeps
 * the renderer (`pocket-card.ts`) testable without one. The card it draws is
 * read exactly as the app's card reads it (`readHumanityCard` under
 * `runBoundedChainRead`), so the Pocket face can never show a state the
 * in-app card does not.
 */
import { resolveAirdropAccount } from "@humanity/shared/airdrops/chain/airdrop-account.ts";
import { CHAIN_READ_TIMEOUT_MS, runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";
import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";
import { linkedCardIdentity } from "@humanity/shared/card/linked-card-identity.ts";
import {
  readHumanityCard,
  type HumanityCardResult,
} from "@humanity/shared/card/read-humanity-card.ts";
import { resolveGameAccountAddress } from "@humanity/shared/identity/game-account.ts";
import {
  parseHumanityUserId,
  resolveHumanityUserId,
  type HumanityUserId,
} from "@humanity/shared/identity/humanity-user-id.ts";
import type { PocketFaceState } from "@humanity/shared/pocket/humanity-face.ts";
import { pocketFaceOf } from "@humanity/shared/pocket/pocket-face-state.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { withTimeout } from "@humanity/shared/utils/with-timeout.ts";
import { setIdentityContext } from "@humanity/shared/telemetry/app-context.ts";

import type { PocketCardDeps } from "./pocket-card.ts";

const logger = loggerFor("worker", "host-deps");

/** The person's card, read exactly as the app's card reads it; `null` when
 *  they have not shared their identity with this product. */
function readOwnCard(
  signal: AbortSignal,
): Promise<{ identity: HumanityUserId; card: HumanityCardResult } | null> {
  return runBoundedChainRead(signal, async (childSignal) => {
    const identity = await resolveHumanityUserId();
    if (identity == null) return null;
    const gameAccount = await resolveGameAccountAddress();
    const card = await readHumanityCard({
      identity,
      gameAccount,
      signal: childSignal,
    });
    return { identity, card };
  });
}

/**
 * The card's name with a full-username claim read at the best block, as the
 * app's card shows it (`useUsernameUpgradeOverlay`): the Pocket card drops
 * the suffix as soon as the claim is in a block, not a finalized read later.
 * The app hands its overlaid face over too, but this worker's own minute read
 * would draw the finalized name back over it. A claim dropped before finality
 * leaves best as well. A failed read keeps the finalized name.
 */
async function nameAtBest(card: ResolvedHumanityCard, identity: HumanityUserId): Promise<string> {
  const owner = card.accountAddress;
  if (card.snapshot.isUpgradedIdentity || owner == null) return card.primaryUsername;
  try {
    const { api } = await getPeopleClient();
    const consumer = await withTimeout(
      api.query.Resources.Consumers.getValue(owner, { at: "best" }),
      CHAIN_READ_TIMEOUT_MS,
      "Timed out reading the name at the best block.",
    );
    const base = parseHumanityUserId(card.primaryUsername) ?? identity;
    const linked = linkedCardIdentity(base, consumer?.full_username);
    return linked.isUpgraded ? linked.primaryUsername : card.primaryUsername;
  } catch (error) {
    logger.warning("best-block name read failed; drawing the finalized name: {error}", { error });
    return card.primaryUsername;
  }
}

/**
 * Where the person stands, and the name the card goes by, from the same read
 * as the app's card (the name at best, `nameAtBest`). Anything short of a
 * resolved card - no shared identity, an unavailable account, a failed or
 * timed-out read - draws `devicehood`, which every account holds before the
 * game says otherwise: a truthful floor rather than a guess, and no name, so
 * the caller falls back to the host's. Never throws, so the face keeps
 * drawing on its next refresh.
 */
async function loadFaceCard(): Promise<{ state: PocketFaceState; name: string | null; failed: boolean }> {
  try {
    const read = await readOwnCard(new AbortController().signal);
    if (read?.card.kind === "card") {
      const face = pocketFaceOf(read.card);
      return { state: face.state, name: await nameAtBest(read.card, read.identity), failed: false };
    }
    return { state: { kind: "devicehood" }, name: null, failed: false };
  } catch (error) {
    logger.warning("card read failed; drawing devicehood: {error}", { error });
    return { state: { kind: "devicehood" }, name: null, failed: true };
  }
}

/**
 * What the Pocket card draws.
 *
 * The name is the one the app's card shows: the card read's, which follows a
 * claimed full username as soon as the claim is finalized, while the host may
 * keep answering with the lite name for the rest of its session. The host's
 * username stands in when there is no card, and the shortened account address
 * only for a person who has not shared their identity with this product.
 *
 * The state is the app card's own (`readOwnCard`, mapped by
 * `pocketFaceOf`, which the app uses for the face it hands over), so the Pocket face and the in-app card agree; see
 * `loadFaceCard` for the floor it falls back to.
 */
export function createPocketCardDeps(): PocketCardDeps {
  return {
    resolveFace: async () => {
      const [identity, account, card] = await Promise.all([
        resolveHumanityUserId(),
        resolveAirdropAccount(),
        loadFaceCard(),
      ]);
      if (identity != null) setIdentityContext(identity);
      const address = account?.address ?? null;
      const state = card.state;
      const name =
        card.name ??
        identity?.username ??
        (address == null ? "Your card" : `${address.slice(0, 6)}...${address.slice(-4)}`);

      // A failed read draws the floor only while nothing better is shown.
      return { face: { name, state }, floor: card.failed };
    },
  };
}
