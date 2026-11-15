// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The app hands the Pocket card the face of each live card read, once per
 *  change, and never a snapshot or a read it has not made in this session. */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";

const written = vi.hoisted(() => [] as unknown[]);
vi.mock("@humanity/shared/pocket/pocket-face-hint.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@humanity/shared/pocket/pocket-face-hint.ts")>()),
  writePocketFaceHint: (hint: unknown) => {
    written.push(hint);
    return Promise.resolve();
  },
}));

import { resetPocketFaceHintForTests, usePocketFaceHint } from "@features/card/hooks/use-pocket-face-hint.ts";

const card = (name: string): HumanityCardResult =>
  ({ kind: "card", primaryUsername: name, state: { kind: "member", activeWeeks: 3 } }) as unknown as HumanityCardResult;

beforeEach(() => {
  written.length = 0;
  resetPocketFaceHintForTests();
});
afterEach(cleanup);

describe("usePocketFaceHint", () => {
  it("hands over a live read, then only a read that changes the face", () => {
    const view = renderHook(({ c, at }) => usePocketFaceHint(c, at, true), {
      initialProps: { c: card("dave.01"), at: 1_000 },
    });
    expect(written).toEqual([{ face: { name: "dave.01", state: { kind: "member", weeks: 3 } }, readAt: 1_000 }]);

    view.rerender({ c: card("dave.01"), at: 13_000 });
    expect(written).toHaveLength(1);

    view.rerender({ c: card("dave"), at: 25_000 });
    expect(written.at(-1)).toEqual({ face: { name: "dave", state: { kind: "member", weeks: 3 } }, readAt: 25_000 });
  });

  it("hands over nothing for a snapshot or a read not made in this session", () => {
    renderHook(() => usePocketFaceHint(card("dave"), 1_000, false));
    renderHook(() => usePocketFaceHint(card("dave"), 0, true));
    renderHook(() => usePocketFaceHint({ kind: "account-unavailable" }, 1_000, true));
    expect(written).toEqual([]);
  });

  it("writes once for two mounted readers of the same card", () => {
    renderHook(() => usePocketFaceHint(card("dave"), 1_000, true));
    renderHook(() => usePocketFaceHint(card("dave"), 1_000, true));
    expect(written).toHaveLength(1);
  });
});
