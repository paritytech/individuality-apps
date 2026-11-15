// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The flip's maths: the face swaps at 90° and is never mirrored, a drag
 *  commits past a nudge, and a flick always lands on the other side. */
import { describe, expect, it } from "vitest";

import {
  COMMIT_DEG,
  dragAngle,
  dragIntent,
  foldAngle,
  releaseTarget,
  releaseTargetFrom,
  settleDuration,
} from "@features/card/domain/card-flip.ts";

describe("foldAngle", () => {
  it("shows the front, unrotated, at every even half turn", () => {
    for (const pos of [0, 360, -360, 720]) {
      expect(foldAngle(pos)).toEqual({ angle: 0, flipped: false });
    }
  });

  it("shows the back, unrotated, at every odd half turn", () => {
    for (const pos of [180, -180, 540]) {
      expect(foldAngle(pos)).toEqual({ angle: 0, flipped: true });
    }
  });

  it("swaps the face at 90° and keeps the rendered angle inside (-90, 90]", () => {
    expect(foldAngle(89)).toEqual({ angle: 89, flipped: false });
    expect(foldAngle(91)).toEqual({ angle: -89, flipped: true });
    expect(foldAngle(-91)).toEqual({ angle: 89, flipped: true });
    expect(foldAngle(270)).toEqual({ angle: -90, flipped: false });
    for (const pos of [-1000, -200, -45, 45, 135, 225, 1000]) {
      const { angle } = foldAngle(pos);
      expect(angle, `${pos}`).toBeGreaterThan(-90);
      expect(angle, `${pos}`).toBeLessThanOrEqual(90);
    }
  });
});

describe("dragAngle", () => {
  it("follows the finger and never runs past the edge", () => {
    expect(dragAngle(0, 0, 330)).toBe(0);
    expect(dragAngle(0, 100, 330)).toBeGreaterThan(0);
    expect(dragAngle(0, -100, 330)).toBeLessThan(0);
    expect(dragAngle(0, 5000, 330)).toBeLessThanOrEqual(180);
    expect(dragAngle(0, -5000, 330)).toBeGreaterThanOrEqual(-180);
    expect(dragAngle(180, 100, 330)).toBeGreaterThan(180);
  });

  it("falls back to a card's width when none is measured", () => {
    expect(dragAngle(0, 100, 0)).toBe(dragAngle(0, 100, 330));
  });
});

describe("dragIntent", () => {
  it("waits for a tap's worth of travel, then reads the direction", () => {
    expect(dragIntent(3, 2)).toBe("undecided");
    expect(dragIntent(12, 3)).toBe("horizontal");
    expect(dragIntent(3, 12)).toBe("vertical");
    expect(dragIntent(-12, 11)).toBe("horizontal");
  });
});

describe("releaseTarget", () => {
  const still = { velocity: 0, sinceLastMove: 0 };

  it("settles home short of the commit angle", () => {
    expect(releaseTarget(0, { pos: COMMIT_DEG - 1, ...still })).toBe(0);
    expect(releaseTarget(180, { pos: 180 - COMMIT_DEG + 1, ...still })).toBe(180);
  });

  it("finishes the turn past it, either way round", () => {
    expect(releaseTarget(0, { pos: COMMIT_DEG + 1, ...still })).toBe(180);
    expect(releaseTarget(0, { pos: -(COMMIT_DEG + 1), ...still })).toBe(-180);
    expect(releaseTarget(180, { pos: 180 + COMMIT_DEG + 1, ...still })).toBe(360);
  });

  it("lets a flick coast, and always onto the other face", () => {
    for (const velocity of [0.5, 1, 3, 8]) {
      const target = releaseTarget(0, { pos: 30, velocity, sinceLastMove: 10 });
      expect(target, `${velocity}`).toBeGreaterThan(0);
      expect(((target / 180) % 2 + 2) % 2, `${velocity}`).toBe(1);
    }
    const back = releaseTarget(0, { pos: -30, velocity: -2, sinceLastMove: 10 });
    expect(back).toBeLessThan(0);
    expect(((back / 180) % 2 + 2) % 2).toBe(1);
  });

  it("caps a wild flick at five turns", () => {
    const target = releaseTarget(0, { pos: 30, velocity: 100, sinceLastMove: 10 });
    expect(target).toBeLessThanOrEqual(30 + 1800 + 180);
  });

  it("ignores a stale velocity: a finger held still has no flick in it", () => {
    expect(releaseTarget(0, { pos: 30, velocity: 3, sinceLastMove: 500 })).toBe(0);
  });

  it("settles home on a flick back, even past the commit angle", () => {
    expect(releaseTarget(0, { pos: 30, velocity: -3, sinceLastMove: 10 })).toBe(0);
    // Dragged to 100°, then flicked back and let go at 70°: home, not over.
    expect(releaseTarget(0, { pos: 70, velocity: -0.75, sinceLastMove: 10 })).toBe(0);
    expect(releaseTarget(180, { pos: 110, velocity: 0.75, sinceLastMove: 10 })).toBe(180);
  });

  it("still commits a slow drag past the commit angle", () => {
    expect(releaseTarget(0, { pos: 70, velocity: -0.05, sinceLastMove: 10 })).toBe(180);
  });
});

describe("releaseTargetFrom", () => {
  it("is releaseTarget for a card grabbed at rest", () => {
    expect(releaseTargetFrom(0, { pos: 70, velocity: 0.05, sinceLastMove: 10 })).toBe(180);
    expect(releaseTargetFrom(180, { pos: 150, velocity: 0, sinceLastMove: 10 })).toBe(180);
  });

  it("lands on the face that shows when a card grabbed mid-turn is held still", () => {
    // Grabbed at 100°, heading for the back, and let go without moving.
    expect(releaseTargetFrom(100, { pos: 100, velocity: 0, sinceLastMove: 200 })).toBe(180);
    expect(releaseTargetFrom(70, { pos: 70, velocity: 0, sinceLastMove: 200 })).toBe(0);
  });

  it("goes on to the next face in the drag's direction past the commit angle", () => {
    expect(releaseTargetFrom(100, { pos: 40, velocity: -0.05, sinceLastMove: 10 })).toBe(0);
    expect(releaseTargetFrom(100, { pos: 160, velocity: 0.05, sinceLastMove: 10 })).toBe(180);
  });

  it("coasts a flick from where it let go", () => {
    expect(releaseTargetFrom(100, { pos: 130, velocity: 2, sinceLastMove: 10 }) % 180).toBe(0);
    expect(releaseTargetFrom(100, { pos: 130, velocity: 2, sinceLastMove: 10 })).toBeGreaterThan(130);
  });
});

describe("settleDuration", () => {
  it("is snappy for a half turn and coasts for more", () => {
    expect(settleDuration(0)).toBe(0.25);
    expect(settleDuration(180)).toBeLessThanOrEqual(0.6);
    expect(settleDuration(1800)).toBeLessThanOrEqual(2.6);
    expect(settleDuration(900)).toBeGreaterThan(settleDuration(180));
  });
});
