// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { SHARED_RUNNER, SOLO_RUNNER } from "./runner-group"

const source = readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")
const workflow = parse(source) as Record<string, unknown>

describe("live workflow runner sharing", () => {
  it("is valid YAML and keeps sharing behind one explicit mode", () => {
    expect(workflow).toBeTruthy()
    expect(source).not.toContain("share_measure:")
    // quoted: GitHub reads YAML 1.1, where a bare off/on is a boolean and a dispatch cannot pick them
    expect(source).toMatch(/share:\n\s+description:[^\n]+\n\s+type: choice\n\s+options: \["off", measure, "on"\]\n\s+default: "off"/)
    expect(source).toContain("E2E_SHARE: ${{ inputs.share || 'off' }}")
  })

  it("takes the physical runner from the probe-produced group row", () => {
    expect(source).toContain("runs-on: ${{ matrix.runner || inputs.runner || 'ubuntu-latest' }}")
    expect(source).not.toContain("parity-int-ubuntu")
    expect(source).toContain("E2E_SOLO_RUNNER: ${{ inputs.runner || 'ubuntu-latest' }}")
    expect(source).toContain("E2E_SHARED_RUNNER: ${{ vars.E2E_SHARED_RUNNER }}")
    expect(SOLO_RUNNER).toBe("ubuntu-latest")
    expect(SHARED_RUNNER).toBe("ubuntu-latest")
    expect(source).toContain("npx tsx scripts/e2e-live/runner-group-cli.mts")
  })

  it("passes an optional compiled product override to every play runner", () => {
    expect(source).toMatch(/app_product:\n\s+description:[^\n]+\n\s+type: string\n\s+default: ""/)
    expect(source).toContain("E2E_APP_PRODUCT: ${{ inputs.app_product }}")
  })

  it("preserves the custom runner override for PR and boot-only singleton runs", () => {
    expect(source).toContain('"runner":""')
    expect(source).toContain("matrix.runner || inputs.runner || 'ubuntu-latest'")
    expect(source).toMatch(/runner:\n\s+description:[^\n]+\n\s+type: string\n\s+default: ubuntu-latest/)
  })

  it("fans out only three bounded secret slots and never serializes the secrets context", () => {
    for (const position of [1, 2, 3]) {
      expect(source).toContain(`E2E_GROUP_MNEMONIC_${position}:`)
      expect(source).toContain(`matrix.secret${position}`)
    }
    expect(source).not.toMatch(/toJSON\(secrets\)/)
  })

  it("generates camera clips for every group position", () => {
    expect(source).toContain('"$E2E_PROFILE" "${{ matrix.profile2 }}" "${{ matrix.profile3 }}"')
    expect(source).toContain("E2E_PROFILE: ${{ (inputs.boot_only && inputs.boot_profile) || matrix.profile1 }}")
    expect(source).toContain('if [[ "$E2E_STAGE" == "boot" ]]; then clip_mode+=(--boot); fi')
    expect(source).toContain('"${clip_mode[@]}" "$E2E_PROFILE"')
    expect(source).toContain('>> "$GITHUB_ENV"')
    expect(source).not.toContain("annotate-runner-results")
  })

  it("records and retains the representative HUD proof only for PR and boot runs", () => {
    expect(source).toContain("name: Prove the recording narration overlay")
    expect(source).toContain("if: matrix.bot1 == 1 && (github.event_name == 'pull_request' || inputs.boot_only)")
    expect(source).toContain('E2E_NARRATION_PROOF: "1"')
    expect(source).toContain("npx playwright test --config scripts/e2e-live/playwright.config.ts")
    expect(source).toContain("/narration-proof/**")
  })

  it("passes the exact probe manifest to gather for group preemption accounting", () => {
    expect(source).toContain("groups: ${{ steps.probe.outputs.groups }}")
    expect(source).toContain("E2E_RUNNER_GROUPS: ${{ needs.probe.outputs.groups }}")
    expect(source).toContain('startswith("play [" + $key + "] (group ")')
  })

  it("passes the probe's complete bot account set to every play runner", () => {
    expect(source).toContain("run_bot_accounts: ${{ steps.probe.outputs.run_bot_accounts }}")
    expect(source).toContain("E2E_RUN_BOT_ACCOUNTS: ${{ needs.probe.outputs.run_bot_accounts }}")
  })
})
