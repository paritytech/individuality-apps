// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// What games publishes to other integrations: the operations of one game on
// the caller's People connection and journal (`GameControl.open`). The
// implementation (`attendance/game.repository.ts`) stays internal.
import type { ImportedGamesTarget } from "../humanity/bootstrap/imported-games.ts";
import type { GameParticipant } from "./participant.ts";

export interface GameOperations {
  /** Set the accelerated local game phases (refuses while a game or schedule exists). */
  prepareLocalGames(options?: { visibleRegistration?: boolean }): Promise<void>;
  /** Fund the distinct host product accounts for the opt-in visible game from the verified local administrator. */
  fundLocalGameAccounts(accounts: readonly { name: string; address: string }[]): Promise<void>;
  /** Create and fund the local prize draw's asset (idempotent); `schedule({ withPrize })` also does it. */
  prepareLocalPrize(): Promise<void>;
  /**
   * Schedule one real game and wait until it is registering; the opt-in draw opens Humanity's lite seat path.
   * `startsInSeconds`: play at least that far ahead (default: as soon as the configured phases allow).
   */
  schedule(options?: { withPrize?: boolean; startsInSeconds?: number; ownedBatch?: ImportedGamesTarget; recordSetup?: (proof: unknown) => void; recordSetupFailure?: (proof: unknown) => Promise<void> }): Promise<number>;
  /**
   * Move the scheduled game `gameIndex`, still registering, to play `playsInSeconds` after the chain's time now: its
   * dates and its prize draws' dates shift earlier together, written through root by the verified authority
   * (game-retime.ts). Changes the game's schedule, never the chain's time. Resolves once the new dates are finalized.
   */
  retime(gameIndex: number, playsInSeconds: number): Promise<GameRetime>;
  /** Sign each participant up (each with its own account). */
  enroll(participants: readonly GameParticipant[]): Promise<void>;
  /** Force the shuffle and wait until game `gameIndex` is reporting. */
  startReporting(gameIndex: number): Promise<void>;
  /** Addresses of the shuffled group, checked against `participants`. */
  shuffledGroup(participants: readonly GameParticipant[]): Promise<string[]>;
  /** One participant's report on the rest of `group` (`NotPerson` for `absent`). */
  reportFrom(reporter: GameParticipant, group: readonly string[], absent?: readonly GameParticipant[]): Promise<void>;
  /** Every present participant reports; `absent` do not. */
  report(participants: readonly GameParticipant[], absent?: GameParticipant | readonly GameParticipant[]): Promise<void>;
  /** End reporting when someone was absent, then wait until the game's processing completed at finality. */
  complete(hasAbsentParticipant: boolean, gameIndex: number): Promise<void>;
}

/** What a re-time did: the game's play date before and after, how far it moved, and each draw moved with it. */
export interface GameRetime {
  readonly gameIndex: number;
  /** Unix seconds. */
  readonly from: number;
  readonly to: number;
  readonly shiftSeconds: number;
  readonly draws: readonly { readonly id: string; readonly drawTime: { readonly from: string; readonly to: string }; readonly schedule: readonly string[] }[];
  /** The finalized block where the new dates were read back. */
  readonly verifiedAt: { readonly number: number; readonly hash: string };
}
