// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The card is ring-first: the Membership ring is what Membership *is*, and
 * the score is one road into it. So the two questions these tests keep apart
 * are "what does the ring say" and "what does the score say", and the second
 * only ever fills in detail the first cannot carry.
 *
 * The matrix below is the whole rule, written out. It is a table rather than
 * a paragraph of prose because every cell is a decision someone made — and
 * the cells that surprise (an `absent` ring demoting a recognized member to
 * `membership-ready`, an `absent` lite ring outranking a LitePeople record)
 * are exactly the ones a future change would quietly get wrong.
 */
import { describe, expect, it } from "vitest";

import {
  deriveHumanityCardState,
  personhoodStateFor,
  type HumanityCardParticipant,
  type HumanityCardSnapshot,
  type HumanityCardState,
  type SuspensionReason,
} from "@humanity/shared/card/humanity-card-state.ts";
import type { RingPosition } from "@humanity/shared/chain/ring-membership.ts";

/** Recognized, at personhood, fully attended for the last 8 games. */
const participant = (
  overrides: Partial<HumanityCardParticipant> = {},
): HumanityCardParticipant => ({
  score: 7,
  streak: { tag: "Attended", count: 4 },
  attendanceHistory: 0b11111111,
  reachedPersonhood: true,
  hasEverReachedPersonhood: true,
  recognition: "Recognized",
  lastAttendedGame: 42,
  ...overrides,
});

/** Snapshot around a recognized member with both rings silent; override per
 *  test. Both rings default to `null` — unanswerable — so a test says which
 *  ring answer it is about. */
const snapshot = (
  overrides: Partial<HumanityCardSnapshot> = {},
): HumanityCardSnapshot => ({
  membershipRing: null,
  devicehoodRing: null,
  isLitePerson: false,
  isUpgradedIdentity: false,
  participant: participant(),
  personhoodThreshold: 5,
  policy: { allowedMisses: 1, window: 8 },
  ...overrides,
});

/** The seven answers the score (via the SDK) can give, named after the card
 *  state each would produce on its own. Every ring row in the matrix is
 *  played against all seven. */
type BaseName =
  | "not-enrolled"
  | "devicehood"
  | "candidate"
  | "membership-ready"
  | "member"
  | "caution"
  | "suspended";

const BASES: Record<BaseName, Partial<HumanityCardSnapshot>> = {
  "not-enrolled": { participant: null, isLitePerson: false },
  devicehood: { participant: null, isLitePerson: true },
  candidate: {
    participant: participant({
      recognition: "NotRecognized",
      reachedPersonhood: false,
    }),
  },
  "membership-ready": {
    participant: participant({ recognition: "NotRecognized" }),
  },
  member: {},
  // 0b11111110: one live miss at the newest bit, so the next absence lands a
  // second and crosses the single allowed miss.
  caution: { participant: participant({ attendanceHistory: 0b11111110, streak: { tag: "Absent", count: 1 } }) },
  suspended: { participant: participant({ recognition: "Suspended" }) },
};

const BASE_NAMES = Object.keys(BASES) as BaseName[];

/** What the SDK tag behind each base is, so the table cannot drift: a
 *  fixture that stops producing the state it is named after would otherwise
 *  make every row asserting it meaningless. */
const BASE_TAGS: Record<BaseName, string> = {
  "not-enrolled": "NotEnrolled",
  devicehood: "Lite",
  candidate: "Candidate",
  "membership-ready": "MembershipReady",
  member: "Member",
  caution: "Caution",
  suspended: "Suspended",
};

interface ExpectedState {
  kind: HumanityCardState["kind"];
  reason?: SuspensionReason;
}

const SUSPENDED_BY_RING: ExpectedState = { kind: "suspended", reason: "ring" };
const SUSPENDED_BY_SCORE: ExpectedState = {
  kind: "suspended",
  reason: "attendance",
};
const MEMBER: ExpectedState = { kind: "member" };
const READY: ExpectedState = { kind: "membership-ready" };
const CAUTION: ExpectedState = { kind: "caution" };
const CANDIDATE: ExpectedState = { kind: "candidate" };
const DEVICEHOOD: ExpectedState = { kind: "devicehood" };
const NOT_ENROLLED: ExpectedState = { kind: "not-enrolled" };

/**
 * Rules 1-6 of the ring-first derivation, one row per Membership-ring answer.
 *
 * Both rings are silent by default, so the two rows that fall through to the
 * devicehood rule land on its last-resort arm (`devicehoodRing: null`, so
 * `isLitePerson` decides) — which is what each base already carries. The
 * devicehood rule itself gets its own matrix below.
 */
