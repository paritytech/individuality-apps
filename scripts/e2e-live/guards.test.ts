// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { EXPECTED_NETWORK_ISOLATION_TEXT, SCRIPTED_WARNING_RECOVERY_MARGIN_MS, evaluateGuard, evaluateT9Guards, isExpectedT9IsolationGuard, mergeGuards, scriptedNeverTextWindows, tally, textGuardTexts, textWatchScript } from "./guards"
import { loadProfiles, profileFor } from "./profile"
import type { Guard, Profile } from "./profile"
import { checkChainVotes, type FiledReport } from "./chain-checks"
import type { VoteTrail } from "./record"
import vm from "node:vm"
import type { NetworkCallRun } from "./network"

const ok = (metrics = {}, events = {}) => ({ ok: true as const, evidence: { metrics, events } })

describe("metric and event guards", () => {
  const m: Guard = { kind: "metric", name: "rtc.signal_rtt_ms", max: 5000 }
  it("pass when every point is in bounds, fail when one is not, fail when none exist", () => {
    expect(evaluateGuard(m, { sentry: ok({ "rtc.signal_rtt_ms": [100, 4000] }) }).status).toBe("pass")
    expect(evaluateGuard(m, { sentry: ok({ "rtc.signal_rtt_ms": [100, 9000] }) }).status).toBe("fail")
    expect(evaluateGuard(m, { sentry: ok() }).status).toBe("fail")
  })
  it("without Sentry evidence: not evaluated, with the reason, never a pass", () => {
    expect(evaluateGuard(m, {}).status).toBe("not-evaluated")
    const r = evaluateGuard(m, { sentry: { ok: false, reason: "no SENTRY_AUTH_TOKEN" } })
    expect(r).toMatchObject({ status: "not-evaluated", evidence: "no SENTRY_AUTH_TOKEN" })
  })
  it("filters metric points by fixed string attributes before applying block-derived bounds", () => {
    const first: Guard = { kind: "metric", name: "clock.chain_gap_ms", attrs: { "clock.check": "first-value" }, maxBlocks: 1 }
    const src = {
      sentry: ok({ "clock.chain_gap_ms": [
        { value: 5_800, attrs: { "clock.check": "first-value" } },
        { value: 12_000, attrs: { "clock.check": "first-change" } },
      ] }),
      blockTimeMs: 6_000,
    }
    expect(evaluateGuard(first, src)).toMatchObject({ status: "pass", evidence: expect.stringContaining("1 matching of 2") })
    expect(evaluateGuard(first, { ...src, blockTimeMs: 5_000 }).status).toBe("fail")
    expect(evaluateGuard({ ...first, minPoints: 2 }, src)).toMatchObject({ status: "fail", evidence: expect.stringContaining("expected at least 2") })
  })
  it("does not pass a max-zero attribute guard when Sentry omitted the required columns", () => {
    const never: Guard = { kind: "metric", name: "failure", attrs: { "failure.kind": "unclean-exit" }, max: 0 }
    expect(evaluateGuard(never, { sentry: ok({ failure: [{ value: 1, attrs: {} }] }) })).toMatchObject({ status: "not-evaluated", evidence: expect.stringContaining("omitted required attribute") })
    expect(evaluateGuard(never, { sentry: ok({ failure: [{ value: 1, attrs: { "failure.kind": "report" } }] }) }).status).toBe("pass")
  })
  it("events match by attributes and count", () => {
    const e: Guard = { kind: "event", name: "rtc.heal", attrs: { "rtc.healed": "true" } }
    expect(evaluateGuard(e, { sentry: ok({}, { "rtc.heal": [{ "rtc.healed": "true" }] }) }).status).toBe("pass")
    expect(evaluateGuard(e, { sentry: ok({}, { "rtc.heal": [{ "rtc.healed": "false" }] }) }).status).toBe("fail")
    const never: Guard = { kind: "event", name: "rtc.peer", attrs: { "rtc.last_stage": "offer" }, max: 0 }
    expect(evaluateGuard(never, { sentry: ok() }).status).toBe("pass")
    expect(evaluateGuard(never, { sentry: ok({}, { "rtc.peer": [{ "rtc.last_stage": "offer" }] }) }).status).toBe("fail")
  })
})

describe("rolesOnly guards", () => {
  const g: Guard = { kind: "event", name: "app-open", attrs: { "previous.exit": "crash-or-kill-foreground" }, rolesOnly: true }
  it("with roles off: not evaluated, whatever the evidence says", () => {
    expect(evaluateGuard(g, { rolesOn: false, sentry: ok({}, { "app-open": [{ "previous.exit": "crash-or-kill-foreground" }] }) })).toMatchObject({ status: "not-evaluated", evidence: expect.stringMatching(/roles off/) })
  })
  it("with roles on: evaluated as any other", () => {
    expect(evaluateGuard(g, { rolesOn: true, sentry: ok({}, { "app-open": [{ "previous.exit": "crash-or-kill-foreground" }] }) }).status).toBe("pass")
  })
  it("the kill-relaunch profile requires the classified foreground kill", () => {
    expect(profileFor(5).expect).toContainEqual(expect.objectContaining(g))
  })
})

describe("default guards", () => {
  it("every profile carries the Voting-has-closed guard once, from the loader", () => {
    for (const p of loadProfiles()) expect(p.expect.filter((x) => x.kind === "text" && x.text === "Voting has closed")).toHaveLength(1)
  })
})

describe("pending guards are never evaluated", () => {
  it("stay pending even with evidence that would pass", () => {
    const g: Guard = { kind: "metric", name: "x", pending: true, note: "why" }
    expect(evaluateGuard(g, { sentry: ok({ x: [1] }) })).toMatchObject({ status: "pending", evidence: "why" })
  })
})

