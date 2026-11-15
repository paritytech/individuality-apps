// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  devCardFixture,
  devGameFixture,
  devUsernameClaimFixture,
  parsePrizeDemoState,
} from "@features/prize/domain/prize-demo.ts";

const DEMO_STATES = [
  "not-enrolled",
  "devicehood",
  "candidate",
  "member",
  "caution",
  "caution-today",
  "suspended",
  "win",
  "miss",
  "live",
] as const;

describe("parsePrizeDemoState", () => {
  it("exposes every visual state in development", () => {
    for (const state of DEMO_STATES) {
      expect(parsePrizeDemoState(state, true)).toBe(state);
    }
  });

  it("falls back to live for removed and unknown values", () => {
    expect(parsePrizeDemoState("home", true)).toBe("live");
    expect(parsePrizeDemoState("locked", true)).toBe("live");
    expect(parsePrizeDemoState("ready", true)).toBe("live");
    expect(parsePrizeDemoState("anything", true)).toBe("live");
    expect(parsePrizeDemoState(undefined, true)).toBe("live");
  });

  it("cannot override live chain state in production", () => {
    for (const state of DEMO_STATES) {
      expect(parsePrizeDemoState(state, false)).toBe("live");
    }
    expect(parsePrizeDemoState("home", false)).toBe("live");
    expect(parsePrizeDemoState("locked", false)).toBe("live");
    expect(parsePrizeDemoState("anything", false)).toBe("live");
    expect(parsePrizeDemoState(undefined, false)).toBe("live");
  });
});

describe("devCardFixture", () => {
  it("yields the truthful no-card state for not-enrolled", () => {
    expect(devCardFixture("not-enrolled").state.kind).toBe("not-enrolled");
  });

  it("gives member fixtures an attended-streak activeWeeks", () => {
    const state = devCardFixture("member").state;
    expect(state.kind).toBe("member");
    if (state.kind === "member") {
      expect(state.activeWeeks).toBeGreaterThan(0);
      expect(state.lastAttendedGame).toBe(42);
    }
  });
});

describe("devGameFixture", () => {
  const REGISTERED_STATES = [
    "candidate",
    "member",
    "caution",
    "suspended",
  ] as const;
  const UNREGISTERED_STATES = ["not-enrolled", "devicehood"] as const;

  it("simulates an open registration-phase game with future timestamps", () => {
    const before = Math.floor(Date.now() / 1000);
    const game = devGameFixture("member");
    expect(game.kind).toBe("game");
    if (game.kind !== "game") return;
    expect(game.phase.label).toBe("registration");
    expect(game.phase.nextDeadlineSeconds).toBe(game.registrationEndsSeconds);
    expect(game.phase.secondsRemaining).toBeGreaterThan(0);
    expect(game.registrationEndsSeconds).toBeGreaterThan(before);
    expect(game.gameDateSeconds).toBeGreaterThan(game.registrationEndsSeconds);
    expect(game.airdropsScheduled).toBe(1);
  });

  it("marks every eligible personhood state as registered", () => {
    for (const state of REGISTERED_STATES) {
      const game = devGameFixture(state);
      expect(game.kind).toBe("game");
      if (game.kind === "game") expect(game.registered).toBe(true);
    }
  });

  it("marks not-enrolled and lite as unregistered", () => {
    for (const state of UNREGISTERED_STATES) {
      const game = devGameFixture(state);
      expect(game.kind).toBe("game");
      if (game.kind === "game") expect(game.registered).toBe(false);
    }
  });

  it("puts the caution-today game later today with registration still open and no seat", () => {
    const now = Math.floor(Date.now() / 1000);
    const game = devGameFixture("caution-today");
    expect(devCardFixture("caution-today").state.kind).toBe("caution");
    expect(game.kind).toBe("game");
    if (game.kind !== "game") return;
    expect(game.registered).toBe(false);
    expect(game.registrationEndsSeconds).toBeGreaterThan(now);
    expect(game.gameDateSeconds).toBeGreaterThan(game.registrationEndsSeconds);
    if (new Date(now * 1000).getHours() < 23) {
      expect(new Date(game.gameDateSeconds * 1000).toDateString())
        .toBe(new Date(now * 1000).toDateString());
    }
  });

  it("always yields a definite registration, never unknown", () => {
    // Live registration can be unknown (a partial player read); the demo
    // fixture is deterministic, so it must stay a plain boolean.
    for (const state of [...REGISTERED_STATES, ...UNREGISTERED_STATES]) {
      const game = devGameFixture(state);
      expect(game.kind).toBe("game");
      if (game.kind === "game") {
        expect(typeof game.registered).toBe("boolean");
      }
    }
  });
});

describe("devUsernameClaimFixture", () => {
  it("offers the name upgrade to the member fixture alone", () => {
    expect(devUsernameClaimFixture("member-new")).toMatchObject({ currentUsername: "marlow.42" });
    for (const demo of ["devicehood", "candidate", "member", "caution", "suspended", "win"] as const) {
      expect(devUsernameClaimFixture(demo), demo).toBeUndefined();
    }
  });
});
