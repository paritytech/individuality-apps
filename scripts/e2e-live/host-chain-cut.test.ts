// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CUT_SETUP_MS, CutWatch, SignUpScreenWatch, classifySignUpScreen, describeHost, hostReconnectFromLog, HOST_CHAIN_NOTICE, SLOW_NOTICE, signUpRestartCardCheck, signUpCutCheck, cardNeverInRoundCheck, confirmCutChainAt, confirmCutDue, cutDoesNotFit, cutHoldS, cutWindowS, hostChainInapplicable, hostLogFile, hostPidFile, inForceFile, isHostChainHang, planHasHostChainCut, planHasHostChainOperation, reportAfterCutCheck, waitInForce, withHostTargets, withoutHostChainCuts } from "./host-chain-cut"
import { NETEM_INCONCLUSIVE_EXIT, NetemError, NetworkController, netemCheckStatus, netemOutcome, networkPlan, type NetemCall, type NetworkPlan } from "./network"
import { profileByName, validateProfile, loadNetemProfiles } from "./profile"

const persona = () => profileByName("host-chain-lost")

describe("the host-chain-lost persona", () => {
  it("plans two cuts of the host's chain alone: at the sign-up and at the confirm stage, 60 s windows with a 45 s hold", () => {
    const plan = networkPlan(persona(), undefined, "previewnet")
    expect(plan.start).toEqual([["apply", "wifi"], ["show"]])
    expect(plan.timeline).toEqual([
      { at: "sign-up", calls: [["host-chain-cut", "60", "45", "previewnet.substrate.dev"]] },
      { at: "confirm", calls: [["host-chain-cut", "60", "45", "previewnet.substrate.dev"]] },
    ])
    expect(planHasHostChainCut(plan)).toBe(true)
  })
  it("targets the run's own People RPC on paseo too", () => {
    expect(networkPlan(persona(), undefined, "paseo-next-v2").timeline[0].calls[0][3]).toBe("paseo-people-next-system-rpc.polkadot.io")
  })
  it("plays as its own previewnet identity, which no other profile holds", () => {
    expect(persona().identity).toEqual({ previewnet: "jollitypv.78" })
  })
  it("a plan without the cut never asks boot for the host's pid", () => {
    expect(planHasHostChainCut(networkPlan(profileByName("chain-outage")))).toBe(false)
    expect(planHasHostChainCut(networkPlan(null))).toBe(false)
  })
  it("the hold defaults to the whole window", () => {
    const p = { ...persona(), network: { profile: "wifi", relayOnly: false, timeline: [{ atSignUp: true as const, hostChainCutS: 30 }] } }
    expect(networkPlan(p).timeline[0].calls).toEqual([["host-chain-cut", "30", "30", "previewnet.substrate.dev"]])
  })
})

describe("validating a host-chain cut step", () => {
  const raw = (step: Record<string, unknown>) => ({ ...JSON.parse(JSON.stringify(persona())), network: { profile: "wifi", relayOnly: false, timeline: [step] } })
  const check = (step: Record<string, unknown>) => () => validateProfile(raw(step), 0, loadNetemProfiles())
  it("takes exactly one trigger", () => {
    expect(check({ atSignUp: true, atConfirm: true, hostChainCutS: 60 })).toThrow(/exactly one of atTurn, atS, atBeforeGameS, atRoundChannelsOpen, atOpen, atSignUp and atConfirm/)
    expect(check({ atSignUp: true, atTurn: 3, hostChainCutS: 60 })).toThrow(/exactly one/)
    expect(check({ atConfirm: true, hostChainCutS: 60 })).not.toThrow()
  })
  it("a moment trigger is true or absent", () => expect(check({ atSignUp: false, hostChainCutS: 60 })).toThrow(/atSignUp: must be true/))
  it("a hold needs a window, at least 3 s, and no longer than it", () => {
    expect(check({ atSignUp: true, hostChainHoldS: 10, profile: "wifi" })).toThrow(/hostChainHoldS needs hostChainCutS/)
    expect(check({ atSignUp: true, hostChainCutS: 60, hostChainHoldS: 2 })).toThrow(/>= 3/)
    expect(check({ atSignUp: true, hostChainCutS: 10, hostChainHoldS: 20 })).toThrow(/cannot outlast the window/)
  })
  it("a moment step must still change something", () => expect(check({ atSignUp: true })).toThrow(/must change something/))
  it("a host-chain cut cannot run at app open (boot has no pid, log or marker there)", () => expect(check({ atOpen: true, hostChainCutS: 60 })).toThrow(/cannot be an atOpen step/))
  it("validates a true host hang independently from the legacy socket-killing cut", () => {
    expect(check({ atTurn: 4, hostChainHangS: 30 })).not.toThrow()
    expect(check({ atTurn: 4, hostChainHangS: 9 })).toThrow(/>= 10/)
    expect(check({ atTurn: 4, hostChainHangS: 30, hostChainCutS: 30 })).toThrow(/mutually exclusive/)
    expect(check({ atOpen: true, hostChainHangS: 30 })).toThrow(/cannot be an atOpen step/)
  })
})

