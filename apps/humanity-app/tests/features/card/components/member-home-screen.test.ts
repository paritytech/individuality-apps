// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** MemberHomeScreen, per state: the story ladder only while there is a rung
 *  to climb, the attendance row only for member-family cards, the dollar
 *  tile only while a ticket is open, the name row only while the claim is on
 *  offer, no play button without a card, and nothing anywhere about money
 *  won or the chain's words. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  // `renderToStaticMarkup` reads a zustand store's *initial* state (the server
  // snapshot), so the toggle is mocked rather than set.
  cardHidden: true,
  useRegisterForGame: vi.fn(
    (): { register: () => void; registering: boolean; registeringLabel: string | null; error: string | null } => ({
      register: () => undefined,
      registering: false,
      registeringLabel: null,
      error: null,
    }),
  ),
  /** The home's wall clock; the real one unless a test pins it. */
  nowSeconds: vi.fn(() => Math.floor(Date.now() / 1000)),
}));

vi.mock("@features/card/hooks/use-register-for-game.ts", () => ({
  useRegisterForGame: mocks.useRegisterForGame,
}));

vi.mock("@shared/hooks/use-now-seconds.ts", () => ({
  useNowSeconds: mocks.nowSeconds,
}));

vi.mock("@features/debug/debug-store.ts", () => ({
  useDebugStore: (select: (state: { cardHidden: boolean }) => unknown) =>
    select({ cardHidden: mocks.cardHidden }),
}));

import {
  MemberHomeScreen,
  type MemberHomeScreenProps,
} from "@features/card/components/MemberHomeScreen.tsx";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import { formatGameTime } from "@features/card/domain/game-schedule.ts";

const now = 1_800_000_000;
const DAY = 86_400;
const HOUR = 3_600;

function game(registered = true): CurrentGameResult {
  return {
    kind: "game",
    nextGame: null,
    gameIndex: 7,
    gameDateSeconds: now + 7 * DAY,
    registrationEndsSeconds: now + 3 * HOUR,
    playEndsSeconds: now + 3 * HOUR + 300,
    airdropsScheduled: 1,
    phase: {
      label: "registration",
      nextDeadlineSeconds: now + 3 * HOUR,
      secondsRemaining: 3 * HOUR,
    },
    registered,
    liteSignUp: null,
  };
}

const member: HumanityCardState = {
  kind: "member",
  activeWeeks: 4,
  lastAttendedGame: 42,
  attendanceHistory: 0b1110_1111,
  window: 8,
};
const candidate: HumanityCardState = {
  kind: "candidate",
  score: 1,
  personhoodThreshold: 5,
  gamesRemaining: 1,
};
const caution: HumanityCardState = {
  kind: "caution",
  activeWeeks: 0,
  misses: 2,
  allowedMisses: 1,
  window: 8,
  lastAttendedGame: 41,
  attendanceHistory: 0b1100_1110,
};

function render(state: HumanityCardState, extra: Partial<MemberHomeScreenProps> = {}): string {
  return renderToStaticMarkup(
    createElement(MemberHomeScreen, {
      state,
      accountAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      displayName: "marlow",
      game: game(),
      gamePending: false,
      gameUnavailable: false,
      onOpenPrize: () => undefined,
      dailyPrizeAvailable: true,
      ...extra,
    }),
  );
}

describe("MemberHomeScreen, the story ladder", () => {
  it("marks the first rung for a person and offers the first game", () => {
    const html = render({ kind: "devicehood", personhoodThreshold: 6 }, { game: game(false), displayName: "marlow.42" });
    expect(html).toContain("Become a member");
    expect(html).toContain("How membership works");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("You&#x27;re here");
    expect(html).toContain("Register");
    expect(html).toContain("A name without numbers, and a daily chance to win a dollar.");
    expect(html).not.toContain("marlow instead of marlow.42");
    expect(html).not.toContain("Attendance");
    expect(html).not.toContain("Win a dollar today");
  });

  it("promises the change under a person's saved seat", () => {
    const html = render({ kind: "devicehood" });
    expect(html).toContain("Registered");
    expect(html).toContain("Your card updates after you play.");
  });

  it("marks the second rung for a candidate with the first one done", () => {
    const html = render(candidate);
    expect(html).toContain("Almost a member");
    expect(html).toContain("How membership works");
    expect(html).toContain("story-row is-done");
    expect(html).toContain("story-row is-current");
    expect(html).not.toContain("Win a dollar today");
    expect(html).not.toContain("Attendance");
  });

  it("holds a not-enrolled card without a play button", () => {
    const html = render({ kind: "not-enrolled" });
    expect(html).toContain("Your card isn&#x27;t ready yet");
    expect(html).toContain("How membership works");
    expect(html).not.toContain('aria-current="step"');
    expect(html).not.toContain("Next game");
    expect(html).not.toContain("cta-pill");
  });

  it("drops the ladder once the person has arrived", () => {
    for (const state of [member, caution, { kind: "suspended", reason: "attendance" } as const]) {
      expect(render(state), state.kind).not.toContain("How membership works");
    }
  });
});

