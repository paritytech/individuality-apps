// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  createCardPromotionTracker,
  dismissCardPromotion,
  trackCardPromotion,
} from "@features/card/domain/card-promotion.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

const candidate = (): HumanityCardState => ({
  kind: "candidate",
  score: 4,
  personhoodThreshold: 8,
  gamesRemaining: 1,
});
const membershipReady = (): HumanityCardState => ({
  kind: "membership-ready",
  activeWeeks: 1,
  lastAttendedGame: 5,
  attendanceHistory: 0,
  window: 8,
});
const member = (): HumanityCardState => ({
  kind: "member",
  activeWeeks: 1,
  lastAttendedGame: 5,
  attendanceHistory: 0,
  window: 8,
});
const notEnrolled = (): HumanityCardState => ({ kind: "not-enrolled" });
const devicehood = (): HumanityCardState => ({ kind: "devicehood", personhoodThreshold: 8 });

describe("trackCardPromotion", () => {
  it("latches candidate → member", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toEqual({ from: candidate(), to: member() });
  });

  it("latches candidate → membership-ready, before the ring key lands", () => {
    // Clearing the threshold is the moment, as Jollity's results card has it.
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, membershipReady());
    expect(tracker.promotion).toEqual({ from: candidate(), to: membershipReady() });
  });

  it("latches devicehood → membership-ready, a threshold cleared in one game", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, devicehood());
    tracker = trackCardPromotion(tracker, membershipReady());
    expect(tracker.promotion).toEqual({ from: devicehood(), to: membershipReady() });
  });

  it("does not latch membership-ready → member: the threshold was the moment", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, membershipReady());
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toBeNull();
  });

  it("latches candidate → membership-ready → member once, at membership-ready", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, membershipReady());
    tracker = dismissCardPromotion(tracker);
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toBeNull();
  });

  it("seeds the baseline from the first observed state without firing", () => {
    const tracker = trackCardPromotion(
      createCardPromotionTracker(),
      candidate(),
    );
    expect(tracker.promotion).toBeNull();
    expect(tracker.baseline).toEqual(candidate());
  });

  it("fires entry-time promotion: hydrated candidate, then fresh member refetch", () => {
    // Previous session persisted candidate; this session hydrates it, then
    // the first refetch lands member.
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toEqual({ from: candidate(), to: member() });
  });

  it("does not fire when the session starts already member", () => {
    const tracker = trackCardPromotion(createCardPromotionTracker(), member());
    expect(tracker.promotion).toBeNull();
  });

  it("does not fire candidate → candidate", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, candidate());
    expect(tracker.promotion).toBeNull();
  });

  it("does not fire member → member", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, member());
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toBeNull();
  });

  it("returns the same tracker when the same state object is observed again", () => {
    // The React caller feeds this from an effect: a fresh tracker on every
    // observation re-renders, re-observes, and loops until React bails out.
    const state = candidate();
    const seeded = trackCardPromotion(createCardPromotionTracker(), state);
    expect(trackCardPromotion(seeded, state)).toBe(seeded);
  });

  it("does not fire not-enrolled → member", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, notEnrolled());
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toBeNull();
  });

  it("ignores undefined gaps: candidate → undefined → member still fires", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, undefined);
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toEqual({ from: candidate(), to: member() });
  });

  it("does not fire a leading undefined gap into member", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, undefined);
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toBeNull();
  });

  it("latches once: later transitions cannot replace the latch", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, member());
    const latched = tracker.promotion;
    // Even a second candidate → member cycle is ignored while latched.
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toBe(latched);
  });
});

describe("dismissCardPromotion", () => {
  it("does not re-fire after dismiss while the card stays member", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, member());
    tracker = dismissCardPromotion(tracker);
    expect(tracker.promotion).toBeNull();
    // Subsequent member refetches (and undefined gaps) must not re-fire.
    tracker = trackCardPromotion(tracker, member());
    tracker = trackCardPromotion(tracker, undefined);
    tracker = trackCardPromotion(tracker, member());
    expect(tracker.promotion).toBeNull();
  });

  it("keeps the baseline at the current state after dismiss", () => {
    let tracker = createCardPromotionTracker();
    tracker = trackCardPromotion(tracker, candidate());
    tracker = trackCardPromotion(tracker, member());
    tracker = dismissCardPromotion(tracker);
    expect(tracker.baseline).toEqual(member());
  });

  it("is a no-op on an unlatched tracker", () => {
    const tracker = trackCardPromotion(
      createCardPromotionTracker(),
      candidate(),
    );
    expect(dismissCardPromotion(tracker)).toBe(tracker);
  });
});
