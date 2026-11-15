// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import {
  orientationOffset,
  pointerOffset,
  pointerTilts,
  restingSurface,
  surfaceFrom,
} from "@features/card/domain/card-parallax.ts";

const CARD_RECT = { left: 20, top: 100, width: 330, height: 208 };

describe("pointerTilts", () => {
  it("drives the card from hovering devices", () => {
    expect(pointerTilts("mouse")).toBe(true);
    expect(pointerTilts("pen")).toBe(true);
  });

  // The regression this gate exists for: `pointermove` fires for touch, so a
  // tap used to tilt the card out from under the thumb.
  it("never drives the card from touch", () => {
    expect(pointerTilts("touch")).toBe(false);
    expect(pointerTilts("")).toBe(false);
  });
});

describe("surfaceFrom", () => {
  it("tilts towards the reading and moves the effect with it", () => {
    const surface = surfaceFrom(1, 1);
    expect(surface.tiltX).toBe(1);
    expect(surface.tiltY).toBe(1);
    expect(surface.sheenX).toBeGreaterThan(50);
    expect(surface.sheenY).toBeGreaterThan(50);
    expect(surface.holoX).toBeGreaterThan(0);
    expect(surface.holoY).toBeGreaterThan(0);
  });

  it("mirrors for a reading on the opposite edge", () => {
    const surface = surfaceFrom(-1, -1);
    expect(surface.tiltX).toBe(-1);
    expect(surface.tiltY).toBe(-1);
    expect(surface.sheenX).toBeLessThan(50);
    expect(surface.sheenY).toBeLessThan(50);
    expect(surface.holoX).toBeLessThan(0);
    expect(surface.holoY).toBeLessThan(0);
  });

  it("clamps readings past the card's edges", () => {
    expect(surfaceFrom(9, 9)).toEqual(surfaceFrom(1, 1));
    expect(surfaceFrom(-9, -9)).toEqual(surfaceFrom(-1, -1));
  });

  it("settles flat and centred at the origin", () => {
    expect(surfaceFrom(0, 0)).toEqual(restingSurface());
  });
});

describe("pointerOffset", () => {
  it("reads the card's centre as the origin", () => {
    expect(pointerOffset({ clientX: 185, clientY: 204 }, CARD_RECT)).toEqual({ nx: 0, ny: 0 });
  });

  it("reads the corners as the unit extremes", () => {
    expect(pointerOffset({ clientX: 20, clientY: 100 }, CARD_RECT)).toEqual({ nx: -1, ny: -1 });
    expect(pointerOffset({ clientX: 350, clientY: 308 }, CARD_RECT)).toEqual({ nx: 1, ny: 1 });
  });
});

describe("orientationOffset", () => {
  it("treats a reclined phone as level", () => {
    expect(orientationOffset({ beta: 40, gamma: 0 })).toEqual({ nx: 0, ny: 0 });
  });

  it("maps roll to travel in either direction", () => {
    expect(orientationOffset({ beta: 40, gamma: 28 })?.nx).toBe(1);
    expect(orientationOffset({ beta: 40, gamma: -28 })?.nx).toBe(-1);
  });

  // A browser with no sensor either stays silent or reports nulls; neither
  // may drive the card.
  it("rejects readings that carry no angles", () => {
    expect(orientationOffset({ beta: null, gamma: null })).toBeNull();
    expect(orientationOffset({ beta: 40, gamma: null })).toBeNull();
    expect(orientationOffset({ beta: null, gamma: 10 })).toBeNull();
    expect(orientationOffset({ beta: Number.NaN, gamma: 10 })).toBeNull();
  });
});
