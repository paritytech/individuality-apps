// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { runBoundedChainRead } from "@humanity/shared/chain/bounded-read.ts";
import { blockingError } from "@shared/chain/query-state.ts";
import { usernameSigningContext } from "@humanity/shared/chain/username-signing-context.ts";
import type { QueryView } from "@shared/chain/query-view.ts";
import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";
import { isHumanityCardStateKind } from "@humanity/shared/card/humanity-card-state.ts";
import {
  readHumanityCard,
  type AccountUnavailable,
  type HumanityCardResult,
} from "@humanity/shared/card/read-humanity-card.ts";
import {
  writeLastCard,
  readLastCard,
} from "@features/card/storage/last-card-store.ts";
import { useHumanityUserId } from "./use-humanity-user-id.ts";
import { useGameAccount } from "./use-game-account.ts";
import { useUsernameUpgradeOverlay } from "./use-username-upgrade-marker.ts";
import { useCandidateOverlay } from "./use-candidate-overlay.ts";
import { usePocketFaceHint } from "./use-pocket-face-hint.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { cardLoad } from "@features/card/telemetry/card-load.ts";
import {
  setCardContext,
  setIdentityContext,
} from "@humanity/shared/telemetry/app-context.ts";

const logger = loggerFor("card", "humanity-card");

/**
 * Whether a card read has landed since this executable started. The first
 * one is the `read` stage of the `card.load` flow (`card-load.ts`) — the
 * read most likely to meet a cold host and a cold chain connection. Every
 * 12 s refetch after it is routine and reports nothing but its log lines; a
 * cold read that fails is logged as an error so the open that showed no
 * card is an issue, and its retry is a second cold read.
 */
let cardReadLanded = false;

/** The composed card query shape consumed by the page: `data`, `error`, `isPending`. */
export type HumanityCardQuery = QueryView<HumanityCardResult>;

/**
 * A card the hydrated query cache hands back may predate this build. The
 * persisted cache is busted per network and schema version, not per deploy,
 * so a `state.kind` retired since (`lite`, for one) can arrive
 * typed as a card with no face to render it. Treat it as no data: the
 * mount-time refetch replaces it, and the durable snapshot (validated the
 * same way) covers the wait.
 */
function renderable(
  data: HumanityCardResult | undefined,
): HumanityCardResult | undefined {
  if (data == null || data.kind !== "card") return data;
  const state: unknown = (data as { state?: unknown }).state;
  return typeof state === "object" &&
    state != null &&
    isHumanityCardStateKind((state as { kind?: unknown }).kind)
    ? data
    : undefined;
}

/** Shared so callers memoising on `data` never see a fresh object per render. */
const ACCOUNT_UNAVAILABLE: AccountUnavailable = { kind: "account-unavailable" };

/** Finalized card state with a durable fallback until a live card resolves,
 *  showing a name claim or a game sign-up already at best before finality
 *  catches up. */
