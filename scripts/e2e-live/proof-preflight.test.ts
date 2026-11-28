// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseNamedProofs, resolveNamedProofs, validateProofPreflight, videoProofViewer, type ProofPreflightInput } from "./proof-preflight"

const bot = (slot: number, profile: string, identity = `person-${slot}`) => ({ bot: slot, profile, identity, secret: `PERSON_${slot}` })

const validFlip = (): ProofPreflightInput => ({
  proofs: ["flip-verdict"],
  bots: [bot(1, "baseline-iphone14-wifi"), bot(2, "locale-la-enus")],
  roles: true,
  telemetry: true,
  telemetryProfile: false,
  flipVerdict: true,
  clockWatchFault: false,
})

describe("parseNamedProofs", () => {
  it("accepts one proof name or a JSON list without silently dropping duplicates", () => {
    expect(parseNamedProofs("flip-verdict")).toEqual(["flip-verdict"])
    expect(parseNamedProofs('["profile:kill-background-iphone13","profile:locale-la-enus"]')).toEqual([
      "profile:kill-background-iphone13",
      "profile:locale-la-enus",
    ])
    expect(() => parseNamedProofs('["flip-verdict","flip-verdict"]')).toThrow(/listed twice/)
  })

  it("refuses unknown and malformed proof declarations", () => {
    expect(() => parseNamedProofs("unknown-proof")).toThrow(/known proof/)
    expect(() => parseNamedProofs("[]")).toThrow(/non-empty/)
    expect(() => parseNamedProofs('["profile:no-such-profile"]')).toThrow(/known profile/)
  })

  it("keeps implied safety proofs when compatible explicit proofs are also named", () => {
    expect(resolveNamedProofs("profile:locale-la-enus", "video-role-proof", true, false)).toEqual([
      "profile:locale-la-enus",
      "video-role-proof",
      "flip-verdict",
    ])
    expect(resolveNamedProofs("flip-verdict", "3", true, false)).toEqual(["flip-verdict"])
    expect(resolveNamedProofs(undefined, "3", false, true)).toEqual(["clock-watch-fault"])
  })
})

