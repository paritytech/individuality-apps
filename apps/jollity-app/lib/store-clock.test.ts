// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import { resetChainClockForTests, setChainNow } from "./chain-clock"
import { resetDeviceClockForTests } from "./device-clock"
import {
  MIN_RETRY_MARGIN_MS,
  createStoreClock,
  nextSlotExpiry,
  resetSlotExpiryForTests,
  statementTransport,
  type StatementStoreLike,
  type StoreClockBase,
  type StoreClockEvent,
  type StoreStamp,
  type WireStatement,
} from "@jollity/statement-core"
import {
  createMessageExpiryClock,
  messageExpiryClockStep,
  resetStoreClockForTests,
  storeClock,
  storeClockBase,
} from "./store-clock"

const T = 1_800_000_000_000

/** sessionStorage as a host page has it: it outlives a reload */
let session: Map<string, string>

beforeEach(() => {
  session = new Map()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => void session.set(key, value),
    removeItem: (key: string) => void session.delete(key),
  })
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"], now: T })
  resetDeviceClockForTests()
  resetChainClockForTests()
  resetStoreClockForTests()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the page's store clock (Rule 2)", () => {
  it("stays differential with statement-core's transport clock over generated sequences", () => {
    const baseArbitrary = fc.record({
      ms: fc.integer({ min: T - 120_000, max: T + 900_000 }),
      kind: fc.constantFrom("chain", "device"),
    })
    const stampArbitrary = fc.record({
      base: fc.integer({ min: T - 120_000, max: T + 900_000 }),
      push: fc.integer({ min: 0, max: 600_000 }),
      kind: fc.constantFrom("chain", "device"),
      from: fc.integer({ min: 0, max: 600_000 }),
      retry: fc.boolean(),
      learn: fc.boolean(),
    }).map(({ base, push, ...stamp }): StoreStamp => ({ ...stamp, base, ms: base + push }))
    const operationArbitrary = fc.oneof(
      baseArbitrary.map((base) => ({ type: "stamp" as const, base })),
      fc.record({ base: baseArbitrary, first: stampArbitrary, ttlS: fc.integer({ min: 1, max: 120 }) })
        .map((value) => ({ type: "retry" as const, ...value })),
      stampArbitrary.map((stamp) => ({ type: "accepted" as const, stamp })),
      fc.record({ stamp: stampArbitrary, reason: fc.constantFrom("alreadyExpired", "channelPriorityTooLow") })
        .map((value) => ({ type: "rejected" as const, ...value })),
      baseArbitrary.map((base) => ({ type: "margin" as const, base })),
    )

    fc.assert(fc.property(
      fc.record({ chain: fc.integer({ min: 0, max: 900_000 }), device: fc.integer({ min: 0, max: 900_000 }) }),
      fc.array(operationArbitrary, { minLength: 0, maxLength: 80 }),
      (initial, operations) => {
        let base: StoreClockBase = { ms: T, kind: "chain" }
        const referenceEvents: StoreClockEvent[] = []
        const reference = createStoreClock({ base: () => base, initial, onEvent: (event) => referenceEvents.push(event) })
        let extracted = createMessageExpiryClock(initial)

        for (const operation of operations) {
          const eventCount = referenceEvents.length
          if (operation.type === "stamp") {
            base = operation.base
            const result = messageExpiryClockStep(extracted, { type: "stamp", base })
            extracted = result.state
            expect(result.commands).toEqual([{ type: "stamp", stamp: reference.stamp() }])
          } else if (operation.type === "retry") {
            base = operation.base
            const result = messageExpiryClockStep(extracted, operation)
            extracted = result.state
            expect(result.commands).toEqual([{ type: "stamp", stamp: reference.retryStamp(operation.first, operation.ttlS) }])
          } else if (operation.type === "accepted") {
            reference.accepted(operation.stamp)
            const result = messageExpiryClockStep(extracted, operation)
            extracted = result.state
            expect(result.commands).toEqual(referenceEvents.slice(eventCount).map((event) => ({ type: "event", event })))
          } else if (operation.type === "rejected") {
            reference.rejected(operation.stamp, operation.reason)
            const result = messageExpiryClockStep(extracted, operation)
            extracted = result.state
            expect(result.commands).toEqual(referenceEvents.slice(eventCount).map((event) => ({ type: "event", event })))
          } else {
            base = operation.base
            const result = messageExpiryClockStep(extracted, { type: "margin", base })
            extracted = result.state
            expect(result.commands).toEqual([{ type: "margin", marginMs: reference.marginMs() }])
          }
          expect(Object.fromEntries(Object.entries(extracted.kinds).map(([kind, value]) => [kind, value.marginMs])))
            .toEqual(reference.margins())
        }
      },
    ), { numRuns: 300 })
  })

  it("offers a pure message-expiry step without changing the caller's state", () => {
    const before = createMessageExpiryClock()
    const result = messageExpiryClockStep(before, { type: "stamp", base: { ms: T, kind: "chain" } })
    expect(before).toEqual(createMessageExpiryClock())
    expect(result.commands).toEqual([
      { type: "stamp", stamp: { ms: T, base: T, kind: "chain", from: 0, retry: false, learn: false } },
    ])
  })

  it("restores only finite non-negative margins and caps them at ten minutes", () => {
    expect(createMessageExpiryClock({ bad: Number.NaN, negative: -1, zero: 0, chain: 900_000, device: 12_000 })).toEqual({
      kinds: {
        zero: { marginMs: 0, failedPushMs: 0 },
        chain: { marginMs: 600_000, failedPushMs: 0 },
        device: { marginMs: 12_000, failedPushMs: 0 },
      },
      rejectedReported: false,
    })
  })

  it("treats a different-base retry as fresh and the exact half-TTL boundary as not stale", () => {
    const state = createMessageExpiryClock({ chain: 12_000, device: 8_000 })
    const first = { ms: T, base: T, kind: "device", from: 8_000, retry: false, learn: false }
    const crossKind = messageExpiryClockStep(state, {
      type: "retry",
      base: { ms: T + 20_000, kind: "chain" },
      first,
      ttlS: 30,
    })
    expect(crossKind.commands).toEqual([{
      type: "stamp",
      stamp: { ms: T + 80_000, base: T + 20_000, kind: "chain", from: 8_000, retry: true, learn: true },
    }])

    const boundary = messageExpiryClockStep(state, {
      type: "retry",
      base: { ms: T + 15_000, kind: "device" },
      first,
      ttlS: 30,
    })
    expect(boundary.commands[0]).toMatchObject({ type: "stamp", stamp: { learn: true, ms: T + 75_000 } })
  })

  it("does not replace a smaller margin with a later sibling's wider acceptance", () => {
    const state = createMessageExpiryClock({ chain: 120_000 })
    const result = messageExpiryClockStep(state, {
      type: "accepted",
      stamp: { ms: T + 240_000, base: T, kind: "chain", from: 0, retry: true, learn: true },
    })
    expect(result).toEqual({ state, commands: [] })
  })

  it("before the first block: the step-free device clock stands in, so a wall step back moves nothing", () => {
    expect(storeClockBase()).toEqual({ ms: T, kind: "device" })
    vi.setSystemTime(T - 75_000)
    expect(storeClock().stamp().ms).toBe(T)
  })

  it("with a chain clock: chain time, margin 0, whatever the phone's wall says", () => {
    setChainNow(() => T - 4_000)
    vi.setSystemTime(T + 5 * 60_000) // a phone set 5 min ahead
    expect(storeClock().stamp()).toMatchObject({ ms: T - 4_000, kind: "chain", retry: false })
  })

  it("a time rejection pushes the re-stamp ahead of chain time, and the accepted margin stamps the next statement", () => {
    setChainNow(() => T - 4_000)
    const clock = storeClock()
    const retry = clock.retryStamp(clock.stamp())
    expect(retry.ms).toBe(T - 4_000 + MIN_RETRY_MARGIN_MS)
    clock.accepted(retry)
    expect(storeClock().stamp().ms).toBe(T - 4_000 + MIN_RETRY_MARGIN_MS) // one clock for the page
  })

  it("a margin learned on the device clock is dropped when the chain's arrives", () => {
    const clock = storeClock()
    clock.accepted(clock.retryStamp(clock.stamp()))
    expect(clock.marginMs()).toBe(MIN_RETRY_MARGIN_MS)
    setChainNow(() => T + 1_000)
    expect(clock.stamp().ms).toBe(T + 1_000)
  })
})

