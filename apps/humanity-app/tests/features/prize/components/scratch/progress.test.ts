// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  getScratchBrushRadius,
  shouldRevealScratch,
} from "@features/prize/components/scratch/progress.ts";

describe("shouldRevealScratch", () => {
  it("reveals at the normal 58% threshold", () => {
    expect(shouldRevealScratch(0.579, null, 10_000)).toBe(false);
    expect(shouldRevealScratch(0.58, null, 10_000)).toBe(true);
  });

  it("rescues a stuck scratch after two seconds above 45%", () => {
    expect(shouldRevealScratch(0.5, 10_000, 11_999)).toBe(false);
    expect(shouldRevealScratch(0.5, 10_000, 12_000)).toBe(true);
    expect(shouldRevealScratch(0.499, 10_000, 15_000)).toBe(false);
  });
});

describe("getScratchBrushRadius", () => {
  it("keeps 26px until inactivity starts the slow-scratch boost", () => {
    expect(getScratchBrushRadius(2_500)).toBe(26);
  });

  it("ramps to a 39px cap over the next second", () => {
    expect(getScratchBrushRadius(3_000)).toBe(32.5);
    expect(getScratchBrushRadius(3_500)).toBe(39);
    expect(getScratchBrushRadius(5_000)).toBe(39);
  });
});
