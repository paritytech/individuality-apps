// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The store clock (docs/time-and-clocks.md, Rule 2): every statement's expiry
 * is stamped from a BASE clock (the app's chain time) plus a learned
 * acceptance margin. The node judges `expiry >> 32` against its own system
 * clock (sc-statement-store `submit`: `is_expired(self.timestamp())`) and
 * answers `{"status":"invalid","reason":"alreadyExpired"}` with no time of its
 * own, and it puts no upper bound on a future expiry. So the transport can only
 * bracket the node's clock: a rejection says the stamp was behind it, an
 * acceptance says it was not. On a time rejection the statement is re-stamped
 * ONCE with a margin pushed ahead, re-signed and resubmitted, and the margin
 * the store accepted is kept for the session.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { statementTransport, type SubmitEvent } from "./statementTransport"
import { channelPriorityFloor, isTimeRejection, resetSlotExpiryForTests, TTL_S } from "./statementCommon"
import {
  calibrateStoreClock,
  calibrationLabels,
  CALIBRATION_TTL_S,
  createStoreClock,
  MAX_RETRY_MARGIN_MS,
  MIN_RETRY_MARGIN_MS,
  type StoreClock,
  type StoreClockEvent,
} from "./storeClock"
import { sha256 } from "./statementCommon"
import { toHex } from "./store"
import { type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers, SignalTransport } from "./transport"

const HOST_EXPIRED = `statement-store submit failed: statement_submit not accepted: {"reason":"alreadyExpired","status":"invalid"}`

/**
 * A store whose node judges each expiry on its OWN clock (`nodeMs`), the way
 * sc-statement-store does, and rejects a past one exactly as the truapi host
 * reports it (game 192, bot 9).
 */
function nodeStore(
  nodeMs: () => number,
  opts: { channels?: Map<string, bigint>; onSign?: (wire: WireStatement) => void } = {},
) {
  const signed: WireStatement[] = []
  /** every statement handed to submit, whatever the node said */
  const submitted: WireStatement[] = []
  const accepted: WireStatement[] = []
  const rejected: WireStatement[] = []
  /** priority rejections: the node keeps one statement per channel, and a
   *  replacement must carry a higher expiry (`channelPriorityTooLow`) */
  const lowPriority: WireStatement[] = []
  const channels = opts.channels ?? new Map<string, bigint>()
  let subscribed = false
  const store: StatementStoreLike = {
    createProofAuthorized: async (wire) => {
      signed.push(wire)
      opts.onSign?.(wire)
      return "proof"
    },
    submit: async (wire) => {
      submitted.push(wire)
      if (Math.floor(nodeMs() / 1000) >= Number(wire.expiry >> 32n)) {
        rejected.push(wire)
        throw new Error(HOST_EXPIRED)
      }
      const held = channels.get(wire.channel)
      if (held !== undefined && wire.expiry <= held) {
        lowPriority.push(wire)
        // as the truapi host re-serializes it: keys sorted, the fields snake_case
        throw new Error(
          `statement_submit not accepted: {"min_expiry":${held},"reason":"channelPriorityTooLow","status":"rejected","submitted_expiry":${wire.expiry}}`,
        )
      }
      channels.set(wire.channel, wire.expiry)
      accepted.push(wire)
    },
    subscribe: () => {
      subscribed = true
      return { unsubscribe: () => {} }
    },
  }
  return { store, signed, submitted, accepted, rejected, lowPriority, channels, subscribed: () => subscribed }
}

/** the signalling frame a statement carries, or undefined for the calibration's non-frame data */
const frameOf = (wire: WireStatement): { t?: string; desc?: { sdp?: string } } | undefined => {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(Buffer.from(wire.data.slice(2), "hex"))))
  } catch {
    return undefined
  }
}
/** the sdp a desc statement carries (unsealed) */
const sdpOf = (wire: WireStatement): string | undefined => {
  const frame = frameOf(wire)
  return frame?.t === "d" ? frame.desc?.sdp : undefined
}

const tick = () => new Promise<void>((r) => setImmediate(r))
const settle = async (rounds = 20, minMs = 5) => {
  const t0 = performance.now()
  for (let i = 0; i < rounds || performance.now() - t0 < minMs; i++) await tick()
}
const until = async (cond: () => boolean, what: string, maxMs = 15_000) => {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > maxMs) throw new Error(`timed out waiting for ${what}`)
    await tick()
  }
}

// nextSlotExpiry() is module-global and strictly rising: each test starts its
// fake clock well past the last one's furthest stamp
let epoch = Date.now()
function fakeTimers() {
  epoch += 24 * 3_600_000
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: epoch })
}
// A closed transport's bye is stamped after real async work (sha256), so it may still be on its way when the test
// ends. Stamped once the next test's clock has jumped a day ahead, it would lift the module-global expiry floor
// (nextSlotExpiry) above that test's own stamps (#372). So a world's transport is closed and its bye drained before
// the next world starts and after each test.
let drainWorld: (() => Promise<void>) | null = null
afterEach(async () => {
  await drainWorld?.()
  drainWorld = null
  await settle()
  vi.useRealTimers()
})