describe("text guards", () => {
  const never: Guard = { kind: "text", text: "Voting has closed", never: true }
  it("never: fails when it appeared at any moment, passes when it did not", () => {
    expect(evaluateGuard(never, { page: { seen: ["Voting has closed"], finalText: "" } }).status).toBe("fail")
    expect(evaluateGuard(never, { page: { seen: [], finalText: "Prize draw" } }).status).toBe("pass")
    expect(evaluateGuard(never, { page: null }).status).toBe("not-evaluated")
  })
  it("exempts only appearances confined to the exact scripted fault window", () => {
    const text = "Your Polkadot app is stuck, restart it"
    const guard: Guard = { kind: "text", text, never: true }
    const window = [{ text, fromMs: 1_000, toMs: 16_000 }]
    expect(evaluateGuard(guard, { page: { seen: [text], appearances: [{ text, fromMs: 4_000, toMs: 15_000 }], ignoreNeverTextWindows: window, finalText: "Game" } })).toMatchObject({ status: "pass", evidence: expect.stringContaining("scripted fault window") })
    expect(evaluateGuard(guard, { page: { seen: [text], appearances: [{ text, fromMs: 4_000, toMs: 17_000 }], ignoreNeverTextWindows: window, finalText: "Game" } }).status).toBe("fail")
    expect(evaluateGuard(guard, { page: { seen: [text], appearances: [{ text, fromMs: 500, toMs: 4_000 }], ignoreNeverTextWindows: window, finalText: "Game" } }).status).toBe("fail")
    expect(evaluateGuard(guard, { page: { seen: [text], ignoreNeverTextWindows: window, finalText: "Game" } }).status).toBe("fail")
    expect(evaluateGuard(guard, { page: { seen: [text], appearances: [{ text, fromMs: 4_000, toMs: 15_000 }], ignoreNeverTextWindows: window, finalText: text } }).status).toBe("fail")
  })
  it("gives only the switcher's successful blackout a bounded warning-recovery margin", () => {
    const run: NetworkCallRun = { step: 1, call: ["blackout", "120"], startMs: 1_000, endMs: 121_000, ok: true, inconclusive: false }
    const windows = scriptedNeverTextWindows("switcher-pixel6a-wifi-to-cell", [run])
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ fromMs: 1_000, toMs: 121_000 + SCRIPTED_WARNING_RECOVERY_MARGIN_MS })
    expect(scriptedNeverTextWindows("telemetry-t9-blackout", [run])).toEqual([])
    expect(scriptedNeverTextWindows("switcher-pixel6a-wifi-to-cell", [{ ...run, ok: false }])).toEqual([])
    const guard: Guard = { kind: "text", text: windows[0].text, never: true }
    expect(evaluateGuard(guard, { page: { seen: [guard.text], appearances: [{ text: guard.text, fromMs: 1_000, toMs: windows[0].toMs }], ignoreNeverTextWindows: windows, finalText: "Game" } }).status).toBe("pass")
    expect(evaluateGuard(guard, { page: { seen: [guard.text], appearances: [{ text: guard.text, fromMs: 1_000, toMs: windows[0].toMs + 1 }], ignoreNeverTextWindows: windows, finalText: "Game" } }).status).toBe("fail")
  })
  it("allows only the isolation notice inside udp-cut-40s's proven cut and recovery window", () => {
    const run: NetworkCallRun = { step: 1, call: ["udp-cut", "40", "turn.cloudflare.com"], startMs: 1_000, endMs: 41_000, ok: true, inconclusive: false }
    const windows = scriptedNeverTextWindows("udp-cut-40s", [run])
    expect(windows).toEqual([{
      text: EXPECTED_NETWORK_ISOLATION_TEXT,
      fromMs: 1_000,
      toMs: 41_000 + SCRIPTED_WARNING_RECOVERY_MARGIN_MS,
    }])
    expect(scriptedNeverTextWindows("uplink-limited-pixel6a", [run])).toEqual([])
    expect(scriptedNeverTextWindows("udp-cut-40s", [{ ...run, call: ["blackout", "40"] }])).toEqual([])
    expect(scriptedNeverTextWindows("udp-cut-40s", [{ ...run, ok: false }])).toEqual([])
    expect(scriptedNeverTextWindows("udp-cut-40s", [{ ...run, inconclusive: true }])).toEqual([])

    const isolation: Guard = { kind: "text", text: EXPECTED_NETWORK_ISOLATION_TEXT, never: true }
    expect(evaluateGuard(isolation, { page: {
      seen: [isolation.text],
      appearances: [{ text: isolation.text, fromMs: 31_000, toMs: 42_000 }],
      ignoreNeverTextWindows: windows,
      finalText: "Game",
    } }).status).toBe("pass")
    expect(evaluateGuard(isolation, { page: {
      seen: [isolation.text],
      appearances: [{ text: isolation.text, fromMs: 31_000, toMs: windows[0].toMs + 1 }],
      ignoreNeverTextWindows: windows,
      finalText: "Game",
    } }).status).toBe("fail")

    const hostRestart: Guard = { kind: "text", text: "Your Polkadot app is stuck, restart it", never: true }
    expect(evaluateGuard(hostRestart, { page: {
      seen: [hostRestart.text],
      appearances: [{ text: hostRestart.text, fromMs: 31_000, toMs: 42_000 }],
      ignoreNeverTextWindows: windows,
      finalText: "Game",
    } }).status).toBe("fail")
  })
  it("shows: on the page at the end or seen", () => {
    const g: Guard = { kind: "text", text: "update" }
    expect(evaluateGuard(g, { page: { seen: [], finalText: "an update" } }).status).toBe("pass")
    expect(evaluateGuard(g, { page: { seen: [], finalText: "" } }).status).toBe("fail")
  })
  it("accepts either device-specific warning only after it clears", () => {
    const g: Guard = { kind: "text-cleared-any", texts: ["Wi-Fi blocked", "network blocked"] }
    expect(evaluateGuard(g, { page: { seen: ["Wi-Fi blocked"], finalText: "network blocked later", afterNetworkText: "Waiting room" } }).status).toBe("pass")
    expect(evaluateGuard(g, { page: { seen: ["network blocked"], finalText: "Game", afterNetworkText: "network blocked" } }).status).toBe("fail")
    expect(evaluateGuard(g, { page: { seen: ["Wi-Fi blocked"], finalText: "Game" } })).toMatchObject({ status: "fail", evidence: "no post-switch page sample was captured" })
    expect(evaluateGuard(g, { page: { seen: [], finalText: "Game", afterNetworkText: "Game" } }).status).toBe("fail")
  })
  it("T9 accepts only its proven isolation notice while every other negative guard stays strict", () => {
    const profile = {
      name: "telemetry-t9-blackout",
      telemetryTorture: { id: "T9", fault: "none" },
      expect: [
        { kind: "text", text: EXPECTED_NETWORK_ISOLATION_TEXT, never: true },
        { kind: "text", text: "Your Polkadot app is stuck, restart it", never: true },
      ],
    } as Profile
    const page = { seen: [EXPECTED_NETWORK_ISOLATION_TEXT, "Your Polkadot app is stuck, restart it"], finalText: EXPECTED_NETWORK_ISOLATION_TEXT }
    const results = evaluateT9Guards(profile, { page }, { isolationWithinWindow: true, faultRecovered: true })
    expect(results.map(({ status }) => status)).toEqual(["pass", "fail"])
    expect(evaluateT9Guards(profile, { page }, { isolationWithinWindow: false, faultRecovered: true })[0].status).toBe("fail")
    expect(evaluateT9Guards(profile, { page }, { isolationWithinWindow: true, faultRecovered: false })[0].status).toBe("fail")
    expect(evaluateT9Guards(profile, { page: { seen: [], finalText: "Connection help" } }, { isolationWithinWindow: true, faultRecovered: true })[0].status).toBe("fail")
  })
  it("identifies the T9 isolation guard by telemetry contract rather than profile name", () => {
    const guard: Guard = { kind: "text", text: EXPECTED_NETWORK_ISOLATION_TEXT, never: true }
    const renamed = { name: "renamed-blackout-profile", telemetryTorture: { id: "T9", fault: "none" } } as Profile
    const misleading = { name: "telemetry-t9-blackout", telemetryTorture: { id: "T8", fault: "sentry-429" } } as Profile
    expect(isExpectedT9IsolationGuard(renamed, guard)).toBe(true)
    expect(isExpectedT9IsolationGuard(misleading, guard)).toBe(false)
  })
  it("the observer script records a text that came and went", () => {
    const bodies = ["", "Voting has closed", "bye"]
    const doc = { get body() { return { innerText: bodies.shift() ?? "" } }, addEventListener: () => {} }
    let scan = () => {}
    const win: Record<string, unknown> = {}
    let now = 1_000
    const ctx = vm.createContext({
      window: win,
      document: doc,
      MutationObserver: class { constructor(cb: () => void) { scan = cb } observe() {} },
      addEventListener: () => {},
      setInterval: () => 0,
      Date: { now: () => now++ },
      Map,
    })
    vm.runInContext(textWatchScript(["Voting has closed"]), ctx)
    scan(); scan(); scan()
    expect(win.__e2eSeen).toEqual(["Voting has closed"])
    expect(win.__e2eAppearances).toEqual([{ text: "Voting has closed", fromMs: 1_001, toMs: 1_002 }])
  })
  it("closes an open interval at the kill/reload boundary even while its text remains visible", () => {
    const doc = { body: { innerText: "Voting has closed" } }
    let scan = () => {}
    const win: Record<string, unknown> = {}
    let now = 1_000
    const ctx = vm.createContext({
      window: win,
      document: doc,
      MutationObserver: class { constructor(cb: () => void) { scan = cb } observe() {} },
      addEventListener: () => {},
      setInterval: () => 0,
      Date: { now: () => now++ },
      Map,
    })
    vm.runInContext(textWatchScript(["Voting has closed"]), ctx)
    scan()
    vm.runInContext("window.__e2eTextWatch.close()", ctx)
    expect(win.__e2eAppearances).toEqual([{ text: "Voting has closed", fromMs: 1_000, toMs: 1_001 }])
  })
  it("collects only the live text guards of a profile", () => expect(textGuardTexts(profileFor(1))).toEqual([
    "Voting has closed",
    "Restart the Polkadot app",
    "Your Polkadot app is stuck, restart it",
    "We couldn't connect you to anyone.",
  ]))
})

