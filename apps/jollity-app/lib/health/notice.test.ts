// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import type { LadderVerdict, LayerResult } from "@jollity/statement-core"
import { healthNoticeVariant, noticeBlame } from "./notice"

const verdict = (blame: LayerResult): LadderVerdict => ({ rungs: [blame], blame })
const failed = (layer: LayerResult["layer"]): LayerResult => ({ layer, status: "fail", detail: "failed" })

describe("noticeBlame", () => {
  it("shows network blame only after both host and no-path proof", () => {
    const turn = verdict(failed("turn-credentials"))
    expect(noticeBlame(turn, false, true)).toBeNull()
    expect(noticeBlame(turn, true, false)).toBeNull()
    expect(noticeBlame(turn, true, true)).toEqual(turn.blame)
  })

  it("raises the missing own key whatever the host and path evidence say", () => {
    const ownKey = verdict(failed("own-key"))
    expect(noticeBlame(ownKey, false, false)).toEqual(ownKey.blame)
  })

  it("does not suppress another actionable layer", () => {
    const camera = verdict(failed("camera"))
    expect(noticeBlame(camera, false, false)).toEqual(camera.blame)
  })
})

describe("healthNoticeVariant", () => {
  it("keeps player-network guidance authoritative after peer-path evidence", () => {
    expect(healthNoticeVariant(true, true)).toBe("connection")
  })

  it("keeps the host-stuck advice when no player-network loss is proven", () => {
    expect(healthNoticeVariant(true, false)).toBe("host-stuck")
    expect(healthNoticeVariant(false, false)).toBe("connection")
  })
})
