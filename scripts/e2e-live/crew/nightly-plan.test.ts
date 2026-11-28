// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { identityFor, loadProfiles, type Profile } from "../profile"
import { allRoles } from "../profiles"
import { botMatrix } from "../timing"
import { runNightlyPlanCli } from "./nightly-plan-cli.mts"
import { invocationFor, isZurichNightlyWindow } from "./nightly-schedule"
import { buildNightlyPlan } from "./nightly-plan"

const profiles = loadProfiles()
const pool = Object.fromEntries(profiles.flatMap((profile) => {
  const identity = identityFor(profile, "previewnet")
  return identity ? [[identity, `opaque-${identity}`]] : []
}))
const plan = () => buildNightlyPlan({ suiteId: "manual-suite-run-42", profiles, identities: pool })

describe("PreviewNet complete-suite plan", () => {
  it("plans the 46 non-telemetry catalogue profiles that can run on PreviewNet exactly once in run order", () => {
    const value = plan()
    const planned = value.waves.flatMap((wave) => wave.coverageProfiles)
    expect(value).toMatchObject({ schemaVersion: 1, suiteId: "manual-suite-run-42", classification: "manual" })
    expect(planned).toHaveLength(46)
    expect(new Set(planned).size).toBe(46)
    // manual dispatch only on previewnet: the issuer shares its host with the chains, app-level fault pending (#2004)
    expect(planned).not.toContain("turn-warm-returning")
    expect(planned.slice().sort()).toEqual(profiles.filter(({ name, manualOnly, telemetryTorture }) => !manualOnly && !telemetryTorture && name !== "turn-issuer-outage").map(({ name }) => name).sort())
    expect(planned).not.toContain("issue874-fast-late-join")
    expect(value.waves[0]).toMatchObject({ key: "game-ready", profiles: allRoles(profiles, "previewnet").map(({ profile }) => profile) })
    expect(value.waves[0].profiles).toHaveLength(30)
    expect(value.waves.filter(({ bootOnly }) => !bootOnly)).toHaveLength(4)
    expect(value.waves.at(-2)).toMatchObject({ key: "check-seat-preparing", bootOnly: false })
    expect(value.waves.at(-2)).not.toHaveProperty("freshPoolCheck")
    expect(value.waves.at(-1)).toMatchObject({ key: "check-stale-build", bootOnly: true, bootProfile: "check-stale-build", app: "local", identities: [] })
  })

  it("leaves out the profiles whose outage PreviewNet can not isolate (turn-issuer-outage), and never dispatches them", () => {
    const planned = plan().waves.flatMap((wave) => [...wave.coverageProfiles, ...wave.profiles])
    expect(planned).not.toContain("turn-issuer-outage")
    expect(allRoles(profiles, "previewnet").map(({ profile }) => profile)).not.toContain("turn-issuer-outage")
    expect(allRoles(profiles, "paseo-next-v2").map(({ profile }) => profile)).not.toContain("turn-issuer-outage")
    expect(() => botMatrix('["turn-issuer-outage"]', undefined, profiles, pool, "previewnet")).toThrow(/can not be scheduled on previewnet.*outage "turn-issuer" can not run on previewnet.*chains too/)
  })

  it("sends no bot telemetry: no telemetry wave, no T1-T12 profile, no wave with telemetry on", () => {
    const value = plan()
    expect(value.waves.some(({ key }) => key.startsWith("telemetry-"))).toBe(false)
    expect(value.waves.flatMap(({ profiles }) => profiles).filter((name) => name.startsWith("telemetry-t"))).toEqual([])
    expect(value.waves.filter(({ telemetry }) => telemetry)).toEqual([])
  })

  it("fills every declared multiplayer topology with deterministic benign companions", () => {
    const value = plan()
    for (const wave of value.waves.filter(({ bootOnly }) => !bootOnly)) {
      const required = Math.max(1, ...wave.coverageProfiles.map((name) => profiles.find((profile) => profile.name === name)?.minPlayers ?? 1))
      expect(wave.profiles.length, wave.key).toBeGreaterThanOrEqual(required)
      expect(wave.profiles).toEqual([...wave.coverageProfiles, ...wave.supportProfiles])
    }
    const dropped = value.waves.find((wave) => wave.coverageProfiles.includes("game259-dropped-lane-rebuild"))!
    expect(dropped).toMatchObject({
      profiles: [
        "reload-video-back",
        "network-blocked",
        "game259-dropped-lane-rebuild",
        "baseline-iphone14-wifi",
        "locale-la-enus",
        "locale-tokyo-jajp",
      ],
      coverageProfiles: ["reload-video-back", "network-blocked", "game259-dropped-lane-rebuild"],
      supportProfiles: ["baseline-iphone14-wifi", "locale-la-enus", "locale-tokyo-jajp"],
    })
    expect(new Set(dropped.identities).size).toBe(6)
  })

  it("keeps every playable wave identity-unique and botMatrix-compatible", () => {
    for (const wave of plan().waves.filter(({ bootOnly }) => !bootOnly)) {
      expect(new Set(wave.identities).size, wave.key).toBe(wave.identities.length)
      const actual = botMatrix(wave.botsInput, undefined, profiles, pool, "previewnet", undefined, undefined, ["jollityfresh.01"])
      expect(actual.map(({ profile }) => profile), wave.key).toEqual(wave.profiles)
    }
  })

  it("colours repeated specialist identities into separate serial waves", () => {
    const fixtureIdentity = "jollityfixture.01"
    const changed = profiles.map((profile) => ({ ...profile, identity: { ...(typeof profile.identity === "object" ? profile.identity : {}) } }))
    const repeated = changed.filter(({ acceptanceOnly, telemetryTorture }) => acceptanceOnly && !telemetryTorture).slice(0, 4)
    for (const profile of repeated) (profile.identity as Record<string, string>).previewnet = fixtureIdentity
    const value = buildNightlyPlan({ suiteId: "manual-suite-run-42", profiles: changed, identities: { ...pool, [fixtureIdentity]: "opaque" } })
    const waves = repeated.map(({ name }) => value.waves.find((wave) => wave.coverageProfiles.includes(name))?.key)
    expect(new Set(waves).size).toBe(4)
  })

  it("records missing pool identities without leaking values or dropping planned coverage", () => {
    const target = profiles.find(({ acceptanceOnly, telemetryTorture }) => acceptanceOnly && !telemetryTorture)!
    const identity = identityFor(target, "previewnet")!
    const reduced = { ...pool }
    delete reduced[identity]
    const value = buildNightlyPlan({ suiteId: "manual-suite-run-42", identities: reduced })
    const wave = value.waves.find(({ coverageProfiles: names }) => names.includes(target.name))!
    expect(wave.coverageProfiles).toContain(target.name)
    expect(wave.missingProfiles).toContainEqual({ profile: target.name, identity, status: "missing (pool)" })
    expect(JSON.parse(wave.botsInput)).not.toContain(target.name)
    expect(JSON.stringify(value)).not.toContain(`opaque-${identity}`)
  })

  it("does not run benign support profiles when the multiplayer scenario itself is unavailable", () => {
    const target = profiles.find(({ name }) => name === "game259-dropped-lane-rebuild")!
    const identity = identityFor(target, "previewnet")!
    // every scenario of the target's wave is unavailable, not only the target (it shares its wave with others)
    const waveOf = (identities: Record<string, string>) =>
      buildNightlyPlan({ suiteId: "manual-suite-run-42", identities }).waves.find(({ coverageProfiles }) => coverageProfiles.includes(target.name))!
    const reduced = { ...pool }
    for (const name of waveOf(pool).coverageProfiles) delete reduced[identityFor(profiles.find((profile) => profile.name === name)!, "previewnet")!]
    const wave = waveOf(reduced)
    expect(wave.missingProfiles).toContainEqual({ profile: target.name, identity, status: "missing (pool)" })
    expect(wave.supportProfiles).toEqual([])
    expect(JSON.parse(wave.botsInput)).toEqual([])
  })

  it("fails instead of silently reducing a pending or structurally unrunnable catalogue", () => {
    const pending = profiles.map((profile) => ({ ...profile }))
    pending.find(({ acceptanceOnly }) => acceptanceOnly)!.pending = "not ready"
    expect(() => buildNightlyPlan({ suiteId: "manual-suite-run-42", profiles: pending, identities: pool })).toThrow(/pending.*not ready/)
    const unrunnable = profiles.map((profile) => ({ ...profile, identity: { ...(typeof profile.identity === "object" ? profile.identity : {}) } }))
    const target = unrunnable.find(({ acceptanceOnly }) => acceptanceOnly) as Profile
    delete (target.identity as Record<string, string>).previewnet
    expect(() => buildNightlyPlan({ suiteId: "manual-suite-run-42", profiles: unrunnable, identities: pool })).toThrow(/identity/)
  })

  it("keeps deliberately assembled proofs available only to explicit dispatch", () => {
    const manual = profiles.find(({ name }) => name === "issue874-fast-late-join")!
    expect(manual).toMatchObject({ acceptanceOnly: true, manualOnly: true })
    expect(plan().waves.flatMap(({ coverageProfiles }) => coverageProfiles)).not.toContain(manual.name)
    expect(botMatrix(JSON.stringify([manual.name]), undefined, profiles, pool, "previewnet")).toHaveLength(1)
  })
})

