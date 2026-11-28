// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { identityFor, loadProfiles } from "./profile"
import { profileIsolationGap } from "./network"
import { USERNAME_RE } from "./players"
import { botMatrix, CI_SETUP_S, coldSuiteCandidateMinLeftS, MIN_WINDOW_S, planTiming, reportEndsFor, SETTLE_MARGIN_S, SIGNUP_SLACK_S } from "./timing"

// a game 60 min out: registration opens at +3300, closes at +3480 (180 s), plays
// at +3600 (shuffle 90 + margin 30), reports end 180 s later.
const NOW = 1_000_000
const game = (o: Partial<Parameters<typeof planTiming>[0]> = {}) => ({
  chainNow: NOW,
  registrationStart: NOW + 3300,
  registrationEnds: NOW + 3480,
  reportEnds: NOW + 3780,
  ...o,
})

describe("planTiming", () => {
  it("starts the runners just in time and sizes the job from that start", () => {
    const p = planTiming(game())
    // runners due 360 s before the window opens: chain +2940
    expect(p).toMatchObject({ ok: true, leadS: 3300 - CI_SETUP_S, firstTapAt: NOW + 3300 })
    if (p.ok) expect(p.jobMinutes).toBe(Math.ceil((3780 - (3300 - CI_SETUP_S) + SETTLE_MARGIN_S) / 60))
  })
  it("dispatches late: runners start CI_SETUP_S before the tap, SIGNUP_SLACK_S before registration closes (#338)", () => {
    // game at T = NOW + 3600: registration opens T-26 min, closes T-150 s, reports end T+180 s
    const T = NOW + 3600
    const p = planTiming(game({ registrationStart: T - 1560, registrationEnds: T - 150, reportEnds: T + 180 }))
    const leadS = T - 150 - SIGNUP_SLACK_S - CI_SETUP_S - NOW
    // runners start at about T-12.5 min
    expect(leadS).toBe(T - 750 - NOW)
    expect(p).toMatchObject({ ok: true, leadS, firstTapAt: T - 150 - SIGNUP_SLACK_S, windowLeftS: SIGNUP_SLACK_S })
    if (p.ok) {
      const jobMinutes = Math.ceil((T + 180 - (NOW + leadS) + SETTLE_MARGIN_S) / 60)
      expect(p.jobMinutes).toBe(jobMinutes)
      // shrinks against the old start (window opening - CI_SETUP_S)
      expect(jobMinutes).toBeLessThan(Math.ceil((T + 180 - (T - 1560 - CI_SETUP_S) + SETTLE_MARGIN_S) / 60))
    }
  })
  it("a window closing soon starts the runners now", () => {
    const p = planTiming(game({ registrationStart: NOW - 10, registrationEnds: NOW + 500, reportEnds: NOW + 1200 }))
    expect(p).toMatchObject({ ok: true, leadS: 0 })
    if (p.ok) expect(p.jobMinutes).toBe(Math.ceil((1200 + SETTLE_MARGIN_S) / 60))
  })
  it("taps when CI is ready if the window is already open", () => {
    const p = planTiming(game({ registrationStart: NOW - 10, registrationEnds: NOW + 500, reportEnds: NOW + 800 }))
    expect(p).toMatchObject({ ok: true, firstTapAt: NOW + CI_SETUP_S, windowLeftS: 500 - CI_SETUP_S })
  })
  it("fails early when CI cannot tap before registration closes", () => {
    const p = planTiming(game({ registrationStart: NOW - 10, registrationEnds: NOW + 200, reportEnds: NOW + 500 }))
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reason).toMatch(/CI cannot sign up in time.*6\.0 min/)
  })
  it("fails when the window leaves less than the minimum after the first tap", () => {
    expect(planTiming(game({ registrationStart: NOW, registrationEnds: NOW + CI_SETUP_S + 29, reportEnds: NOW + 900 })).ok).toBe(false)
    expect(planTiming(game({ registrationStart: NOW, registrationEnds: NOW + CI_SETUP_S + 30, reportEnds: NOW + 900 })).ok).toBe(true)
  })
  it("refuses an idle probe beyond its cap", () => {
    const p = planTiming(game({ registrationStart: NOW + 21000, registrationEnds: NOW + 21180, reportEnds: NOW + 21400 }))
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.reason).toMatch(/cap/)
  })
  it("rejects missing or inconsistent times", () => {
    expect(planTiming(game({ reportEnds: Number.NaN })).ok).toBe(false)
    expect(planTiming(game({ reportEnds: NOW + 100 })).ok).toBe(false)
  })
})

