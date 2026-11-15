// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { androidLimits, validateFace, type RendererNode } from "@parity/product-sdk/renderer";
import { describe, expect, it } from "vitest";

import { humanityFace, type PocketFaceState } from "@humanity/shared/pocket/humanity-face.ts";

/** Every state the face distinguishes, including each member material tier. */
const STATES: Record<string, PocketFaceState> = {
  "not-enrolled": { kind: "not-enrolled" },
  devicehood: { kind: "devicehood" },
  "candidate-spark": { kind: "candidate", score: 1, threshold: 10 },
  "candidate-flame": { kind: "candidate", score: 6, threshold: 10 },
  "candidate-blaze": { kind: "candidate", score: 10, threshold: 10 },
  "candidate-shares": { kind: "candidate", score: 30, threshold: 50 },
  "membership-ready": { kind: "membership-ready", weeks: 1 },
  "member-silver": { kind: "member", weeks: 3 },
  "member-dark-silver": { kind: "member", weeks: 20 },
  "member-black": { kind: "member", weeks: 60 },
  "member-holo": { kind: "member", weeks: 500 },
  caution: { kind: "caution", misses: 2, allowedMisses: 3, window: 8 },
  suspended: { kind: "suspended" },
};

/** The worker's `public/`, which Vite copies into the archive an `Archive` source resolves in. */
const WORKER_PUBLIC = fileURLToPath(new URL("../../../../apps/humanity-worker/public/", import.meta.url));

/** Every image in a face: its archive path, and the padding that places it. */
function images(node: RendererNode, padding: unknown = null): { path: string; padding: unknown }[] {
  const { tag, value } = node as { tag: string; value?: Record<string, unknown> };
  const modifiers = (value?.["modifiers"] ?? []) as { tag: string; value: unknown }[];
  const own = modifiers.find((m) => m.tag === "Padding")?.value ?? padding;
  if (tag === "Image") {
    const source = (value?.["props"] as { source: { tag: string; value: string } }).source;
    return [{ path: source.tag === "Archive" ? source.value : `bulletin:${source.value}`, padding: own }];
  }
  return ((value?.["children"] ?? []) as RendererNode[]).flatMap((child) => images(child, own));
}

const imagesOf = (state: PocketFaceState) => images(humanityFace({ name: "x", state }));

