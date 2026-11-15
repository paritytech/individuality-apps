// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Copy and tint for the Humanity card home screen.
 *  Every line is chain-truthful: no score, no promised game count, no dates.
 *  The ladder a person reads is person, candidate, member — never the
 *  chain's words (`CONTEXT.md` keeps those for code). */
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { heatRankForScore } from "./card-heat.ts";
import type { SuspensionRecovery } from "./suspension-recovery.ts";

/** Daily-dollar eligibility: runtime/personhood must permit claiming.
 *
 *  `membership-ready` is included because it was included before this state
 *  existed, not because the runtime is known to allow it — the claim needs a
 *  ring-VRF key in the Membership ring, which is the one thing this state
 *  lacks. If a claim from here is refused on chain, this predicate is the
 *  line to change. */
export function mayClaimDaily(state: HumanityCardState): boolean {
  return (
    state.kind === "member" ||
    state.kind === "membership-ready" ||
    state.kind === "caution"
  );
}

/** The card's accessible name. Rank is material only, so nothing prints on
 *  the face; a screen reader still hears where the card stands, in the
 *  ladder's own words. Membership Ready reads as member: the person earned
 *  it, and the wait for the ring is not theirs to act on. */
export function cardStatusLabel(state: HumanityCardState): string {
  switch (state.kind) {
    case "not-enrolled":
      return "Not ready yet";
    case "devicehood":
      return "Person";
    case "candidate":
      return "Candidate";
    case "membership-ready":
    case "member":
      return "Member";
    case "caution":
      return "Member, at risk";
    case "suspended":
      return "Suspended";
  }
}

/** Home screen title copy, truthful per state. Members get none: the card
 *  and the rows under it say it all. */
export function homeTitle(state: HumanityCardState): string | null {
  switch (state.kind) {
    case "not-enrolled":
      return "Your card isn't ready yet";
    case "devicehood":
      return "Become a member";
    case "candidate":
      return state.gamesRemaining === 1 ? "Almost a member" : "On your way";
    case "membership-ready":
    case "member":
      return null;
    case "caution":
      return "Membership at risk";
    case "suspended":
      return "Membership paused";
  }
}

/** Home screen subtitle copy, truthful per state. `when` is the next game's
 *  day as the caution line says it ("today", "tomorrow", "this Saturday"),
 *  when one is scheduled; the caution line names the day it can.
 *  `recovery` says whether a suspended member's games already cover the way
 *  back (`suspensionRecovery`); unknown keeps the general line. */
export function homeSub(
  state: HumanityCardState,
  when: string | null = null,
  recovery: SuspensionRecovery = "unknown",
): string | null {
  switch (state.kind) {
    case "not-enrolled":
      return "The Polkadot app sets it up. Reopen the app if this doesn't change.";
    case "devicehood":
      return "Play the weekly game to become a member.";
    case "candidate":
      return candidateSub(state.gamesRemaining);
    case "membership-ready":
    case "member":
      return null;
    case "caution":
      return when == null ? "Play the next game to keep it." : `Play ${when} to keep it.`;
    case "suspended":
      return suspendedSub(recovery);
  }
}

/** Candidate subtitle: name silver when the next game reaches it, and keep
 *  playing otherwise.
 *
 *  `gamesRemaining` comes from the SDK, which counts the way the runtime
 *  scores: a game adds the *streak*, and the streak grows every week. This
 *  used to ask whether `score + 1` cleared the threshold, which is only the
 *  first game of a streak — so anyone on a run of two or more was told to
 *  keep playing on the very game that would have finished it. */
function candidateSub(gamesRemaining: number): string {
  return gamesRemaining === 1
    ? "One more game to go."
    : "Each game counts toward membership.";
}

/** Suspended subtitle. "ready" means the games already played clear the bar,
 *  so registering again is the whole way back; "play" means it takes more
 *  games, and the line says so rather than promising one. */
function suspendedSub(recovery: SuspensionRecovery): string {
  switch (recovery) {
    case "ready":
      return "Register for the next game to pick up where you left off.";
    case "play":
      return "Play the next game to start rebuilding. It can take more than one.";
    case "unknown":
      return "Register for another game to restart your membership journey.";
  }
}

/** What a first-timer reads under a registered seat. */
export function firstGameConfirmedNote(): string {
  return "Your card updates after you play.";
}

/** The line under a cautioned member's game block. */
export const CAUTION_GAME_NOTE = "One game keeps your membership.";

/** Ambient color for the home screen per state. */
export function homeAmbient(state: HumanityCardState): string {
  switch (state.kind) {
    case "membership-ready":
    case "member":
      return "rgba(244,114,182,0.14)";
    case "candidate": {
      const rank = heatRankForScore(state.score, state.personhoodThreshold);
      return rank?.ambient ?? "rgba(255,255,255,0.08)";
    }
    case "caution":
      return "rgba(200,140,40,0.14)";
    case "suspended":
      return "rgba(160,160,160,0.12)";
    case "devicehood":
    case "not-enrolled":
    default:
      return "rgba(180,190,210,0.10)";
  }
}
