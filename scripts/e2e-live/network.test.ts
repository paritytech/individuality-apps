// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import {
  NetworkController,
  blackoutFaultWindow,
  blackoutAcceptanceDeadline,
  blackoutRecoveryObserved,
  BLACKOUT_ISOLATION_MIN_MS,
  clearNetworkAfterPlay,
  isolationWithinBlackout,
  NETEM_INCONCLUSIVE_EXIT,
  NETEM_TIMEOUT_MARGIN_MS,
  NetemError,
  ISOLATION_GAPS,
  OUTAGE_TARGETS,
  outageHost,
  SURVIVAL_TRANSITION_TIMEOUT_MS,
  dueSteps,
  netemEnabled,
  netemCallTimeoutMs,
  networkPlan,
  postOpenBurstChecks,
  roundChannelOpenPeers,
  scheduleAtWallMs,
  scheduleBeforeGameSteps,
  waitForRoundChannelGate,
  waitForSurvivalWindow,
  type NetemCall,
  type NetworkNarrationEvent,
  type NetworkPlan,
  type NetworkStepEvidence,
} from "./network"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { profileByName, profileFor } from "./profile"
import { verifyRoleActs } from "./role-proof"

describe("networkPlan", () => {
  it("uses the actual successful blackout run as the telemetry recovery window", () => {
    const runs = [
      { step: 1, call: ["blackout", "120"] as NetemCall, startMs: 1_000, endMs: 121_000, ok: true, inconclusive: false },
    ]
    expect(blackoutFaultWindow(runs)).toEqual({ startedAtMs: 1_000, recoveredAtMs: 121_000 })
    expect(blackoutAcceptanceDeadline(121_000)).toBe(181_000)
    expect(blackoutFaultWindow([{ ...runs[0], ok: false }])).toBeNull()
  })
  it("accepts T9 isolation only after the 30 s grace and before blackout recovery", () => {
    const window = { startedAtMs: 1_000, recoveredAtMs: 121_000 }
    expect(isolationWithinBlackout(1_000 + BLACKOUT_ISOLATION_MIN_MS, window)).toBe(true)
    expect(isolationWithinBlackout(121_000, window)).toBe(true)
    expect(isolationWithinBlackout(1_000 + BLACKOUT_ISOLATION_MIN_MS - 1, window)).toBe(false)
    expect(isolationWithinBlackout(121_001, window)).toBe(false)
    expect(isolationWithinBlackout(null, window)).toBe(false)
  })
  it("requires both a conclusive restore run and every browser recovery edge", () => {
    const window = { startedAtMs: 1_000, recoveredAtMs: 121_000 }
    expect(blackoutRecoveryObserved(window, [true, true])).toBe(true)
    expect(blackoutRecoveryObserved(window, [true, false])).toBe(false)
    expect(blackoutRecoveryObserved(window, [])).toBe(false)
    expect(blackoutRecoveryObserved(null, [true])).toBe(false)
  })

  it("baseline (no profile) touches nothing", () => expect(networkPlan(null)).toEqual({ start: [], timeline: [], atOpen: [] }))
  it("wifi apply + show", () => {
    expect(networkPlan(profileFor(1))).toEqual({ start: [["apply", "wifi"], ["show"]], timeline: [], atOpen: [] })
  })
  it("relay-only blocks UDP after the shaping", () => {
    expect(networkPlan(profileFor(3)).start).toEqual([["apply", "wifi"], ["block-udp"], ["show"]])
  })
  it("switchAtTurn is sugar for one timeline step: swap, then blackout", () => {
    expect(networkPlan(profileFor(4)).timeline).toEqual([{ atTurn: 2, calls: [["swap", "lte-good"], ["blackout", "15"]] }])
  })
  it("keeps game259 on wifi until the final group's 5/5 channels open, then runs a bounded burst over 17% loss", () => {
    expect(networkPlan(profileByName("game259-lossy-video"))).toEqual({
      start: [["apply", "wifi"], ["show"]],
      timeline: [
        {
          atRoundChannelsOpen: { round: 2, count: 5, byGameS: 105 },
          boundedBurst: { holdMs: 15_000, restoreProfile: "game259-lossy" },
          calls: [["swap", "game259-lossy"], ["custom", "100", "40", "65", "2"], ["swap", "game259-lossy"]],
        },
      ],
      atOpen: [],
    })
  })
  it("a timeline: a 10 s loss spike on the current link, a recovery swap, a late blackout", () => {
    const p = { ...profileFor(1), network: { profile: "lte-good", relayOnly: false, timeline: [{ atTurn: 4, lossPct: 30, forS: 10 }, { atTurn: 6, profile: "wifi" }, { atS: 100, rateMbit: 0.5, blackoutS: 3 }] } }
    expect(networkPlan(p).timeline).toEqual([
      { atTurn: 4, calls: [["spike", "10", "50", "10", "30", "20"]] },
      { atTurn: 6, calls: [["swap", "wifi"]] },
      { atS: 100, calls: [["custom", "50", "10", "0.1", "0.5"], ["blackout", "3"]] },
    ])
  })
})

describe("outage targets", () => {
  it("the People RPC and statement-store hosts equal the ones the slots use, per network", async () => {
    const { NETWORKS } = await import("../lib/host-slot.mjs")
    for (const n of ["previewnet", "paseo-next-v2"] as const) {
      expect(OUTAGE_TARGETS[n]["people-rpc"]).toBe(new URL(NETWORKS[n].peopleWs).hostname)
      expect(OUTAGE_TARGETS[n]["statement-store"]).toBe(OUTAGE_TARGETS[n]["people-rpc"])
    }
  })
  it("both networks name the same four targets, or say why one can not be isolated", () => {
    const named = (network: keyof typeof OUTAGE_TARGETS) => [...Object.keys(OUTAGE_TARGETS[network]), ...Object.keys(ISOLATION_GAPS[network])].sort()
    expect(named("previewnet")).toEqual(named("paseo-next-v2"))
    for (const network of ["previewnet", "paseo-next-v2"] as const) {
      for (const target of Object.keys(ISOLATION_GAPS[network])) expect(OUTAGE_TARGETS[network][target]).toBeUndefined()
    }
  })
})