export function useHumanityCard(enabled = true): HumanityCardQuery {
  const identityQuery = useHumanityUserId(enabled);
  const identity = identityQuery.data;
  // Host call, resolved outside the chain read: see `useGameAccount`.
  const gameAccountQuery = useGameAccount(identity?.username, enabled);
  const gameAccount = gameAccountQuery.data ?? null;
  const cardQuery = useQuery<HumanityCardResult>({
    queryKey: [
      "chain",
      "humanity-card",
      identity?.username ?? "none",
      gameAccount ??
        (gameAccountQuery.isPending
          ? "pending-game-account"
          : "no-game-account"),
    ],
    enabled: enabled && identity != null,
    // Two attempts before the error state replaces the card; a pin lapse
    // inside an attempt is retried by `readAtFinalized` and never counts.
    retry: 1,
    retryDelay: 1_000,
    staleTime: 0,
    refetchInterval: 12_000,
    refetchIntervalInBackground: true,
    queryFn: ({ signal }): Promise<HumanityCardResult> => {
      const read = (): Promise<HumanityCardResult> =>
        runBoundedChainRead(
          signal,
          async (childSignal): Promise<HumanityCardResult> => {
            if (identity == null) {
              return { kind: "account-unavailable" };
            }
            const result = await readHumanityCard({
              readSigningContext: usernameSigningContext,
              identity,
              gameAccount,
              signal: childSignal,
            });
            if (result.kind === "card") writeLastCard(identity.username, result);
            return result;
          },
        );
      if (cardReadLanded) return read();
      cardLoad.stage("read");
      cardLoad.set({ "game.account": gameAccount != null });
      // Whether this read can be the launch's answer. While the host is
      // still deriving the game account the read is provisional — it
      // returns `account-unavailable` at once and the re-keyed read that
      // follows is the real one — so it may not end the flow.
      const provisional = gameAccount == null && gameAccountQuery.isPending;
      return read().then(
        (result) => {
          if (result.kind === "card") {
            cardReadLanded = true;
            // Read, not yet seen: the commit that draws it ends the flow.
            cardLoad.stage("render");
          } else if (!provisional) {
            cardReadLanded = true;
            cardLoad.finish({ kind: result.kind, ok: false });
          }
          return result;
        },
        (error: unknown) => {
          // The query is re-keyed once the game account resolves, which
          // aborts the read in flight: not a failure, and the next read
          // is the cold one, still inside the `read` stage.
          if (!(error instanceof Error && error.name === "AbortError")) {
            logger.error("first card read failed: {error}", { error });
            cardLoad.fail(error);
          }
          throw error;
        },
      );
    },
  });

  const identityUnavailable =
    !identityQuery.isFetching &&
    !identityQuery.isPending &&
    identityQuery.error == null &&
    identityQuery.data == null;
  const cardData = renderable(cardQuery.data);
  // A hydrated card this build rejected counts as success to the query, so
  // its replacement is a background refetch, not a pending state. Until that
  // read lands (or fails), the card is loading, not absent.
  const awaitingReplacement =
    cardQuery.data !== undefined &&
    cardData === undefined &&
    cardQuery.error == null;
  const liveQuery: HumanityCardQuery = {
    data: identityUnavailable ? ACCOUNT_UNAVAILABLE : cardData,
    error:
      blockingError(identityQuery.error, identityQuery.data) ??
      blockingError(cardQuery.error, cardData),
    isPending:
      identityQuery.isPending ||
      (identity != null &&
        (cardQuery.isPending ||
          awaitingReplacement ||
          (gameAccountQuery.isPending && cardData?.kind !== "card"))),
  };
  const storedSnapshot = readLastCard();
  // The flow ends once the live card is on screen — this effect runs after
  // the paint of the render in which the consumer drew `cardData` — or when
  // the host said it holds no identity for us, which is the
  // account-unavailable screen. Both are no-ops once the launch's flow has
  // finished.
  useEffect(() => {
    if (!cardLoad.inFlight) return;
    if (identityUnavailable) {
      cardLoad.finish({ kind: "account-unavailable", ok: false });
    } else if (cardReadLanded && cardData?.kind === "card") {
      cardLoad.set({ "card.cached": storedSnapshot != null });
      cardLoad.finish({ kind: cardData.state?.kind ?? "card", ok: true });
    }
  }, [identityUnavailable, cardData, storedSnapshot]);
  // Account unavailability only reports a failed account lookup, never membership.
  const resolved: HumanityCardQuery =
    liveQuery.data?.kind !== "card" &&
    storedSnapshot != null &&
    (identity == null || identity.username === storedSnapshot.username)
      ? {
          data: storedSnapshot.card as ResolvedHumanityCard,
          error: null,
          isPending: false,
        }
      : liveQuery;
  const data = useCandidateOverlay(
    useUsernameUpgradeOverlay(resolved.data, identity, enabled),
    enabled,
  );
  // The Pocket card follows the live read, the name claim overlay included.
  // A card restored from the persisted cache keeps its old `dataUpdatedAt`,
  // so only a read made since mount counts as live.
  usePocketFaceHint(
    data,
    cardQuery.dataUpdatedAt,
    enabled && resolved === liveQuery && cardQuery.isFetchedAfterMount,
  );
  // What an error filed from here on is about: the person and the card as
  // last shown, the overlay and the cached snapshot included.
  useEffect(() => setIdentityContext(identity), [identity]);
  useEffect(() => setCardContext(data, gameAccount), [data, gameAccount]);
  return data === resolved.data ? resolved : { ...resolved, data };
}
