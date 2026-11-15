// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  toCurrentGameResult,
  toGameResult,
  toRegistered,
} from "@features/card/chain/current-game-data.ts";
import {
  toGamePhaseView,
  type GamePhaseLabel,
} from "@humanity/shared/chain/game-phase.ts";
import {
  IndividualityDecodeError,
  toCurrentGame,
  type CurrentGame,
  type GamePhase,
  type PlayerRegistration,
  type SdkCurrentGameResult,
} from "@humanity/shared/chain/individuality.ts";

const NOW = 1_800_000_000;

function sdkGame(overrides: Partial<CurrentGame> = {}): CurrentGame {
  return {
    index: 7,
    phase: "Registration",
    nextDeadline: 1_800_000_300,
    registrationEnds: 1_800_000_300,
    shuffleDeadline: 1_800_014_400,
    gamePlayTime: 1_800_028_800,
    reportingEnds: 1_800_172_800,
    maxGroupSize: 5,
    rounds: 3,
    playerCount: null,
    pendingAttendance: 0,
    airdropsScheduled: 1,
    ...overrides,
  };
}

function running(overrides: Partial<CurrentGame> = {}): SdkCurrentGameResult {
  return {
    tag: "Running",
    at: { blockHash: "0xblock", blockNumber: 42 },
    game: sdkGame(overrides),
    registration: { tag: "Registered" },
    upcoming: [],
    durations: {
      registration: 300,
      shuffle: 210,
      postShuffleMargin: 90,
      reporting: 360,
      playerProcess: 60,
    },
  };
}

describe("toCurrentGameResult over the SDK result", () => {
  it("maps Running onto the card's game kind, renaming the SDK's fields", () => {
    expect(toCurrentGameResult(running(), NOW)).toMatchObject({
      kind: "game",
      gameIndex: 7,
      gameDateSeconds: 1_800_028_800,
      registrationEndsSeconds: 1_800_000_300,
      // 3 rounds of 5 players: 15 turns of 12 s and two 7 s gaps after the play time
      playEndsSeconds: 1_800_028_800 + 15 * 12 + 2 * 7,
      airdropsScheduled: 1,
    });
  });

  it("opens the next game's registration when the running game ends, not at the schedule projection (#1699)", () => {
    const preview = (gamePlayTime: number) => ({
      gamePlayTime,
      rounds: 3,
      maxGroupSize: 5,
      airdrops: [],
      timeline: {
        registrationStarts: gamePlayTime - 600,
        registrationEnds: gamePlayTime - 300,
        shuffleDeadline: gamePlayTime - 30,
        gamePlayTime,
        reportingEnds: gamePlayTime + 600,
        playerProcessEnds: gamePlayTime + 660,
      },
    });
    const read = { ...running(), upcoming: [preview(1_800_030_000), preview(1_800_031_200)] } satisfies SdkCurrentGameResult;
    expect(toCurrentGameResult(read, NOW)).toMatchObject({
      // the running game's reportingEnds, not 1_800_029_400 (kickoff minus the registration phase)
      nextGame: { gameDateSeconds: 1_800_030_000, registrationStartsSeconds: 1_800_172_800 },
    });
    expect(toCurrentGameResult({ ...running({ phase: "Cancelling" }), upcoming: read.upcoming }, NOW)).toMatchObject({
      nextGame: { registrationStartsSeconds: 1_800_029_400 },
    });
    const between = { ...read, tag: "BetweenGames", lastGameIndex: 7 } as unknown as SdkCurrentGameResult;
    expect(toCurrentGameResult(between, NOW)).toMatchObject({ nextGame: { registrationStartsSeconds: 0 } });
    expect(toCurrentGameResult(running(), NOW)).toMatchObject({ nextGame: null });
  });

  it("maps BetweenGames onto no-game, carrying the last index", () => {
    expect(
      toCurrentGameResult(
        {
          tag: "BetweenGames",
          at: { blockHash: "0xblock", blockNumber: 42 },
          lastGameIndex: 3,
          upcoming: [],
          durations: {
            registration: 300,
            shuffle: 210,
            postShuffleMargin: 90,
            reporting: 360,
            playerProcess: 60,
          },
        },
        NOW,
      ),
    ).toEqual({ kind: "no-game", gameIndex: 3, nextGame: null });
  });

  it("reports gameIndex 0 when no game has ever run", () => {
    expect(
      toCurrentGameResult(
        {
          tag: "BetweenGames",
          at: { blockHash: "0xblock", blockNumber: 1 },
          lastGameIndex: null,
          upcoming: [],
          durations: {
            registration: 300,
            shuffle: 210,
            postShuffleMargin: 90,
            reporting: 360,
            playerProcess: 60,
          },
        },
        NOW,
      ),
    ).toEqual({ kind: "no-game", gameIndex: 0, nextGame: null });
  });

  it("preserves a multi-airdrop count rather than collapsing it to a flag", () => {
    expect(
      toCurrentGameResult(running({ airdropsScheduled: 3 }), NOW),
    ).toMatchObject({ airdropsScheduled: 3 });
    expect(
      toCurrentGameResult(running({ airdropsScheduled: 0 }), NOW),
    ).toMatchObject({ airdropsScheduled: 0 });
  });
});

