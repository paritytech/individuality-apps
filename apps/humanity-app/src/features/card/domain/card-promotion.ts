// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure one-shot promotion tracker for the humanity card: the moment the
 *  person becomes a member, as Jollity tells them — the score clears the
 *  threshold (`membership-ready`), before the ring key lands. No React, no
 *  storage — feed it observed card states and it latches the first move from
 *  devicehood or candidate to membership-ready or member, once, until
 *  dismissed. The first
 *  observed state seeds the baseline without firing:
 *  that state is the previous-session card hydrated by the react-query
 *  persister, so an entry-time promotion is just the hydrated candidate
 *  followed by the first fresh member refetch. After dismiss the baseline is
 *  the current state, so the same promotion never re-fires while the card
 *  stays member. */
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

/** The latched promotion: the pre-membership state the card moved from, and
 *  the fresh membership-ready or member state it moved to. */
export interface CardPromotion {
  from: HumanityCardState;
  to: HumanityCardState;
}

/** Tracker state: the last observed defined card state (the baseline) and
 *  the latched promotion, if any. */
export interface CardPromotionTracker {
  baseline: HumanityCardState | null;
  promotion: CardPromotion | null;
}

/** A fresh tracker: no baseline, no promotion. */
export function createCardPromotionTracker(): CardPromotionTracker {
  return { baseline: null, promotion: null };
}

/** Advance the tracker with one observed card state.
 *  - `undefined` (pending/refetch without data) never disturbs the tracker.
 *  - A latched promotion ignores everything until `dismissCardPromotion`.
 *  - The same state object observed again is a no-op.
 *  - The first observed state seeds the baseline without firing.
 *  - A later move from devicehood or candidate to membership-ready or member
 *    latches once; membership-ready to member does not, it was celebrated. */
export function trackCardPromotion(
  tracker: CardPromotionTracker,
  next: HumanityCardState | undefined,
): CardPromotionTracker {
  if (next === undefined || tracker.promotion !== null) {
    return tracker;
  }
  const previous = tracker.baseline;
  // Re-observing the same state must return the SAME tracker: a caller that
  // feeds this from an effect would otherwise re-render on every observation
  // and loop forever against a source that rebuilds its state object.
  if (previous === next) {
    return tracker;
  }
  // The celebration is for earning membership, as Jollity's results card has
  // it: the score clearing the threshold (`membership-ready`) is the moment,
  // and the wait from there for `Score.register` and the ring key
  // (`use-auto-register-personhood.ts`) is not a second one. What only the
  // ring key allows, the name, waits for it on its own (`usernameClaimTarget`).
  const wasOnTheWay =
    previous !== null && (previous.kind === "devicehood" || previous.kind === "candidate");
  if (wasOnTheWay && (next.kind === "membership-ready" || next.kind === "member")) {
    return { baseline: next, promotion: { from: previous, to: next } };
  }
  return { baseline: next, promotion: null };
}

/** Dismiss the latched promotion. The baseline is already the current
 *  observed state, so the same transition cannot re-fire while the card
 *  stays member. */
export function dismissCardPromotion(
  tracker: CardPromotionTracker,
): CardPromotionTracker {
  return tracker.promotion === null
    ? tracker
    : { ...tracker, promotion: null };
}
