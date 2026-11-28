// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { identityFor, loadNetemProfiles, loadProfiles } from "../profile"
import { allRoles } from "../profiles"
import { MAX_SHARED_BOTS, runnerGroups, SHARED_RUNNER, SOLO_RUNNER } from "../runner-group"
import type { BotEntry } from "../timing"

const network = "previewnet"
const profiles = loadProfiles()
const netem = loadNetemProfiles()

const logicalBots = (): BotEntry[] => allRoles(profiles, network).map(({ profile }, index) => {
  const configured = profiles.find((candidate) => candidate.name === profile)
  const identity = configured && identityFor(configured, network)
  if (!configured || !identity) throw new Error(`capacity profile ${profile} needs a ${network} identity`)
  return { bot: index + 1, profile, identity, secret: `CAPACITY_SLOT_${index + 1}` }
})

const capacityPlan = () => {
  const entries = logicalBots()
  return { entries, plan: runnerGroups(entries, { profiles, netem, share: "on" }) }
}

describe("PreviewNet Crew capacity plan", () => {
  it("pins the reviewed 31-profile plan to 20 physical runner groups", () => {
    const { entries, plan } = capacityPlan()
    const sizes = plan.include.map(({ size }) => size)

    expect({
      logicalBots: entries.length,
      physicalGroups: plan.include.length,
      singletonGroups: sizes.filter((size) => size === 1).length,
      sharedGroups: plan.include.filter(({ shared }) => shared).length,
      twoBotGroups: sizes.filter((size) => size === 2).length,
      threeBotGroups: sizes.filter((size) => size === 3).length,
    }, "Crew shape changed: review the new runner plan and capacity evidence, then re-pin this contract and its investigation document together").toEqual({
      logicalBots: 31,
      physicalGroups: 20,
      singletonGroups: 14,
      sharedGroups: 6,
      twoBotGroups: 1,
      threeBotGroups: 5,
    })
  })

  it("schedules every derived profile and identity exactly once", () => {
    const { entries, plan } = capacityPlan()
    const planned = plan.include.flatMap(({ entries: members }) => members)

    expect(planned.map(({ bot }) => bot).sort((a, b) => a - b)).toEqual(entries.map(({ bot }) => bot))
    expect(new Set(planned.map(({ profile }) => profile)).size).toBe(entries.length)
    expect(new Set(planned.map(({ identity }) => identity)).size).toBe(entries.length)
    expect(plan.manifest.flatMap(({ bots }) => bots).sort((a, b) => a - b)).toEqual(entries.map(({ bot }) => bot))
  })

  it("keeps shared groups bounded and dynamic, relay, or rate-limited profiles solo", () => {
    const { entries, plan } = capacityPlan()

    for (const group of plan.include) {
      expect(group.size).toBe(group.entries.length)
      expect(group.size).toBeGreaterThanOrEqual(1)
      expect(group.size).toBeLessThanOrEqual(MAX_SHARED_BOTS)
      expect(group.runner).toBe(group.shared ? SHARED_RUNNER : SOLO_RUNNER)
      if (group.shared) expect(group.effect).toMatch(/^static:/)
    }

    for (const entry of entries) {
      const profile = profiles.find(({ name }) => name === entry.profile)
      if (!profile) throw new Error(`missing profile ${entry.profile}`)
      const shape = netem[profile.network.profile]
      const mustBeSolo = Boolean(
        profile.network.relayOnly
        || profile.network.switchAtTurn
        || profile.network.blackoutS
        || profile.network.timeline?.length
        || (shape && shape.rateMbit !== 0),
      )
      if (!mustBeSolo) continue
      const group = plan.include.find(({ entries: members }) => members.some(({ bot }) => bot === entry.bot))
      expect(group, entry.profile).toMatchObject({ size: 1, shared: false, runner: SOLO_RUNNER })
    }
  })
})