/**
 * One world: the true time is the fake Date's; the phone's wall clock is off
 * it by `wall`, chain time by `chain`, the node's own clock by `node`.
 */
async function world(
  offsets: { wall?: number; chain?: number; node?: number },
  before?: (ctx: { fake: ReturnType<typeof nodeStore>; clock: StoreClock }) => Promise<void>,
  store?: Parameters<typeof nodeStore>[1],
) {
  await drainWorld?.()
  fakeTimers()
  // by default every clock disagrees: chain time lags 2 s, the phone's wall
  // runs 7 s ahead, so a stamp taken from the wrong clock shows in its deadline
  const off = { wall: 7_000, chain: -2_000, node: 0, ...offsets }
  const truth = () => Date.now()
  const fake = nodeStore(() => truth() + off.node, store)
  const events: StoreClockEvent[] = []
  const submits: SubmitEvent[] = []
  const clock = createStoreClock({
    base: () => ({ ms: truth() + off.chain, kind: "chain" }),
    onEvent: (event) => events.push(event),
  })
  await before?.({ fake, clock })
  const handlers: SignalHandlers = { onPeerJoined: vi.fn(), onPeerLeft: vi.fn(), onSignal: vi.fn() }
  const transport: SignalTransport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
    now: () => truth() + off.wall,
    storeClock: clock,
    onSubmit: (event) => submits.push(event),
  })({ base: "", room: "room1", id: "me", name: "me", handlers })
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    transport.close()
  }
  /** close (once) and wait until the bye has been handed to the node: once closed nothing is retried */
  const drain = async () => {
    close()
    await until(() => fake.submitted.some((wire) => frameOf(wire)?.t === "bye"), "the bye to be submitted")
    await settle()
  }
  drainWorld = drain
  await until(fake.subscribed, "the transport to subscribe")
  // the room's hello goes out first: let it land (or fail) before a test's first desc and before the clock moves
  await until(
    () => fake.accepted.some((wire) => frameOf(wire)?.t === "hello") || submits.some((e) => e.kind === "failed"),
    "the hello to be accepted or to fail",
  )
  await settle()
  /** send one desc and let it land; returns the signs it took */
  const send = async (sdp: string) => {
    const before = fake.signed.length
    const failedBefore = submits.filter((e) => e.kind === "failed").length
    transport.send("p1", { rtc: { desc: { type: "offer", sdp } } })
    // the desc is stamped only after real async work (the channel's sha256), so wait for its submit to be accepted
    // or to fail BEFORE the fake clock moves: a stamp taken during the advance lands up to 1 s late (#372)
    await until(
      () => fake.accepted.some((wire) => sdpOf(wire) === sdp) || submits.filter((e) => e.kind === "failed").length > failedBefore,
      `the desc "${sdp}" to be accepted or to fail`,
    )
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle() // quiescence: the caller pins the exact number of signs this frame took
    return fake.signed.length - before
  }
  /** the deadline a statement stamped `msAgo` before now carries: chain time
   *  plus `margin`, plus the TTL */
  const deadline = (msAgo: number, margin = 0) => Math.floor((truth() - msAgo + off.chain + margin) / 1000) + TTL_S
  const deadlineOf = (wire: WireStatement) => Number(wire.expiry >> 32n)
  return { off, truth, fake, clock, events, submits, transport: { ...transport, close }, drain, send, deadline, deadlineOf }
}

describe("isTimeRejection: the node's alreadyExpired, exactly", () => {
  it("matches the host's and the node RPC's shapes, in either key order", () => {
    expect(isTimeRejection(new Error(HOST_EXPIRED))).toBe(true)
    // nodeStatementStore: `statement rejected: ${JSON.stringify(SubmitResult)}`, the node's order
    expect(isTimeRejection(new Error(`statement rejected: {"status":"invalid","reason":"alreadyExpired"}`))).toBe(true)
    // the SubmitResult itself, should a store reject with the object
    expect(isTimeRejection({ status: "invalid", reason: "alreadyExpired" })).toBe(true)
  })

  it("matches the iOS host's Swift wording, which carries no JSON", () => {
    const ios = "invalid(Optional(StatementStore.StatementInvalidReason.alreadyExpired))"
    expect(isTimeRejection(new Error(ios))).toBe(true)
    expect(isTimeRejection(new Error(`statement submit failed: ${ios}`))).toBe(true)
    expect(isTimeRejection(new Error("InvalidReason::AlreadyExpired"))).toBe(true)
    expect(isTimeRejection(new Error("already_expired"))).toBe(true)
  })

  it("does not match the rejections about expiry ORDER, allowance, or a lookalike", () => {
    for (const result of [
      `{"status":"rejected","reason":"channelPriorityTooLow","submittedExpiry":1,"minExpiry":2}`,
      `{"status":"rejected","reason":"accountFull","submittedExpiry":1,"minExpiry":2}`,
      `{"reason":"noAllowance","status":"rejected"}`,
      `{"status":"knownExpired"}`,
    ])
      expect(isTimeRejection(new Error(`statement_submit not accepted: ${result}`))).toBe(false)
    expect(isTimeRejection(new Error("submit timeout"))).toBe(false)
    expect(isTimeRejection(new Error("notalreadyexpiredyet"))).toBe(false) // a word, not a substring
  })
})

