// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/e2e-live.yml"), "utf8")

describe("e2e-live app_cid plumbing", () => {
  it("accepts the optional pin for reusable and dispatched runs", () => {
    expect(workflow.match(/\n      app_cid:\n/g)).toHaveLength(2)
    expect(workflow).toContain("E2E_APP_CID_INPUT: ${{ inputs.app_cid }}")
  })

  it("hands the same explicit CID and input provenance to every play runner", () => {
    expect(workflow).toContain("E2E_APP_CID: ${{ inputs.app_cid || needs.probe.outputs.app_cid }}")
    expect(workflow).toContain("E2E_APP_PIN_SOURCE: ${{ inputs.app_cid != '' && 'input' || needs.probe.outputs.app_pin_source }}")
  })

  it("keeps resolved pins distinct from explicit series pins", () => {
    expect(workflow).toContain("app_pin_source: ${{ steps.pin.outputs.app_pin_source }}")
    expect(workflow).toContain("the normal dotNS pin and check-stale-build keep the real update gate")
  })
})