const MEMBERSHIP_MATRIX: ReadonlyArray<{
  label: string;
  ring: RingPosition | null;
  outcomes: Record<BaseName, ExpectedState>;
}> = [
  {
    // Rule 1: the chain's own verdict, and nothing the score says survives it.
    label: "suspended",
    ring: { kind: "suspended" },
    outcomes: {
      "not-enrolled": SUSPENDED_BY_RING,
      devicehood: SUSPENDED_BY_RING,
      candidate: SUSPENDED_BY_RING,
      "membership-ready": SUSPENDED_BY_RING,
      member: SUSPENDED_BY_RING,
      caution: SUSPENDED_BY_RING,
      suspended: SUSPENDED_BY_RING,
    },
  },
  {
    // Rule 2: included IS Membership. The score only adds the caution, or
    // the attendance suspension it alone can see.
    label: "included",
    ring: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 0 },
    outcomes: {
      "not-enrolled": MEMBER,
      devicehood: MEMBER,
      candidate: MEMBER,
      "membership-ready": MEMBER,
      member: MEMBER,
      caution: CAUTION,
      suspended: SUSPENDED_BY_SCORE,
    },
  },
  {
    // Rule 3: queued, ring not yet rebuilt — earned and not yet provable,
    // which is what Membership Ready names, whatever the score says.
    label: "onboarding",
    ring: { kind: "onboarding", queuePage: 0, queuedAtSeconds: 1_788_533_994 },
    outcomes: {
      "not-enrolled": READY,
      devicehood: READY,
      candidate: READY,
      "membership-ready": READY,
      member: READY,
      caution: READY,
      suspended: READY,
    },
  },
  {
    // Rule 4: the key is known and the ring has no entry for it. A score that
    // says Member is therefore earned-but-unproven, never Member.
    label: "absent",
    ring: { kind: "absent" },
    outcomes: {
      "not-enrolled": NOT_ENROLLED,
      devicehood: DEVICEHOOD,
      candidate: CANDIDATE,
      "membership-ready": READY,
      member: READY,
      caution: READY,
      suspended: READY,
    },
  },
  {
    // Rule 5: unanswerable — no key and no binding — so the score stands as
    // the only evidence there is.
    label: "unanswerable (null)",
    ring: null,
    outcomes: {
      "not-enrolled": NOT_ENROLLED,
      devicehood: DEVICEHOOD,
      candidate: CANDIDATE,
      "membership-ready": READY,
      member: MEMBER,
      caution: CAUTION,
      suspended: SUSPENDED_BY_SCORE,
    },
  },
];

describe("deriveHumanityCardState score fixtures", () => {
  it.each(BASE_NAMES)("derives the %s base from the SDK", (base) => {
    expect(personhoodStateFor(snapshot(BASES[base])).tag).toBe(BASE_TAGS[base]);
  });
});

describe("deriveHumanityCardState membership ring", () => {
  it.each(
    MEMBERSHIP_MATRIX.flatMap(({ label, ring, outcomes }) =>
      BASE_NAMES.map((base) => ({
        label,
        ring,
        base,
        expected: outcomes[base],
      })),
    ),
  )(
    "membership ring $label over a $base score is $expected.kind",
    ({ ring, base, expected }) => {
      expect(
        deriveHumanityCardState(
          snapshot({ membershipRing: ring, ...BASES[base] }),
        ),
      ).toMatchObject(expected);
    },
  );
});

/**
 * Rule 6, reached only when the Membership ring has not made this person a
 * member or a candidate. The lite ring answers Devicehood the same way the
 * full ring answers Membership, so a LitePeople record is only consulted
 * when the ring cannot be asked at all.
 */
describe("deriveHumanityCardState devicehood ring", () => {
  const rows: ReadonlyArray<{
    label: string;
    ring: RingPosition | null;
    lite: boolean;
    expected: HumanityCardState["kind"];
  }> = [
    { label: "included", ring: { kind: "included", ringIndex: 1, ringPage: 0, ringPosition: 0 }, lite: true, expected: "devicehood" },
    { label: "included", ring: { kind: "included", ringIndex: 1, ringPage: 0, ringPosition: 0 }, lite: false, expected: "devicehood" },
    { label: "onboarding", ring: { kind: "onboarding", queuePage: 0, queuedAtSeconds: 7 }, lite: true, expected: "devicehood" },
    { label: "onboarding", ring: { kind: "onboarding", queuePage: 0, queuedAtSeconds: 7 }, lite: false, expected: "devicehood" },
    // Suspended from the lite ring is still Devicehood reached: the card has
    // no lost-devicehood state, and the full ring owns the lost verdict.
    { label: "suspended", ring: { kind: "suspended" }, lite: true, expected: "devicehood" },
    { label: "suspended", ring: { kind: "suspended" }, lite: false, expected: "devicehood" },
    // `absent` is an answer, and it outranks a LitePeople record: the ring
    // does not hold this person's lite key, so nothing is proven.
    { label: "absent", ring: { kind: "absent" }, lite: true, expected: "not-enrolled" },
    { label: "absent", ring: { kind: "absent" }, lite: false, expected: "not-enrolled" },
    // Unanswerable: no lite key from the host and no record to read one
    // from, so record presence is the last-resort evidence.
    { label: "unanswerable (null)", ring: null, lite: true, expected: "devicehood" },
    { label: "unanswerable (null)", ring: null, lite: false, expected: "not-enrolled" },
  ];

  it.each(rows)(
    "lite ring $label with isLitePerson $lite is $expected",
    ({ ring, lite, expected }) => {
      expect(
        deriveHumanityCardState(
          snapshot({
            participant: null,
            isLitePerson: lite,
            devicehoodRing: ring,
          }),
        ).kind,
      ).toBe(expected);
    },
  );

  it("is not consulted once the Membership ring has answered", () => {
    // An included Membership key with no lite ring entry at all is still a
    // Member: Devicehood is the step before, not a precondition to re-check.
    expect(
      deriveHumanityCardState(
        snapshot({
          participant: null,
          isLitePerson: false,
          membershipRing: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 0 },
          devicehoodRing: { kind: "absent" },
        }),
      ),
    ).toEqual({ kind: "member", activeWeeks: 0, lastAttendedGame: null, attendanceHistory: null, window: 8 });
  });
});

