// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  decodeAbsenceGracePolicy,
  toDeviceKeyCheck,
  toDevicehood,
  toHumanityCardParticipant,
  toHumanityCardResult,
  type HumanityCardReadInputs,
  type RawLitePerson,
} from "@humanity/shared/card/humanity-card-data.ts";
import type {
  PersonRingStanding,
  RingPosition,
} from "@humanity/shared/chain/ring-membership.ts";
import type { PersonhoodRingKeyLookup } from "@humanity/shared/identity/personhood-ring-key.ts";
import type { HexString } from "@humanity/shared/chain/host-api.ts";

/** The raw `Score.Participants` value exactly as papi decodes it. */
type RawStreak = { type: "Attended" | "Absent"; value: number };
type RawRecognition = {
  type: "ExternallyRecognized" | "NotRecognized" | "Suspended" | "Recognized";
  value: bigint | undefined;
};
type RawParticipant = {
  score: number;
  streak: RawStreak;
  attendance_history: number;
  credit: bigint;
  cashed_out: boolean;
  reached_personhood: boolean;
  has_ever_reached_personhood: boolean;
  recognition: RawRecognition;
  last_attended_game?: number | undefined;
};

/** A full PAPI-shaped participant; override any field per test. */
function rawParticipant(overrides: Partial<RawParticipant> = {}): RawParticipant {
  return {
    score: 42,
    streak: { type: "Attended", value: 3 },
    attendance_history: 0b1101,
    credit: 1_000n,
    cashed_out: false,
    reached_personhood: true,
    has_ever_reached_personhood: true,
    recognition: { type: "Recognized", value: 5n },
    last_attended_game: 7_777,
    ...overrides,
  };
}

describe("decodeAbsenceGracePolicy", () => {
  it("decodes the serialized [allowed_misses, window] pair", () => {
    expect(decodeAbsenceGracePolicy("0x0506")).toEqual({
      allowedMisses: 5,
      window: 6,
    });
  });

  it("preserves zeroes in 0x0000", () => {
    expect(decodeAbsenceGracePolicy("0x0000")).toEqual({
      allowedMisses: 0,
      window: 0,
    });
  });

  it.each([
    ["0x", "empty value"],
    ["0x05", "one byte"],
    ["0x050", "odd length"],
    ["0x050607", "three bytes"],
    ["0x0g06", "non-hex digit"],
    ["0506", "missing 0x prefix"],
  ])("throws on %s (%s)", (value) => {
    expect(() => decodeAbsenceGracePolicy(value)).toThrow();
  });
});

describe("toHumanityCardParticipant", () => {
  it("maps every field of a representative participant", () => {
    expect(toHumanityCardParticipant(rawParticipant())).toEqual({
      score: 42,
      streak: { tag: "Attended", count: 3 },
      attendanceHistory: 0b1101,
      reachedPersonhood: true,
      hasEverReachedPersonhood: true,
      recognition: "Recognized",
      lastAttendedGame: 7_777,
    });
  });

  it("carries both streak variants through under the chain's own names", () => {
    const cases: Array<[RawStreak, "Attended" | "Absent"]> = [
      [{ type: "Attended", value: 3 }, "Attended"],
      [{ type: "Absent", value: 2 }, "Absent"],
    ];
    for (const [streak, expected] of cases) {
      expect(toHumanityCardParticipant(rawParticipant({ streak }))).toEqual(
        expect.objectContaining({
          streak: { tag: expected, count: streak.value },
        }),
      );
    }
  });

  it("maps all four recognition variants through unchanged", () => {
    const cases: Array<[RawRecognition, RawRecognition["type"]]> = [
      [{ type: "ExternallyRecognized", value: undefined }, "ExternallyRecognized"],
      [{ type: "NotRecognized", value: undefined }, "NotRecognized"],
      [{ type: "Suspended", value: 9n }, "Suspended"],
      [{ type: "Recognized", value: 5n }, "Recognized"],
    ];
    for (const [recognition, expected] of cases) {
      expect(toHumanityCardParticipant(rawParticipant({ recognition }))).toEqual(
        expect.objectContaining({ recognition: expected }),
      );
    }
  });

  it("maps a missing last_attended_game to null", () => {
    expect(
      toHumanityCardParticipant(rawParticipant({ last_attended_game: undefined })),
    ).toEqual(expect.objectContaining({ lastAttendedGame: null }));
  });

  it("throws on an unknown streak variant", () => {
    const raw = rawParticipant();
    raw.streak = { type: "Maybe", value: 1 } as unknown as RawStreak;
    expect(() => toHumanityCardParticipant(raw)).toThrow();
  });

  it("throws on an unknown recognition variant", () => {
    const raw = rawParticipant();
    raw.recognition = {
      type: "Provisional",
      value: undefined,
    } as unknown as RawRecognition;
    expect(() => toHumanityCardParticipant(raw)).toThrow();
  });
});