describe("MemberHomeScreen, the member rows", () => {
  it("shows the recent games, the streak and the open ticket", () => {
    const html = render(member);
    expect(html).not.toContain("under-card");
    expect(html).toContain("Attendance");
    expect(html).toContain("4 in a row");
    expect(html).toContain("last 8 games");
    expect((html.match(/class="mark is-attended/g) ?? []).length).toBe(7);
    expect((html.match(/class="mark is-missed/g) ?? []).length).toBe(1);
    expect(html).toContain("Win a dollar today");
  });

  it("hides the ticket once it is consumed and never shows a total", () => {
    const html = render(member, { dailyPrizeAvailable: false });
    expect(html).not.toContain("Win a dollar today");
    expect(html).not.toMatch(/Your dollars|won so far|\$\d/);
  });

  it("offers the name upgrade only when it is on offer, and only to a member", () => {
    const usernameClaim = { currentUsername: "marlow.42", onOpen: () => undefined };
    expect(render(member)).not.toContain("Claim your member username");
    expect(render(member, { usernameClaim })).toContain("Choose a name to replace marlow.42");
    expect(render(caution, { usernameClaim })).not.toContain("Claim your member username");
    expect(render({ kind: "devicehood" }, { usernameClaim })).not.toContain("Claim your member username");
  });

  it("shows the registration's quiet line, and no button for it", () => {
    const ready: HumanityCardState = { ...member, kind: "membership-ready" } as HumanityCardState;
    const line = "Your Polkadot app can't finish this yet. Update it and try again.";
    const html = render(ready, { membershipNote: line });
    expect(html).toContain("Your Polkadot app can&#x27;t finish this yet. Update it and try again.");
    expect(html).not.toContain("Finish becoming a member");
    expect(render(ready)).not.toContain("membership-note");
    // Above the next game, below the line under the card.
    expect(html.indexOf("membership-note")).toBeGreaterThan(html.indexOf("under-card"));
    expect(html.indexOf("membership-note")).toBeLessThan(html.indexOf("game-block"));
    // The name claim stays a member's: it appears once the card reads member.
    const usernameClaim = { currentUsername: "marlow.42", onOpen: () => undefined };
    expect(render(ready, { usernameClaim })).not.toContain("Claim your member username");
  });

  it("never renders the inline name claim form", () => {
    expect(render(member)).not.toContain("Claim this name");
    expect(render({ kind: "devicehood" })).not.toContain("Your new name");
  });
});

describe("MemberHomeScreen, caution and suspended", () => {
  it("folds the deadline into the next-game block for a cautioned member", () => {
    const html = render(caution);
    expect(html).toContain("Membership at risk");
    // The fixture game sits far out from the real clock, so the line dates it.
    expect(html).toMatch(/Play (this|on) [^<]+ to keep it\./);
    expect(html).toContain("game-block is-caution");
    expect(html).toMatch(/\d+ days left/);
    expect(html).toContain("One game keeps your membership.");
    expect(html).toContain("Missed the last game");
    expect(html).toContain("Win a dollar today");
  });

  it("offers a suspended member the way back", () => {
    const html = render({ kind: "suspended", reason: "attendance" }, { game: game(false) });
    expect(html).toContain("Membership paused");
    expect(html).toContain("Register");
    expect(html).not.toContain("Attendance");
    expect(html).not.toContain("Win a dollar today");
  });
});

describe("MemberHomeScreen card", () => {
  // The card is drawn only when the debug panel shows it.
  beforeEach(() => {
    mocks.cardHidden = false;
  });
  afterEach(() => {
    mocks.cardHidden = true;
  });

  it("renders the card interactive, with the glyph as the flip control", () => {
    const html = render(member, { qrPayload: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" });
    // A member's card carries no stripe.
    expect(html).toMatch(/class="idcard [^"]*is-interactive/);
    expect(html).not.toMatch(/class="idcard [^"]*has-stripe/);
    expect(html).toContain("is-interactive");
    expect(html).toContain('aria-label="Flip the card"');
    expect(html).toContain("data-summon-ignore");
    expect(html).toContain("Scan from the Polkadot app to start a chat");
    expect(html).not.toContain("is-flipped");
  });

  it("marks every hint target and shows no hint until a visit picks one", () => {
    const usernameClaim = { currentUsername: "marlow.42", onOpen: () => undefined };
    const html = render(member, { usernameClaim, game: game(false), hints: { enabled: true } });
    expect(html).toContain('data-hint="card"');
    const person = render({ kind: "devicehood" }, { game: game(false), hints: { enabled: true } });
    expect(person).toContain('data-hint="register"');
    expect(render(candidate)).toContain('data-hint="stripe"');
    expect(render({ kind: "devicehood", personhoodThreshold: 6 })).toContain('data-hint="stripe"');
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain("aria-describedby");
  });

  it("draws the back without a code when there is no payload", () => {
    const html = render(member, { qrPayload: null });
    expect(html).not.toContain("idcard-qr-relief");
    expect(html).not.toContain("Scan from the Polkadot app");
  });
});

describe("MemberHomeScreen, the last-day sheet", () => {
  // "Today" is wall-clock relative: pin midday so wall + 3h never crosses midnight.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 8, 17, 12)); });
  afterEach(() => { vi.useRealTimers(); });
  const today = (registered: boolean): CurrentGameResult => {
    const wall = Math.floor(Date.now() / 1000);
    const base = game(registered);
    if (base.kind !== "game") throw new Error("fixture is a game");
    return {
      ...base,
      gameDateSeconds: wall + 3 * HOUR,
      registrationEndsSeconds: wall + HOUR,
      playEndsSeconds: wall + HOUR + 300,
      phase: { label: "registration", nextDeadlineSeconds: wall + HOUR, secondsRemaining: HOUR },
    };
  };

  it("lays the sheet over a cautioned home on the day of the game", () => {
    const html = render(caution, { game: today(false), cautionSheet: { enabled: true, persist: false } });
    expect(html).toContain('class="caution-sheet"');
    expect(html).toContain("Last game to keep your membership.");
    expect(html).toContain("Not this week");
    expect(html).toContain("today");
  });

  it("shows no sheet on other days, for other states, or when not asked", () => {
    expect(render(caution, { cautionSheet: { enabled: true, persist: false } })).not.toContain('class="caution-sheet"');
    expect(render(member, { game: today(true), cautionSheet: { enabled: true, persist: false } })).not.toContain('class="caution-sheet"');
    expect(render(caution, { game: today(false) })).not.toContain('class="caution-sheet"');
  });
});

describe("MemberHomeScreen vocabulary", () => {
  it("keeps the chain's words off every state", () => {
    const states: HumanityCardState[] = [
      { kind: "not-enrolled" },
      { kind: "devicehood" },
      candidate,
      member,
      caution,
      { kind: "suspended", reason: "attendance" },
    ];
    const banned = /devicehood|personhood|\blite\b|score|wallet|meet in person|prize draws|\u2014/i;
    for (const state of states) {
      const html = render(state);
      const text = html.replace(/<[^>]+>/g, " ");
      expect(text, state.kind).not.toMatch(banned);
      // What a screen reader or a hover reads is copy too.
      const attributes = [...html.matchAll(/(?:aria-label|title)="([^"]*)"/g)].map((m) => m[1]).join(" | ");
      expect(attributes, state.kind).not.toMatch(banned);
    }
  });
});

describe("MemberHomeScreen, registering from here", () => {
  it("signs the game account up with the sign-up hook and shows a plain Register", () => {
    mocks.useRegisterForGame.mockClear();
    const html = render({ kind: "devicehood" }, { game: game(false), seatAccount: "5DIM2Seat" });
    expect(html).toContain("Register");
    expect(html).toContain('data-hint="register"');
    expect(html).not.toMatch(/Reserve|seat/i);
    expect(mocks.useRegisterForGame).toHaveBeenCalledWith(
      "5DIM2Seat",
      expect.objectContaining({ kind: "game", registered: false }),
      expect.any(Function),
    );
  });

  it("holds Register while the sign-up is in flight", () => {
    mocks.useRegisterForGame.mockReturnValueOnce({
      register: () => undefined,
      registering: true,
      registeringLabel: null,
      error: null,
    });
    const html = render({ kind: "devicehood" }, { game: game(false) });
    expect(html).toContain("Registering…");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("says the seat is getting ready while the bind and the name link land", () => {
    mocks.useRegisterForGame.mockReturnValueOnce({
      register: () => undefined,
      registering: true,
      registeringLabel: "Getting your seat ready…",
      error: null,
    });
    const html = render({ kind: "devicehood" }, { game: game(false) });
    expect(html).toContain("Getting your seat ready…");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("holds Register while a recorded sign-up of the account is under way", () => {
    const html = render({ kind: "devicehood" }, { game: game(false), signUpUnderWay: true });
    expect(html).toContain("Registering…");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("shows a failed sign-up under Register", () => {
    mocks.useRegisterForGame.mockReturnValueOnce({
      register: () => undefined,
      registering: false,
      registeringLabel: null,
      error: "You cancelled the approval.",
    });
    const html = render({ kind: "devicehood" }, { game: game(false) });
    expect(html).toContain("You cancelled the approval.");
  });
});

describe("MemberHomeScreen, the caution deadline in calendar days", () => {
  // Thursday 17 September 2026, 10:00 local.
  const thursday = new Date(2026, 8, 17, 10).getTime() / 1000;
  const openOn = (gameDateSeconds: number, registered = false): CurrentGameResult =>
    ({
      ...game(registered),
      gameDateSeconds,
      registrationEndsSeconds: gameDateSeconds - HOUR,
      playEndsSeconds: gameDateSeconds - HOUR + 300,
      phase: { label: "registration", nextDeadlineSeconds: gameDateSeconds - HOUR, secondsRemaining: HOUR },
    }) as CurrentGameResult;
  function renderAt(state: HumanityCardState, gameDateSeconds: number, registered = false): string {
    mocks.nowSeconds.mockReturnValue(thursday);
    try {
      return render(state, {
        game: openOn(gameDateSeconds, registered),
        cautionSheet: { enabled: true, persist: false },
      });
    } finally {
      mocks.nowSeconds.mockImplementation(() => Math.floor(Date.now() / 1000));
    }
  }

  it("counts whole days to the game on the block's chip", () => {
    const saturday = new Date(2026, 8, 19, 19).getTime() / 1000;
    const weekday = new Date(saturday * 1000).toLocaleDateString(undefined, { weekday: "long" });
    const later = renderAt(caution, saturday);
    expect(later).toContain("2 days left");
    expect(later).toContain(`Play this ${weekday} to keep it.`);
    // Tomorrow evening is 33 hours out, and still reads as tomorrow.
    const tomorrow = renderAt(caution, new Date(2026, 8, 18, 19).getTime() / 1000);
    expect(tomorrow).toContain("tomorrow");
    expect(tomorrow).toContain("Play tomorrow to keep it.");
    expect(tomorrow).not.toContain('class="caution-sheet"');
  });

  it("raises the last-day sheet on the game's day, offering to register", () => {
    const html = renderAt(caution, new Date(2026, 8, 17, 19).getTime() / 1000);
    expect(html).toContain('class="caution-sheet"');
    expect(html).toContain("Play today to keep it.");
    expect(html).toContain(`Today at ${formatGameTime(new Date(2026, 8, 17, 19).getTime() / 1000)}`);
    expect(html).toContain("Last game to keep your membership.");
    expect(html).toContain("Not this week");
  });

  it("tells a member who already registered that they are registered", () => {
    const html = renderAt(caution, new Date(2026, 8, 17, 19).getTime() / 1000, true);
    const sheet = html.slice(html.indexOf('class="caution-sheet"'));
    expect(sheet).toContain("Registered");
    expect(sheet).not.toMatch(/>Register</);
  });

  it("raises no sheet for a member playing the same game", () => {
    const html = renderAt(member, new Date(2026, 8, 17, 19).getTime() / 1000);
    expect(html).not.toContain("caution-sheet");
  });

  it("says when registration closes on the sheet", () => {
    const html = renderAt(caution, new Date(2026, 8, 17, 19).getTime() / 1000);
    expect(html).toContain("Registration closes in");
  });

  it("dates a game a week out rather than naming this week's weekday", () => {
    const nextThursday = new Date(2026, 8, 24, 19).getTime() / 1000;
    const html = renderAt(caution, nextThursday);
    expect(html).toContain("7 days left");
    expect(html).not.toMatch(/Play this /);
    expect(html).toMatch(/Play on [^<]+ to keep it\./);
  });

  it("names no day once there is nothing left to act on", () => {
    mocks.nowSeconds.mockReturnValue(thursday);
    try {
      const closed = {
        ...openOn(new Date(2026, 8, 17, 19).getTime() / 1000),
        registrationEndsSeconds: thursday - HOUR,
        playEndsSeconds: thursday - HOUR + 300,
      } as CurrentGameResult;
      const html = render(caution, { game: closed, cautionSheet: { enabled: true, persist: false } });
      expect(html).toContain("Play the next game to keep it.");
      expect(html).not.toContain("caution-sheet");
    } finally {
      mocks.nowSeconds.mockImplementation(() => Math.floor(Date.now() / 1000));
    }
  });
});

describe("MemberHomeScreen, the suspended card", () => {
  it("fades the suspended card face", () => {
    mocks.cardHidden = false;
    try {
      const html = render({ kind: "suspended", reason: "attendance" });
      expect(html).toMatch(/class="idcard [^"]*\bis-faded\b[^"]*\bis-suspended\b/);
      expect(render(member)).not.toContain("is-faded");
    } finally {
      mocks.cardHidden = true;
    }
  });

  it("sinks the avatar and wordmark into the faded face but keeps the name at full ink", () => {
    const css = readFileSync(
      new URL("../../../../src/features/card/styles/idcard-states.css", import.meta.url),
      "utf8",
    );
    const faded = (part: string): number | null => {
      const rule = new RegExp(`\\.idcard\\.is-faded \\.${part} \\{ opacity: ([0-9.]+); \\}`).exec(css);
      return rule == null ? null : Number(rule[1]);
    };
    expect(faded("idcard-avatar")).toBeLessThan(1);
    // The wordmark's resting opacity on every other face is 0.14.
    expect(faded("idcard-wordmark")).toBeLessThan(0.14);
    expect(css).not.toMatch(/\.idcard\.is-faded \.idcard-(top|name|idcol)\b/);
  });

  it("picks the paused line from whether the games already cover the way back", () => {
    const suspended = { kind: "suspended", reason: "attendance" } as const;
    expect(render(suspended, { suspendedRecovery: "ready" })).toContain(
      "Register for the next game to pick up where you left off.",
    );
    expect(render(suspended, { suspendedRecovery: "play" })).toContain("It can take more than one.");
    expect(render(suspended)).toContain("Register for another game to restart your membership journey.");
  });
});

describe("MemberHomeScreen, the card toggle", () => {
  it("draws no card by default: the host's Pocket card is the card", () => {
    const html = render(candidate, { game: game(false) });
    expect(html).not.toContain("idcard");
    expect(html).not.toContain('data-hint="card"');
    expect(html).not.toContain('data-hint="stripe"');
    expect(html).toContain("Next game");
  });

  it("draws its own card, face up with its back hidden, when the panel shows it", () => {
    mocks.cardHidden = false;
    try {
      const html = render(member, { game: game(false) });
      expect(html).toContain('aria-label="Flip the card"');
      expect(html).toContain('class="idcard-back" aria-hidden="true"');
    } finally {
      mocks.cardHidden = true;
    }
  });
});

describe("MemberHomeScreen, end-to-end hooks", () => {
  it("marks the home column and the card with the card's state and owner", () => {
    mocks.cardHidden = false;
    try {
      const owner = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
      const html = render(candidate, { ownerAccount: owner });
      expect(html).toMatch(/class="body-col member-home-col"[^>]*data-testid="humanity-home" data-card-state="candidate"/);
      expect(html).toContain('data-testid="membership-card"');
      expect((html.match(/data-card-state="candidate"/g) ?? []).length).toBe(2);
      expect(html).toContain(`data-account="${owner}"`);
      expect(render(member)).not.toContain("data-account");
    } finally {
      mocks.cardHidden = true;
    }
  });
});