describe("deriveHumanityCardState payloads", () => {
  it("counts the games a candidate still needs against the snapshot threshold", () => {
    expect(
      deriveHumanityCardState(
        snapshot({
          isLitePerson: true,
          participant: participant({
            score: 1,
            streak: { tag: "Attended", count: 1 },
            attendanceHistory: 0b00000001,
            reachedPersonhood: false,
            hasEverReachedPersonhood: false,
            recognition: "NotRecognized",
            lastAttendedGame: 40,
          }),
        }),
      ),
    ).toEqual({
      kind: "candidate",
      score: 1,
      personhoodThreshold: 5,
      gamesRemaining: 2,
    });
    expect(
      deriveHumanityCardState(
        snapshot({
          participant: participant({
            recognition: "NotRecognized",
            reachedPersonhood: false,
            score: 3,
          }),
        }),
      ),
    ).toEqual({
      kind: "candidate",
      score: 3,
      personhoodThreshold: 5,
      gamesRemaining: 1,
    });
  });

  it("reports the attended streak as active weeks and zero for an absent streak", () => {
    expect(deriveHumanityCardState(snapshot())).toEqual({
      kind: "member",
      activeWeeks: 4,
      lastAttendedGame: 42,
      attendanceHistory: 0b11111111,
      window: 8,
    });
    expect(
      deriveHumanityCardState(
        snapshot({ participant: participant({ streak: { tag: "Absent", count: 3 } }) }),
      ),
    ).toEqual({
      kind: "member",
      activeWeeks: 0,
      lastAttendedGame: 42,
      attendanceHistory: 0b11111111,
      window: 8,
    });
  });

  it("carries the member payload onto membership-ready", () => {
    expect(
      deriveHumanityCardState(
        snapshot({
          membershipRing: { kind: "onboarding", queuePage: 0, queuedAtSeconds: 1_788_533_994 },
          ...BASES["membership-ready"],
        }),
      ),
    ).toEqual({ kind: "membership-ready", activeWeeks: 4, lastAttendedGame: 42, attendanceHistory: 0b11111111, window: 8 });
  });

  it("makes a member of an included key with no participant at all", () => {
    // The sudo faucet's shape: a key in the Membership ring, no Score record
    // anywhere. The score is one road into the ring and not the only one.
    expect(
      deriveHumanityCardState(
        snapshot({
          participant: null,
          membershipRing: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 0 },
        }),
      ),
    ).toEqual({ kind: "member", activeWeeks: 0, lastAttendedGame: null, attendanceHistory: null, window: 8 });
  });

  it("cautions exactly when the next absence crosses the grace policy", () => {
    expect(
      deriveHumanityCardState(
        snapshot({ participant: participant({ attendanceHistory: 0b11111110, streak: { tag: "Absent", count: 1 } }) }),
      ),
    ).toEqual({
      kind: "caution",
      activeWeeks: 0,
      misses: 2,
      allowedMisses: 1,
      window: 8,
      lastAttendedGame: 42,
      attendanceHistory: 0b11111110,
    });
    // Zero allowed misses: even a clean window crosses on the next absence.
    expect(
      deriveHumanityCardState(snapshot({ policy: { allowedMisses: 0, window: 8 } })),
    ).toEqual({
      kind: "caution",
      // A perfect attender under a no-miss policy: projected caution, streak intact.
      activeWeeks: 4,
      misses: 1,
      allowedMisses: 0,
      window: 8,
      lastAttendedGame: 42,
      attendanceHistory: 0b11111111,
    });
    // 0b01111111: the only miss is the oldest bit; a new absence evicts it,
    // so the projected window still holds exactly one miss — still a member.
    expect(
      deriveHumanityCardState(
        snapshot({ participant: participant({ attendanceHistory: 0b01111111 }) }),
      ),
    ).toEqual({
      kind: "member",
      activeWeeks: 4,
      lastAttendedGame: 42,
      attendanceHistory: 0b01111111,
      window: 8,
    });
  });

  it("keeps the caution payload when the ring says included", () => {
    expect(
      deriveHumanityCardState(
        snapshot({
          membershipRing: { kind: "included", ringIndex: 0, ringPage: 0, ringPosition: 0 },
          participant: participant({ attendanceHistory: 0b11111110, streak: { tag: "Absent", count: 1 } }),
        }),
      ),
    ).toEqual({
      kind: "caution",
      activeWeeks: 0,
      misses: 2,
      allowedMisses: 1,
      window: 8,
      lastAttendedGame: 42,
      attendanceHistory: 0b11111110,
    });
  });

  it("never cautions an externally recognized member", () => {
    // 0b11001111: two misses inside the window, so a Recognized member here
    // would be cautioned — external recognition stays a plain member.
    const risky = participant({
      recognition: "ExternallyRecognized",
      attendanceHistory: 0b11001111,
    });
    expect(deriveHumanityCardState(snapshot({ participant: risky }))).toEqual({
      kind: "member",
      activeWeeks: 4,
      lastAttendedGame: 42,
      attendanceHistory: 0b11001111,
      window: 8,
    });
    // External recognition holds even when the personhood flag is unset.
    expect(
      deriveHumanityCardState(
        snapshot({ participant: { ...risky, reachedPersonhood: false } }),
      ),
    ).toEqual({
      kind: "member",
      activeWeeks: 4,
      lastAttendedGame: 42,
      attendanceHistory: 0b11001111,
      window: 8,
    });
  });

  it("fail-safes to suspended when recognized without personhood", () => {
    expect(
      deriveHumanityCardState(
        snapshot({
          participant: participant({
            recognition: "Recognized",
            reachedPersonhood: false,
          }),
        }),
      ),
    ).toEqual({ kind: "suspended", reason: "attendance" });
  });

  it("names which suspension a card is in", () => {
    // The same rendered state, two different events: the ring's verdict and
    // the score's. Keeping them apart is what lets the copy diverge later.
    expect(
      deriveHumanityCardState(snapshot({ membershipRing: { kind: "suspended" } })),
    ).toEqual({ kind: "suspended", reason: "ring" });
    expect(
      deriveHumanityCardState(snapshot(BASES["suspended"])),
    ).toEqual({ kind: "suspended", reason: "attendance" });
  });
});

