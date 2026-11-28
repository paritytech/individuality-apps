// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { main } from "./nightly-window-cli.mts"

describe("ordinary PreviewNet admission", () => {
  it("allows work at any time when no complete suite is queued or running", () => {
    expect(() => main(["manual"], "[]")).not.toThrow()
  })

  it.each(["queued", "in_progress"])("refuses work while a complete suite is %s", (status) => {
    const active = JSON.stringify([{ databaseId: 42, status, displayTitle: "PreviewNet complete crew suite" }])
    expect(() => main(["manual"], active)).toThrow(/queued or in progress/)
  })
})
