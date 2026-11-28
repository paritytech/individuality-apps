// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { RECONNECTING_BEFORE_RESTART_MS } from "../../apps/jollity-app/lib/chain-health"
import { loadProfiles } from "./profile"
import { DEFAULT_PROFILE, ROTATION_FIXED_PROFILES, allRoles, knownProfiles, personaSchedule, resolveProfile, videoRoleProofPlan } from "./profiles"

describe("resolveProfile", () => {
  it("defaults to baseline", () => {
    expect(resolveProfile(undefined)).toBe(DEFAULT_PROFILE)
    expect(resolveProfile("  ")).toBe("baseline")
  })
  it("accepts a name from profiles.json", () => expect(resolveProfile("slow-pixel7-lte-poor")).toBe("slow-pixel7-lte-poor"))
  it("fails clearly on an unknown one, listing the known", () => {
    expect(() => resolveProfile("nope")).toThrow(/E2E_PROFILE="nope" is not a known profile \(known: baseline,/)
  })
  it("the known names are baseline plus exactly profiles.json (one source of truth)", () => {
    expect(knownProfiles()).toEqual(["baseline", ...loadProfiles().map((p) => p.name)])
  })
})

describe("the proven profiles join the all preset", () => {
  it("each new profile, relay-outage and host-crash-long", () => {
    const all = allRoles(undefined, "paseo-next-v2").map((e) => e.profile)
    for (const n of ["clock-wrong-then-corrected", "clock-ahead-then-corrected", "clock-step-while-hidden", "reload-mid-game", "visible-freeze", "relay-outage", "host-crash-long"]) expect(all).toContain(n)
  })
})

describe("uplink lift acceptance persona", () => {
  it("starts at 0.3 Mbit/s, lifts in turn 4, and is explicit-dispatch only", () => {
    const profile = loadProfiles().find((candidate) => candidate.name === "uplink-lift-pixel6a")!
    expect(profile.network).toMatchObject({
      profile: "lte-upload-limited",
      relayOnly: true,
      timeline: [{ atTurn: 4, profile: "lte-good" }],
    })
    expect(profile.identity).toEqual({ previewnet: "jollyuplink.08", "paseo-next-v2": "jollyuplink.30" })
    expect(profile.acceptanceOnly).toBe(true)
    expect(allRoles(undefined, "previewnet").map(({ profile }) => profile)).not.toContain("uplink-lift-pixel6a")
    expect(personaSchedule("previewnet", 101).scheduled).not.toContain("uplink-lift-pixel6a")
  })
})

describe("camera mute-loop acceptance persona", () => {
  it("mutes fresh tracks under harness control and stays out of broad schedules", () => {
    const profile = loadProfiles().find((candidate) => candidate.name === "camera-mute-loop")!
    expect(profile.camera).toMatchObject({ delayMs: 0, resolution: "720p", muteLoop: true })
    expect(profile.acceptanceOnly).toBe(true)
    expect(profile.manualOnly).toBe(true)
    expect(profile.identity).toEqual({ previewnet: "jollycamdeny.25" })
    expect(profile.expect).toContainEqual(expect.objectContaining({ kind: "text", text: "Restart the Polkadot app" }))
    expect(profile.expect.find((guard) => guard.kind === "text" && guard.text === "Restart the Polkadot app")).not.toHaveProperty("never")
    expect(allRoles(undefined, "previewnet").map(({ profile }) => profile)).not.toContain("camera-mute-loop")
    expect(personaSchedule("previewnet", 101).scheduled).not.toContain("camera-mute-loop")
  })
})

describe("covered clock profiles", () => {
  it("does not advertise the two redundant cases", () => {
    expect(knownProfiles()).not.toContain("clock-slow-minus75")
    expect(knownProfiles()).not.toContain("clock-jump-plus30")
  })
})

describe("personaSchedule", () => {
  it("keeps the four proven regression personas in every rotation half", () => {
    for (const run of [101, 102]) {
      const schedule = personaSchedule("previewnet", run)
      expect(schedule.scheduled.slice(0, ROTATION_FIXED_PROFILES.length)).toEqual(ROTATION_FIXED_PROFILES)
      expect(schedule.half).toBe(run === 101 ? "A" : "B")
      expect(schedule.runNumber).toBe(run)
    }
  })

  it("alternates every other runnable persona across consecutive dispatched runs", () => {
    const all = allRoles(undefined, "previewnet").map((entry) => entry.profile)
    const a = personaSchedule("previewnet", 101)
    const b = personaSchedule("previewnet", 102)
    const rotating = all.filter((profile) => !ROTATION_FIXED_PROFILES.includes(profile as (typeof ROTATION_FIXED_PROFILES)[number]))

    expect(a.rotatedOut).toEqual(b.scheduled.filter((profile) => rotating.includes(profile)))
    expect(b.rotatedOut).toEqual(a.scheduled.filter((profile) => rotating.includes(profile)))
    expect(new Set([...a.scheduled, ...a.rotatedOut])).toEqual(new Set(all))
    expect(new Set([...b.scheduled, ...b.rotatedOut])).toEqual(new Set(all))
  })

  it("uses the durable play-marker half instead of deriving it from run-id parity", () => {
    expect(personaSchedule("previewnet", 102, undefined, "A").half).toBe("A")
    expect(personaSchedule("previewnet", 101, undefined, "B").half).toBe("B")
  })

  it("refuses a missing or invalid dispatched-run number", () => {
    for (const run of [undefined, 0, 1.5, Number.NaN]) expect(() => personaSchedule("previewnet", run)).toThrow(/run.*number/)
  })
})

describe("videoRoleProofPlan", () => {
  it("composes reload, delayed-flip and never-video in one game with ordinary remaining slots", () => {
    expect(videoRoleProofPlan()).toEqual([
      { bot: 1, profile: "reload-mid-game" },
      { bot: 2, profile: "video-role-late-flip" },
      { bot: 3, profile: "video-role-late-never" },
      { bot: 4, profile: "baseline" },
      { bot: 5, profile: "baseline" },
      { bot: 6, profile: "baseline" },
    ])
  })
})

describe("host-stuck-in-game hang", () => {
  // The stuck-app advice shows only after the host has been stuck for the app's
  // "Reconnecting…" window. Host 0.27 recovers ~10 s after a hang lifts (0.26
  // took ~65 s), so the hang itself must cover detection + the window + margin.
  const STUCK_DETECTION_S = 26
  const MARGIN_S = 20
  it("lasts past stuck detection, the reconnecting window and a margin", () => {
    const step = loadProfiles().find((p) => p.name === "host-stuck-in-game")?.network.timeline?.find((t) => t.hostChainHangS !== undefined)
    expect(step?.hostChainHangS).toBeGreaterThanOrEqual(STUCK_DETECTION_S + RECONNECTING_BEFORE_RESTART_MS / 1000 + MARGIN_S)
  })
  // host-stuck-waiting: the journey restarts the host itself HANG - 8 s in, so
  // the restart advice has to be on screen before then.
  const SELF_RESTART_LEAD_S = 8
  it("host-stuck-waiting shows the restart advice before its own host restart", () => {
    const step = loadProfiles().find((p) => p.name === "host-stuck-waiting")?.network.timeline?.find((t) => t.hostChainHangS !== undefined)
    expect((step?.hostChainHangS ?? 0) - SELF_RESTART_LEAD_S).toBeGreaterThanOrEqual(STUCK_DETECTION_S + RECONNECTING_BEFORE_RESTART_MS / 1000 + MARGIN_S)
  })
})
