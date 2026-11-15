// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PocketFace } from "@humanity/shared/pocket/humanity-face.ts";

import { createPocketCardRenderer } from "../src/pocket-card.ts";

type Send = (face: unknown) => void;
type Draw = (send: Send) => Promise<() => void>;

const host = vi.hoisted(() => ({
  draw: null as Draw | null,
  lastFill: null as number | null,
  hint: null as null | { face: unknown; readAt: number },
}));

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  getPocketManager: () =>
    Promise.resolve({
      drawCard: (_cardId: string, draw: Draw) => {
        host.draw = draw;
        return { unsubscribe: () => undefined };
      },
    }),
}));

// No debug-panel standing: the card draws what `resolveFace` says.
vi.mock("@humanity/shared/pocket/pocket-face-override.ts", () => ({
  readPocketFaceOverride: () => Promise.resolve(null),
}));

// The face of the app's latest card read, as the app would hand it over.
vi.mock("@humanity/shared/pocket/pocket-face-hint.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@humanity/shared/pocket/pocket-face-hint.ts")>()),
  readPocketFaceHint: () => Promise.resolve(host.hint),
  writePocketFaceHint: (hint: { face: unknown; readAt: number }) => {
    host.hint = hint;
    return Promise.resolve();
  },
}));

// The share the card last drew, as the product's storage would keep it.
vi.mock("@humanity/shared/pocket/pocket-last-fill.ts", () => ({
  readLastFill: () => Promise.resolve(host.lastFill),
  writeLastFill: (share: number) => {
    host.lastFill = share;
    return Promise.resolve();
  },
}));

// Every face is drawn with its fill in the tree; the test reads the fill back
// rather than parsing renderer nodes.
vi.mock("@humanity/shared/pocket/humanity-face.ts", () => ({
  humanityFace: (face: PocketFace) => face,
}));

const candidate = (score: number): PocketFace => ({
  name: "frank.01",
  state: { kind: "candidate", score, threshold: 10 },
});

describe("pocket card stripe fill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host.draw = null;
    host.lastFill = null;
    host.hint = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function onScreen(face: () => PocketFace): Promise<{ sent: PocketFace[]; release: () => void }> {
    await createPocketCardRenderer({ resolveFace: () => Promise.resolve({ face: face(), floor: false }) }).start();
    const sent: PocketFace[] = [];
    const draw = host.draw;
    if (draw == null) throw new Error("the card was never registered");
    const release = await draw((next) => sent.push(next as PocketFace));
    return { sent, release };
  }

  const fills = (sent: PocketFace[]) => sent.map((face) => face.fill);

  it("fills in from empty the first time the card draws a stripe, easing to the standing", async () => {
    const { sent } = await onScreen(() => candidate(6));
    await vi.advanceTimersByTimeAsync(1_000);

    const drawn = fills(sent);
    expect(drawn.length).toBeGreaterThan(10);
    // The last face is the standing's own, with no frame fill left on it.
    expect(drawn.at(-1)).toBeUndefined();
    const eased = drawn.slice(0, -1) as number[];
    for (let frame = 1; frame < eased.length; frame += 1) {
      expect(eased[frame]).toBeGreaterThan(eased[frame - 1] ?? 0);
    }
    // Eased out: the first frames cover more ground than the last ones.
    expect((eased[1] ?? 0) - (eased[0] ?? 0)).toBeGreaterThan((eased.at(-1) ?? 0) - (eased.at(-2) ?? 0));
    expect(host.lastFill).toBe(0.6);
  });

  it("does not move a stripe the host is already showing at the standing", async () => {
    host.lastFill = 0.6;
    const { sent } = await onScreen(() => candidate(6));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.fill).toBeUndefined();
  });

  it("fills progress made off screen in from where the card last stood", async () => {
    host.lastFill = 0.4;
    const { sent } = await onScreen(() => candidate(7));
    await vi.advanceTimersByTimeAsync(1_000);

    const drawn = fills(sent);
    expect(drawn[0]).toBeGreaterThan(0.4);
    expect(drawn[0]).toBeLessThan(0.7);
    expect(host.lastFill).toBe(0.7);
  });

  it("moves from where it stands when the standing changes, not from empty", async () => {
    let score = 4;
    const { sent } = await onScreen(() => candidate(score));
    await vi.advanceTimersByTimeAsync(1_000);
    sent.length = 0;

    score = 8;
    await vi.advanceTimersByTimeAsync(60_000 + 1_000);

    const drawn = fills(sent);
    expect(drawn[0]).toBeGreaterThan(0.4);
    expect(drawn.at(-1)).toBeUndefined();
    expect(host.lastFill).toBe(0.8);
  });

  it("sends nothing more once the card leaves the screen, and remembers the frame it left on", async () => {
    const { sent, release } = await onScreen(() => candidate(9));
    await vi.advanceTimersByTimeAsync(120);
    release();
    const drawnBeforeRelease = sent.length;
    const leftOn = sent.at(-1)?.fill;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent.length).toBe(drawnBeforeRelease);
    expect(host.lastFill).toBe(leftOn);
  });

  it("draws any other standing once, with no frames", async () => {
    const { sent } = await onScreen(() => ({ name: "x", state: { kind: "member", weeks: 3 } }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.fill).toBeUndefined();
  });
});

