// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../telemetry", async () => (await import("../telemetry/testing")).fakeTelemetryModule())
vi.mock("../telemetry/health-event", () => ({ sendTelemetryHealth: async () => true }))
const scenes = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock("../telemetry/smoothness", () => ({
  enterScene: (scene: string) => scenes.calls.push(`enter ${scene}`),
  leaveScene: (scene: string) => scenes.calls.push(`leave ${scene}`),
  leaveAllScenes: () => scenes.calls.push("leave all"),
  recordHeap: () => scenes.calls.push("heap"),
}))
const invariants = vi.hoisted(() => ({ hits: [] as Array<{ kind: string; valueMs?: number; detail?: Record<string, string> }> }))
vi.mock("../invariants", async () => ({
  ...(await vi.importActual<typeof import("../invariants")>("../invariants")),
  noteInvariant: (hit: { kind: string; valueMs?: number; detail?: Record<string, string> }) => {
    invariants.hits.push(hit)
    return true
  },
}))
const logs = vi.hoisted(() => ({ lines: [] as string[], entries: [] as Array<{ time: number; tag: string; message: string }> }))
vi.mock("../debug/log-store", () => ({
  devLog: (tag: string, message: string) => {
    logs.lines.push(message)
    logs.entries.push({ time: Date.now(), tag, message })
  },
  // the log-stops-before-payoff invariant reads the ring's newest line
  getDevLogEntries: () => logs.entries,
}))
const ice = vi.hoisted(() => ({
  listener: null as null | ((event: unknown) => void),
  outcome: null as null | ((outcome: unknown) => void),
}))
vi.mock("../webrtc/ice", () => ({
  observeIce: (listener: (event: unknown) => void) => {
    ice.listener = listener
    return () => {
      ice.listener = null
    }
  },
  observeTurnOutcome: (listener: (outcome: unknown) => void) => {
    ice.outcome = listener
    return () => {
      ice.outcome = null
    }
  },
}))

import { journeysNamed, recorded, resetRecorded } from "../telemetry/testing"
import * as trace from "./game-trace"
import { setRtcStandby } from "./rtc-quality"
import type { RtcSample } from "../webrtc/rtc-stats"
import type { FunnelStage } from "../webrtc/funnel"

const states = (entries: Record<string, RTCPeerConnectionState>) => new Map(Object.entries(entries))
const observe = (
  entries: Record<string, RTCPeerConnectionState>,
  present: string[],
  pairs: Record<string, string> = {},
  ices: Record<string, string> = {},
  stages: Record<string, FunnelStage> = {},
) =>
  trace.observeMesh({
    states: states(entries),
    reports: Object.keys(entries).map((id) => ({ id, ice: ices[id] ?? "checking", pair: pairs[id], ...(stages[id] ? { stage: stages[id] } : {}) })),
    present: new Set(present),
    turnServers: 2,
  })

beforeEach(() => {
  vi.useRealTimers()
  resetRecorded()
  scenes.calls.length = 0
  logs.lines.length = 0
  logs.entries.length = 0
  invariants.hits.length = 0
  trace.resetGameTraceForTests()
})

/** the first round, reached by a join that opened at the handover a minute ago */
const onTimeRound = () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(Date.now() + 60_000)
  trace.roundChanged(0)
}

describe("journey.join", () => {
  it("starts with the camera hand-over, warm or not", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.cameraSettled({ kind: "live" })
    const [join] = journeysNamed("join")
    expect(join.attrs["camera.warm"]).toBe("true")
    expect(join.steps[0]).toMatchObject({ name: "camera.acquire", ended: true, endAttrs: { "camera.state": "ready" } })
  })

  it("snapshots the network connection at join start", () => {
    vi.stubGlobal("navigator", { connection: { type: "cellular", effectiveType: "4g", downlink: 9.5, rtt: 100, saveData: false } })
    try {
      trace.beginJoin({ cameraWarm: true })
      expect(journeysNamed("join")[0].attrs).toMatchObject({
        "net.type": "cellular",
        "net.effective": "4g",
        "net.rtt": "100",
        "net.downlink": "9.5",
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("starts without the connection API", () => {
    trace.beginJoin({ cameraWarm: true })
    expect(journeysNamed("join")[0].attrs["net.type"]).toBeUndefined()
  })

  it("records a camera that could not be had", () => {
    trace.beginJoin({ cameraWarm: false })
    trace.cameraSettled({ kind: "unavailable", reason: "busy" })
    expect(journeysNamed("join")[0].steps[0].endAttrs).toEqual({ "camera.state": "unavailable", "camera.reason": "busy" })
  })

  it("names the game and its clock offset once known", () => {
    trace.beginJoin({ cameraWarm: false })
    trace.noteGame(5, -7200)
    trace.noteGame(5, -7200)
    expect(journeysNamed("join")[0].attrs).toMatchObject({ "game.index": "5", "clock.offset": "-7200" })
    expect(recorded.gameIndex).toEqual([5])
  })

  it("turns the TURN events into timed steps, and a cache hit into an attribute", () => {
    trace.beginJoin({ cameraWarm: false })
    ice.listener?.({ kind: "proof", startedAt: 1000, endedAt: 1400, ok: true })
    ice.listener?.({ kind: "issue", startedAt: 1400, endedAt: 1900, ok: false })
    ice.listener?.({ kind: "cached" })
    const [join] = journeysNamed("join")
    expect(join.steps.slice(1).map((step) => [step.name, step.startedAt, step.endedAt, step.attrs["turn.ok"]])).toEqual([
      ["turn.proof", 1000, 1400, "true"],
      ["turn.issue", 1400, 1900, "false"],
    ])
    expect(join.attrs["turn.cached"]).toBe("true")
  })

  it("marks a player whose own signalling key was not found, until a later try finds it", () => {
    trace.beginJoin({ cameraWarm: false })
    expect(journeysNamed("join")[0].attrs["rtc.no_signalling_key"]).toBeUndefined()
    trace.signallingKeyLookedUp(false)
    expect(journeysNamed("join")[0].attrs["rtc.no_signalling_key"]).toBe("true")
    trace.signallingKeyLookedUp(true) // a hung read gave up, the next try found it
    expect(journeysNamed("join")[0].attrs["rtc.no_signalling_key"]).toBe("false")
  })

  it("says why the own key was missing, which key matched once found, and that it recovered", () => {
    trace.beginJoin({ cameraWarm: false })
    trace.signallingKeyLookedUp(false, { cause: "read-refused" })
    expect(journeysNamed("join")[0].attrs).toMatchObject({ "rtc.no_signalling_key": "true", "rtc.own_key.cause": "read-refused" })
    expect(journeysNamed("join")[0].attrs["rtc.own_key.recovered"]).toBeUndefined()
    trace.signallingKeyLookedUp(true, { cause: "found", source: "humanity" })
    expect(journeysNamed("join")[0].attrs).toMatchObject({
      "rtc.no_signalling_key": "false",
      "rtc.own_key.cause": "found",
      "rtc.own_key.source": "humanity",
      "rtc.own_key.recovered": "true",
    })
  })

  it("does not call a key found at the first try recovered", () => {
    trace.beginJoin({ cameraWarm: false })
    trace.signallingKeyLookedUp(true, { cause: "found", source: "jollity" })
    expect(journeysNamed("join")[0].attrs["rtc.own_key.recovered"]).toBeUndefined()
  })

  const refusedMiss = {
    cause: "read-refused",
    reads: { own: "answered", humanity: "refused" },
    refusal: "AccessNotGranted",
    humanityProduct: "peopl.paseo",
  } as const

  const refused = Promise.resolve({ surface: "unreadable", humanityRead: "refused" })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it("sends own-key-missing once per join, with the cause as its reason and the values in its context", async () => {
    trace.beginJoin({ cameraWarm: false })
    trace.ownKeyMissed(refusedMiss, refused)
    trace.ownKeyMissed(refusedMiss, refused)
    trace.ownKeyMissed({ cause: "no-match", reads: { own: "answered", humanity: "answered" }, humanityProduct: "peopl.paseo" }, Promise.resolve(null))
    await flush()
    expect(recorded.failures).toEqual([
      {
        kind: "own-key-missing",
        details: {
          reason: "read-refused",
          context: {
            humanity_product: "peopl.paseo",
            own_read: "answered",
            humanity_read: "refused",
            refusal: "AccessNotGranted",
            "signup.surface": "unreadable",
            "signup.humanity_read": "refused",
          },
        },
        journey: "join",
        expected: false,
      },
    ])
  })

  it("claims the join at the miss: a slow sign-up read lands on that join, and the next join may send again", async () => {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: false })
    const first = journeysNamed("join")[0].handle
    let answer: (facts: { surface: string; humanityRead: string }) => void = () => {}
    trace.ownKeyMissed(refusedMiss, new Promise((resolve) => (answer = resolve)))
    // the join ends and the next one opens before the sign-up read is back
    trace.leftGame()
    await vi.advanceTimersByTimeAsync(10)
    trace.beginJoin({ cameraWarm: false })
    answer({ surface: "unreadable", humanityRead: "refused" })
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded.failures).toHaveLength(1)
    expect(recorded.failures[0].details.context?.["signup.surface"]).toBe("unreadable")
    expect(first.ended).toBe(true)
    // it went to the join that missed, not the one open now
    expect(journeysNamed("join")[1].attrs["journey.expected"]).toBeUndefined()
    // the second join has its own claim
    trace.ownKeyMissed({ cause: "no-identifier", humanityProduct: "peopl.paseo" }, Promise.resolve(null))
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded.failures.map((failure) => failure.details.reason)).toEqual(["read-refused", "no-identifier"])
  })

  it("holds a miss that came with no join open for the next join, and sends it once", async () => {
    trace.ownKeyMissed(refusedMiss, refused)
    trace.ownKeyMissed({ cause: "no-match", humanityProduct: "peopl.paseo" }, refused)
    await flush()
    expect(recorded.failures).toHaveLength(0)
    trace.beginJoin({ cameraWarm: false })
    trace.ownKeyMissed(refusedMiss, refused)
    await flush()
    expect(recorded.failures).toEqual([expect.objectContaining({ kind: "own-key-missing", journey: "join", details: expect.objectContaining({ reason: "read-refused" }) })])
  })

  it("drops a held miss once a later lookup finds the key: a recovered player sends nothing on the next join", async () => {
    trace.ownKeyMissed(refusedMiss, refused)
    trace.signallingKeyLookedUp(true, { cause: "found", source: "humanity" })
    trace.beginJoin({ cameraWarm: false })
    await flush()
    expect(recorded.failures).toHaveLength(0)
  })

  it("sends nothing for a lookup whose reads gave no answer, and the next real miss still goes", async () => {
    trace.beginJoin({ cameraWarm: false })
    trace.ownKeyMissed({ cause: "no-answer", reads: { own: "no-answer", humanity: "answered" }, humanityProduct: "peopl.paseo" }, Promise.resolve(null))
    await flush()
    expect(recorded.failures).toHaveLength(0)
    trace.ownKeyMissed({ cause: "no-match", reads: { own: "answered", humanity: "answered" }, humanityProduct: "peopl.paseo" }, Promise.resolve(null))
    await flush()
    expect(recorded.failures).toEqual([expect.objectContaining({ kind: "own-key-missing", details: expect.objectContaining({ reason: "no-match" }) })])
  })

  it("masks a refusal the host words with a scrubbed word, and caps it", async () => {
    trace.beginJoin({ cameraWarm: false })
    trace.ownKeyMissed({ ...refusedMiss, refusal: `Unauthorized ${"x".repeat(300)}` }, Promise.resolve(null))
    await flush()
    const refusal = recorded.failures[0].details.context?.refusal ?? ""
    expect(refusal.startsWith("Unau*horized")).toBe(true)
    expect(refusal.length).toBeLessThanOrEqual(120)
  })

  it("puts the sign-up surface on the join and the game, even when it was read before the join opened", () => {
    trace.noteSignUpSurface(5, { surface: "unreadable", humanityRead: "refused" })
    trace.beginJoin({ cameraWarm: false })
    expect(journeysNamed("join")[0].attrs["signup.surface"]).toBeUndefined()
    trace.noteGame(5, 0)
    expect(journeysNamed("join")[0].attrs).toMatchObject({ "signup.surface": "unreadable", "signup.humanity_read": "refused" })
    trace.roundChanged(0)
    expect(journeysNamed("game")[0].attrs).toMatchObject({ "signup.surface": "unreadable", "signup.humanity_read": "refused" })
    trace.noteSignUpSurface(5, { surface: "humanity", humanityRead: "ok" })
    expect(journeysNamed("join")[0].attrs).toMatchObject({ "signup.surface": "humanity", "signup.humanity_read": "ok" })
    expect(journeysNamed("game")[0].attrs).toMatchObject({ "signup.surface": "humanity", "signup.humanity_read": "ok" })
  })

  it("leaves off a sign-up surface read for another game", () => {
    trace.noteSignUpSurface(4, { surface: "app", humanityRead: "ok" })
    trace.beginJoin({ cameraWarm: false })
    trace.noteGame(5, 0)
    expect(journeysNamed("join")[0].attrs["signup.surface"]).toBeUndefined()
  })

  it("ends full once every present peer is connected, with each peer's path", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.cameraSettled({ kind: "live" })
    trace.meshOpened("me", 0)
    observe({ a: "connecting", b: "connecting" }, ["a", "b"])
    observe({ a: "connected", b: "connecting" }, ["a", "b"], { a: "srflx/relay" })
    const [join] = journeysNamed("join")
    expect(join.ended).toBe(false)
    expect(join.steps.find((step) => step.name === "peer.first")?.ended).toBe(true)
    observe({ a: "connected", b: "connected" }, ["a", "b"], { a: "srflx/relay", b: "host/host" })
    const peers = join.steps.filter((step) => step.name === "rtc.peer")
    expect(peers.map((step) => [step.attrs["rtc.peer"], step.endAttrs?.["rtc.path"]])).toEqual([
      ["0", "relay"],
      ["1", "direct"],
    ])
    expect(join.steps.find((step) => step.name === "mesh.open")?.ended).toBe(true)
    expect(join.steps.find((step) => step.name === "peer.all")?.ended).toBe(true)
    expect(join.outcome).toBe("full")
  })

  it("keeps a peer's step open until its candidate pair arrives a tick after connected", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    observe({ a: "connecting" }, ["a"])
    observe({ a: "connected" }, ["a"])
    const [join] = journeysNamed("join")
    const peer = () => join.steps.find((step) => step.name === "rtc.peer")
    expect(peer()?.ended).toBe(false)
    expect(join.ended).toBe(false)
    expect(join.steps.find((step) => step.name === "peer.first")?.ended).toBe(true)
    observe({ a: "connected" }, ["a"], { a: "host/host" })
    expect(peer()?.endAttrs).toEqual({ "rtc.outcome": "connected", "rtc.path": "direct" })
    expect(join.outcome).toBe("full")
  })

  it("ends a peer whose pair never arrives with an unknown path, after the wait", async () => {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    observe({ a: "connected" }, ["a"])
    const [join] = journeysNamed("join")
    await vi.advanceTimersByTimeAsync(trace.PEER_PATH_WAIT_MS - 1)
    expect(join.ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(join.steps.find((step) => step.name === "rtc.peer")?.endAttrs).toEqual({ "rtc.outcome": "connected", "rtc.path": "unknown" })
    expect(join.outcome).toBe("full")
  })

  it("ends the join full when the first round starts while a pair is still on its way", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    observe({ a: "connected" }, ["a"])
    onTimeRound()
    const [join] = journeysNamed("join")
    expect(join.steps.find((step) => step.name === "rtc.peer")?.endAttrs).toEqual({ "rtc.outcome": "connected", "rtc.path": "unknown" })
    expect(join.outcome).toBe("full")
  })

  it("reports a peer that failed, once, with the path tried and the relay count", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    observe({ a: "connecting" }, ["a"])
    observe({ a: "failed" }, ["a"], {}, { a: "failed" })
    observe({ a: "failed" }, ["a"], {}, { a: "failed" })
    expect(recorded.failures).toEqual([
      expect.objectContaining({ kind: "peer-failed", details: { reason: "failed", context: { peer: "a", path: "unknown", relays: "2" } } }),
    ])
    const peer = journeysNamed("join")[0].steps.find((step) => step.name === "rtc.peer")
    expect(peer?.endAttrs).toMatchObject({ "rtc.outcome": "failed" })
  })

  it("survives a remount in the same tick", async () => {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: false })
    trace.leftGame()
    trace.beginJoin({ cameraWarm: false })
    await vi.advanceTimersByTimeAsync(10)
    expect(journeysNamed("join")).toHaveLength(1)
    expect(journeysNamed("join")[0].ended).toBe(false)
  })

  it("ends when the player leaves /game before the first round", async () => {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: false })
    trace.meshOpened("me", 0)
    observe({ a: "connected", b: "connecting" }, ["a", "b"], { a: "host/host" })
    trace.leftGame()
    await vi.advanceTimersByTimeAsync(10)
    expect(journeysNamed("join")[0].outcome).toBe("partial")
  })
})

