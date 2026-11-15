// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The hint record: empty on a fresh device, retiring and showing write a
 *  versioned record keyed on the network (not the cache schema), a tip left
 *  up by an earlier visit reads as seen, malformed or foreign records read
 *  as empty, and blocked storage never throws. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURRENT_VISIT,
  markOnboardingHintShown,
  readOnboardingHints,
  resetOnboardingHintsStoreForTests,
  retireOnboardingHint,
  startNewVisitForTests,
} from "@features/card/storage/onboarding-hints-store.ts";
import { NETWORK_SCOPE } from "@shared/chain/query-persistence.ts";

const KEY = `humanity-prizes:hints:${NETWORK_SCOPE}`;

beforeEach(() => {
  resetOnboardingHintsStoreForTests();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onboarding-hints-store", () => {
  it("starts empty and remembers what was shown and retired", () => {
    expect(readOnboardingHints()).toEqual({ version: 2, retired: {}, lastShown: null, firstVisit: null });
    markOnboardingHintShown("register", 100);
    retireOnboardingHint("register", 200);
    resetOnboardingHintsStoreForTests();
    expect(readOnboardingHints()).toEqual({
      version: 2,
      retired: { register: 200 },
      lastShown: { id: "register", at: 100, visit: CURRENT_VISIT },
      firstVisit: CURRENT_VISIT,
    });
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "{}")).toMatchObject({ version: 2 });
  });

  it("reads a tip left up by an earlier visit as seen, and writes that back", () => {
    markOnboardingHintShown("card", 100);
    startNewVisitForTests();
    expect(readOnboardingHints().retired).toEqual({ card: 100 });
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? "{}").retired).toEqual({ card: 100 });
  });

  it("reads a foreign or malformed record as empty", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ version: 0, retired: { register: 1 } }));
    expect(readOnboardingHints().retired).toEqual({});
    resetOnboardingHintsStoreForTests();
    window.localStorage.setItem(KEY, JSON.stringify({ version: 2, retired: { bogus: 1, card: "x" }, lastShown: { id: "nope", at: 1, visit: "v" } }));
    expect(readOnboardingHints()).toEqual({ version: 2, retired: {}, lastShown: null, firstVisit: null });
    resetOnboardingHintsStoreForTests();
    window.localStorage.setItem(KEY, "{not json");
    expect(readOnboardingHints().retired).toEqual({});
  });

  it("stays quiet when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readOnboardingHints().retired).toEqual({});
    expect(() => retireOnboardingHint("card")).not.toThrow();
    expect(readOnboardingHints().retired.card).toBeTypeOf("number");
  });
});