describe("withHostTargets", () => {
  it("appends the slot's pid file, host log and in-force marker to a host-chain cut", () => {
    const call: NetemCall = ["host-chain-cut", "60", "10", "previewnet.substrate.dev"]
    expect(withHostTargets(call, "/out", 3)).toEqual([...call, "/out/host-pid-3", "/out/slot-3.log", "/out/host-chain-cut-3.in-force"])
    expect([hostPidFile("/o", 1), hostLogFile("/o", 1), inForceFile("/o", 1)]).toEqual(["/o/host-pid-1", "/o/slot-1.log", "/o/host-chain-cut-1.in-force"])
  })
  it("appends the same targets to a true host hang", () => {
    const call: NetemCall = ["host-chain-hang", "30", "previewnet.substrate.dev"]
    expect(isHostChainHang(call)).toBe(true)
    expect(withHostTargets(call, "/out", 3)).toEqual([...call, "/out/host-pid-3", "/out/slot-3.log", "/out/host-chain-cut-3.in-force"])
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 4, calls: [call] }] }
    expect(planHasHostChainCut(plan)).toBe(false)
    expect(planHasHostChainOperation(plan)).toBe(true)
  })
  it("leaves every other call alone", () => {
    expect(withHostTargets(["outage", "x", "10"], "/out", 1)).toEqual(["outage", "x", "10"])
  })
})

describe("cutDoesNotFit (chain seconds)", () => {
  it("fits when the window plus the margin is left", () => expect(cutDoesNotFit(60, 1000, 1120, 60, "registration")).toBeNull())
  it("says why when it does not", () => expect(cutDoesNotFit(60, 1000, 1100, 60, "registration")).toBe("registration closes in 100 s, a 60 s host-chain cut needs 120 s (60 s to spare)"))
  it("reads the window off the cut's call", () => {
    expect(cutWindowS([["show"], ["host-chain-cut", "45", "10", "h"]])).toBe(45)
    expect(cutWindowS([["show"]])).toBeNull()
  })
})

describe("waitInForce", () => {
  it("resolves once the marker appears, false on timeout", async () => {
    let n = 0
    expect(await waitInForce("/o", 1, 1000, () => ++n > 2, 1)).toBe(true)
    expect(await waitInForce("/o", 1, 20, () => false, 5)).toBe(false)
  })
})