const tick = () => new Promise<void>((r) => setImmediate(r))
const settle = async () => {
  for (let i = 0; i < 40; i++) await tick()
}
/** Poll until `cond` holds. Bounded by process.hrtime, since these tests fake Date AND performance. */
const until = async (cond: () => boolean, what: string, maxMs = 15_000) => {
  const t0 = process.hrtime.bigint()
  while (!cond()) {
    if (process.hrtime.bigint() - t0 > BigInt(maxMs) * 1_000_000n) throw new Error(`timed out waiting for ${what}`)
    await tick()
  }
}
const isDesc = (wire: WireStatement) => new TextDecoder().decode(Uint8Array.from(Buffer.from(wire.data.slice(2), "hex"))).includes('"t":"d"')

/** a node in sync with the true time that keeps one statement per channel and
 *  refuses a lower or equal expiry on it, as the host reports it */
function node(ahead: () => number, channels: Map<string, bigint>) {
  const lowPriority: WireStatement[] = []
  const accepted: WireStatement[] = []
  const store: StatementStoreLike = {
    createProofAuthorized: async () => "proof",
    submit: async (wire) => {
      if (Math.floor((Date.now() + ahead()) / 1000) >= Number(wire.expiry >> 32n))
        throw new Error(`statement_submit not accepted: {"reason":"alreadyExpired","status":"invalid"}`)
      const held = channels.get(wire.channel)
      if (held !== undefined && wire.expiry <= held) {
        lowPriority.push(wire)
        throw new Error(`statement_submit not accepted: {"min_expiry":${held},"reason":"channelPriorityTooLow","status":"rejected","submitted_expiry":${wire.expiry}}`)
      }
      channels.set(wire.channel, wire.expiry)
      accepted.push(wire)
    },
    subscribe: () => ({}),
  }
  return { store, lowPriority, accepted }
}

