// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The submit-health hook (`onSubmit`): a submit that backs off, waits for a
 * slot, or fails for good is told to the host app, which files it per pair.
 * The frame's contents never go in an event.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { statementTransport, type SubmitEvent } from "./statementTransport"
import type { StatementStoreLike, WireStatement } from "./store"
import type { SignalHandlers, SignalTransport } from "./transport"

function fakeStore(opts: { submitError?: string; hangSigns?: boolean } = {}) {
  let subscribed = false
  let signs = 0
  const submitted: WireStatement[] = []
  const store: StatementStoreLike = {
    createProofAuthorized: () => {
      signs++
      return opts.hangSigns ? new Promise<unknown>(() => {}) : Promise.resolve("fake-proof")
    },
    submit: async (wire) => {
      if (opts.submitError) throw new Error(opts.submitError)
      submitted.push(wire)
    },
    subscribe: () => {
      subscribed = true
      return { unsubscribe: () => {} }
    },
  }
  return { store, submitted, subscribed: () => subscribed, signs: () => signs }
}

const tick = () => new Promise<void>((r) => setImmediate(r))
const until = async (cond: () => boolean, what: string, maxMs = 15_000) => {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > maxMs) throw new Error(`timed out waiting for ${what}`)
    await tick()
  }
}

async function open(fake: ReturnType<typeof fakeStore>, onSubmit: (event: SubmitEvent) => void) {
  const handlers: SignalHandlers = { onPeerJoined: vi.fn(), onPeerLeft: vi.fn(), onSignal: vi.fn() }
  const transport: SignalTransport = statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {}, onSubmit })({
    base: "",
    room: "room1",
    id: "me",
    name: "me",
    handlers,
  })
  await until(fake.subscribed, "the transport to subscribe")
  return transport
}

let epoch = Date.now() + 10 * 3_600_000
function fakeTimers() {
  epoch += 3_600_000
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: epoch })
}
afterEach(() => vi.useRealTimers())

const desc = (sdp = "o") => ({ rtc: { desc: { type: "offer" as const, sdp } } })

describe("statementTransport onSubmit", () => {
  it("tells each retry's back-off and then the failure, naming the frame and the peer", async () => {
    fakeTimers()
    const events: SubmitEvent[] = []
    const transport = await open(fakeStore({ submitError: "rejected: no allowance" }), (event) => events.push(event))
    const told = (kind: SubmitEvent["kind"]) => events.filter((event) => event.frame === "desc" && event.kind === kind).length
    transport.send("p1", desc())
    // Each back-off timer is armed right after its retry is told, so wait for
    // the event, then advance exactly that delay; never a fixed settle().
    await until(() => told("retry") === 1, "the first retry")
    await vi.advanceTimersByTimeAsync(400)
    await until(() => told("retry") === 2, "the second retry")
    await vi.advanceTimersByTimeAsync(800)
    await until(() => told("failed") === 1, "the failure")
    const mine = events.filter((event) => event.frame === "desc")
    expect(mine).toEqual([
      { kind: "retry", frame: "desc", to: "p1", attempt: 1, delayMs: 400, reason: "rejected: no allowance" },
      { kind: "retry", frame: "desc", to: "p1", attempt: 2, delayMs: 800, reason: "rejected: no allowance" },
      { kind: "failed", frame: "desc", to: "p1", attempts: 3, reason: "rejected: no allowance", timedOut: false },
    ])
    transport.close()
  })

  it("names a presence frame with no peer", async () => {
    fakeTimers()
    const events: SubmitEvent[] = []
    const transport = await open(fakeStore({ submitError: "boom" }), (event) => events.push(event))
    await until(() => events.some((event) => event.frame === "presence"), "the presence frame's first retry")
    const presence = events.find((event) => event.frame === "presence")
    expect(presence).toBeDefined()
    expect(presence?.to).toBeUndefined()
    transport.close()
  })

  it("tells a frame that waited a second or more for a submit slot", async () => {
    fakeTimers()
    const events: SubmitEvent[] = []
    const fake = fakeStore({ hangSigns: true })
    const transport = await open(fake, (event) => events.push(event))
    transport.send("p1", desc("fill")) // with the hello, both slots
    transport.send("p2", desc("wait")) // queued behind both
    await until(() => fake.signs() >= 2, "both slots to hold a hung sign")
    await vi.advanceTimersByTimeAsync(20_000) // the hung signs time out and free the slots
    await until(() => events.some((event) => event.kind === "slot_wait" && event.to === "p2"), "p2's slot_wait")
    const waited = events.find((event) => event.kind === "slot_wait" && event.to === "p2")
    expect(waited).toMatchObject({ kind: "slot_wait", frame: "desc", to: "p2" })
    expect((waited as Extract<SubmitEvent, { kind: "slot_wait" }>).waitedMs).toBeGreaterThanOrEqual(1000)
    transport.close()
  })

  it("marks a submit that timed out, which is not retried", async () => {
    fakeTimers()
    const events: SubmitEvent[] = []
    const fake = fakeStore({ hangSigns: true })
    const transport = await open(fake, (event) => events.push(event))
    transport.send("p1", desc())
    await until(() => fake.signs() >= 2, "the hello's and p1's signs to hang")
    await vi.advanceTimersByTimeAsync(20_000)
    await until(() => events.some((event) => event.kind === "failed" && event.frame === "desc"), "p1's failure")
    expect(events.find((event) => event.kind === "failed" && event.frame === "desc")).toMatchObject({ kind: "failed", attempts: 1, timedOut: true })
    expect(events.some((event) => event.kind === "retry" && event.frame === "desc")).toBe(false)
    transport.close()
  })

  it("keeps signalling going when the hook throws", async () => {
    fakeTimers()
    const fake = fakeStore()
    const transport = await open(fake, () => {
      throw new Error("observer bug")
    })
    transport.send("p1", desc())
    await until(() => fake.submitted.length > 0 && transport.stats!().submitsOk > 0, "a submit to land")
    expect(fake.submitted.length).toBeGreaterThan(0)
    expect(transport.stats!().submitsOk).toBeGreaterThan(0)
    transport.close()
  })
})