describe("chain-report guard", () => {
  const filed = (verdict: string): FiledReport => ({ who: "me", block: 1, extrinsic: 0, rounds: [{ ownIndex: 0, members: [{ index: 0, player: "me" }, { index: 1, player: "bob" }] }], fullReport: [[verdict]] })
  const trail = (v: string): VoteTrail => ({ reports: [{ ts: 0, filedBy: "tap", players: { bob: { verdict: v } } }], taps: 0, sealed: 0, overrides: 0 })
  const g: Guard = { kind: "chain-report", matchesVoteTrail: true }
  it("passes when the chain report equals the trail", () => expect(evaluateGuard(g, { chain: { account: "me", filed: filed("Person"), trail: trail("person") } }).status).toBe("pass"))
  it("fails on a difference, naming it", () => {
    const r = evaluateGuard(g, { chain: { account: "me", filed: filed("NotPerson"), trail: trail("person") } })
    expect(r.status).toBe("fail")
    expect(r.evidence).toMatch(/trail person, chain NotPerson/)
  })
  it("uses the per-turn stage-d oracle instead of flattening a dynamic-role trail", () => {
    const chain = {
      account: "me",
      filed: filed("NotPerson"),
      trail: trail("person"),
      oracle: { name: "role-aware report", status: "pass", detail: "2/2 round verdicts as expected; video roles: Unseen turns excluded; never-seen expects NotPerson" },
    }
    const r = evaluateGuard(g, { chain: chain as never })
    expect(r.status).toBe("pass")
    expect(r.evidence).toMatch(/2\/2 round verdicts as expected/)
  })
  it("fails when the per-turn stage-d oracle fails even if the flattened trail matches", () => {
    const chain = {
      account: "me",
      filed: filed("Person"),
      trail: trail("person"),
      oracle: { name: "role-aware report", status: "fail", detail: "turn 7 expected Person, got NotPerson" },
    }
    const r = evaluateGuard(g, { chain: chain as never })
    expect(r.status).toBe("fail")
    expect(r.evidence).toMatch(/turn 7 expected Person/)
  })
  it("delegates late-prefix never-video reports to the corrected stage-d oracle", () => {
    const members = [
      { index: 0, player: "never" },
      { index: 1, player: "me" },
      { index: 2, player: "peer" },
    ]
    const roles = {
      turns: [
        { turn: 2, roles: { never: "unseen" as const, peer: "unseen" as const } },
        { turn: 3, roles: { never: "unseen" as const, peer: "host" as const } },
      ],
    }
    const report = (verdict: "Person" | "NotPerson"): FiledReport => ({ who: "me", block: 1, extrinsic: 0, rounds: [{ ownIndex: 1, members }], fullReport: [[verdict, verdict]] })
    const correct = report("NotPerson")
    const oracle = checkChainVotes("late role report", correct, ["me", "never", "peer"], false, undefined, roles)
    expect(oracle.status).toBe("pass")
    expect(evaluateGuard(g, { chain: { account: "me", filed: correct, trail: trail("person"), oracle } }).status).toBe("pass")

    const wrong = report("Person")
    const wrongOracle = checkChainVotes("late role report", wrong, ["me", "never", "peer"], false, undefined, roles)
    expect(wrongOracle.status).toBe("fail")
    expect(evaluateGuard(g, { chain: { account: "me", filed: wrong, trail: trail("person"), oracle: wrongOracle } }).status).toBe("fail")
  })
  it("does not let delegation bless NotPerson for a peer missing from every role row", () => {
    const members = [
      { index: 0, player: "missing" },
      { index: 1, player: "me" },
      { index: 2, player: "observed" },
    ]
    const roles = {
      turns: [
        { turn: 1, roles: { observed: "coplayer" as const } },
        { turn: 2, roles: { observed: "coplayer" as const } },
        { turn: 3, roles: { observed: "host" as const } },
      ],
    }
    const filed: FiledReport = { who: "me", block: 1, extrinsic: 0, rounds: [{ ownIndex: 1, members }], fullReport: [["NotPerson", "Person"]] }
    const oracle = checkChainVotes("partial role report", filed, ["me", "missing", "observed"], false, undefined, roles)
    expect(oracle.status).toBe("fail")
    expect(evaluateGuard(g, { chain: { account: "me", filed, trail: trail("person"), oracle } }).status).toBe("fail")
  })
  it("delegates a proven post-cutoff auto-reject into the aggregate tie", () => {
    const report = (verdict: "Person" | "NotPerson"): FiledReport => ({
      who: "me",
      block: 1,
      extrinsic: 0,
      maxGroupSize: 3,
      rounds: [{ ownIndex: 0, members: [{ index: 0, player: "me" }, { index: 1, player: "bob" }] }],
      fullReport: [[verdict]],
    })
    const roles = {
      turns: [
        { turn: 1, roles: { bob: "coplayer" as const }, verdicts: { bob: "no-opportunity" as const } },
        { turn: 2, roles: { bob: "host" as const }, verdicts: { bob: "not-votable" as const } },
        { turn: 3, roles: { bob: "coplayer" as const }, verdicts: { bob: "approved" as const } },
      ],
    }
    const correct = report("NotPerson")
    const correctOracle = checkChainVotes("role-aware tie", correct, ["me", "bob"], false, undefined, roles)
    expect(correctOracle.status).toBe("pass")
    expect(evaluateGuard(g, { chain: { account: "me", filed: correct, trail: trail("person"), oracle: correctOracle } }).status).toBe("pass")

    const wrong = report("Person")
    const wrongOracle = checkChainVotes("role-aware tie", wrong, ["me", "bob"], false, undefined, roles)
    expect(wrongOracle.status).toBe("fail")
    expect(evaluateGuard(g, { chain: { account: "me", filed: wrong, trail: trail("person"), oracle: wrongOracle } }).status).toBe("fail")
  })
  it("blocks unknown cutoff freshness even when NotPerson matches the aggregate tie", () => {
    const filed: FiledReport = {
      who: "me",
      block: 1,
      extrinsic: 0,
      maxGroupSize: 3,
      rounds: [{ ownIndex: 0, members: [{ index: 0, player: "me" }, { index: 1, player: "bob" }] }],
      fullReport: [["NotPerson"]],
    }
    const roles = {
      turns: [
        { turn: 1, roles: { bob: "coplayer" as const }, verdicts: { bob: "unknown" as const } },
        { turn: 2, roles: { bob: "host" as const }, verdicts: { bob: "not-votable" as const } },
        { turn: 3, roles: { bob: "coplayer" as const }, verdicts: { bob: "approved" as const } },
      ],
    }
    const oracle = checkChainVotes("unknown freshness tie", filed, ["me", "bob"], false, undefined, roles)
    expect(oracle.status).toBe("fail")
    expect(oracle.detail).toContain("opportunity evidence unknown")
    expect(evaluateGuard(g, { chain: { account: "me", filed, trail: trail("notperson"), oracle } }).status).toBe("fail")
  })
  it("an empty trail is not evaluated, never a pass; no report on chain is a fail", () => {
    expect(evaluateGuard(g, { chain: { account: "me", filed: filed("Person"), trail: null } }).status).toBe("not-evaluated")
    expect(evaluateGuard(g, { chain: { account: "me", filed: undefined, trail: trail("person") } }).status).toBe("fail")
  })
  it("says WHY there is no trail, from the devLog export: game 190 blamed a relaunch on bots that never relaunched", () => {
    const why = "no window.__jollityHarness in this page: the build carries it under next dev or with a test tag set (telemetry on for the run)"
    const r = evaluateGuard(g, { chain: { account: "me", filed: filed("Person"), trail: null, trailNote: why } })
    expect(r.status).toBe("not-evaluated")
    expect(r.evidence).toBe(`no vote trail: ${why}`)
    expect(r.evidence).not.toMatch(/relaunch/)
    expect(evaluateGuard(g, { chain: { account: "me", filed: filed("Person"), trail: null } }).evidence).toBe("no vote trail: the devLog was not exported")
  })
})

