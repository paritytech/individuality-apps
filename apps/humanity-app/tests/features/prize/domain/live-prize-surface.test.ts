// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  liveTicketLabels,
  resolveLiveSurface,
  restoreSettledWin,
} from "@features/prize/domain/live-prize-surface.ts";
import {
  EVENT_ID,
  NOW,
  participation,
  standing,
} from "./live-prize-surface.fixtures.ts";

describe("resolveLiveSurface", () => {
  it("never shows a loading state: no standing yet renders the resting copy", () => {
    const pending = resolveLiveSurface(undefined, NOW);
    expect(pending).toEqual({
      kind: "empty",
      message: "Today's dollar isn't open yet.",
    });
    expect(pending.kind === "empty" && pending.message).not.toMatch(/…|reading|loading/i);
  });

  it("yields the no-draws message when the standing is empty", () => {
    expect(resolveLiveSurface(standing([]), NOW)).toEqual({
      kind: "empty",
      message: "No draws are scheduled on People Chain yet.",
    });
  });

  it("yields the not-yet-drawn copy when a registration is open", () => {
    const open = participation("Registering", {
      winner: false,
      drawTimeSeconds: NOW + 3600,
      endTimeSeconds: NOW + 7200,
    });
    expect(resolveLiveSurface(standing([open]), NOW)).toEqual({
      kind: "empty",
      message:
        "Registration is open for today's dollar. The draw hasn't happened yet.",
    });
  });

  it("yields the scheduled copy when only a Scheduled draw exists", () => {
    const scheduled = participation("Scheduled", {
      drawTimeSeconds: NOW + 7200,
      endTimeSeconds: NOW + 10800,
    });
    expect(resolveLiveSurface(standing([scheduled]), NOW)).toEqual({
      kind: "empty",
      message: "Today's dollar isn't open yet. Come back when registration opens.",
    });
  });

  it("yields the drawing copy for an AwaitingEntropy draw", () => {
    const mid = participation("AwaitingEntropy", {
      drawTimeSeconds: NOW - 60,
      endTimeSeconds: NOW + 3600,
    });
    expect(resolveLiveSurface(standing([mid]), NOW)).toEqual({
      kind: "empty",
      message: "Today's dollar is being drawn. Check back in a moment.",
    });
  });

  it("maps a Claiming winner to a win ticket", () => {
    const win = participation("Claiming", { winner: true, effectiveWinners: 5, totalParticipants: 200 });
    expect(resolveLiveSurface(standing([win]), NOW)).toEqual({
      kind: "ticket",
      outcome: "win",
      eventId: EVENT_ID,
      labels: {
        amountLabel: "$1",
        dateLabel: "FRIDAY 15 JANUARY",
        oddsLabel: "Odds today: 1 in 40",
      },
    });
  });

  it("maps a Claiming non-winner to a miss ticket", () => {
    const miss = participation("Claiming", { winner: false, effectiveWinners: 5, totalParticipants: 200 });
    expect(resolveLiveSurface(standing([miss]), NOW)).toEqual({
      kind: "ticket",
      outcome: "miss",
      eventId: EVENT_ID,
      labels: {
        amountLabel: "$1",
        dateLabel: "FRIDAY 15 JANUARY",
        oddsLabel: "Odds today: 1 in 40",
      },
    });
  });

  // `winner` reads false for any alias without a Winners entry, so an
  // unregistered draw must not surface as a scratchable miss.
  it.each([false, null])("yields no ticket for a Claiming draw with registered=%s", (registered) => {
    const bystander = { ...participation("Claiming", { winner: false }), registered };
    expect(resolveLiveSurface(standing([bystander]), NOW)).toEqual({
      kind: "empty",
      message: "No draws are open on People Chain right now.",
    });
  });

  it("still surfaces a claimed win when the registration can no longer be read", () => {
    const claimed = { ...participation("Claiming", { winner: false }), registered: null, claimed: true };
    expect(resolveLiveSurface(standing([claimed]), NOW)).toMatchObject({
      kind: "ticket",
      outcome: "win",
    });
  });

  it("keeps a claimed winner as a win after the runtime removes its winner entry", () => {
    const claimed = {
      ...participation("Claiming", {
        winner: false,
        effectiveWinners: 1,
        totalParticipants: 1,
      }),
      claimed: true,
    };

    expect(resolveLiveSurface(standing([claimed]), NOW)).toEqual({
      kind: "ticket",
      outcome: "win",
      eventId: EVENT_ID,
      labels: {
        amountLabel: "$1",
        dateLabel: "FRIDAY 15 JANUARY",
        oddsLabel: "Odds today: 1 in 1",
      },
    });
  });

  it("skips a Claiming draw whose window has already closed", () => {
    const expired = participation("Claiming", {
      winner: true,
      drawTimeSeconds: NOW - 7200,
      endTimeSeconds: NOW - 60,
    });
    expect(resolveLiveSurface(standing([expired]), NOW)).toEqual({
      kind: "empty",
      message: "No draws are open on People Chain right now.",
    });
  });
});

describe("restoreSettledWin", () => {
  const miss = resolveLiveSurface(
    standing([
      participation("Claiming", {
        winner: false,
        effectiveWinners: 1,
        totalParticipants: 1,
      }),
    ]),
    NOW,
  );

  it("restores a claimed win from the persisted settlement ledger", () => {
    expect(restoreSettledWin(miss, false, true)).toMatchObject({
      kind: "ticket",
      outcome: "win",
      eventId: EVENT_ID,
    });
  });

  it("does not invent a win while settlement is loading", () => {
    expect(restoreSettledWin(miss, true, true)).toBe(miss);
  });

  it("keeps an unsettled miss unchanged", () => {
    expect(restoreSettledWin(miss, false, false)).toBe(miss);
  });
});

describe("liveTicketLabels", () => {
  it("uses effective winners and the draw's UTC draw date", () => {
    expect(liveTicketLabels(participation("Claiming", { winner: true, effectiveWinners: 5, totalParticipants: 200 }))).toEqual({
      amountLabel: "$1",
      dateLabel: "FRIDAY 15 JANUARY",
      oddsLabel: "Odds today: 1 in 40",
    });
  });

  it("drops the odds line when the participants count is unknown", () => {
    const blind = participation("Registering", {
      totalParticipants: null,
      effectiveWinners: null,
      drawTimeSeconds: NOW + 60,
      endTimeSeconds: NOW + 3600,
    });
    expect(liveTicketLabels(blind).oddsLabel).toBe("");
  });
});
