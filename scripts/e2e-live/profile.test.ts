// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { devices } from "@playwright/test"
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { assertDevlogHarness, matrixNeedsDevlogHarness, describeGuard, fixtureRequestPath, identityFor, isCheckProfile, loadNetemProfiles, loadProfiles, localPermissionGateEnv, materializeProfileEnv, needsDevlogHarness, needsTelemetryOracle, pendingGuards, profileByName, profileFor, shouldEnforceDevlogHarness, validateGuard, validateProfiles } from "./profile"
import raw from "./profiles.json"
import { GAME_LOG_CHUNK_MAX_BYTES, ROLLING_CHECKPOINT_LINES, splitGameLogLines, type GameLogChunkLine } from "../../apps/jollity-app/lib/telemetry/game-log-outbox"
import { rolePlan } from "./roles"
import { evaluateGuard } from "./guards"

const netem = loadNetemProfiles()
const base = () => structuredClone(raw.profiles[0]) as Record<string, unknown>

describe("telemetry oracle scope", () => {
  it("gates only explicit telemetry-torture profiles", () => {
    expect(needsTelemetryOracle(profileByName("telemetry-t1-baseline"))).toBe(true)
    expect(needsTelemetryOracle(profileByName("slow-pixel7-lte-poor"))).toBe(false)
    expect(needsTelemetryOracle({ ...profileByName("telemetry-t1-baseline")!, name: "ordinary-with-flag" })).toBe(false)
    expect(needsTelemetryOracle(null)).toBe(false)
  })
})

