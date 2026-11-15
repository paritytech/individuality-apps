// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * #457: a connected link needs little of the store (header, rule 6).
 *
 * The mesh says which of its links are up (`setLinked`). A linked peer gets no
 * heartbeat re-announce of our desc and candidates, except for FRESH_DESC_MS
 * after a desc that went by the store; the hello slows to STABLE_HELLO_MS once
 * every link is up; a linked peer is never forgotten for hello silence, and its
 * session stays live while the link is up.
 */
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers } from "./transport"

const enc = new TextEncoder()
const dec = new TextDecoder()
type AnyFrame = Record<string, unknown>

function fakeStore() {
  const submitted: Array<WireStatement & { proof: unknown }> = []
  let onPage: ((page: { statements: Array<{ data?: string }> }) => void) | null = null
  const store: StatementStoreLike = {
    createProofAuthorized: () => Promise.resolve("fake-proof"),
    submit: async (wire) => {
      submitted.push(wire)
    },
    subscribe: (_filter, cb) => {
      onPage = cb
      return { unsubscribe: () => {} }
    },
  }
  return {
    store,
    push: (...frames: AnyFrame[]) =>
      onPage?.({ statements: frames.map((f) => ({ data: toHex(enc.encode(JSON.stringify(f))) })) }),
    subscribed: () => onPage !== null,
    frames: () => submitted.map((w) => JSON.parse(dec.decode(fromHex(w.data))) as AnyFrame),
  }
}

function spies() {
  return {
    onPeerSession: vi.fn<(id: string, sid: string) => void>(),
    onPeerJoined: vi.fn<(id: string, name: string, seen?: boolean) => void>(),
    onPeerLeft: vi.fn<(id: string) => void>(),
    onSignal: vi.fn<(from: string, data: unknown) => void>(),
  } satisfies SignalHandlers
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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("statementTransport — a room whose links are up needs little of the store (#457)", () => {
  const SID_A = "1800000000000-aaaa"
  const SID_B = "1800000005000-bbbb" // the peer's reload: a later boot

  /** the transport open on fake time, a peer heard, an offer sent to it, past the first beats */
  async function room() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    // A submit hashes its labels with WebCrypto, which finishes on the real
    // clock: under fake time a slow machine would merge beats that a fast one
    // keeps apart. The same hash, settled at once, keeps the count exact.
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
      const bytes = createHash("sha256").update(Buffer.from(data as ArrayBuffer)).digest()
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    })
    const fake = fakeStore()
    const handlers = spies()
    const transport = statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {} })({
      base: "",
      room: "room1",
      id: "me",
      name: "Me",
      handlers,
    })
    await vi.advanceTimersByTimeAsync(200)
    await until(fake.subscribed, "the transport to subscribe")
    let sid = SID_A
    const hello = () => fake.push({ t: "hello", from: "peer", sid, name: "Peer" })
    hello()
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "v=0 offer" } } })
    /** what the heartbeat submits over `ms`, by frame type, the peer's hello coming every 4 s */
    const over = async (ms: number) => {
      const from = fake.frames().length
      for (let t = 0; t < ms; t += 1000) {
        if (t % 4000 === 0) hello()
        await vi.advanceTimersByTimeAsync(1000)
      }
      const types = fake.frames().slice(from).map((f) => f.t)
      return { hello: types.filter((t) => t === "hello").length, desc: types.filter((t) => t === "d").length }
    }
    await over(10_000) // past the first beats
    return { fake, handlers, transport, over, reload: (to: string) => void (sid = to) }
  }

  it("re-announces our description every beat while the link forms, and stops once it is up", async () => {
    const { transport, over } = await room()
    expect(await over(64_000)).toEqual({ hello: 8, desc: 8 }) // forming: every 8 s
    transport.setLinked?.("peer", true)
    await over(32_000) // past FRESH_DESC_MS of the offer
    expect(await over(64_000)).toEqual({ hello: 4, desc: 0 }) // up: a hello every 16 s, nothing else
    transport.setLinked?.("peer", false)
    expect(await over(64_000)).toEqual({ hello: 8, desc: 8 }) // dropped: back to every beat
    transport.close()
  })

  it("still re-announces a description sent just now to a linked peer: an ICE restart over the store", async () => {
    const { transport, over } = await room()
    transport.setLinked?.("peer", true)
    await over(40_000)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "v=0 restart" } } })
    expect((await over(24_000)).desc).toBeGreaterThanOrEqual(3) // sent, then re-announced
    await over(16_000) // its FRESH_DESC_MS runs out
    expect((await over(40_000)).desc).toBe(0) // then quiet again
    transport.close()
  })

  it("keeps the hello at every beat while one link of several is still down", async () => {
    const { fake, transport, over } = await room()
    // a second peer we offer to, its link never up (heard once: an offer of
    // ours outlives its hellos, a peer we only heard is forgotten in 45 s)
    fake.push({ t: "hello", from: "other", name: "Other" })
    transport.send("other", { rtc: { desc: { type: "offer", sdp: "v=0 other" } } })
    transport.setLinked?.("peer", true)
    await over(32_000)
    expect((await over(64_000)).hello).toBe(8)
    transport.close()
  })

  it("never forgets a linked peer for hello silence, and forgets an unlinked one", async () => {
    const { handlers, transport } = await room()
    transport.setLinked?.("peer", true)
    await vi.advanceTimersByTimeAsync(80_000) // no hello from the peer at all
    expect(handlers.onPeerLeft).not.toHaveBeenCalled()
    transport.setLinked?.("peer", false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer")
    transport.close()
  })

  it("forgets the link when the peer reloads: the new boot's link is re-announced to every beat", async () => {
    const { handlers, transport, over, reload } = await room()
    transport.setLinked?.("peer", true)
    await over(40_000)
    reload(SID_B) // its next hello is the new boot's
    await over(4_000)
    expect(handlers.onPeerSession).toHaveBeenCalledWith("peer", SID_B)
    // the mesh rebuilds the link and offers again; it is not up yet
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "v=0 rebuilt" } } })
    await over(32_000) // past FRESH_DESC_MS: a stale link would have gone quiet here
    expect(await over(64_000)).toEqual({ hello: 8, desc: 8 })
    transport.close()
  })
})

