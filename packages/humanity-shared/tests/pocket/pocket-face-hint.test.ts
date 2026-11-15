// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";

import {
  POCKET_FACE_HINT_KEY,
  readPocketFaceHint,
  writePocketFaceHint,
} from "@humanity/shared/pocket/pocket-face-hint.ts";
import { getLocalKvStore, resetLocalKvStore } from "@humanity/shared/storage/local-kv.ts";

const face = (name: string) => ({ name, state: { kind: "member" as const, weeks: 3 } });

describe("pocket face hint", () => {
  beforeEach(() => {
    resetLocalKvStore();
  });

  it("round-trips a face and the time of its read", async () => {
    await writePocketFaceHint({ face: face("dave"), readAt: 1_000 });
    expect(await readPocketFaceHint()).toEqual({ face: face("dave"), readAt: 1_000 });
  });

  it("never replaces a later read's face with an earlier one", async () => {
    await writePocketFaceHint({ face: face("dave"), readAt: 2_000 });
    await writePocketFaceHint({ face: face("dave.01"), readAt: 1_000 });
    expect((await readPocketFaceHint())?.face.name).toBe("dave");

    await writePocketFaceHint({ face: face("dave.01"), readAt: 2_000 });
    expect((await readPocketFaceHint())?.face.name).toBe("dave.01");
  });

  it("reads a malformed or future-dated value as no hint", async () => {
    const store = await getLocalKvStore();
    await store.setJSON(POCKET_FACE_HINT_KEY, { face: { name: "x", state: { kind: "gold" } }, readAt: 1 });
    expect(await readPocketFaceHint()).toBeNull();

    await store.setJSON(POCKET_FACE_HINT_KEY, { face: face("x"), readAt: "soon" });
    expect(await readPocketFaceHint()).toBeNull();

    await store.setJSON(POCKET_FACE_HINT_KEY, { face: face("x"), readAt: Date.now() + 3_600_000 });
    expect(await readPocketFaceHint()).toBeNull();

    await store.set(POCKET_FACE_HINT_KEY, "not json");
    expect(await readPocketFaceHint()).toBeNull();
  });
});