describe("NetworkController and game moments", () => {
  const plan: NetworkPlan = {
    start: [["apply", "wifi"]],
    timeline: [
      { at: "sign-up", calls: [["host-chain-cut", "60", "10", "h"]] },
      { atTurn: 2, calls: [["swap", "lte-good"]] },
      { at: "confirm", calls: [["host-chain-cut", "60", "10", "h"]] },
    ],
    atOpen: [],
  }
  const make = (active = true) => {
    const calls: NetemCall[] = []
    const c = new NetworkController({ plan, active, run: async (call) => (calls.push(call), "ok"), say: () => undefined, now: () => "T" })
    return { c, calls }
  }
  it("fires a moment's steps once, never from the turn loop, and counts them in the timeline proof", async () => {
    const { c, calls } = make()
    expect(c.onTurn({ turn: 12, sinceStartS: 999 }).map((r) => r.calls)).toEqual([[["swap", "lte-good"]]])
    expect(c.pendingAt("sign-up")).toHaveLength(1)
    expect(c.onMoment("sign-up")).toEqual([{ turn: 0, applied: true, calls: [["host-chain-cut", "60", "10", "h"]] }])
    expect(c.onMoment("sign-up")).toEqual([])
    expect(c.pendingAt("sign-up")).toHaveLength(0)
    expect((await c.stop()).fired).toBe(2)
    c.onMoment("confirm", 12)
    const snap = await c.stop()
    expect(snap).toMatchObject({ planned: 3, fired: 3 })
    expect(calls.map((x) => x[0])).toEqual(["swap", "host-chain-cut", "host-chain-cut"])
  })
  it("a boot-only run skips the cut (stage (a) proves it with the page open) but runs the rest", async () => {
    const { c, calls } = make()
    await c.start({ bootOnly: true })
    expect(calls).toEqual([["apply", "wifi"], ["swap", "lte-good"], ["show"]])
  })
  it("an unshaped runner logs the moment and runs nothing", async () => {
    const { c, calls } = make(false)
    expect(c.onMoment("confirm", 12)).toEqual([{ turn: 12, applied: false, calls: [["host-chain-cut", "60", "10", "h"]] }])
    await c.stop()
    expect(calls).toEqual([])
    expect(c.isActive).toBe(false)
  })
})

describe("netem.sh host-chain-cut", () => {
  const sh = readFileSync(join(__dirname, "netem.sh"), "utf8")
  it("is a verb, and clear removes its rules and cgroups", () => {
    expect(sh).toMatch(/host-chain-cut\) shift; cmd_host_chain_cut/)
    expect(sh).toMatch(/blackout_off\n {2}host_chain_clear\n/)
  })
  it("matches the host's cgroup on OUTPUT only, rejects with a reset, kills by 4-tuple, and cleans up on any exit", () => {
    expect(sh).toMatch(/-m cgroup --path "\$cgpath" -p tcp -d "\$ip" -j REJECT --reject-with tcp-reset/)
    expect(sh).toMatch(/ss -K -tn state established src "\$lport" dst "\$peer"/)
    expect(sh).toMatch(/trap host_chain_off EXIT INT TERM/)
    expect(sh).not.toMatch(/INPUT[^\n]*HOSTCHAIN_CHAIN/)
  })
  it("fails NOT PROVEN when it cannot show the cut, and proves the browser's own socket survived when there is one", () => {
    expect(sh).toContain("the app's side is INCONCLUSIVE")
    for (const why of ["not cgroup v2", "held no socket", "still held", "INSIDE the host's cgroup still reached", "OUTSIDE the host's cgroup too", "did not survive the cut"]) expect(sh).toContain(why)
  })
})

describe("netem.sh host-chain-hang", () => {
  const sh = readFileSync(join(__dirname, "netem.sh"), "utf8")
  const body = sh.split("cmd_host_chain_hang() {")[1]!.split("\n}\n\ncmd_clear")[0]!
  const prepare = sh.split("host_chain_prepare() {")[1]!.split("\n}\nhost_chain_cgroup_rules")[0]!
  it("silently drops all host-cgroup TCP traffic without destroying established sockets", () => {
    expect(sh).toMatch(/host-chain-hang\) shift; cmd_host_chain_hang/)
    expect(sh).toContain("host_chain_cgroup_rules() { # <DROP|REJECT>")
    expect(body).toContain("host_chain_cgroup_rules DROP")
    expect(body).not.toContain("ss -K")
    expect(body).toContain("no socket was killed")
    expect(body).toContain('iptables -w -A "$HOSTCHAIN_FLOW_OUT"')
    expect(body).toContain('iptables -w -A "$HOSTCHAIN_FLOW_IN"')
    expect(body).toContain('-s "$local_ip" --sport "$local_port" -d "$peer_ip" --dport "$peer_port"')
    expect(body).toContain('-s "$peer_ip" --sport "$peer_port" -d "$local_ip" --dport "$local_port"')
    expect(body).toContain("forced cgroup connect had $cgroup_packets packet(s) DROPped")
    expect(body).toContain("neither the established flow nor the forced cgroup connect matched a DROP rule")
  })
  it("forces an in-cgroup connect while DROP is active and counts its DROP packets for an idle host", () => {
    const forcedProbe = body.indexOf('probe_in_cgroup "$host" "$HOSTCHAIN_CG"')
    const count = body.indexOf('cgroup_packets="$($SUDO iptables -w -L "$HOSTCHAIN_CHAIN"')
    expect(forcedProbe).toBeGreaterThan(-1)
    expect(count).toBeGreaterThan(forcedProbe)
    expect(body).toContain("cgroup_packets=$(( cgroup_packets + cgroup_packets6 ))")
    expect(body).toContain('elif [ "$cgroup_packets" -gt 0 ]')
  })
  it("moves the host before snapshotting flows so any racing socket inherits the blocked cgroup", () => {
    expect(prepare.indexOf("cgroup.procs")).toBeLessThan(prepare.indexOf('HOSTCHAIN_BEFORE="$(host_sockets'))
  })
})

