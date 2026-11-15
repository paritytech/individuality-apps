// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { PROGRESS_SEGMENTS, progressShare, segmentFills } from "@humanity/shared/card/progress-stripe.ts";

describe("progress stripe", () => {
  it("fills whole segments up to the share and the next one partway", () => {
    const fills = segmentFills(0.35);
    expect(fills.slice(0, 4).map((fill) => Number(fill.toFixed(6)))).toEqual([1, 1, 1, 0.5]);
    expect(fills.slice(4)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("always draws the same number of segments, whatever the threshold", () => {
    for (const threshold of [1, 6, 10, 12, 30, 50]) {
      expect(segmentFills(progressShare(3, threshold))).toHaveLength(PROGRESS_SEGMENTS);
    }
  });

  it("is the same stripe for the same share of any threshold", () => {
    expect(segmentFills(progressShare(3, 10))).toEqual(segmentFills(progressShare(9, 30)));
  });

  it("covers exactly the share, point by point", () => {
    for (let score = 0; score <= 7; score += 1) {
      const covered = segmentFills(progressShare(score, 7)).reduce((sum, fill) => sum + fill, 0);
      expect(covered).toBeCloseTo((score / 7) * PROGRESS_SEGMENTS, 9);
    }
  });

  it("clamps what is not a share to empty or full", () => {
    expect(progressShare(-2, 10)).toBe(0);
    expect(progressShare(15, 10)).toBe(1);
    expect(progressShare(4, 0)).toBe(0);
    expect(progressShare(Number.NaN, 10)).toBe(0);
    expect(segmentFills(Number.NaN).every((fill) => fill === 0)).toBe(true);
    expect(segmentFills(2).every((fill) => fill === 1)).toBe(true);
  });
});