describe("pocket card follows the app's newer read", () => {
  const member = (name: string): PocketFace => ({ name, state: { kind: "member", weeks: 3 } });

  beforeEach(() => {
    vi.useFakeTimers();
    host.draw = null;
    host.lastFill = null;
    host.hint = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Read = { face: PocketFace; floor: boolean };
  let reads: Array<() => Promise<Read>> = [];

  /** Puts the card on screen; each worker read takes the next of `reads`,
   *  repeating the last. */
  async function onScreen(...next: Array<PocketFace | Read | (() => Promise<Read>)>): Promise<{
    sent: PocketFace[];
    release: () => void;
  }> {
    reads = next.map((read) =>
      typeof read === "function" ? read : () => Promise.resolve("floor" in read ? read : { face: read, floor: false }),
    );
    let call = 0;
    await createPocketCardRenderer({
      resolveFace: () => (reads[Math.min(call++, reads.length - 1)] ?? reads[0]!)(),
    }).start();
    const sent: PocketFace[] = [];
    if (host.draw == null) throw new Error("the card was never registered");
    const release = await host.draw((face) => sent.push(face as PocketFace));
    return { sent, release };
  }

  it("draws a face the app read after the card's own read, within the poll", async () => {
    const { sent } = await onScreen(member("dave.01"));
    expect(sent.at(-1)?.name).toBe("dave.01");

    host.hint = { face: member("dave"), readAt: Date.now() + 1 };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent.at(-1)?.name).toBe("dave");
  });

  it("draws the newest stored face at once, then its own read over it", async () => {
    host.hint = { face: member("dave.01"), readAt: Date.now() - 10_000 };
    const { sent } = await onScreen(member("dave"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map((face) => face.name)).toEqual(["dave.01", "dave"]);
    // What it read is kept for the next time the card comes on screen.
    expect((host.hint?.face as PocketFace).name).toBe("dave");
  });

  it("sends nothing new when the app's face is the one already drawn", async () => {
    const { sent } = await onScreen(member("dave"));
    host.hint = { face: member("dave"), readAt: Date.now() + 1 };
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sent).toHaveLength(1);
  });

  it("keeps a face from a read that worked when a later read fails", async () => {
    const floor = { face: { name: "dave.01", state: { kind: "devicehood" } } as PocketFace, floor: true };
    const { sent } = await onScreen(member("dave"), floor);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(sent.map((face) => face.name)).toEqual(["dave"]);
    expect((host.hint?.face as PocketFace).name).toBe("dave");
  });

  it("draws the floor only until a read works, and never stores it", async () => {
    const floor = { face: { name: "dave.01", state: { kind: "devicehood" } } as PocketFace, floor: true };
    const { sent } = await onScreen(floor, member("dave"));
    expect(host.hint).toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(sent.map((face) => face.name)).toEqual(["dave.01", "dave"]);
  });

  it("takes a second change the app makes within one read", async () => {
    const { sent } = await onScreen(member("dave.01"));
    const at = Date.now() + 1;
    host.hint = { face: member("dave"), readAt: at };
    await vi.advanceTimersByTimeAsync(2_000);
    host.hint = { face: member("dave.01"), readAt: at };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent.map((face) => face.name)).toEqual(["dave.01", "dave", "dave.01"]);
  });

  it("draws nothing once the card has left the screen", async () => {
    const { sent, release } = await onScreen(member("dave.01"));
    release();
    host.hint = { face: member("dave"), readAt: Date.now() + 1 };
    await vi.advanceTimersByTimeAsync(65_000);
    expect(sent).toHaveLength(1);
  });
});
