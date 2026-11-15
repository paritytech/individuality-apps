// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * F3: the submit pipe under a hung
 * or slow signer. Every heartbeat re-submits a hello plus each live desc and
 * cand slot through the 2-slot semaphore. Before the fix the queue grew
 * without bound, each queued frame carried an expiry minted when it was
 * queued (so it went out already expired), and a superseded frame for a
 * channel was still signed after a newer one for that channel had queued.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { createStoreClock } from "./storeClock"
import { fromHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers, SignalTransport } from "./transport"

const dec = new TextDecoder()
type AnyFrame = Record<string, unknown>

/** In-memory store whose signer hangs forever or answers after `signMs`. */
function fakeStore(opts: { hangSigns?: boolean; signMs?: number } = {}) {
  const signed: WireStatement[] = []
  const submitted: Array<{ wire: WireStatement; at: number }> = []
  let onPage: unknown = null
  const store: StatementStoreLike = {
    createProofAuthorized: (wire) => {
      signed.push(wire)
      if (opts.hangSigns) return new Promise<unknown>(() => {})
      return new Promise<unknown>((r) => setTimeout(() => r("fake-proof"), opts.signMs ?? 0))
    },
    submit: async (wire) => {
      submitted.push({ wire, at: Date.now() })
    },
    subscribe: (_filter, cb) => {
      onPage = cb
      return { unsubscribe: () => {} }
    },
  }
  const frame = (w: WireStatement) => JSON.parse(dec.decode(fromHex(w.data))) as AnyFrame
  return { store, signed, submitted, subscribed: () => onPage !== null, frame }
}

const tick = () => new Promise<void>((r) => setImmediate(r))
// Real time, not Date: the tests fake Date. crypto.subtle digests resolve off
// the event loop, so on a slow runner a fixed count of setImmediate rounds can
// finish before they do; `minMs` keeps settling for a real-time floor as well.
const settle = async (rounds = 20, minMs = 5) => {
  const t0 = performance.now()
  for (let i = 0; i < rounds || performance.now() - t0 < minMs; i++) await tick()
}
/** Poll until `cond` holds; fail loudly (not silently) after `maxMs` of real time. */
const until = async (cond: () => boolean, what: string, maxMs = 15_000) => {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > maxMs) throw new Error(`timed out waiting for ${what}`)
    await tick()
  }
}

async function open(fake: ReturnType<typeof fakeStore>, now?: () => number, expiryNow?: () => number) {
  const handlers: SignalHandlers = {
    onPeerJoined: vi.fn(),
    onPeerLeft: vi.fn(),
    onSignal: vi.fn(),
  }
  const transport: SignalTransport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
    now,
    storeClock: expiryNow && createStoreClock({ base: () => ({ ms: expiryNow(), kind: "test" }) }),
  })({ base: "", room: "room1", id: "me", name: "me", handlers })
  await until(fake.subscribed, "the transport to subscribe")
  return transport
}

// A pacing delay, not a read: it lets the real async work (sha256 digests)
// behind each heartbeat finish before the fake clock moves. Callers that then
// assert a positive count wait for it with `until`.
async function beats(n: number) {
  for (let beat = 0; beat < n; beat++) {
    await settle()
    await vi.advanceTimersByTimeAsync(8_000)
  }
  await settle()
}

