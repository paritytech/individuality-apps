// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The PoC's two rules that are pure arithmetic over what the People chain holds, kept apart from the steps so that
// they can be tested without a lab.

/** How long a sign-up needs before the game: opening Jollity, the first name link (PGAS claim, store, note), the bind
 *  and the sign-up itself. Run 5 on live entered a window with 330 s left and ran out of it. */
export const SIGN_UP_NEEDS_S = 600;
/** How far ahead the lab's own game plays: live's 20 minutes, so its sign-up window is as long as a live one. */
export const OWN_GAME_PLAYS_IN_S = 1200;
/** Slack for the root call to be included before the runtime's earliest play time has passed. */
export const INCLUSION_SLACK_S = 120;

export type Phases = { registration: number; shuffle: number; post_shuffle_margin: number };

/** When the lab's own game plays: `playsInS` after now, or after the game already on the chain, and never sooner than
 *  the runtime's registration, shuffle and margin allow. */
export function ownGamePlayTime(nowS: number, currentGameDate: number | undefined, phases: Phases, playsInS = OWN_GAME_PLAYS_IN_S) {
  const earliest = phases.registration + phases.shuffle + phases.post_shuffle_margin + INCLUSION_SLACK_S;
  const at = Math.ceil(Math.max(nowS, currentGameDate ?? 0)) + Math.max(playsInS, earliest);
  if (!Number.isSafeInteger(at) || at > 0xffff_ffff) throw Error("The game's play time is outside the runtime's u32 range");
  return at;
}

/** The part of a `Score.Participants` record the card's label follows. */
export type Participant = { reached_personhood?: boolean; has_ever_reached_personhood?: boolean };

/**
 * What Humanity's card calls a lite person, by what the People chain holds for her game account. Her first sign-up
 * writes her `Score.Participants` record, and from then on she is a candidate; before it she has none and is a
 * person. A new person on a local copy is the first, the one named person a live run reuses is the second from her
 * second run on. Someone who reached personhood is past both, and past this scenario: undefined.
 */
export function standingLabel(participant: Participant | undefined): 'Person' | 'Candidate' | undefined {
  if (!participant) return 'Person';
  if (participant.reached_personhood || participant.has_ever_reached_personhood) return undefined;
  return 'Candidate';
}

/**
 * A selector that ends in Playwright's `>> nth=N` chain, as its CSS and the index; undefined for a selector without
 * one. A phone's page takes CSS only (paritytech/product-lab#193), and the shared play loop asks for a tile with the
 * chain: the lab takes it out and asks the locator for the index instead (play-steps.ts).
 */
export function chainedNth(selector: string): { css: string; nth: number } | undefined {
  const found = /^([\s\S]*\S)\s*>>\s*nth=(-?\d+)\s*$/.exec(selector);
  return found ? { css: found[1]!, nth: Number(found[2]) } : undefined;
}
