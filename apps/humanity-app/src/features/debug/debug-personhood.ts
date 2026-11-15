// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The personhood section of the debug panel — the reason it exists.
 *
 * The card's states now match the runtime's one for one, so `kind` can tell
 * a recognized person from one still waiting for a ring key. The label below
 * still reports the runtime's own view, in the runtime's own words: this is
 * the chain-facing surface, and `Lite person` or `Score.register` is what
 * someone debugging against the chain is looking for.
 */
import {
  personhoodStateFor,
  type HumanityCardSnapshot,
  type HumanityCardState,
} from "@humanity/shared/card/humanity-card-state.ts";
import type { PersonhoodState } from "@humanity/shared/chain/individuality.ts";

import type {
  DeviceKeyCheck,
  Devicehood,
  DevicehoodRingProbe,
} from "@humanity/shared/card/humanity-card-data.ts";
import type {
  PersonRingStanding,
  RingBuildState,
  RingName,
  RingPosition,
} from "@humanity/shared/chain/ring-membership.ts";

import {
  bool,
  hex32Short,
  MISSING,
  timestamp,
  type DebugRow,
} from "./debug-format.ts";

/**
 * The rolling attendance byte, most recent game first — the orientation the
 * runtime stores it in (bit 0 = latest game, 1 = attended).
 */
function attendanceBits(history: number): string {
  const bits = (history & 0xff).toString(2).padStart(8, "0").split("").reverse();
  return `${bits.join("")} (latest first)`;
}

/** The runtime's seven states, in runtime vocabulary.
 *
 *  The one case the runtime cannot describe is a Member the rings placed and
 *  the score has never recognised — the sudo faucet and every future DIM land
 *  exactly there, with a key in the ring and no participant record to explain
 *  it. Which recognition variant produced a `Member` is the panel's own
 *  `recognition` row, so nothing is lost by not repeating it here. */
export function matrixLabel(
  card: HumanityCardState,
  state: PersonhoodState,
): string {
  if (
    card.kind === "member" &&
    (state.tag === "NotEnrolled" ||
      state.tag === "Lite" ||
      state.tag === "Candidate")
  ) {
    return "Member (ring inclusion, no Score recognition)";
  }
  switch (state.tag) {
    case "NotEnrolled":
      return "Not enrolled (empty)";
    case "Lite":
      return "Lite person (lite)";
    case "Candidate":
      return `Candidate (scoring, ${state.gamesRemaining} game(s) to go)`;
    case "MembershipReady":
      return "Membership ready (claim it — Score.register not called)";
    case "Member":
      return "Member (included)";
    case "Caution":
      return "Caution (at risk)";
    case "Suspended":
      return "Suspended (lost)";
  }
}

/**
 * How this person reached Devicehood, and the key that proves it.
 *
 * Devicehood names the state, not the proof — a registration fee gets there
 * with no device attestation — so the method is the only thing on chain that
 * says which. The SDK reads this record for presence alone and discards both
 * fields, which is why the decode is ours.
 */
function devicehoodRows(devicehood: Devicehood | null): DebugRow[] {
  if (devicehood == null) {
    return [{ label: "devicehood", value: MISSING }];
  }
  const method =
    devicehood.method.kind === "fee"
      ? "fee (no device attestation)"
      : `unique device, attested by ${devicehood.method.attester}`;
  return [
    { label: "devicehood", value: method },
    { label: "devicehood ring key", value: devicehood.ringVrfKey },
  ];
}

/** Score against the threshold, with the distance left rather than a bare pair. */
function scoreRow(score: number | null, threshold: number): DebugRow {
  if (score == null) {
    return { label: "score / threshold", value: `${MISSING} / ${threshold}` };
  }
  const suffix =
    score >= threshold ? " (cleared)" : ` (${threshold - score} to go)`;
  return { label: "score / threshold", value: `${score} / ${threshold}${suffix}` };
}

/**
 * How a ring answered, in one string.
 *
 * `absent` is a real answer — the ring was asked about a key it does not hold
 * — and reads differently from having no standing at all, which is the ring
 * never asked. Both rings render through here so the two rows stay comparable.
 */
function positionText(position: RingPosition): string {
  switch (position.kind) {
    case "included":
      return `included (ring ${position.ringIndex})`;
    case "onboarding":
      return (
        `onboarding since ${new Date(position.queuedAtSeconds * 1000).toISOString()}` +
        ` (queue page ${position.queuePage})`
      );
    case "suspended":
      return "suspended from the ring";
    case "absent":
      return "no entry for this key";
  }
}