describe("the app going to the background", () => {
  let listeners: Map<string, () => void>
  let doc: { visibilityState: string; addEventListener: (type: string, fn: () => void) => void }
  const hide = () => {
    doc.visibilityState = "hidden"
    listeners.get("document:visibilitychange")?.()
  }
  const show = () => {
    doc.visibilityState = "visible"
    listeners.get("document:visibilitychange")?.()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    listeners = new Map()
    vi.stubGlobal("window", { addEventListener: (type: string, fn: () => void) => void listeners.set(`window:${type}`, fn) })
    doc = { visibilityState: "visible", addEventListener: (type: string, fn: () => void) => void listeners.set(`document:${type}`, fn) }
    vi.stubGlobal("document", doc)
    trace.resetGameTraceForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function playing() {
    trace.beginJoin({ cameraWarm: true }) // installs the listeners
    trace.noteGame(5, 0)
    trace.meshOpened("me", 0)
    observe({ a: "connected", b: "connecting" }, ["a", "b"], { a: "host/host" })
    trace.roundChanged(0)
  }

  it("keeps a game open through a short hide, not sad but noted, and records what follows", async () => {
    playing()
    hide()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS - 1000)
    show()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS * 2)
    const [game] = journeysNamed("game")
    expect(game.ended).toBe(false)
    expect(game.sad).toEqual([])
    expect(game.attrs["journey.hidden"]).toBe("true")
    expect(game.steps.find((step) => step.name === "app.hidden")).toMatchObject({ ended: true })
    trace.roundChanged(1)
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    expect(game.steps.map((step) => step.name)).toEqual(["round.1", "app.hidden", "round.2", "report.submit", "report.landed"])
    expect(game.outcome).toBe("completed")
  })

  it("says on the game journey why the auto-confirm did not run", () => {
    trace.autoConfirmOff()
    expect(journeysNamed("game")).toEqual([])
    playing()
    trace.autoConfirmOff()
    expect(journeysNamed("game")[0].attrs["report.auto_confirm"]).toBe("off-after-background")
  })

  it("marks a game whose report window closed before any report", () => {
    playing()
    trace.reportWindowClosed()
    expect(journeysNamed("game")[0].attrs["report.outcome"]).toBe("window-closed")
  })

  it("puts the vote trail on the game journey as text, and nothing without a live game", () => {
    const facts = {
      taps: 14,
      auto: 22,
      turns: 12,
      person: 2,
      notperson: 3,
      autoOnly: 3,
      ties: 1,
      unseen: 2,
      unseenDefault: 1,
      unseenFlipped: 1,
      unseenChoices: [
        { choice: "default-notperson" as const, everFlipped: false },
        { choice: "flipped-person" as const, everFlipped: true },
      ],
      filedBy: "auto-confirm" as const,
    }
    trace.reportBuilt(facts)
    expect(journeysNamed("game")).toEqual([])
    playing()
    trace.reportBuilt(facts)
    expect(journeysNamed("game")[0].attrs).toMatchObject({
      "votes.taps": "14",
      "votes.auto": "22",
      "votes.turns": "12",
      "report.person": "2",
      "report.notperson": "3",
      "report.auto_only": "3",
      "report.ties": "1",
      "report.unseen": "2",
      "report.unseen_default": "1",
      "report.unseen_flipped": "1",
      "report.filed_by": "auto-confirm",
    })
    expect(recorded.metrics.filter((point) => point.name === "report.no_video_choice")).toEqual([
      { type: "count", name: "report.no_video_choice", value: 1, attrs: { choice: "default-notperson", ever_flipped: "false" } },
      { type: "count", name: "report.no_video_choice", value: 1, attrs: { choice: "flipped-person", ever_flipped: "true" } },
    ])
    expect(recorded.noVideoChoiceLogs).toEqual([
      { choice: "default-notperson", everFlipped: false },
      { choice: "flipped-person", everFlipped: true },
    ])
  })

  it("flushes the metrics once when the page goes, and once when the game ends, never per round", async () => {
    playing()
    trace.roundChanged(1)
    expect(recorded.metricFlushes).toBe(0)
    listeners.get("window:pagehide")?.()
    expect(recorded.metricFlushes).toBe(1)
    resetRecorded()
    trace.resetGameTraceForTests()
    playing()
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    expect(journeysNamed("game")[0].outcome).toBe("completed")
    expect(recorded.metricFlushes).toBe(1)
  })

  it("abandons the game once the page has stayed hidden past the grace", async () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    observe({ a: "connected", b: "connecting" }, ["a", "b"], { a: "host/host" })
    hide()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS - 1)
    expect(journeysNamed("join")[0].ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(journeysNamed("join")[0].outcome).toBe("partial")
    expect(journeysNamed("join")[0].sad).toEqual(["app-hidden"])
    trace.roundChanged(0)
    expect(journeysNamed("game")[0].sad).toEqual([])
  })

  it("abandons a game hidden past the grace", async () => {
    playing()
    hide()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS)
    expect(journeysNamed("game")[0].outcome).toBe("abandoned")
    expect(journeysNamed("game")[0].sad).toEqual(["app-hidden"])
  })

  it("does not abandon a game whose hidden timer fires late on resume, and records the report", async () => {
    playing()
    hide()
    await vi.advanceTimersByTimeAsync(1000)
    // iOS froze the page: the wall clock moved on while the timer did not run
    vi.setSystemTime(Date.now() + 120_000)
    // the overdue timer runs before the visible event, so the page still reads hidden
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS)
    const [game] = journeysNamed("game")
    expect(game.ended).toBe(false)
    expect(game.sad).toEqual(["app-suspended"])
    expect(game.steps.find((step) => step.name === "app.hidden")).toMatchObject({ ended: true })
    show()
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    expect(game.steps.map((step) => step.name)).toEqual(expect.arrayContaining(["report.submit", "report.landed"]))
    expect(game.outcome).toBe("completed")
    expect(journeysNamed("payoff")[0].attrs["report.after_abandon"]).toBeUndefined()
  })

  it("still records the report, on the payoff, when the game was abandoned before the player came back", async () => {
    playing()
    hide()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS)
    expect(journeysNamed("game")[0].outcome).toBe("abandoned")
    show()
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    const [payoff] = journeysNamed("payoff")
    expect(payoff.attrs).toMatchObject({ "game.index": "5", "report.after_abandon": "true", "report.outcome": "landed" })
  })

  it("still sends report-failed when the game journey has closed", async () => {
    playing()
    hide()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS)
    show()
    trace.reportFailed("boom")
    expect(recorded.failures.map((failure) => failure.kind)).toContain("report-failed")
  })

  it("names a timed-out report in report-failed", () => {
    playing()
    trace.reportFailed("the report did not settle in 30s", "timeout")
    expect(recorded.failures.find((failure) => failure.kind === "report-failed")?.details.reason).toBe("timeout")
  })

  it("summarises the final round when the page goes on the last turn, once (#632)", () => {
    playing()
    trace.roundChanged(1)
    for (let n = 1; n <= 3; n++)
      trace.observeRtcReport([{ id: "a", pair: "host/host", quality: { link: 1, at: n * 3000, rttMs: 150, inbound: { id: "IV", fps: 22, height: 640, packetsLost: 0, packetsReceived: n * 297 } } }])
    listeners.get("window:pagehide")?.()
    const rtt = () => recorded.metrics.filter((point) => point.name === "rtc.rtt_ms" && point.attrs.round === "2")
    expect(rtt()).toHaveLength(2)
    listeners.get("window:pagehide")?.()
    trace.leftGame()
    expect(rtt()).toHaveLength(2)
  })

  it("abandons at once on pagehide", () => {
    playing()
    listeners.get("window:pagehide")?.()
    expect(journeysNamed("game")[0].outcome).toBe("abandoned")
  })

  it("owns the lifecycle of its join, game and payoff, so the generic interrupt (#279) leaves their endings to it", () => {
    playing()
    trace.reportLanded(5)
    trace.gameSettledFor(5)
    trace.drawShown({ kind: "none" }, null, 5)
    for (const name of ["join", "game", "payoff"] as const) expect(journeysNamed(name)[0].options.ownsLifecycle).toBe(true)
  })

  it("keeps the payoff through a short hide, so the hand-off still sends the on-time game log", async () => {
    playing()
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    hide()
    await vi.advanceTimersByTimeAsync(5000)
    show()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS)
    trace.gameSettledFor(5)
    trace.drawShown({ kind: "none" }, null, 5)
    trace.payoffHandedOff()
    const [payoff] = journeysNamed("payoff")
    expect(payoff.sad).toEqual([])
    expect(payoff.outcome).toBe("shown")
    expect(recorded.gameLogs).toEqual([
      { gameIndex: 5, since: expect.any(Number), trace: payoff.handle.trace, stage: "report" },
      { gameIndex: 5, since: expect.any(Number), trace: payoff.handle.trace, stage: "payoff" },
    ])
  })

  it("stalls the payoff hidden past the grace", async () => {
    playing()
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    hide()
    await vi.advanceTimersByTimeAsync(trace.HIDDEN_ABANDON_MS)
    const [payoff] = journeysNamed("payoff")
    expect(payoff.outcome).toBe("stalled")
    expect(payoff.endAttrs).toMatchObject({ "payoff.stage": "draw.show" })
  })
})

