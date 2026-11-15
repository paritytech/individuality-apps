// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  clampCandidateProgress,
  clampMemberWeeks,
  DEBUG_SCENARIOS,
  DEFAULT_MEMBER_WEEKS,
  isDebugScenarioId,
  MAX_DEBUG_THRESHOLD,
  MEMBER_TIER_WEEKS,
  scenarioSnapshot,
  stepMemberWeeks,
  type DebugScenarioId,
} from "@features/debug/debug-scenarios.ts";
import { matrixLabel } from "@features/debug/debug-personhood.ts";
import { resolveCardStyle } from "@features/card/components/card-state-resolve.ts";
import { memberMaterialForWeeks } from "@features/card/components/card-materials.ts";
import {
  deriveHumanityCardState,
  personhoodStateFor,
  type HumanityCardState,
} from "@humanity/shared/card/humanity-card-state.ts";

const expectedKinds: Record<DebugScenarioId, HumanityCardState["kind"]> = {
  "not-enrolled": "not-enrolled",
  devicehood: "devicehood",
  candidate: "candidate",
  "membership-ready": "membership-ready",
  member: "member",
  caution: "caution",
  suspended: "suspended",
};

describe("debug scenarios", () => {
  it("derives every selectable card state through the card domain", () => {
    for (const { id } of DEBUG_SCENARIOS) {
      expect(deriveHumanityCardState(scenarioSnapshot(id)).kind).toBe(
        expectedKinds[id],
      );
    }
  });

  it("distinguishes membership ready from a recognized member", () => {
    const readySnapshot = scenarioSnapshot("membership-ready");
    const memberSnapshot = scenarioSnapshot("member");

    expect(
      matrixLabel(
        deriveHumanityCardState(readySnapshot),
        personhoodStateFor(readySnapshot),
      ),
    ).toContain("Membership ready");
    expect(
      matrixLabel(
        deriveHumanityCardState(memberSnapshot),
        personhoodStateFor(memberSnapshot),
      ),
    ).toBe("Member (included)");
  });

  it("drives the two Devicehood scenarios from the lite ring, not the record", () => {
    // The panel exists to show what the chain says, so a scenario that
    // reached its state through the pre-ring presence fallback would stop
    // exercising the path the real card takes. Flipping the record proves
    // which one decided: the ring answer must win either way.
    expect(
      deriveHumanityCardState({
        ...scenarioSnapshot("devicehood"),
        isLitePerson: false,
      }).kind,
    ).toBe("devicehood");
    expect(
      deriveHumanityCardState({
        ...scenarioSnapshot("not-enrolled"),
        isLitePerson: true,
      }).kind,
    ).toBe("not-enrolled");
  });
});

describe("isDebugScenarioId", () => {
  it("accepts every scenario this build offers", () => {
    for (const scenario of DEBUG_SCENARIOS) {
      expect(isDebugScenarioId(scenario.id)).toBe(true);
    }
  });

  it("rejects ids a persisted store may still carry from an older build", () => {
    // `lite` was a scenario until 2026-09-04.
    for (const value of ["lite", "ready", "", null, undefined, 1]) {
      expect(isDebugScenarioId(value), String(value)).toBe(false);
    }
  });

  it("draws the candidate at the panel's score and threshold", () => {
    for (const progress of [
      { score: 0, threshold: 10 },
      { score: 7, threshold: 10 },
      { score: 12, threshold: 12 },
      { score: 18, threshold: 30 },
    ]) {
      const state = deriveHumanityCardState(scenarioSnapshot("candidate", progress));
      expect(state).toMatchObject({
        kind: "candidate",
        score: progress.score,
        personhoodThreshold: progress.threshold,
      });
    }
  });

  it("clamps a candidate progress to whole numbers, a threshold of at least one, and a score within it", () => {
    expect(clampCandidateProgress({ score: 9, threshold: 5 })).toEqual({ score: 5, threshold: 5 });
    expect(clampCandidateProgress({ score: -3, threshold: 0 })).toEqual({ score: 0, threshold: 1 });
    expect(clampCandidateProgress({ score: 2.6, threshold: 99 })).toEqual({ score: 3, threshold: MAX_DEBUG_THRESHOLD });
    expect(clampCandidateProgress({ score: Number.NaN, threshold: Number.NaN })).toEqual({ score: 4, threshold: 10 });
  });

  it("draws both member scenarios at the panel's weeks, one tier's material each", () => {
    for (const id of ["member", "membership-ready"] as const) {
      for (const weeks of MEMBER_TIER_WEEKS) {
        const state = deriveHumanityCardState(scenarioSnapshot(id, undefined, weeks));
        expect(state, `${id} ${weeks}`).toMatchObject({ kind: id, activeWeeks: weeks });
        expect(resolveCardStyle(state).vars).toMatchObject({
          "--c-sheen": memberMaterialForWeeks(weeks).sheen,
          "--c-holo": String(memberMaterialForWeeks(weeks).holo),
        });
      }
    }
    const fallback = deriveHumanityCardState(scenarioSnapshot("member"));
    expect(fallback).toMatchObject({ activeWeeks: DEFAULT_MEMBER_WEEKS });
  });

  it("offers every tier's first week, in order", () => {
    expect(MEMBER_TIER_WEEKS).toEqual([1, 2, 4, 8, 13, 26, 39, 52, 78, 104, 208, 312, 416]);
  });

  it("snaps member weeks to the first week of their tier", () => {
    expect(clampMemberWeeks(30)).toBe(26);
    expect(clampMemberWeeks(416)).toBe(416);
    expect(clampMemberWeeks(9_999)).toBe(416);
    expect(clampMemberWeeks(0)).toBe(1);
    expect(clampMemberWeeks(-5)).toBe(1);
    expect(clampMemberWeeks(Number.NaN)).toBe(DEFAULT_MEMBER_WEEKS);
  });

  it("steps member weeks a tier at a time and holds at either end", () => {
    expect(stepMemberWeeks(8, 1)).toBe(13);
    expect(stepMemberWeeks(13, -1)).toBe(8);
    expect(stepMemberWeeks(30, 1)).toBe(39);
    expect(stepMemberWeeks(1, -1)).toBe(1);
    expect(stepMemberWeeks(416, 1)).toBe(416);
  });
});