describe("toHumanityCardResult", () => {
  /** SS58-42 username-owner account (Alice's well-known address). */
  const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const CANDIDATE = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  /** A person's standing in a ring, as `readRingStandingForKey` reports it. */
  function standing(
    position: RingPosition,
    key = `0x${"11".repeat(32)}`,
  ): PersonRingStanding {
    return {
      source: "personhood-key",
      personalId: null,
      ringVrfKey: key as PersonRingStanding["ringVrfKey"],
      position,
      ring: null,
    };
  }

  function reads(
    overrides: Partial<HumanityCardReadInputs> = {},
  ): HumanityCardReadInputs {
    return {
      primaryUsername: "Alice.dot",
      ownerAccount: OWNER,
      gameAccount: CANDIDATE,
      rawParticipant: rawParticipant(),
      litePerson: null,
      membershipStanding: null,
      devicehoodRing: null,
      deviceKeyCheck: null,
      isUpgradedIdentity: false,
      personhoodThreshold: 6,
      absenceGraceRatio: "0x0506",
      ...overrides,
    };
  }

  it("keeps the username owner separate from the candidate account", () => {
    expect(toHumanityCardResult(reads())).toEqual({
      kind: "card",
      participantKey: "account",
      primaryUsername: "Alice.dot",
      accountAddress: OWNER,
      ownerAccount: OWNER,
      participant: toHumanityCardParticipant(rawParticipant()),
      devicehood: null,
      membershipStanding: null,
      devicehoodRing: null,
      deviceKeyCheck: null,
      state: {
        kind: "member",
        activeWeeks: 3,
        lastAttendedGame: 7_777,
        attendanceHistory: 0b1101,
        window: 6,
      },
      playerIdentities: { accountAddress: CANDIDATE },
      // The snapshot is the derivation input, carried so a reader can see the
      // threshold and grace policy on every state, not just the ones quoting them.
      snapshot: {
        isLitePerson: false,
        isUpgradedIdentity: false,
        membershipRing: null,
        devicehoodRing: null,
        participant: toHumanityCardParticipant(rawParticipant()),
        personhoodThreshold: 6,
        policy: { allowedMisses: 5, window: 6 },
      },
    });
  });

  it("preserves whether recovery evidence came from an account or person alias", () => {
    expect(toHumanityCardResult(reads({ participantKey: "person" })).participantKey).toBe("person");
    expect(toHumanityCardResult(reads({ participantKey: "account" })).participantKey).toBe("account");
    expect(toHumanityCardResult(reads({ rawParticipant: null })).participantKey).toBeNull();
  });

  it("shows the candidate account when the DotNS name has no owner on chain", () => {
    // An unregistered name says nothing about personhood, so the card still
    // resolves — about the person, not about the name — and the only account
    // we hold is the one that plays the game.
    const result = toHumanityCardResult(reads({ ownerAccount: null }));
    expect(result.accountAddress).toBe(CANDIDATE);
    expect(result.playerIdentities.accountAddress).toBe(CANDIDATE);
  });

  it("plays the weekly game on the game account, not the username owner", () => {
    const result = toHumanityCardResult(reads());
    expect(result.playerIdentities).toEqual({ accountAddress: CANDIDATE });
    // The card's own address is untouched: it names the person, not the seat.
    expect(result.accountAddress).toBe(OWNER);
  });


/** A minimal `PeopleLite.LitePeople` value; the method arm is exercised on
 *  `toDevicehood` directly. */
const liteRecord = (): RawLitePerson => ({
  ring_vrf_key: `0x${"ab".repeat(32)}`,
  method: { type: "Fee" },
});

  it("derives lite/not-enrolled states when no participant record exists", () => {
    expect(
      toHumanityCardResult(reads({ rawParticipant: null, litePerson: liteRecord() }))
        .state,
    ).toEqual({ kind: "devicehood", personhoodThreshold: 6 });
    expect(
      toHumanityCardResult(reads({ rawParticipant: null, litePerson: null }))
        .state,
    ).toEqual({ kind: "not-enrolled" });
  });

  it("puts each ring standing's position on the snapshot and keeps the standing", () => {
    // The snapshot carries only the position the state derives from; the
    // full standing stays on the result for the debug panel's key rows.
    const membership = standing({ kind: "absent" }, `0x${"22".repeat(32)}`);
    const devicehood = standing({ kind: "included", ringIndex: 1, ringPage: 0, ringPosition: 0 });
    const result = toHumanityCardResult(
      reads({
        rawParticipant: null,
        membershipStanding: membership,
        devicehoodRing: { kind: "placed", ringVrfKey: devicehood.ringVrfKey, standing: devicehood },
      }),
    );

    expect(result.snapshot.membershipRing).toEqual({ kind: "absent" });
    expect(result.snapshot.devicehoodRing).toEqual({
      kind: "included",
      ringIndex: 1,
      ringPage: 0,
      ringPosition: 0,
    });
    expect(result.membershipStanding).toBe(membership);
    expect(result.devicehoodRing).toMatchObject({ kind: "placed", standing: devicehood });
    // Devicehood off the lite ring, with no LitePeople record read at all.
    expect(result.state).toEqual({ kind: "devicehood", personhoodThreshold: 6 });
  });

  it("leaves a ring position null when the standing is unanswerable", () => {
    const snapshot = toHumanityCardResult(
      reads({ membershipStanding: null, devicehoodRing: null }),
    ).snapshot;
    expect(snapshot.membershipRing).toBeNull();
    expect(snapshot.devicehoodRing).toBeNull();
  });

  it("no longer renders an upgraded identity as a member on the label alone", () => {
    // The DotNS label is display only: Membership is ring inclusion, and a
    // stale lite record with no ring answer leaves them at Devicehood.
    expect(
      toHumanityCardResult(
        reads({
          rawParticipant: null,
          litePerson: liteRecord(),
          isUpgradedIdentity: true,
        }),
      ).state,
    ).toEqual({ kind: "devicehood", personhoodThreshold: 6 });
    // Still carried for the username-claim flow and the debug panel.
    expect(
      toHumanityCardResult(reads({ isUpgradedIdentity: true })).snapshot
        .isUpgradedIdentity,
    ).toBe(true);
  });

  it("wires the personhood threshold and grace policy into the state", () => {
    const result = toHumanityCardResult(
      reads({
        rawParticipant: rawParticipant({
          recognition: { type: "NotRecognized", value: undefined },
          reached_personhood: false,
          has_ever_reached_personhood: false,
          score: 4,
        }),
      }),
    );
    expect(result.state).toEqual({
      kind: "candidate",
      score: 4,
      personhoodThreshold: 6, gamesRemaining: 1
    });
  });
});