describe("the chaos outage profiles", () => {
  it("the TURN issuer is the device-uniqueness backend of the network the slots build for, where a host can isolate it", async () => {
    const { NETWORK_CONFIG } = await import("../../packages/jollity-protocol/src/config")
    // dev-host.mjs builds NEXT_PUBLIC_NETWORK_NAME=paseo for paseo-next-v2 and previewnet for previewnet
    expect(OUTAGE_TARGETS["paseo-next-v2"]["turn-issuer"]).toBe(new URL(NETWORK_CONFIG.paseo.deviceUniquenessBackendUrl).hostname)
    // previewnet serves it under a path of the chains' own host, which netem (a host cut) can not isolate
    expect(new URL(NETWORK_CONFIG.previewnet.deviceUniquenessBackendUrl).hostname).toBe(OUTAGE_TARGETS.previewnet["people-rpc"])
    expect(OUTAGE_TARGETS.previewnet["turn-issuer"]).toBeUndefined()
    expect(() => outageHost("turn-issuer", "previewnet")).toThrow(/can not run on previewnet.*chains too/)
  })
  it("the TURN relay is the host the app's permission list names", () => {
    const perms = readFileSync(join(__dirname, "../../apps/jollity-app/lib/permissions.ts"), "utf8")
    for (const n of ["previewnet", "paseo-next-v2"] as const) expect(perms).toContain(`"${OUTAGE_TARGETS[n]["turn-relay"]}", // TURN relay`)
  })
  it("chain-outage cuts the People RPC (statement store, chain reads) for 10 s at a turn, on the run's network", () => {
    for (const n of ["previewnet", "paseo-next-v2"] as const) {
      const plan = networkPlan(profileByName("chain-outage"), undefined, n)
      expect(plan.timeline).toEqual([{ atTurn: 4, calls: [["outage", OUTAGE_TARGETS[n]["people-rpc"], "10"]] }])
      expect(plan.atOpen).toEqual([])
    }
  })
  it("turn-issuer-outage fires at app open (off the timeline) for longer than ice.ts's 15 s retry budget", () => {
    expect(networkPlan(profileByName("turn-issuer-outage"), undefined, "paseo-next-v2").atOpen).toEqual([{ calls: [["outage", "identity.parity-prod.parity.io", "20"]] }])
    // no previewnet plan: the outage would cut the chains too, so the profile refuses rather than test something else
    expect(() => networkPlan(profileByName("turn-issuer-outage"), undefined, "previewnet")).toThrow(/turn-issuer.*previewnet/)
  })
  it("relay-outage blocks the relay for 10 s on a relay-only bot", () => {
    const p = profileByName("relay-outage")
    const plan = networkPlan(p)
    expect(plan.start).toContainEqual(["block-udp"])
    expect(plan.timeline).toEqual([{ atTurn: 4, calls: [["outage", "turn.cloudflare.com", "10"]] }])
  })
  it("pins #724/#757's registered-player personas to their pre-game outage and recovery edges", () => {
    const returning = profileByName("turn-warm-returning")
    expect(returning.acceptanceOnly).toBe(true)
    expect(returning.expect).toContainEqual(expect.objectContaining({ kind: "event", name: "network.turn-receipt", attrs: { "turn.received": "true", "turn.source": "warmup" } }))
    // pinned to the persona's issuer cut on the one network that can isolate it; previewnet refuses it (see ISOLATION_GAPS)
    expect(networkPlan(returning, undefined, "paseo-next-v2").timeline).toEqual([
      { atBeforeGameS: 90, calls: [["outage", OUTAGE_TARGETS["paseo-next-v2"]["turn-issuer"], "120"]] },
    ])
    expect(() => networkPlan(returning, undefined, "previewnet")).toThrow(/previewnet/)

    const blocked = profileByName("network-blocked")
    expect(blocked.acceptanceOnly).toBe(true)
    expect(blocked.expect).toContainEqual(expect.objectContaining({ kind: "text", text: "Restart the Polkadot app", never: true }))
    expect(blocked.expect).toContainEqual(expect.objectContaining({ kind: "event", name: "network.waiting-check", attrs: { "waiting_check.result": "blocked", "waiting_check.trigger": "network-change" } }))
    expect(networkPlan(blocked).timeline).toEqual([
      { atBeforeGameS: 300, concurrent: true, calls: [["outage", OUTAGE_TARGETS.previewnet["turn-relay"], "298"]] },
      { atBeforeGameS: 2, calls: [["allow-udp"], ["swap", "lte-good"]] },
    ])
  })
})

describe("netem call bounds", () => {
  it("uses each blocking call's own duration plus margin", () => {
    expect(netemCallTimeoutMs(["outage", "example.test", "298"])).toBe(298_000 + NETEM_TIMEOUT_MARGIN_MS)
    expect(netemCallTimeoutMs(["host-chain-hang", "90", "example.test"])).toBe(90_000 + NETEM_TIMEOUT_MARGIN_MS)
    expect(netemCallTimeoutMs(["blackout", "5"])).toBe(120_000)
    expect(netemCallTimeoutMs(["swap", "lte-good"])).toBe(120_000)
  })
})

describe("the WebRTC path cut and the video stall", () => {
  it("udp-cut-40s cuts UDP and the relay for 40 s at turn 4, keeping the People RPC up", () => {
    expect(networkPlan(profileByName("udp-cut-40s")).timeline).toEqual([{ atTurn: 4, calls: [["udp-cut", "40", OUTAGE_TARGETS.previewnet["turn-relay"], OUTAGE_TARGETS.previewnet["people-rpc"]]] }])
    // on paseo the People RPC it keeps up is paseo's
    expect(networkPlan(profileByName("udp-cut-40s"), undefined, "paseo-next-v2").timeline[0]!.calls[0]).toEqual(["udp-cut", "40", OUTAGE_TARGETS["paseo-next-v2"]["turn-relay"], OUTAGE_TARGETS["paseo-next-v2"]["people-rpc"]])
  })
  it("video-stall-30s blackholes video for 30 s at turn 4", () => {
    expect(networkPlan(profileByName("video-stall-30s")).timeline).toEqual([{ atTurn: 4, calls: [["video-stall", "30"]] }])
  })
  it("rides along with a change of the link in the same step", () => {
    const p = { ...profileFor(1), network: { profile: "wifi", relayOnly: false, timeline: [{ atTurn: 2, videoStallS: 10, profile: "lte-poor" }] } }
    expect(networkPlan(p).timeline[0].calls).toEqual([["video-stall", "10"], ["swap", "lte-poor"]])
  })
  it("netem.sh knows the path verbs, can unblock relay-only UDP, and cleans cuts on clear", () => {
    const sh = readFileSync(join(__dirname, "netem.sh"), "utf8")
    expect(sh).toMatch(/udp-cut\) shift; cmd_udp_cut/)
    expect(sh).toMatch(/video-stall\) shift; cmd_video_stall/)
    expect(sh).toMatch(/allow-udp\) cmd_allow_udp/)
    const allowUdp = sh.slice(sh.indexOf("cmd_allow_udp()"), sh.indexOf("OUTAGE_CHAIN="))
    expect(allowUdp).toContain("setup_root")
    expect(allowUdp).toMatch(/iptables -w -D OUTPUT/)
    expect(allowUdp).toContain('require_hook_absent iptables "allow-udp IPv4 OUTPUT hook" OUTPUT')
    expect(allowUdp).toContain('require_hook_absent iptables "allow-udp IPv4 DROP rule" "$UDP_CHAIN"')
    expect(sh).toMatch(/udp_cut_off\n {2}video_stall_off/)
  })
})

describe("the stuck-host hang", () => {
  it("drops the signing host's People-RPC traffic without using the legacy cut", () => {
    const p = { ...profileFor(1), network: { profile: "wifi", relayOnly: false, timeline: [{ atTurn: 4, hostChainHangS: 30 }] } }
    expect(networkPlan(p, undefined, "previewnet").timeline).toEqual([{ atTurn: 4, calls: [["host-chain-hang", "30", "previewnet.substrate.dev"]] }])
  })
  it("pins the two #726 personas to chain-derived waiting and in-game triggers", () => {
    expect(networkPlan(profileByName("host-stuck-waiting")).timeline).toEqual([{ atBeforeGameS: 300, calls: [["host-chain-hang", "120", "previewnet.substrate.dev"]] }])
    expect(networkPlan(profileByName("host-stuck-in-game")).timeline).toEqual([{ atTurn: 4, calls: [["host-chain-hang", "110", "previewnet.substrate.dev"]] }])
  })
})

describe("targeted outages", () => {
  it("name an endpoint, resolve it to a host and last forS", () => {
    const p = { ...profileFor(1), network: { profile: "wifi", relayOnly: false, timeline: [{ atTurn: 5, outage: "people-rpc", forS: 20 }, { atS: 60, outage: "turn.example.org", forS: 5 }] } }
    expect(networkPlan(p, undefined, "previewnet").timeline[0].calls).toEqual([["outage", "previewnet.substrate.dev", "20"]])
    const t = networkPlan(p, undefined, "paseo-next-v2").timeline
    expect(t[0].calls).toEqual([["outage", "paseo-people-next-system-rpc.polkadot.io", "20"]])
    expect(t[1].calls).toEqual([["outage", "turn.example.org", "5"]])
  })
})

