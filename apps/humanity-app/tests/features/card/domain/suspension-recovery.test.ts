// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { suspensionRecovery } from "@features/card/domain/suspension-recovery.ts";
import type { HumanityCardSnapshot } from "@humanity/shared/card/humanity-card-state.ts";

const snapshot: HumanityCardSnapshot = {
  devicehoodRing: null,
  membershipRing: { kind: "suspended" }, isLitePerson: false, isUpgradedIdentity: true,
  personhoodThreshold: 3, policy: { allowedMisses: 3, window: 4 },
  participant: {
    score: 5, streak: { tag: "Absent", count: 4 }, attendanceHistory: 0,
    reachedPersonhood: false, hasEverReachedPersonhood: true,
    recognition: "Suspended", lastAttendedGame: 6,
  },
};
describe("Score suspension recovery eligibility", () => {
  it("permits resumption at the runtime threshold even without the reached flag", () => {
    expect(suspensionRecovery(snapshot)).toBe("ready");
    expect(suspensionRecovery({ ...snapshot, personhoodThreshold: 5 })).toBe("ready");
  });
  it("requires more play below threshold unless the runtime already marked it reached", () => {
    expect(suspensionRecovery({ ...snapshot, personhoodThreshold: 6 })).toBe("play");
    expect(suspensionRecovery({ ...snapshot, personhoodThreshold: 6,
      participant: { ...snapshot.participant!, reachedPersonhood: true } })).toBe("ready");
  });
  it("does not infer recovery from a suspended ring alone or an old saved card", () => {
    expect(suspensionRecovery(undefined)).toBe("unknown");
    expect(suspensionRecovery({ ...snapshot, participant: null })).toBe("unknown");
    expect(suspensionRecovery({ ...snapshot,
      participant: { ...snapshot.participant!, recognition: "Recognized" } })).toBe("unknown");
  });
});