describe("cold-suite pre-game deadline", () => {
  const previewPhases = { shuffle: 60, postShuffleMargin: 30 }

  it("keeps the ordinary cold-start floor when no profile acts before the game", () => {
    expect(coldSuiteCandidateMinLeftS([null], previewPhases)).toBe(CI_SETUP_S + MIN_WINDOW_S)
  })

  it("leaves enough registration time for the earliest T-300 action", () => {
    const profile = loadProfiles().find(({ name }) => name === "host-stuck-waiting")!
    expect(coldSuiteCandidateMinLeftS([profile], previewPhases)).toBe(600)
  })
})

const POOL = {
  "jollityeea.09": "5A",
  "jollityeeb.29": "5B",
  "jollityeec.81": "5C",
  "jollityeed.41": "5D",
  "jollityeee.05": "5E",
  "jollityeef.81": "5F",
  "chaos.1": "5X",
}
// profiles.json still names paseo-next-v2 identities (a plain string), so these run on paseo; previewnet is covered below
const matrix = (raw: string | undefined, pool: Record<string, string> = POOL, rotationRun?: number) => botMatrix(raw, undefined, undefined, pool, "paseo-next-v2", rotationRun)

describe("botMatrix", () => {
  it("defaults to three baseline bots counting from one, each on its slot's identity", () => {
    expect(matrix(undefined)).toEqual([
      { bot: 1, profile: "baseline", identity: "jollityeea.09", secret: "JOLLITYEEA_09" },
      { bot: 2, profile: "baseline", identity: "jollityeeb.29", secret: "JOLLITYEEB_29" },
      { bot: 3, profile: "baseline", identity: "jollityeec.81", secret: "JOLLITYEEC_81" },
    ])
    expect(matrix("")).toHaveLength(3)
    expect(matrix("6").map((e) => e.bot)).toEqual([1, 2, 3, 4, 5, 6])
  })
  it("takes a JSON list of (bot, profile) pairs; the identity comes from the profile", () => {
    expect(matrix('[{"bot":1},{"bot":2,"profile":"slow-pixel7-lte-poor"}]')).toEqual([
      { bot: 1, profile: "baseline", identity: "jollityeea.09", secret: "JOLLITYEEA_09" },
      { bot: 2, profile: "slow-pixel7-lte-poor", identity: "jollityeeb.29", secret: "JOLLITYEEB_29" },
    ])
  })
  it("takes a list of profile names: the slot index is the position, the identity the profile's", () => {
    const m = matrix('["late-join-galaxya55-lte-good","baseline-iphone14-wifi"]')
    expect(m.map((e) => [e.bot, e.profile, e.identity])).toEqual([
      [1, "late-join-galaxya55-lte-good", "jollityeef.81"],
      [2, "baseline-iphone14-wifi", "jollityeea.09"],
    ])
    expect(matrix('[{"profile":"baseline-iphone14-wifi"}]')[0].bot).toBe(1)
  })
  it("materializes the bounded video-role proof as six distinct per-slot identities", () => {
    const profiles = loadProfiles()
    const pool = Object.fromEntries(
      profiles.flatMap((profile) => {
        const identity = identityFor(profile, "paseo-next-v2")
        return identity ? [[identity, `account-${identity}`]] : []
      }),
    )
    const proof = botMatrix("video-role-proof", undefined, profiles, pool, "paseo-next-v2")
    expect(proof.map(({ profile }) => profile)).toEqual([
      "reload-mid-game",
      "video-role-late-flip",
      "video-role-late-never",
      "baseline",
      "baseline",
      "baseline",
    ])
    expect(new Set(proof.map(({ identity }) => identity)).size).toBe(6)
  })
  it("rejects nonsense, duplicates and unknown profiles", () => {
    for (const bad of ["0", "x", "[]", '[{"bot":0}]', '[{"bot":1},{"bot":1}]', '[{"bot":1,"profile":"nope"}]']) expect(() => matrix(bad)).toThrow()
    expect(() => matrix('[{"bot":1,"profile":"nope"}]')).toThrow(/not a known profile/)
    expect(() => matrix("1:baseline")).toThrow(/not a count/)
  })
})