async function page({ store, accepted }: ReturnType<typeof node>) {
  const transport = statementTransport({
    resolveStore: async () => store,
    namespace: "ns",
    log: () => {},
    storeClock: storeClock(),
  })({ base: "", room: "g7:me_p1", id: "me", name: "me", handlers: { onPeerJoined: () => {}, onPeerLeft: () => {}, onSignal: () => {} } })
  await settle()
  transport.send("p1", { rtc: { desc: { type: "offer", sdp: "o" } } })
  // the hello and the desc are submitted after real async work (sha256), and a closed transport skips the time
  // re-stamp by design: wait until both have landed, or the page closes before it learns its margin (#372)
  await until(() => accepted.some(isDesc) && accepted.some((wire) => !isDesc(wire)), "the hello and the desc to be accepted")
  await settle()
  await vi.advanceTimersByTimeAsync(1_000)
  await settle()
  return transport
}

describe("the store clock across a reload mid-game (#336 review)", () => {
  it("a reload on the same room sends its first desc without a priority rejection", async () => {
    setChainNow(() => Date.now() - 2_000)
    const channels = new Map<string, bigint>()
    let ahead = 45_000
    const first = node(() => ahead, channels)
    ;(await page(first)).close()
    expect(storeClock().marginMs()).toBe(MIN_RETRY_MARGIN_MS)
    // the reload: the module state is gone, sessionStorage is not; the node is back in sync
    resetStoreClockForTests({ reload: true })
    resetSlotExpiryForTests()
    resetChainClockForTests()
    setChainNow(() => Date.now() - 2_000)
    ahead = 0
    await vi.advanceTimersByTimeAsync(2_000)
    const second = node(() => ahead, channels)
    ;(await page(second)).close()
    expect(second.accepted.length).toBeGreaterThanOrEqual(2) // the hello and the desc
    expect(second.lowPriority).toEqual([])
    expect(storeClock().marginMs()).toBe(MIN_RETRY_MARGIN_MS)
  })

  it("saves the floor when a stamp is MINTED, not when it is accepted: a statement still in flight at the reload is covered (#345 review)", () => {
    setChainNow(() => T)
    storeClock() // the page's clock exists, so its saver is listening
    const minted = nextSlotExpiry(T + 60_000) // e.g. the bye, signed after the last accepted statement
    const saved = JSON.parse(session.get("jollity.storeClock") ?? "{}") as { floor?: string }
    expect(saved.floor).toBe(minted.toString())
  })

  it("an unreadable saved state is ignored", () => {
    session.set("jollity.storeClock", "{not json")
    setChainNow(() => T)
    expect(storeClock().stamp().ms).toBe(T)
  })
})