function landed() {
  trace.beginJoin({ cameraWarm: true })
  trace.noteGame(5, 0)
  trace.meshOpened("me", 0)
  observe({ a: "connected" }, ["a"], { a: "host/host" })
  trace.roundChanged(0)
  trace.confirmOpened()
  trace.reportSubmitting()
  trace.reportLanded(5)
}

describe("humanityRequested", () => {
  it("records a humanity.open request on a short journey in the payoff's trace", () => {
    landed()
    trace.payoffHandedOff()
    trace.humanityRequested({ target: "card" })
    const [payoff] = journeysNamed("payoff")
    const [humanity] = journeysNamed("humanity")
    expect(humanity.options.sameTraceAs).toBe(payoff.handle)
    expect(humanity.attrs).toMatchObject({ "game.index": "5", "membership.humanity": "requested" })
    expect(humanity.steps).toEqual([expect.objectContaining({ name: "open", ended: true, attrs: { "humanity.target": "card", "humanity.action": "requested" } })])
    expect(humanity.outcome).toBe("requested")
  })

})

describe("payoff telemetry characterisation", () => {
  const payoffSnapshot = () => {
    const [payoff] = journeysNamed("payoff")
    return {
      steps: payoff.steps.filter((step) => step.ended).map((step) => step.name),
      stalledAt: payoff.attrs["payoff.stage"],
      outcome: payoff.outcome,
    }
  }

  const finishCollectables = () => {
    trace.collectablesOpened()
    trace.collectablesShown({ "chest.outcome": "collectables", "chest.count": "1" })
    trace.payoffHandedOff()
  }

  it("records the normal payoff facts once and in order", () => {
    landed()
    trace.gameSettledFor(5)
    trace.drawShown({ kind: "ready", draw: { userTicket: "t", wheel: {}, won: false } as never }, null, 5)
    finishCollectables()
    expect(payoffSnapshot()).toEqual({ steps: ["draw.show", "attestations.ready", "chest.show"], stalledAt: undefined, outcome: "shown" })
  })

  it("records a collectables screen stall before ending stalled", () => {
    landed()
    trace.gameSettledFor(5)
    trace.drawShown({ kind: "ready", draw: { userTicket: "t", wheel: {}, won: false } as never }, null, 5)
    trace.collectablesOpened()
    trace.payoffStalled("chest.load")
    trace.collectablesShown({ "chest.outcome": "none", "chest.reason": "failed" })
    trace.payoffHandedOff()
    expect(payoffSnapshot()).toEqual({ steps: ["draw.show", "attestations.ready", "chest.show"], stalledAt: "chest.load", outcome: "stalled" })
  })

  it("records a skipped draw before the collectables screen and shown ending", () => {
    landed()
    trace.gameSettledFor(5)
    trace.drawShown({ kind: "none" }, null, 5)
    finishCollectables()
    expect(payoffSnapshot()).toEqual({ steps: ["draw.show", "attestations.ready", "chest.show"], stalledAt: undefined, outcome: "shown" })
  })

  it("reloading directly into payoff pages re-emits no payoff facts", () => {
    trace.drawShown({ kind: "ready", draw: { userTicket: "t", wheel: {}, won: false } as never }, null, 5)
    trace.collectablesOpened()
    trace.collectablesShown({ "chest.outcome": "collectables", "chest.count": "1" })
    trace.payoffHandedOff()
    expect(journeysNamed("payoff")).toEqual([])
    expect(recorded.gameLogs).toEqual([])
  })
})

describe("journey.game", () => {
  /** a join on time: it opened at the handover, a minute before the first round */
  function joinWith(connected: boolean) {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, -7200)
    trace.meshOpened("me", 0)
    observe({ a: connected ? "connected" : "connecting", b: "connecting" }, ["a", "b"], { a: "host/host" })
    vi.setSystemTime(Date.now() + 60_000)
  }

  it("starts at the first round, in the join's trace, and ends the join", () => {
    joinWith(true)
    trace.roundChanged(0)
    const [join] = journeysNamed("join")
    const [game] = journeysNamed("game")
    expect(join.outcome).toBe("partial")
    expect(game.options.sameTraceAs).toBe(join.handle)
    expect(game.attrs).toMatchObject({ "game.index": "5", "clock.offset": "-7200", "game.late": "false" })
    expect(game.steps.map((step) => step.name)).toEqual(["round.1"])
  })

  it("ends the join isolated when nobody connected by the first round", () => {
    joinWith(false)
    trace.roundChanged(0)
    expect(journeysNamed("join")[0].outcome).toBe("isolated")
  })

  it("keeps a join that opened at kickoff open, and ends it late with both link timings (#800)", () => {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, -7200)
    trace.meshOpened("me", 0)
    vi.setSystemTime(Date.now() + 700)
    trace.roundChanged(0)
    const [join] = journeysNamed("join")
    expect(join.ended).toBe(false)
    expect(journeysNamed("game")[0].attrs).toMatchObject({ "game.late": "false" })
    vi.setSystemTime(Date.now() + 1800)
    observe({ a: "connected", b: "connecting" }, ["a", "b"], { a: "host/host" })
    expect(join.ended).toBe(false)
    vi.setSystemTime(Date.now() + 1000)
    observe({ a: "connected", b: "connected" }, ["a", "b"], { a: "host/host", b: "host/host" })
    expect(join.outcome).toBe("late")
    expect(join.endAttrs).toMatchObject({ "join.connected": "2", "join.first_link_ms": 2500, "join.all_links_ms": 3500 })
  })

  it("ends a late join at the deadline with no timings when no link ever came up", async () => {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 1)
    trace.roundChanged(1)
    const [join] = journeysNamed("join")
    await vi.advanceTimersByTimeAsync(trace.LATE_JOIN_DEADLINE_MS - 1)
    expect(join.ended).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(join.outcome).toBe("late")
    expect(join.endAttrs).not.toHaveProperty("join.first_link_ms")
    expect(join.endAttrs).not.toHaveProperty("join.all_links_ms")
  })

  it("still closes a late join as isolated on the real redirect", () => {
    vi.useFakeTimers()
    trace.beginJoin({ cameraWarm: true })
    trace.roundChanged(0)
    trace.isolated("store-write")
    expect(journeysNamed("join")[0].outcome).toBe("isolated")
  })

  it("steps round by round", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.roundChanged(null)
    trace.roundChanged(1)
    const [game] = journeysNamed("game")
    expect(game.steps.map((step) => [step.name, step.ended])).toEqual([
      ["round.1", true],
      ["round.2", false],
    ])
  })

  it("starts the game journey at a later round after a reload", () => {
    trace.beginJoin({ cameraWarm: false })
    trace.roundChanged(1)
    const [game] = journeysNamed("game")
    expect(game.attrs["game.late"]).toBe("true")
    expect(game.steps[0].name).toBe("round.2")
  })

  it("spans each stall", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.stallChanged({ kind: "connection_stalled", layer: "store-write" })
    trace.stallChanged({ kind: "connection_stalled", layer: "store-write" })
    trace.stallChanged({ kind: "connection_recovered", layer: "store-write" })
    const stalls = journeysNamed("game")[0].steps.filter((step) => step.name === "rtc.stall")
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toMatchObject({ attrs: { "rtc.layer": "store-write" }, ended: true })
  })

  it("sends the health ladder's turn-credentials layer as turn-issue", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.stallChanged({ kind: "connection_stalled", layer: "turn-credentials" })
    const stall = journeysNamed("game")[0].steps.find((step) => step.name === "rtc.stall")
    expect(stall?.attrs["rtc.layer"]).toBe("turn-issue")
    trace.isolated("turn-credentials")
    expect(recorded.failures[0]).toMatchObject({ kind: "mesh-isolated", details: { reason: "turn-issue" } })
  })

  it("spans a reconnect and marks the game sad, sending no failure", () => {
    joinWith(true)
    trace.roundChanged(0)
    observe({ a: "disconnected", b: "connecting" }, ["a", "b"])
    observe({ a: "connected", b: "connecting" }, ["a", "b"], { a: "relay/host" })
    const [game] = journeysNamed("game")
    const reconnect = game.steps.find((step) => step.name === "rtc.reconnect")
    expect(reconnect).toMatchObject({ ended: true, endAttrs: { "rtc.outcome": "reconnected", "rtc.path": "relay" } })
    expect(game.sad).toEqual(["peer-reconnect"])
    expect(recorded.failures).toHaveLength(0)
  })

  it("spans each period a peer is away, with who and why", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.peerAway("b", "said")
    trace.peerAway("b", "said") // the same period is one span
    trace.peerBack("b")
    trace.peerAway("b", "timeout")
    trace.peerBack("b")
    trace.peerBack("c") // never away: nothing to end
    trace.peerAway("d", "said")
    trace.peersBack() // a closed room ends every open period
    const [game] = journeysNamed("game")
    const spans = game.steps.filter((step) => step.name === "game.peer.away")
    expect(spans).toHaveLength(3)
    expect(spans.every((step) => step.ended)).toBe(true)
    expect(spans[0]).toMatchObject({ attrs: { "rtc.peer": expect.any(String), "away.reason": "said" }, ended: true })
    expect(spans[1]).toMatchObject({ attrs: { "away.reason": "timeout" }, ended: true })
  })

  it("spans a camera recovery", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.cameraRecovering("track-ended")
    trace.cameraRecovered()
    const [game] = journeysNamed("game")
    expect(game.steps.find((step) => step.name === "camera.recover")).toMatchObject({
      attrs: { "camera.reason": "track-ended" },
      ended: true,
    })
    expect(game.sad).toEqual(["camera-recover"])
  })

  it("measures the confirm window and the landing, through a failed first try", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.roundChanged(null)
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportFailed("Invalid.Payment")
    trace.reportSubmitting()
    trace.reportLanded(5)
    const [game] = journeysNamed("game")
    expect(game.steps.filter((step) => step.name.startsWith("report.")).map((step) => [step.name, step.endAttrs?.["report.outcome"]])).toEqual([
      ["report.submit", undefined],
      ["report.landed", "failed"],
      ["report.landed", "landed"],
    ])
    expect(game.sad).toEqual(["report-retry"])
    expect(game.outcome).toBe("completed")
    expect(recorded.failures).toEqual([
      expect.objectContaining({ kind: "report-failed", details: { reason: "refused", context: { error: "Invalid.Payment" } } }),
    ])
  })

  it("ends isolated and reports the blamed layer", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.isolated("store-write")
    expect(journeysNamed("game")[0].outcome).toBe("isolated")
    expect(recorded.failures[0]).toMatchObject({ kind: "mesh-isolated", details: { reason: "store-write" } })
  })

  it("ends abandoned when the player leaves before the report lands", async () => {
    vi.useFakeTimers()
    joinWith(true)
    trace.roundChanged(0)
    trace.leftGame()
    await vi.advanceTimersByTimeAsync(10)
    expect(journeysNamed("game")[0].outcome).toBe("abandoned")
  })

  it("does not restart a finished game", () => {
    joinWith(true)
    trace.roundChanged(0)
    trace.reportLanded(5)
    const sceneCalls = [...scenes.calls]
    trace.roundChanged(1)
    const games = journeysNamed("game")
    expect(games).toHaveLength(1)
    expect(games[0].steps.filter((step) => step.name.startsWith("round."))).toHaveLength(1)
    expect(scenes.calls).toEqual(sceneCalls)
  })
})

