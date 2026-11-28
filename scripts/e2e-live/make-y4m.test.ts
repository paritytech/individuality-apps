// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfiles } from "./profile"
import { allRoles } from "./profiles"
import { clipPlansForProfiles, generateClips, readY4m } from "./make-y4m.mts"

describe("identity fake-camera clips", () => {
  it("plans one stable path per distinct identity and required resolution", () => {
    const plans = clipPlansForProfiles("/clips", ["slow-pixel7-lte-poor", "tap-storm-pixel7", "uplink-limited-pixel6a", "uplink-lift-pixel6a"], "game")
    expect(plans.map(({ path }) => basename(path))).toEqual(["lady-latency-360p.y4m", "tap-tony-360p.y4m", "narrowband-ned-720p.y4m"])
  })

  it("keeps reserved baseline on Chromium's built-in camera during a game", () => {
    expect(clipPlansForProfiles("/clips", ["baseline"], "game")).toEqual([])
  })

  it("plans dedicated harness clips for reserved and identity-bearing boot profiles", () => {
    expect(clipPlansForProfiles("/clips", ["baseline", "slow-pixel7-lte-poor"], "boot").map(({ path }) => basename(path))).toEqual([
      "harness-baseline-720p.y4m",
      "harness-slow-pixel7-lte-poor-360p.y4m",
    ])
  })

  it("keeps camera-denied and camera-missing identities resolvable", () => {
    expect(clipPlansForProfiles("/clips", ["camera-denied", "camera-missing"], "game").map(({ path }) => basename(path))).toEqual([
      "shutter-sheila-720p.y4m",
      "phantom-phil-720p.y4m",
    ])
  })

  it("plans one unique camera source for every game-ready identity", () => {
    const profiles = allRoles(loadProfiles(), "previewnet").map(({ profile }) => profile)
    const plans = clipPlansForProfiles("/clips", profiles, "game")
    expect(profiles).toHaveLength(31)
    expect(plans).toHaveLength(31)
    expect(new Set(plans.map((plan) => plan.kind === "identity" ? plan.identity.key : null)).size).toBe(31)
  })

  it("writes deterministic moving clips whose identities have different pixels", async () => {
    const first = await mkdtemp(join(tmpdir(), "crew-y4m-a-"))
    const second = await mkdtemp(join(tmpdir(), "crew-y4m-b-"))
    const [lady, tony] = await generateClips(first, ["slow-pixel7-lte-poor", "tap-storm-pixel7"], "game")
    const [ladyAgain] = await generateClips(second, ["slow-pixel7-lte-poor"], "game")

    const ladyBytes = await readFile(lady.path)
    const ladyAgainBytes = await readFile(ladyAgain.path)
    const tonyBytes = await readFile(tony.path)
    expect(ladyBytes.equals(ladyAgainBytes)).toBe(true)
    expect(ladyBytes.equals(tonyBytes)).toBe(false)

    const parsed = readY4m(ladyBytes)
    expect(parsed).toMatchObject({ width: 640, height: 360, fps: 15 })
    expect(parsed.frames).toHaveLength(30)
    expect(parsed.frames[0].equals(parsed.frames[29])).toBe(false)
  })
})