describe("validateProofPreflight", () => {
  // Run 40514976677 dispatched game259-lossy-video with four bots. Its
  // atRoundChannelsOpen gate wants five distinct channels, which needs six players,
  // so the step could never fire: "all 4 channels opened ... but no 65% burst was
  // recorded", "0 of 1 step(s) applied". The profile declares minPlayers: 6 and
  // nothing consulted it, because the check only ran for named proofs.
  const lossy = (players: number): ProofPreflightInput => ({
    proofs: [],
    bots: Array.from({ length: players }, (_, i) => bot(i + 1, i === 0 ? "game259-lossy-video" : "locale-la-enus")),
    roles: false,
    telemetry: false,
    telemetryProfile: false,
    flipVerdict: false,
    clockWatchFault: false,
  })

  it("refuses a plain dispatch that cannot supply the players a persona's own gate needs", () => {
    expect(() => validateProofPreflight(lossy(4))).toThrow(/game259-lossy-video requires 6 players; resolved 4/)
  })

  it("allows the same persona once enough players are resolved", () => {
    expect(() => validateProofPreflight(lossy(6))).not.toThrow()
  })

  it("leaves personas without minPlayers alone", () => {
    const plain = { ...lossy(2), bots: [bot(1, "locale-la-enus"), bot(2, "locale-tokyo-jajp")] }
    expect(() => validateProofPreflight(plain)).not.toThrow()
  })

  it("fails a named proof immediately when no co-player is resolved", () => {
    const input = validFlip()
    input.bots = input.bots.slice(0, 1)
    expect(() => validateProofPreflight(input)).toThrow(/flip-verdict needs at least one co-player/)
  })

  it("fails a role proof when roles are disabled", () => {
    expect(() => validateProofPreflight({ ...validFlip(), roles: false })).toThrow(/flip-verdict requires roles=true/)
  })

  it("fails a telemetry profile run unless telemetry=true is set explicitly", () => {
    expect(() => validateProofPreflight({ ...validFlip(), telemetry: false, telemetryProfile: true })).toThrow(/telemetry profiles \(T1-T12\) need telemetry=true/)
    expect(() => validateProofPreflight({ ...validFlip(), telemetry: false, telemetryProfile: true })).toThrow(/flip-verdict requires telemetry=true/)
    expect(() => validateProofPreflight({ proofs: [], bots: [], roles: false, telemetry: false, telemetryProfile: true, flipVerdict: false, clockWatchFault: false })).toThrow(/opt-in per run/)
    // clock_watch_fault supplies run-job telemetry but not gather's readers: only an explicit telemetry=true counts for a T profile
    expect(() => validateProofPreflight({ proofs: [], bots: [], roles: false, telemetry: true, explicitTelemetry: false, gameLogToSentry: true, telemetryProfile: true, flipVerdict: false, clockWatchFault: true })).toThrow(/opt-in per run/)
    expect(() => validateProofPreflight({ proofs: [], bots: [], roles: false, telemetry: true, explicitTelemetry: true, gameLogToSentry: false, telemetryProfile: true, flipVerdict: false })).toThrow(/game_log_to_sentry=true/)
    expect(() => validateProofPreflight({ proofs: [], bots: [], roles: false, telemetry: true, explicitTelemetry: true, gameLogToSentry: true, telemetryProfile: true, flipVerdict: false })).not.toThrow()
    expect(() => validateProofPreflight({ ...validFlip(), telemetry: true, telemetryProfile: true })).not.toThrow()
  })

  it("fails a proof that needs telemetry when it is inactive", () => {
    expect(() => validateProofPreflight({ ...validFlip(), telemetry: false })).toThrow(/flip-verdict requires telemetry=true/)
    expect(() => validateProofPreflight({
      ...validFlip(),
      proofs: ["profile:video-stall-30s"],
      bots: [bot(1, "video-stall-30s"), bot(2, "locale-la-enus")],
      telemetry: true,
    })).toThrow(/video-stall-30s requires 6 players/)
  })

  it("fails the flip proof when flip_verdict is absent", () => {
    expect(() => validateProofPreflight({ ...validFlip(), flipVerdict: false })).toThrow(/flip-verdict requires flip_verdict=true/)
  })

  it("fails video-role-proof unless the exact preset, roles and telemetry are present", () => {
    const input: ProofPreflightInput = {
      ...validFlip(),
      proofs: ["video-role-proof"],
      bots: [bot(1, "reload-mid-game"), bot(2, "video-role-late-flip")],
      flipVerdict: false,
    }
    expect(() => validateProofPreflight(input)).toThrow(/exact six-bot video-role-proof preset/)
    input.bots = [
      bot(99, "reload-mid-game"),
      bot(2, "video-role-late-flip"),
      bot(3, "video-role-late-never"),
      bot(4, "baseline"),
      bot(5, "baseline"),
      bot(6, "baseline"),
    ]
    expect(() => validateProofPreflight(input)).toThrow(/exact six-bot video-role-proof preset/)
  })

  it("accepts the complete video-role proof and its co-player controls", () => {
    expect(validateProofPreflight({
      ...validFlip(),
      proofs: ["video-role-proof"],
      bots: [
        bot(1, "reload-mid-game"),
        bot(2, "video-role-late-flip"),
        bot(3, "video-role-late-never"),
        bot(4, "baseline"),
        bot(5, "baseline"),
        bot(6, "baseline"),
      ],
      flipVerdict: false,
    })).toEqual({ proofs: ["video-role-proof"] })
  })

  it("accepts compatible profile proofs sharing one resolved game matrix", () => {
    expect(validateProofPreflight({
      proofs: ["profile:kill-background-iphone13", "profile:locale-la-enus"],
      bots: [bot(1, "kill-background-iphone13"), bot(2, "locale-la-enus")],
      roles: true,
      telemetry: true,
      telemetryProfile: false,
      flipVerdict: false,
      clockWatchFault: false,
    })).toEqual({ proofs: ["profile:kill-background-iphone13", "profile:locale-la-enus"] })
  })

  it.each(["game259-lossy-video", "game259-dropped-lane-rebuild", "game259-clean-video-control", "video-stall-30s", "udp-cut-40s"])("requires six players for %s", (profile) => {
    expect(() => validateProofPreflight({ ...validFlip(), proofs: [`profile:${profile}`], bots: [bot(1, profile), bot(2, "baseline")] })).toThrow(new RegExp(`${profile} requires 6 players`))
    expect(validateProofPreflight({ ...validFlip(), proofs: [`profile:${profile}`], bots: Array.from({ length: 6 }, (_, i) => bot(i + 1, i === 0 ? profile : "baseline")) })).toEqual({ proofs: [`profile:${profile}`] })
  })

  it("derives the video proof viewer from an equivalent JSON matrix", () => {
    const bots = [bot(1, "reload-mid-game"), bot(2, "video-role-late-flip"), bot(3, "video-role-late-never"), bot(4, "baseline"), bot(5, "baseline"), bot(6, "baseline")]
    expect(videoProofViewer(["video-role-proof"], bots)).toMatchObject({ bot: 1, profile: "reload-mid-game" })
  })

  it("rejects incompatible shared profile proofs", () => {
    expect(() => validateProofPreflight({ ...validFlip(), proofs: ["profile:game259-lossy-video"], bots: Array.from({ length: 6 }, (_, i) => bot(i + 1, i === 0 ? "game259-lossy-video" : i === 1 ? "video-role-late-never" : "baseline")) })).toThrow(/incompatible.*game259-lossy-video.*video-role-late-never/i)
  })

  it("requires the inferred clock-watch proof's baseline bot, roles and telemetry contract", () => {
    const input = { ...validFlip(), proofs: ["clock-watch-fault" as const], flipVerdict: false, clockWatchFault: true }
    expect(() => validateProofPreflight({ ...input, roles: false })).toThrow(/clock-watch-fault requires roles=true/)
    expect(() => validateProofPreflight({ ...input, bots: [bot(1, "locale-la-enus"), bot(2, "baseline")] })).toThrow(/baseline-iphone14-wifi as bot 1/)
    expect(validateProofPreflight(input)).toEqual({ proofs: ["clock-watch-fault"] })
  })
})

