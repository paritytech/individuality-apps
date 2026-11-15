// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

import { recoverInterruptedJourneys, startJourney } from "./index"
import { openJourneyRecoveryRecords, resetJourneysForTests } from "./journeys"
import { resetChainClockForTests, setChainBlock, setChainOffset } from "../chain-clock"
import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { recordingTransport, testConfig } from "./test-transport"

let sink: ReturnType<typeof recordingTransport>
beforeEach(async () => {
  resetChainClockForTests()
  await resetTelemetryForTests()
  sink = recordingTransport()
  startTelemetryWith(testConfig({ makeTransport: sink.factory }))
})

const transactions = () => sink.items("transaction").map((item) => item.payload)

describe("a journey", () => {
  it("is a root span with journey.sad and journey.expected present from the start", async () => {
    startJourney("join", { "clock.offset": "-7200" }).end("full")
    await Sentry.flush(1000)
    const [tx] = transactions()
    expect(tx.transaction).toBe("journey.join")
    expect(tx.contexts.trace.op).toBe("journey.join")
    expect(tx.contexts.trace.parent_span_id).toBeUndefined()
    expect(tx.contexts.trace.data).toMatchObject({
      "journey.sad": "false",
      "journey.expected": "false",
      "journey.outcome": "full",
      "clock.offset": "-7200",
    })
  })

  it("flips journey.sad and keeps the last reason", async () => {
    const journey = startJourney("game")
    journey.markSad("peer-reconnect")
    journey.markSad("report-retry")
    journey.end("completed")
    await Sentry.flush(1000)
    expect(transactions()[0].contexts.trace.data).toMatchObject({
      "journey.sad": "true",
      "journey.sad_reason": "report-retry",
    })
  })

  it("puts each step under the journey, op <journey>.<step>, with its attributes", async () => {
    const journey = startJourney("join")
    journey.step("camera.acquire", { "camera.warm": "true" }).end({ "camera.state": "ready" })
    journey.end("full")
    await Sentry.flush(1000)
    const [tx] = transactions()
    expect(tx.spans).toHaveLength(1)
    expect(tx.spans[0]).toMatchObject({
      op: "join.camera.acquire",
      description: "camera.acquire",
      parent_span_id: tx.contexts.trace.span_id,
      data: expect.objectContaining({ "camera.warm": "true", "camera.state": "ready" }),
    })
  })

  it("cuts the steps still open when it ends", async () => {
    const journey = startJourney("game")
    journey.step("rtc.stall")
    journey.end("abandoned")
    await Sentry.flush(1000)
    expect(transactions()[0].spans[0].data).toMatchObject({ "step.outcome": "cut" })
  })

  it("takes wall-clock start and end times", async () => {
    const journey = startJourney("person", {}, { startedAt: 1_700_000_000_000 })
    journey.step("key.find", {}, { startedAt: 1_700_000_000_000 }).end({}, { endedAt: 1_700_000_001_500 })
    journey.end("bound", {}, { endedAt: 1_700_000_004_000 })
    await Sentry.flush(1000)
    const [tx] = transactions()
    expect(tx.start_timestamp).toBe(1_700_000_000)
    expect(tx.timestamp).toBe(1_700_000_004)
    expect(tx.spans[0].timestamp).toBe(1_700_000_001.5)
  })

  it("does nothing after it ended, and ends once", async () => {
    const journey = startJourney("payoff")
    journey.end("shown")
    journey.set({ late: "true" })
    journey.markSad("late")
    journey.step("chest.show").end()
    journey.end("stalled")
    expect(journey.ended).toBe(true)
    await Sentry.flush(1000)
    expect(transactions()).toHaveLength(1)
    expect(transactions()[0].contexts.trace.data["journey.outcome"]).toBe("shown")
    expect(transactions()[0].spans).toHaveLength(0)
  })

  it("shares a trace with the journey it follows", async () => {
    const join = startJourney("join")
    join.end("full")
    const game = startJourney("game", {}, { sameTraceAs: join })
    game.end("completed")
    const lone = startJourney("app-open")
    lone.end("ready")
    await Sentry.flush(1000)
    const [a, b, c] = transactions()
    expect(b.contexts.trace.trace_id).toBe(a.contexts.trace.trace_id)
    expect(b.contexts.trace.parent_span_id).toBe(a.contexts.trace.span_id)
    expect(c.contexts.trace.trace_id).not.toBe(a.contexts.trace.trace_id)
    expect(join.trace).toEqual({ traceId: a.contexts.trace.trace_id, spanId: a.contexts.trace.span_id })
  })

})

