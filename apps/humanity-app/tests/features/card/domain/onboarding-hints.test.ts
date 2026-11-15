// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Tips for a first-time visitor: the first visit runs them in order, a
 *  later visit gets at most one and only after the gap, a tip left up on
 *  an earlier visit counts as seen, nothing done comes back, and every tip
 *  explains rather than repeats. */
import { describe, expect, it } from "vitest";

import {
  HINT_GAP_MS,
  NO_TARGETS,
  chooseOnboardingHint,
  onboardingHintCopy,
  settleEarlierVisit,
  type HintTargets,
} from "@features/card/domain/onboarding-hints.ts";
import {
  ONBOARDING_HINT_IDS,
  emptyHintRecord,
  withShown,
  type OnboardingHintRecord,
} from "@features/card/storage/onboarding-hints-store.ts";

const all: HintTargets = { card: true, register: true, stripe: true };
const NOW = 1_800_000_000_000;
const FIRST = "visit-1";
const LATER = "visit-2";

/** `record` with `ids` retired at `at`. */
const retire = (record: OnboardingHintRecord, ids: readonly (keyof HintTargets)[], at = NOW) => ({
  ...record,
  retired: { ...record.retired, ...Object.fromEntries(ids.map((id) => [id, at])) },
});

describe("chooseOnboardingHint, the first visit", () => {
  it("goes card, stripe, register", () => {
    let record = emptyHintRecord();
    for (const expected of ["card", "stripe", "register"] as const) {
      expect(chooseOnboardingHint(all, record, NOW, FIRST)).toBe(expected);
      record = retire(withShown(record, expected, NOW, FIRST), [expected]);
    }
    expect(chooseOnboardingHint(all, record, NOW, FIRST)).toBeNull();
  });

  it("gives a late target its turn in the same visit", () => {
    // The game read has not landed, so only the card is on screen.
    let record = withShown(emptyHintRecord(), "card", NOW, FIRST);
    record = retire(record, ["card"]);
    expect(chooseOnboardingHint({ ...NO_TARGETS, card: true }, record, NOW + 1, FIRST)).toBeNull();
    expect(chooseOnboardingHint({ ...NO_TARGETS, card: true, register: true }, record, NOW + 2, FIRST)).toBe("register");
  });

  it("keeps the tip already up on this visit", () => {
    const record = withShown(emptyHintRecord(), "card", NOW, FIRST);
    expect(chooseOnboardingHint(all, record, NOW + 1, FIRST)).toBe("card");
  });
});

describe("chooseOnboardingHint, a later visit", () => {
  const afterFirst = retire(withShown(emptyHintRecord(), "card", NOW, FIRST), ["card"]);

  it("waits for the gap since the last tip", () => {
    expect(chooseOnboardingHint(all, afterFirst, NOW + 2 * 60 * 60 * 1000, LATER)).toBeNull();
    expect(chooseOnboardingHint(all, afterFirst, NOW + HINT_GAP_MS, LATER)).toBe("stripe");
  });

  it("shows at most one tip, even once it is put away", () => {
    const shown = withShown(afterFirst, "stripe", NOW + HINT_GAP_MS, LATER);
    expect(chooseOnboardingHint(all, shown, NOW + HINT_GAP_MS + 1, LATER)).toBe("stripe");
    const putAway = retire(shown, ["stripe"], NOW + HINT_GAP_MS + 1);
    expect(chooseOnboardingHint(all, putAway, NOW + HINT_GAP_MS + 2, LATER)).toBeNull();
  });

  it("does not chain just because the earlier visit was the first", () => {
    const shown = retire(withShown(afterFirst, "stripe", NOW + HINT_GAP_MS, LATER), ["stripe"]);
    expect(chooseOnboardingHint(all, shown, NOW + HINT_GAP_MS + 1, LATER)).toBeNull();
  });
});

describe("settleEarlierVisit", () => {
  it("retires a tip that was still up when an earlier visit ended", () => {
    const left = withShown(emptyHintRecord(), "card", NOW, FIRST);
    const settled = settleEarlierVisit(left, LATER);
    expect(settled.retired.card).toBe(NOW);
    expect(chooseOnboardingHint(all, settled, NOW + HINT_GAP_MS, LATER)).toBe("stripe");
  });

  it("leaves this visit's tip, and a settled record, as they are", () => {
    const left = withShown(emptyHintRecord(), "card", NOW, FIRST);
    expect(settleEarlierVisit(left, FIRST)).toBe(left);
    const settled = settleEarlierVisit(left, LATER);
    expect(settleEarlierVisit(settled, LATER)).toBe(settled);
  });
});

describe("onboardingHintCopy", () => {
  it("says what a thing is and what it brings, in a title and one line", () => {
    for (const id of ONBOARDING_HINT_IDS) {
      const { title, body } = onboardingHintCopy(id);
      expect(title.length, id).toBeGreaterThan(0);
      expect(body.length, id).toBeGreaterThan(0);
      expect(title, id).not.toMatch(/^(register|tap to flip)$/i);
      expect(`${title} ${body}`, id).not.toMatch(/free|minutes|silver|warm|personhood|devicehood|—/i);
    }
    expect(onboardingHintCopy("card").title).toBe("This is your card");
    expect(onboardingHintCopy("card").body).toBe("Flip it over for a code others can scan to chat with you.");
    expect(onboardingHintCopy("register").title).toBe("This signs you up for the weekly game");
    expect(onboardingHintCopy("register").body).toContain("Register here");
  });
});
