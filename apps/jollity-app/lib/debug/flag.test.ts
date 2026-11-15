// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { buildCommitShort } from "./flag"

describe("build commit display", () => {
  it("shows the short exact PR-preview commit", () => {
    expect(buildCommitShort(`jollity-build-commit:${"a1".repeat(20)}`)).toBe("a1a1a1a1a1a1")
  })

  it("keeps truthful non-exact build markers", () => {
    expect(buildCommitShort("jollity-build-commit:cached")).toBe("cached")
    expect(buildCommitShort("jollity-build-commit:dev")).toBe("dev")
    expect(buildCommitShort("not-a-build-marker")).toBe("unknown")
  })
})