describe("humanityFace", () => {
  for (const [name, state] of Object.entries(STATES)) {
    it(`${name} is a face the Android host can draw`, () => {
      const face = humanityFace({ name: "alice.01", state });
      // Measured as the pretty-printed text `write-pocket-faces.mts` ships.
      const verdict = validateFace(JSON.stringify(face, null, 2), { host: androidLimits });

      expect(verdict.errors).toEqual([]);
      expect(verdict.warnings).toEqual([]);
    });
  }

  it("stays ASCII, since the host reads worker JS as Latin-1", () => {
    for (const state of Object.values(STATES)) {
      const json = JSON.stringify(humanityFace({ name: "alice.01", state }));
      expect(json).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it("edges the black, caution and suspended cards, and only those", () => {
    // The card's own edge is the border that follows its 24dp corners; the QR
    // glyph's squares are bordered too, at 2dp corners.
    const edges = (state: PocketFaceState) =>
      [
        ...JSON.stringify(humanityFace({ name: "x", state })).matchAll(
          /"tag":"Border","value":\{"width":(\d+),"color":"(\w+)","shape":\{"tag":"Rounded","value":24\}/g,
        ),
      ].map(([, w, c]) => `${w} ${c}`);

    expect(edges({ kind: "member", weeks: 60 })).toEqual(["1 FgPrimary"]);
    expect(edges({ kind: "caution", misses: 1, allowedMisses: 1 })).toEqual(["3 FgWarning"]);
    expect(edges({ kind: "suspended" })).toEqual(["3 FgError"]);
    expect(edges({ kind: "devicehood" })).toEqual(["1 FgPrimary"]);
    expect(edges({ kind: "not-enrolled" })).toEqual(["1 FgPrimary"]);
    expect(edges({ kind: "candidate", score: 4, threshold: 10 })).toEqual([]);
    expect(edges({ kind: "member", weeks: 3 })).toEqual([]);
  });

  it("draws the same stripe for the same share of any threshold", () => {
    const at = (score: number, threshold: number) =>
      JSON.stringify(humanityFace({ name: "x", state: { kind: "candidate", score, threshold } }));

    // 30%: same fill, same heat rank, same cast.
    expect(at(3, 10)).toBe(at(9, 30));
    expect(at(3, 10)).not.toBe(at(4, 10));
  });

  it("draws the worker's fill in place of the standing's while it eases", () => {
    const state: PocketFaceState = { kind: "candidate", score: 8, threshold: 10 };
    const standing = JSON.stringify(humanityFace({ name: "x", state }));

    expect(JSON.stringify(humanityFace({ name: "x", state, fill: 0.8 }))).toBe(standing);
    expect(JSON.stringify(humanityFace({ name: "x", state, fill: 0.2 }))).not.toBe(standing);
    // The fill is a frame of the stripe, not a new standing: the same frame of
    // a spark (1/10) and a fire (8/10) candidate is drawn in each one's colour.
    const frame = (score: number) =>
      JSON.stringify(humanityFace({ name: "x", state: { kind: "candidate", score, threshold: 10 }, fill: 0.1 }));
    expect(frame(1)).not.toBe(frame(8));
  });

  it("draws only images the worker archive carries", () => {
    for (const state of Object.values(STATES)) {
      for (const { path } of imagesOf(state)) {
        expect(path, `missing pocket asset ${path}`).toMatch(/^pocket\//);
        expect(existsSync(WORKER_PUBLIC + path), `missing pocket asset ${path}`).toBe(true);
      }
    }
  });

  it("draws no SVG, which the iOS host cannot decode", () => {
    for (const state of Object.values(STATES)) {
      for (const { path } of imagesOf(state)) expect(path).toMatch(/\.(png|webp)$/);
    }
  });

  it("puts the wordmark in the material's ink: light on dark silver and black, dark elsewhere", () => {
    const wordmark = (state: PocketFaceState) => imagesOf(state).find(({ path }) => path.includes("wordmark"))?.path;

    expect(wordmark({ kind: "member", weeks: 20 })).toBe("pocket/wordmark-light.png");
    expect(wordmark({ kind: "member", weeks: 60 })).toBe("pocket/wordmark-light.png");
    expect(wordmark({ kind: "member", weeks: 3 })).toBe("pocket/wordmark-dark.png");
    expect(wordmark({ kind: "candidate", score: 4, threshold: 10 })).toBe("pocket/wordmark-dark.png");
    expect(wordmark({ kind: "suspended" })).toBe("pocket/wordmark-dark.png");
  });

  it("keeps the QR glyph in the corner, and just under the ribbon on a caution or suspended card", () => {
    const qrTop = (state: PocketFaceState) =>
      (imagesOf(state).find(({ path }) => path === "pocket/qr-code.png")?.padding as { top: number } | null)?.top;

    expect(qrTop({ kind: "member", weeks: 3 })).toBe(22);
    expect(qrTop({ kind: "devicehood" })).toBe(22);
    expect(qrTop({ kind: "caution", misses: 2, allowedMisses: 3 })).toBe(56);
    expect(qrTop({ kind: "suspended" })).toBe(56);
  });

  /**
   * The Android (Compose) and iOS (SwiftUI) hosts disagree where the format
   * leaves a choice, so the face stays out of those places: every node that
   * pads along an axis has no fixed size on it (Android pads outside a fixed
   * size, iOS inside), every Box with more than one child names its alignment
   * (iOS centres by default, Android starts top-left), and every Row or Column
   * with more than one child spreads them (iOS adds its own gap otherwise).
   */
  it("uses only layouts both hosts draw alike", () => {
    type Node = { tag: string; value?: { modifiers?: { tag: string; value: unknown }[]; props?: Record<string, unknown>; children?: Node[] } };
    const problems: string[] = [];
    const walk = (node: Node, where: string) => {
      const mods = node.value?.modifiers ?? [];
      const padding = mods.find((m) => m.tag === "Padding")?.value as
        | { top: number; end: number; bottom?: number; start?: number }
        | undefined;
      if (padding) {
        const vertical = padding.top + (padding.bottom ?? padding.top);
        const horizontal = padding.end + (padding.start ?? padding.end);
        if (vertical > 0 && mods.some((m) => m.tag === "Height")) problems.push(`${where}: ${node.tag} pads a fixed height`);
        if (horizontal > 0 && mods.some((m) => m.tag === "Width")) problems.push(`${where}: ${node.tag} pads a fixed width`);
      }
      const children = node.value?.children ?? [];
      const props = node.value?.props ?? {};
      if (node.tag === "Box" && children.length > 1 && props["contentAlignment"] === undefined) {
        problems.push(`${where}: a Box of ${children.length} without a contentAlignment`);
      }
      const arrangement = node.tag === "Row" ? props["horizontalArrangement"] : props["verticalArrangement"];
      if ((node.tag === "Row" || node.tag === "Column") && children.length > 1 && !/^Space/.test(String(arrangement))) {
        problems.push(`${where}: a ${node.tag} of ${children.length} children without a spaced arrangement`);
      }
      children.forEach((child, i) => walk(child, `${where}/${i}`));
    };
    for (const [name, state] of Object.entries(STATES)) walk(humanityFace({ name: "x", state }) as Node, name);
    expect(problems).toEqual([]);
  });
});