describe("botMatrix identities", () => {
  it("refuses an identity that is not in the pool, naming the profile and the fix", () => {
    const rest = Object.fromEntries(Object.entries(POOL).filter(([u]) => u !== "jollityeea.09"))
    expect(() => matrix('["baseline-iphone14-wifi"]', rest)).toThrow(/profile baseline-iphone14-wifi plays as jollityeea\.09.*not in E2E_IDENTITIES/)
    expect(() => matrix("1", rest)).toThrow(/not in E2E_IDENTITIES/)
  })
  it("refuses one identity twice in one run (two sessions of one account break every peer's link)", () => {
    expect(() => matrix('["baseline-iphone14-wifi","baseline-iphone14-wifi"]')).toThrow(/jollityeea\.09 appears twice/)
    // the slot owner of bot 1 is jollityeea.09, the same person as the named profile
    expect(() => matrix('[{"bot":1},{"bot":2,"profile":"baseline-iphone14-wifi"}]')).toThrow(/jollityeea\.09 appears twice/)
  })
  it("a baseline with no slot owner has no identity", () => {
    expect(() => matrix('[{"bot":7}]')).toThrow(/bot 7.*no identity/)
  })
  it("a profile without an identity can not be scheduled by name", () => {
    const profiles = loadProfiles().map((p) => (p.name === "slow-pixel7-lte-poor" ? { ...p, identity: undefined } : p))
    expect(() => botMatrix('["slow-pixel7-lte-poor"]', undefined, profiles, POOL, "paseo-next-v2")).toThrow(/profile slow-pixel7-lte-poor has no identity/)
  })
  it("fails without a pool at all", () => {
    expect(() => botMatrix("3", undefined, undefined, {}, "paseo-next-v2")).toThrow(/E2E_IDENTITIES/)
  })
  it("a pool identity can be added with a profile alone (add a test = add a profile + an identity)", () => {
    const profiles = [...loadProfiles(), { ...loadProfiles()[0], name: "chaos-test", bot: null, identity: "chaos.1" }]
    const m = botMatrix('["chaos-test"]', ["baseline", ...profiles.map((p) => p.name)], profiles, POOL, "paseo-next-v2")
    expect(m).toEqual([{ bot: 1, profile: "chaos-test", identity: "chaos.1", secret: "CHAOS_1" }])
  })
})

describe("botMatrix per network", () => {
  const PV_POOL = { "jollitypv.23": "5PV33", "jollitypv.34": "5PV34" }
  /** the real profiles with their previewnet identities removed: one paseo person each, as before previewnet */
  const paseoOnly = () => loadProfiles().map((p) => (p.identity && typeof p.identity === "object" ? { ...p, identity: p.identity["paseo-next-v2"] } : p))
  const withPv = () => paseoOnly().map((p) => (p.name === "baseline-iphone14-wifi" ? { ...p, identity: { "paseo-next-v2": "jollityeea.09", previewnet: "jollitypv.23" } } : p))
  it("an object identity picks the network's person and its secret", () => {
    const profiles = withPv()
    expect(botMatrix('["baseline-iphone14-wifi"]', undefined, profiles, PV_POOL, "previewnet")).toEqual([{ bot: 1, profile: "baseline-iphone14-wifi", identity: "jollitypv.23", secret: "JOLLITYPV_23" }])
    expect(botMatrix('["baseline-iphone14-wifi"]', undefined, profiles, POOL, "paseo-next-v2")[0].identity).toBe("jollityeea.09")
  })
  it("a profile with only a paseo identity has none on previewnet, and the error says which network and pool", () => {
    expect(() => botMatrix('["slow-pixel7-lte-poor"]', undefined, paseoOnly(), PV_POOL, "previewnet")).toThrow(/profile slow-pixel7-lte-poor has no identity on previewnet.*"previewnet"/)
  })
  it("a previewnet identity missing from the pool names E2E_IDENTITIES_PREVIEWNET", () => {
    expect(() => botMatrix('["baseline-iphone14-wifi"]', undefined, withPv(), { "jollitypv.99": "5" }, "previewnet")).toThrow(/jollitypv\.23.*not in E2E_IDENTITIES_PREVIEWNET/)
  })
  it("all keeps only the profiles that have an identity on the network", () => {
    const m = botMatrix("all", undefined, withPv(), PV_POOL, "previewnet")
    expect(m.map((e) => e.profile)).toEqual(["baseline-iphone14-wifi"])
  })
})