describe("journey recovery after an OS-killed page (#279)", () => {
  it("keeps the live root and every reached step in the durable recovery record", () => {
    const join = startJourney("join", {}, { ownsLifecycle: true, startedAt: 1_799_999_990_000 })
    join.set({ "game.index": "17" })
    join.step("camera.acquire", {}, { startedAt: 1_799_999_995_000 }).end({}, { endedAt: 1_799_999_996_000 })
    join.step("camera.acquire", {}, { startedAt: 1_799_999_996_500 }).end({}, { endedAt: 1_799_999_996_800 })
    join.step("mesh.open", {}, { startedAt: 1_799_999_997_000 })
    join.step("rtc.signal", {}, { startedAt: 1_799_999_997_100 }).end({}, { endedAt: 1_799_999_997_200 })
    join.step("net.change", {}, { startedAt: 1_799_999_997_300 }).end({}, { endedAt: 1_799_999_997_400 })
    join.markSad("app-hidden")

    expect(openJourneyRecoveryRecords()).toEqual([
      expect.objectContaining({
        name: "join",
        gameIndex: "17",
        startedAt: 1_799_999_990_000,
        traceHeader: expect.stringMatching(/^[0-9a-f]{32}-[0-9a-f]{16}-[01]$/),
        lastStep: "mesh.open",
        sadReason: "app-hidden",
        steps: [
          { name: "camera.acquire", startedAt: 1_799_999_995_000, endedAt: 1_799_999_996_800 },
          { name: "mesh.open", startedAt: 1_799_999_997_000 },
          { name: "rtc.signal", startedAt: 1_799_999_997_100, endedAt: 1_799_999_997_200 },
          { name: "net.change", startedAt: 1_799_999_997_300, endedAt: 1_799_999_997_400 },
        ],
      }),
    ])

    join.end("partial")
    expect(openJourneyRecoveryRecords()).toEqual([])
  })

  it("keeps a repeated step open until every instance of that name ends", () => {
    const join = startJourney("join", {}, { ownsLifecycle: true, startedAt: 1_800_000_000_000 })
    const first = join.step("rtc.peer", {}, { startedAt: 1_800_000_001_000 })
    const second = join.step("rtc.peer", {}, { startedAt: 1_800_000_002_000 })
    first.end({}, { endedAt: 1_800_000_003_000 })
    expect(openJourneyRecoveryRecords()[0].steps).toEqual([{ name: "rtc.peer", startedAt: 1_800_000_001_000 }])
    second.end({}, { endedAt: 1_800_000_004_000 })
    expect(openJourneyRecoveryRecords()[0].steps).toEqual([
      { name: "rtc.peer", startedAt: 1_800_000_001_000, endedAt: 1_800_000_004_000 },
    ])
  })

  it("reconstructs a top-level root in place and links a same-game join as its continuation", async () => {
    const startedAt = 1_800_000_000_000
    const endedAt = startedAt + 20_000
    setChainOffset(30_000)
    setChainBlock(777)
    expect(
      recoverInterruptedJourneys(
        [
          {
            name: "join",
            startedAt,
            traceHeader: `${"a".repeat(32)}-${"b".repeat(16)}-1`,
            gameIndex: "17",
            lastStep: "mesh.open",
            steps: [
              { name: "camera.acquire", startedAt: startedAt + 1_000, endedAt: startedAt + 2_000 },
              { name: "mesh.open", startedAt: startedAt + 3_000 },
            ],
          },
        ],
        "old-session",
        endedAt,
      ),
    ).toBe(1)
    const resumed = startJourney("join")
    resumed.set({ "game.index": "17" })
    resumed.end("full")
    await Sentry.flush(1000)

    const [interrupted, continuation] = transactions()
    expect(interrupted.transaction).toBe("journey.join")
    expect(interrupted.contexts.trace.trace_id).toBe("a".repeat(32))
    expect(interrupted.contexts.trace.parent_span_id).toBeUndefined()
    expect(interrupted.contexts.trace.data).toMatchObject({
      "journey.outcome": "interrupted",
      "journey.interrupted_by": "unclean-exit",
      "journey.interrupted_step": "mesh.open",
      "journey.interrupted_after_ms": "20000",
      "journey.recovered": "true",
      "journey.previous_session_id": "old-session",
      "game.index": "17",
      "wall.time.start": String(startedAt),
      "wall.time.end": String(endedAt),
    })
    expect(interrupted.contexts.trace.data["chain.block.start"]).toBeUndefined()
    expect(interrupted.contexts.trace.data["chain.time.start"]).toBeUndefined()
    expect(interrupted.contexts.trace.data["clock.span_drift_ms.end"]).toBeUndefined()
    expect(interrupted.spans.map((span: { description: string }) => span.description)).toEqual(["camera.acquire", "mesh.open"])
    expect(interrupted.spans[1].data).toMatchObject({ "journey.recovered": "true", "step.outcome": "cut" })
    expect(continuation.contexts.trace.trace_id).not.toBe(interrupted.contexts.trace.trace_id)
    expect(continuation.contexts.trace.links).toEqual([
      expect.objectContaining({
        trace_id: interrupted.contexts.trace.trace_id,
        span_id: interrupted.contexts.trace.span_id,
        attributes: { "sentry.link.type": "previous_trace" },
      }),
    ])
    expect(continuation.contexts.trace.data).toMatchObject({
      "journey.resumed": "true",
      "journey.resumed_from_session": "old-session",
      "journey.outcome": "full",
    })
  })

  it("puts a recovered child root back under its original sent parent, not the lost root", async () => {
    const join = startJourney("join", { "game.index": "17" }, { startedAt: 1_800_000_000_000 })
    const game = startJourney("game", { "game.index": "17" }, { sameTraceAs: join, ownsLifecycle: true, startedAt: 1_800_000_005_000 })
    game.step("round.1", {}, { startedAt: 1_800_000_006_000 })
    const [record] = openJourneyRecoveryRecords().filter((candidate) => candidate.name === "game")
    expect(record.parentTraceHeader).toBe(`${join.trace?.traceId}-${join.trace?.spanId}-1`)
    const lostSpanId = game.trace?.spanId
    join.end("full", {}, { endedAt: 1_800_000_004_000 })
    resetJourneysForTests()

    recoverInterruptedJourneys([record], "old-session", 1_800_000_010_000)
    await Sentry.flush(1000)

    const [sentJoin, recoveredGame] = transactions()
    expect(recoveredGame.contexts.trace.trace_id).toBe(sentJoin.contexts.trace.trace_id)
    expect(recoveredGame.contexts.trace.parent_span_id).toBe(sentJoin.contexts.trace.span_id)
    expect(recoveredGame.contexts.trace.parent_span_id).not.toBe(lostSpanId)
  })

  it("does not resume a recovered journey when the next join is a different game", async () => {
    recoverInterruptedJourneys(
      [
        {
          name: "join",
          startedAt: 1_800_000_000_000,
          traceHeader: `${"a".repeat(32)}-${"b".repeat(16)}-1`,
          gameIndex: "17",
          lastStep: "mesh.open",
          steps: [],
        },
      ],
      "old-session",
      1_800_000_010_000,
    )
    const nextGame = startJourney("join")
    nextGame.set({ "game.index": "18" })
    nextGame.end("full")
    await Sentry.flush(1000)

    const continuation = transactions()[1]
    expect(continuation.contexts.trace.links).toBeUndefined()
    expect(continuation.contexts.trace.data["journey.resumed"]).toBeUndefined()
  })

  it("links the next same-game join to recovered game and payoff roots", async () => {
    recoverInterruptedJourneys(
      [
        {
          name: "game",
          startedAt: 1_800_000_000_000,
          traceHeader: `${"a".repeat(32)}-${"b".repeat(16)}-1`,
          gameIndex: "17",
          lastStep: "round.1",
          steps: [],
        },
        {
          name: "payoff",
          startedAt: 1_800_000_005_000,
          traceHeader: `${"c".repeat(32)}-${"d".repeat(16)}-1`,
          gameIndex: "17",
          lastStep: "draw.show",
          steps: [],
        },
      ],
      "old-session",
      1_800_000_010_000,
    )
    const resumed = startJourney("join")
    resumed.set({ "game.index": "17" })
    resumed.end("full")
    await Sentry.flush(1000)

    const [recoveredGame, recoveredPayoff, continuation] = transactions()
    expect(continuation.contexts.trace.links).toEqual([
      expect.objectContaining({ trace_id: recoveredGame.contexts.trace.trace_id, span_id: recoveredGame.contexts.trace.span_id }),
      expect.objectContaining({ trace_id: recoveredPayoff.contexts.trace.trace_id, span_id: recoveredPayoff.contexts.trace.span_id }),
    ])
    expect(continuation.contexts.trace.data).toMatchObject({
      "journey.resumed": "true",
      "journey.resumed_from_session": "old-session",
    })
  })

  it("links recovery that finishes after the current join already learned its game", async () => {
    const resumed = startJourney("join")
    resumed.set({ "game.index": "17" })
    recoverInterruptedJourneys(
      [
        {
          name: "game",
          startedAt: 1_800_000_000_000,
          traceHeader: `${"a".repeat(32)}-${"b".repeat(16)}-1`,
          gameIndex: "17",
          lastStep: "round.1",
          steps: [],
        },
      ],
      "old-session",
      1_800_000_010_000,
    )
    resumed.end("full")
    await Sentry.flush(1000)

    const [recoveredGame, continuation] = transactions()
    expect(continuation.contexts.trace.links).toEqual([
      expect.objectContaining({ trace_id: recoveredGame.contexts.trace.trace_id, span_id: recoveredGame.contexts.trace.span_id }),
    ])
    expect(continuation.contexts.trace.data["journey.resumed"]).toBe("true")
  })
})