describe("dueSteps", () => {
  const plan = [{ atTurn: 3, calls: [] }, { atS: 50, calls: [] }]
  it("fires by turn or by seconds since the start, once", () => {
    expect(dueSteps(plan, new Set(), { turn: 2, sinceStartS: 10 })).toEqual([])
    expect(dueSteps(plan, new Set(), { turn: 3, sinceStartS: 10 })).toEqual([0])
    expect(dueSteps(plan, new Set([0]), { turn: 9, sinceStartS: 60 })).toEqual([1])
    expect(dueSteps(plan, new Set(), { turn: null, sinceStartS: null })).toEqual([])
  })
})

describe("netemEnabled", () => {
  it("only on a Linux CI runner", () => {
    expect(netemEnabled({ CI: "true" }, "linux").on).toBe(true)
    expect(netemEnabled({ CI: "true" }, "darwin").on).toBe(false)
    expect(netemEnabled({}, "linux").on).toBe(false)
    expect(netemEnabled({ CI: "true", E2E_NETEM: "0" }, "linux").why).toBe("E2E_NETEM=0")
  })
})

describe("NetworkController", () => {
  const controller = (plan: NetworkPlan, options: Partial<ConstructorParameters<typeof NetworkController>[0]> = {}) => {
    const calls: NetemCall[] = []
    const lines: string[] = []
    const problems: string[] = []
    const instance = new NetworkController({
      plan,
      active: true,
      run: async (call) => {
        calls.push(call)
        return "ok"
      },
      write: (line) => lines.push(line),
      say: () => undefined,
      now: () => "2026-10-06T10:00:00.000Z",
      problems,
      ...options,
    })
    return { instance, calls, lines, problems }
  }

  it("narrates preparing before execution, active at the marker, and recovery only after a successful process exit", async () => {
    const events: NetworkNarrationEvent[] = []
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 2, calls: [["blackout", "5"]] }] }
    const { instance } = controller(plan, {
      onNarration: (event) => events.push(event),
      run: async (_call, onLifecycle) => {
        expect(events.map(({ state }) => state)).toEqual(["preparing"])
        onLifecycle?.({ state: "active", detail: "blackout" })
        onLifecycle?.({ state: "restored", detail: "blackout" })
        expect(events.map(({ state }) => state)).toEqual(["preparing", "active"])
        await done
        return "ok"
      },
    })

    instance.onTurn({ turn: 2, sinceStartS: 0 })
    await Promise.resolve()
    expect(events.map(({ state }) => state)).toEqual(["preparing", "active"])
    finish()
    await instance.drain()
    expect(events).toEqual([
      { step: 1, state: "preparing", role: "step" },
      { step: 1, state: "active", role: "action", detail: "blackout" },
      { step: 1, state: "restored", role: "action", detail: "blackout" },
    ])
  })

  it("never invents active or recovery when execution fails before the active marker", async () => {
    const events: NetworkNarrationEvent[] = []
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 1, calls: [["outage", "example.test", "5"]] }] }
    const { instance } = controller(plan, {
      onNarration: (event) => events.push(event),
      run: async () => { throw new Error("apply failed") },
    })

    instance.onTurn({ turn: 1, sinceStartS: 0 })
    await instance.drain()
    expect(events.map(({ state }) => state)).toEqual(["preparing", "failed"])
  })

  it("records a deliberately disabled network step as not applied instead of failed", async () => {
    const events: NetworkNarrationEvent[] = []
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 1, calls: [["outage", "example.test", "5"]] }] }
    const { instance } = controller(plan, {
      active: false,
      inactiveReason: "E2E_NETEM=0",
      onNarration: (event) => events.push(event),
    })

    instance.onTurn({ turn: 1, sinceStartS: 0 })
    await instance.drain()
    expect(events.map(({ state }) => state)).toEqual(["preparing", "not-applied"])
  })

  it("buffers a restored marker and reports failure instead of false recovery when the process exits unsuccessfully", async () => {
    const events: NetworkNarrationEvent[] = []
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 1, calls: [["video-stall", "5"]] }] }
    const { instance } = controller(plan, {
      onNarration: (event) => events.push(event),
      run: async (_call, onLifecycle) => {
        onLifecycle?.({ state: "active", detail: "video-stall" })
        onLifecycle?.({ state: "restored", detail: "video-stall" })
        throw new Error("restore proof failed")
      },
    })

    instance.onTurn({ turn: 1, sinceStartS: 0 })
    await instance.drain()
    expect(events.map(({ state }) => state)).toEqual(["preparing", "active", "failed"])
  })

  it("keeps an inconclusive netem outcome distinct from failure", async () => {
    const events: NetworkNarrationEvent[] = []
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 1, calls: [["host-chain-cut", "5", "5", "host"]] }] }
    const { instance } = controller(plan, {
      onNarration: (event) => events.push(event),
      run: async (_call, onLifecycle) => {
        onLifecycle?.({ state: "active", detail: "host-chain-cut" })
        throw new NetemError("host side only INCONCLUSIVE", NETEM_INCONCLUSIVE_EXIT)
      },
    })

    instance.onTurn({ turn: 1, sinceStartS: 0 })
    await instance.drain()
    expect(events.map(({ state }) => state)).toEqual(["preparing", "active", "inconclusive"])
  })

  it("retains each concurrent step's own one-based narration index", async () => {
    const events: NetworkNarrationEvent[] = []
    const plan: NetworkPlan = {
      start: [],
      atOpen: [],
      timeline: [
        { atTurn: 1, concurrent: true, calls: [["blackout", "5"]] },
        { atTurn: 1, concurrent: true, calls: [["video-stall", "5"]] },
      ],
    }
    const { instance } = controller(plan, {
      onNarration: (event) => events.push(event),
      run: async (call, onLifecycle) => {
        onLifecycle?.({ state: "active", detail: call[0] })
        onLifecycle?.({ state: "restored", detail: call[0] })
        return "ok"
      },
    })

    instance.onTurn({ turn: 1, sinceStartS: 0 })
    await instance.drainBackground()
    for (const step of [1, 2]) {
      expect(events.filter((event) => event.step === step).map(({ state }) => state)).toEqual(["preparing", "active", "restored"])
    }
  })

  it("labels bounded-burst setup, action and restore lifecycle so the presentation can choose what to show", async () => {
    const events: NetworkNarrationEvent[] = []
    const plan: NetworkPlan = {
      start: [],
      atOpen: [],
      timeline: [{
        atTurn: 1,
        boundedBurst: { holdMs: 15_000, restoreProfile: "game259-lossy" },
        calls: [["swap", "game259-lossy"], ["custom", "100", "40", "65", "2"], ["swap", "game259-lossy"]],
      }],
    }
    let callIndex = 0
    const { instance } = controller(plan, {
      onNarration: (event) => events.push(event),
      sleep: async () => undefined,
      run: async (call, onLifecycle) => {
        callIndex += 1
        onLifecycle?.({ state: "active", detail: call[0] })
        return "ok"
      },
    })

    instance.onTurn({ turn: 1, sinceStartS: 0 })
    await instance.drain()
    expect(callIndex).toBe(3)
    expect(events).toEqual([
      { step: 1, state: "preparing", role: "step" },
      { step: 1, state: "active", role: "setup", detail: "swap" },
      { step: 1, state: "active", role: "action", detail: "custom" },
      { step: 1, state: "active", role: "restore", detail: "swap" },
    ])
  })

  it("owns initial shaping, serial at-open work, and one final clear", async () => {
    const plan: NetworkPlan = {
      start: [["apply", "wifi"], ["show"]],
      timeline: [],
      atOpen: [{ calls: [["outage", "turn.example", "10"]] }],
    }
    let release!: () => void
    const outage = new Promise<void>((resolve) => { release = resolve })
    const { instance, calls } = controller(plan, {
      run: async (call) => {
        calls.push(call)
        if (call[0] === "outage") await outage
        return "ok"
      },
    })
    await instance.start({ bootOnly: false })
    expect(calls).toEqual([["apply", "wifi"], ["show"], ["outage", "turn.example", "10"]])
    let stopped = false
    const stop = instance.stop({ clear: true }).then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    await stop
    expect(calls).toEqual([["apply", "wifi"], ["show"], ["outage", "turn.example", "10"], ["clear"]])
    await instance.stop({ clear: true })
    expect(calls.filter(([verb]) => verb === "clear")).toHaveLength(1)
  })

  it("clears an active link inherited from boot even when this controller did not apply it", async () => {
    const plan: NetworkPlan = { start: [["apply", "game259-lossy"]], timeline: [], atOpen: [] }
    const { instance, calls } = controller(plan, { sleep: async () => undefined })

    await instance.stop({ clear: true })

    expect(calls).toEqual([["clear"]])
  })

  it("retries post-play cleanup without replacing the primary play result", async () => {
    const plan: NetworkPlan = { start: [["apply", "game259-lossy"]], timeline: [], atOpen: [] }
    const calls: NetemCall[] = []
    const failures: string[] = []
    const instance = new NetworkController({
      plan,
      active: true,
      run: async (call) => {
        calls.push(call)
        if (calls.length === 1) throw new Error("first clear failed")
        return "ok"
      },
      say: () => undefined,
    })

    await expect(clearNetworkAfterPlay(instance, (message) => failures.push(message))).resolves.toEqual({ ok: true, failures })
    expect(calls).toEqual([["clear"], ["clear"]])
    expect(failures).toEqual([expect.stringContaining("first clear failed")])
  })

  it("returns a terminal cleanup failure for a failing role check without throwing over play", async () => {
    const failures: string[] = []
    const instance = new NetworkController({
      plan: { start: [], timeline: [], atOpen: [] },
      active: true,
      run: async () => { throw new Error("clear stayed broken") },
      say: () => undefined,
    })
    await expect(clearNetworkAfterPlay(instance, (message) => failures.push(message))).resolves.toEqual({ ok: false, failures })
    expect(failures).toHaveLength(2)
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    expect(source).toContain('name: "post-play network cleanup"')
    expect(source).toContain('status: "fail"')
  })

  it("cleans the link in play's failure-safe exit before settlement starts", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    const playFinally = source.indexOf("// A failed play must not let a future pre-game timer")
    const clear = source.indexOf("await clearNetworkAfterPlay(networkController", playFinally)
    const settlement = source.indexOf('test("(d) settlement:', playFinally)
    expect(playFinally).toBeGreaterThan(-1)
    expect(clear).toBeGreaterThan(playFinally)
    expect(clear).toBeLessThan(settlement)
  })

  it("fires a registered player's waiting-room hang exactly once at its chain-derived offset", async () => {
    const plan: NetworkPlan = { start: [], timeline: [{ atBeforeGameS: 300, calls: [["host-chain-hang", "90", "h"]] }], atOpen: [] }
    const { instance, calls } = controller(plan)
    expect(instance.onBeforeGame(300)).toEqual([{ turn: 0, applied: true, calls: plan.timeline[0].calls }])
    expect(instance.onBeforeGame(300)).toEqual([])
    await instance.drain()
    expect(calls).toEqual([["host-chain-hang", "90", "h"]])
  })

  it("arms every pre-game timeline step from data while leaving turn steps for the play loop", async () => {
    const plan: NetworkPlan = {
      start: [["apply", "wifi"]],
      timeline: [
        { atBeforeGameS: 75, calls: [["swap", "game259-negotiation-burst"]] },
        { atTurn: 1, calls: [["swap", "game259-lossy"]] },
      ],
      atOpen: [],
    }
    const { instance, calls } = controller(plan)
    let release!: () => void
    const rows: NetworkStepEvidence[] = []
    const scheduled = scheduleBeforeGameSteps(plan, 1_000, (chainS) => chainS * 1000, (beforeS) => instance.onBeforeGame(beforeS), {
      nowMs: () => 900_000,
      sleep: (ms) => new Promise<void>((resolve) => {
        expect(ms).toBe(25_000)
        release = resolve
      }),
      onRows: (fired) => rows.push(...fired),
    })

    expect([...scheduled.keys()]).toEqual([75])
    expect(calls).toEqual([])
    release()
    await scheduled.get(63)
    await instance.drain()
    expect(calls).toEqual([["swap", "game259-negotiation-burst"]])
    expect(rows).toEqual([{ turn: 0, applied: true, calls: [["swap", "game259-negotiation-burst"]] }])
    expect(instance.onTurn({ turn: 1, sinceStartS: 0 })).toEqual([{ turn: 1, applied: true, calls: [["swap", "game259-lossy"]] }])
  })

  it("cancels pending pre-game steps without firing or recording them", async () => {
    const plan: NetworkPlan = {
      start: [],
      timeline: [
        { atBeforeGameS: 75, calls: [["swap", "game259-negotiation-burst"]] },
        { atBeforeGameS: 2, calls: [["swap", "lte-good"]] },
      ],
      atOpen: [],
    }
    const { instance, calls } = controller(plan)
    const releases: Array<() => void> = []
    const scheduled = scheduleBeforeGameSteps(plan, 1_000, (chainS) => chainS * 1000, (beforeS) => instance.onBeforeGame(beforeS), {
      nowMs: () => 900_000,
      sleep: () => new Promise<void>((resolve) => releases.push(resolve)),
    })

    scheduled.cancel(2)
    scheduled.cancel()
    expect(await scheduled.get(75)).toEqual([])
    expect(await scheduled.get(2)).toEqual([])
    for (const release of releases) release()
    await Promise.resolve()
    expect(calls).toEqual([])
    expect(instance.snapshot().fired).toBe(0)
  })

  it("can defer a setup-sensitive pre-game step until its setup has relaunched", () => {
    const plan: NetworkPlan = {
      start: [],
      timeline: [{ atBeforeGameS: 90, calls: [["outage", "issuer", "45"]] }],
      atOpen: [],
    }
    const scheduled = scheduleBeforeGameSteps(plan, 1_000, (chainS) => chainS * 1000, () => [], {
      nowMs: () => 900_000,
      excludeSeconds: [90],
    })
    expect([...scheduled.keys()]).toEqual([])
  })

  it("does not burst before the full channel gate and fires exactly at 5/5", async () => {
    const plan: NetworkPlan = {
      start: [["apply", "wifi"]],
      timeline: [{
        atRoundChannelsOpen: { round: 1, count: 5, byGameS: 30 },
        boundedBurst: { holdMs: 15_000, restoreProfile: "game259-lossy" },
        calls: [["swap", "game259-lossy"], ["custom", "100", "40", "65", "2"], ["swap", "game259-lossy"]],
      }],
      atOpen: [],
    }
    const { instance, calls } = controller(plan, { sleep: async () => undefined })

    expect(instance.onRoundChannelsOpen(1, 4)).toEqual([])
    await instance.drain()
    expect(calls).toEqual([])
    expect(instance.onRoundChannelsOpen(1, 5)).toEqual([{ turn: 0, applied: true, calls: plan.timeline[0].calls }])
    expect(instance.onRoundChannelsOpen(1, 6)).toEqual([])
    await instance.drain()
    expect(calls).toEqual(plan.timeline[0].calls)
  })

  it("fires the planned burst when the finalized group narrows its live gate from five peers to four", async () => {
    const plannedGate = { round: 2, count: 5, byGameS: 105 }
    const plan: NetworkPlan = {
      start: [["apply", "wifi"]],
      timeline: [{
        atRoundChannelsOpen: plannedGate,
        boundedBurst: { holdMs: 15_000, restoreProfile: "game259-lossy" },
        calls: [["swap", "game259-lossy"], ["custom", "100", "40", "65", "2"], ["swap", "game259-lossy"]],
      }],
      atOpen: [],
    }
    const { instance, calls } = controller(plan, { sleep: async () => undefined })
    const effectiveGate = { ...plannedGate, count: 4 }

    expect(instance.onRoundChannelsOpen(2, 3, undefined, { planned: plannedGate, effective: effectiveGate })).toEqual([])
    expect(instance.onRoundChannelsOpen(2, 4, undefined, {
      planned: { ...plannedGate, count: 6 },
      effective: effectiveGate,
    })).toEqual([])
    expect(instance.onRoundChannelsOpen(2, 4, undefined, {
      planned: plannedGate,
      effective: effectiveGate,
    })).toEqual([
      { turn: 0, applied: true, calls: plan.timeline[0].calls },
    ])
    await instance.drain()
    expect(calls).toEqual(plan.timeline[0].calls)
  })

  it("awaits the 65% apply, invokes the hook, holds 15 seconds, and restores in finally", async () => {
    let nowMs = 1_000
    const events: string[] = []
    const plan: NetworkPlan = {
      start: [],
      timeline: [{
        atRoundChannelsOpen: { round: 1, count: 5, byGameS: 30 },
        boundedBurst: { holdMs: 15_000, restoreProfile: "game259-lossy" },
        calls: [["swap", "game259-lossy"], ["custom", "100", "40", "65", "2"], ["swap", "game259-lossy"]],
      }],
      atOpen: [],
    }
    const { instance } = controller(plan, {
      nowMs: () => nowMs,
      run: async (call) => { events.push(`run:${call.join(" ")}`); nowMs += 10; return "ok" },
      sleep: async (ms) => { events.push(`sleep:${ms}`); nowMs += ms },
    })
    instance.onRoundChannelsOpen(1, 5, async () => { events.push("hook") })
    await instance.drain()
    expect(events).toEqual([
      "run:swap game259-lossy",
      "run:custom 100 40 65 2",
      "hook",
      "sleep:15000",
      "run:swap game259-lossy",
    ])
    expect(instance.snapshot().problems).toEqual([])
  })

  it("restores immediately when the post-apply hook fails instead of holding the impairment", async () => {
    const events: string[] = []
    const plan: NetworkPlan = {
      start: [],
      timeline: [{
        atRoundChannelsOpen: { round: 1, count: 5, byGameS: 30 },
        boundedBurst: { holdMs: 15_000, restoreProfile: "game259-lossy" },
        calls: [["swap", "game259-lossy"], ["custom", "100", "40", "65", "2"], ["swap", "game259-lossy"]],
      }],
      atOpen: [],
    }
    const { instance } = controller(plan, {
      run: async (call) => { events.push(`run:${call.join(" ")}`); return "ok" },
      sleep: async (ms) => { events.push(`sleep:${ms}`) },
    })
    instance.onRoundChannelsOpen(1, 5, async () => { events.push("hook"); throw new Error("NOT PROVEN") })
    await instance.drain()
    expect(events).toEqual([
      "run:swap game259-lossy", "run:custom 100 40 65 2", "hook", "run:swap game259-lossy",
    ])
    expect(instance.snapshot().problems).toEqual([expect.stringContaining("renegotiation hook failed: NOT PROVEN")])
  })

  it("deduplicates round-1 channel opens and proves the burst starts only after the fifth", () => {
    const lines = [
      { tag: "rtc", message: "[jollity-rtc] round-link stage=channel-open round=1 peer=A", ts: 1_000 },
      { tag: "rtc", message: "[jollity-rtc] round-link stage=channel-open round=1 peer=A", ts: 1_100 },
      { tag: "rtc", message: "[jollity-rtc] round-link stage=channel-open round=1 peer=B", ts: 1_200 },
      { tag: "rtc", message: "[jollity-rtc] round-link stage=channel-open round=2 peer=ignored", ts: 1_300 },
      { tag: "rtc", message: "[jollity-rtc] round-link stage=channel-open round=1 peer=C", ts: 1_400 },
      { tag: "rtc", message: "[jollity-rtc] round-link stage=channel-open round=1 peer=D", ts: 1_500 },
      { tag: "rtc", message: "[jollity-rtc] round-link stage=channel-open round=1 peer=E", ts: 1_600 },
    ]
    expect(roundChannelOpenPeers(lines, 1)).toEqual(new Map([["A", 1_000], ["B", 1_200], ["C", 1_400], ["D", 1_500], ["E", 1_600]]))
    const runs = [{
      step: 1,
      call: ["swap", "game259-lossy"] as NetemCall,
      startMs: 1_600,
      endMs: 1_610,
      ok: true,
      inconclusive: false,
    }, {
      step: 1,
      call: ["custom", "100", "40", "65", "2"] as NetemCall,
      startMs: 1_610,
      endMs: 1_620,
      ok: true,
      inconclusive: false,
    }, {
      step: 1,
      call: ["swap", "game259-lossy"] as NetemCall,
      startMs: 16_620,
      endMs: 16_630,
      ok: true,
      inconclusive: false,
    }]
    for (const [index, peer] of ["A", "B", "C", "D", "E"].entries()) {
      const base = peer === "E" ? 17_000 : 1_700 + index * 10
      lines.push(
        { tag: "rtc", message: `[jollity-rtc] e2e-renegotiation stage=requested request=game259-round-1-burst round=1 generation=2 peer=${peer}`, ts: base },
        { tag: "rtc", message: `[jollity-rtc] e2e-renegotiation stage=offer-sent request=game259-round-1-burst round=1 generation=2 peer=${peer}`, ts: base + 1 },
        { tag: "rtc", message: `[jollity-rtc] e2e-renegotiation stage=answer-received request=game259-round-1-burst round=1 generation=2 peer=${peer}`, ts: base + 2 },
        { tag: "rtc", message: `[jollity-rtc] e2e-renegotiation stage=fresh-video request=game259-round-1-burst round=1 generation=2 peer=${peer}`, ts: base + 3 },
      )
    }
    expect(postOpenBurstChecks(7, lines, runs, { round: 1, count: 5, baseProfile: "game259-lossy", burstS: 15, requestId: "game259-round-1-burst" })).toEqual([
      expect.objectContaining({ status: "pass", detail: expect.stringContaining("10 ms after the 5th distinct channel opened") }),
      expect.objectContaining({ status: "pass", detail: expect.stringContaining("15 s") }),
      expect.objectContaining({ status: "pass", detail: expect.stringContaining("exactly one request") }),
    ])
    lines.push({
      tag: "rtc",
      message: "[jollity-rtc] e2e-renegotiation stage=request-dropped request=game259-round-1-burst round=1 generation=2 peer=A reason=\"signaling have-local-offer\"",
      ts: 1_705,
    })
    expect(postOpenBurstChecks(7, lines, runs, { round: 1, count: 5, baseProfile: "game259-lossy", burstS: 15, requestId: "game259-round-1-burst" })[2]).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("NOT PROVEN"),
    })
  })

  it("filters the 27 October standby union to the finalized five-peer group", () => {
    const lines = [
      ...["active-a", "active-b", "active-c", "active-d", "active-e", "standby-a", "standby-b", "standby-c"]
        .map((peer, index) => ({
          tag: "rtc",
          message: `[jollity-rtc] round-link stage=channel-open round=2 peer=${peer}`,
          ts: 1_000 + index,
        })),
    ]
    expect([...roundChannelOpenPeers(lines, 2, ["active-a", "active-b", "active-c", "active-d", "active-e"]).keys()]).toEqual([
      "active-a", "active-b", "active-c", "active-d", "active-e",
    ])
  })

  it("fails closed for missing per-link proof and an inconclusive burst", () => {
    const lines = ["A", "B", "C", "D", "E"].map((peer, index) => ({
      tag: "rtc", message: `[jollity-rtc] round-link stage=channel-open round=1 peer=${peer}`, ts: 1_000 + index,
    }))
    const runs = [
      { step: 1, call: ["swap", "game259-lossy"] as NetemCall, startMs: 1_010, endMs: 1_020, ok: true, inconclusive: false },
      { step: 1, call: ["custom", "100", "40", "65", "2"] as NetemCall, startMs: 1_020, endMs: 1_030, ok: true, inconclusive: true },
      { step: 1, call: ["swap", "game259-lossy"] as NetemCall, startMs: 16_030, endMs: 16_040, ok: true, inconclusive: false },
    ]
    const checks = postOpenBurstChecks(7, lines, runs, { round: 1, count: 5, baseProfile: "game259-lossy", burstS: 15, requestId: "game259-round-1-burst" })
    expect(checks[1]).toMatchObject({ status: "fail" })
    expect(checks[2]).toMatchObject({ status: "fail", detail: expect.stringContaining("NOT PROVEN") })
  })

  it("returns an explicit NOT PROVEN result when all channels never open by the bound", async () => {
    let nowMs = 1_000
    const result = await waitForRoundChannelGate({
      gate: { round: 1, count: 5, byGameS: 30 },
      deadlineMs: 1_250,
      readLines: async () => Array.from({ length: 4 }, (_, i) => ({
        tag: "rtc",
        message: `[jollity-rtc] round-link stage=channel-open round=1 peer=P${i}`,
        ts: 900 + i,
      })),
      fire: () => { throw new Error("must not fire") },
      nowMs: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      pollMs: 100,
    })
    expect(result).toEqual({
      status: "not-proven",
      peers: 4,
      detail: "round-1 channel gate NOT PROVEN: 4/5 distinct channels open by game T+30 s",
      rows: [],
    })
  })

  it("waits past round-2 channel markers until earlier-only peers are removed", async () => {
    // Anonymized 27 October ordering: five active markers were present while
    // the mesh still held three earlier-only links; removal landed milliseconds later.
    let nowMs = 1_000
    let reads = 0
    let fireCalls = 0
    const active = ["active-a", "active-b", "active-c", "active-d", "active-e"]
    const stale = ["old-a", "old-b", "old-c"]
    const result = await waitForRoundChannelGate({
      gate: { round: 2, count: 5, byGameS: 105 },
      peerIds: active,
      removedPeerIds: stale,
      deadlineMs: 2_000,
      readLines: async () => {
        reads += 1
        return [
          ...active.map((peer, index) => ({ tag: "rtc", message: `[jollity-rtc] round-link stage=channel-open round=2 peer=${peer}`, ts: 900 + index })),
          ...(reads < 2 ? [] : stale.map((peer, index) => ({ tag: "rtc", message: `[jollity-rtc] no round left with: ${peer}`, ts: 910 + index }))),
        ]
      },
      fire: () => { fireCalls += 1; return [] },
      nowMs: () => nowMs,
      sleep: async (ms) => { nowMs += ms },
      pollMs: 100,
    })

    expect(result.status).toBe("fired")
    expect(reads).toBe(2)
    expect(fireCalls).toBe(1)
  })

  it("polls the connect window once per second by default", async () => {
    let nowMs = 1_000
    const sleeps: number[] = []
    await waitForRoundChannelGate({
      gate: { round: 1, count: 5, byGameS: 30 }, deadlineMs: 2_500,
      readLines: async () => [], fire: () => [], nowMs: () => nowMs,
      sleep: async (ms) => { sleeps.push(ms); nowMs += ms },
    })
    expect(sleeps).toEqual([1_000, 500])
  })

  it("refuses to move a channel-gated burst after its evidence deadline", async () => {
    const calls: number[] = []
    const result = await waitForRoundChannelGate({
      gate: { round: 1, count: 5, byGameS: 30 },
      deadlineMs: 1_250,
      readLines: async () => Array.from({ length: 5 }, (_, i) => ({
        tag: "rtc",
        message: `[jollity-rtc] round-link stage=channel-open round=1 peer=P${i}`,
        ts: i === 4 ? 1_251 : 900 + i,
      })),
      fire: (_round, count) => { calls.push(count); return [] },
      nowMs: () => 1_300,
    })
    expect(result.status).toBe("not-proven")
    expect(calls).toEqual([])
  })

  it("refuses to fire when an on-time evidence read completes after the wall-clock deadline", async () => {
    let nowMs = 1_200
    let fireCalls = 0
    const result = await waitForRoundChannelGate({
      gate: { round: 1, count: 5, byGameS: 30 },
      deadlineMs: 1_250,
      readLines: async () => {
        nowMs = 1_251
        return Array.from({ length: 5 }, (_, i) => ({
          tag: "rtc",
          message: `[jollity-rtc] round-link stage=channel-open round=1 peer=P${i}`,
          ts: 1_000 + i,
        }))
      },
      fire: () => { fireCalls += 1; return [] },
      nowMs: () => nowMs,
    })
    expect(result).toEqual({
      status: "not-proven",
      peers: 5,
      detail: "round-1 channel gate NOT PROVEN: 5/5 distinct channels open by game T+30 s",
      rows: [],
    })
    expect(fireCalls).toBe(0)
  })

  it("does not start a burst when play is cancelled during the evidence read", async () => {
    let cancelled = false
    let fireCalls = 0
    const result = await waitForRoundChannelGate({
      gate: { round: 1, count: 5, byGameS: 30 },
      deadlineMs: 30_000,
      readLines: async () => {
        cancelled = true
        return Array.from({ length: 5 }, (_, i) => ({
          tag: "rtc",
          message: `[jollity-rtc] round-link stage=channel-open round=1 peer=P${i}`,
          ts: 1_000 + i,
        }))
      },
      fire: () => { fireCalls += 1; return [] },
      nowMs: () => 2_000,
      cancelled: () => cancelled,
    })
    expect(result).toEqual({
      status: "cancelled",
      peers: 0,
      detail: "round-1 channel gate cancelled",
      rows: [],
    })
    expect(fireCalls).toBe(0)
  })

  it("wires best-block scheduling, setup-sensitive deferral, guards, cancellation, and ordering proof", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    expect(source).toMatch(/scheduleBeforeGameSteps\(\s*NET_PLAN,\s*g\.gameAt,/)
    expect(source).toMatch(/appClockWallMsFor\(schedulingClock, gameSecond\)/)
    expect(source).toMatch(/excludeSeconds:\s*BOT\?\.name === "turn-warm-returning" \? \[90\] : \[\]/)
    expect(source.indexOf('reloadAct(0, pages[0], "registered returning-player waiting room after source warm-up", false)')).toBeLessThan(
      source.indexOf("turn-warm-returning NOT PROVEN"),
    )
    const relaunchReload = source.indexOf('reloadAct(0, pages[0], "registered returning-player waiting room after source warm-up", false)')
    const postRelaunchRead = source.indexOf("const afterRelaunch = await waitForAppClock(() => readAppClock(pages[0]))", relaunchReload)
    expect(postRelaunchRead).toBeGreaterThan(relaunchReload)
    expect(source.indexOf("appClockWallMsFor(afterRelaunch", postRelaunchRead)).toBeGreaterThan(postRelaunchRead)
    expect(source).toContain("beforeGameSteps.cancel(recoveredAt)")
    expect(source).toContain("waitingNetworkWarningTimeoutMs(schedulingClock, handoverAt(g.gameAt), Date.now())")
    expect(source).toContain("host hang not scheduled")
    expect(source).toContain("beforeGameSteps.cancel()")
    expect(source).toContain("waitForRoundChannelGate")
    expect(source).toContain("postOpenBurstChecks")
  })

  it("does not queue an on-time recovery behind a concurrent waiting-room outage", async () => {
    const plan: NetworkPlan = {
      start: [],
      timeline: [
        { atBeforeGameS: 300, concurrent: true, calls: [["outage", "issuer", "286"]] },
        { atBeforeGameS: 2, calls: [["allow-udp"], ["swap", "lte-good"]] },
      ],
      atOpen: [],
    }
    let release!: () => void
    const outage = new Promise<void>((resolve) => { release = resolve })
    const { instance, calls } = controller(plan, {
      run: async (call) => {
        calls.push(call)
        if (call[0] === "outage") await outage
        return "ok"
      },
    })
    instance.onBeforeGame(300)
    let serialDrained = false
    await instance.drain().then(() => { serialDrained = true })
    expect(serialDrained).toBe(true)
    expect(calls).toEqual([["outage", "issuer", "286"]])
    const recoveryRows = await instance.runBeforeGame(2)
    expect(recoveryRows).toEqual([{ turn: 0, applied: true, calls: plan.timeline[1].calls }])
    expect(calls).toEqual([["outage", "issuer", "286"], ["allow-udp"], ["swap", "lte-good"]])
    let backgroundDrained = false
    const background = instance.drainBackground().then(() => { backgroundDrained = true })
    await Promise.resolve()
    expect(backgroundDrained).toBe(false)
    release()
    await background
    await instance.stop()
  })

  it("arms T-2 before earlier cleanup and fires it before kickoff while that work is still stuck", async () => {
    const plan: NetworkPlan = {
      start: [],
      timeline: [
        { atBeforeGameS: 300, concurrent: true, calls: [["outage", "issuer", "286"]] },
        { atBeforeGameS: 2, calls: [["allow-udp"], ["swap", "lte-good"]] },
      ],
      atOpen: [],
    }
    let releaseOutage!: () => void
    const outage = new Promise<void>((resolve) => { releaseOutage = resolve })
    let wallMs = 0
    const callTimes: number[] = []
    const { instance, calls } = controller(plan, {
      run: async (call) => {
        calls.push(call)
        callTimes.push(wallMs)
        if (call[0] === "outage") await outage
        return "ok"
      },
    })
    let releaseTMinus2!: () => void
    let waitedMs = -1
    const atTMinus2 = scheduleAtWallMs(298_000, () => instance.runBeforeGame(2), {
      nowMs: () => wallMs,
      sleep: (ms) => new Promise<void>((resolve) => {
        waitedMs = ms
        releaseTMinus2 = () => {
          wallMs += ms
          resolve()
        }
      }),
    })

    instance.onBeforeGame(300)
    await Promise.resolve()
    expect(waitedMs).toBe(298_000)
    expect(calls).toEqual([["outage", "issuer", "286"]])

    releaseTMinus2()
    await expect(atTMinus2).resolves.toEqual([{ turn: 0, applied: true, calls: plan.timeline[1].calls }])
    expect(calls).toEqual([["outage", "issuer", "286"], ["allow-udp"], ["swap", "lte-good"]])
    expect(callTimes.slice(1)).toEqual([298_000, 298_000])
    expect(callTimes[1]).toBeLessThan(300_000)

    let cleanupFinished = false
    const cleanup = instance.drainBackground().then(() => { cleanupFinished = true })
    await Promise.resolve()
    expect(cleanupFinished).toBe(false)
    releaseOutage()
    await cleanup
    await instance.stop()
  })

  it("records each fired call's wall times and outcome, for the switch proof", async () => {
    let wall = 1000
    const plan: NetworkPlan = { start: [], timeline: [{ atTurn: 6, calls: [["swap", "lte-good"], ["blackout", "15"]] }], atOpen: [] }
    const { instance } = controller(plan, {
      nowMs: () => (wall += 10),
      run: async (call) => {
        if (call[0] === "blackout") throw new Error("netem.sh blackout failed: boom")
        return "ok"
      },
    })
    const rows = instance.onTurn({ turn: 6, sinceStartS: null })
    expect(rows).toEqual([{ turn: 6, applied: true, calls: plan.timeline[0].calls }])
    const snap = await instance.stop()
    expect(snap.runs.map(({ step, call, ok, inconclusive }) => ({ step, call: call[0], ok, inconclusive }))).toEqual([
      { step: 1, call: "swap", ok: true, inconclusive: false },
      { step: 1, call: "blackout", ok: false, inconclusive: false },
    ])
    expect(snap.runs.every((r) => r.endMs > r.startMs)).toBe(true)
    expect(snap.fired).toBe(0)
  })

  it("pairs each acceptance qdisc counter with app counters from the same interval boundary", async () => {
    let wall = 1_000
    const { instance } = controller({ start: [], timeline: [], atOpen: [] }, {
      profileName: "uplink-lift-pixel6a",
      nowMs: () => (wall += 1_500),
      captureAdaptation: async () => ({
        currentRung: 4,
        roundSecondsByRung: { survival: 7 },
        roundPayloadBytesByRung: { survival: 12_000 },
        roundHeaderBytesByRung: { survival: 900 },
        roundTransportBytesByRung: { survival: 13_000 },
        roundTransportAllowanceBytesByRung: { survival: 1_300 },
        roundTransportSecondsByRung: { survival: 7 },
        lastWindow: { activeSenders: 5, validSenders: 5 },
      }) as never,
    })
    await instance.captureQdisc("survival-start")
    expect(instance.snapshot().qdiscSnapshots[0]).toMatchObject({
      label: "survival-start",
      requestStartedAtMs: 2_500,
      requestEndedAtMs: 4_000,
      atMs: 2_500,
      adaptation: {
        currentRung: 4,
        roundSecondsByRung: { survival: 7 },
        roundPayloadBytesByRung: { survival: 12_000 },
        roundHeaderBytesByRung: { survival: 900 },
        roundTransportBytesByRung: { survival: 13_000 },
        roundTransportAllowanceBytesByRung: { survival: 1_300 },
        roundTransportSecondsByRung: { survival: 7 },
        lastWindow: { activeSenders: 5, validSenders: 5 },
      },
    })
  })

  it("exercises timeline and at-open calls during a boot-only run", async () => {
    const plan: NetworkPlan = {
      start: [["apply", "wifi"]],
      timeline: [{ atTurn: 2, calls: [["swap", "lte-good"], ["blackout", "5"]] }],
      atOpen: [{ calls: [["outage", "turn.example", "10"]] }],
    }
    const { instance, calls } = controller(plan)
    await instance.start({ bootOnly: true })
    expect(calls).toEqual([
      ["apply", "wifi"],
      ["swap", "lte-good"], ["blackout", "5"], ["show"],
      ["outage", "turn.example", "10"], ["show"],
    ])
  })

  it("keeps an explicit bounded burst's hold and finally restore in boot-only compatibility", async () => {
    const events: string[] = []
    const plan: NetworkPlan = {
      start: [],
      timeline: [{
        boundedBurst: { holdMs: 15_000, restoreProfile: "game259-lossy" },
        calls: [["swap", "game259-lossy"], ["custom", "100", "40", "65", "2"], ["swap", "game259-lossy"]],
      }],
      atOpen: [],
    }
    const { instance } = controller(plan, {
      run: async (call) => { events.push(call.join(" ")); return "ok" },
      sleep: async (ms) => { events.push(`hold ${ms}`) },
    })
    await instance.start({ bootOnly: true })
    expect(events).toEqual([
      "swap game259-lossy", "custom 100 40 65 2", "hold 15000", "swap game259-lossy", "show",
    ])
  })

  it("uses supervisor-owned shaping without applying or clearing it again", async () => {
    const plan: NetworkPlan = { start: [["apply", "wifi"], ["show"]], timeline: [], atOpen: [] }
    const { instance, calls, lines } = controller(plan, { shared: true })
    await instance.start({ bootOnly: false })
    await instance.stop({ clear: true })
    expect(calls).toEqual([])
    expect(lines).toEqual([])
  })

  it("records due steps once, serializes calls, and reports failures", async () => {
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 2, calls: [["swap", "lte-poor"], ["show"]] }] }
    const { instance, calls, lines, problems } = controller(plan, {
      run: async (call) => {
        calls.push(call)
        if (call[0] === "show") throw new Error("first line\nlast line")
        return "ok"
      },
    })
    expect(instance.onTurn({ turn: 1, sinceStartS: 0 })).toEqual([])
    expect(instance.onTurn({ turn: 2, sinceStartS: 12 })).toEqual([{ turn: 2, applied: true, calls: plan.timeline[0].calls }])
    expect(instance.onTurn({ turn: 3, sinceStartS: 24 })).toEqual([])
    const snapshot = await instance.stop()
    expect(calls).toEqual([["swap", "lte-poor"], ["show"]])
    expect(lines).toEqual([
      "2026-10-06T10:00:00.000Z network step 1 at game turn 2: swap lte-poor then show",
      "ERROR first line\nlast line",
    ])
    expect(problems).toEqual(["network step 1 (show) failed: first line last line"])
    expect(snapshot).toMatchObject({ live: true, planned: 1, fired: 0, problems })
    expect(snapshot.runs.map((r) => [r.call[0], r.ok])).toEqual([["swap", true], ["show", false]])
  })

  it("logs but does not run timeline steps on an unshaped runner", async () => {
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 1, calls: [["swap", "lte-good"]] }] }
    const { instance, calls, lines } = controller(plan, { active: false })
    expect(instance.onTurn({ turn: 1, sinceStartS: 0 })).toEqual([{ turn: 1, applied: false, calls: plan.timeline[0].calls }])
    expect((await instance.stop()).fired).toBe(0)
    expect(calls).toEqual([])
    expect(lines).toEqual(["2026-10-06T10:00:00.000Z network step 1 at game turn 1: swap lte-good (NOT applied: boot.mts did not shape this runner)"])
  })

  it("renders the existing switcher, storm, and relay-outage evidence byte-for-byte", async () => {
    const legacy = (plan: NetworkPlan) => {
      const fired = new Set<number>()
      const applied = new Set<number>()
      const lines: string[] = []
      const rows: unknown[] = []
      for (let turn = 1; turn <= 12; turn++) {
        for (const i of dueSteps(plan.timeline, fired, { turn, sinceStartS: turn * 12 })) {
          fired.add(i)
          const step = plan.timeline[i]
          lines.push(`2026-10-06T10:00:00.000Z network step ${i + 1} at game turn ${turn}: ${step.calls.map((call) => call.join(" ")).join(" then ")}`)
          rows.push({ turn, applied: true, calls: step.calls })
          applied.add(i)
        }
      }
      return {
        lines,
        rows,
        proof: verifyRoleActs(1, { kind: "baseline", changeVerdictThenConfirm: false }, [], { live: true, planned: plan.timeline.length, fired: applied.size }),
      }
    }

    for (const name of ["switcher-pixel6a-wifi-to-cell", "storm-pixel6a-timeline", "relay-outage"]) {
      const plan = networkPlan(profileByName(name))
      const expected = legacy(plan)
      const { instance, lines } = controller(plan)
      const rows = Array.from({ length: 12 }, (_, i) => instance.onTurn({ turn: i + 1, sinceStartS: (i + 1) * 12 })).flat()
      const snapshot = await instance.stop()
      const actual = {
        lines,
        rows,
        proof: verifyRoleActs(1, { kind: "baseline", changeVerdictThenConfirm: false }, [], snapshot),
      }
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    }
  })
})

