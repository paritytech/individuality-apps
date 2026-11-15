// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";

import {
  POCKET_FACE_OVERRIDE_KEY,
  readPocketFaceOverride,
  writePocketFaceOverride,
} from "@humanity/shared/pocket/pocket-face-override.ts";
import { getLocalKvStore, resetLocalKvStore } from "@humanity/shared/storage/local-kv.ts";

describe("pocket face override", () => {
  beforeEach(() => {
    resetLocalKvStore();
  });

  it("round-trips a simulated standing through product storage", async () => {
    await writePocketFaceOverride({ kind: "candidate", score: 4, threshold: 10 });

    expect(await readPocketFaceOverride()).toEqual({ kind: "candidate", score: 4, threshold: 10 });
  });

  it("clears the slot when the panel goes back to chain", async () => {
    await writePocketFaceOverride({ kind: "suspended" });
    await writePocketFaceOverride(null);

    expect(await readPocketFaceOverride()).toBeNull();
    expect(await (await getLocalKvStore()).get(POCKET_FACE_OVERRIDE_KEY)).toBeNull();
  });

  it("reads a value that is not a face state as no override", async () => {
    const store = await getLocalKvStore();
    await store.setJSON(POCKET_FACE_OVERRIDE_KEY, { kind: "gold-member" });
    expect(await readPocketFaceOverride()).toBeNull();

    await store.set(POCKET_FACE_OVERRIDE_KEY, "not json");
    expect(await readPocketFaceOverride()).toBeNull();
  });
});
