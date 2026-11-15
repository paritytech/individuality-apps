// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Demo parser for DEV-only card fixture states.
 *  Production always uses live chain data. */
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";

/** The closed set of DEV demo states for the card journey.
 *  home/locked are removed — all states are now live chain-driven. */
export type PrizeDemoState =
  | "not-enrolled"
  | "devicehood"
  | "candidate"
  | "membership-ready"
  | "member"
  | "member-new"
  | "caution"
  | "caution-today"
  | "promotion"
  | "suspended"
  | "win"
  | "miss"
  | "live";

const DEMO_STATES: Record<PrizeDemoState, true> = {
  "not-enrolled": true,
  devicehood: true,
  candidate: true,
  "membership-ready": true,
  member: true,
  "member-new": true,
  caution: true,
  "caution-today": true,
  promotion: true,
  suspended: true,
  win: true,
  miss: true,
  live: true,
};

/** Visual fixtures exist only in development; production always reads the chain. */
export function parsePrizeDemoState(
  value: string | undefined,
  isDevelopment: boolean,
): PrizeDemoState {
  if (!isDevelopment || value == null || !Object.hasOwn(DEMO_STATES, value)) {
    return "live";
  }
  return value as PrizeDemoState;
}

// ---- DEV-only card fixtures (never leak into live mode) -----------------------

/** DEV-only fixture account. */
const DEV_ACCOUNT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";

/** A member three weeks into a streak, one miss further back. */
const MEMBER_FIXTURE: HumanityCardState = {
  kind: "member",
  activeWeeks: 3,
  lastAttendedGame: 42,
  attendanceHistory: 0b1111_0111,
  window: 8,
};

export interface CardFixture {
  accountAddress: string;
  state: HumanityCardState;
  /** The name the fixture card wears; the demo screens read like the mocks. */
  displayName: string;
}

/** DEV fixture helper — returns a representative HumanityCardState + account.
 *  All values are fake and must never appear in production. */
export function devCardFixture(demo: PrizeDemoState): CardFixture {
  switch (demo) {
    case "not-enrolled":
      return { accountAddress: DEV_ACCOUNT, displayName: "marlow.42", state: { kind: "not-enrolled" } };
    case "devicehood":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow.42",
        state: { kind: "devicehood", personhoodThreshold: 6 },
      };
    case "candidate":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow.42",
        state: {
          kind: "candidate",
          score: 4,
          personhoodThreshold: 6,
          gamesRemaining: 1,
        },
      };
    case "membership-ready":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow",
        state: {
          kind: "membership-ready",
          activeWeeks: 2,
          lastAttendedGame: 42,
          // Two games into a record the runtime started at 0xFF.
          attendanceHistory: 0xff,
          window: 8,
        },
      };
    case "member":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow",
        state: MEMBER_FIXTURE,
      };
    // The moment of promotion: the candidate card about to turn silver.
    case "promotion":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow.42",
        state: { kind: "candidate", score: 6, personhoodThreshold: 6, gamesRemaining: 0 },
      };
    // Just promoted: the card is silver, the name still carries its number,
    // and the name is the next step. No ticket yet — the daily dollar comes
    // with the name.
    case "member-new":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow.42",
        state: {
          kind: "member",
          activeWeeks: 6,
          lastAttendedGame: 42,
          // Six games since the record began; the runtime starts a record at
          // 0xFF, so the two older bits are its fill, not games played.
          attendanceHistory: 0xff,
          window: 8,
        },
      };
    case "caution":
    case "caution-today":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow",
        state: {
          kind: "caution",
          activeWeeks: 0,
          // Caution is projected: the misses already use up the allowance,
          // so the next absence would cross it.
          misses: 2,
          allowedMisses: 2,
          window: 8,
          lastAttendedGame: 41,
          // Two absences in the window, the latest game among them.
          attendanceHistory: 0b1111_1010,
        },
      };
    case "suspended":
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow",
        // Attendance rather than the ring: the demo is about a player who
        // stopped showing up, not about a key the chain threw out.
        state: { kind: "suspended", reason: "attendance" },
      };
    case "win":
    case "miss":
    case "live":
      // These demo states don't produce a card fixture
      return {
        accountAddress: DEV_ACCOUNT,
        displayName: "marlow",
        state: MEMBER_FIXTURE,
      };
  }
}

/** DEV-only simulated current-game fixture (never used in live mode).
 *  A registration-phase game with timestamps relative to now, so the demo
 *  always reads as an open registration. Every value is fake and must never
 *  appear in production. */
export function devGameFixture(demo: PrizeDemoState): CurrentGameResult {
  const now = Math.floor(Date.now() / 1000);
  if (demo === "caution-today") return cautionTodayGame(now);
  // Registration closes three hours out; the game is a week away.
  const registrationEndsSeconds = now + 3 * 3_600;
  const gameDateSeconds = now + 7 * 86_400;
  return {
    kind: "game",
    nextGame: null,
    // The next game after the fixture card's lastAttendedGame (42).
    gameIndex: 43,
    gameDateSeconds,
    registrationEndsSeconds,
    playEndsSeconds: gameDateSeconds + 300,
    airdropsScheduled: 1,
    phase: {
      label: "registration",
      nextDeadlineSeconds: registrationEndsSeconds,
      secondsRemaining: registrationEndsSeconds - now,
    },
    registered: demo !== "not-enrolled" && demo !== "devicehood",
    liteSignUp: null,
  };
}

/** DEV-only: the grace window's last game later today, not yet registered
 *  for — the case that raises the last-day sheet. The game sits two hours
 *  out, pulled in to stay on today's date late in the evening. */
function cautionTodayGame(now: number): CurrentGameResult {
  const endOfDay = Math.floor(new Date(now * 1000).setHours(23, 59, 0, 0) / 1000);
  const gameDateSeconds = Math.max(now + 120, Math.min(now + 2 * 3_600, endOfDay));
  const registrationEndsSeconds = now + Math.floor((gameDateSeconds - now) / 2);
  return {
    kind: "game",
    nextGame: null,
    gameIndex: 43,
    gameDateSeconds,
    registrationEndsSeconds,
    playEndsSeconds: gameDateSeconds + 300,
    airdropsScheduled: 1,
    phase: {
      label: "registration",
      nextDeadlineSeconds: registrationEndsSeconds,
      secondsRemaining: registrationEndsSeconds - now,
    },
    registered: false,
    liteSignUp: null,
  };
}

/** DEV-only name upgrade on offer: the member fixture still carries its
 *  number, so the home shows the row; nobody else is offered one. */
export function devUsernameClaimFixture(
  demo: PrizeDemoState,
): { currentUsername: string; onOpen: () => void } | undefined {
  return demo === "member-new"
    ? { currentUsername: "marlow.42", onOpen: () => undefined }
    : undefined;
}

/** DEV-only: whether the fixture holds an open ticket. A member whose name
 *  still carries its number has none yet; a consumed demo has none left. */
export function devTicketOpen(demo: PrizeDemoState): boolean {
  return demo !== "win" && demo !== "miss" && demo !== "member-new" && demo !== "promotion";
}
