// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { usernameClaimTarget } from "@humanity/shared/card/username-claim.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";

function card(
  overrides: Partial<Extract<HumanityCardResult, { kind: "card" }>> = {},
): Extract<HumanityCardResult, { kind: "card" }> {
  return {
    kind: "card",
    primaryUsername: "alice.42.dot",
    accountAddress: "5Alice",
    ownerAccount: "5Alice",
    participant: null,
    devicehood: null,
    membershipStanding: null,
    devicehoodRing: null,
    deviceKeyCheck: null,
    playerIdentities: { accountAddress: "5Candidate" },
    state: { kind: "member", activeWeeks: 1, lastAttendedGame: 10, attendanceHistory: 0, window: 8 },
    snapshot: {
      membershipRing: null,
      devicehoodRing: null,
      isLitePerson: true,
      isUpgradedIdentity: false,
      participant: {
        score: 8,
        streak: { tag: "Attended", count: 1 },
        attendanceHistory: 1,
        reachedPersonhood: true,
        hasEverReachedPersonhood: true,
        recognition: "NotRecognized",
        lastAttendedGame: 10,
      },
      personhoodThreshold: 8,
      policy: { allowedMisses: 1, window: 8 },
    },
    ...overrides,
  };
}

describe("usernameClaimTarget", () => {
  it.each(["erin.35", "erin.35.dot", "erin.35.testnet"])(
    "suggests the base name of %s without its numeric or network suffix",
    (primaryUsername) => {
      expect(usernameClaimTarget(card({ primaryUsername }))).toMatchObject({
        kind: "available",
        currentLiteUsername: "erin.35",
        suggestedUsername: "erin",
      });
    },
  );
  it.each([
    ["jet-set.42.dot", "jetset"],
    ["r2d2bot.07.dot", "rdbot"],
  ])("offers %s a default a full name can hold", (primaryUsername, suggested) => {
    expect(usernameClaimTarget(card({ primaryUsername }))).toMatchObject({
      kind: "available",
      suggestedUsername: suggested,
    });
    expect(suggested).toMatch(/^[a-z]+$/);
  });
  it("allows a faucet-promoted full person without game participation", () => {
    const faucetCard = card({
      state: { kind: "candidate", score: 0, personhoodThreshold: 8, gamesRemaining: 8 },
      snapshot: { ...card().snapshot, participant: null },
    });
    expect(usernameClaimTarget(faucetCard)).toEqual({ kind: "not-ready" });
    expect(usernameClaimTarget(faucetCard, true).kind).toBe("available");
    expect(usernameClaimTarget(undefined, true)).toEqual({ kind: "not-ready" });
  });
  it("allows a member who still owns a lite username", () => {
    expect(usernameClaimTarget(card())).toEqual({
      kind: "available",
      accountAddress: "5Alice",
      currentLiteUsername: "alice.42",
      suggestedUsername: "alice",
    });
  });

  it("allows a member recognised outside the game who still owns a lite username", () => {
    const ringMember = card({
      primaryUsername: "erin.38.paseo",
      snapshot: {
        ...card().snapshot,
        participant: null,
        membershipRing: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 39 },
      },
    });
    expect(usernameClaimTarget(ringMember)).toMatchObject({
      kind: "available",
      currentLiteUsername: "erin.38",
      suggestedUsername: "erin",
    });
  });

  it("does not let a direct URL bypass the membership threshold", () => {
    expect(
      usernameClaimTarget(
        card({ state: { kind: "candidate", score: 7, personhoodThreshold: 8, gamesRemaining: 1 } }),
      ),
    ).toEqual({ kind: "not-ready" });
  });

  it("recognizes an identity that already owns a full username", () => {
    expect(
      usernameClaimTarget(
        card({
          primaryUsername: "alicewonder.dot",
          snapshot: { ...card().snapshot, isUpgradedIdentity: true },
        }),
      ),
    ).toEqual({ kind: "already-claimed" });
  });
});

describe("usernameClaimTarget while the Membership root is behind", () => {
  const standing = (ringPosition: number, includedKeys: number) =>
    ({
      source: "personhood-key",
      personalId: null,
      ringVrfKey: "0x00",
      position: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition },
      ring: { ringIndex: 0, totalKeys: 14, includedKeys, immutableSinceSeconds: null, rootRevision: 12, stale: true },
    }) as unknown as NonNullable<Extract<HumanityCardResult, { kind: "card" }>["membershipStanding"]>;

  it("offers no name until the root covers the key (the KeyNotInRing case)", () => {
    expect(usernameClaimTarget(card({ membershipStanding: standing(13, 13) })).kind).toBe("not-ready");
  });

  it("offers the name once the rebuilt root includes the key", () => {
    expect(usernameClaimTarget(card({ membershipStanding: standing(13, 14) })).kind).toBe("available");
  });
});
