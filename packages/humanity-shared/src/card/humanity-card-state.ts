// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The card's state, derived from chain state.
 *
 * **The rings are the source of truth.** Membership is inclusion in the
 * Membership ring and nothing else, and Devicehood is inclusion in the lite
 * ring: both are facts the chain holds about a person's ring-VRF key, and
 * both are reachable by roads this app does not drive. `Score.register` is
 * one of them; `DummyDim.recognize_personhood` puts a key in the ring under
 * sudo with no participant record at all, and every further method (DIM1,
 * DIM3) is expected to arrive the same way. So the ring answers "are you a
 * Member", and the score only ever answers "how far along is this person" —
 * which is why a ring answer is never overruled by a score.
 *
 * What the score is still needed for is detail the ring cannot carry: how
 * many games a Candidate has left, and whether a Member is missing games
 * (Caution) or has missed too many (Suspended). That fold lives in
 * `derivePersonhoodState` in `@parity/product-sdk/individuality` — the
 * runtime's own rules for recognition, the personhood threshold and the
 * absence-grace window belong next to the runtime, not in a copy here — and
 * `asCardState` renames its seven states into the product's vocabulary.
 *
 * DotNS is **not** consulted. A bare username (no lite `.<digits>` suffix)
 * used to floor the card at `member`, which made a naming convention into
 * evidence of personhood; the rings answer the same question directly, for
 * everyone, including the people that floor was invented for.
 *
 * The card's states *are* the runtime's states, one for one. Where the two
 * vocabularies differ the product's word wins (`Lite` is `devicehood`), and
 * nothing is collapsed: `MembershipReady` is a state a person is really in —
 * earned Membership, no key in the ring yet — and renders as a member today
 * only because that is a presentation choice, made per surface and visible
 * at each one.
 */
import {
  derivePersonhoodState,
  type PersonhoodParticipant,
  type PersonhoodState,
} from "@humanity/shared/chain/individuality.ts";
import type { RingPosition } from "@humanity/shared/chain/ring-membership.ts";

/**
 * A game participant as read from `Score.Participants` and decoded.
 *
 * `attendanceHistory` is a rolling byte: bit 0 is the most recent game,
 * 1 = attended, 0 = absent.
 *
 * `hasEverReachedPersonhood` is ours rather than the SDK's: the derivation
 * has no use for it, but the debug panel reports it, because a person who
 * once cleared the threshold and no longer has the flag is a different story
 * from one who never did.
 */
export interface HumanityCardParticipant extends PersonhoodParticipant {
  hasEverReachedPersonhood: boolean;
}

/** Everything the card needs to derive a state, resolved per account. */
export interface HumanityCardSnapshot {
  /** Presence of a `PeopleLite.LitePeople` record. The last-resort evidence
   *  of Devicehood: used only when the lite ring cannot be asked at all. */
  isLitePerson: boolean;
  /** A DotNS label with no lite `.<digits>` suffix. Display and the
   *  username-claim flow only — the state derivation does not read it, since
   *  a naming convention is not evidence of personhood. */
  isUpgradedIdentity: boolean;
  participant: HumanityCardParticipant | null;
  personhoodThreshold: number;
  policy: { allowedMisses: number; window: number };
  /**
   * Where this person's key stands with the **Membership ring** — the fact
   * Membership *is*. `absent` is an answer ("no entry for their key"), while
   * `null` is the absence of one: no key from the host and no account bound
   * to a personal id, so the ring was never asked. The derivation treats
   * those differently, which is the whole point of keeping them apart.
   */
  membershipRing: RingPosition | null;
  /**
   * Where this person's key stands with the **lite (Devicehood) ring** —
   * the fact Devicehood is. `null` is again "unanswerable": no lite key from
   * the host and no `PeopleLite.LitePeople` record to take one from, in
   * which case {@link isLitePerson} is all that is left.
   */
  devicehoodRing: RingPosition | null;
}

/**
 * Every `kind` a {@link HumanityCardState} can carry, for data that crosses a
 * boundary untyped. A durable snapshot written by an older build can name a
 * state that no longer exists (`lite` was one), and a face
 * asked to render it has nothing to show. The `Record` keeps the list in step
 * with the union: a kind added to one and not the other fails to compile.
 */
const HUMANITY_CARD_STATE_KINDS: Record<HumanityCardState["kind"], true> = {
  "not-enrolled": true,
  devicehood: true,
  candidate: true,
  "membership-ready": true,
  member: true,
  caution: true,
  suspended: true,
};

export function isHumanityCardStateKind(
  value: unknown,
): value is HumanityCardState["kind"] {
  return (
    typeof value === "string" &&
    Object.hasOwn(HUMANITY_CARD_STATE_KINDS, value)
  );
}