// nextSlotExpiry() is module-global and strictly rising, so each test starts
// its fake clock an hour past the last one: an earlier test's late expiries
// must not lift this test's deadlines.
let epoch = Date.now()
function fakeTimers() {
  epoch += 3_600_000
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: epoch })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("statementTransport — F3 submit backlog", () => {
  // The queue stays bounded while the signer hangs.
  it("F3: the submit backlog stays within one heartbeat's worth when the signer hangs", async () => {
    fakeTimers()
    const fake = fakeStore({ hangSigns: true })
    const transport = await open(fake)
    for (const to of ["p1", "p2"])
      transport.send(to, { rtc: { desc: { type: "offer", sdp: `o-${to}` } } })
    await beats(12)
    const s = transport.stats!()
    const backlog = s.framesSent - s.submitsOk - s.submitsFailed - s.inflight
    // one heartbeat = a hello + a desc for each of the 2 peers
    expect(backlog).toBeLessThanOrEqual(3)
    transport.close()
  })

  // No frame goes out already expired: a slow signer (7.5 s, under SIGN_TIMEOUT_MS)
  // with 3 peers serves ~2 frames per beat against 4 arrivals.
  it("F3: no statement reaches the store already past its own TTL deadline", async () => {
    fakeTimers()
    const fake = fakeStore({ signMs: 7_500 })
    const transport = await open(fake)
    for (const to of ["p1", "p2", "p3"])
      transport.send(to, { rtc: { desc: { type: "offer", sdp: `o-${to}` } } })
    await beats(15)
    await until(() => fake.submitted.length > 10, "more than 10 statements to reach the store")
    expect(fake.submitted.length).toBeGreaterThan(10)
    const expired = fake.submitted.filter(
      ({ wire, at }) => Number(wire.expiry >> 32n) * 1000 <= at,
    )
    expect(expired).toEqual([])
    transport.close()
  })

  // No superseded frame is signed: a queued frame for a channel is replaced
  // by a newer one for the same channel and never signed.
  it("F3: a desc superseded while it waits for a slot is never signed", async () => {
    fakeTimers()
    const fake = fakeStore({ hangSigns: true })
    const transport = await open(fake)
    const sdpsSigned = () =>
      fake.signed.map((w) => (fake.frame(w).desc as { sdp?: string } | undefined)?.sdp).filter(Boolean)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "fill" } } }) // with the first hello, both slots
    await until(() => fake.signed.length >= 2, "the hello and the fill desc to hold both slots")
    transport.send("p2", { rtc: { desc: { type: "offer", sdp: "old" } } }) // queued
    transport.send("p2", { rtc: { desc: { type: "offer", sdp: "new" } } }) // supersedes it
    await vi.advanceTimersByTimeAsync(8_000) // the hung signs time out and free both slots
    await until(() => sdpsSigned().includes("new"), "the superseding desc to be signed")
    const sdps = sdpsSigned()
    expect(sdps).toContain("new")
    expect(sdps).not.toContain("old")
    transport.close()
  })
})

describe("statementTransport — a wall clock stepped back (#331)", () => {
  // Game 192: the phone's clock stepped back 75 s mid-game. The node judges a
  // statement's deadline against its OWN clock, so a deadline minted on the
  // stepped clock (Date + TTL_S 30 s) was already past: `alreadyExpired`, the
  // mesh went dark, and the isolation verdict sent the player away.
  /** submit, as the node's clock has it: the true time, not the stepped Date */
  async function steppedBack(
    now: ((stepped: () => number) => () => number) | undefined,
    expiryNow?: (stepped: () => number) => () => number,
  ) {
    fakeTimers()
    let stepped = 0
    const trueNow = () => Date.now() - stepped
    const fake = fakeStore()
    fake.store.submit = async (wire) => {
      fake.submitted.push({ wire, at: trueNow() })
    }
    const transport = await open(fake, now?.(() => stepped), expiryNow?.(() => stepped))
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "o-p1" } } })
    await beats(1)
    stepped = -75_000
    vi.setSystemTime(Date.now() + stepped)
    const before = fake.submitted.length
    await beats(6)
    await until(() => fake.submitted.length > before + 3, "more than 3 statements after the step")
    const after = fake.submitted.slice(before)
    transport.close()
    expect(after.length).toBeGreaterThan(3)
    return after.filter(({ wire, at }) => Number(wire.expiry >> 32n) * 1000 <= at)
  }

  it("on the wall clock, the statements go out already expired (the bug)", async () => {
    expect((await steppedBack(undefined)).length).toBeGreaterThan(0)
  })

  it("on a step-free clock passed as `now`, none does", async () => {
    expect(await steppedBack((stepped) => () => Date.now() - stepped())).toEqual([])
  })

  it("the store clock alone mints the deadline: the stamps may stay on another clock", async () => {
    expect(await steppedBack(undefined, (stepped) => () => Date.now() - stepped())).toEqual([])
  })
})
