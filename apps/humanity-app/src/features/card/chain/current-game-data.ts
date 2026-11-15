// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { playEndsSeconds, registrationOpensSeconds } from "@individuality/shared-records";
import { toGamePhaseView } from "@humanity/shared/chain/game-phase.ts";
import type {
  CurrentGame,
  PlayerRegistration,
  SdkCurrentGameResult,
} from "@humanity/shared/chain/individuality.ts";
import type { CurrentGameResult, NextGame } from "@features/card/domain/current-game.ts";
import type { LiteSignUpVerdict } from "@features/card/domain/lite-signup.ts";


type ResolvedGame = Exclude<CurrentGameResult, { kind: "account-unavailable" }>;

export function toRegistered(
  registration: PlayerRegistration,
): boolean | null {
  switch (registration.tag) {
    case "Registered":
      return true;
    case "NotRegistered":
      return false;
    case "Unknown":
      return null;
    case "Unchecked":
      throw new Error("game registration was Unchecked: no players were read");
  }
}

/** The chain keeps `Game.GameSchedules` chronological, so the first entry is
 *  the next game. Its registration opens when the game before it ends
 *  (`previousGameEnds`, see registrationOpensSeconds). */
export function toNextGame(
  upcoming: SdkCurrentGameResult["upcoming"],
  previousGameEnds: number | null,
): NextGame | null {
  const next = upcoming[0];
  if (next == null) return null;
  const [opens] = registrationOpensSeconds([next.timeline], previousGameEnds);
  return { gameDateSeconds: next.gamePlayTime, registrationStartsSeconds: opens! };
}

/** One place names the phase, so no caller invents its own wording. */
export function toGameResult(
  game: CurrentGame,
  registration: PlayerRegistration,
  nowSeconds: number,
  liteSignUp: LiteSignUpVerdict | null = null,
  nextGame: NextGame | null = null,
): ResolvedGame {
  return {
    kind: "game",
    gameIndex: game.index,
    gameDateSeconds: game.gamePlayTime,
    registrationEndsSeconds: game.registrationEnds,
    playEndsSeconds: playEndsSeconds(game),
    airdropsScheduled: game.airdropsScheduled,
    phase: toGamePhaseView(game.phase, game.nextDeadline, nowSeconds),
    registered: toRegistered(registration),
    liteSignUp,
    nextGame,
  };
}

export function toCurrentGameResult(
  read: SdkCurrentGameResult,
  nowSeconds: number,
  liteSignUp: LiteSignUpVerdict | null = null,
): ResolvedGame {
  switch (read.tag) {
    case "BetweenGames":
      // `Game.GameIndex` answered 0 before any game existed; the SDK says null.
      return { kind: "no-game", gameIndex: read.lastGameIndex ?? 0, nextGame: toNextGame(read.upcoming, 0) };
    case "Running":
      return toGameResult(
        read.game,
        read.registration,
        nowSeconds,
        liteSignUp,
        toNextGame(read.upcoming, read.game.phase === "Cancelling" ? null : read.game.reportingEnds),
      );
  }
}