describe("channelPriorityFloor: the expiry our own channel already holds", () => {
  it("reads min_expiry exactly, past 2^53, in the host's snake_case and the camelCase shape", () => {
    const held = (1_800_000_000n << 32n) | 123_456_789n
    expect(
      channelPriorityFloor(new Error(`statement_submit not accepted: {"min_expiry":${held},"reason":"channelPriorityTooLow","status":"rejected","submitted_expiry":5}`)),
    ).toBe(held)
    expect(channelPriorityFloor(new Error(`{"status":"rejected","reason":"channelPriorityTooLow","submittedExpiry":5,"minExpiry":${held}}`))).toBe(held)
  })

  it("is null for every other rejection", () => {
    expect(channelPriorityFloor(new Error(`{"min_expiry":9,"reason":"accountFull","status":"rejected","submitted_expiry":5}`))).toBeNull()
    expect(channelPriorityFloor(new Error(HOST_EXPIRED))).toBeNull()
    expect(channelPriorityFloor(new Error("channelPriorityTooLow"))).toBeNull() // no floor to go above
  })
})

describe("the store clock: chain time plus a learned acceptance margin", () => {
  it("a live network: the chain stamp is accepted first time, no retry, even with the phone 5 min ahead", async () => {
    const w = await world({ wall: 5 * 60_000, chain: -3_000 })
    expect(await w.send("a")).toBe(1)
    const deadline = Number(w.fake.accepted.at(-1)!.expiry >> 32n)
    expect(deadline).toBe(Math.floor((w.truth() - 1_000 - 3_000) / 1000) + TTL_S)
    expect(w.fake.rejected).toEqual([])
    expect(w.clock.marginMs()).toBe(0)
    expect(w.events).toEqual([])
    w.transport.close()
  })

  it("the safety net: a node 45 s ahead rejects once, the pushed re-stamp is accepted, and the next statement passes first time", async () => {
    // the first statement is the room's hello: it pays the one rejection
    const w = await world({ node: 45_000 })
    await until(() => w.fake.accepted.length > 0, "the hello to land")
    expect(w.fake.signed).toHaveLength(2)
    expect(w.fake.rejected).toHaveLength(1)
    expect(w.fake.accepted[0]!.expiry).toBe(w.fake.signed[1]!.expiry)
    expect(w.clock.marginMs()).toBe(MIN_RETRY_MARGIN_MS)
    const learned = w.events.filter((e) => e.kind === "learned")
    expect(learned).toEqual([{ kind: "learned", marginMs: MIN_RETRY_MARGIN_MS, previousMs: 0, base: "chain" }])
    expect(await w.send("a")).toBe(1)
    expect(w.deadlineOf(w.fake.accepted.at(-1)!)).toBe(w.deadline(1_000, MIN_RETRY_MARGIN_MS))
    expect(await w.send("b")).toBe(1)
    expect(w.fake.rejected).toHaveLength(1)
    w.transport.close()
  })

  it("once the node is back in sync, statements still go out on the learned margin, and the store takes them: no upper bound", async () => {
    const w = await world({ node: 45_000 })
    await w.send("a")
    expect(w.clock.marginMs()).toBe(MIN_RETRY_MARGIN_MS)
    w.off.node = 0
    for (const sdp of ["b", "c", "d"]) {
      expect(await w.send(sdp)).toBe(1)
      // stamped ahead by the margin, not back on bare chain time
      expect(w.deadlineOf(w.fake.accepted.at(-1)!)).toBe(w.deadline(1_000, MIN_RETRY_MARGIN_MS))
    }
    expect(w.fake.rejected).toHaveLength(1)
    w.transport.close()
  })

  it("a push too short is pushed further on the next time rejection, still once a statement", async () => {
    // 100 s ahead: chain + 60 s + TTL is still behind it, chain + 120 s is not
    const w = await world({ node: 100_000 })
    await until(() => w.fake.signed.length >= 2 && w.submits.some((e) => e.kind === "failed"), "the hello to fail")
    expect(w.fake.signed).toHaveLength(2) // the base stamp and one re-stamp: no loop
    expect(w.clock.marginMs()).toBe(0)
    expect(await w.send("a")).toBe(2)
    expect(w.clock.marginMs()).toBe(2 * MIN_RETRY_MARGIN_MS)
    expect(await w.send("b")).toBe(1)
    w.transport.close()
  })

  it("a -75 s wall step mid-game rejects nothing, before and after a margin was learned", async () => {
    for (const node of [0, 45_000]) {
      const w = await world({ node })
      await w.send("a")
      const rejected = w.fake.rejected.length
      w.off.wall -= 75_000
      for (const sdp of ["b", "c", "d"]) {
        expect(await w.send(sdp)).toBe(1)
        expect(w.deadlineOf(w.fake.accepted.at(-1)!)).toBe(w.deadline(1_000, w.clock.marginMs()))
      }
      expect(w.fake.rejected).toHaveLength(rejected)
      w.transport.close()
    }
  })

  it("a phone clock wrong at the start and then corrected: nothing is rejected and no margin is learned", async () => {
    const w = await world({ wall: -3 * 60_000 })
    expect(await w.send("a")).toBe(1)
    expect(w.deadlineOf(w.fake.accepted.at(-1)!)).toBe(w.deadline(1_000))
    w.off.wall = 0 // an NTP fix
    expect(await w.send("b")).toBe(1)
    expect(w.deadlineOf(w.fake.accepted.at(-1)!)).toBe(w.deadline(1_000))
    expect(w.fake.rejected).toEqual([])
    expect(w.clock.marginMs()).toBe(0)
    w.transport.close()
  })

  it("rejected on both stamps: one failure with the reason, no loop, told once", async () => {
    // the node's clock 3 h ahead of chain time
    const w = await world({ node: 3 * 3_600_000 })
    expect(await w.send("a")).toBe(2)
    const failed = w.submits.filter((e) => e.kind === "failed")
    expect(failed.length).toBeGreaterThan(0)
    expect(failed.every((e) => e.kind === "failed" && /alreadyExpired/.test(e.reason))).toBe(true)
    expect(w.events.filter((e) => e.kind === "rejected")).toHaveLength(1)
    expect(w.clock.marginMs()).toBe(0)
    // nothing more is tried on its own
    const signed = w.fake.signed.length
    await settle() // absence: no further sign may follow, so there is nothing to wait for
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(w.fake.signed.length).toBe(signed)
    // the next statement: the base stamp, one re-stamp pushed further, a failure
    expect(await w.send("b")).toBe(2)
    expect(w.events.filter((e) => e.kind === "rejected")).toHaveLength(1)
    w.transport.close()
  })

  it("the re-stamp's push grows from the margin in force and from the last push that failed", () => {
    const clock = createStoreClock({ base: () => ({ ms: 1_000_000, kind: "chain" }) })
    const first = clock.retryStamp(clock.stamp())
    expect(first.ms - 1_000_000).toBe(MIN_RETRY_MARGIN_MS)
    clock.rejected(first, "alreadyExpired")
    const second = clock.retryStamp(clock.stamp())
    expect(second.ms - 1_000_000).toBe(2 * MIN_RETRY_MARGIN_MS)
    clock.accepted(second)
    expect(clock.marginMs()).toBe(2 * MIN_RETRY_MARGIN_MS)
    expect(clock.retryStamp(clock.stamp()).ms - 1_000_000).toBe(4 * MIN_RETRY_MARGIN_MS)
  })

  it("keeps the smallest margin of two re-stamps accepted for the same rejection", () => {
    let base = 1_000_000
    const clock = createStoreClock({ base: () => ({ ms: base, kind: "chain" }) })
    const [a, b, c] = [clock.stamp(), clock.stamp(), clock.stamp()]
    const retryA = clock.retryStamp(a) // MIN
    clock.rejected(clock.retryStamp(c), "alreadyExpired") // a third statement's re-stamp failed meanwhile
    const retryB = clock.retryStamp(b) // pushed further: 2 × MIN
    base += 500
    clock.accepted(retryB)
    expect(clock.marginMs()).toBe(2 * MIN_RETRY_MARGIN_MS)
    clock.accepted(retryA) // the shorter push, accepted later
    expect(clock.marginMs()).toBe(MIN_RETRY_MARGIN_MS)
  })

  it("a margin learned against the device stand-in is dropped once the chain clock arrives", () => {
    let base = { ms: 5_000_000, kind: "device" }
    const clock = createStoreClock({ base: () => base })
    clock.accepted(clock.retryStamp(clock.stamp()))
    expect(clock.marginMs()).toBe(MIN_RETRY_MARGIN_MS)
    base = { ms: 4_000_000, kind: "chain" }
    expect(clock.stamp().ms).toBe(4_000_000)
    expect(clock.marginMs()).toBe(0)
  })

  it("a rejection caused by the stamp's own age (a stalled page) re-stamps from a fresh base and learns nothing", async () => {
    // the page freezes 40 s during the first desc's sign: Date moves, the stamp
    // does not, and the node, in sync, rejects it for time
    let froze = false
    const w = await world({}, undefined, {
      onSign: (wire) => {
        if (froze || wire.topics.length === 0) return
        const frame = JSON.parse(new TextDecoder().decode(Uint8Array.from(Buffer.from(wire.data.slice(2), "hex"))))
        if (frame.t !== "d") return
        froze = true
        vi.setSystemTime(Date.now() + 40_000)
      },
    })
    expect(await w.send("a")).toBe(2)
    expect(w.fake.rejected).toHaveLength(1)
    // the re-stamp is bare chain time, read after the stall: no push
    expect(w.deadlineOf(w.fake.accepted.at(-1)!)).toBe(w.deadline(1_000))
    expect(w.clock.marginMs()).toBe(0)
    expect(w.events).toEqual([])
    expect(await w.send("b")).toBe(1)
    w.transport.close()
  })

  it("no push grows past MAX_RETRY_MARGIN_MS (10 min)", () => {
    expect(MAX_RETRY_MARGIN_MS).toBe(10 * 60_000)
    const clock = createStoreClock({ base: () => ({ ms: 1_000_000, kind: "chain" }) })
    for (let i = 0; i < 20; i++) clock.rejected(clock.retryStamp(clock.stamp()), "alreadyExpired")
    expect(clock.retryStamp(clock.stamp()).ms - 1_000_000).toBe(MAX_RETRY_MARGIN_MS)
  })

  it("a page reloaded mid-game (the expiry floor lost) re-stamps once above its own channel's old statement, and does not fail", async () => {
    const channels = new Map<string, bigint>()
    const before = await world({ node: 45_000 }, undefined, { channels })
    await before.send("a")
    expect(before.clock.marginMs()).toBe(MIN_RETRY_MARGIN_MS)
    await before.drain() // the old page's bye is minted before the reload, not after it (#372)
    // the reload: a new page, no floor, margin 0; the node back in sync
    resetSlotExpiryForTests()
    const submits: SubmitEvent[] = []
    const fake = nodeStore(() => Date.now(), { channels })
    const handlers: SignalHandlers = { onPeerJoined: vi.fn(), onPeerLeft: vi.fn(), onSignal: vi.fn() }
    const transport = statementTransport({
      resolveStore: async () => fake.store,
      namespace: "test.ns",
      log: () => {},
      storeClock: createStoreClock({ base: () => ({ ms: Date.now() - 2_000, kind: "chain" }) }),
      onSubmit: (event) => submits.push(event),
    })({ base: "", room: "room1", id: "me", name: "me", handlers })
    await until(fake.subscribed, "the transport to subscribe")
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "after reload" } } })
    // wait for the hello and the desc to land before the fake clock moves (#372)
    await until(
      () => fake.accepted.some((wire) => sdpOf(wire) === "after reload") || submits.some((e) => e.kind === "failed"),
      "the desc after the reload to be accepted or to fail",
    )
    await until(() => fake.accepted.length >= 2 || submits.some((e) => e.kind === "failed"), "the hello after the reload to land")
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle() // quiescence: the assertions below pin exact final counts (no extra sign or submit)
    expect(fake.lowPriority.length).toBeGreaterThan(0) // the old hello and desc outrank bare chain time
    expect(submits.filter((e) => e.kind === "failed")).toEqual([])
    expect(fake.accepted).toHaveLength(2) // the hello and the desc, each re-stamped once above the old one
    expect(fake.signed.length).toBeLessThanOrEqual(4)
    transport.close()
  })

  it("lastExpiry stays monotonic through a margin change: every signed expiry rises", async () => {
    const w = await world({ node: 45_000 })
    for (const sdp of ["a", "b", "c"]) await w.send(sdp)
    const expiries = w.fake.signed.map((wire) => wire.expiry)
    expect(expiries.length).toBeGreaterThan(3)
    for (let i = 1; i < expiries.length; i++) expect(expiries[i]! > expiries[i - 1]!).toBe(true)
    w.transport.close()
  })
})

