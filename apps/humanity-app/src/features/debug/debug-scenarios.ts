// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  HumanityCardParticipant,
  HumanityCardSnapshot,
} from "@humanity/shared/card/humanity-card-state.ts";
import type { RingPosition } from "@humanity/shared/chain/ring-membership.ts";
import { MEMBER_MATERIALS } from "@features/card/components/card-materials.ts";

/** Included in the Membership ring, as the states past Membership are. */
const INCLUDED: RingPosition = {
  kind: "included",
  ringIndex: 0,
  ringPage: 0,
  ringPosition: 0,
};
/** Key queued, ring not yet rebuilt — the other road to Membership Ready. */
const ONBOARDING: RingPosition = {
  kind: "onboarding",
  queuePage: 0,
  queuedAtSeconds: 0,
};
/** Asked, and the ring has no entry — the answer Not Enrolled rests on. */
const ABSENT: RingPosition = { kind: "absent" };

export type DebugScenarioId =
  | "not-enrolled"
  | "devicehood"
  | "candidate"
  | "membership-ready"
  | "member"
  | "caution"
  | "suspended";

export interface DebugScenario {
  id: DebugScenarioId;
  label: string;
}

export const DEBUG_SCENARIOS: readonly DebugScenario[] = [
  { id: "not-enrolled", label: "Not enrolled" },
  { id: "devicehood", label: "Devicehood" },
  { id: "candidate", label: "Candidate" },
  { id: "membership-ready", label: "Membership ready" },
  { id: "member", label: "Member" },
  { id: "caution", label: "Caution" },
  { id: "suspended", label: "Suspended" },
];

/** Whether a persisted scenario id is one this build still knows. The debug
 *  store outlives builds like every other browser state, and `lite` was once
 *  a scenario. */
export function isDebugScenarioId(value: unknown): value is DebugScenarioId {
  return DEBUG_SCENARIOS.some((scenario) => scenario.id === value);
}

const POLICY = { allowedMisses: 1, window: 4 };

function participant(
  overrides: Partial<HumanityCardParticipant>,
): HumanityCardParticipant {
  return {
    score: 4,
    streak: { tag: "Attended", count: 3 },
    attendanceHistory: 0b0000_0111,
    reachedPersonhood: false,
    hasEverReachedPersonhood: false,
    recognition: "NotRecognized",
    lastAttendedGame: 42,
    ...overrides,
  };
}

/**
 * Where a simulated candidate stands: points scored and the threshold they
 * count towards. The panel sets both, so the progress stripe, its heat and
 * the home copy can be looked at anywhere along the way.
 */
export interface CandidateProgress {
  score: number;
  threshold: number;
}

export const DEFAULT_CANDIDATE_PROGRESS: CandidateProgress = { score: 4, threshold: 10 };

/** High enough to see the stripe's share on a long road, not only a short one. */
export const MAX_DEBUG_THRESHOLD = 30;

/** Whole numbers, a threshold of at least one, and a score no higher than it. */
export function clampCandidateProgress(progress: CandidateProgress): CandidateProgress {
  const whole = (value: number, fallback: number) =>
    Number.isFinite(value) ? Math.round(value) : fallback;
  const threshold = Math.min(
    MAX_DEBUG_THRESHOLD,
    Math.max(1, whole(progress.threshold, DEFAULT_CANDIDATE_PROGRESS.threshold)),
  );
  const score = Math.min(threshold, Math.max(0, whole(progress.score, DEFAULT_CANDIDATE_PROGRESS.score)));
  return { score, threshold };
}

/** The first week of each member tier. The card looks the same from one to
 *  the next, so these are the only weeks worth picking. */
export const MEMBER_TIER_WEEKS: readonly number[] = MEMBER_MATERIALS.map((tier) => tier.weeks);

const FIRST_TIER_WEEKS = MEMBER_MATERIALS[0].weeks;

/** Week 2, the first tier past fresh silver: the look the member scenarios
 *  had before their weeks could be picked. */
export const DEFAULT_MEMBER_WEEKS = 2;

/** The first week of the tier `weeks` falls in; below the first tier is the first. */
export function clampMemberWeeks(weeks: number): number {
  if (!Number.isFinite(weeks)) return DEFAULT_MEMBER_WEEKS;
  return MEMBER_TIER_WEEKS.reduce((tier, start) => (weeks >= start ? start : tier), FIRST_TIER_WEEKS);
}

