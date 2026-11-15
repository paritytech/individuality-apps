// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Live-prize data assembly for `PrizePage`. Pulls the card, current game
 *  and people-airdrop standing together, derives the resolved surface and
 *  fires background registration whenever the standing changes. Claiming is not one of them: the daily screen submits
 *  the claim when it opens (`useAutoClaimDraws`).
 *  Owning the data shape here keeps `PrizePage` short and makes the surface
 *  visible to a future "now playing on this draw" panel without changing the
 *  page.
 *
 *  The card is read first because the standing query needs its account; the
 *  game is read next so the home block has schedule data; the standing is
 *  read last and drives the surface. The auto-register effect runs
 *  alongside — see `useAutoRegisterDraws`. */
import type { AirdropStanding } from "@individuality/daily-dollar";
import type {
  AutoRegisterState,
} from "@features/airdrops/hooks/use-auto-register-draws.ts";
import { useAutoRegisterDraws } from "@features/airdrops/hooks/use-auto-register-draws.ts";
import { useAirdropStanding } from "@features/airdrops/hooks/use-airdrop-standing.ts";
import { offersRegister, type CurrentGameResult } from "@features/card/domain/current-game.ts";
import { freshness, useForegroundSession } from "@shared/session/foreground-session.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import { useHumanityCard } from "@features/card/hooks/use-humanity-card.ts";
import { useGameRegistration } from "@features/card/hooks/use-game-registration.ts";
import { useCurrentGame } from "@features/card/hooks/use-current-game.ts";
import { useDebugCardOverride } from "@features/debug/use-debug-card-override.ts";
import {
  resolveLiveSurface,
  type LiveSurface,
} from "@features/prize/domain/live-prize-surface.ts";

// `error` is typed as `Error | null` to match the `QueryView<T>` contract
// that `useHumanityCard` / `useCurrentGame` / `useAirdropStanding` already
// expose — `blockingError` requires that exact shape, and a wider `unknown`
// would force a cast at every call site. The card path is normalised to
// `HumanityCardResult | undefined` (no `null`) because the `QueryView<T>`
// data field is `T | undefined`, `useDebugCardOverride` never widens it to
// `null`, and `DebugInput.card` declares `undefined`-only — so the spurious
// `null` was a typing mistake, not a real value the hook could ever carry.
export interface AirdropPrizePageData {
  cardQuery: {
    data: HumanityCardResult | undefined;
    error: Error | null;
    isPending: boolean;
  };
  gameQuery: {
    data: CurrentGameResult | undefined;
    error: Error | null;
    isPending: boolean;
  };
  standingQuery: {
    data: AirdropStanding | undefined;
    error: Error | null;
    isPending: boolean;
  };
  standing: AirdropStanding | undefined;
  surface: LiveSurface;
  nowSeconds: number;
  autoRegister: AutoRegisterState;
  /** Jollity (its chat or its app) or this home is signing this account up for the game
   *  the home shows, or has seen that land, which the chain does not hold yet
   *  (`useGameRegistration`). */
  signUpUnderWay: boolean;
}

export function useAirdropPrizePageData(isLive: boolean): AirdropPrizePageData {
  const cardQuery = useDebugCardOverride(useHumanityCard(isLive));
  const registrationQuery = useGameRegistration(isLive);
  const registration = registrationQuery.data;
  // A recorded sign-up, Jollity's or this home's, is on its way, or landed where the finalized read has
  // yet to see it: the game is read quickly until the chain says the same.
  const signUpRecorded = registration != null && registration.phase !== "failed";
  const gameQuery = useCurrentGame(cardQuery.data, isLive, signUpRecorded);
  // Never offer Register on an answer this foreground session has not read:
  // the person may have registered in Jollity since, whose sign-up shows on
  // chain only once it is in a block. Both reads pause while the page is
  // hidden, so the block waits for both.
  const session = useForegroundSession();
  const holdGame =
    offersRegister(gameQuery.data) &&
    (freshness(gameQuery, session) !== "fresh" ||
      freshness(registrationQuery, session) !== "fresh");
  const standingQuery = useAirdropStanding(isLive);
  const standing = standingQuery.data;
  // Registration proves against the `people` ring: a lite-only or onboarding key proves NotMember.
  const inMembershipRing =
    cardQuery.data?.kind === "card" &&
    cardQuery.data.snapshot.membershipRing?.kind === "included";
  const autoRegister = useAutoRegisterDraws(standing, isLive && inMembershipRing);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const surface = resolveLiveSurface(standing, nowSeconds);
  const game = gameQuery.data;
  // Only for the game on screen, and only while the chain has not caught up:
  // once it reads the account registered, the chain is the answer again. A
  // sign-up that failed says nothing either: Register is on offer.
  const signUpUnderWay =
    signUpRecorded &&
    game?.kind === "game" &&
    game.gameIndex === registration.gameIndex &&
    game.registered === false;

  return {
    cardQuery: {
      data: cardQuery.data,
      error: cardQuery.error,
      isPending: cardQuery.isPending,
    },
    gameQuery: {
      data: holdGame ? undefined : gameQuery.data,
      error: gameQuery.error,
      isPending: gameQuery.isPending || holdGame,
    },
    standingQuery: {
      data: standing,
      error: standingQuery.error,
      isPending: standingQuery.isPending,
    },
    standing,
    surface,
    nowSeconds,
    autoRegister,
    signUpUnderWay,
  };
}
