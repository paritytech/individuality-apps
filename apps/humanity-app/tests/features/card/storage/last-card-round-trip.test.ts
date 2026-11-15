// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The durable fallback is only as good as its serialization. `writeLastCard`
 * cannot throw (a browser store may be blocked), so a `ResolvedHumanityCard`
 * that is not JSON-safe would silently disable the fallback and put the user
 * back on the failure screen this feature exists to remove. Chain reads carry
 * `bigint`s (`credit`, `recognition.value`) that `JSON.stringify` refuses, so
 * this pins the real derivation — not a hand-written literal — as safe.
 */
import { describe, expect, it } from "vitest";

import {
  toHumanityCardResult,
  type HumanityCardReadInputs,
} from "@humanity/shared/card/humanity-card-data.ts";
import {
  parseLastCard,
  serializeLastCard,
} from "@features/card/domain/last-card-snapshot.ts";
import type { PersonRingStanding } from "@humanity/shared/chain/ring-membership.ts";

const USERNAME = "alice.dot";

/** PAPI-shaped reads, bigints included, exactly as the chain hands them over. */
function readInputs(
  overrides: Partial<HumanityCardReadInputs> = {},
): HumanityCardReadInputs {
  return {
    primaryUsername: USERNAME,
    ownerAccount: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    gameAccount: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    membershipStanding: null,
    devicehoodRing: null,
    deviceKeyCheck: null,
    rawParticipant: {
      score: 42,
      streak: { type: "Attended", value: 3 },
      attendance_history: 0b1101,
      credit: 1_000n,
      cashed_out: false,
      reached_personhood: true,
      has_ever_reached_personhood: true,
      recognition: { type: "Recognized", value: 5n },
      last_attended_game: 7_777,
    },
    litePerson: null,
    isUpgradedIdentity: true,
    personhoodThreshold: 10,
    absenceGraceRatio: "0x0506",
    ...overrides,
  };
}

describe("last card durable round trip", () => {
  it("preserves a derived member card exactly", () => {
    const card = toHumanityCardResult(readInputs());

    const restored = parseLastCard(serializeLastCard(USERNAME, card, 1_700_000));

    expect(restored).not.toBeNull();
    expect(restored?.username).toBe(USERNAME);
    expect(restored?.card).toEqual(card);
  });

  it("preserves a card with no participant record", () => {
    const card = toHumanityCardResult(readInputs({ rawParticipant: null }));

    const restored = parseLastCard(serializeLastCard(USERNAME, card, 1_700_000));

    expect(restored?.card).toEqual(card);
  });

  it("serializes without throwing on the bigint-bearing read inputs", () => {
    // Guards the exact regression: a raw chain value reaching the card shape.
    expect(() =>
      serializeLastCard(USERNAME, toHumanityCardResult(readInputs()), 0),
    ).not.toThrow();
  });

  it("preserves the suspension reason and both ring positions", () => {
    // `state.reason` and the two ring positions are the parts of the payload
    // a durable round trip could silently drop: the parser only validates
    // `state.kind`, so nothing else would complain.
    const key = `0x${"11".repeat(32)}` as PersonRingStanding["ringVrfKey"];
    const card = toHumanityCardResult(
      readInputs({
        membershipStanding: {
          source: "personhood-key",
          personalId: null,
          ringVrfKey: key,
          position: { kind: "suspended" },
          ring: null,
        },
        devicehoodRing: {
          kind: "placed",
          ringVrfKey: key,
          standing: {
            source: "account-binding",
            personalId: null,
            ringVrfKey: key,
            position: { kind: "absent" },
            ring: null,
          },
        },
      }),
    );
    expect(card.state).toEqual({ kind: "suspended", reason: "ring" });

    const restored = parseLastCard(serializeLastCard(USERNAME, card, 1_700_000));

    expect(restored?.card).toEqual(card);
  });
});