/**
 * PER-CHANNEL ORDER. The node keeps one statement per channel, and a
 * replacement must carry a higher expiry. Two frames of ours on one channel in
 * flight at once could land in either order, and a refusal of the older one
 * cannot be told from a pre-reload holder (game 199, bot 16: the glare
 * rebuild's offer and answer to one peer in the same millisecond). So a
 * channel has at most one submit in flight: a newer frame waits, the newest
 * one wins the wait, and other channels go on in parallel.
 */
describe("per-channel order: one submit in flight per channel", () => {
  const text = (wire: WireStatement) => new TextDecoder().decode(Uint8Array.from(Buffer.from(wire.data!.slice(2), "hex")))
  /** a store that logs every submit's start and end by the sdp it carries, and lets a test hold one */
  function orderedStore(opts: { hold?: (body: string) => Promise<void> | undefined; heldBefore?: (body: string) => bigint | undefined } = {}) {
    const channels = new Map<string, bigint>()
    const log: string[] = []
    const accepted: string[] = []
    const signed: string[] = []
    const lowPriority: string[] = []
    let subscribed = false
    const tag = (body: string) => /"sdp":"([^"]+)"/.exec(body)?.[1] ?? (body.includes('"t":"hello"') ? "hello" : body.includes('"t":"bye"') ? "bye" : "other")
    const store: StatementStoreLike = {
      createProofAuthorized: async (wire) => {
        signed.push(tag(text(wire)))
        return "proof"
      },
      submit: async (wire) => {
        const body = text(wire)
        const t = tag(body)
        log.push(`start ${t}`)
        try {
          await opts.hold?.(t)
          const held = channels.get(wire.channel) ?? opts.heldBefore?.(body)
          if (held !== undefined && wire.expiry <= held) {
            lowPriority.push(t)
            throw new Error(
              `statement_submit not accepted: {"min_expiry":${held},"reason":"channelPriorityTooLow","status":"rejected","submitted_expiry":${wire.expiry}}`,
            )
          }
          channels.set(wire.channel, wire.expiry)
          accepted.push(t)
        } finally {
          log.push(`end ${t}`)
        }
      },
      subscribe: () => {
        subscribed = true
        return { unsubscribe: () => {} }
      },
    }
    return { store, log, accepted, signed, lowPriority, channels, subscribed: () => subscribed }
  }
  async function open(fake: ReturnType<typeof orderedStore>) {
    fakeTimers()
    const submits: SubmitEvent[] = []
    const handlers: SignalHandlers = { onPeerJoined: vi.fn(), onPeerLeft: vi.fn(), onSignal: vi.fn() }
    const transport = statementTransport({
      resolveStore: async () => fake.store,
      namespace: "test.ns",
      log: () => {},
      storeClock: createStoreClock({ base: () => ({ ms: Date.now(), kind: "chain" }) }),
      onSubmit: (event) => submits.push(event),
    })({ base: "", room: "room1", id: "me", name: "me", handlers })
    await until(fake.subscribed, "the transport to subscribe")
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    return { transport, submits }
  }
  // pacing, not a read: let real async work (digests) finish around each clock move
  const run = async (ms = 1_000) => {
    await settle()
    await vi.advanceTimersByTimeAsync(ms)
    await settle()
  }

  it("game 199's glare race: the offer and the answer in the same ms on one :d channel, and the answer wins", async () => {
    let release!: () => void
    const offerHeld = new Promise<void>((r) => (release = r))
    const fake = orderedStore({ hold: (t) => (t === "the-offer" ? offerHeld : undefined) })
    const { transport, submits } = await open(fake)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "the-offer" } } })
    await settle() // the offer leaves the queue and is in flight
    transport.send("p1", { rtc: { desc: { type: "answer", sdp: "the-answer" } } })
    await run()
    // the answer waits for the offer: it never goes out while the offer is in flight
    expect(fake.log).not.toContain("start the-answer")
    expect(fake.signed).not.toContain("the-answer")
    release()
    await run()
    const descs = fake.log.filter((l) => /the-(offer|answer)/.test(l))
    expect(descs).toEqual(["start the-offer", "end the-offer", "start the-answer", "end the-answer"])
    expect(fake.accepted.filter((t) => t.startsWith("the-")).at(-1)).toBe("the-answer")
    expect(submits.filter((e) => e.kind === "failed")).toEqual([])
    transport.close()
  })

  it("the same race sent in one tick coalesces: the offer is never submitted, the answer is", async () => {
    const fake = orderedStore()
    const { transport } = await open(fake)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "the-offer" } } })
    transport.send("p1", { rtc: { desc: { type: "answer", sdp: "the-answer" } } })
    await run()
    const sent = fake.log.filter((l) => l.startsWith("start the-"))
    // either never sent, or sent and finished before the answer
    expect(sent.at(-1)).toBe("start the-answer")
    expect(fake.accepted.filter((t) => t.startsWith("the-")).at(-1)).toBe("the-answer")
    transport.close()
  })

  it("the reviewer's reload interleaving: A and B both below the old page's holder, and B is the frame the channel keeps", async () => {
    // the old page left a desc on the channel stamped 60 s ahead; the new page's A and B both stamp below it
    let old: bigint | undefined // stamped on the fake clock at the first read: 60 s ahead of the new page
    const oldHolder = () => (old ??= (BigInt(Math.floor(Date.now() / 1000) + 60 + TTL_S) << 32n) | 1n)
    let bSigned!: () => void
    const signedB = new Promise<void>((r) => (bSigned = r))
    const fake = orderedStore({
      heldBefore: (body) => (body.includes('"t":"d"') ? oldHolder() : undefined),
      // A's refusal comes back only once B has been signed, or after 500 ms: on the old two-in-flight pipe that let
      // A's lift land above B and B's refusal be dropped, so the stale A stayed on the channel
      hold: (t) => (t === "frame-A" && !fake.signed.includes("frame-B") ? Promise.race([signedB, new Promise<void>((r) => setTimeout(r, 500))]) : undefined),
    })
    const realPush = fake.signed.push.bind(fake.signed)
    fake.signed.push = (...items: string[]) => {
      const n = realPush(...items)
      if (items.includes("frame-B")) bSigned()
      return n
    }
    const { transport, submits } = await open(fake)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "frame-A" } } })
    await until(() => fake.signed.includes("frame-A"), "frame-A to be in flight")
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "frame-B" } } })
    await run()
    await run()
    expect(fake.lowPriority).toContain("frame-A") // the old holder was really in the way
    expect(fake.accepted.filter((t) => t.startsWith("frame-")).at(-1)).toBe("frame-B")
    expect(submits.filter((e) => e.kind === "failed")).toEqual([])
    transport.close()
  })

  it("a slow submit on one channel holds up no other channel", async () => {
    let release!: () => void
    const p1Held = new Promise<void>((r) => (release = r))
    const fake = orderedStore({ hold: (t) => (t === "to-p1" ? p1Held : undefined) })
    const { transport } = await open(fake)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "to-p1" } } })
    await until(() => fake.log.includes("start to-p1"), "to-p1 to be held in the store")
    transport.send("p2", { rtc: { desc: { type: "offer", sdp: "to-p2" } } })
    await run()
    expect(fake.accepted).toContain("to-p2")
    expect(fake.accepted).not.toContain("to-p1")
    release()
    await run()
    expect(fake.accepted).toContain("to-p1")
    transport.close()
  })

  it("the bye queued behind a presence submit still goes out after close", async () => {
    let release!: () => void
    const helloHeld = new Promise<void>((r) => (release = r))
    let holding = false
    const fake = orderedStore({ hold: (t) => (holding && t === "hello" ? helloHeld : undefined) })
    const { transport } = await open(fake)
    holding = true
    await vi.advanceTimersByTimeAsync(20_000) // a heartbeat's hello goes out and hangs
    await until(
      () => fake.log.filter((l) => l.endsWith(" hello")).at(-1) === "start hello",
      "the held heartbeat hello to reach the store",
    ) // in flight on the presence channel
    transport.close()
    await until(() => fake.accepted.includes("bye"), "the close bye to be accepted")
    // the bye does not wait for the hello: on unload the page's JS often dies first, and peers would then wait out
    // the TTL instead of dropping the player at once (#345 review)
    expect(fake.log).toContain("start bye")
    expect(fake.accepted).toContain("bye")
    release()
    await run()
  })

  it("closing while a hello waits behind an in-flight one counts no replacement: rtc.signal_replaced is in-game only", async () => {
    let release!: () => void
    const helloHeld = new Promise<void>((r) => (release = r))
    let holding = false
    const fake = orderedStore({ hold: (t) => (holding && t === "hello" ? helloHeld : undefined) })
    const { transport, submits } = await open(fake)
    holding = true
    await vi.advanceTimersByTimeAsync(20_000)
    await until(
      () => fake.log.filter((l) => l.endsWith(" hello")).at(-1) === "start hello",
      "the held heartbeat hello to reach the store",
    )
    await vi.advanceTimersByTimeAsync(20_000) // the next heartbeat's hello waits behind the held one
    await settle() // pacing: let that hello queue before the close
    transport.close()
    await settle() // absence: nothing may be told "replaced", so there is nothing to wait for
    expect(submits.filter((e) => e.kind === "replaced")).toEqual([])
    release()
    await run()
  })

  it("a retry stops when a newer frame waits for its channel: the newer one goes at once, not after the stale one's tries", async () => {
    const fake = orderedStore({
      hold: (t) => (t === "stale" ? Promise.reject(new Error("statement_submit failed: error 0")) : undefined),
    })
    const { transport, submits } = await open(fake)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "stale" } } })
    await until(() => submits.some((e) => e.kind === "retry"), '"stale" to fail fast and start its 400 ms wait')
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "fresh" } } })
    await run(450)
    // Wait for the store's own answer, not a fixed turn count: the "fresh"
    // frame's channel digest is real threadpool work (crypto.subtle), and on a
    // loaded runner it can land past settle()'s turns, which is what made this
    // flake (archive #1459: accepted ['hello'] had no 'fresh' yet)
    await until(() => fake.accepted.includes("fresh"), 'the "fresh" frame to be accepted')
    await settle() // quiescence: pin the exact final counts below
    expect(fake.log.filter((l) => l === "start stale")).toHaveLength(1)
    expect(fake.accepted).toContain("fresh")
    expect(submits.filter((e) => e.kind === "failed")).toEqual([])
    transport.close()
  })

  it("tells when a waiting frame is replaced by a newer one before it is sent, and not for an unchanged re-announce", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const fake = orderedStore({ hold: (t) => (t === "first" ? held : undefined) })
    const { transport, submits } = await open(fake)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "first" } } })
    await until(() => fake.log.includes("start first"), "first to be held in the store")
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "second" } } }) // waits behind "first"
    await settle() // pacing: "second" must reach the channel queue (after its digest) before "third"; the queue is not observable
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "third" } } }) // replaces "second" before it is sent
    await until(() => submits.some((e) => e.kind === "replaced"), "the replacement to be told")
    await settle() // absence: no second "replaced" may follow, so there is nothing to wait for
    expect(submits.filter((e) => e.kind === "replaced")).toEqual([{ kind: "replaced", frame: "desc", to: "p1" }])
    release()
    await run()
    expect(fake.signed).not.toContain("second")
    expect(fake.accepted.at(-1)).toBe("third")
    transport.close()
  })
})