describe("journey.payoff", () => {
  it("starts at the report landing, in the game's trace, waiting for the draw", () => {
    landed()
    trace.reportLanded(5)
    const [game] = journeysNamed("game")
    const [payoff] = journeysNamed("payoff")
    expect(journeysNamed("payoff")).toHaveLength(1)
    expect(payoff.options.sameTraceAs).toBe(game.handle)
    expect(payoff.steps.map((step) => [step.name, step.ended])).toEqual([
      ["draw.show", false],
    ])
  })

  it("ends attestations.ready when the chain settles this game, and only this game", () => {
    landed()
    trace.collectablesOpened()
    trace.gameSettledFor(4)
    expect(journeysNamed("payoff")[0].steps.find((step) => step.name === "attestations.ready")?.ended).toBe(false)
    trace.gameSettledFor(5)
    expect(journeysNamed("payoff")[0].steps.find((step) => step.name === "attestations.ready")?.ended).toBe(true)
  })

  it("does not send attestations-late while the payoff lingers on the draw", async () => {
    vi.useFakeTimers()
    landed()
    await vi.advanceTimersByTimeAsync(trace.ATTESTATIONS_LATE_MS * 2)
    expect(recorded.failures).toHaveLength(0)
  })

  it("sends attestations-late once, 60 s after the collectables screen opens", async () => {
    vi.useFakeTimers()
    landed()
    await vi.advanceTimersByTimeAsync(trace.ATTESTATIONS_LATE_MS)
    trace.collectablesOpened()
    await vi.advanceTimersByTimeAsync(trace.ATTESTATIONS_LATE_MS - 1)
    expect(recorded.failures).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(recorded.failures).toEqual([expect.objectContaining({ kind: "attestations-late", details: { reason: "60s", context: { seconds: "60" } } })])
    await vi.advanceTimersByTimeAsync(trace.ATTESTATIONS_LATE_MS)
    expect(recorded.failures).toHaveLength(1)
  })

  it("carries the sign-up's skip reason to the draw", () => {
    trace.signupDraws(0, "no draw scheduled")
    landed()
    expect(trace.currentSignupSkip()).toBe("no draw scheduled")
  })

  it("collects the draw and the collectables screen, ends shown at the hand-off and sends the game log", () => {
    landed()
    trace.gameSettledFor(5)
    trace.drawShown({ kind: "ready", draw: { userTicket: "t", wheel: {}, won: false } as never }, null, 5)
    trace.collectablesOpened()
    trace.collectablesShown({ "chest.outcome": "collectables", "chest.count": "3" })
    trace.payoffHandedOff()
    const [payoff] = journeysNamed("payoff")
    expect(payoff.steps.map((step) => [step.name, step.ended])).toEqual([
      ["draw.show", true],
      ["attestations.ready", true],
      ["chest.show", true],
    ])
    expect(payoff.attrs).toMatchObject({ "draw.invited": "true", "chest.count": "3" })
    expect(payoff.outcome).toBe("shown")
    expect(recorded.gameLogs).toEqual([
      { gameIndex: 5, since: expect.any(Number), trace: payoff.handle.trace, stage: "report" },
      { gameIndex: 5, since: expect.any(Number), trace: payoff.handle.trace, stage: "payoff" },
    ])
  })

  it("ignores the draw while it is still loading, and ends draw.show once at the result", () => {
    landed()
    trace.drawShown({ kind: "loading" }, null, 5)
    trace.drawShown({ kind: "ready", draw: { userTicket: null, wheel: {}, won: false } as never }, null, 5)
    const draw = journeysNamed("payoff")[0].steps.find((step) => step.name === "draw.show")
    expect(draw?.endAttrs).toEqual({ "draw.invited": "false", "draw.reason": "not-entered", "draw.won": "false" })
  })

  it("sends the game log the moment the report lands, before any payoff screen", () => {
    landed()
    const [payoff] = journeysNamed("payoff")
    expect(recorded.gameLogs).toEqual([{ gameIndex: 5, since: expect.any(Number), trace: payoff.handle.trace, stage: "report" }])
    trace.payoffHandedOff()
    expect(recorded.gameLogs.map((request) => request.stage)).toEqual(["report", "payoff"])
  })

  it("ends stalled at the collectables screen's stall escape", () => {
    landed()
    trace.collectablesOpened()
    trace.payoffStalled("chest.load")
    trace.collectablesShown({ "chest.outcome": "none", "chest.reason": "failed" })
    trace.payoffHandedOff()
    const [payoff] = journeysNamed("payoff")
    expect(payoff.outcome).toBe("stalled")
    expect(payoff.endAttrs).toMatchObject({ "payoff.stage": "chest.load" })
  })

  it("records how long a later collectables read took to recover", () => {
    landed()
    trace.collectablesOpened()
    trace.collectablesReadRecovered(33_000)
    trace.collectablesShown({ "chest.outcome": "collectables", "chest.count": "2" })
    const [payoff] = journeysNamed("payoff")
    expect(payoff.attrs).toMatchObject({ "chest.recovered": "true" })
    expect(recorded.metrics).toContainEqual({
      type: "distribution",
      name: "chest.recovery_ms",
      value: 33_000,
      unit: "millisecond",
      attrs: {},
    })
  })

  it("ignores the payoff pages when there is no payoff (a reload into /collectables)", () => {
    trace.collectablesOpened()
    trace.collectablesShown({ "chest.outcome": "none", "chest.reason": "absent" })
    trace.payoffHandedOff()
    expect(journeysNamed("payoff")).toHaveLength(0)
    expect(recorded.gameLogs).toHaveLength(0)
  })
})

describe("link quality on the round steps", () => {
  /** a 3 s reading of one link, counters growing with `n` */
  const reading = (n: number): RtcSample => ({
    link: 1,
    at: n * 3000,
    rttMs: 150,
    inbound: { id: "IV", fps: 22, height: 640, jitterMs: 10, packetsLost: n * 3, packetsReceived: n * 297 },
    outbound: { id: "OV", fps: 24, height: 480, bytesSent: n * 150_000 },
  })
  let n = 0
  const tick = (ids: string[]) => {
    n += 1
    trace.observeRtcReport(ids.map((id) => ({ id, pair: "relay/srflx", quality: reading(n) })))
  }
  const round = (index: number) => journeysNamed("game")[0].steps.find((step) => step.name === `round.${index}`)

  beforeEach(() => {
    n = 0
  })

  function start() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("me", 0)
    observe({ a: "connected", b: "connected" }, ["a", "b"], { a: "relay/srflx", b: "relay/srflx" })
    trace.roundChanged(0)
  }

  it("puts the round's summary on its step as the next round opens, and sends one summary per peer per round", () => {
    start()
    for (let i = 0; i < 4; i++) tick(["a", "b"])
    trace.roundChanged(1)
    expect(round(1)).toMatchObject({ ended: true, attrs: { "rtc.summary": "2 peers: rtt p95 150ms, loss p95 1.0%, in 22fps, out 24fps" } })
    for (let i = 0; i < 4; i++) tick(["a"])
    trace.confirmOpened()
    expect(round(2)).toMatchObject({ ended: true, attrs: { "rtc.summary": "1 peer: rtt p95 150ms, loss p95 1.0%, in 22fps, out 24fps" } })
    const p95 = recorded.metrics.filter((point) => point.name === "rtc.rtt_ms" && point.attrs.stat === "p95")
    expect(p95.map((point) => [point.attrs.round, point.attrs["rtc.peer"], point.attrs["rtc.path"]])).toEqual([
      ["1", "0", "relay"],
      ["1", "1", "relay"],
      ["2", "0", "relay"],
    ])
    // the report stage is not a round: nothing more is summarised
    tick(["a"])
    trace.reportSubmitting()
    trace.reportLanded(5)
    expect(recorded.metrics.filter((point) => point.name === "rtc.rtt_ms" && point.attrs.stat === "p95")).toHaveLength(3)
  })

  it("summarises the round a null round closes", () => {
    start()
    tick(["a"])
    tick(["a"])
    trace.roundChanged(null)
    expect(round(1)?.attrs["rtc.summary"]).toBe("1 peer: rtt p95 150ms, loss p95 1.0%, in 22fps, out 24fps")
  })

  it("summarises the open round of a game that ends early, and leaves the step to be cut", async () => {
    vi.useFakeTimers()
    start()
    tick(["a"])
    tick(["a"])
    trace.leftGame()
    await vi.advanceTimersByTimeAsync(0)
    const [game] = journeysNamed("game")
    expect(game.outcome).toBe("abandoned")
    expect(round(1)).toMatchObject({ attrs: { "rtc.summary": "1 peer: rtt p95 150ms, loss p95 1.0%, in 22fps, out 24fps" }, endAttrs: { "step.outcome": "cut" } })
    expect(recorded.metricFlushes).toBe(1)
  })

  it("numbers the peers afresh for the next game", () => {
    start()
    tick(["a", "b"])
    tick(["a", "b"])
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    trace.payoffHandedOff()
    resetRecorded()
    // the next game has only b in it: b, the second peer of the last game, is its first
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(6, 0)
    trace.meshOpened("me", 0)
    observe({ b: "connected" }, ["b"], { b: "relay/srflx" })
    trace.roundChanged(0)
    tick(["b"])
    tick(["b"])
    trace.confirmOpened()
    expect(recorded.metrics.filter((point) => point.name === "rtc.rtt_ms").map((point) => point.attrs["rtc.peer"])).toEqual(["0", "0"])
  })
})

describe("smoothness scenes", () => {
  const ready = { kind: "ready", draw: { userTicket: "t", wheel: {}, won: false } } as never

  it("a round enters game.round and keeps it through the rotation countdown; the confirm stage enters game.confirm", () => {
    trace.beginJoin({ cameraWarm: true })
    scenes.calls.length = 0
    trace.roundChanged(0)
    expect(scenes.calls).toEqual(["enter game.round"])
    // between rounds: the FLIP and the stagger are the heaviest frames of the game
    trace.roundChanged(null, true)
    trace.roundChanged(1)
    trace.confirmOpened()
    expect(scenes.calls).toEqual(["enter game.round", "enter game.round", "enter game.confirm"])
  })

  it("leaves game.round once the rounds are over, not between them", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.roundChanged(0)
    scenes.calls.length = 0
    trace.roundChanged(null, true)
    expect(scenes.calls).toEqual([])
    // the last round's gap gives way to reporting with no confirm stage (already submitted)
    trace.roundChanged(null)
    expect(scenes.calls).toEqual(["leave game.round"])
  })

  it("still ends the round step and sends its link summary between rounds", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.roundChanged(0)
    trace.roundChanged(null, true)
    const [game] = journeysNamed("game")
    expect(game.steps.find((step) => step.name === "round.1")?.ended).toBe(true)
  })

  it("the game ending leaves its scenes", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.roundChanged(0)
    trace.confirmOpened()
    scenes.calls.length = 0
    trace.reportLanded(5)
    expect(scenes.calls).toContain("leave game.confirm")
    expect(scenes.calls).toContain("leave game.round")
  })

  it("the payoff screens own their scenes (useScene): the trace enters none, so none is left behind", () => {
    trace.drawShown({ kind: "loading" }, null, 5)
    trace.drawShown(ready, null, 5)
    trace.collectablesOpened()
    trace.payoffHandedOff()
    expect(scenes.calls.filter((call) => call.startsWith("enter"))).toEqual([])
  })

  it("a new join clears any scene left over", () => {
    trace.beginJoin({ cameraWarm: true })
    expect(scenes.calls).toEqual(["leave all"])
  })

  it("records the JS heap once, when the payoff ends", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.roundChanged(0)
    trace.confirmOpened()
    trace.reportSubmitting()
    trace.reportLanded(5)
    expect(scenes.calls.filter((call) => call === "heap")).toEqual([])
    trace.payoffHandedOff()
    trace.payoffHandedOff()
    expect(scenes.calls.filter((call) => call === "heap")).toEqual(["heap"])
  })

})