describe("deriveHumanityCardState ring-first regressions", () => {
  it("no longer floors an upgraded identity at member", () => {
    // The DotNS label is display only now. It used to raise a person with no
    // participant record and no ring standing straight to `member`, which
    // asserted Membership from a username — the exact claim the ring owns.
    expect(
      deriveHumanityCardState(
        snapshot({ participant: null, isUpgradedIdentity: true }),
      ),
    ).toEqual({ kind: "not-enrolled" });
    expect(
      deriveHumanityCardState(
        snapshot({
          participant: null,
          isLitePerson: true,
          isUpgradedIdentity: true,
        }),
      ),
    ).toEqual({ kind: "devicehood", personhoodThreshold: 5 });
    expect(
      deriveHumanityCardState(
        snapshot({ isUpgradedIdentity: true, ...BASES["candidate"] }),
      ),
    ).toMatchObject({ kind: "candidate" });
  });

  it("demotes a recognized member the Membership ring has no entry for", () => {
    // External recognition is the strongest thing the score can say, and it
    // still is not ring inclusion: they have earned it and cannot prove it.
    expect(
      deriveHumanityCardState(
        snapshot({
          membershipRing: { kind: "absent" },
          participant: participant({ recognition: "ExternallyRecognized" }),
        }),
      ),
    ).toEqual({ kind: "membership-ready", activeWeeks: 4, lastAttendedGame: 42, attendanceHistory: 0b11111111, window: 8 });
  });

  it("reads Devicehood off the lite ring when no LitePeople record exists", () => {
    // The lite key is in the ring, so this person has Devicehood — even
    // though `PeopleLite.LitePeople` had nothing for the account we read
    // (unregistered DotNS name, or a person bound to another account).
    expect(
      deriveHumanityCardState(
        snapshot({
          participant: null,
          isLitePerson: false,
          devicehoodRing: {
            kind: "included",
            ringIndex: 1,
            ringPage: 0,
            ringPosition: 0,
          },
        }),
      ),
    ).toEqual({ kind: "devicehood", personhoodThreshold: 5 });
  });
});
