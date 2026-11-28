// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { syncRecordingArtifactNames } from "./sync-public-recordings.mts"

describe("local public recording sync artifacts", () => {
  it("keeps the legacy manual artifact contract", () => {
    expect(syncRecordingArtifactNames("39147986065", "2", "manual")).toEqual({
      publication: "e2e-live-39147986065-attempt-2-manual-selected-results",
      annotations: "e2e-live-39147986065-attempt-2-manual-crew-hud-*",
      bundlePath: "publication-out/publication-bundle.json",
    })
  })

  it("selects one exact complete-suite execution", () => {
    expect(syncRecordingArtifactNames("39177426470", "1", "game-ready")).toEqual({
      publication: "crew-publication-39177426470-attempt-1-game-ready",
      annotations: "e2e-live-39177426470-attempt-1-game-ready-crew-hud-*",
      bundlePath: "publication-bundle.json",
    })
  })

  it("rejects unsafe or ambiguous identifiers before downloading", () => {
    expect(() => syncRecordingArtifactNames("39177426470", "0", "game-ready")).toThrow("positive integer")
    expect(() => syncRecordingArtifactNames("39177426470", "1", "../game-ready")).toThrow("execution key")
  })
})