describe("calibration in the waiting room", () => {
  const labels = calibrationLabels("test.ns", "me")

  it("learns the margin before the game: the first in-game statement is accepted first time", async () => {
    let calibration: Awaited<ReturnType<typeof calibrateStoreClock>> | undefined
    let calibrationSigns = 0
    const w = await world({ node: 45_000 }, async ({ fake, clock }) => {
      calibration = await calibrateStoreClock({ store: fake.store, clock, labels })
      calibrationSigns = fake.signed.length
    })
    expect(calibration).toMatchObject({ outcome: "learned", attempts: 2, marginMs: MIN_RETRY_MARGIN_MS })
    expect(typeof calibration!.durationMs).toBe("number")
    // the game: the hello and every desc pass on their first stamp
    await until(() => w.fake.accepted.length > 1, "the hello to land")
    expect(w.fake.signed.length - calibrationSigns).toBe(1)
    expect(await w.send("a")).toBe(1)
    expect(w.fake.rejected).toHaveLength(1) // the calibration's, and no other
    w.transport.close()
  })

  it("rides the player's own channel on a topic no signalling subscribes to, with a short TTL and non-frame data", async () => {
    fakeTimers()
    const fake = nodeStore(() => Date.now())
    const clock = createStoreClock({ base: () => ({ ms: Date.now(), kind: "chain" }) })
    const result = await calibrateStoreClock({ store: fake.store, clock, labels })
    expect(result).toMatchObject({ outcome: "accepted", attempts: 1, marginMs: 0 })
    const wire = fake.accepted[0]!
    expect(wire.channel).toBe(toHex(await sha256("test.ns|rtc:calibrate:me")))
    expect(wire.topics).toEqual([toHex(await sha256("test.ns|rtc:calibrate"))])
    expect(Number(wire.expiry >> 32n)).toBe(Math.floor(Date.now() / 1000) + CALIBRATION_TTL_S)
    expect(() => JSON.parse(new TextDecoder().decode(Uint8Array.from(Buffer.from(wire.data.slice(2), "hex"))))).toThrow()
  })

  it("leaves the signalling slots' expiry floor alone: the first in-game stamp is not lifted by it", async () => {
    const w = await world({}, async ({ fake, clock }) => {
      await calibrateStoreClock({ store: fake.store, clock, labels, ttlS: 3_600 })
    })
    await until(() => w.fake.accepted.length > 1, "the hello to land")
    const calibrationDeadline = Number(w.fake.accepted[0]!.expiry >> 32n)
    const hello = w.fake.accepted[1]!
    // stamped at chain time + TTL_S, not at the calibration's deadline + 1
    expect(Number(hello.expiry >> 32n)).toBeLessThan(calibrationDeadline)
    expect(w.deadlineOf(hello)).toBe(w.deadline(0))
    w.transport.close()
  })

  it("a calibration that cannot finish (no allowance yet) leaves the in-game one-shot re-stamp as the fallback", async () => {
    let calibration: Awaited<ReturnType<typeof calibrateStoreClock>> | undefined
    const w = await world({ node: 45_000 }, async ({ fake, clock }) => {
      const submit = fake.store.submit
      fake.store.submit = async () => {
        throw new Error(`statement_submit not accepted: {"reason":"noAllowance","status":"rejected"}`)
      }
      calibration = await calibrateStoreClock({ store: fake.store, clock, labels })
      fake.store.submit = submit
    })
    expect(calibration).toMatchObject({ outcome: "failed", attempts: 1, marginMs: 0 })
    expect(calibration!.reason).toMatch(/noAllowance/)
    // in game: the hello pays the one rejection and learns the margin
    await until(() => w.fake.accepted.length > 0, "the hello to land")
    expect(w.fake.rejected).toHaveLength(1)
    expect(w.clock.marginMs()).toBe(MIN_RETRY_MARGIN_MS)
    expect(await w.send("a")).toBe(1)
    w.transport.close()
  })

  it("both calibration stamps rejected: reported once, the margin unchanged, no loop", async () => {
    fakeTimers()
    const fake = nodeStore(() => Date.now() + 3 * 3_600_000)
    const events: StoreClockEvent[] = []
    const clock = createStoreClock({ base: () => ({ ms: Date.now(), kind: "chain" }), onEvent: (e) => events.push(e) })
    const result = await calibrateStoreClock({ store: fake.store, clock, labels })
    expect(result).toMatchObject({ outcome: "rejected", attempts: 2, marginMs: 0 })
    expect(fake.signed).toHaveLength(2)
    expect(events.map((e) => e.kind)).toEqual(["rejected"])
  })
})