describe("join intervals", () => {
  it("chain.read runs from the join's start to the first game read", () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    trace.beginJoin({ cameraWarm: true })
    vi.setSystemTime(10_450)
    trace.noteGame(5, 0)
    trace.noteGame(5, 0)
    const reads = journeysNamed("join")[0].steps.filter((step) => step.name === "chain.read")
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatchObject({ ended: true, startedAt: 10_000 })
  })

  it("statements.first_page runs from the subscription to the first page, once", () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    trace.beginJoin({ cameraWarm: true })
    trace.statementsSubscribed()
    vi.setSystemTime(20_900)
    trace.statementsSubscribed() // a later subscription does not move the start
    trace.statementsFirstPage()
    trace.statementsFirstPage()
    const pages = journeysNamed("join")[0].steps.filter((step) => step.name === "statements.first_page")
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ ended: true, startedAt: 20_000 })
  })

  it("a subscription that never got a page does not start the next game's step", () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    trace.beginJoin({ cameraWarm: true })
    trace.statementsSubscribed() // no page ever arrives
    trace.leftGame()
    vi.runAllTimers()
    vi.setSystemTime(40_000)
    trace.beginJoin({ cameraWarm: true })
    vi.setSystemTime(40_100)
    trace.statementsSubscribed()
    trace.statementsFirstPage()
    const pages = journeysNamed("join")[1].steps.filter((step) => step.name === "statements.first_page")
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ startedAt: 40_100 })
  })

  it("a second room subscription in the same join does not arm a second step", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.statementsSubscribed()
    trace.statementsFirstPage()
    trace.statementsSubscribed()
    trace.statementsFirstPage()
    expect(journeysNamed("join")[0].steps.filter((step) => step.name === "statements.first_page")).toHaveLength(1)
  })

  it("a first page with no join open, or no subscription, records nothing", () => {
    trace.statementsFirstPage()
    trace.beginJoin({ cameraWarm: true })
    trace.statementsFirstPage()
    expect(journeysNamed("join")[0].steps.filter((step) => step.name === "statements.first_page")).toEqual([])
  })

})

describe("the pair id on every rtc step and metric (#255)", () => {
  const reading = (n: number): RtcSample => ({
    link: 1,
    at: n * 3000,
    rttMs: 150,
    inbound: { id: "IV", fps: 22, height: 640, jitterMs: 10, packetsLost: n * 3, packetsReceived: n * 297 },
    outbound: { id: "OV", fps: 24, height: 480, bytesSent: n * 150_000 },
  })

  function join() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }

  it("names both ends on the join's rtc.peer step, with the round the mesh opened for", () => {
    join()
    observe({ amy: "connecting" }, ["amy"])
    const peer = journeysNamed("join")[0].steps.find((step) => step.name === "rtc.peer")
    expect(peer?.attrs).toMatchObject({ "rtc.peer": "0", "rtc.pair": "g5:r1:6fc008fbdd24" })
  })

  it("names the pair on the reconnect and away steps, in the round being played", () => {
    join()
    observe({ amy: "connected" }, ["amy"], { amy: "host/host" })
    trace.roundChanged(1)
    observe({ amy: "disconnected" }, ["amy"])
    trace.peerAway("amy", "said")
    const game = journeysNamed("game")[0]
    expect(game.steps.find((step) => step.name === "rtc.reconnect")?.attrs["rtc.pair"]).toBe("g5:r2:6fc008fbdd24")
    expect(game.steps.find((step) => step.name === "game.peer.away")?.attrs["rtc.pair"]).toBe("g5:r2:6fc008fbdd24")
  })

  it("says on the round step that coverage is unsupported when the stats carry no frame counter", () => {
    join()
    observe({ amy: "connected" }, ["amy"], { amy: "host/host" })
    trace.roundChanged(0)
    for (let n = 0; n <= 3; n++) trace.observeRtcReport([{ id: "amy", conn: "connected", pair: "host/host", quality: reading(n) }])
    trace.roundChanged(1)
    const unsupported = journeysNamed("game")[0].steps.find((step) => step.name === "round.1")?.attrs["rtc.unsupported"]
    // the device-side categories this fixture lacks are said too (#263)
    expect(String(unsupported).split(",")).toEqual(expect.arrayContaining(["coverage", "decode_time", "encoder"]))
    expect(recorded.metrics.filter((point) => point.name === "rtc.coverage_pct")).toEqual([])
  })

  it("is on every metric point of a peer's round, beside rtc.peer", () => {
    join()
    observe({ amy: "connected" }, ["amy"], { amy: "host/host" })
    trace.roundChanged(0)
    for (let n = 0; n <= 5; n++) trace.observeRtcReport([{ id: "amy", pair: "host/host", quality: reading(n) }])
    trace.roundChanged(1)
    const points = recorded.metrics.filter((point) => point.name.startsWith("rtc."))
    expect(points.length).toBeGreaterThan(0)
    for (const point of points) expect(point.attrs).toMatchObject({ "rtc.peer": "0", "rtc.pair": "g5:r1:6fc008fbdd24" })
  })
})

describe("the connection funnel (#257)", () => {
  function join() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }
  const funnel = () => recorded.metrics.filter((point) => point.name === "rtc.funnel_ms")
  const peerStep = () => journeysNamed("join")[0].steps.find((step) => step.name === "rtc.peer")

  it("sends rtc.funnel_ms per stage, in ms, with the stage, the role, the pair and the peer", () => {
    join()
    trace.recordMeshEvent("amy", { kind: "stage", stage: "offer", ms: 120 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "connected", ms: 2400 })
    expect(funnel()).toEqual([
      {
        type: "distribution",
        name: "rtc.funnel_ms",
        value: 120,
        unit: "millisecond",
        attrs: { stage: "offer", "rtc.role": "answerer", "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" },
      },
      expect.objectContaining({ value: 2400, attrs: expect.objectContaining({ stage: "connected", "rtc.peer": "0" }) }),
    ])
  })

  it("tags a standby peer's funnel points rtc.standby and leaves an active peer's untagged (#1156)", () => {
    join()
    setRtcStandby(["bob"])
    trace.recordMeshEvent("bob", { kind: "stage", stage: "offer", ms: 100 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "offer", ms: 120 })
    expect(funnel().map((point) => point.attrs["rtc.standby"])).toEqual(["true", undefined])
  })

  it("names the last stage a pair reached on its rtc.peer step when it fails", () => {
    join()
    observe({ amy: "connecting" }, ["amy"])
    observe({ amy: "failed" }, ["amy"], {}, { amy: "failed" }, { amy: "answer" }) // the mesh row says how far it got
    expect(peerStep()?.attrs["rtc.role"]).toBe("answerer") // "amy" < "zed": amy offers, zed answers
    expect(peerStep()?.endAttrs).toMatchObject({ "rtc.outcome": "failed", "rtc.last_stage": "answer" })
  })

  it("says the last stage is none for a pair that reached nothing, and on a join that ends with it pending", () => {
    join()
    observe({ amy: "connecting" }, ["amy"])
    onTimeRound() // the join ends with amy still pending
    expect(peerStep()?.endAttrs).toMatchObject({ "rtc.outcome": "pending", "rtc.last_stage": "none" })
  })

  it("puts no last stage on a pair that connected", () => {
    join()
    observe({ amy: "connecting" }, ["amy"])
    observe({ amy: "connected" }, ["amy"], { amy: "host/host" }, {}, { amy: "connected" })
    expect(peerStep()?.endAttrs?.["rtc.last_stage"]).toBeUndefined()
  })

})

describe("the selected path through the game (#258)", () => {
  const link = (over: Partial<RtcSample> = {}): RtcSample => ({ link: 1, localType: "relay", remoteType: "srflx", protocol: "udp", relayProtocol: "tls", networkType: "cellular", ...over })
  const report = (id: string, quality: RtcSample) => trace.observeRtcReport([{ id, conn: "connected", pair: `${quality.localType}/${quality.remoteType}`, quality }])
  const pathSteps = () => journeysNamed("game")[0].steps.filter((step) => step.name === "rtc.path")
  const pathLines = () => logs.lines.filter((line) => line.startsWith("[jollity-rtc] path "))

  function start() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
    observe({ amy: "connected" }, ["amy"], { amy: "relay/srflx" })
  }

  it("logs a path line and records an rtc.path step on the game when the pair is first set", () => {
    start()
    trace.roundChanged(0)
    report("amy", link())
    expect(pathLines()).toEqual(["[jollity-rtc] path amy relay/srflx tls"])
    expect(pathSteps()).toHaveLength(1)
    expect(pathSteps()[0]).toMatchObject({
      ended: true,
      attrs: {
        "rtc.peer": "0",
        "rtc.pair": "g5:r1:6fc008fbdd24",
        "rtc.path": "relay",
        "rtc.local_type": "relay",
        "rtc.remote_type": "srflx",
        "rtc.protocol": "udp",
        "rtc.relay_protocol": "tls",
      },
    })
  })

  it("does not repeat the line or the step while the path holds", () => {
    start()
    trace.roundChanged(0)
    report("amy", link())
    report("amy", link())
    report("amy", link({ link: 2 }))
    expect(pathLines()).toHaveLength(1)
    expect(pathSteps()).toHaveLength(1)
  })

  it("records a change as a second step and line, and counts it for the round", () => {
    start()
    trace.roundChanged(0)
    report("amy", link())
    report("amy", link({ localType: "host", remoteType: "host", relayProtocol: undefined }))
    report("amy", link())
    expect(pathLines()).toEqual(["[jollity-rtc] path amy relay/srflx tls", "[jollity-rtc] path amy host/host udp", "[jollity-rtc] path amy relay/srflx tls"])
    expect(pathSteps()).toHaveLength(3)
    trace.roundChanged(1)
    const changes = recorded.metrics.filter((point) => point.name === "rtc.path_changes")
    expect(changes).toEqual([{ type: "count", name: "rtc.path_changes", value: 2, attrs: expect.objectContaining({ round: "1", "rtc.peer": "0", "rtc.pair": "g5:r1:6fc008fbdd24" }) }])
  })

  it("sends no path_changes for a round whose path never changed", () => {
    start()
    trace.roundChanged(0)
    report("amy", link())
    trace.roundChanged(1)
    expect(recorded.metrics.filter((point) => point.name === "rtc.path_changes")).toEqual([])
  })

  it("logs the path set during the join at once, and leaves it to the join's rtc.peer step (no game step is made up)", () => {
    start()
    report("amy", link())
    expect(pathLines()).toEqual(["[jollity-rtc] path amy relay/srflx tls"])
    expect(journeysNamed("game")).toHaveLength(0)
    const peer = journeysNamed("join")[0].steps.find((step) => step.name === "rtc.peer")
    expect(peer?.endAttrs).toMatchObject({ "rtc.path": "relay" })
    trace.roundChanged(0)
    expect(pathSteps()).toHaveLength(0)
  })

  it("says unsupported for a protocol the browser did not report", () => {
    start()
    trace.roundChanged(0)
    report("amy", link({ protocol: undefined, relayProtocol: undefined, networkType: undefined }))
    expect(pathSteps()[0].attrs).toMatchObject({ "rtc.protocol": "unsupported", "rtc.relay_protocol": "unsupported", "rtc.network": "unsupported" })
    expect(pathLines()).toEqual(["[jollity-rtc] path amy relay/srflx unsupported"])
  })

})