/** The closed set of states a humanity card can be in. */
export type HumanityCardState =
  | { kind: "not-enrolled" }
  /** The person's card. It carries the runtime's threshold so the face can
   *  draw the empty stripe a candidate will fill: a newcomer sees what the
   *  games are for before playing one. Optional only for a snapshot written
   *  before the field existed; the derivation always sets it. */
  | { kind: "devicehood"; personhoodThreshold?: number }
  | {
      kind: "candidate";
      score: number;
      personhoodThreshold: number;
      /** Consecutive attended games still needed to clear the threshold,
       *  accounting for the streak already running. 0 once the score is at or
       *  above it — the chain owns `reachedPersonhood`, so the card never
       *  infers it from `score >= threshold`. */
      gamesRemaining: number;
    }
  /** Membership earned, not yet provable. Either the key is queued and the
   *  ring has not been rebuilt (`onboarding`), or the ring has no entry for
   *  it while the score says it should — `Score.register` puts it there, and
   *  this app has not called it. Carries the member payload because every
   *  surface renders it as a member for now. */
  | {
      kind: "membership-ready";
      activeWeeks: number;
      lastAttendedGame: number | null;
      /** The rolling attendance byte, bit 0 the most recent game; null with
       *  no participant record (a person recognised by another method), who
       *  has no games to show. */
      attendanceHistory: number | null;
      /** `Score.AbsenceGraceRatio`'s window: how many recent games count. */
      window: number;
    }
  | {
      kind: "member";
      /** Consecutive attended games (weekly), 0 when the streak is absent. */
      activeWeeks: number;
      lastAttendedGame: number | null;
      attendanceHistory: number | null;
      window: number;
    }
  | {
      kind: "caution";
      /** Consecutive attended games, as for a member: Caution is projected
       *  (the next absence would cross the grace window), so a cautioned
       *  member can be on a streak. */
      activeWeeks: number;
      misses: number;
      allowedMisses: number;
      window: number;
      lastAttendedGame: number | null;
      attendanceHistory: number | null;
    }
  /**
   * Lost. The two roads here are not obviously one event, so the state says
   * which: `"ring"` is a key suspended from the Membership ring — the
   * chain's own verdict, and final as far as this app can see — while
   * `"attendance"` is the score's, a person suspended for missing too many
   * games in the grace window. UI copy is the same for both today; keeping
   * them apart is what makes it possible for it not to be.
   */
  | { kind: "suspended"; reason: SuspensionReason };

/** Why a card is suspended. See the `suspended` arm of {@link HumanityCardState}. */
export type SuspensionReason = "ring" | "attendance";

/**
 * The runtime's own view of this snapshot, in the runtime's own words.
 *
 * Exported for the debug panel, which reports chain state in chain vocabulary
 * rather than the product's — and re-deriving it from raw recognition was how
 * it used to get it, which is how it came to disagree with the card.
 */
export function personhoodStateFor(
  snapshot: HumanityCardSnapshot,
): PersonhoodState {
  return derivePersonhoodState({
    isLitePerson: snapshot.isLitePerson,
    participant: snapshot.participant,
    personhoodThreshold: snapshot.personhoodThreshold,
    policy: snapshot.policy,
  });
}

/** The SDK's seven states under the product's names. One for one: a state the
 * runtime distinguishes is a state this app can be in, so none is folded into
 * a neighbour here. Whether two of them happen to *look* alike is a question
 * for each surface, not for the domain. */
function asCardState(
  state: PersonhoodState,
  attendance: Attendance,
): HumanityCardState {
  const { activeWeeks, lastAttendedGame, attendanceHistory, window } =
    attendance;
  switch (state.tag) {
    case "NotEnrolled":
      return { kind: "not-enrolled" };
    case "Lite":
      return { kind: "devicehood" };
    case "Candidate":
      return {
        kind: "candidate",
        score: state.score,
        personhoodThreshold: state.personhoodThreshold,
        gamesRemaining: state.gamesRemaining,
      };
    case "MembershipReady":
      return {
        kind: "membership-ready",
        activeWeeks,
        lastAttendedGame,
        attendanceHistory,
        window,
      };
    case "Member":
      return { kind: "member", activeWeeks, lastAttendedGame, attendanceHistory, window };
    case "Caution":
      return {
        kind: "caution",
        activeWeeks,
        misses: state.misses,
        allowedMisses: state.allowedMisses,
        window: state.window,
        lastAttendedGame,
        attendanceHistory,
      };
    case "Suspended":
      return { kind: "suspended", reason: "attendance" };
  }
}

/** The attendance detail every member-family state carries, read off the
 *  participant once and passed down rather than recomputed per branch. The
 *  raw byte and the policy window travel too: the home draws the recent
 *  games from them, and only the runtime knows how many of them count. */
interface Attendance {
  readonly activeWeeks: number;
  readonly lastAttendedGame: number | null;
  readonly attendanceHistory: number | null;
  readonly window: number;
}