describe("the confirm timing: the report attempt comes after the cut is in force", () => {
  const built = (ts: number) => ({ ts, tag: "vote", message: "report built" })
  it("a Confirm tap gated on the cut lands after the in-force marker, and the check passes", () => {
    const w = new CutWatch(true, 1_000_000)
    expect(w.gateOpen(100)).toBe(false) // armed, not fired: the confirm stage must not be tapped yet
    w.fired(1000)
    expect(w.gateOpen(5000)).toBe(false) // netem.sh still setting up
    // the bot polls the gate as the play loop does; netem.sh's marker appears at 6000; the app builds the report on the tap
    let tapAt = 0
    for (let t = 1000; t < 10_000; t += 250) {
      if (t >= 6000) w.inForce(6000)
      if (w.gateOpen(t)) {
        tapAt = t
        break
      }
    }
    expect(tapAt).toBe(6000)
    const c = reportAfterCutCheck(1, [built(tapAt), { ts: tapAt + 3000, tag: "vote", message: "report retry" }], w)
    expect(c.status).toBe("pass")
    expect(c.detail).toMatch(/1 retry/)
  })
  it("an auto-confirm that built the report before the marker fails: the report was not tested", () => {
    const w = new CutWatch(true, 1_000_000)
    w.fired(1000)
    w.inForce(6000)
    expect(reportAfterCutCheck(1, [built(5000), built(9000)], w)).toMatchObject({ status: "fail" })
  })
  it("a cut that never came into force fails, an unarmed one is unchecked, missing lines are unchecked", () => {
    const w = new CutWatch(true, 1_000_000)
    expect(reportAfterCutCheck(1, [built(1)], w).detail).toBe("the confirm cut never fired")
    w.fired(1)
    expect(reportAfterCutCheck(1, [built(1)], w).status).toBe("fail")
    expect(reportAfterCutCheck(1, [built(1)], new CutWatch(false, 0)).status).toBe("unchecked")
    w.inForce(2)
    expect(reportAfterCutCheck(1, [], w).status).toBe("unchecked")
    expect(reportAfterCutCheck(1, [{ ts: 5, tag: "vote", message: "tile tap" }], w).status).toBe("fail")
  })
  it("the gate never holds a tap past the setup bound or the game's deadline", () => {
    const w = new CutWatch(true, 50_000)
    w.fired(1000)
    expect(w.gateOpen(1000 + CUT_SETUP_MS - 1)).toBe(false)
    expect(w.gateOpen(1000 + CUT_SETUP_MS)).toBe(true)
    const late = new CutWatch(true, 50_000)
    expect(late.gateOpen(49_999)).toBe(false)
    expect(late.gateOpen(50_000)).toBe(true)
    expect(new CutWatch(false, 0).gateOpen(0)).toBe(true)
    const unfit = new CutWatch(true, 50_000)
    unfit.disarm() // the cut did not fit the report window: the tap is not held for it
    expect(unfit.gateOpen(0)).toBe(true)
  })
})

