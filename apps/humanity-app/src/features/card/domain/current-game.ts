// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Live game state for the home card, resolved per account. Pure type; the
 *  chain decode shapes live in `chain/current-game-data.ts`. */
import type { GamePhaseView } from "@humanity/shared/chain/game-phase.ts";
import type { LiteSignUpVerdict } from "./lite-signup.ts";


/** The first game on the chain's schedule after the running one (or after
 *  the last one, between games): a game the chain has not created yet. */
export interface NextGame {
  /** Unix seconds of its play time, the only time the chain stores for it. */
  gameDateSeconds: number;
  /** Unix seconds registration opens: projected from the phase durations. */
  registrationStartsSeconds: number;
}

export type CurrentGameResult =
  | { kind: "account-unavailable" }
  | { kind: "no-game"; gameIndex: number; nextGame: NextGame | null }
  | {
      kind: "game";
      gameIndex: number;
      /** Unix seconds of the game's play time. */
      gameDateSeconds: number;
      /** Unix seconds when registration closes. */
      registrationEndsSeconds: number;
      /** Unix seconds when the last turn ends (`playEndsSeconds` of
       *  `@individuality/shared-records`): the Reporting phase runs on past
       *  it, and from here the game is over for the player. */
      playEndsSeconds: number;
      /** How many daily-dollar airdrops this game scheduled; the events carry
       *  indices `0..airdropsScheduled`. Zero means none. */
      airdropsScheduled: number;
      phase: GamePhaseView;
      /** The game after this one; shown once this one's play time has passed. */
      nextGame: NextGame | null;
      /**
       * Whether the resolved identities are registered for this game.
       * `true` when any identity read back a stored `registered` flag; `null`
       * when none did but at least one identity read failed, so the UI can
       * say it cannot tell instead of claiming unregistered; `false` only
       * when every identity read succeeded and none was registered.
       */
      registered: boolean | null;
      /** Lite sign-up verdict at the same pinned block; `null` when the read could
       *  not run (no candidate account, outside a host, or a failed read). */
      liteSignUp: LiteSignUpVerdict | null;
    };

/**
 * Whether the block would offer Register on this answer: a game the account
 * is not registered for. Such an answer is only shown once read in the
 * current foreground session. A held-over one may predate a sign-up made in
 * DIM2 since, and showing it would offer Register to someone who is
 * registered, then flip to registered when the fresh read lands.
 */
export function offersRegister(game: CurrentGameResult | null | undefined): boolean {
  return game?.kind === "game" && game.registered === false;
}