describe("the relay credential outcome (#259)", () => {
  const turnPoints = () => recorded.metrics.filter((point) => point.name === "rtc.turn_ttl_left_s")

  it("marks the join issued, with the seconds left on the credentials", () => {
    trace.beginJoin({ cameraWarm: true })
    ice.outcome?.({ received: "true", ttlLeftS: 600 })
    expect(journeysNamed("join")[0].attrs).toMatchObject({ "turn.received": "true", "turn.stage": "none", "turn.status": "none" })
    expect(turnPoints()).toEqual([{ type: "distribution", name: "rtc.turn_ttl_left_s", value: 600, unit: "second", attrs: { "turn.received": "true", round: "1" } }])
    expect(recorded.failures).toEqual([])
  })

  it("marks a cache hit cached, with what is left of the seconds", () => {
    trace.beginJoin({ cameraWarm: true })
    ice.outcome?.({ received: "cached", ttlLeftS: 412 })
    expect(journeysNamed("join")[0].attrs["turn.received"]).toBe("cached")
    expect(turnPoints()[0]).toMatchObject({ value: 412, attrs: { "turn.received": "cached" } })
  })

  it("names the stage and status on the journey, and the reason once, in the turn-unavailable failure", () => {
    trace.beginJoin({ cameraWarm: true })
    ice.outcome?.({ received: "false", stage: "issue", status: 400, reason: "proof rejected: ring revision too old" })
    const attrs = journeysNamed("join")[0].attrs
    expect(attrs).toMatchObject({ "turn.received": "false", "turn.stage": "issue", "turn.status": "400" })
    expect(attrs["turn.reason"]).toBeUndefined()
    expect(turnPoints()).toEqual([])
    expect(recorded.failures).toEqual([
      {
        kind: "turn-unavailable",
        details: { reason: "issue", context: { status: "400", detail: "proof rejected: ring revision too old" } },
        journey: "join",
        expected: false,
      },
    ])
  })

  it("reports the cause as the failure's reason, so each kind of refusal is its own group", () => {
    trace.beginJoin({ cameraWarm: true })
    ice.outcome?.({ received: "false", stage: "issue", status: 429, reason: "redemption limit reached", cause: "redemption-limit" })
    expect(recorded.failures[0].details).toEqual({ reason: "redemption-limit", context: { status: "429", detail: "redemption limit reached" } })
  })

  it("defuses the masked words and caps the reason in the failure", () => {
    trace.beginJoin({ cameraWarm: true })
    ice.outcome?.({ received: "false", stage: "issue", status: 401, reason: `bad credential ${"x".repeat(300)}` })
    const detail = recorded.failures[0].details.context?.detail as string
    expect(detail.startsWith("bad cr*dential")).toBe(true)
    expect(detail).toHaveLength(120)
  })

  it("says the status is none when the failure had none (the host gave no proof)", () => {
    trace.beginJoin({ cameraWarm: true })
    ice.outcome?.({ received: "false", stage: "proof", reason: "no personhood proof from the host" })
    expect(journeysNamed("join")[0].attrs).toMatchObject({ "turn.received": "false", "turn.stage": "proof", "turn.status": "none" })
    expect(recorded.failures[0].details).toEqual({ reason: "proof", context: { detail: "no personhood proof from the host" } })
  })

  it("keeps the host-chain refusal in context and classifies its TURN stage", () => {
    trace.beginJoin({ cameraWarm: true })
    ice.outcome?.({
      received: "false",
      stage: "proof-chain",
      reason: "no proof: CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }",
      cause: "proof-failed",
    })
    expect(journeysNamed("join")[0].attrs).toMatchObject({
      "turn.received": "false",
      "turn.stage": "proof-chain",
      "turn.status": "none",
    })
    expect(recorded.failures[0].details).toEqual({
      reason: "proof-failed",
      context: {
        detail: "no proof: CannotGetCurrentBlock { reason: Rpc(SubscriptionDropped) }",
      },
    })
  })

  it("a success after a refusal on the same journey leaves none of the refusal's values", () => {
    trace.beginJoin({ cameraWarm: true })
    onTimeRound()
    ice.outcome?.({ received: "false", stage: "issue", status: 503, reason: "upstream unavailable" })
    ice.outcome?.({ received: "true", ttlLeftS: 600 })
    expect(journeysNamed("game")[0].attrs).toMatchObject({ "turn.received": "true", "turn.stage": "none", "turn.status": "none" })
  })

  it("goes to the game journey for a later round's mesh, once the join has ended", () => {
    trace.beginJoin({ cameraWarm: true })
    onTimeRound()
    ice.outcome?.({ received: "false", stage: "issue", status: 503, reason: "upstream unavailable" })
    expect(journeysNamed("game")[0].attrs).toMatchObject({ "turn.received": "false", "turn.status": "503" })
    expect(recorded.failures[0]).toMatchObject({ kind: "turn-unavailable", journey: "game" })
  })

})

describe("ICE gathering detail (#260)", () => {
  function join() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }
  const named = (name: string) => recorded.metrics.filter((point) => point.name === name)
  const peerStep = () => journeysNamed("join")[0].steps.find((step) => step.name === "rtc.peer")
  const counts = { host: 2, srflx: 1, relay: 0, other: 0 }

  it("sends the candidates by type and the gathering time, with the pair, the peer and the round", () => {
    join()
    trace.recordMeshEvent("amy", { kind: "gather", counts, ms: 1200, errors: [] })
    const base = { "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" }
    expect(named("rtc.candidates").map((point) => [point.attrs["rtc.candidate_type"], point.value, point.unit])).toEqual([
      ["host", 2, "none"],
      ["srflx", 1, "none"],
      ["relay", 0, "none"], // a zero is the answer to "no relay"
      ["other", 0, "none"],
    ])
    expect(named("rtc.candidates")[0].attrs).toMatchObject(base)
    expect(named("rtc.gather_ms")).toEqual([{ type: "distribution", name: "rtc.gather_ms", value: 1200, unit: "millisecond", attrs: base }])
  })

  it("spans each distinct icecandidateerror once on the join, by code and host", () => {
    join()
    for (const error of [{ code: "701", host: "turn.example.org" }, { code: "701", host: "turn.example.org" }, { code: "401", host: "turn.example.org" }])
      trace.recordMeshEvent("amy", { kind: "ice_error", ...error })
    const steps = journeysNamed("join")[0].steps.filter((step) => step.name === "rtc.ice_error")
    expect(steps.map((step) => step.attrs["rtc.error_code"])).toEqual(["701", "401"])
    expect(steps[0].attrs).toMatchObject({ "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.error_host": "turn.example.org" })
    expect(named("rtc.ice_errors")).toEqual([]) // the counts ride the gathering
  })

  it("counts a gathering's errors once per code and host, with n, when it completes", () => {
    join()
    trace.recordMeshEvent("amy", { kind: "gather", counts, ms: 900, errors: [{ code: "701", host: "turn.example.org", n: 3 }] })
    expect(named("rtc.ice_errors")).toEqual([
      { type: "count", name: "rtc.ice_errors", value: 3, attrs: { "rtc.error_code": "701", "rtc.error_host": "turn.example.org", "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" } },
    ])
  })

  it("shows what a pair that never connected had gathered, on its failed rtc.peer step and as metrics", () => {
    join()
    observe({ amy: "connecting" }, ["amy"])
    trace.observeMesh({
      states: states({ amy: "failed" }),
      reports: [{ id: "amy", ice: "failed", gathered: { counts, errors: [{ code: "701", host: "h", n: 2 }] } }],
      present: new Set(["amy"]),
      turnServers: 2,
    })
    expect(peerStep()?.endAttrs).toMatchObject({ "rtc.outcome": "failed", "rtc.gathered": "2/1/0" })
    expect(named("rtc.candidates").map((point) => point.value)).toEqual([2, 1, 0, 0]) // the gathering never completed: sent from the report
    expect(named("rtc.gather_ms")).toEqual([]) // no time without a completed gathering
    expect(named("rtc.ice_errors").map((point) => point.value)).toEqual([2]) // and the errors it had
  })

  it("does not send a gathering twice: the completed one is not repeated from the report", () => {
    join()
    observe({ amy: "connecting" }, ["amy"])
    trace.recordMeshEvent("amy", { kind: "gather", counts, ms: 900, errors: [] })
    trace.observeMesh({ states: states({ amy: "failed" }), reports: [{ id: "amy", ice: "failed", gathered: { counts, errors: [{ code: "701", host: "h", n: 2 }] } }], present: new Set(["amy"]), turnServers: 2 })
    expect(named("rtc.candidates")).toHaveLength(4)
  })

  it("says the gathered counts on a join that ends with the pair pending", () => {
    join()
    trace.observeMesh({ states: states({ amy: "connecting" }), reports: [{ id: "amy", ice: "checking", gathered: { counts, errors: [] } }], present: new Set(["amy"]), turnServers: 2 })
    onTimeRound()
    expect(peerStep()?.endAttrs).toMatchObject({ "rtc.outcome": "pending", "rtc.gathered": "2/1/0" })
  })

})

describe("restart and rebuild detail (#261)", () => {
  function join() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }
  const heals = () => recorded.metrics.filter((point) => point.name === "rtc.heal_ms")
  const healed = { kind: "heal", trigger: "disconnected", action: "ice_restart", attempt: 1, healed: true, healMs: 2500, end: "connected" } as const

  it("sends rtc.heal_ms with the trigger, action, attempt, outcome, the pair and the round", () => {
    join()
    trace.recordMeshEvent("amy", healed)
    expect(heals()).toEqual([
      {
        type: "distribution",
        name: "rtc.heal_ms",
        value: 2500,
        unit: "millisecond",
        attrs: {
          "rtc.heal_trigger": "disconnected",
          "rtc.heal_action": "ice_restart",
          "rtc.heal_attempt": "1",
          "rtc.healed": "true",
          "rtc.heal_end": "connected",
          "rtc.pair": "g5:r1:6fc008fbdd24",
          "rtc.peer": "0",
          round: "1",
        },
      },
    ])
  })

  it("carries unseen detail with string attempt attributes on both attempt outputs", () => {
    join()
    trace.recordMeshEvent("amy", { ...healed, trigger: "negotiation_error", action: "rebuild", detail: "unseen" })

    expect(heals()[0]?.attrs).toMatchObject({
      "rtc.heal_detail": "unseen",
      "rtc.heal_attempt": "1",
      "rtc.healed": "true",
    })
    const span = journeysNamed("join")[0].steps.find((step) => step.name === "rtc.heal")
    expect(span?.attrs).toMatchObject({
      "rtc.heal_detail": "unseen",
      "rtc.heal_attempt": "1",
      "rtc.healed": "true",
    })
  })

  it("names the #1020 repairs: a network change and an offer left unanswered", () => {
    join()
    trace.recordMeshEvent("amy", { ...healed, trigger: "network_change" })
    trace.recordMeshEvent("amy", { kind: "heal", trigger: "answer_timeout", action: "rebuild", attempt: 1, healed: true, healMs: 1200, end: "connected" })
    expect(heals().map((point) => [point.attrs["rtc.heal_trigger"], point.attrs["rtc.heal_action"], point.value])).toEqual([
      ["network_change", "ice_restart", 2500],
      ["answer_timeout", "rebuild", 1200],
    ])
  })

  it("sends a failed attempt too, so the success rate has its denominator", () => {
    join()
    trace.recordMeshEvent("amy", healed)
    trace.recordMeshEvent("amy", { kind: "heal", trigger: "failed", action: "rebuild", attempt: 2, healed: false, healMs: 6000, end: "next_attempt" })
    expect(heals().map((point) => point.attrs["rtc.healed"])).toEqual(["true", "false"])
  })

  it("spans each attempt on the join, then on the game once the join has ended", () => {
    join()
    trace.recordMeshEvent("amy", healed)
    onTimeRound()
    trace.recordMeshEvent("amy", { ...healed, trigger: "media_stall", healMs: 4000 })
    const onJoin = journeysNamed("join")[0].steps.filter((step) => step.name === "rtc.heal")
    const onGame = journeysNamed("game")[0].steps.filter((step) => step.name === "rtc.heal")
    expect(onJoin).toHaveLength(1)
    expect(onGame).toHaveLength(1)
    expect(onGame[0]).toMatchObject({
      attrs: { "rtc.peer": "0", "rtc.pair": expect.stringContaining("6fc008fbdd24"), "rtc.heal_trigger": "media_stall", "rtc.heal_action": "ice_restart", "rtc.heal_attempt": "1", "rtc.healed": "true", "rtc.heal_end": "connected" },
      ended: true,
    })
  })

  it("forwards one typed cohort record without peer identity", () => {
    join()
    trace.recordMeshEvent("amy", {
      kind: "heal_cohort",
      size: 3,
      windowMs: 45,
      relayProtocol: "tcp",
      turnEndpointHost: "turn.cloudflare.com",
      failKind: "torn-down",
      quietMs: [0, 0, 1],
      recoveryMs: [2100, 2115, 2130],
      unrecovered: 0,
      pageHidden: false,
    })

    expect(recorded.healCohorts).toEqual([{
      size: 3,
      windowMs: 45,
      relayProtocol: "tcp",
      turnEndpointHost: "turn.cloudflare.com",
      failKind: "torn-down",
      quietMs: [0, 0, 1],
      recoveryMs: [2100, 2115, 2130],
      unrecovered: 0,
      pageHidden: false,
    }])
    expect(JSON.stringify(recorded.healCohorts)).not.toContain("amy")
  })

  it("forwards each established link's failure, how it died, with the link's attributes", () => {
    join()
    trace.recordMeshEvent("amy", {
      kind: "link_failed",
      failKind: "torn-down",
      quietMs: 0,
      upMs: 28_000,
      path: "relay",
      relayProtocol: "tcp",
      relayProtocolSource: "url",
      turnEndpointHost: "turn.cloudflare.com",
      pageHidden: false,
    })

    expect(recorded.linkFailures).toHaveLength(1)
    const [{ event, attrs }] = recorded.linkFailures
    expect(event).toEqual({
      failKind: "torn-down",
      quietMs: 0,
      upMs: 28_000,
      path: "relay",
      relayProtocol: "tcp",
      relayProtocolSource: "url",
      turnEndpointHost: "turn.cloudflare.com",
      pageHidden: false,
    })
    // the event's own `kind` is the mesh's discriminator, not a failure fact
    expect(event).not.toHaveProperty("kind")
    expect(attrs).toHaveProperty("rtc.pair")
  })

  it("sends one typed away-period row and its duration distribution with the pair", () => {
    join()
    trace.recordMeshEvent("amy", {
      kind: "away_period",
      reason: "timeout",
      return: "statement_description",
      lastAttempt: "rebuild",
      attempts: 2,
      offerer: "peer",
      offererRole: "answerer",
      ms: 12_345,
    })

    expect(recorded.awayPeriods).toEqual([{
      event: expect.objectContaining({ attempts: 2, ms: 12_345 }),
      attrs: { "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" },
    }])
    expect(recorded.metrics.filter((point) => point.name === "rtc.away_ms")).toEqual([{
      type: "distribution",
      name: "rtc.away_ms",
      value: 12_345,
      unit: "millisecond",
      attrs: { "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" },
    }])
  })

  it("sends one typed heal-episode row and its duration distribution with the pair", () => {
    join()
    trace.recordMeshEvent("amy", {
      kind: "heal_episode",
      ladder: "disconnected:ice_restart > disconnected:rebuild",
      steps: 2,
      healed: true,
      end: "connected",
      ms: 12_345,
    })

    expect(recorded.healEpisodes).toEqual([{
      event: expect.objectContaining({ steps: 2, healed: true, ms: 12_345 }),
      attrs: { "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" },
    }])
    expect(recorded.metrics.filter((point) => point.name === "rtc.heal_episode_ms")).toEqual([{
      type: "distribution",
      name: "rtc.heal_episode_ms",
      value: 12_345,
      unit: "millisecond",
      attrs: {
        "rtc.heal_episode_result": "healed",
        "rtc.heal_end": "connected",
        "rtc.pair": "g5:r1:6fc008fbdd24",
        "rtc.peer": "0",
        round: "1",
      },
    }])
  })

})