/**
 * The ring behind an `Included` key: which slot, how much of the ring the
 * root actually covers, which revision, and whether a rebuild is pending.
 *
 * `Included` is a slot assignment, so it does not say a proof can be made
 * for the key. When the host refuses to prove for a key the chain calls
 * `Included`, these two rows are the whole question: partial coverage or a
 * stale ring means the chain is still building and the host is right to
 * refuse; full coverage with a built root means the refusal is the host's
 * own — a different registered key, or a stale snapshot on its side.
 *
 * `group` prefixes both labels: the panel places two different keys in two
 * different rings, and a bare `ring slot` would not say which.
 */
function ringDetailRows(
  position: Extract<RingPosition, { kind: "included" }>,
  ring: RingBuildState | null,
  group: string,
): DebugRow[] {
  if (ring == null) {
    // A standing produced without the ring read — the mock backend answers a
    // whole standing of `null` today, but the field is independently nullable
    // and a card is worth rendering either way. The slot is still real; the
    // root is unknown, which is not the same as absent.
    return [
      {
        label: `${group} slot`,
        value: `ring ${position.ringIndex}, position ${position.ringPosition} (page ${position.ringPage})`,
      },
      { label: `${group} root`, value: MISSING },
    ];
  }
  const sealed =
    ring.immutableSinceSeconds == null
      ? ""
      : `, immutable since ${timestamp(ring.immutableSinceSeconds)}`;
  return [
    {
      label: `${group} slot`,
      value:
        `ring ${position.ringIndex}, position ${position.ringPosition}` +
        ` of ${ring.totalKeys} keys (page ${position.ringPage}),` +
        ` ${ring.includedKeys} included in the root`,
    },
    {
      label: `${group} root`,
      value:
        `${ring.rootRevision == null ? "never built" : `revision ${ring.rootRevision}`}, ` +
        `${ring.stale ? "stale (rebuild queued)" : "not stale"}${sealed}`,
    },
  ];
}

/** The runtime's own name for the ring Devicehood keys are enrolled in. Named
 *  in every value below, so no row of this group can be read as one about the
 *  full people ring. */
const DEVICEHOOD_RING: RingName = "people-lite";

/** Label prefix for the whole group, `ring slot` / `ring root` included. */
const DEVICEHOOD_GROUP = "devicehood ring";

/**
 * Where the *chain-recorded* Devicehood key stands with the lite ring.
 *
 * Its own group, because the `membership ring` rows below are a different key
 * in a different ring: the full people ring, read with the key our host
 * discloses. For a lite person those rows correctly say `no entry for this
 * key` while these say `included` — both at once is the healthy shape, and it
 * was unreadable off a pasted snapshot while only one of the two rings was
 * ever placed. A fully built lite ring here plus a host that still refuses to
 * prove is the pair that convicts the host.
 *
 * An unanswered probe renders as an explicit unknown. "The ring holds no
 * entry for this key" is a claim about the chain; letting a read that never
 * happened wear it is the ambiguity this whole investigation kept hitting.
 */
function devicehoodRingRows(probe: DevicehoodRingProbe | null): DebugRow[] {
  if (probe == null) {
    return [
      {
        label: DEVICEHOOD_GROUP,
        value: `unknown: nothing read ${DEVICEHOOD_RING} for this card`,
      },
    ];
  }
  if (probe.kind === "no-record") {
    return [
      {
        label: DEVICEHOOD_GROUP,
        value: `unknown: no Devicehood record, so no key to place in ${DEVICEHOOD_RING}`,
      },
    ];
  }
  // The exact storage read, key in full: the row a reader re-runs by hand,
  // and the one that names which key every row above it is about.
  const lookup: DebugRow = {
    label: `${DEVICEHOOD_GROUP} lookup`,
    value: `Members.Members(${DEVICEHOOD_RING}, ${probe.ringVrfKey})`,
  };
  if (probe.kind === "failed") {
    return [
      {
        label: DEVICEHOOD_GROUP,
        value: `unknown: the ${DEVICEHOOD_RING} read failed, see the error row`,
      },
      { label: `${DEVICEHOOD_GROUP} error`, value: probe.error },
      lookup,
    ];
  }
  const { position, ring } = probe.standing;
  return [
    {
      label: DEVICEHOOD_GROUP,
      value:
        `${positionText(position)} — devicehood key ` +
        `${hex32Short(probe.ringVrfKey)} in ${DEVICEHOOD_RING}`,
    },
    ...(position.kind === "included"
      ? ringDetailRows(position, ring, DEVICEHOOD_GROUP)
      : []),
    lookup,
  ];
}

