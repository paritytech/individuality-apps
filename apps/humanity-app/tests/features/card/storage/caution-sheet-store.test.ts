// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerCautionSheet,
  readCautionSheetAnswered,
  resetCautionSheetStoreForTests,
} from "@features/card/storage/caution-sheet-store.ts";

beforeEach(() => {
  resetCautionSheetStoreForTests();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("caution-sheet-store", () => {
  it("remembers the one game whose sheet was answered", () => {
    expect(readCautionSheetAnswered()).toBeNull();
    answerCautionSheet(42);
    resetCautionSheetStoreForTests();
    expect(readCautionSheetAnswered()).toBe(42);
    answerCautionSheet(43);
    expect(readCautionSheetAnswered()).toBe(43);
  });

  it("stays quiet when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readCautionSheetAnswered()).toBeNull();
    expect(() => answerCautionSheet(1)).not.toThrow();
    expect(readCautionSheetAnswered()).toBe(1);
  });
});