describe("manual and scheduled plan CLI", () => {
  const run = (fresh: string[], event = "workflow_dispatch", now = new Date("2026-10-19T10:00:00.000Z")) => {
    const directory = mkdtempSync(join(tmpdir(), "crew-plan-"))
    const output = join(directory, "output")
    const document = join(directory, "plan.json")
    writeFileSync(output, "")
    const result = runNightlyPlanCli({
      GITHUB_EVENT_NAME: event, GITHUB_RUN_ID: "42", GITHUB_OUTPUT: output,
      E2E_IDENTITIES_PREVIEWNET: JSON.stringify({ ...pool, "jollitypv.999": "must-not-leak" }),
      E2E_UNBOUND_FRESH_USERS: JSON.stringify(fresh), E2E_FRESH_RESERVE: "1",
    }, document, now)
    return { directory, result, output: readFileSync(output, "utf8"), document: readFileSync(document, "utf8") }
  }

  it("writes secret-free serial matrices and leaves stale-build last", () => {
    const value = run(["jollityfresh.01", "jollityfresh.02"])
    try {
      expect(value.result).toEqual({ suiteId: "manual-suite-run-42", profiles: 46 })
      expect(value.document).not.toContain("must-not-leak")
      const checks = JSON.parse(/^check_matrix=(.*)$/m.exec(value.output)![1]).include as Array<{ key: string }>
      const stale = JSON.parse(/^stale_check_matrix=(.*)$/m.exec(value.output)![1]).include as Array<{ key: string }>
      expect(checks.map(({ key }) => key)).toEqual(["check-seat-preparing"])
      expect(stale.map(({ key }) => key)).toEqual(["check-stale-build"])
      expect(value.output).toContain("has_checks=true")
      expect(value.output).not.toContain("telemetry_matrix")
      expect(value.output).not.toContain("has_telemetry")
      expect(value.document).not.toContain('"telemetry": true')
    } finally { rmSync(value.directory, { recursive: true, force: true }) }
  })

  it("keeps native stale-build evidence runnable when the seat reserve is exhausted", () => {
    const value = run(["jollityfresh.01"])
    try {
      const checks = JSON.parse(/^check_matrix=(.*)$/m.exec(value.output)![1]).include as Array<{ key: string }>
      const stale = JSON.parse(/^stale_check_matrix=(.*)$/m.exec(value.output)![1]).include as Array<{ key: string }>
      expect(checks).toEqual([])
      expect(stale.map(({ key }) => key)).toEqual(["check-stale-build"])
      expect(value.document).toContain('"profile": "check-seat-preparing"')
      expect(value.output).not.toContain("missing_pool=")
    } finally { rmSync(value.directory, { recursive: true, force: true }) }
  })

  it("classifies a scheduled suite by stable run ID and writes nightly metadata", () => {
    const value = run(["jollityfresh.01", "jollityfresh.02"], "schedule", new Date("2026-10-19T01:17:00.000Z"))
    try {
      expect(value.result).toEqual({ suiteId: "nightly-suite-run-42", profiles: 46 })
      expect(value.output).toContain("classification=nightly")
      expect(JSON.parse(value.document)).toMatchObject({ suiteId: "nightly-suite-run-42", classification: "nightly" })
    } finally { rmSync(value.directory, { recursive: true, force: true }) }
  })

  it("accepts the 03:17 schedule in both CEST and CET and rejects delayed work outside 03:00-09:00", () => {
    expect(invocationFor("schedule", 42, new Date("2026-10-19T01:17:00.000Z"))).toEqual({ suiteId: "nightly-suite-run-42", classification: "nightly" })
    expect(invocationFor("schedule", 42, new Date("2026-10-26T02:17:00.000Z"))).toEqual({ suiteId: "nightly-suite-run-42", classification: "nightly" })
    expect(isZurichNightlyWindow(new Date("2026-10-19T01:00:00.000Z"))).toBe(true)
    expect(isZurichNightlyWindow(new Date("2026-10-19T06:59:59.999Z"))).toBe(true)
    expect(isZurichNightlyWindow(new Date("2026-10-19T00:59:59.999Z"))).toBe(false)
    expect(isZurichNightlyWindow(new Date("2026-10-19T07:00:00.000Z"))).toBe(false)
    expect(() => invocationFor("schedule", 42, new Date("2026-10-19T07:00:00.000Z"))).toThrow(/outside 03:00–09:00 Europe\/Zurich/)
  })

  it("keeps manual suites manual and rejects unsupported callers", () => {
    expect(invocationFor("workflow_dispatch", 42, new Date("2026-10-19T01:17:00.000Z"))).toEqual({ suiteId: "manual-suite-run-42", classification: "manual" })
    expect(() => invocationFor("pull_request", 42, new Date("2026-10-19T01:17:00.000Z"))).toThrow(/unsupported/)
  })

})