/**
 * Whether this host holds the lite member key the chain attested for the
 * person — the precondition `bind-game-seat.ts` checks before ever
 * submitting, and the reason the weekly-game card offers or withholds its
 * reservation action. Placed beside the devicehood ring rows above so a
 * reader sees the attested key and this verdict together: this check reads
 * two already-fetched keys against each other and issues no read of its own.
 *
 * An unanswered check (`unknown`, or `null` because nothing asked) renders
 * as an explicit unknown, matching every other probe in this file — it is a
 * diagnostic gap, never a negative answer.
 */
function deviceKeyCheckRow(check: DeviceKeyCheck | null): DebugRow {
  if (check == null) {
    return { label: "device key check", value: `${MISSING} (nothing checked)` };
  }
  switch (check.kind) {
    case "matches":
      return { label: "device key check", value: `matches — ${check.key}` };
    case "mismatch":
      return {
        label: "device key check",
        value: `mismatch — this device holds ${check.hostKey}, chain attested ${check.chainKey}`,
      };
    case "no-host-key":
      return {
        label: "device key check",
        value: `no key — ${check.owner} declares none on this device`,
      };
    case "unknown":
      return { label: "device key check", value: `unknown: ${check.reason}` };
  }
}

/**
 * Where this person's key stands with the Membership ring — the chain's own
 * answer to whether they are a Member, and the one the card derives from.
 *
 * No standing at all means the question was unanswerable: no ring key from
 * the host and no account of theirs bound to a personal id, so there is no
 * key to look up — which is most people, and says nothing either way.
 */
function membershipRows(standing: PersonRingStanding | null): DebugRow[] {
  if (standing == null) {
    return [
      {
        label: "membership ring",
        value: "unanswerable (no ring key from the host, no personal id bound)",
      },
    ];
  }
  const { position } = standing;
  // Which read answered is worth a row of its own: `account-binding` answered
  // about a person who happened to bind an account, which is a narrower claim
  // than `personhood-key`, and the difference explains a surprising `absent`.
  return [
    { label: "membership ring", value: positionText(position) },
    ...(position.kind === "included"
      ? ringDetailRows(position, standing.ring, "ring")
      : []),
    { label: "ring read", value: standing.source },
    {
      label: "personal id",
      value: standing.personalId == null ? MISSING : standing.personalId.toString(),
    },
    { label: "person ring key", value: standing.ringVrfKey },
  ];
}

/** Every personhood signal the card derived its state from, inputs included:
 *  the threshold and grace policy are otherwise invisible on the states that
 *  do not happen to quote them. */
export function personhoodRows(
  state: HumanityCardState,
  snapshot: HumanityCardSnapshot,
  devicehood: Devicehood | null = null,
  membershipStanding: PersonRingStanding | null = null,
  devicehoodRing: DevicehoodRingProbe | null = null,
  deviceKeyCheck: DeviceKeyCheck | null = null,
): DebugRow[] {
  const { participant, personhoodThreshold, policy } = snapshot;
  const rows: DebugRow[] = [
    { label: "card state", value: state.kind },
    { label: "matrix state", value: matrixLabel(state, personhoodStateFor(snapshot)) },
    scoreRow(participant?.score ?? null, personhoodThreshold),
    { label: "recognition", value: participant?.recognition ?? MISSING },
    {
      label: "reached personhood",
      value: participant == null ? MISSING : bool(participant.reachedPersonhood),
    },
    {
      label: "ever reached personhood",
      value:
        participant == null
          ? MISSING
          : bool(participant.hasEverReachedPersonhood),
    },
    { label: "lite person", value: bool(snapshot.isLitePerson) },
    ...devicehoodRows(devicehood),
    ...devicehoodRingRows(devicehoodRing),
    deviceKeyCheckRow(deviceKeyCheck),
    ...membershipRows(membershipStanding),
    { label: "upgraded identity", value: bool(snapshot.isUpgradedIdentity) },
    {
      label: "grace policy",
      value: `${policy.allowedMisses} allowed misses / ${policy.window} game window`,
    },
  ];
  if (participant != null) {
    rows.push(
      {
        label: "streak",
        value: `${participant.streak.count} ${participant.streak.tag}`,
      },
      {
        label: "attendance",
        value: attendanceBits(participant.attendanceHistory),
      },
      {
        label: "last attended game",
        value: participant.lastAttendedGame?.toString() ?? MISSING,
      },
    );
  }
  if (state.kind === "caution") {
    rows.push({
      label: "projected misses",
      value: `${state.misses} of ${state.allowedMisses} allowed (next absence)`,
    });
  }
  return rows;
}
