// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import type { Hex32 } from "@individuality/daily-dollar";
import {
  DAILY_DOLLAR_CHAT_COPY,
  DAILY_DOLLAR_COPY,
  assertAscii,
} from "./copy";
import type { DrawRecord } from "./registry";

const NOW = 1_000_000;
const EVENT_A = `0x${"1".padStart(64, "0")}` as Hex32;

function record(overrides: Partial<DrawRecord> = {}): DrawRecord {
  return {
    eventId: EVENT_A,
    drawIndex: "7",
    status: "Registering",
    // 1970-01-12T14:03:20Z and 1970-01-12T16:33:20Z.
    drawTimeSeconds: NOW + 1_000,
    endTimeSeconds: NOW + 10_000,
    prizeAmount: "1000000",
    registration: {
      state: "registered",
      source: "worker",
      attempts: 1,
      lastAttemptSeconds: NOW,
      nextAttemptSeconds: null,
      txHash: null,
      error: null,
    },
    outcome: "pending",
    notifications: [],
    notificationError: null,
    notificationRetrySeconds: null,
    scratchedAtSeconds: null,
    announced: [],
    updatedAtSeconds: NOW,
    ...overrides,
  };
}

describe("assertAscii", () => {
  it("rejects the characters the host would mangle", () => {
    // The guard the ASCII assertions below rest on: if it accepted these, a
    // curly quote or an emoji could reach a notification unnoticed.
    expect(() => assertAscii("you won \u2014 nice")).toThrow(/ASCII/);
    expect(() => assertAscii("Today\u2019s draw")).toThrow(/ASCII/);
    expect(() => assertAscii("prize \u{1F389}")).toThrow(/ASCII/);
    expect(assertAscii("Open Humanity to claim.")).toBe(
      "Open Humanity to claim.",
    );
  });
});

describe("DAILY_DOLLAR_COPY", () => {
  it("never names the outcome: a winner's push reads like everyone's", () => {
    const invite = DAILY_DOLLAR_COPY.claimWindow(record());

    expect(assertAscii(invite)).toBe("Scratch now, you may have won a dollar today.");
    expect(DAILY_DOLLAR_COPY.won(record({ outcome: "won" }))).toBe(invite);
  });

  it("ignores the prize amount and timestamps", () => {
    const invite = DAILY_DOLLAR_COPY.claimWindow(record());

    for (const overrides of [
      { prizeAmount: "not-a-number" },
      { prizeAmount: "23420000" },
      { drawTimeSeconds: 0, endTimeSeconds: 0 },
    ]) {
      expect(DAILY_DOLLAR_COPY.won(record({ outcome: "won", ...overrides }))).toBe(invite);
    }
  });

  // The paseo-next-v2 schedule: draw 2026-10-07 11:30Z, claim window shut at
  // 2026-10-08 11:30Z, the moment draw #48 resolved.
  const daily = { drawTimeSeconds: 1_791_372_600, endTimeSeconds: 1_791_459_000 };

  it("tells an unopened ticket it missed yesterday's draw, without saying what was under it", () => {
    for (const outcome of ["won", "miss"] as const) {
      expect(assertAscii(DAILY_DOLLAR_COPY.missed(record({ outcome, ...daily })))).toBe(
        "You missed yesterday's chance to win a dollar.",
      );
    }
  });

  it("never calls the missed draw today's", () => {
    // A non-daily window ends at no fixed distance from the draw, so it names no day.
    for (const window of [9_000, 2 * 86_400]) {
      const missed = DAILY_DOLLAR_COPY.missed(record({ drawTimeSeconds: NOW, endTimeSeconds: NOW + window }));
      expect(assertAscii(missed)).toBe("Your Daily Dollar ticket expired before you scratched it.");
    }
  });
});

describe("DAILY_DOLLAR_CHAT_COPY", () => {
  it("says the same thing the claim-window reminder says", () => {
    // One piece of news, two routes to the same person: a push and a chat
    // line that worded it differently would read as two draws.
    const line = DAILY_DOLLAR_CHAT_COPY.scratchable(record({ outcome: "won" }));

    expect(assertAscii(line.text)).toBe("Scratch now, you may have won a dollar today.");
    expect(line.text).toBe(DAILY_DOLLAR_COPY.claimWindow(record()));
  });

  it("offers a Scratch button that opens the Pocket card", () => {
    const { buttons } = DAILY_DOLLAR_CHAT_COPY.scratchable(record({ outcome: "won" }));

    expect(buttons).toEqual([{ actionId: "open-card", title: "Scratch" }]);
    for (const { actionId, title } of buttons ?? []) {
      assertAscii(actionId);
      assertAscii(title);
    }
  });

  it("names the prize and nothing about claiming it", () => {
    // Posted around the moment the app claims, so a deadline or a balance
    // line could already be wrong - "Claim it before" a prize already claimed.
    for (const outcome of ["won", "claimed"] as const) {
      const { text } = DAILY_DOLLAR_CHAT_COPY.wonResult(record({ outcome }));

      expect(assertAscii(text)).toBe("You scratched a winner: $1!");
    }
  });

  it("falls back to the product's own name for an unreadable prize", () => {
    const { text } = DAILY_DOLLAR_CHAT_COPY.wonResult(
      record({ outcome: "won", prizeAmount: "0" }),
    );

    expect(assertAscii(text)).toContain("a dollar");
    expect(text).not.toContain("NaN");
  });

  it("points at the next draw on a miss rather than dwelling", () => {
    const line = DAILY_DOLLAR_CHAT_COPY.missResult(record({ outcome: "miss" }));

    expect(line.text).toBe("No dollar this time. The next draw is coming.");
    expect(line.card).toMatchObject({ kind: "miss" });
    assertAscii(line.text);
    expect(line).not.toHaveProperty("buttons");
  });
});