describe("toDevicehood", () => {
  const KEY = `0x${"ab".repeat(32)}`;
  const ATTESTER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  it("names the attester that corroborated a unique device", () => {
    expect(
      toDevicehood({
        ring_vrf_key: KEY,
        method: { type: "UniqueDevice", value: ATTESTER },
      }),
    ).toEqual({
      ringVrfKey: KEY,
      method: { kind: "unique-device", attester: ATTESTER },
    });
  });

  it("reports a fee registration, which proves no device at all", () => {
    expect(
      toDevicehood({ ring_vrf_key: KEY, method: { type: "Fee" } }),
    ).toEqual({ ringVrfKey: KEY, method: { kind: "fee" } });
  });

  it("carries the ring key through, since it is what a ring read takes", () => {
    expect(
      toDevicehood({ ring_vrf_key: KEY, method: { type: "Fee" } }).ringVrfKey,
    ).toBe(KEY);
  });

  it("rejects a unique device with no attester", () => {
    expect(() =>
      toDevicehood({ ring_vrf_key: KEY, method: { type: "UniqueDevice" } }),
    ).toThrow("without an attester");
  });

  it("rejects a method variant a runtime upgrade added", () => {
    // `Voucher(PersonalId)` is written but commented out upstream, so this is
    // the shape the next upgrade arrives in.
    expect(() =>
      toDevicehood({
        ring_vrf_key: KEY,
        method: { type: "Voucher", value: "7" },
      } as RawLitePerson),
    ).toThrow("unknown recognition method variant");
  });
});