/**
 * What the **Membership ring** says, with the score supplying the detail the
 * ring cannot carry.
 *
 * Returns `null` for "the Membership ring does not settle this person" — not
 * in it, and the score has nothing to suggest they should be — which is the
 * one case where the Devicehood ring gets the question.
 *
 * The four ring answers:
 *
 * - `suspended` — the chain's own verdict on their key. Final; the score is
 *   not consulted, because a suspended key is not a member by any road.
 * - `included` — a Member, full stop. The score then says *which kind*: a
 *   cautioned Member really is included, and the caution is the more useful
 *   of the two facts; a score-suspended one is suspended for attendance,
 *   which is a different event from ring suspension and says so.
 * - `onboarding` — key queued, ring not yet rebuilt. Exactly Membership
 *   Ready, whatever the score says: the wait is real and must not be erased.
 * - `absent` — the ring has no entry for their key. Anyone the score puts at
 *   or past Membership has earned it and cannot prove it yet, which is again
 *   Membership Ready; a Candidate is still a Candidate; and for the two
 *   pre-personhood states the ring has simply told us nothing useful.
 *
 * `null` (never asked — no key from the host, no personal id bound) leaves
 * the score unchallenged for anyone it recognises at all. That is the road
 * this app took before the rings, and it stays the fallback for runs with no
 * host.
 */
function resolveMembership(
  sdk: HumanityCardState,
  position: RingPosition | null,
  attendance: Attendance,
): HumanityCardState | null {
  if (position == null) {
    switch (sdk.kind) {
      // `asCardState` already attributes its suspension to attendance.
      case "candidate":
      case "membership-ready":
      case "member":
      case "caution":
      case "suspended":
        return sdk;
      case "not-enrolled":
      case "devicehood":
        return null;
    }
  }
  switch (position.kind) {
    case "suspended":
      return { kind: "suspended", reason: "ring" };
    case "included":
      if (sdk.kind === "caution") return sdk;
      if (sdk.kind === "suspended") {
        return { kind: "suspended", reason: "attendance" };
      }
      return { kind: "member", ...attendance };
    case "onboarding":
      return { kind: "membership-ready", ...attendance };
    case "absent":
      switch (sdk.kind) {
        case "member":
        case "caution":
        case "suspended":
        case "membership-ready":
          return { kind: "membership-ready", ...attendance };
        case "candidate":
          return sdk;
        case "not-enrolled":
        case "devicehood":
          return null;
      }
  }
}

/**
 * What the **lite ring** says, asked only of people the Membership ring did
 * not settle.
 *
 * Any position at all is Devicehood: a queued or suspended lite key still
 * belongs to someone who proved a device or paid the fee, and Devicehood is
 * the state they reached, not a claim about what the ring can prove today.
 * `absent` is the chain saying they are not there, which is Not Enrolled.
 *
 * `null` is the lite ring never asked — no lite key from the host and no
 * `PeopleLite.LitePeople` record to take one from — and then the presence of
 * that record is the only evidence left. It is the pre-ring rule, kept for
 * exactly the case the rings cannot cover.
 */
function resolveDevicehood(
  position: RingPosition | null,
  isLitePerson: boolean,
  personhoodThreshold: number,
): HumanityCardState {
  const devicehood: HumanityCardState = { kind: "devicehood", personhoodThreshold };
  if (position == null) {
    return isLitePerson ? devicehood : { kind: "not-enrolled" };
  }
  switch (position.kind) {
    case "included":
    case "onboarding":
    case "suspended":
      return devicehood;
    case "absent":
      return { kind: "not-enrolled" };
  }
}

/**
 * Pure resolution of the humanity card state from chain query state.
 *
 * Rings first, in order: Membership, then Devicehood for whoever Membership
 * did not settle. The score is folded in only where a ring answer needs
 * detail (games remaining, misses) — never to overrule one, and never as
 * evidence of Membership on its own. DotNS is not consulted at all.
 */
export function deriveHumanityCardState(
  snapshot: HumanityCardSnapshot,
): HumanityCardState {
  const { participant } = snapshot;
  const attendance: Attendance = {
    activeWeeks:
      participant !== null && participant.streak.tag === "Attended"
        ? participant.streak.count
        : 0,
    lastAttendedGame: participant?.lastAttendedGame ?? null,
    attendanceHistory: participant?.attendanceHistory ?? null,
    window: snapshot.policy.window,
  };
  const sdk = asCardState(personhoodStateFor(snapshot), attendance);
  return (
    resolveMembership(sdk, snapshot.membershipRing, attendance) ??
    resolveDevicehood(
      snapshot.devicehoodRing,
      snapshot.isLitePerson,
      snapshot.personhoodThreshold,
    )
  );
}
