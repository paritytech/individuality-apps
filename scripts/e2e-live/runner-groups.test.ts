// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { loadNetemProfiles, loadProfiles, type Profile } from "./profile"
import { ROTATION_FIXED_PROFILES } from "./profiles"
import { MAX_SHARED_BOTS, runnerGroups, SHARED_RUNNER, SOLO_RUNNER } from "./runner-group"
import type { BotEntry } from "./timing"

const profiles = loadProfiles()
const netem = loadNetemProfiles()
const entry = (bot: number, profile: string): BotEntry => ({ bot, profile, identity: `person.${bot}`, secret: `PERSON_${bot}` })

describe("runnerGroups", () => {
  it("keeps sharing off by default", () => {
    const wifiNames = ["baseline-iphone14-wifi", "kill-background-iphone13", "locale-la-enus", "locale-tokyo-jajp"]
    const plan = runnerGroups(wifiNames.map((profile, index) => entry(index + 1, profile)), { profiles, netem })
    expect(plan.include.every(({ size, shared }) => size === 1 && !shared)).toBe(true)
  })

  it("packs identical static unbounded wifi effects in groups of at most three when enabled", () => {
    const wifiNames = ["baseline-iphone14-wifi", "locale-la-enus", "locale-tokyo-jajp", "locale-berlin-dede"]
    const plan = runnerGroups(wifiNames.map((profile, index) => entry(index + 1, profile)), { profiles, netem, share: "on" })
    expect(plan.include.map(({ size, runner }) => [size, runner])).toEqual([
      [MAX_SHARED_BOTS, SHARED_RUNNER],
      [1, SOLO_RUNNER],
    ])
    expect(plan.include[0].effect_profile).toBe("wifi")
    expect(plan.include.flatMap(({ entries }) => entries.map(({ bot }) => bot))).toEqual([1, 2, 3, 4])
  })

  it("keeps every runner-wide or rate-limited effect solo", () => {
    const names = ["baseline", "slow-pixel7-lte-poor", "relay-iphonese-fastclock", "switcher-pixel6a-wifi-to-cell", "storm-pixel6a-timeline", "chain-outage", "uplink-limited-pixel6a"]
    const plan = runnerGroups(names.map((profile, index) => entry(index + 1, profile)), { profiles, netem })
    expect(plan.include).toHaveLength(names.length)
    expect(plan.include.every(({ size, runner, shared }) => size === 1 && runner === SOLO_RUNNER && !shared)).toBe(true)
  })

  it("keeps group order at the first logical bot even when compatible bots are separated", () => {
    const plan = runnerGroups([entry(1, "baseline-iphone14-wifi"), entry(2, "slow-pixel7-lte-poor"), entry(3, "locale-la-enus")], { profiles, netem, share: "on" })
    expect(plan.include.map(({ bots_label }) => bots_label)).toEqual(["1-3", "2"])
  })

  it("uses numbered public fields for bounded secret lookup without embedding mnemonics", () => {
    const plan = runnerGroups([entry(7, "baseline-iphone14-wifi"), entry(8, "locale-la-enus")], { profiles, netem, share: "on" })
    expect(plan.include[0]).toMatchObject({ bot1: 7, secret1: "PERSON_7", bot2: 8, secret2: "PERSON_8", bot3: null, secret3: "", bots_label: "7-8" })
    expect(JSON.stringify(plan)).not.toContain("mnemonic")
  })

  it("measure mode creates one shared baseline-like wifi cohort and a solo control", () => {
    const names = ["baseline-iphone14-wifi", "locale-la-enus", "locale-tokyo-jajp", "locale-berlin-dede", "kill-background-iphone13"]
    const plan = runnerGroups(names.map((profile, index) => entry(index + 1, profile)), { profiles, netem, share: "measure" })
    expect(plan.include[0]).toMatchObject({ size: 2, shared: true, measure: true, runner: SHARED_RUNNER })
    expect(plan.include[1]).toMatchObject({ size: 1, shared: false, measure: true, runner: SHARED_RUNNER })
    expect(plan.include[2]).toMatchObject({ size: 1, measure: false })
  })

  it("excludes camera outcomes, clock experiments and fixtures from measurement", () => {
    const names = ["baseline-iphone14-wifi", "locale-la-enus", "camera-denied", "camera-missing", "clock-jumps", "check-stale-build"]
    expect(() => runnerGroups(names.map((profile, index) => entry(index + 1, profile)), { profiles, netem, share: "measure" })).toThrow(/CPU\/resolution-matched/)
  })

  it("refuses an underpowered measurement instead of silently comparing unlike bots", () => {
    expect(() => runnerGroups([entry(1, "baseline-iphone14-wifi"), entry(2, "locale-la-enus")], { profiles, netem, share: "measure" })).toThrow(/solo control/)
  })

  it("keys compatibility from network data, not persona names", () => {
    const custom: Profile = { ...profiles[0], name: "new-baseline-like", bot: null, role: { kind: "baseline", params: {} } }
    const plan = runnerGroups([entry(1, profiles[0].name), entry(2, custom.name)], { profiles: [...profiles, custom], netem, share: "on" })
    expect(plan.include[0]).toMatchObject({ size: 2, shared: true })
  })

  it("shares any identical static unbounded profile without keying eligibility to the wifi name", () => {
    const cleanLink = { ...netem.wifi }
    const custom = ["clean-one", "clean-two"].map((name) => ({ ...profiles[0], name, network: { ...profiles[0].network, profile: "clean-link" } })) as Profile[]
    const plan = runnerGroups(custom.map(({ name }, index) => entry(index + 1, name)), { profiles: [...profiles, ...custom], netem: { ...netem, "clean-link": cleanLink }, share: "on" })
    expect(plan.include[0]).toMatchObject({ size: 2, shared: true, effect_profile: "clean-link" })
  })

  it("never mixes network effects inside a measurement cohort or its control", () => {
    const clean = { ...profiles[0], name: "clean-baseline", network: { ...profiles[0].network, profile: "clean-link" } } as Profile
    const selected = [entry(1, "baseline-iphone14-wifi"), entry(2, "locale-la-enus"), entry(3, clean.name)]
    expect(() => runnerGroups(selected, { profiles: [...profiles, clean], netem: { ...netem, "clean-link": { ...netem.wifi } }, share: "measure" })).toThrow(/share=measure needs/)
  })

  it("never puts two fixed rotation sentinels in one physical group", () => {
    const plan = runnerGroups([
      entry(1, "baseline-iphone14-wifi"), entry(2, "locale-la-enus"), entry(3, "kill-background-iphone13"),
    ], { profiles, netem, share: "on" })
    expect(plan.include.filter(({ entries }) => entries.some(({ profile }) => ROTATION_FIXED_PROFILES.includes(profile as (typeof ROTATION_FIXED_PROFILES)[number]))).every(({ entries }) => entries.filter(({ profile }) => ROTATION_FIXED_PROFILES.includes(profile as (typeof ROTATION_FIXED_PROFILES)[number])).length === 1)).toBe(true)
  })

  it("keeps fixed sentinels on separate runners in measurement mode too", () => {
    const baseline = profiles.find(({ name }) => name === "baseline-iphone14-wifi") as Profile
    const fixedClone = { ...baseline, name: "kill-background-iphone13" }
    const ordinaryClone = { ...baseline, name: "measurement-ordinary" }
    const plan = runnerGroups([
      entry(1, baseline.name), entry(2, fixedClone.name), entry(3, ordinaryClone.name),
    ], { profiles: [fixedClone, ordinaryClone, ...profiles], netem, share: "measure" })
    const shared = plan.include.find(({ shared }) => shared)
    expect(shared?.entries.filter(({ profile }) => ROTATION_FIXED_PROFILES.includes(profile as (typeof ROTATION_FIXED_PROFILES)[number]))).toHaveLength(1)
  })
})