describe("the restart card never shows during a round", () => {
  const health = { ts: 10, tag: "chain", message: "health waiting: host-chain-lost" }
  const card = (ts: number) => ({ ts, tag: "chain", message: "restart card shown" })
  it("passes when every card is outside the round", () => expect(cardNeverInRoundCheck(1, [health, card(50)], { fromMs: 100, toMs: 200 }).status).toBe("pass"))
  it("fails on a card inside the round", () => expect(cardNeverInRoundCheck(1, [health, card(150)], { fromMs: 100, toMs: 200 }).status).toBe("fail"))
  it("is unchecked, not a pass, on a build without the chain check", () => {
    expect(cardNeverInRoundCheck(1, [card(150)], { fromMs: 100, toMs: 200 }).status).toBe("unchecked")
    expect(cardNeverInRoundCheck(1, [], null).status).toBe("unchecked")
    expect(cardNeverInRoundCheck(1, [health], null).status).toBe("unchecked")
  })
})

describe("only app=local", () => {
  it("is inapplicable on a deployed app, and its cuts are dropped from the plan", () => {
    expect(hostChainInapplicable("local")).toBeNull()
    expect(hostChainInapplicable("dim2.testnet")).toMatch(/THROUGH the host/)
    const plan = withoutHostChainCuts(networkPlan(persona()))
    expect(plan.timeline).toEqual([])
    expect(plan.start).toEqual([["apply", "wifi"], ["show"]])
    expect(planHasHostChainCut(plan)).toBe(false)
  })
  it("keeps a step's other calls", () => {
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 2, calls: [["swap", "wifi"], ["host-chain-cut", "60", "10", "h"]] }] }
    expect(withoutHostChainCuts(plan).timeline).toEqual([{ atTurn: 2, calls: [["swap", "wifi"]] }])
  })
  it("keeps a true host hang on a deployed-app plan", () => {
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ atTurn: 4, calls: [["host-chain-hang", "30", "h"]] }] }
    expect(withoutHostChainCuts(plan)).toEqual(plan)
  })
})

describe("the confirm cut fires at the start of the second-to-last turn", () => {
  it("on the page's turn display: turn 11 of 12, not before", () => {
    expect(confirmCutDue(10, 12)).toBe(false)
    expect(confirmCutDue(11, 12)).toBe(true)
    expect(confirmCutDue(12, 12)).toBe(true) // a page that skipped turn 11 still fires
  })
  it("on the chain-clock fallback: two turns before the last one ends", () => expect(confirmCutChainAt(1144, 12)).toBe(1120))
  it("the profile's 45 s refusal and 60 s window, started there, span the auto-confirm's first report build", () => {
    // seconds relative to the confirm stage opening (the last turn's end); the app builds the report at settle 1.5 s + auto 7 s
    const firedAt = -2 * 12
    const setup = [1, CUT_SETUP_MS / 1000] // in force a moment after firing, at most the setup bound
    const reportBuilt = 1.5 + 7
    const plan = networkPlan(persona()).timeline.find((s) => s.at === "confirm")!.calls
    const hold = cutHoldS(plan)!
    const window = cutWindowS(plan)!
    for (const s of setup) {
      expect(firedAt + s).toBeLessThan(reportBuilt) // in force before the report is built
      expect(firedAt + s + hold).toBeGreaterThan(reportBuilt) // still refusing when it is
      expect(firedAt + s + window).toBeGreaterThan(reportBuilt)
    }
  })
  it("a report built after the refusal ended fails: the host could already reconnect", () => {
    const w = new CutWatch(true, 1_000_000, 45_000)
    w.fired(0)
    w.inForce(4000)
    const built = (ts: number) => [{ ts, tag: "vote", message: "report built" }]
    expect(reportAfterCutCheck(1, built(4000 + 30_000), w).status).toBe("pass")
    expect(reportAfterCutCheck(1, built(4000 + 46_000), w)).toMatchObject({ status: "fail" })
    expect(reportAfterCutCheck(1, built(3000), w).status).toBe("fail")
  })
})

