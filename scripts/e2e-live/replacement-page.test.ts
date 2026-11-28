// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { bindReplacementPage } from "./replacement-page"

describe("replacement-page lifecycle", () => {
  it("moves later play/evidence access and the final exporter off the closed page together", () => {
    const closed = { id: "closed" }
    const replacement = { id: "replacement" }
    const pages = [closed]
    let exporterPage = closed
    const exporter = { rebind: (page: typeof closed) => (exporterPage = page) }

    expect(bindReplacementPage(pages, 0, replacement, [exporter])).toBe(replacement)
    expect(pages[0]).toBe(replacement)
    expect(exporterPage).toBe(replacement)
  })
})