/** The first week of the neighbouring tier, held at either end of the ramp. */
export function stepMemberWeeks(weeks: number, step: 1 | -1): number {
  const index = MEMBER_TIER_WEEKS.indexOf(clampMemberWeeks(weeks));
  const next = Math.min(MEMBER_TIER_WEEKS.length - 1, Math.max(0, index + step));
  return MEMBER_TIER_WEEKS[next] ?? FIRST_TIER_WEEKS;
}

/** Creates a card-derivation input for a selectable debug state.
 *
 *  The rings carry each scenario, because the derivation reads them first: a
 *  scenario that set only Score fields would describe a person the card
 *  cannot place. `devicehoodRing` is `null` — never asked — wherever the
 *  Membership ring already settles the state, which is every scenario past
 *  Candidate. The candidate's score and threshold are the panel's, and so
 *  are a member's weeks, carried as the attendance streak because that is
 *  what the card counts weeks from. */
export function scenarioSnapshot(
  id: DebugScenarioId,
  candidate: CandidateProgress = DEFAULT_CANDIDATE_PROGRESS,
  memberWeeks: number = DEFAULT_MEMBER_WEEKS,
): HumanityCardSnapshot {
  switch (id) {
    case "not-enrolled":
      return {
        membershipRing: null,
        devicehoodRing: ABSENT,
        isLitePerson: false,
        isUpgradedIdentity: false,
        participant: null,
        personhoodThreshold: 10,
        policy: POLICY,
      };
    case "devicehood":
      return {
        membershipRing: null,
        devicehoodRing: INCLUDED,
        isLitePerson: true,
        isUpgradedIdentity: false,
        participant: null,
        personhoodThreshold: 10,
        policy: POLICY,
      };
    case "candidate":
      return {
        membershipRing: null,
        devicehoodRing: null,
        isLitePerson: false,
        isUpgradedIdentity: false,
        participant: participant({ score: candidate.score }),
        personhoodThreshold: candidate.threshold,
        policy: POLICY,
      };
    case "membership-ready":
      return {
        membershipRing: ONBOARDING,
        devicehoodRing: null,
        isLitePerson: false,
        isUpgradedIdentity: false,
        participant: participant({
          score: 10,
          streak: { tag: "Attended", count: memberWeeks },
          reachedPersonhood: true,
          hasEverReachedPersonhood: true,
        }),
        personhoodThreshold: 10,
        policy: POLICY,
      };
    case "member":
      return {
        membershipRing: INCLUDED,
        devicehoodRing: null,
        isLitePerson: false,
        isUpgradedIdentity: false,
        participant: participant({
          score: 10,
          // A miss four games back, so the home has a hollow mark to show.
          attendanceHistory: 0b1110_0111,
          // The panel's weeks, which a real streak would restart at that miss:
          // the streak stands in for weeks here, so every tier stays reachable.
          streak: { tag: "Attended", count: memberWeeks },
          reachedPersonhood: true,
          hasEverReachedPersonhood: true,
          recognition: "Recognized",
        }),
        personhoodThreshold: 10,
        policy: POLICY,
      };
    case "caution":
      return {
        membershipRing: INCLUDED,
        devicehoodRing: null,
        isLitePerson: false,
        isUpgradedIdentity: false,
        // One miss in the four-game window, the latest game played: the
        // allowance is used up, so the next absence would cross it.
        participant: participant({
          score: 10,
          streak: { tag: "Attended", count: 1 },
          attendanceHistory: 0b1111_1101,
          reachedPersonhood: true,
          hasEverReachedPersonhood: true,
          recognition: "Recognized",
        }),
        personhoodThreshold: 10,
        policy: POLICY,
      };
    // Suspended by attendance, not by the ring: the score's own verdict, with
    // the Membership ring left unanswerable so the score is what carries it.
    case "suspended":
      return {
        membershipRing: null,
        devicehoodRing: null,
        isLitePerson: false,
        isUpgradedIdentity: false,
        participant: participant({
          score: 10,
          reachedPersonhood: true,
          hasEverReachedPersonhood: true,
          recognition: "Suspended",
        }),
        personhoodThreshold: 10,
        policy: POLICY,
      };
  }
}