describe("workflow wiring", () => {
  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/e2e-live.yml"), "utf8")
  const deploy = readFileSync(resolve(__dirname, "../../.github/workflows/deploy.yml"), "utf8")

  it("hands every proof precondition to the probe without a pre-run GitHub API gate", () => {
    expect(workflow).toContain("proofs:")
    expect(workflow).toContain("E2E_PROOFS: ${{ inputs.proofs }}")
    expect(workflow).toContain("E2E_ROLES: ${{ inputs.roles && '1' || '0' }}")
    expect(workflow).toContain("E2E_FLIP_VERDICT: ${{ inputs.flip_verdict && '1' || '0' }}")
    expect(workflow).toContain("E2E_TELEMETRY: ${{ inputs.telemetry && '1' || '0' }}")
    expect(workflow).toContain("E2E_CLOCK_WATCH_FAULT: ${{ inputs.clock_watch_fault && '1' || '0' }}")
    expect(readFileSync(resolve(__dirname, "./probe.mts"), "utf8")).not.toContain("requirePrPreviewHead")
    expect(workflow).toContain("E2E_PROOF_HEAD: ${{ needs.probe.outputs.proof_head }}")
  })

  it("stamps exact PR-preview head provenance without disabling main/release source-cache reuse", () => {
    // this repository's deploy.yml keys only pull_request builds on the head sha; main and release builds keep the cached marker
    expect(deploy).toContain("COMMIT_KEY: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}")
    expect(deploy).toContain('echo "commit_marker=jollity-build-commit:$COMMIT_KEY" >> "$GITHUB_OUTPUT"')
    expect(deploy).toContain('echo "commit_marker=jollity-build-commit:cached" >> "$GITHUB_OUTPUT"')
    expect(deploy).toContain("NEXT_PUBLIC_BUILD_COMMIT: ${{ steps.hash.outputs.commit_marker }}")
    expect(deploy).not.toContain("NEXT_PUBLIC_BUILD_COMMIT: jollity-build-commit:${{ github.event.pull_request.head.sha || github.sha }}")
  })
})
