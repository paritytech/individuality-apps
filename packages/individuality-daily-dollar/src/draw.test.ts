// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  claimableDraw,
  pendingRegistrations,
  type AirdropDraw,
  type AirdropParticipation,
  type AirdropStanding,
  type Hex32,
} from "./draw";

const ZERO_HEX =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;

function draw(
  status: AirdropDraw["status"],
  overrides: Partial<{
    drawTimeSeconds: number;
    endTimeSeconds: number;
    eventId: Hex32;
  }> = {},
): AirdropDraw {
  return {
    eventId: overrides.eventId ?? ZERO_HEX,
    drawIndex: 0n,
    status,
    registrationStartsSeconds: 0,
    drawTimeSeconds: overrides.drawTimeSeconds ?? 1_000,
    endTimeSeconds: overrides.endTimeSeconds ?? 2_000,
    prizeAmount: 1_000n,
    assetId: null,
    maxWinners: 1,
    totalParticipants: 0,
    effectiveWinners: 0,
    claimed: 0,
  };
}

function participation(
  draw: AirdropDraw,
  overrides: Partial<
    Pick<AirdropParticipation, "slot" | "registered" | "winner" | "claimed">
  > = {},
): AirdropParticipation {
  return {
    draw,
    slot: ZERO_HEX,
    registered: false,
    winner: false,
    claimed: null,
    ...overrides,
  };
}

const standing = (participations: AirdropParticipation[]): AirdropStanding => ({
  participations,
  alias: ZERO_HEX,
  airdropsContext: ZERO_HEX,
  aliasContext: ZERO_HEX,
  contextMatches: true,
  atBlockHash: ZERO_HEX,
});

describe("pendingRegistrations", () => {
  it("includes only Registering, un-registered, derivable-slot, before-draw", () => {
    const eligible = participation(draw("Registering", { drawTimeSeconds: 1_500 }), {
      registered: false,
      slot: ZERO_HEX,
    });
    expect(pendingRegistrations(standing([eligible]), 1_000)).toEqual([eligible]);
  });

  it("excludes a Registering draw whose registration state is unknown (null)", () => {
    expect(
      pendingRegistrations(
        standing([
          participation(draw("Registering", { drawTimeSeconds: 1_500 }), {
            registered: null,
            slot: ZERO_HEX,
          }),
        ]),
        1_000,
      ),
    ).toEqual([]);
  });

  it("includes an open draw when the dedicated account has no alias yet", () => {
    const eligible = participation(draw("Registering", { drawTimeSeconds: 1_500 }), {
      registered: null,
      slot: null,
    });
    const unbound: AirdropStanding = {
      ...standing([eligible]),
      alias: null,
      aliasContext: null,
      contextMatches: false,
    };

    expect(pendingRegistrations(unbound, 1_000)).toEqual([eligible]);
  });

  it("excludes a Registering draw with no derivable slot", () => {
    expect(
      pendingRegistrations(
        standing([
          participation(draw("Registering", { drawTimeSeconds: 1_500 }), {
            registered: false,
            slot: null,
          }),
        ]),
        1_000,
      ),
    ).toEqual([]);
  });

  it("excludes draws whose registration window has already passed", () => {
    expect(
      pendingRegistrations(
        standing([
          participation(draw("Registering", { drawTimeSeconds: 900 }), {
            registered: false,
            slot: ZERO_HEX,
          }),
        ]),
        1_000,
      ),
    ).toEqual([]);
  });

  it("excludes draws not in the Registering status", () => {
    expect(
      pendingRegistrations(
        standing([
          participation(draw("Scheduled", { drawTimeSeconds: 1_500 }), {
            registered: false,
            slot: ZERO_HEX,
          }),
          participation(draw("Claiming", { drawTimeSeconds: 1_500 }), {
            registered: false,
            slot: ZERO_HEX,
          }),
        ]),
        1_000,
      ),
    ).toEqual([]);
  });
});

describe("claimableDraw", () => {
  it("picks the earliest-closing eligible draw among multiple", () => {
    const later = participation(
      draw("Claiming", { drawTimeSeconds: 500, endTimeSeconds: 1_500 }),
      { winner: true },
    );
    const earlier = participation(
      draw("Claiming", { drawTimeSeconds: 500, endTimeSeconds: 1_200 }),
      { winner: true },
    );
    const result = claimableDraw(standing([later, earlier]), 1_000);
    expect(result?.draw.eventId).toBe(earlier.draw.eventId);
  });

  it("returns undefined for a draw the person did not win", () => {
    expect(
      claimableDraw(
        standing([
          participation(draw("Claiming", { endTimeSeconds: 1_500 }), { winner: false }),
        ]),
        1_000,
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an un-Claiming status", () => {
    expect(
      claimableDraw(
        standing([
          participation(draw("Registering", { endTimeSeconds: 1_500 }), { winner: true }),
          participation(draw("AwaitingEntropy", { endTimeSeconds: 1_500 }), { winner: true }),
        ]),
        1_000,
      ),
    ).toBeUndefined();
  });

  it("returns undefined when the claim window has elapsed", () => {
    expect(
      claimableDraw(
        standing([
          participation(draw("Claiming", { endTimeSeconds: 800 }), { winner: true }),
        ]),
        1_000,
      ),
    ).toBeUndefined();
  });
});