describe("uplink-lift Survival evidence wait", () => {
  it("starts the two-minute transition budget only after the target game controller exists", async () => {
    const calls: { stage: string; timeoutMs: number }[] = []
    await waitForSurvivalWindow({
      playDeadlineMs: 800_000,
      nowMs: () => 100_000,
      waitForGame: async (timeoutMs) => {
        calls.push({ stage: "game", timeoutMs })
      },
      waitForTransition: async (timeoutMs) => {
        calls.push({ stage: "transition", timeoutMs })
      },
    })
    expect(calls).toEqual([
      { stage: "game", timeoutMs: 700_000 },
      { stage: "transition", timeoutMs: SURVIVAL_TRANSITION_TIMEOUT_MS },
    ])
  })

  it("does not start the transition allowance when the target game never appears", async () => {
    let transitionStarted = false
    await expect(
      waitForSurvivalWindow({
        playDeadlineMs: 200,
        nowMs: () => 100,
        waitForGame: async (timeoutMs) => {
          expect(timeoutMs).toBe(100)
          throw new Error("target game absent")
        },
        waitForTransition: async () => {
          transitionStarted = true
        },
      }),
    ).rejects.toThrow("target game absent")
    expect(transitionStarted).toBe(false)
  })

  it("caps the transition allowance to the remaining play deadline", async () => {
    const times = [100, 750]
    const calls: { stage: string; timeoutMs: number }[] = []
    await waitForSurvivalWindow({
      playDeadlineMs: 800,
      nowMs: () => times.shift()!,
      waitForGame: async (timeoutMs) => {
        calls.push({ stage: "game", timeoutMs })
      },
      waitForTransition: async (timeoutMs) => {
        calls.push({ stage: "transition", timeoutMs })
      },
    })
    expect(calls).toEqual([
      { stage: "game", timeoutMs: 700 },
      { stage: "transition", timeoutMs: 50 },
    ])
  })

  it("fails before starting the transition wait when the play deadline elapsed", async () => {
    const times = [100, 800]
    let transitionStarted = false
    await expect(
      waitForSurvivalWindow({
        playDeadlineMs: 800,
        nowMs: () => times.shift()!,
        waitForGame: async () => undefined,
        waitForTransition: async () => {
          transitionStarted = true
        },
      }),
    ).rejects.toThrow("play deadline elapsed before Survival transition wait")
    expect(transitionStarted).toBe(false)
  })
})