describe("hard lane negotiation failures (#485)", () => {
  function join() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }

  it("counts the failure by name, SDP stage, operation, reason and pair, and puts it on the journey", () => {
    join()
    trace.recordMeshEvent("amy", {
      kind: "negotiation_error",
      name: "InvalidAccessError",
      stage: "answer",
      operation: "set-remote",
      reason: "ssrc-collision",
    })
    expect(recorded.metrics.filter((point) => point.name === "rtc.negotiation_error")).toEqual([
      expect.objectContaining({
        type: "count",
        value: 1,
        attrs: expect.objectContaining({
          "rtc.error_name": "InvalidAccessError",
          "rtc.negotiation_stage": "answer",
          "rtc.negotiation_operation": "set-remote",
          "rtc.negotiation_reason": "ssrc-collision",
          "rtc.pair": "g5:r1:6fc008fbdd24",
        }),
      }),
    ])
    expect(journeysNamed("join")[0].steps.filter((step) => step.name === "rtc.negotiation_error")).toEqual([
      expect.objectContaining({
        attrs: expect.objectContaining({
          "rtc.peer": "0",
          "rtc.pair": "g5:r1:6fc008fbdd24",
          "rtc.error_name": "InvalidAccessError",
        }),
        ended: true,
      }),
    ])
  })
})

describe("the sender's SPS on a link (#629)", () => {
  function join() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }
  const sps = {
    kind: "sps" as const,
    outcome: "sps" as const,
    mime: "video/H264",
    frames: 2,
    inspectMs: 0.3,
    parseMs: 0.1,
    toKeyMs: 40,
    keyFrameRequest: "sent" as const,
    engine: "script" as const,
    attachMs: 0.2,
    sps: { profileIdc: 66, constraintFlags: 0, levelIdc: 31, pocType: 0, numRefFrames: 1, vui: false, bitstreamRestriction: false, complete: true },
  }

  it("counts the SPS fields under the pair, sends the tap's cost and wait as numbers, and puts a step on the journey", () => {
    join()
    trace.recordMeshEvent("amy", sps)
    expect(recorded.metrics.filter((point) => point.name === "rtc.sps")).toEqual([
      expect.objectContaining({
        type: "count",
        value: 1,
        attrs: expect.objectContaining({ "rtc.sps.poc_type": "0", "rtc.sps.restriction": "false", "rtc.sps.engine": "script", "rtc.pair": "g5:r1:6fc008fbdd24" }),
      }),
    ])
    const cost = recorded.metrics.filter((point) => point.name === "rtc.sps.cost_ms")
    expect(cost).toEqual([expect.objectContaining({ type: "distribution", attrs: expect.objectContaining({ "rtc.sps.outcome": "sps", "rtc.pair": "g5:r1:6fc008fbdd24" }) })])
    expect(cost[0].value).toBeCloseTo(0.5)
    expect(recorded.metrics.filter((point) => point.name === "rtc.sps.to_key_ms").map((point) => point.value)).toEqual([40])
    expect(recorded.metrics.filter((point) => point.name === "rtc.sps.frames").map((point) => point.value)).toEqual([2])
    expect(journeysNamed("join")[0].steps.filter((step) => step.name === "rtc.sps")).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ "rtc.peer": "0", "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.sps.poc_type": "0" }), ended: true }),
    ])
  })

  it("sends one per pair: a rebuilt link in the same round is not a second row", () => {
    join()
    trace.recordMeshEvent("amy", sps)
    trace.recordMeshEvent("amy", sps)
    expect(recorded.metrics.filter((point) => point.name === "rtc.sps")).toHaveLength(1)
  })

  it("sends an untapped link as a row with its reason and no cost", () => {
    join()
    trace.recordMeshEvent("amy", { ...sps, outcome: "untapped", reason: "not-ready", sps: undefined, frames: 0 })
    expect(recorded.metrics.filter((point) => point.name === "rtc.sps")).toEqual([
      expect.objectContaining({ attrs: expect.objectContaining({ "rtc.sps.outcome": "untapped", "rtc.sps.reason": "not-ready" }) }),
    ])
    expect(recorded.metrics.filter((point) => point.name.startsWith("rtc.sps."))).toEqual([])
  })

})

describe("signalling health (#262)", () => {
  function join() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }
  const named = (name: string) => recorded.metrics.filter((point) => point.name === name)

  it("sends rtc.signal_rtt_ms with the route it went by, the role, the pair and the round", () => {
    join()
    trace.recordMeshEvent("amy", { kind: "signal_rtt", ms: 4200, via: "statement", peerPresent: true })
    expect(named("rtc.signal_rtt_ms")).toEqual([
      {
        type: "distribution",
        name: "rtc.signal_rtt_ms",
        value: 4200,
        unit: "millisecond",
        attrs: { "rtc.signal_via": "statement", "rtc.signal_peer_present": "true", "rtc.role": "answerer", "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" },
      },
    ])
  })

  it("tags a round trip to an absent peer and adds the from-first-seen time", () => {
    join()
    trace.recordMeshEvent("amy", { kind: "signal_rtt", ms: 70_300, via: "statement", peerPresent: false, fromSeenMs: 300 })
    expect(named("rtc.signal_rtt_ms")[0].attrs).toMatchObject({ "rtc.signal_peer_present": "false" })
    expect(named("rtc.signal_rtt_from_seen_ms")).toMatchObject([{ type: "distribution", value: 300, unit: "millisecond", attrs: { "rtc.signal_peer_present": "false" } }])
  })

  it("counts a submit that backed off or failed, by frame and reason, under the pair of the peer it was for", () => {
    join()
    trace.signalSubmit({ kind: "retry", frame: "desc", to: "amy", attempt: 1, delayMs: 400, reason: "rejected: no allowance" })
    trace.signalSubmit({ kind: "failed", frame: "cand", to: "amy", attempts: 3, reason: "rejected: no allowance", timedOut: false })
    trace.signalSubmit({ kind: "failed", frame: "presence", to: undefined, attempts: 1, reason: "submit timeout", timedOut: true })
    const points = named("rtc.signal_problems")
    expect(points.map((point) => [point.type, point.value, point.attrs["rtc.signal_event"], point.attrs["rtc.signal_frame"], point.attrs["rtc.signal_reason"]])).toEqual([
      ["count", 1, "retry", "desc", "error"],
      ["count", 1, "failed", "cand", "error"],
      ["count", 1, "failed", "presence", "timeout"],
    ])
    expect(points[0].attrs).toMatchObject({ "rtc.pair": "g5:r1:6fc008fbdd24", round: "1" })
    expect(points[2].attrs["rtc.pair"]).toBeUndefined() // presence is for the room, not a pair
  })

  it("counts a waiting frame replaced by a newer one before it was sent (the per-channel queue, game 199)", () => {
    join()
    trace.signalSubmit({ kind: "replaced", frame: "desc", to: "amy" })
    expect(named("rtc.signal_replaced")).toEqual([
      { type: "count", name: "rtc.signal_replaced", value: 1, attrs: { "rtc.signal_frame": "desc", "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" } },
    ])
    expect(named("rtc.signal_problems")).toEqual([]) // a replacement is the queue working, not a problem
  })

  it("sends how long a frame waited for a submit slot", () => {
    join()
    trace.signalSubmit({ kind: "slot_wait", frame: "desc", to: "amy", waitedMs: 7400 })
    expect(named("rtc.signal_slot_wait_ms")).toEqual([
      { type: "distribution", name: "rtc.signal_slot_wait_ms", value: 7400, unit: "millisecond", attrs: { "rtc.signal_frame": "desc", "rtc.pair": "g5:r1:6fc008fbdd24", "rtc.peer": "0", round: "1" } },
    ])
  })

  it("spans a failed submit once per frame and peer, with the error cleaned for the org's masking", () => {
    join()
    const failed = { kind: "failed", frame: "desc", to: "amy", attempts: 3, reason: "Unauthorized: no credentials", timedOut: false } as const
    trace.signalSubmit(failed)
    trace.signalSubmit(failed)
    const steps = journeysNamed("join")[0].steps.filter((step) => step.name === "rtc.signal")
    expect(steps).toHaveLength(1)
    expect(steps[0].attrs).toMatchObject({ "rtc.signal_frame": "desc", "rtc.signal_reason": "error", "rtc.pair": "g5:r1:6fc008fbdd24" })
    expect(steps[0].attrs["rtc.signal_error"]).toBe("Unau*horized: no cr*dentials")
    expect(named("rtc.signal_problems")).toHaveLength(2) // the counter still counts both
  })

})

describe("the store clock as telemetry (Rule 2)", () => {
  const named = (name: string) => recorded.metrics.filter((point) => point.name === name)
  it("sends the learned margin as a number, by base, and counts a rejection on both stamps", () => {
    trace.storeClockEvent({ kind: "learned", marginMs: 60_000, previousMs: 0, base: "chain" })
    trace.storeClockEvent({ kind: "rejected", reason: "alreadyExpired", marginMs: 0, pushMs: 60_000, base: "chain" })
    expect(named("rtc.store_margin_ms")).toEqual([
      { type: "distribution", name: "rtc.store_margin_ms", value: 60_000, unit: "millisecond", attrs: { "rtc.store_base": "chain" } },
    ])
    expect(named("rtc.store_time_rejected").map((point) => [point.type, point.value, point.attrs])).toEqual([
      ["count", 1, { "rtc.store_base": "chain" }],
    ])
  })

})

describe("the statement subscription the host ends, as telemetry (rank 7)", () => {
  const named = (name: string) => recorded.metrics.filter((point) => point.name === name)
  it("counts each end and each reopening", () => {
    trace.statementsInterrupted("completed")
    trace.statementsResubscribed(1)
    expect(named("rtc.store_interrupted").map((point) => [point.type, point.value, point.attrs])).toEqual([
      ["count", 1, { "rtc.store_reason": "completed" }],
    ])
    expect(named("rtc.store_resubscribe").map((point) => [point.type, point.value, point.attrs])).toEqual([
      ["count", 1, { "rtc.store_attempt": "1" }],
    ])
  })

})

describe("stalls as telemetry steps (#262)", () => {
  const stalls = (journey: "join" | "game") => journeysNamed(journey)[0].steps.filter((step) => step.name === "rtc.stall")

  it("spans a stall in the join too, which only the game did before", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
    trace.stallChanged({ kind: "connection_stalled", layer: "store-write", detail: { reason: "submits failing", lastError: "noAllowance" } })
    expect(stalls("join")).toHaveLength(1)
    expect(stalls("join")[0].attrs).toMatchObject({ "rtc.layer": "store-write", round: "1", "rtc.stall_reason": "submits failing", "rtc.last_error": "noAllowance" })
  })

  it("ends the span with how it recovered and sends the stall's length as a metric", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
    trace.stallChanged({ kind: "connection_stalled", layer: "store-write" })
    trace.stallChanged({ kind: "connection_recovered", layer: "store-write", detail: { stallMs: 14_000, recoveredVia: "self-heal" } })
    expect(stalls("join")[0]).toMatchObject({ ended: true, endAttrs: { "rtc.recovered_via": "self-heal" } })
    expect(recorded.metrics.filter((point) => point.name === "rtc.stall_ms")).toEqual([
      { type: "distribution", name: "rtc.stall_ms", value: 14_000, unit: "millisecond", attrs: { "rtc.layer": "store-write", "rtc.recovered_via": "self-heal", round: "1" } },
    ])
  })

  it("cleans the stall's reason and last error for the org's masking, and caps them", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("zed", 0)
    trace.stallChanged({ kind: "connection_stalled", layer: "store-write", detail: { reason: "no credentials", lastError: "x".repeat(500) } })
    const [step] = stalls("join")
    expect(step.attrs["rtc.stall_reason"]).toBe("no cr*dentials")
    expect(step.attrs["rtc.last_error"]).toHaveLength(120)
  })

  it("sends no stall metric for a stall that is still going", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("zed", 0)
    trace.stallChanged({ kind: "connection_stalled", layer: "ice" })
    expect(recorded.metrics.filter((point) => point.name === "rtc.stall_ms")).toEqual([])
  })
})