describe("statementTransport — a linked peer's session stays live however slow its hello (#457)", () => {
  // a reload whose clock went back an hour: its sid sorts OLDER than the live boot's
  const T = 1_800_000_000_000
  const LIVE = `${T}-aaaa`
  const WRONG = `${T - 3_600_000}-cccc`
  const hello = (sid: string) => ({ t: "hello", from: "peer", sid, name: "Peer" })

  async function openAt(clock: { ms: number }) {
    const fake = fakeStore()
    const handlers = spies()
    const transport = statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {}, now: () => clock.ms })({
      base: "",
      room: "room1",
      id: "me",
      name: "Me",
      handlers,
    })
    await until(fake.subscribed, "the transport to subscribe")
    return { fake, handlers, transport }
  }

  it("holds an older boot's hello out past SESSION_SILENT_MS while the link is up, and takes it once the link is down", async () => {
    const clock = { ms: 0 }
    const { fake, handlers, transport } = await openAt(clock)
    fake.push(hello(LIVE))
    await settle()
    transport.setLinked?.("peer", true)
    // 25 s with no hello: the live boot, all its links up, says hello every
    // 16 s, so one late or lost hello is no sign it left
    clock.ms = 25_000
    fake.push(hello(WRONG))
    await settle()
    expect(handlers.onPeerSession).not.toHaveBeenCalled()
    // the link drops: the silence counts again, and the fail-open takes over
    transport.setLinked?.("peer", false)
    fake.push(hello(WRONG))
    await settle()
    expect(handlers.onPeerSession.mock.calls).toEqual([["peer", WRONG]])
    transport.close()
  })
})