describe("typed step names", () => {
  it("rejects a step the journey does not declare, and takes any round", () => {
    const journey = startJourney("game")
    // @ts-expect-error a typo is a compile error
    journey.step("camera.aquire").end()
    journey.step("round.7").end()
    journey.step("report.submit").end()
    journey.end("completed")
  })
})

describe("a journey's place in time", () => {
  const data = async () => {
    await Sentry.flush(1000)
    return transactions()[0].contexts.trace.data
  }
  const driftLogs = () => sink.items("log")
    .flatMap((item) => item.payload.items)
    .filter((item) => item.attributes?.["failure.kind"]?.value === "clock-drift")
  const driftMetrics = () => sink.items("trace_metric")
    .flatMap((item) => item.payload.items)
    .filter((item) => item.name === "failure" && item.attributes?.["failure.kind"]?.value === "clock-drift")
  const frozenClock = () => {
    const real = performance.now.bind(performance)
    return vi.spyOn(performance, "now").mockImplementation(() => real() - 600_000)
  }

  it("stamps the journey and its steps from the wall clock when the span clock has fallen behind", async () => {
    const spy = frozenClock()
    try {
      const before = Date.now()
      const journey = startJourney("join")
      journey.step("camera.acquire").end()
      journey.end("full")
      const after = Date.now()
      await Sentry.flush(1000)
      const [tx] = transactions()
      expect(tx.start_timestamp * 1000).toBeGreaterThanOrEqual(before - 5)
      expect(tx.start_timestamp * 1000).toBeLessThanOrEqual(after + 5)
      expect(tx.spans[0].start_timestamp * 1000).toBeGreaterThanOrEqual(before - 5)
      expect(tx.spans[0].start_timestamp * 1000).toBeLessThanOrEqual(after + 5)
      expect(tx.timestamp * 1000).toBeGreaterThanOrEqual(before - 5)
    } finally {
      spy.mockRestore()
    }
  })

  it("records the span clock's drift at the start, and reports a 10 minute drift once per session", async () => {
    const spy = frozenClock()
    try {
      startJourney("join").end("full")
      startJourney("game").end("completed")
      const attrs = await data()
      expect(Math.abs(Number(attrs["clock.span_drift_ms"]) + 600_000)).toBeLessThan(100)
      const logs = driftLogs()
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatchObject({
        body: "clock-drift: span-clock",
        level: "warn",
        attributes: {
          "failure.kind": { type: "string", value: "clock-drift" },
          "failure.reason": { type: "string", value: "span-clock" },
          "journey.expected": { type: "string", value: "false" },
          journey: { type: "string", value: "join" },
        },
      })
      expect(driftMetrics()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("sends no drift failure when the clocks agree", async () => {
    startJourney("join").end("full")
    await data()
    expect(driftLogs()).toHaveLength(0)
    expect(driftMetrics()).toHaveLength(0)
  })

  it("leaves chain.time off without a clock snapshot", async () => {
    startJourney("join").end("full")
    const attrs = await data()
    expect(attrs["chain.time.start"]).toBeUndefined()
  })

  it("records the chain time from the clock snapshot at the start", async () => {
    setChainOffset(1000)
    startJourney("join").end("full")
    const attrs = await data()
    const now = Math.floor(Date.now() / 1000) + 1000
    expect(Math.abs(Number(attrs["chain.time.start"]) - now)).toBeLessThanOrEqual(2)
  })

  it("records the block, the chain time and the wall time at the start and again at the end", async () => {
    setChainOffset(1000)
    setChainBlock(777)
    const journey = startJourney("join")
    setChainBlock(790)
    journey.end("full")
    const attrs = await data()
    const now = Math.floor(Date.now() / 1000)
    expect(attrs["chain.block.start"]).toBe("777")
    expect(attrs["chain.block.end"]).toBe("790")
    for (const phase of ["start", "end"]) {
      expect(Math.abs(Number(attrs[`chain.time.${phase}`]) - (now + 1000))).toBeLessThanOrEqual(2)
      expect(Math.abs(Number(attrs[`wall.time.${phase}`]) - Date.now())).toBeLessThan(5_000)
      expect(typeof attrs[`wall.time.${phase}`]).toBe("string")
    }
    expect(attrs["clock.span_drift_ms.end"]).toBeDefined()
  })

  it("leaves the block off while the source has seen none, and keeps the wall time", async () => {
    setChainOffset(5)
    startJourney("join").end("full")
    const attrs = await data()
    expect(attrs["chain.block.start"]).toBeUndefined()
    expect(attrs["chain.block.end"]).toBeUndefined()
    expect(attrs["wall.time.start"]).toBeDefined()
  })

  it("measures drift at the end too, and reports it when only the end is drifted", async () => {
    const journey = startJourney("join")
    const spy = frozenClock()
    try {
      journey.end("full")
      const attrs = await data()
      expect(Math.abs(Number(attrs["clock.span_drift_ms.end"]) + 600_000)).toBeLessThan(100)
      expect(driftLogs()).toHaveLength(1)
      expect(driftMetrics()).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("stamps wall.time from a back-dated start and end, not from the call", async () => {
    const at = Date.now() - 60_000
    startJourney("join", {}, { startedAt: at - 5_000 }).end("full", undefined, { endedAt: at })
    const attrs = await data()
    expect(attrs["wall.time.start"]).toBe(String(at - 5_000))
    expect(attrs["wall.time.end"]).toBe(String(at))
  })
})