describe("botMatrix profiles", () => {
  it("six-roles reads the bot field of profiles.json", () => {
    const m = matrix("six-roles")
    expect(m.map((e) => e.bot)).toEqual([1, 2, 3, 4, 5, 6])
    expect(m[0].profile).toBe("baseline-iphone14-wifi")
    expect(m[5].profile).toBe("late-join-galaxya55-lte-good")
    expect(m[5].identity).toBe("jollityeef.81")
  })
  it("core is six-roles; all adds every runnable profile with an identity, never a check-* or a pending one", () => {
    expect(matrix("core")).toEqual(matrix("six-roles"))
    const profiles = [
      ...loadProfiles(),
      { ...loadProfiles()[0], name: "chaos-a", bot: null, identity: "chaos.1" },
      { ...loadProfiles()[0], name: "chaos-pending", bot: null, identity: "chaos.2", pending: "not yet" },
      { ...loadProfiles()[0], name: "chaos-noid", bot: null, identity: undefined },
      { ...loadProfiles()[0], name: "check-thing", bot: null, identity: "chaos.3" },
    ]
    // every identity profiles.json names is in the pool, as the repo variable E2E_IDENTITIES has it
    const paseoId = (p: (typeof profiles)[number]) => (typeof p.identity === "object" && p.identity ? p.identity["paseo-next-v2"] : p.identity)
    const pool = { ...POOL, ...Object.fromEntries(profiles.flatMap((p) => (paseoId(p) ? [[paseoId(p) as string, "5Z"]] : []))), "chaos.2": "5", "chaos.3": "5" }
    const m = botMatrix("all", ["baseline", ...profiles.map((p) => p.name)], profiles, pool, "paseo-next-v2")
    expect(m.map((e) => e.bot)).toEqual(m.map((_, i) => i + 1))
    expect(m.slice(0, 6).map((e) => e.profile)).toEqual(matrix("core").map((e) => e.profile))
    expect(m.map((e) => e.profile)).toContain("chaos-a")
    for (const bad of ["chaos-pending", "chaos-noid", "check-thing", "check-seat-preparing"]) expect(m.map((e) => e.profile)).not.toContain(bad)
    expect(new Set(m.map((e) => e.identity)).size).toBe(m.length)
  })
  it("rotate uses the dispatched-run half while all, core, counts and JSON remain exact", () => {
    const profiles = loadProfiles()
    const paseoId = (p: (typeof profiles)[number]) => (typeof p.identity === "object" && p.identity ? p.identity["paseo-next-v2"] : p.identity)
    const pool = Object.fromEntries(profiles.flatMap((p) => (paseoId(p) ? [[paseoId(p) as string, "5Z"]] : [])))
    const all = matrix("all", pool)
    const a = matrix("rotate", pool, 101)
    const b = matrix("rotate", pool, 102)

    expect(a.map((entry) => entry.bot)).toEqual(a.map((_, index) => index + 1))
    expect(b.map((entry) => entry.bot)).toEqual(b.map((_, index) => index + 1))
    expect(new Set([...a, ...b].map((entry) => entry.profile))).toEqual(new Set(all.map((entry) => entry.profile)))
    expect(matrix("core", pool)).toEqual(matrix("six-roles", pool))
    expect(matrix("3", pool)).toHaveLength(3)
    expect(matrix('["reload-mid-game"]', pool)).toHaveLength(1)
    expect(() => matrix("rotate", pool)).toThrow(/run.*number/)
  })
  it("every runnable profile with an identity can be scheduled; a pending one is refused with its reason", () => {
    for (const p of loadProfiles()) {
      const id = identityFor(p, "paseo-next-v2")
      const pool = { ...POOL, ...(id ? { [id]: "5Z" } : {}) }
      const list = JSON.stringify([p.name])
      if (p.pending) expect(() => matrix(list, pool)).toThrow(/pending and can not be scheduled: /)
      else if (p.fixture) expect(() => matrix(list, pool)).toThrow(/needs next dev: dispatch it with boot_only, app=local and boot_profile=/)
      else if (p.freshIdentity) expect(() => matrix(list, pool)).toThrow(/needs a fresh lite person/)
      else if (id) expect(matrix(list, pool)).toHaveLength(1)
      else expect(() => matrix(list, pool)).toThrow(/has no identity/)
    }
  })
})

describe("reportEndsFor", () => {
  it("takes the latest of the pallet's, the reporting phase and the turn floor", () => {
    expect(reportEndsFor({ gameAt: 1000, reportEnds: 1500 }, { reporting: 180 })).toBe(1500)
    expect(reportEndsFor({ gameAt: 1000, reportEnds: 1100 }, { reporting: 180 })).toBe(1180)
    // 2 rounds x 6 seats x 12 s + 60 s = 204 s after play time
    expect(reportEndsFor({ gameAt: 1000, reportEnds: 1100, rounds: 2, maxGroupSize: 6 }, { reporting: 120 })).toBe(1204)
  })
  it("works for a scheduled game the pallet has no report_ends for", () => {
    expect(reportEndsFor({ gameAt: 1000 }, { reporting: 180 })).toBe(1180)
  })
})