describe("toRegistered over PlayerRegistration", () => {
  const cases: ReadonlyArray<[PlayerRegistration, boolean | null]> = [
    [{ tag: "Registered" }, true],
    [{ tag: "NotRegistered" }, false],
    [{ tag: "Unknown" }, null],
  ];

  it.each(cases)("maps %j to %j", (registration, expected) => {
    expect(toRegistered(registration)).toBe(expected);
  });

  it("throws on Unchecked rather than answering unknown", () => {
    expect(() => toRegistered({ tag: "Unchecked" })).toThrow(/unchecked/i);
  });

  it("carries the registration from the read onto the result", () => {
    expect(
      toGameResult(sdkGame(), { tag: "NotRegistered" }, NOW),
    ).toMatchObject({ registered: false });
    expect(toGameResult(sdkGame(), { tag: "Unknown" }, NOW)).toMatchObject({
      registered: null,
    });
  });
});

/** The SDK's decode, tested here because the loud failure it now owns is a
 *  guarantee this app depends on. */
describe("toCurrentGame over a raw game", () => {
  const raw = {
    index: 7,
    registration_ends: 1_800_000_300,
    shuffle_deadline: 1_800_014_400,
    game_date: 1_800_028_800,
    report_ends: 1_800_172_800,
    state: { type: "Reporting" },
    max_group_size: 5,
    rounds: 3,
    pending_attendance: 0,
    airdrops_scheduled: 1,
  };

  it("selects the deadline belonging to the phase", () => {
    expect(toCurrentGame(raw)).toMatchObject({
      phase: "Reporting",
      nextDeadline: 1_800_172_800,
    });
  });

  it("throws on a game state no runtime this app knows reports", () => {
    expect(() =>
      toCurrentGame({ ...raw, state: { type: "DefinitelyNotReal" } }),
    ).toThrow(IndividualityDecodeError);
  });
});

describe("toGamePhaseView over GamePhase", () => {
  const labels: ReadonlyArray<[GamePhase, GamePhaseLabel]> = [
    ["Registration", "registration"],
    ["Shuffle", "shuffle"],
    ["Reporting", "reporting"],
    ["PlayerProcess", "processing"],
    ["Cancelling", "cancelling"],
  ];

  it.each(labels)("maps %s to %s", (phase, label) => {
    expect(toGamePhaseView(phase, 1_800_000_300, NOW).label).toBe(label);
  });

  it("counts down to the deadline the SDK selected", () => {
    expect(toGamePhaseView("Registration", 1_800_000_300, NOW)).toEqual({
      label: "registration",
      nextDeadlineSeconds: 1_800_000_300,
      secondsRemaining: 300,
    });
  });

  it("clamps a deadline in the past at zero", () => {
    expect(
      toGamePhaseView("Shuffle", NOW - 60, NOW).secondsRemaining,
    ).toBe(0);
  });

  it("has no countdown for a phase that ends on work", () => {
    expect(toGamePhaseView("PlayerProcess", null, NOW)).toEqual({
      label: "processing",
      nextDeadlineSeconds: null,
      secondsRemaining: null,
    });
  });
});