describe("toDeviceKeyCheck", () => {
  // The state that cost the three-agent investigation: previewnet's
  // `peopl.testnet` index-1 host key against `PeopleLite.LitePeople`'s
  // attested key for the same person. Measured 2026-09-08.
  const HOST_KEY: HexString =
    "0x936d177b3a002d37c890b0e95fce4de2362d38a7ae36ecff3b9c2f0467b46de0";
  const CHAIN_KEY: HexString =
    "0x8cad933a3e1ff2614e9572c9eab78eccb983aa524fa68d53dc00395c35f0b5ee";
  const OWNER = "peopl.testnet";

  const liteRecord = (key = CHAIN_KEY): RawLitePerson => ({
    ring_vrf_key: key,
    method: { type: "Fee" },
  });

  const found = (key: HexString): PersonhoodRingKeyLookup => ({
    kind: "found",
    key,
  });

  it("reports a mismatch carrying both keys", () => {
    expect(toDeviceKeyCheck(found(HOST_KEY), OWNER, liteRecord())).toEqual({
      kind: "mismatch",
      hostKey: HOST_KEY,
      chainKey: CHAIN_KEY,
    });
  });

  it("matches equal keys, case-insensitively", () => {
    const upperChainKey = `0x${CHAIN_KEY.slice(2).toUpperCase()}` as HexString;
    expect(
      toDeviceKeyCheck(found(CHAIN_KEY), OWNER, liteRecord(upperChainKey)),
    ).toEqual({ kind: "matches", key: CHAIN_KEY });
  });

  it("names the owner when the host declares no key for the ring", () => {
    expect(
      toDeviceKeyCheck({ kind: "not-declared" }, OWNER, liteRecord()),
    ).toEqual({ kind: "no-host-key", owner: OWNER });
  });

  it("is unknown when the host has no key registry to ask", () => {
    expect(
      toDeviceKeyCheck({ kind: "no-registry" }, OWNER, liteRecord()),
    ).toEqual({ kind: "unknown", reason: expect.any(String) });
  });

  it("is null with no chain record to check against", () => {
    expect(toDeviceKeyCheck(found(HOST_KEY), OWNER, null)).toBeNull();
    // Not applicable regardless of what the host lookup answered.
    expect(
      toDeviceKeyCheck({ kind: "not-declared" }, OWNER, null),
    ).toBeNull();
  });
});
