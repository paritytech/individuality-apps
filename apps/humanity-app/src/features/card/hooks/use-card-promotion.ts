// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** useCardPromotion — one-shot celebration trigger for the person becoming a
 *  member: devicehood or candidate to membership-ready or member.
 *
 *  A thin React wrapper over the pure card-promotion tracker: it feeds the
 *  observed card state in and exposes the latched promotion plus a dismiss
 *  that resets the tracker's baseline to the current state. No storage here —
 *  the persisted react-query card cache already prevents repeats across
 *  sessions: once the fresh member result is persisted, the next entry
 *  hydrates `member` as the baseline and nothing fires. */
import { useCallback, useState } from "react";

import {
  createCardPromotionTracker,
  dismissCardPromotion,
  trackCardPromotion,
  type CardPromotion,
  type CardPromotionTracker,
} from "@features/card/domain/card-promotion.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

export interface CardPromotionResult {
  /** The latched transition into membership, null until one happens. */
  promotion: CardPromotion | null;
  /** Clear the latch and reset the baseline to the current state. */
  dismiss: () => void;
}

/** Observe the humanity card state (undefined while pending/unavailable) and
 *  latch the first move into membership-ready or member. */
export function useCardPromotion(
  state: HumanityCardState | undefined,
): CardPromotionResult {
  const [tracker, setTracker] = useState<CardPromotionTracker>(
    createCardPromotionTracker,
  );

  // Tracked during render, not in an effect: the render that first sees the
  // member card must already know it is a promotion, or anything gated on
  // it (the name screen's auto-open) acts a render too early. The tracker
  // returns itself for a state it has seen, so this settles in one pass.
  const next = trackCardPromotion(tracker, state);
  if (next !== tracker) setTracker(next);

  const dismiss = useCallback(() => {
    setTracker((current) => dismissCardPromotion(current));
  }, []);

  return { promotion: next.promotion, dismiss };
}
