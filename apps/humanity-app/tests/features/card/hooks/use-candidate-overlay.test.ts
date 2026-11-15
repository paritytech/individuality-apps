// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A devicehood person who has just signed up reads as a candidate as soon as
 * the sign-up is at best, or on the wire from Jollity, rather than a
 * finality delay later. Every other state stays the finalized read's.
 */
import type { GameRegistration } from "@individuality/shared-records";
import { describe, expect, it } from "vitest";

import { withCandidateOverlay } from "@features/card/hooks/use-candidate-overlay.ts";
import {
  toHumanityCardResult,
  type HumanityCardReadInputs,
  type RawParticipant,
} from "@humanity/shared/card/humanity-card-data.ts";

const record = (phase: GameRegistration["phase"], surface: GameRegistration["surface"] = "chat"): GameRegistration => ({
  gameIndex: 1305,
  phase,
  surface,
  at: 0,
  attempt: 0,
});
const SENT = record("sent");
const BUSY = record("registering");

function participant(overrides: Partial<RawParticipant> = {}): RawParticipant {
  return {
    score: 0,
    streak: { type: "Attended", value: 0 },
    attendance_history: 0,
    credit: 0n,
    cashed_out: false,
    reached_personhood: false,
    has_ever_reached_personhood: false,
    recognition: { type: "NotRecognized", value: undefined },
    ...overrides,
  };
}

function card(overrides: Partial<HumanityCardReadInputs> = {}) {
  return toHumanityCardResult({
    primaryUsername: "Alice.dot",
    ownerAccount: "5Owner",
    gameAccount: "5Candidate",
    rawParticipant: null,
    litePerson: { ring_vrf_key: `0x${"ab".repeat(32)}`, method: { type: "Fee" } },
    membershipStanding: null,
    devicehoodRing: null,
    deviceKeyCheck: null,
    isUpgradedIdentity: false,
    personhoodThreshold: 6,
    absenceGraceRatio: "0x0506",
    ...overrides,
  });
}

describe("withCandidateOverlay", () => {
  it("leaves a devicehood card alone with nothing at best and no sign-up on the wire", () => {
    const devicehood = card();
    expect(withCandidateOverlay(devicehood, null, null)).toBe(devicehood);
    expect(withCandidateOverlay(devicehood, null, BUSY)).toBe(devicehood);
  });

  it("reads the participant at best as the card's", () => {
    const result = withCandidateOverlay(card(), participant({ score: 3, streak: { type: "Attended", value: 2 } }), null);
    expect(result?.kind === "card" && result.state).toEqual({
      kind: "candidate",
      score: 3,
      personhoodThreshold: 6,
      gamesRemaining: 1,
    });
  });

  it.each([
    ["on the wire from the chat", SENT],
    ["on the wire from the app", record("sent", "app")],
    ["landed for the chat", record("registered")],
  ])("shows a fresh candidate once Jollity's sign-up is %s", (_label, registration) => {
    const result = withCandidateOverlay(card(), null, registration);
    expect(result?.kind === "card" && result.state).toEqual({
      kind: "candidate",
      score: 0,
      personhoodThreshold: 6,
      gamesRemaining: 3,
    });
  });

  it("stays devicehood for a sign-up that failed", () => {
    const devicehood = card();
    expect(withCandidateOverlay(devicehood, null, record("failed"))).toBe(devicehood);
  });

  it("prefers the record at best over Jollity's sign-up", () => {
    const result = withCandidateOverlay(card(), participant({ score: 5 }), SENT);
    expect(result?.kind === "card" && result.state.kind === "candidate" && result.state.score).toBe(5);
  });

  it("never touches a card past devicehood", () => {
    const candidate = card({ rawParticipant: participant({ score: 4 }) });
    expect(withCandidateOverlay(candidate, participant({ score: 5 }), SENT)).toBe(candidate);
  });
});
