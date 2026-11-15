// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The scope that replaced `gsap.context`: stopping it stops what it holds
 *  and anything added after, and schedules nothing more. A `later` waits
 *  its delay in seconds: Motion's `delay` takes seconds, and reading them as
 *  milliseconds once held every celebration burst back by minutes. */
import { describe, expect, it, vi } from "vitest";

// Motion reads the frame clock when it loads, so the fake one goes in first.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});

import { animationScope } from "@shared/motion/motion.ts";
import { backOut, elasticOut } from "@shared/motion/ease.ts";

describe("animationScope", () => {
  it("stops what it holds, and stops at once what is added after", () => {
    const scope = animationScope();
    const held = { stop: vi.fn() };
    scope.add(held);
    scope.stop();
    expect(held.stop).toHaveBeenCalledTimes(1);

    const late = { stop: vi.fn() };
    scope.add(late);
    expect(late.stop).toHaveBeenCalledTimes(1);
    scope.later(() => {
      throw new Error("never runs");
    }, 0);
    vi.advanceTimersByTime(100);
  });
});

describe("animationScope.later", () => {
  it("runs after its delay in seconds, not a thousand times later", () => {
    const scope = animationScope();
    const fn = vi.fn();
    scope.later(fn, 0.3);
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});

describe("GSAP eases", () => {
  it("back.out overshoots and lands where GSAP's does", () => {
    const ease = backOut(1.70158);
    expect(ease(0)).toBeCloseTo(0, 6);
    expect(ease(1)).toBeCloseTo(1, 6);
    // GSAP back.out(1.70158) at 0.5: 1 + 2.70158 * -0.125 + 1.70158 * 0.25.
    expect(ease(0.5)).toBeCloseTo(1.0876975, 6);
    expect(Math.max(...[0.6, 0.7, 0.8].map(ease))).toBeGreaterThan(1);
  });

  it("elastic.out starts and ends at rest", () => {
    const ease = elasticOut(1, 0.3);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.2)).toBeGreaterThan(1);
  });
});