describe("an INCONCLUSIVE cut is neither a pass nor a fail", () => {
  it("maps netem.sh's exit codes: 0 proven, 3 inconclusive, anything else failed", () => {
    expect(netemOutcome(null)).toBe("proven")
    expect(netemOutcome(new NetemError("x INCONCLUSIVE", NETEM_INCONCLUSIVE_EXIT))).toBe("inconclusive")
    expect(netemOutcome(new NetemError("NOT PROVEN", 1))).toBe("failed")
    expect(netemOutcome(new NetemError("killed", null))).toBe("failed")
    expect(netemOutcome(new Error("plain"))).toBe("failed")
    expect(["proven", "inconclusive", "failed"].map((o) => netemCheckStatus(o as "proven"))).toEqual(["pass", "inconclusive", "fail"])
  })
  it("a game step that comes back inconclusive is applied, recorded apart, and never a problem", async () => {
    const plan: NetworkPlan = { start: [], atOpen: [], timeline: [{ at: "confirm", calls: [["host-chain-cut", "60", "45", "h"]] }] }
    const problems: string[] = []
    const c = new NetworkController({
      plan,
      active: true,
      run: async () => {
        throw new NetemError("netem.sh host-chain-cut INCONCLUSIVE: [netem] host-chain cut proven for the HOST only; the app's side is INCONCLUSIVE: no browser socket", NETEM_INCONCLUSIVE_EXIT)
      },
      say: () => undefined,
      problems,
    })
    c.onMoment("confirm", 11)
    expect(await c.stop()).toMatchObject({ planned: 1, fired: 1 })
    expect(problems).toEqual([])
    expect(c.inconclusive()).toHaveLength(1)
    expect(c.inconclusive()[0]).toMatch(/network step 1 \(host-chain-cut\) INCONCLUSIVE: .*app's side is INCONCLUSIVE/)
  })
  it("a failed step is still a problem", async () => {
    const problems: string[] = []
    const c = new NetworkController({ plan: { start: [], atOpen: [], timeline: [{ at: "confirm", calls: [["host-chain-cut", "60", "45", "h"]] }] }, active: true, run: async () => { throw new NetemError("NOT PROVEN", 1) }, say: () => undefined, problems })
    c.onMoment("confirm")
    expect(await c.stop()).toMatchObject({ fired: 0 })
    expect(problems).toHaveLength(1)
    expect(c.inconclusive()).toEqual([])
  })
  it("netem.sh exits with its own code for it, distinct from NOT PROVEN's die", () => {
    const sh = readFileSync(join(__dirname, "netem.sh"), "utf8")
    expect(sh).toContain(`HOSTCHAIN_INCONCLUSIVE_EXIT=${NETEM_INCONCLUSIVE_EXIT}`)
    expect(sh).toMatch(/exit "\$HOSTCHAIN_INCONCLUSIVE_EXIT"/)
    expect(sh).toMatch(/die\(\) \{[^}]*exit 1; \}/)
    expect(sh).toMatch(/HOSTCHAIN_MARKER" \]; then rm -f "\$HOSTCHAIN_MARKER"/)
  })
})

describe("the in-force marker is watched until the game's deadline, not the tap's setup bound", () => {
  it("the watch runs to the deadline while the gate opens at CUT_SETUP_MS", () => {
    const w = new CutWatch(true, 100_000)
    w.fired(1000)
    expect(w.markerWaitMs(1000)).toBe(99_000)
    expect(w.gateOpen(1000 + CUT_SETUP_MS)).toBe(true) // the tap goes...
    w.inForce(1000 + CUT_SETUP_MS + 1000) // ...and a marker at 21 s is still seen
    expect(w.inForceAtMs).toBe(22_000)
    expect(w.markerWaitMs(200_000)).toBe(0)
  })
  const attempt = (ts: number, message = "route: lite") => ({ ts, tag: "signup", message })
  it("a marker that lands after the tap's bound is late, never a failure: a tap after it passes", () => {
    const w = new CutWatch(true, 100_000, 45_000)
    w.fired(1000)
    w.inForce(23_000)
    expect(signUpCutCheck(1, w, 24_000)).toMatchObject({ status: "pass" })
    expect(signUpCutCheck(1, w, 24_000).detail).toMatch(/1 s after it/)
  })
  it("a tap BEFORE the marker is INCONCLUSIVE when no sign-up attempt started under the refusal", () => {
    const w = new CutWatch(true, 100_000, 45_000)
    w.fired(1000)
    w.inForce(23_000)
    expect(signUpCutCheck(1, w, 21_000)).toMatchObject({ status: "inconclusive" })
    expect(signUpCutCheck(1, w, 21_000, [attempt(21_500)]).status).toBe("inconclusive") // its only attempt came before the cut
    expect(signUpCutCheck(1, w, 21_000, [attempt(21_500), attempt(70_000, "sign-up goes again (attempt 2): x")]).status).toBe("inconclusive") // after the refusal ended
    expect(signUpCutCheck(1, w, 21_000, [{ ts: 30_000, tag: "vote", message: "route: x" }]).status).toBe("inconclusive") // not a sign-up line
  })
  it("a tap BEFORE the marker passes when the first sign-up attempt started after it", () => {
    const w = new CutWatch(true, 100_000, 45_000)
    w.fired(1000)
    w.inForce(23_000)
    const c = signUpCutCheck(1, w, 21_000, [attempt(23_400)])
    expect(c.status).toBe("pass")
    expect(c.detail).toMatch(/the first sign-up attempt started 0.4 s after it/)
  })
  it("or when a retry started under the refusal", () => {
    const w = new CutWatch(true, 100_000, 45_000)
    w.fired(1000)
    w.inForce(23_000)
    const c = signUpCutCheck(1, w, 21_000, [attempt(21_500), attempt(30_000, "sign-up goes again (attempt 2): CannotGetCurrentBlock, after 1500 ms")])
    expect(c.status).toBe("pass")
    expect(c.detail).toMatch(/a retry \(attempt 2 of 2\)/)
  })
  it("a sign-up cut that never came into force fails; an unarmed one is unchecked", () => {
    const w = new CutWatch(true, 100_000)
    expect(signUpCutCheck(1, w, null).detail).toBe("the sign-up cut never fired")
    const noTap = new CutWatch(true, 100_000)
    noTap.fired(1)
    noTap.inForce(2)
    expect(signUpCutCheck(1, noTap, null).status).toBe("inconclusive")
    w.fired(1)
    expect(signUpCutCheck(1, w, 5).status).toBe("fail")
    expect(signUpCutCheck(1, new CutWatch(false, 0), null).status).toBe("unchecked")
  })
})

describe("the sign-up under a dead host holds to the restart card (#507)", () => {
  const armed = (inForceAt: number | null = 1000) => {
    const w = new CutWatch(true, 10_000_000, 45_000)
    w.fired(500)
    if (inForceAt !== null) w.inForce(inForceAt)
    return w
  }
  const dead = { reconnected: false, afterS: null }
  const AFTER_CLOSE = 10_005_000
  const stuck = () => {
    const sc = new SignUpScreenWatch()
    sc.see(5000, "registering", 1000)
    sc.see(65_000, "slow", 1000)
    sc.see(245_000, "slow", 1000)
    sc.see(250_000, "missed", 1000)
    return sc
  }

  it("mirrors the host-chain notice the app renders under the Join button", () => {
    const source = readFileSync(join(__dirname, "../../apps/jollity-app/lib/registration/register-button.ts"), "utf8")
    expect(source).toContain(HOST_CHAIN_NOTICE)
  })

  it("classifies the screens by their words and the card's testid", () => {
    expect(classifySignUpScreen("Connection lost Restart the Polkadot app", false)).toBe("restart-card")
    expect(classifySignUpScreen("anything", true)).toBe("restart-card")
    expect(classifySignUpScreen("You missed this one", false)).toBe("missed")
    expect(classifySignUpScreen(`Joining… ${SLOW_NOTICE}`, false)).toBe("slow")
    expect(classifySignUpScreen(`Joining… ${HOST_CHAIN_NOTICE} You can still join until 02:10.`, false)).toBe("chain-notice")
    expect(classifySignUpScreen("Joining…", false)).toBe("registering")
    expect(classifySignUpScreen("Joining your group", false)).toBe("other")
    expect(classifySignUpScreen("Register", false)).toBe("other")
  })

  it("passes when the card showed after the cut was in force", () => {
    const sc = new SignUpScreenWatch()
    sc.see(5000, "registering", 1000)
    sc.see(40_000, "restart-card", 1000)
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: false, screen: sc, host: dead, nowMs: AFTER_CLOSE })
    expect(c.status).toBe("pass")
    expect(c.detail).toContain("39 s after the cut was in force")
  })

  it("passes on HOST_CHAIN_NOTICE alone and records which one showed", () => {
    const sc = new SignUpScreenWatch()
    sc.see(5000, "slow", 1000)
    sc.see(30_000, "chain-notice", 1000)
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: false, screen: sc, host: dead, nowMs: AFTER_CLOSE })
    expect(c.status).toBe("pass")
    expect(c.detail).toContain("HOST_CHAIN_NOTICE")
    expect(c.detail).not.toContain("restart card (")
  })

  it("says only SLOW_NOTICE showed when that is all the failed run saw", () => {
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: false, screen: stuck(), host: dead, nowMs: AFTER_CLOSE })
    expect(c.detail).toContain("only SLOW_NOTICE showed")
  })

  it("does not count a card from before the cut was in force", () => {
    const sc = new SignUpScreenWatch()
    sc.see(500, "restart-card", 1000)
    expect(sc.cardAtMs).toBeNull()
  })

  it("FAILS when registration closed without the card, even though the host never reconnected, and says what it saw", () => {
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: false, screen: stuck(), host: dead, nowMs: AFTER_CLOSE })
    expect(c.status).toBe("fail")
    expect(c.name).toBe("player 16 host-chain cut: under a host that lost its chain, the app told the player to restart the Polkadot app before registration closed")
    expect(c.detail).toContain('"You missed this one"')
    expect(c.detail).toContain("did NOT reconnect")
    expect(c.detail).toContain("sign-up did not land")
    expect(c.detail).toContain('taking longer than usual" showed for 180 s')
  })

  it("FAILS on a window that passed without the missed screen read, naming the last screen", () => {
    const sc = new SignUpScreenWatch()
    sc.see(5000, "slow", 1000)
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: false, screen: sc, host: { reconnected: null, afterS: null }, nowMs: AFTER_CLOSE })
    expect(c.status).toBe("fail")
    expect(c.detail).toContain("window passed (last screen: slow)")
    expect(c.detail).toContain("unknown")
  })

  it("is UNCHECKED when the stage ended (timeout) before registration closed and no missed screen was read", () => {
    const sc = new SignUpScreenWatch()
    sc.see(5000, "slow", 1000)
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: false, screen: sc, host: dead, nowMs: 9_000_000 })
    expect(c.status).toBe("unchecked")
    expect(c.detail).toContain("ended before registration closed")
  })

  it("still FAILS before the close when the page already showed the missed screen", () => {
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: false, screen: stuck(), host: dead, nowMs: 9_000_000 })
    expect(c.status).toBe("fail")
  })

  it("describes the host's reconnect outcome in words", () => {
    expect(describeHost({ reconnected: true, afterS: 7 })).toBe("the host reconnected 7 s after the kill")
    expect(describeHost(dead)).toContain("did NOT reconnect")
    expect(describeHost({ reconnected: null, afterS: null })).toContain("unknown")
  })

  it("is not applicable when the sign-up landed with no card (the host recovered)", () => {
    const sc = new SignUpScreenWatch()
    sc.see(5000, "registering", 1000)
    const c = signUpRestartCardCheck(16, { watch: armed(), landed: true, screen: sc, host: { reconnected: true, afterS: 12 }, nowMs: AFTER_CLOSE })
    expect(c.status).toBe("unchecked")
    expect(c.detail).toContain("not applicable")
  })

  it("is unchecked when the cut was never armed or never came into force", () => {
    expect(signUpRestartCardCheck(16, { watch: new CutWatch(false, 1), landed: false, screen: stuck(), host: dead, nowMs: AFTER_CLOSE }).status).toBe("unchecked")
    expect(signUpRestartCardCheck(16, { watch: armed(null), landed: false, screen: stuck(), host: dead, nowMs: AFTER_CLOSE }).status).toBe("unchecked")
  })

  it("reads the host's reconnect outcome from netem.log, the first cut's", () => {
    expect(hostReconnectFromLog("x\n[netem] host-chain cut: the host did NOT reconnect to a.b within the 60 s window\n[netem] host-chain cut: the host reconnected to a.b 7 s after the kill")).toEqual({ reconnected: false, afterS: null })
    expect(hostReconnectFromLog("[netem] host-chain cut: the host reconnected to previewnet.substrate.dev 12 s after the kill")).toEqual({ reconnected: true, afterS: 12 })
    expect(hostReconnectFromLog("nothing")).toEqual({ reconnected: null, afterS: null })
  })
})