describe("network changes during the game (#264)", () => {
  type Listener = () => void
  let win: Map<string, Set<Listener>>
  let conn: Map<string, Set<Listener>> & { type?: string }
  let connection: { type: string; effectiveType: string; addEventListener: (n: string, f: Listener) => void; removeEventListener: (n: string, f: Listener) => void }
  const add = (map: Map<string, Set<Listener>>) => (name: string, fn: Listener) => void (map.get(name) ?? map.set(name, new Set()).get(name)!).add(fn)
  const remove = (map: Map<string, Set<Listener>>) => (name: string, fn: Listener) => void map.get(name)?.delete(fn)
  const fire = (map: Map<string, Set<Listener>>, name: string) => map.get(name)?.forEach((fn) => fn())
  // the pagehide listener is the trace's own, not the watcher's
  const listening = () => [...[...win].filter(([name]) => name !== "pagehide"), ...conn].reduce((n, [, set]) => n + set.size, 0)
  const netSteps = () => (journeysNamed("game")[0] ?? journeysNamed("join")[0]).steps.filter((step) => step.name === "net.change")

  beforeEach(() => {
    trace.resetGameTraceForTests()
    win = new Map()
    conn = new Map()
    connection = { type: "wifi", effectiveType: "4g", addEventListener: add(conn), removeEventListener: remove(conn) }
    vi.stubGlobal("window", { addEventListener: add(win), removeEventListener: remove(win) })
    vi.stubGlobal("navigator", { onLine: true, connection })
    logs.lines.length = 0
  })
  afterEach(() => vi.unstubAllGlobals())

  const startGame = () => {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    onTimeRound()
  }

  it("puts a network change on the game journey and in the game log, with the connection it moved to", () => {
    startGame()
    connection.type = "cellular"
    fire(conn, "change")
    const [step] = netSteps()
    expect(step.attrs).toMatchObject({ "net.event": "change", "net.type": "cellular", "net.from_type": "wifi" })
    expect(logs.lines).toContain("[jollity-net] change wifi 4g -> cellular 4g")
    expect(recorded.metrics.filter((point) => point.name === "net.changes")).toMatchObject([{ type: "count", value: 1, attrs: { "net.event": "change", "net.type": "cellular" } }])
  })

  it("records offline and online as steps of the join before the game starts", () => {
    trace.beginJoin({ cameraWarm: true })
    fire(win, "offline")
    fire(win, "online")
    expect(journeysNamed("join")[0].steps.filter((step) => step.name === "net.change").map((step) => step.attrs["net.event"])).toEqual(["offline", "online"])
  })

  it("stops listening when the game ends, and when the join is left", async () => {
    startGame()
    expect(listening()).toBe(3)
    trace.roundChanged(null)
    trace.leftGame()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(listening()).toBe(0)
    const before = netSteps().length
    fire(win, "offline")
    expect(netSteps().length).toBe(before)
  })

  it("does not stack listeners over two games", () => {
    startGame()
    trace.resetGameTraceForTests()
    startGame()
    expect(listening()).toBe(3)
  })

  it("says unsupported on a browser without the connection API", () => {
    vi.stubGlobal("navigator", { onLine: true })
    startGame()
    fire(win, "offline")
    expect(netSteps()[0].attrs).toMatchObject({ "net.event": "offline", "net.type": "unsupported", "net.connection": "unsupported" })
  })
})

describe("decoder changes through the game (#556)", () => {
  const read = (decoder: string, codec: string, link = 1): RtcSample => ({
    link,
    localType: "host",
    remoteType: "host",
    inbound: { id: "iv", decoderImplementation: decoder, codec },
  })
  const report = (quality: RtcSample) => trace.observeRtcReport([{ id: "amy", conn: "connected", pair: "host/host", quality }])
  const changes = () => journeysNamed("game")[0].steps.filter((step) => step.name === "rtc.decoder_change")

  function start() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
    trace.roundChanged(0)
  }

  it("records a step when the decoder falls back mid-round, not on the first reading or while it holds", () => {
    start()
    report(read("ExternalDecoder (MediaCodecVideoDecoder)", "H264"))
    report(read("ExternalDecoder (MediaCodecVideoDecoder)", "H264"))
    expect(changes()).toHaveLength(0)
    report(read("FFmpeg (fallback from: ExternalDecoder (MediaCodecVideoDecoder))", "H264"))
    expect(changes()).toHaveLength(1)
    expect(changes()[0]).toMatchObject({
      ended: true,
      attrs: {
        "rtc.peer": "0",
        "rtc.decoder_from": "ExternalDecoder (MediaCodecVideoDecoder)",
        "rtc.decoder": "FFmpeg (fallback from: ExternalDecoder (MediaCodecVideoDecoder))",
        "rtc.codec_from": "H264",
        "rtc.codec": "H264",
      },
    })
  })

  it("records a codec switch, and ignores a rebuilt connection", () => {
    start()
    report(read("libvpx", "VP8"))
    report(read("libvpx", "H264"))
    expect(changes()).toHaveLength(1)
    report(read("OpenH264", "VP8", 2))
    expect(changes()).toHaveLength(1)
  })
})

describe("the codec map: the link row and implementation changes", () => {
  function play() {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.meshOpened("zed", 0)
  }
  const reading = (n: number, over: Partial<NonNullable<RtcSample["inbound"]>> = {}, out: Partial<NonNullable<RtcSample["outbound"]>> = {}): RtcSample => ({
    link: 1,
    at: n * 3000,
    rttMs: 100,
    inbound: { id: "IV", framesDecoded: n * 60, packetsReceived: n * 300, codec: "H264", decoderImplementation: "ExternalDecoder", ...over },
    outbound: { id: "OV", framesEncoded: n * 60, codec: "H264", encoderImplementation: "MediaCodec", ...out },
  })
  const metric = (name: string) => recorded.metrics.filter((point) => point.name === name)

  it("files the funnel stamps, the role, the SDP flags and seen under the round, and sends one rtc.link row", () => {
    play()
    trace.recordMeshEvent("amy", { kind: "stage", stage: "offer", ms: 400 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "first_frame", ms: 2400 })
    observe({ amy: "connected" }, ["amy"], { amy: "host/host" })
    trace.roundChanged(0)
    const sdp = { rtx: true, red: false, ulpfec: false, flexfec: false }
    for (let n = 1; n <= 3; n++) trace.observeRtcReport([{ id: "amy", conn: "connected", pair: "host/host", quality: reading(n), sdp }])
    trace.peerSeen("amy")
    trace.confirmOpened()
    const [row] = metric("rtc.link")
    expect(row.attrs).toMatchObject({
      "rtc.outcome": "video",
      "rtc.last_stage": "first_frame",
      "rtc.role": "answerer",
      "rtc.seen": "true",
      "rtc.rtx": "true",
      "rtc.pair": "g5:r1:6fc008fbdd24",
      "rtc.codec_in": "H264",
      "rtc.decoder_kind": "hardware",
    })
    expect(metric("rtc.link.ttff_ms")[0].value).toBe(2000)
  })

  it("counts an implementation change in either direction as rtc.impl_change, and puts an encoder change on the game", () => {
    play()
    trace.roundChanged(0)
    trace.observeRtcReport([{ id: "amy", conn: "connected", quality: reading(1) }])
    trace.observeRtcReport([{ id: "amy", conn: "connected", quality: reading(2, { decoderImplementation: "FFmpeg (fallback from: ExternalDecoder)" }, { encoderImplementation: "OpenH264" }) }])
    const changes = metric("rtc.impl_change")
    expect(changes.map((point) => [point.attrs["rtc.direction"], point.attrs["rtc.impl_from"], point.attrs["rtc.impl"], point.attrs["rtc.impl_kind"]])).toEqual([
      ["in", "ExternalDecoder", "FFmpeg", "software"],
      ["out", "MediaCodec", "OpenH264", "software"],
    ])
    expect(changes[0].attrs).toMatchObject({ "rtc.pair": "g5:r1:6fc008fbdd24", round: "1" })
    const steps = journeysNamed("game")[0].steps.map((step) => step.name)
    expect(steps).toContain("rtc.encoder_change")
    expect(steps).toContain("rtc.decoder_change")
  })

})

describe("invariants (lib/invariants.ts)", () => {
  // The log-stops-before-payoff check compares the newest log line's time with
  // the payoff's start, both Date.now(). On the real clock a millisecond can
  // tick between the two and fire it for a log that did keep writing, so every
  // test here runs on a frozen Date: lines and the payoff share one instant.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1_800_000_000_000)
  })

  it("reports a payoff for a game this session did not play", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.noteGame(5, 0)
    trace.reportLanded(4) // the payoff names another game
    expect(invariants.hits).toEqual([
      expect.objectContaining({
        kind: "payoff-without-join",
        detail: expect.objectContaining({ "game.index": 4, "invariant.played_game": 5, "invariant.asked_by": "payoff.start" }),
      }),
    ])
  })

  it("stays quiet when the payoff is the game just played", () => {
    landed()
    trace.payoffHandedOff()
    expect(invariants.hits).toEqual([])
  })

  it("says nothing about a draw screen asking for another game: a chat link into game 4's draw after playing 5 is a normal way in", () => {
    landed()
    trace.drawShown({ kind: "none" }, null, 4)
    expect(invariants.hits).toEqual([])
  })

  it("reports a log whose newest line predates the payoff", () => {
    const at = Date.now()
    landed() // the payoff starts here
    // nothing was logged while it ran: the ring's newest line is five seconds old
    logs.entries.length = 0
    logs.entries.push({ time: at - 5_000, tag: "rtc", message: "last line before the payoff" })
    trace.payoffHandedOff()
    expect(invariants.hits).toEqual([
      expect.objectContaining({ kind: "log-stops-before-payoff", valueMs: 5_000, detail: { "invariant.newest_line": "rtc", "game.index": 5 } }),
    ])
  })

  it("does not report a log that kept writing through the payoff", () => {
    const at = Date.now()
    landed()
    logs.entries.push({ time: at + 1_000, tag: "chest", message: "the chest opened" })
    trace.payoffHandedOff()
    expect(invariants.hits).toEqual([])
  })

  it("reports a connection stamped before the offer that caused it", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    trace.recordMeshEvent("amy", { kind: "stage", stage: "offer", ms: 2_400 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "connected", ms: 120 })
    expect(invariants.hits).toEqual([
      expect.objectContaining({
        kind: "funnel-out-of-order",
        valueMs: 2_280,
        detail: expect.objectContaining({ stage: "connected", "invariant.cause_stage": "offer" }),
      }),
    ])
  })

  it("does not report the answerer's real order: offer, ice_checking, answer, connected", () => {
    // The mesh stamps `ice_checking` from oniceconnectionstatechange while
    // the answer is still gathering (the remote candidates came in the
    // offer), and stamps `answer` after setLocalDescription + waitIceGathering
    // + signal. Nearly every session answers someone, so this order must be
    // quiet — the funnel's array order is not causal.
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    trace.recordMeshEvent("amy", { kind: "stage", stage: "offer", ms: 120 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "ice_checking", ms: 340 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "answer", ms: 900 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "connected", ms: 1_400 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "first_frame", ms: 2_600 })
    expect(invariants.hits).toEqual([])
  })

  it("keeps the FIRST stamp of each stage, so a later re-stamp cannot invent a breach", () => {
    trace.beginJoin({ cameraWarm: true })
    trace.meshOpened("me", 0)
    trace.recordMeshEvent("amy", { kind: "stage", stage: "offer", ms: 100 })
    trace.recordMeshEvent("amy", { kind: "stage", stage: "connected", ms: 900 })
    // a later duplicate offer (a re-offer) must not move offer's time past
    // connected's and make the pair look broken
    trace.recordMeshEvent("amy", { kind: "stage", stage: "offer", ms: 2_000 })
    expect(invariants.hits).toEqual([])
  })

})