describe("devlog harness scope", () => {
  it("is on for every game matrix, even one with no devlog-guard profile, because sign-up reads the app clock", () => {
    const wave = ["baseline-iphone14-wifi", "kill-background-iphone13", "reload-mid-game", "clock-step-while-hidden", "slow-pixel7-lte-poor", "switcher-pixel6a-wifi-to-cell"].map((name) => profileByName(name))
    expect(wave.some((profile) => needsDevlogHarness(profile))).toBe(false)
    expect(matrixNeedsDevlogHarness(wave)).toBe(true)
    expect(matrixNeedsDevlogHarness([])).toBe(false)
  })

  it("is required by profiles with a devlog guard or direct in-page evidence", () => {
    expect(needsDevlogHarness(profileByName("baseline-iphone14-wifi"))).toBe(false)
    expect(needsDevlogHarness(profileByName("slow-pixel7-lte-poor"))).toBe(false)
    expect(needsTelemetryOracle(profileByName("baseline-iphone14-wifi"))).toBe(false)
    expect(needsTelemetryOracle(profileByName("slow-pixel7-lte-poor"))).toBe(false)
    expect(needsDevlogHarness(profileByName("video-stall-30s"))).toBe(true)
    expect(needsDevlogHarness(profileByName("reload-clean-close"))).toBe(false)
    expect(needsDevlogHarness(profileByName("turn-cache-relaunch"))).toBe(false)
    expect(needsDevlogHarness(profileByName("uplink-lift-pixel6a"))).toBe(true)
    expect(needsDevlogHarness(profileByName("turn-warm-returning"))).toBe(true)
    expect(needsDevlogHarness(profileByName("network-blocked"))).toBe(true)
    for (const profile of loadProfiles()) {
      const guarded = profile.expect.some((guard) => guard.kind === "devlog" || guard.kind === "late-join-proof" || guard.kind === "reload-video-back")
        || ["uplink-lift-pixel6a", "turn-warm-returning", "network-blocked"].includes(profile.name)
      expect(needsDevlogHarness(profile), profile.name).toBe(guarded)
    }
  })

  it("is not required by profiles whose guards are page or chain only", () => {
    expect(needsDevlogHarness(profileByName("video-role-late-flip"))).toBe(false)
    expect(needsDevlogHarness(null)).toBe(false)
  })

  it("fails loudly only for a dispatched play run without the harness", () => {
    const guarded = profileByName("video-stall-30s")
    expect(() => assertDevlogHarness(guarded, false, true)).toThrow(/video-stall-30s.*page harness/i)
    expect(() => assertDevlogHarness(guarded, true, true)).not.toThrow()
    expect(() => assertDevlogHarness(profileByName("turn-warm-returning"), false, true)).toThrow(/turn-warm-returning.*page harness/i)
    expect(() => assertDevlogHarness(profileByName("video-role-late-flip"), false, true)).not.toThrow()
    expect(() => assertDevlogHarness(guarded, false, false)).not.toThrow()
  })

  it("keeps pull-request, schedule and boot-only boots outside the fail-closed boundary", () => {
    expect(shouldEnforceDevlogHarness("pull_request", "boot")).toBe(false)
    expect(shouldEnforceDevlogHarness("schedule", "all")).toBe(false)
    expect(shouldEnforceDevlogHarness("workflow_dispatch", "boot")).toBe(false)
    expect(shouldEnforceDevlogHarness("workflow_dispatch", "all")).toBe(true)
    expect(() => assertDevlogHarness(profileByName("baseline-iphone14-wifi"), false, true)).not.toThrow()
    const probe = readFileSync(new URL("./probe.mts", import.meta.url), "utf8")
    const boot = readFileSync(new URL("./boot.mts", import.meta.url), "utf8")
    expect(probe).toContain("matrixNeedsDevlogHarness(bots.map((bot) => profileForName(bot.profile)))")
    expect(boot).toContain("shouldEnforceDevlogHarness(process.env.GITHUB_EVENT_NAME, STAGE)")
    expect(boot).toMatch(/assertDevlogHarness\(\s*PROFILE_DEF,\s*process\.env\.E2E_DEVLOG_HARNESS === "1"/)
    expect(boot).toContain("const tag = telemetryTag || harnessTag")
    expect(boot).toMatch(/if \(!telemetryTag\) \{\s*const stripped = stripSentryDsns\(files\)/)
  })
})
const doc = (...ps: unknown[]) => ({ profiles: ps })

describe("profiles.json", () => {
  const profiles = loadProfiles()
  it("defines the reload-mid-round video proof (#1020): a round-1 reload, video back from a co-player within the budget", () => {
    const profile = profileByName("reload-video-back")
    expect(profile.acceptanceOnly).toBe(true)
    expect(profile.role).toMatchObject({ kind: "reload", params: { reloadAtTurn: 2 } })
    expect(profile.expect).toContainEqual(expect.objectContaining({ kind: "reload-video-back", maxVideoBackMs: 45000 }))
    expect(needsDevlogHarness(profile)).toBe(true)
  })
  it("defines a fail-capable seven-player fast-late-join proof", () => {
    const profile = profileByName("issue874-fast-late-join")
    expect(profile.acceptanceOnly).toBe(true)
    expect(profile.manualOnly).toBe(true)
    expect(profile.role).toMatchObject({ kind: "late-join", params: { joinAfterTurn: 6 } })
    expect(profile.expect).toContainEqual(expect.objectContaining({ kind: "late-join-proof", round: 1, maxFirstVideoMs: 8000 }))
    expect(needsDevlogHarness(profile)).toBe(true)
  })
  it("holds the six bots, the two one-bot checks and the data-only scenario profiles", () => {
    expect(profiles.filter((p) => p.bot !== null).map((p) => p.bot).sort()).toEqual([1, 2, 3, 4, 5, 6])
    expect(profiles.filter(isCheckProfile).map((p) => p.name).sort()).toEqual(["check-seat-preparing", "check-stale-build"])
  })
  it("defines the complete previewnet telemetry torture matrix without fresh identities", () => {
    const torture = profiles.filter((profile) => profile.telemetryTorture)
    expect(torture.map((profile) => profile.telemetryTorture?.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12"])
    expect(torture.every((profile) => profile.bot === null && profile.acceptanceOnly && identityFor(profile, "previewnet"))).toBe(true)
    expect(new Set(torture.map((profile) => identityFor(profile, "previewnet"))).size).toBe(6)
    expect(torture.every((profile) => profile.freshIdentity !== true)).toBe(true)
    expect(torture.every(needsTelemetryOracle)).toBe(true)
    expect(profiles.filter((profile) => !profile.telemetryTorture).every((profile) => !needsTelemetryOracle(profile))).toBe(true)
    expect(profileByName("telemetry-t3-ios-fetch-gate").telemetryTorture).toMatchObject({ durationS: 180, activateAtTurn: 1 })
    expect(profileByName("telemetry-t4-kill-while-stuck").telemetryTorture).toMatchObject({ fault: "host-storage-hang", pageLoads: [0], fetchGatePageLoads: [0], fetchGateS: 3600, activateAtTurn: 1 })
    expect(profileByName("telemetry-t5-stuck-first-reopen").telemetryTorture).toMatchObject({ fault: "host-storage-hang", pageLoads: [0, 1], fetchGatePageLoads: [0, 1], fetchGateS: 3600, activateAtTurn: 1 })
    expect(profileByName("telemetry-t7-sentry-block").telemetryTorture).toMatchObject({ durationS: 300, activateAtTurn: 1 })
    expect(profileByName("telemetry-t8-sentry-429").telemetryTorture).toMatchObject({ durationS: 120, retryAfterS: 120, activateAtTurn: 1 })
    const t9Text = profileByName("telemetry-t9-blackout").expect.filter((guard) => guard.kind === "text").map((guard) => guard.text)
    expect(t9Text).toEqual(expect.arrayContaining(["Your Polkadot app is stuck, restart it", "We couldn't connect you to anyone."]))
  })
  it("the reduced T10 storm exceeds one chunk budget across live rolling seals", () => {
    const profile = profileByName("telemetry-t10-big-log")
    const role = rolePlan(profile, true)
    expect(role).toMatchObject({ kind: "tap-storm", flips: 20 })
    const flips = role.kind === "tap-storm" ? role.flips : 0
    const sessionId = "7d73bc18-8d45-464e-99a7-ee377d79cdc5"
    const lines: GameLogChunkLine[] = Array.from({ length: flips * 2 * 10 }, (_, index) => ({
      ts: 1_792_382_409_209 + index,
      sessionId,
      lineId: `${sessionId}:${index}`,
      level: "info",
      tag: "vote",
      message: "tap",
      data: JSON.stringify({ turn: Math.floor(index / (flips * 2)) + 1, round: 0, target: "5ExampleTarget111111111111111111111111111111111111111", verdict: index % 2 ? "person" : "notperson" }),
    }))
    const rollingSeals = Array.from(
      { length: Math.ceil(lines.length / ROLLING_CHECKPOINT_LINES) },
      (_, index) => lines.slice(index * ROLLING_CHECKPOINT_LINES, (index + 1) * ROLLING_CHECKPOINT_LINES),
    )
    const parts = rollingSeals.flatMap((seal) => splitGameLogLines(seal))
    expect(lines).toHaveLength(400)
    expect(rollingSeals).toHaveLength(8)
    expect(parts).toHaveLength(rollingSeals.length)
    for (const part of parts) expect(new TextEncoder().encode(JSON.stringify(part)).byteLength).toBeLessThanOrEqual(GAME_LOG_CHUNK_MAX_BYTES)
    expect(parts.reduce((sum, part) => sum + new TextEncoder().encode(JSON.stringify(part)).byteLength, 0)).toBeGreaterThan(GAME_LOG_CHUNK_MAX_BYTES)
    expect(parts.flat()).toEqual(lines)
  })
  it.each(profiles.map((p) => [p.name, p] as const))("%s uses a real device and network profile", (_n, p) => {
    expect(Object.keys(devices)).toContain(p.device)
    expect(Object.keys(netem)).toContain(p.network.profile)
    for (const g of p.expect) expect(describeGuard(g)).toBeTruthy()
  })
  it("loads names and shape without importing @playwright/test", () => {
    expect(readFileSync(new URL("./profile.ts", import.meta.url), "utf8")).not.toMatch(/from "@playwright\/test"/)
  })
  it("never lets a pending guard stand without a reason, and lists them", () => {
    const pending = profiles.flatMap(pendingGuards)
    expect(pending.length).toBeGreaterThan(0)
    for (const g of pending) expect(g.note).toBeTruthy()
  })
  it("makes all nine proved dedicated personas eligible", () => {
    const byName = Object.fromEntries(profiles.map((profile) => [profile.name, profile]))
    for (const name of ["locale-la-enus", "locale-tokyo-jajp", "locale-berlin-dede", "uplink-limited-pixel6a", "storm-pixel6a-timeline", "camera-denied", "camera-missing", "video-role-late-flip", "video-role-late-never"]) {
      expect(byName[name]?.pending, name).toBeUndefined()
    }
    expect(byName["camera-denied"]?.expectedOutcome).toEqual({ kind: "camera-unavailable", reason: "denied" })
    expect(byName["camera-missing"]?.expectedOutcome).toEqual({ kind: "camera-unavailable", reason: "no-camera" })
  })
  it("keeps the local permission gate for terminal camera personas only", () => {
    expect(localPermissionGateEnv(null)).toEqual({ SKIP_PERMISSION_GATE: "1" })
    expect(localPermissionGateEnv(profileByName("baseline-iphone14-wifi"))).toEqual({ SKIP_PERMISSION_GATE: "1" })
    expect(localPermissionGateEnv(profileByName("camera-denied"))).toEqual({})
    expect(localPermissionGateEnv(profileByName("camera-missing"))).toEqual({})
  })
  it("looks up by bot and by name", () => {
    expect(profileFor(3).network.relayOnly).toBe(true)
    expect(profileByName("check-stale-build").bot).toBeNull()
    expect(() => profileFor(9)).toThrow(/no profile for bot 9/)
    expect(() => profileByName("nope")).toThrow(/no profile named/)
  })
  it("is runnable: no pending reason, and its release entries cover every network's product", () => {
    const p = profileByName("check-stale-build")
    expect(p.pending).toBeUndefined()
    for (const product of ["dim2.testnet", "dim2.paseo"]) expect(Object.keys(p.fixture?.body as object)).toContain(product)
    expect(p.env).not.toHaveProperty("NEXT_PUBLIC_PRODUCT_DOTNS")
  })
  it("describes the stale-build environment and version response as profile data", () => {
    const p = profileByName("check-stale-build")
    expect(p.role).toEqual({ kind: "baseline", label: "stale-build", params: {} })
    expect(p.fixture?.path).toBe("/dim2-version.json")
    expect(p.fixture?.body).toEqual({
      // one release entry per network's product (host-slot NETWORKS): the app's own product is the host's, never pinned here
      "dim2.testnet": { version: "e2e-future-build", time: 4_102_444_800 },
      "dim2.paseo": { version: "e2e-future-build", time: 4_102_444_800 },
      updated: "2100-01-01T00:00:00.000Z",
    })
    expect(materializeProfileEnv(p, "http://localhost:1234/dim2-version.json")).toEqual({
      NEXT_PUBLIC_VERSION_URL: "http://localhost:1234/dim2-version.json",
      NEXT_PUBLIC_BUILD_TIME: "0",
    })
  })
  it("matches a fixture request by pathname while preserving the app's cache-busting query", () => {
    expect(fixtureRequestPath("/dim2-version.json?t=12345")).toBe("/dim2-version.json")
  })
})

describe("validation", () => {
  it("keeps manual proofs explicit-dispatch acceptance profiles", () => {
    const one = (manualOnly: unknown, acceptanceOnly: unknown = true) =>
      doc({ ...base(), bot: null, acceptanceOnly, manualOnly })
    expect(validateProfiles(one(true), netem)[0]).toMatchObject({ acceptanceOnly: true, manualOnly: true })
    expect(() => validateProfiles(one(false), netem)).toThrow(/manualOnly.*true/)
    expect(() => validateProfiles(doc({ ...base(), bot: null, manualOnly: true }), netem)).toThrow(/manual-only profiles must be acceptanceOnly/)
  })

  it("validates torture choreography and keeps it explicit-dispatch only", () => {
    const one = (telemetryTorture: unknown, acceptanceOnly: unknown = true) =>
      doc({ ...base(), bot: null, acceptanceOnly, telemetryTorture })
    expect(validateProfiles(one({ id: "T4", fault: "ios-fetch-gate", pageLoads: [0], durationS: 300 }), netem)[0].telemetryTorture?.id).toBe("T4")
    expect(() => validateProfiles(one({ id: "T13", fault: "none" }), netem)).toThrow(/telemetryTorture.id/)
    expect(() => validateProfiles(one({ id: "T1", fault: "unknown" }), netem)).toThrow(/telemetryTorture.fault/)
    expect(() => validateProfiles(one({ id: "T1", fault: "none", pageLoads: [0.5] }), netem)).toThrow(/whole numbers/)
    expect(() => validateProfiles(one({ id: "T1", fault: "none", fetchGatePageLoads: [0.5] }), netem)).toThrow(/whole numbers/)
    expect(() => validateProfiles(one({ id: "T1", fault: "none", activateAtTurn: 1.5 }), netem)).toThrow(/whole number/)
    expect(() => validateProfiles(one({ id: "T1", fault: "none" }, false), netem)).toThrow(/acceptanceOnly/)
  })
  it("keeps data-channel faults bounded and explicit-dispatch only", () => {
    const one = (dataChannelFault: unknown, acceptanceOnly: unknown = true) =>
      doc({ ...base(), bot: null, acceptanceOnly, dataChannelFault })
    expect(validateProfiles(one({ dropRenegotiationOffers: 2 }), netem)[0].dataChannelFault).toEqual({ dropRenegotiationOffers: 2 })
    expect(() => validateProfiles(one({ dropRenegotiationOffers: 0 }), netem)).toThrow(/dropRenegotiationOffers/)
    expect(() => validateProfiles(one({ dropRenegotiationOffers: 1.5 }), netem)).toThrow(/whole number/)
    expect(() => validateProfiles(one({ dropRenegotiationOffers: 2 }, false), netem)).toThrow(/acceptanceOnly/)
  })
  it("keeps peer recovery faults closed and explicit-dispatch only", () => {
    const one = (peerFault: unknown, acceptanceOnly: unknown = true) =>
      doc({ ...base(), bot: null, acceptanceOnly, peerFault })
    for (const kind of ["glare-forcer", "late-signal", "one-way-video", "dropped-answer"]) {
      expect(validateProfiles(one({ kind }), netem)[0].peerFault).toEqual({ kind })
    }
    expect(() => validateProfiles(one({ kind: "silent-no-op" }), netem)).toThrow(/peerFault.kind/)
    expect(() => validateProfiles(one({ kind: "late-signal", delay: 1 }), netem)).toThrow(/has no field delay/)
    expect(() => validateProfiles(one({ kind: "late-signal" }, false), netem)).toThrow(/acceptanceOnly/)
  })

  it("defines four fail-or-fire step 4 peer personas", () => {
    for (const name of ["glare-forcer", "late-signal", "one-way-video", "dropped-answer"] as const) {
      const profile = profileByName(name)
      expect(profile).toMatchObject({ acceptanceOnly: true, minPlayers: 6, peerFault: { kind: name } })
      const fireGuard = profile.expect.find((guard) => guard.kind === "devlog" && guard.match === `[e2e-peer-fault] ${name} fired`)
      expect(fireGuard).toEqual(expect.objectContaining({ kind: "devlog", min: 1 }))
      expect(evaluateGuard(fireGuard!, { devlog: { note: "test", lines: [{ ts: 1, tag: "rtc", message: "unrelated harness line" }] } }).status).toBe("fail")
      const proofFields = name === "late-signal" ? " peer=peer-a link=peer-a>me" : name === "one-way-video" ? " initiator-peer=peer-z" : ""
      expect(evaluateGuard(fireGuard!, { devlog: { note: "test", lines: [{ ts: 1, tag: "rtc", message: `[e2e-peer-fault] ${name} fired fault=test${proofFields}` }] } }).status).toBe("pass")
      // Round size and a co-scheduled one-way-video fault make a fixed
      // aggregate first-video count neither stable nor persona-specific. Each
      // fault instead proves its own affected peer survived after firing.
      expect(profile.expect.find((guard) => guard.kind === "devlog" && guard.match === "[jollity-rtc] round-link" && guard.fields?.stage === "first-video")).toBeUndefined()
      expect(profile.expect).toContainEqual(expect.objectContaining({
        match: name === "dropped-answer" ? "[e2e-peer-fault] dropped-answer recovered" : `[e2e-peer-fault] ${name} recovered`,
        min: 1,
      }))
    }
    expect(profileByName("glare-forcer").expect).toContainEqual(expect.objectContaining({ match: "glare on lane with video negotiated: rebuild instead of rolling back" }))
    expect(profileByName("late-signal")).toMatchObject({ network: { profile: "wifi", relayOnly: false } })
    expect(profileByName("late-signal").network.timeline).toBeUndefined()
    expect(profileByName("late-signal").expect).toContainEqual(expect.objectContaining({ match: "[jollity-rtc] e2e-late-signal stage=complete", fields: { replacements: "2" } }))
    expect(profileByName("one-way-video").expect).toContainEqual(expect.objectContaining({ match: "[e2e-peer-fault] one-way-video fired", has: ["initiator-peer"] }))
    expect(profileByName("one-way-video").expect).toContainEqual(expect.objectContaining({ match: "unseen: signalingState=" }))
    expect(profileByName("dropped-answer").expect).toContainEqual(expect.objectContaining({ match: "[e2e-peer-fault] dropped-answer recovered" }))
    expect(profileByName("dropped-answer").network.timeline).toBeUndefined()
  })

  it("defines the issue 870 previewnet acceptance matrix", () => {
    const lossy = profileByName("game259-lossy-video")
    expect(lossy).toMatchObject({ acceptanceOnly: true, minPlayers: 6, network: { profile: "wifi" } })
    expect(lossy.network.timeline).toEqual([
      {
        atRoundChannelsOpen: { round: 2, count: 5, byGameS: 105 },
        profile: "game259-negotiation-burst",
        forS: 15,
        restoreProfile: "game259-lossy",
      },
    ])
    // The journey's group-derived post-burst checks bind these events to the
    // exact active peers. A static aggregate would also count earlier-only
    // links re-logged during the round transition.
    expect(lossy.expect.find((guard) => guard.kind === "devlog" && guard.match === "[jollity-rtc] round-link" && guard.fields?.round === "2")).toBeUndefined()
    expect(lossy.expect).not.toContainEqual(expect.objectContaining({ match: "channel open" }))
    expect(profileByName("game259-dropped-lane-rebuild")).toMatchObject({ minPlayers: 6, dataChannelFault: { dropRenegotiationOffers: 1 } })
    expect(profileByName("game259-dropped-lane-rebuild").expect).toContainEqual(expect.objectContaining({ kind: "devlog", match: "[e2e-data-channel-fault] dropped renegotiation offer", fields: { fault: "offer-1" } }))
    expect(profileByName("game259-dropped-lane-rebuild").expect).toContainEqual(expect.objectContaining({ kind: "devlog", match: "[jollity-rtc] round-link", fields: { stage: "first-video", round: "1", fault: "offer-1" }, has: ["peer"], min: 1, max: 1 }))
    expect(profileByName("game259-clean-video-control").minPlayers).toBe(6)
    const clean = profileByName("game259-clean-video-control").expect
    expect(clean).toContainEqual(expect.objectContaining({ kind: "devlog", match: "[jollity-rtc] round-link", fields: { stage: "first-video", round: "1", peer: "5EWNTaqLH4f2qHWWxe5eGwrzX1p9HVn18x31NQB918zYJzEc" } }))
    expect(clean).toContainEqual(expect.objectContaining({ kind: "devlog", match: "[jollity-rtc] media-stall: no-video-rebuild", fields: { peer: "5EWNTaqLH4f2qHWWxe5eGwrzX1p9HVn18x31NQB918zYJzEc" }, max: 0 }))
    for (const name of ["game259-lossy-video", "game259-dropped-lane-rebuild", "game259-clean-video-control", "video-stall-30s", "udp-cut-40s"]) {
      expect(profileByName(name).minPlayers, name).toBe(6)
    }
  })
  it("requires a whole supported group size for multiplayer-only profiles", () => {
    expect(() => validateProfiles(doc({ ...base(), minPlayers: 1 }), netem)).toThrow(/minPlayers.*2-6/)
    expect(() => validateProfiles(doc({ ...base(), minPlayers: 6.5 }), netem)).toThrow(/minPlayers.*whole number/)
    expect(() => validateProfiles(doc({ ...base(), minPlayers: 7 }), netem)).toThrow(/minPlayers.*2-6/)
  })
  it("rejects an unknown network profile, also in switchTo", () => {
    expect(() => validateProfiles(doc({ ...base(), network: { profile: "5g", relayOnly: false } }), netem)).toThrow(/network.profile.*5g/)
    expect(() => validateProfiles(doc({ ...base(), network: { profile: "wifi", relayOnly: false, switchAtTurn: 2, switchTo: "5g" } }), netem)).toThrow(/switchTo/)
  })
  it("requires switchAtTurn and switchTo together, and blackout needs a switch", () => {
    expect(() => validateProfiles(doc({ ...base(), network: { profile: "wifi", relayOnly: false, switchAtTurn: 2 } }), netem)).toThrow(/go together/)
    expect(() => validateProfiles(doc({ ...base(), network: { profile: "wifi", relayOnly: false, blackoutS: 5 } }), netem)).toThrow(/needs switchAtTurn/)
  })
  it("rejects duplicate bot numbers and names", () => {
    expect(() => validateProfiles(doc(base(), { ...base(), name: "other" }), netem)).toThrow(/duplicate bot number 1/)
    expect(() => validateProfiles(doc(base(), { ...base(), bot: 2 }), netem)).toThrow(/duplicate name/)
  })
  it("rejects bot numbers out of range and unknown roles", () => {
    expect(() => validateProfiles(doc({ ...base(), bot: 7 }), netem)).toThrow(/1-6 or null/)
    expect(() => validateProfiles(doc({ ...base(), role: { kind: "dance", params: {} } }), netem)).toThrow(/role.kind/)
  })
  it("rejects stray, missing and mistyped role params, naming them", () => {
    const withRole = (kind: string, params: unknown) => doc({ ...base(), role: { kind, params } })
    expect(() => validateProfiles(withRole("baseline", { changeVerdict: true }), netem)).toThrow(/no param changeVerdict/)
    expect(() => validateProfiles(withRole("late-join", {}), netem)).toThrow(/needs joinAfterTurn/)
    expect(() => validateProfiles(withRole("late-join", { joinAfterTurn: "2" }), netem)).toThrow(/expected number/)
    expect(() => validateProfiles(withRole("late-join", { joinAfterTurn: 0 }), netem)).toThrow(/whole number from 1/)
    expect(validateProfiles(withRole("video-return", { joinAfterTurn: 2, enableAtTurn: 4, disableAtTurn: 7 }), netem)).toHaveLength(1)
    expect(() => validateProfiles(withRole("video-return", { joinAfterTurn: 2, enableAtTurn: "4" }), netem)).toThrow(/expected number/)
    expect(() => validateProfiles(withRole("kill-relaunch", { killInRound: 2, backgroundFromGameEndS: 10 }), netem)).toThrow(/go together/)
    expect(() => validateProfiles(withRole("kill-relaunch", { killInRound: 2, backgroundFromGameEndS: 20, backgroundUntilGameEndS: 10 }), netem)).toThrow(/ends before it starts/)
    expect(() => validateProfiles(withRole("stale-build", { versionFixture: "nope" }), netem)).toThrow(/role.kind/)
    expect(validateProfiles(withRole("baseline", { changeVerdictThenConfirm: true }), netem)).toHaveLength(1)
  })
  it("rejects unsafe env and malformed fixture data", () => {
    const one = (extra: Record<string, unknown>) => doc({ ...base(), ...extra })
    expect(() => validateProfiles(one({ env: { PATH: "/tmp" } }), netem)).toThrow(/env.PATH.*NEXT_PUBLIC_/)
    expect(() => validateProfiles(one({ env: { NEXT_PUBLIC_X: 1 } }), netem)).toThrow(/env.NEXT_PUBLIC_X.*string/)
    expect(() => validateProfiles(one({ env: { NEXT_PUBLIC_X: "{{fixture.url}}" } }), netem)).toThrow(/fixture.url.*fixture/)
    expect(() => validateProfiles(one({ fixture: { path: "dim2.json", body: {} } }), netem)).toThrow(/fixture.path.*start with/)
    expect(() => validateProfiles(one({ fixture: { path: "/../secret", body: {} } }), netem)).toThrow(/fixture.path/)
    expect(() => validateProfiles(one({ fixture: { path: "/ok.json", body: {}, extra: true } }), netem)).toThrow(/fixture.*no field extra/)
  })
  it("a pending profile carries its reason", () => {
    expect(() => validateProfiles(doc({ ...base(), pending: "" }), netem)).toThrow(/pending/)
    expect(validateProfiles(doc({ ...base(), pending: "needs X" }), netem)[0].pending).toBe("needs X")
  })
  it("validates the device fields: zone, locale, camera mode, clock jumps", () => {
    const one = (extra: Record<string, unknown>) => doc({ ...base(), ...extra })
    expect(() => validateProfiles(one({ timezoneId: "Mars/Olympus" }), netem)).toThrow(/not an IANA time zone/)
    expect(() => validateProfiles(one({ camera: { delayMs: 0, resolution: "360p", mode: "broken" } }), netem)).toThrow(/camera.mode/)
    expect(() => validateProfiles(one({ clockJumps: [{ atTurn: 0, offsetS: 5 }] }), netem)).toThrow(/atTurn/)
    expect(validateProfiles(one({ timezoneId: "Asia/Tokyo", locale: "ja-JP", clockJumps: [{ atTurn: 3, offsetS: -30 }] }), netem)[0].timezoneId).toBe("Asia/Tokyo")
  })
  it("allows a camera-unavailable expected outcome only for its matching camera mode", () => {
    const one = (extra: Record<string, unknown>) => doc({ ...base(), ...extra })
    expect(validateProfiles(one({ camera: { delayMs: 0, resolution: "720p", mode: "denied" }, expectedOutcome: { kind: "camera-unavailable", reason: "denied" } }), netem)[0].expectedOutcome).toEqual({ kind: "camera-unavailable", reason: "denied" })
    expect(validateProfiles(one({ camera: { delayMs: 0, resolution: "720p", mode: "missing" }, expectedOutcome: { kind: "camera-unavailable", reason: "no-camera" } }), netem)[0].expectedOutcome).toEqual({ kind: "camera-unavailable", reason: "no-camera" })
    expect(() => validateProfiles(one({ expectedOutcome: { kind: "camera-unavailable", reason: "denied" } }), netem)).toThrow(/expectedOutcome.*camera.mode/)
    expect(() => validateProfiles(one({ camera: { delayMs: 0, resolution: "720p", mode: "denied" }, expectedOutcome: { kind: "camera-unavailable", reason: "no-camera" } }), netem)).toThrow(/expectedOutcome.reason/)
    expect(() => validateProfiles(one({ camera: { delayMs: 0, resolution: "720p", mode: "denied" }, expectedOutcome: { kind: "camera-unavailable", reason: "denied", skip: true } }), netem)).toThrow(/expectedOutcome.*field skip/)
  })
  it("validates a network timeline", () => {
    const tl = (timeline: unknown) => doc({ ...base(), network: { profile: "wifi", relayOnly: false, timeline } })
    expect(() => validateProfiles(tl([{ profile: "wifi" }]), netem)).toThrow(/exactly one of atTurn, atS, atBeforeGameS, atRoundChannelsOpen, atOpen, atSignUp and atConfirm/)
    expect(() => validateProfiles(tl([{ atTurn: 2, atS: 5, profile: "wifi" }]), netem)).toThrow(/exactly one/)
    expect(() => validateProfiles(tl([{ atTurn: 2 }]), netem)).toThrow(/must change something/)
    expect(() => validateProfiles(tl([{ atTurn: 2, lossPct: 130 }]), netem)).toThrow(/0-100/)
    expect(() => validateProfiles(tl([{ atTurn: 2, profile: "5g" }]), netem)).toThrow(/unknown network profile/)
    expect(() => validateProfiles(tl([{ atTurn: 2, speed: 1 }]), netem)).toThrow(/no field speed/)
    expect(() => validateProfiles(tl([{ atTurn: 2, outage: "people-rpc" }]), netem)).toThrow(/needs forS/)
    expect(validateProfiles(tl([{ atRoundChannelsOpen: { round: 1, count: 5, byGameS: 30 }, profile: "game259-negotiation-burst", forS: 15, restoreProfile: "game259-lossy" }]), netem)[0].network.timeline).toEqual([
      { atRoundChannelsOpen: { round: 1, count: 5, byGameS: 30 }, profile: "game259-negotiation-burst", forS: 15, restoreProfile: "game259-lossy" },
    ])
    expect(() => validateProfiles(tl([{ atRoundChannelsOpen: { round: 1, count: 0, byGameS: 30 }, profile: "wifi" }]), netem)).toThrow(/count.*>= 1/)
    expect(() => validateProfiles(tl([{ atRoundChannelsOpen: { round: 1, count: 5 }, profile: "wifi" }]), netem)).toThrow(/byGameS/)
    expect(() => validateProfiles(tl([{ atRoundChannelsOpen: { round: 1, count: 5, byGameS: 30, extra: true }, profile: "wifi" }]), netem)).toThrow(/no field extra/)
    expect(() => validateProfiles(tl([{ atRoundChannelsOpen: { round: 1, count: 5, byGameS: 30 }, profile: "wifi", restoreProfile: "game259-lossy" }]), netem)).toThrow(/restoreProfile needs.*forS/)
    expect(validateProfiles(tl([{ atTurn: 4, lossPct: 30, forS: 10 }, { atS: 100, profile: "lte-good", blackoutS: 3 }]), netem)[0].network.timeline).toHaveLength(2)
    expect(() => validateProfiles(tl([{ atOpen: true, atTurn: 2, outage: "turn-issuer", forS: 20 }]), netem)).toThrow(/exactly one/)
    expect(() => validateProfiles(tl([{ atOpen: false, outage: "turn-issuer", forS: 20 }]), netem)).toThrow(/must be true/)
    expect(validateProfiles(tl([{ atOpen: true, outage: "turn-issuer", forS: 20 }]), netem)[0].network.timeline).toEqual([{ atOpen: true, outage: "turn-issuer", forS: 20 }])
  })
  it("validates the WebRTC path cut and the video stall as timeline changes of their own", () => {
    const tl = (timeline: unknown) => doc({ ...base(), network: { profile: "wifi", relayOnly: false, timeline } })
    expect(validateProfiles(tl([{ atTurn: 4, udpCutS: 40 }]), netem)[0].network.timeline).toEqual([{ atTurn: 4, udpCutS: 40 }])
    expect(validateProfiles(tl([{ atTurn: 4, videoStallS: 30 }]), netem)[0].network.timeline).toEqual([{ atTurn: 4, videoStallS: 30 }])
    expect(() => validateProfiles(tl([{ atTurn: 4, udpCutS: 0 }]), netem)).toThrow(/udpCutS.*>= 1/)
    expect(() => validateProfiles(tl([{ atTurn: 4, videoStallS: "30" }]), netem)).toThrow(/videoStallS/)
  })
  it("validates a devlog guard", () => {
    expect(validateGuard("g", { kind: "devlog", tag: "rtc", match: "media-stall:", max: 15 })).toEqual({ kind: "devlog", tag: "rtc", match: "media-stall:", max: 15 })
    expect(validateGuard("g", { kind: "devlog", match: "round-link", fields: { round: "1" }, has: ["peer"] })).toEqual({ kind: "devlog", match: "round-link", fields: { round: "1" }, has: ["peer"] })
    expect(() => validateGuard("g", { kind: "devlog", match: "round-link", fields: { round: 1 } })).toThrow(/g.fields.round/)
    expect(() => validateGuard("g", { kind: "devlog", match: "round-link", has: "peer" })).toThrow(/g.has/)
    expect(() => validateGuard("g", { kind: "devlog" })).toThrow(/g.match/)
    expect(() => validateGuard("g", { kind: "devlog", match: "x", name: "y" })).toThrow(/has no field name/)
    expect(describeGuard({ kind: "devlog", tag: "rtc", match: "self-heal" })).toBe('devLog [rtc] line containing "self-heal" at least once')
    expect(describeGuard({ kind: "devlog", match: "peer away", max: 0 })).toBe('devLog line containing "peer away" never')
  })
  it("validates the fast late-join proof guard", () => {
    const guard = { kind: "late-join-proof", round: 1, maxFirstVideoMs: 8000 } as const
    expect(validateGuard("g", guard)).toEqual(guard)
    expect(describeGuard(guard)).toContain("never taps or seals before clock ready")
    expect(() => validateGuard("g", { ...guard, round: 1.5 })).toThrow(/integer/)
    expect(() => validateGuard("g", { ...guard, maxFirstVideoMs: 0 })).toThrow(/maxFirstVideoMs/)
  })
  it("validates the video-back-after-reload guard", () => {
    const guard = { kind: "reload-video-back", maxVideoBackMs: 45000 } as const
    expect(validateGuard("g", guard)).toEqual(guard)
    expect(describeGuard(guard)).toBe("after the reload, every co-player seen before it (and not gone) sends video again within 45000 ms of the new page booting")
    expect(() => validateGuard("g", { ...guard, maxVideoBackMs: 0 })).toThrow(/maxVideoBackMs/)
    expect(() => validateGuard("g", { ...guard, round: 1 })).toThrow(/no field round/)
  })
  it("rejects unknown guard kinds, stray fields and bad params, naming the path", () => {
    expect(() => validateGuard("g", { kind: "vibes" })).toThrow(/unknown value "vibes"/)
    expect(() => validateGuard("g", { kind: "metric", name: "x", equals: 1 })).toThrow(/no field equals/)
    expect(() => validateGuard("g", { kind: "metric", name: "x", max: "9" })).toThrow(/g.max/)
    expect(() => validateGuard("g", { kind: "metric", name: "x", min: 5, max: 1 })).toThrow(/min is above max/)
    expect(() => validateGuard("g", { kind: "metric", name: "x", attrs: { via: true } })).toThrow(/attributes are strings: write "true"/)
    expect(() => validateGuard("g", { kind: "metric", name: "x", maxBlocks: 0 })).toThrow(/maxBlocks/)
    expect(() => validateGuard("g", { kind: "event", name: "x", min: 0 })).toThrow(/g.min/)
    expect(() => validateGuard("g", { kind: "event", name: "x", attrs: { "rtc.healed": true } })).toThrow(/attributes are strings: write "true"/)
    expect(() => validateGuard("g", { kind: "chain-report", matchesVoteTrail: false })).toThrow(/must be true/)
    expect(() => validateGuard("g", { kind: "metric", name: "x", pending: true })).toThrow(/needs a note/)
    expect(() => validateProfiles(doc({ ...base(), expect: [{ kind: "text" }] }), netem)).toThrow(/profile baseline-iphone14-wifi.expect\[0\].text/)
  })
  it("accepts every guard kind and describes it", () => {
    const d = (g: unknown) => describeGuard(validateGuard("g", g))
    expect(d({ kind: "metric", name: "a" })).toBe("metric a is recorded")
    expect(d({ kind: "metric", name: "rtc.coverage_pct", min: 90 })).toBe("metric rtc.coverage_pct every point >= 90")
    expect(d({ kind: "metric", name: "a", min: 1, max: 2 })).toBe("metric a every point >= 1 and <= 2")
    expect(d({ kind: "metric", name: "clock.chain_gap_ms", attrs: { "clock.check": "first-value" }, maxBlocks: 1 })).toBe('metric clock.chain_gap_ms with {"clock.check":"first-value"} every point <= 1 observed chain block')
    expect(d({ kind: "event", name: "rtc.heal", attrs: { "rtc.healed": "true" }, min: 2 })).toBe('event rtc.heal with {"rtc.healed":"true"} seen >= 2 times')
    expect(d({ kind: "event", name: "a", max: 0 })).toBe("event a never seen")
    expect(d({ kind: "text", text: "hi" })).toBe('page shows "hi"')
    expect(d({ kind: "text", text: "Voting has closed", never: true })).toBe('page never shows "Voting has closed"')
    expect(d({ kind: "chain-report", matchesVoteTrail: true })).toMatch(/vote trail/)
    expect(d({ kind: "event", name: "game-log", pending: true, note: "n" })).toBe("[pending, not evaluated] event game-log seen at least once")
  })
})

describe("the reload, hidden-step and freeze roles, and the store-rejection guard", () => {
  const withRole = (kind: string, params: Record<string, unknown>) => ({ ...base(), name: "x", bot: null, role: { kind, params } })
  it("a clock step is signed and whole, never 0", () => {
    expect(() => validateProfiles(doc(withRole("hidden-step", { hideAtTurn: 5, showAtTurn: 7, stepS: -60 })), netem)).not.toThrow()
    expect(() => validateProfiles(doc(withRole("hidden-step", { hideAtTurn: 5, showAtTurn: 7, stepS: 0 })), netem)).toThrow(/stepS: a clock step/)
    expect(() => validateProfiles(doc(withRole("hidden-step", { hideAtTurn: 5, showAtTurn: 7, stepS: 1.5 })), netem)).toThrow(/stepS: a clock step/)
  })
  it("the page is shown after it is hidden", () => {
    expect(() => validateProfiles(doc(withRole("hidden-step", { hideAtTurn: 7, showAtTurn: 7, stepS: -60 })), netem)).toThrow(/showAtTurn must come after hideAtTurn/)
  })
  it("the turn knobs are counts from 1, and a stray param fails", () => {
    expect(() => validateProfiles(doc(withRole("reload", { reloadAtTurn: 0 })), netem)).toThrow(/reloadAtTurn: must be a whole number from 1/)
    expect(() => validateProfiles(doc(withRole("freeze", { freezeAtTurn: 9, freezeS: 20, monotonicStops: "yes" })), netem)).toThrow(/monotonicStops: expected boolean/)
    expect(() => validateProfiles(doc(withRole("reload", { reloadAtTurn: 6, atTurn: 6 })), netem)).toThrow(/the reload role has no param atTurn/)
  })
  it("a store-rejection guard names one node reason, with count bounds", () => {
    expect(validateGuard("g", { kind: "store-rejection", reason: "channelPriorityTooLow", max: 0 })).toEqual({ kind: "store-rejection", reason: "channelPriorityTooLow", max: 0 })
    expect(() => validateGuard("g", { kind: "store-rejection", reason: "channel priority" })).toThrow(/one camelCase word/)
    expect(() => validateGuard("g", { kind: "store-rejection", reason: "alreadyExpired", min: 0 })).toThrow(/expected a number >= 1/)
    expect(() => validateGuard("g", { kind: "store-rejection", reason: "alreadyExpired", text: "x" })).toThrow(/has no field text/)
    expect(describeGuard({ kind: "store-rejection", reason: "alreadyExpired", max: 0 })).toBe("the statement store never refuses a submit with alreadyExpired")
  })
  it("the new profiles are in the file with their identities", () => {
    for (const name of ["clock-wrong-then-corrected", "clock-ahead-then-corrected", "clock-step-while-hidden", "reload-mid-game", "visible-freeze", "relay-outage"]) expect(profileByName(name).identity).toBeTruthy()
    expect(profileByName("clock-wrong-then-corrected")).toMatchObject({ clockOffsetS: -5, clockJumps: [{ atTurn: 6, offsetS: 0 }] })
    expect(profileByName("clock-ahead-then-corrected")).toMatchObject({ clockOffsetS: 5, clockJumps: [{ atTurn: 6, offsetS: 0 }] })
  })
})

describe("identityFor", () => {
  it("a plain string is paseo-next-v2's person, with none on previewnet", () => {
    expect(identityFor({ identity: "jollityeea.09" }, "paseo-next-v2")).toBe("jollityeea.09")
    expect(identityFor({ identity: "jollityeea.09" }, "previewnet")).toBeUndefined()
  })
  it("an object maps each network to its own person", () => {
    const p = { identity: { "paseo-next-v2": "jollityeea.09", previewnet: "jollitypv.91" } }
    expect(identityFor(p, "previewnet")).toBe("jollitypv.91")
    expect(identityFor(p, "paseo-next-v2")).toBe("jollityeea.09")
    expect(identityFor({ identity: { previewnet: "jollitypv.91" } }, "paseo-next-v2")).toBeUndefined()
  })
  it("none is none", () => expect(identityFor({}, "previewnet")).toBeUndefined())
})

describe("profiles.json identity shapes", () => {
  const withIdentity = (identity: unknown) => ({ profiles: (raw as { profiles: Record<string, unknown>[] }).profiles.map((p, i) => (i === 0 ? { ...p, identity } : p)) })
  it("accepts a string and a per-network object", () => {
    expect(validateProfiles(withIdentity("jollityeea.09"))[0].identity).toBe("jollityeea.09")
    expect(validateProfiles(withIdentity({ previewnet: "jollitypv.91" }))[0].identity).toEqual({ previewnet: "jollitypv.91" })
  })
  it("refuses an unknown network, a bad username and an empty object", () => {
    for (const bad of [{ mainnet: "jollitypv.91" }, { previewnet: "nope" }, {}, 5, ["jollitypv.91"]]) expect(() => validateProfiles(withIdentity(bad))).toThrow(/identity/)
  })
})

describe("the blocked-network negative control", () => {
  // The connection screen is CORRECT for a
  // relay-only player whose relay is down, so a relay-only persona must not carry a guard
  // saying that copy means a blocked player network. Bot 16 (relay-outage) failed it on
  // a live run for exactly that reason.
  const BLOCKED = "We couldn't connect you to anyone."
  const neverGuard = (name: string): boolean =>
    profileByName(name).expect.some((g) => g.kind === "text" && g.text === BLOCKED && g.never === true)

  it("drops it from the personas whose own timeline takes the relay down", () => {
    expect(neverGuard("relay-outage")).toBe(false)
    expect(neverGuard("network-blocked")).toBe(false)
  })

  it("keeps it on relay-only personas whose relay still works", () => {
    // relay-iphonese-fastclock is relay-only, but TURN is fine: this is the guard that
    // exposed the #1397 clock bug, so dropping it would lose real evidence.
    expect(neverGuard("relay-iphonese-fastclock")).toBe(true)
    expect(neverGuard("uplink-lift-pixel6a")).toBe(true)
    expect(neverGuard("turn-cache-relaunch")).toBe(true)
    // a TURN-ISSUER outage is not a relay outage: credentials fail, then the relay works
    expect(neverGuard("turn-warm-returning")).toBe(true)
  })

  it("keeps it on the host-fault personas it was written for", () => {
    expect(neverGuard("host-crash")).toBe(true)
    expect(neverGuard("host-crash-long")).toBe(true)
  })
})
