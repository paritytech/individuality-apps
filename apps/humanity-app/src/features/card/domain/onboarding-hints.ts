// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which tip a visit gets, if any, and what it says. The tips are for a
 * first-time visitor: what the card is, what the stripe on it means, and
 * what registering does. What membership brings is on the screen itself.
 * A member has opened this screen many times and needs none of it, so the
 * home asks for tips only before membership.
 *
 * A visit is one page load. The rules, in order:
 *
 * - a tip shows only while its target is on screen and it has not yet done
 *   its job;
 * - the first visit (the one that showed the first tip ever) runs its tips
 *   one after another as each is put away, so a newcomer meets the screen
 *   in one sitting; a tip whose target arrives late still gets its turn;
 * - a later visit gets at most one tip, and only once `HINT_GAP_MS` has
 *   passed since the last tip shown;
 * - a tip has done its job once it has been on screen for a visit (it is
 *   retired when the next visit starts), once it is put away, or once the
 *   person did what it explains (registering).
 *
 * Pure: the home feeds it what is on screen and the stored record.
 */
import type {
  OnboardingHintId,
  OnboardingHintRecord,
} from "@features/card/storage/onboarding-hints-store.ts";

/** Six hours between one tip and the next outside the first visit: a later
 *  visit, not the same one. */
export const HINT_GAP_MS = 6 * 60 * 60 * 1000;

const ORDER: readonly OnboardingHintId[] = ["card", "stripe", "register"];

export type HintTargets = Record<OnboardingHintId, boolean>;

export const NO_TARGETS: HintTargets = { card: false, register: false, stripe: false };

/** A tip still on record as shown on an earlier visit has been seen: retire
 *  it. Returns `record` itself when there is nothing to settle. */
export function settleEarlierVisit(record: OnboardingHintRecord, visit: string): OnboardingHintRecord {
  const last = record.lastShown;
  if (last == null || last.visit === visit || record.retired[last.id] != null) return record;
  return { ...record, retired: { ...record.retired, [last.id]: last.at } };
}

export function chooseOnboardingHint(
  targets: HintTargets,
  record: OnboardingHintRecord,
  now: number,
  visit: string,
): OnboardingHintId | null {
  const last = record.lastShown;
  const firstVisit = last == null || record.firstVisit === visit;
  for (const id of ORDER) {
    if (!targets[id] || record.retired[id] != null) continue;
    // The tip already up on this visit stays up.
    if (last != null && last.id === id && last.visit === visit) return id;
    if (firstVisit) return id;
    // A later visit: one tip, spaced from the last.
    if (last != null && (last.visit === visit || now - last.at < HINT_GAP_MS)) return null;
    return id;
  }
  return null;
}

export interface HintCopy {
  title: string;
  body: string;
}

/** What each tip says: what the thing is and what it brings, never the
 *  label of the thing it points at. */
export function onboardingHintCopy(id: OnboardingHintId): HintCopy {
  switch (id) {
    case "card":
      return {
        title: "This is your card",
        body: "Flip it over for a code others can scan to chat with you.",
      };
    case "register":
      return {
        title: "This signs you up for the weekly game",
        body: "Register here and play at game time. Your card updates after you play.",
      };
    case "stripe":
      return {
        title: "Your progress",
        body: "Each game you play fills part of this stripe. When it is full, you are a member.",
      };
  }
}