describe("merge and tally", () => {
  it("a later evaluation replaces only the not-evaluated", () => {
    const e = [{ kind: "metric", description: "a", status: "not-evaluated", evidence: "" }, { kind: "text", description: "b", status: "pass", evidence: "" }] as never
    const l = [{ kind: "metric", description: "a", status: "fail", evidence: "x" }, { kind: "text", description: "b", status: "fail", evidence: "x" }] as never
    expect(tally(mergeGuards(e, l))).toEqual({ pass: 1, fail: 1, pending: 0, "not-evaluated": 0 })
  })
})

describe("store-rejection guard (the host's replies on the page's websocket)", () => {
  const g: Guard = { kind: "store-rejection", reason: "channelPriorityTooLow", max: 0 }
  const wire = (reasons: string[], frames = 50) => ({ frames, sockets: 1, rejections: reasons.map((reason, k) => ({ reason, at: `2026-10-04T19:00:0${k}.000Z` })) })
  it("passes with no refusal of that reason, fails with one", () => {
    expect(evaluateGuard(g, { wire: wire(["alreadyExpired"]) }).status).toBe("pass")
    const bad = evaluateGuard(g, { wire: wire(["channelPriorityTooLow"]) })
    expect(bad.status).toBe("fail")
    expect(bad.evidence).toMatch(/1 channelPriorityTooLow refusal\(s\) naming a statement the saved floor should have cleared, first at 19:00:00 UTC/)
  })
  it("is not evaluated without a tap, or when the tap read nothing (no frame is no proof)", () => {
    expect(evaluateGuard(g, {}).status).toBe("not-evaluated")
    expect(evaluateGuard(g, { wire: wire([], 0) }).status).toBe("not-evaluated")
  })
  it("game 199 bot 16: a channelPriorityTooLow naming the page's own newer frame (superseded) is no failure; one at or below the saved floor is", () => {
    const reloads = [{ at: "2026-10-04T20:26:07.535Z", floor: "7690000000000000000" }]
    const own = { reason: "channelPriorityTooLow", at: "2026-10-04T20:27:24.400Z", heldExpiry: "7690000400000000000" }
    const ok = evaluateGuard(g, { wire: { frames: 6413, sockets: 2, reloads, rejections: [own] } })
    expect(ok.status).toBe("pass")
    expect(ok.evidence).toMatch(/^0 channelPriorityTooLow refusal\(s\) naming a statement the saved floor should have cleared; 1 superseded by the page's own newer frame/)
    const stale = { reason: "channelPriorityTooLow", at: "2026-10-04T20:26:12.000Z", heldExpiry: "7690000000000000000" }
    const bad = evaluateGuard(g, { wire: { frames: 6413, sockets: 2, reloads, rejections: [own, stale] } })
    expect(bad.status).toBe("fail")
    expect(bad.evidence).toMatch(/^1 channelPriorityTooLow refusal\(s\) naming a statement the saved floor should have cleared, first at 20:26:12 UTC; 1 superseded/)
  })
  it("defaults to seen at least once without bounds", () => {
    expect(evaluateGuard({ kind: "store-rejection", reason: "alreadyExpired" }, { wire: wire([]) }).status).toBe("fail")
    expect(evaluateGuard({ kind: "store-rejection", reason: "alreadyExpired" }, { wire: wire(["alreadyExpired"]) }).status).toBe("pass")
  })
})

describe("devlog guard (the app's own log lines)", () => {
  const lines = [
    { tag: "rtc", message: "[jollity-rtc] self-heal: ICE restart 5Abc (attempt 1)" },
    { tag: "rtc", message: "[jollity-rtc] media-stall: 5Abc connected but no inbound video → ICE restart (heal 1)" },
    { tag: "rtc", message: "[jollity-rtc] round-link stage=first-video round=1 fault=offer-1 peer=5Abc" },
    { tag: "statement", message: "media-stall: not an rtc line" },
  ]
  const devlog = { lines, note: "4 entries" }
  it("counts lines that contain the match, of the tag when one is given", () => {
    expect(evaluateGuard({ kind: "devlog", tag: "rtc", match: "media-stall:" }, { devlog })).toMatchObject({ status: "pass", evidence: expect.stringMatching(/^1 matching of 4/) })
    expect(evaluateGuard({ kind: "devlog", match: "media-stall:", min: 2 }, { devlog }).status).toBe("pass")
    expect(evaluateGuard({ kind: "devlog", tag: "rtc", match: "media-stall:", max: 0 }, { devlog }).status).toBe("fail")
    expect(evaluateGuard({ kind: "devlog", tag: "rtc", match: "peer away", max: 0 }, { devlog }).status).toBe("pass")
    expect(evaluateGuard({ kind: "devlog", tag: "rtc", match: "rebuild" }, { devlog }).status).toBe("fail")
  })
  it("matchAny counts a line that has any of the matches, min and max applying to the total (game 126: the frozen-frames detector healed the stall)", () => {
    const frozen = [
      { tag: "rtc", message: "[jollity-rtc] media frozen: packets rising (40 received), frames flat at 12 → keyframe ask" },
      { tag: "rtc", message: "[jollity-rtc] media frozen: still no frame after the keyframe ask → rebuild" },
    ]
    const onlyFrozen = { lines: frozen, note: "2 entries" }
    const guard: Guard = { kind: "devlog", tag: "rtc", match: "media-stall:", matchAny: ["media frozen:"] }
    expect(evaluateGuard({ kind: "devlog", tag: "rtc", match: "media-stall:" }, { devlog: onlyFrozen }).status).toBe("fail")
    expect(evaluateGuard(guard, { devlog: onlyFrozen })).toMatchObject({ status: "pass", evidence: expect.stringMatching(/^2 matching of 2/) })
    expect(evaluateGuard(guard, { devlog })).toMatchObject({ status: "pass", evidence: expect.stringMatching(/^1 matching of 4/) })
    expect(evaluateGuard({ ...guard, max: 2 }, { devlog: { lines: [...frozen, ...lines], note: "" } }).status).toBe("fail")
    expect(evaluateGuard({ ...guard, max: 3 }, { devlog: { lines: [...frozen, ...lines], note: "" } }).status).toBe("pass")
    expect(evaluateGuard({ ...guard, min: 3 }, { devlog: { lines: [...frozen, ...lines], note: "" } }).status).toBe("pass")
    expect(evaluateGuard({ ...guard, min: 4 }, { devlog: { lines: [...frozen, ...lines], note: "" } }).status).toBe("fail")
  })
  it("video-stall-30s accepts either stall detector in both of its guards", () => {
    const stall = loadProfiles().find((p) => p.name === "video-stall-30s")!.expect.filter((g) => g.kind === "devlog" && g.match === "media-stall:")
    expect(stall).toHaveLength(2)
    const frozenOnly = { lines: Array.from({ length: 7 }, () => ({ tag: "rtc", message: "[jollity-rtc] media frozen: packets rising (9 received), frames flat at 3 → keyframe ask" })), note: "" }
    for (const g of stall) expect(evaluateGuard(g, { devlog: frozenOnly }).status).toBe("pass")
  })
  it("matches exact key/value fields and required dynamic fields", () => {
    expect(evaluateGuard({ kind: "devlog", tag: "rtc", match: "[jollity-rtc] round-link", fields: { stage: "first-video", round: "1", fault: "offer-1" }, has: ["peer"] }, { devlog }).status).toBe("pass")
    expect(evaluateGuard({ kind: "devlog", match: "[jollity-rtc] round-link", fields: { round: "2" } }, { devlog }).status).toBe("fail")
    expect(evaluateGuard({ kind: "devlog", match: "[jollity-rtc] round-link", has: ["signalingState"] }, { devlog }).status).toBe("fail")
  })
  it("is not evaluated without lines, saying why, never a pass", () => {
    expect(evaluateGuard({ kind: "devlog", match: "x", max: 0 }, {})).toMatchObject({ status: "not-evaluated", evidence: "no devLog lines: not exported" })
    expect(evaluateGuard({ kind: "devlog", match: "x", max: 0 }, { devlog: { lines: [], note: "export failed: timed out" } })).toMatchObject({ status: "not-evaluated", evidence: "no devLog lines: export failed: timed out" })
  })
})

describe("fast cold late-join proof guard", () => {
  const guard = { kind: "late-join-proof", round: 1, maxFirstVideoMs: 8000 } as const
  const line = (ts: number, tag: string, message: string, data: Record<string, unknown> = {}, sessionId = "cold-a") => ({ ts, tag, message, data, sessionId })
  const good = () => ({ note: "proof", lines: [
    line(1_000, "clock", "clock ready", { gapMs: 400, late: true }),
    line(1_200, "rtc", "mesh opening", { room: "g7:a_b", round: 1 }),
    line(8_900, "rtc", "[jollity-rtc] round-link stage=first-video round=1 peer=b"),
    line(10_100, "vote", "tap", { round: 1, turn: 6 }),
  ] })
  it("passes prompt video, actual-round rooms and no pre-ready vote activity", () => {
    const devlog = good()
    devlog.lines.unshift(line(500, "rtc", "mesh opening", { room: "other", round: 0 }, "other-session"))
    expect(evaluateGuard(guard, { devlog })).toMatchObject({ status: "pass", evidence: expect.stringContaining("first video in 7700 ms") })
  })
  it("fails slow video, wrong-room round, and a pre-ready tap or seal", () => {
    const slow = good(); slow.lines[2].ts = 9_201
    expect(evaluateGuard(guard, { devlog: slow }).status).toBe("fail")
    const wrong = good(); (wrong.lines[1].data as Record<string, unknown>).round = 0
    expect(evaluateGuard(guard, { devlog: wrong }).status).toBe("fail")
    const onTime = good(); (onTime.lines[0].data as Record<string, unknown>).late = false
    expect(evaluateGuard(guard, { devlog: onTime })).toMatchObject({ status: "fail", evidence: expect.stringContaining("0 late clock ready lines") })
    for (const message of ["tap", "turn sealed"]) {
      const early = good(); early.lines.unshift(line(1_000, "vote", message, { round: 1, turn: 6 }))
      expect(evaluateGuard(guard, { devlog: early })).toMatchObject({ status: "fail", evidence: `${message} occurred before clock ready` })
    }
  })
})

describe("video back after a reload guard (#1020)", () => {
  const guard = { kind: "reload-video-back", maxVideoBackMs: 45_000 } as const
  const line = (ts: number, sessionId: string, message: string, tag = "rtc") => ({ ts, sessionId, tag, message })
  const video = (ts: number, sessionId: string, peer: string, round = 1) => line(ts, sessionId, `[jollity-rtc] round-link stage=first-video round=${round} peer=${peer}`)
  const reloaded = () => ({ note: "proof", lines: [
    line(1_000, "before", "boot", "app"),
    video(5_000, "before", "bob"),
    video(6_000, "before", "cid"),
    line(20_000, "after", "boot", "app"),
    line(24_000, "after", "mesh opening"),
    video(28_000, "after", "bob"),
    video(31_000, "after", "cid"),
  ] })
  it("passes when every co-player seen before the reload sends video again within the budget", () => {
    expect(evaluateGuard(guard, { devlog: reloaded() })).toMatchObject({ status: "pass", evidence: expect.stringContaining("all 2 co-player(s) back, the last (cid) 11000 ms after the reloaded page booted") })
  })
  it("fails when one co-player never comes back while the others do (game 270: one pair dark)", () => {
    const stuck = reloaded()
    stuck.lines.pop()
    stuck.lines.push(video(31_000, "after", "dan"))
    expect(evaluateGuard(guard, { devlog: stuck })).toMatchObject({ status: "fail", evidence: expect.stringContaining("no video back from cid (round 1 before the reload)") })
  })
  it("excuses a co-player who said they left after the reload", () => {
    const gone = reloaded()
    gone.lines.pop()
    gone.lines.push(line(30_000, "after", "[jollity-rtc] peer away cid said"))
    expect(evaluateGuard(guard, { devlog: gone })).toMatchObject({ status: "pass", evidence: expect.stringContaining("cid left") })
  })
  it("does not excuse a co-player who said they were away, came back and never sent video again", () => {
    const back = reloaded()
    back.lines.pop()
    back.lines.push(line(29_000, "after", "[jollity-rtc] peer away cid said"), line(33_000, "after", "[jollity-rtc] peer back cid"))
    expect(evaluateGuard(guard, { devlog: back })).toMatchObject({ status: "fail", evidence: expect.stringContaining("no video back from cid") })
  })
  it("counts a video logged before the reloaded page knows its round", () => {
    const early = reloaded()
    early.lines[6] = line(31_000, "after", "[jollity-rtc] round-link stage=first-video round=none peer=cid")
    expect(evaluateGuard(guard, { devlog: early }).status).toBe("pass")
  })
  it("fails when the slowest co-player's video comes back past the budget", () => {
    const slow = reloaded()
    slow.lines[6]!.ts = 65_001
    expect(evaluateGuard(guard, { devlog: slow })).toMatchObject({ status: "fail", evidence: expect.stringContaining("cid's video back 45001 ms") })
  })
  it("is not evaluated when the run did not create the precondition: no reload, or no video before it", () => {
    const once = { note: "one", lines: reloaded().lines.filter((l) => l.sessionId === "before") }
    expect(evaluateGuard(guard, { devlog: once })).toMatchObject({ status: "not-evaluated", evidence: expect.stringContaining("one page session") })
    const dark = { note: "dark", lines: reloaded().lines.filter((l) => !(l.sessionId === "before" && l.message.includes("first-video"))) }
    expect(evaluateGuard(guard, { devlog: dark })).toMatchObject({ status: "not-evaluated", evidence: expect.stringContaining("no co-player video before the reload") })
    expect(evaluateGuard(guard, { devlog: { note: "gone", lines: [] } }).status).toBe("not-evaluated")
  })
})

describe("synchronized peer-connection failure guard", () => {
  const guard = { kind: "synchronized-pc-failure", withinMs: 5_000, minPeers: 2 } as const
  const evidence = (rows: Array<[number, string, unknown?]>) => ({ lines: rows.map(([ts, message, data]) => ({ ts, tag: "rtc", message, ...(data === undefined ? {} : { data }) })), note: `${rows.length} entries` })
  it("fails when every established link fails in one short window", () => {
    const devlog = evidence([[1, "[jollity-rtc] pc alice connected"], [2, "[jollity-rtc] pc bob connected"], [10_000, "[jollity-rtc] pc alice failed"], [12_000, "[jollity-rtc] pc bob failed"]])
    expect(evaluateGuard(guard, { devlog })).toMatchObject({ status: "fail", evidence: expect.stringContaining("2/2") })
  })
  it("passes staggered or partial failures", () => {
    const devlog = evidence([[1, "[jollity-rtc] pc alice connected"], [2, "[jollity-rtc] pc bob connected"], [10_000, "[jollity-rtc] pc alice failed"], [20_000, "[jollity-rtc] pc bob failed"]])
    expect(evaluateGuard(guard, { devlog }).status).toBe("pass")
  })
  it("does not combine a recovered link's old failure with a later one", () => {
    const recovered = evidence([[1, "[jollity-rtc] pc alice connected"], [2, "[jollity-rtc] pc bob connected"], [10_000, "[jollity-rtc] pc alice failed"], [11_000, "[jollity-rtc] pc alice connected"], [12_000, "[jollity-rtc] pc bob failed"]])
    expect(evaluateGuard(guard, { devlog: recovered }).status).toBe("pass")
  })
  it("uses production mesh lifecycle lines to separate regrouped connection generations", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [11_000, "mesh closing", { room: "g7:alice_bob", generation: 1, cause: "room-change" }],
      [11_001, "mesh opening", { room: "g7:bob_carol", generation: 2 }],
      [11_002, "[jollity-rtc] pc bob connected"],
      [12_000, "[jollity-rtc] pc bob failed"],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("pass")
  })
  it("counts only peers connected when each synchronized-failure window starts", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob_carol", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [4, "[jollity-rtc] pc carol connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [150_000, "[jollity-rtc] pc bob failed"],
      [152_000, "[jollity-rtc] pc carol failed"],
    ])
    expect(evaluateGuard(guard, { devlog })).toMatchObject({ status: "fail", evidence: expect.stringContaining("2/2") })
  })
  it("excludes peers that explicitly said they were leaving", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [9_000, "[jollity-rtc] peer away alice said"],
      [9_100, "[jollity-rtc] peer away bob said"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("pass")
  })
  it("re-adds an explicitly-away peer when the production peer-back line says it returned", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [9_000, "[jollity-rtc] peer away alice said"],
      [20_000, "[jollity-rtc] peer back alice"],
      [30_000, "[jollity-rtc] pc alice failed"],
      [32_000, "[jollity-rtc] pc bob failed"],
    ])
    expect(evaluateGuard(guard, { devlog })).toMatchObject({ status: "fail", evidence: expect.stringContaining("2/2") })
  })
  it("does not call a collapse immediately beside the local game-end or regroup teardown", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [12_500, "mesh closing", { room: "g7:alice_bob", generation: 1, cause: "inactive" }],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("pass")
  })
  it("does not suppress a real collapse when network recovery rebuilds the same room", () => {
    const room = { room: "g7:alice_bob", generation: 1 }
    const devlog = evidence([
      [1, "mesh opening", room],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [12_100, "[jollity-rtc] network online: rebuilding room"],
      [12_500, "mesh closing", { ...room, cause: "network-recovery" }],
      [12_501, "mesh opening", { room: room.room, generation: 2 }],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("fail")
  })
  it("suppresses a planned regroup from the failed room into a different room", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [12_500, "mesh closing", { room: "g7:alice_bob", generation: 1, cause: "room-change" }],
      [12_501, "mesh opening", { room: "g7:carol_dave", generation: 2 }],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("pass")
  })
  it("fails closed for unmount or missing close causes", () => {
    for (const close of [
      { room: "g7:alice_bob", generation: 1, cause: "unmount" },
      { room: "g7:alice_bob", generation: 1 },
    ]) {
      const devlog = evidence([
        [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
        [2, "[jollity-rtc] pc alice connected"],
        [3, "[jollity-rtc] pc bob connected"],
        [10_000, "[jollity-rtc] pc alice failed"],
        [12_000, "[jollity-rtc] pc bob failed"],
        [12_500, "mesh closing", close],
      ])
      expect(evaluateGuard(guard, { devlog }).status).toBe("fail")
    }
  })
  it("requires the planned close to match both failed room and lifecycle generation", () => {
    for (const close of [
      { room: "g7:carol_dave", generation: 1, cause: "room-change" },
      { room: "g7:alice_bob", generation: 2, cause: "inactive" },
    ]) {
      const devlog = evidence([
        [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
        [2, "[jollity-rtc] pc alice connected"],
        [3, "[jollity-rtc] pc bob connected"],
        [10_000, "[jollity-rtc] pc alice failed"],
        [12_000, "[jollity-rtc] pc bob failed"],
        [12_500, "mesh closing", close],
      ])
      expect(evaluateGuard(guard, { devlog }).status).toBe("fail")
    }
  })
  it("does not cross-suppress equal generation numbers merged from different documents", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [12_500, "mesh closing", { room: "g7:alice_bob", generation: 1, cause: "inactive" }],
    ])
    const merged = { ...devlog, lines: devlog.lines.map((line) => ({ ...line, sessionId: line.message === "mesh closing" ? "document-b" : "document-a" })) }
    expect(evaluateGuard(guard, { devlog: merged }).status).toBe("fail")
  })
  it("does not let a later merged-log generation suppress an earlier collapse", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      // A reload/new document can contribute an opening without retaining the
      // prior document's closing line. Its close must not excuse generation 1.
      [13_000, "mesh opening", { room: "g7:carol_dave", generation: 2 }],
      [13_500, "mesh closing", { room: "g7:carol_dave", generation: 2, cause: "inactive" }],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("fail")
  })
  it("still fails a synchronized collapse when teardown is absent or later than the guard window", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
      [17_001, "mesh closing", { room: "g7:alice_bob", generation: 1, cause: "inactive" }],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("fail")
  })
  it("ignores a failure edge from a peer that never connected in this generation", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [9_000, "[jollity-rtc] peer back carol"],
      [10_000, "[jollity-rtc] pc carol failed"],
    ])
    expect(evaluateGuard(guard, { devlog }).status).toBe("pass")
  })
  it("ignores lifecycle-looking lines from another devlog tag", () => {
    const devlog = evidence([
      [1, "mesh opening", { room: "g7:alice_bob", generation: 1 }],
      [2, "[jollity-rtc] pc alice connected"],
      [3, "[jollity-rtc] pc bob connected"],
      [10_000, "[jollity-rtc] pc alice failed"],
      [12_000, "[jollity-rtc] pc bob failed"],
    ])
    devlog.lines.push({ ts: 12_500, tag: "journey", message: "mesh closing" })
    expect(evaluateGuard(guard, { devlog }).status).toBe("fail")
  })
})