describe("profiles.json on previewnet", () => {
  it("every profile with a paseo person also has a distinct previewnet person, so all plays on both networks", () => {
    const profiles = loadProfiles()
    const withId = profiles.filter((p) => p.identity && !p.acceptanceOnly)
    const pv = withId.map((p) => (typeof p.identity === "object" ? p.identity.previewnet : undefined))
    // a previewnet-only persona (host-chain-lost) has no paseo person yet: only the ones that do are held to both
    const paseo = withId.map((p) => (typeof p.identity === "object" ? p.identity["paseo-next-v2"] : p.identity))
    const both = paseo.flatMap((u) => (u === undefined ? [] : [u]))
    expect(pv.every((u) => typeof u === "string" && USERNAME_RE.test(u))).toBe(true)
    expect(both.every((u) => USERNAME_RE.test(u))).toBe(true)
    expect(new Set(pv).size).toBe(pv.length)
    expect(new Set(both).size).toBe(both.length)
    expect(pv.every((u, index) => u !== paseo[index])).toBe(true)
    expect(pv).not.toContain("jollitypv.91") // the previewnet boot identity, never a bot
    const acceptance = profiles.filter((profile) => profile.acceptanceOnly)
    expect(acceptance.map((profile) => profile.name).sort()).toEqual([
      "camera-mute-loop",
      "game259-clean-video-control",
      "game259-dropped-lane-rebuild",
      "game259-lossy-video",
      "glare-forcer",
      "host-restart-classified",
      "host-stuck-in-game",
      "host-stuck-waiting",
      "issue874-fast-late-join",
      "late-signal",
      "network-blocked",
      "one-way-video",
      "reload-clean-close",
      "reload-video-back",
      "telemetry-t1-baseline",
      "telemetry-t10-big-log",
      "telemetry-t11-no-localstorage",
      "telemetry-t12-reload-dedupe",
      "telemetry-t2-host-storage-hang",
      "telemetry-t3-ios-fetch-gate",
      "telemetry-t4-kill-while-stuck",
      "telemetry-t5-stuck-first-reopen",
      "telemetry-t6-freeze-after-report",
      "telemetry-t7-sentry-block",
      "telemetry-t8-sentry-429",
      "telemetry-t9-blackout",
      "turn-cache-relaunch",
      "turn-warm-returning",
      "uplink-lift-pixel6a",
      "dropped-answer",
    ].sort())
    const identities = new Map(profiles.map((profile) => [profile.name, profile.identity]))
    expect(identities.get("uplink-lift-pixel6a")).toEqual(identities.get("uplink-limited-pixel6a"))
    expect(identities.get("turn-warm-returning")).toEqual({ previewnet: (identities.get("relay-iphonese-fastclock") as { previewnet: string }).previewnet })
    expect(identities.get("network-blocked")).toEqual({ previewnet: (identities.get("switcher-pixel6a-wifi-to-cell") as { previewnet: string }).previewnet })
    expect(identities.get("host-stuck-waiting")).toEqual(identities.get("turn-warm-returning"))
    expect(identities.get("host-stuck-in-game")).toEqual(identities.get("network-blocked"))
    expect(identities.get("issue874-fast-late-join")).toEqual(identities.get("late-join-turn-5"))
  })

  it("keeps every shared-identity acceptance pair out of one run", () => {
    const profiles = loadProfiles()
    const previewnetPool = Object.fromEntries(
      profiles.flatMap((profile) => {
        const identity = identityFor(profile, "previewnet")
        return identity ? [[identity, `account-${identity}`]] : []
      }),
    )
    // a profile PreviewNet can not isolate is refused outright (network.test.ts, nightly-plan.test.ts), so it has no pair to test
    for (const acceptance of profiles.filter((profile) => profile.acceptanceOnly && !profileIsolationGap(profile, "previewnet"))) {
      const identity = identityFor(acceptance, "previewnet")
      const owners = profiles.filter((profile) => profile.name !== acceptance.name && !profileIsolationGap(profile, "previewnet") && identityFor(profile, "previewnet") === identity)
      expect(owners.length, `${acceptance.name} must share a previewnet identity`).toBeGreaterThan(0)
      for (const owner of owners) {
        const pair = JSON.stringify([acceptance.name, owner.name])
        expect(() => botMatrix(pair, undefined, profiles, previewnetPool, "previewnet")).toThrow(new RegExp(`${identity?.replace(".", "\\.")} appears twice in one run`))
      }
    }
    expect(botMatrix('["host-stuck-waiting","host-stuck-in-game"]', undefined, profiles, previewnetPool, "previewnet").map(({ identity }) => identity)).toEqual(["jollitypv.20", "jollitypv.25"])
  })
})
