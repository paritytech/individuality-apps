// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Sentry from "@sentry/react"

import { startJourney } from "./index"
import { resetTelemetryForTests, startTelemetryWith } from "./init"
import { recordingTransport, testConfig } from "./test-transport"

let sink: ReturnType<typeof recordingTransport>
let page: EventTarget
let doc: EventTarget & { visibilityState: string }

beforeEach(async () => {
  await resetTelemetryForTests()
  page = new EventTarget()
  doc = Object.assign(new EventTarget(), { visibilityState: "visible" })
  vi.stubGlobal("window", page)
  vi.stubGlobal("document", doc)
  sink = recordingTransport()
  startTelemetryWith(testConfig({ makeTransport: sink.factory }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const roots = () => sink.items("transaction").map((item) => item.payload)
const pagehide = (persisted: boolean) => page.dispatchEvent(Object.assign(new Event("pagehide"), { persisted }))
const sent = async () => {
  await Sentry.flush(1000)
  return roots()
}

describe("journeys the page goes away on (#279)", () => {
  it("sends an open journey as interrupted on pagehide, with its step and age", async () => {
    const join = startJourney("permissions")
    join.step("camera").end()
    join.step("network")
    pagehide(false)
    const [tx] = await sent()
    expect(tx.transaction).toBe("journey.permissions")
    expect(tx.contexts.trace.data).toMatchObject({
      "journey.outcome": "interrupted",
      "journey.sad": "false",
      "journey.interrupted_by": "pagehide",
      "journey.interrupted_step": "network",
    })
    expect(typeof tx.contexts.trace.data["journey.interrupted_after_ms"]).toBe("string")
    expect(join.ended).toBe(true)
  })

  it("leaves a journey open on a pagehide the back-forward cache keeps", async () => {
    const join = startJourney("permissions")
    pagehide(true)
    expect(await sent()).toHaveLength(0)
    expect(join.ended).toBe(false)
    join.end("granted")
    expect(await sent()).toHaveLength(1)
  })

  it("does not send a journey that ended normally again", async () => {
    startJourney("permissions").end("granted")
    await sent()
    pagehide(false)
    const all = await sent()
    expect(all).toHaveLength(1)
    expect(all[0].contexts.trace.data["journey.outcome"]).toBe("granted")
  })

  it("sends a second pagehide's journeys once", async () => {
    startJourney("person")
    pagehide(false)
    pagehide(false)
    expect(await sent()).toHaveLength(1)
  })

  it("sends every open journey", async () => {
    startJourney("app-open")
    startJourney("permissions")
    startJourney("person")
    startJourney("game-signup").end("landed")
    pagehide(false)
    const names = (await sent()).map((tx) => tx.transaction).sort()
    expect(names).toEqual(["journey.app-open", "journey.game-signup", "journey.permissions", "journey.person"])
  })

  it("keeps an earlier sad reason", async () => {
    const signup = startJourney("game-signup")
    signup.markSad("turn-issue")
    pagehide(false)
    const [tx] = await sent()
    expect(tx.contexts.trace.data).toMatchObject({ "journey.sad": "true", "journey.sad_reason": "turn-issue", "journey.outcome": "interrupted" })
  })

  it("leaves a journey that owns its lifecycle to its owner", async () => {
    const join = startJourney("join", {}, { ownsLifecycle: true })
    startJourney("game-signup")
    pagehide(false)
    const all = await sent()
    expect(all.map((tx) => tx.transaction)).toEqual(["journey.game-signup"])
    expect(join.ended).toBe(false)
  })

  it("does not end anything on a page that merely goes hidden, however long", () => {
    vi.useFakeTimers()
    const signup = startJourney("game-signup")
    doc.visibilityState = "hidden"
    doc.dispatchEvent(new Event("visibilitychange"))
    vi.advanceTimersByTime(10 * 60_000)
    expect(signup.ended).toBe(false)
  })
})
