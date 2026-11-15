// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Candidate delivery: the receiver dedups a generation's candidates by
 * IDENTITY, never by index. Two lost-candidate cases, found by a model check,
 * came from index dedup:
 *   - F8: a new description under an unchanged gen restarts the sender's list
 *     at index 0 while the receiver kept its count, so the first candidates
 *     of the new list were skipped.
 *   - F2: the sender keeps a sliding MAX_CANDS window, so once it is full
 *     every frame is 40 long and candidate 41 onward was never delivered.
 * The frame format is unchanged, so a peer on an old bundle still interops.
 */
import { describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers, SignalTransport } from "./transport"

const enc = new TextEncoder()
const dec = new TextDecoder()
type AnyFrame = Record<string, unknown>

/** In-memory store: records submits, lets a test push inbound pages. */
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
      onPage?.({
        statements: frames.map((f) => ({ data: toHex(enc.encode(JSON.stringify(f))) })),
      }),
    subscribed: () => onPage !== null,
    frames: () => submitted.map((w) => JSON.parse(dec.decode(fromHex(w.data))) as AnyFrame),
  }
}

function spies() {
  return {
    onPeerJoined: vi.fn<(id: string, name: string, seen?: boolean) => void>(),
    onPeerLeft: vi.fn<(id: string) => void>(),
    onSignal: vi.fn<(from: string, data: unknown) => void>(),
  } satisfies SignalHandlers
}

/** Let real async work (crypto.subtle digests, promise chains) settle. */
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

async function open(fake: ReturnType<typeof fakeStore>) {
  const handlers = spies()
  const transport: SignalTransport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
  })({ base: "", room: "room1", id: "me", name: "me", handlers })
  await until(fake.subscribed, "the transport to subscribe")
  return { transport, handlers }
}

const offer = (gen: string, sdp: string) => ({
  t: "d", from: "peer", name: "Peer", gen, desc: { type: "offer", sdp },
})
const candsDelivered = (h: ReturnType<typeof spies>) =>
  h.onSignal.mock.calls
    .map(([, d]) => (d as { rtc: { cand?: { candidate?: string } } }).rtc.cand?.candidate)
    .filter((s): s is string => !!s)
/** Each candidate line mapped to how many times it reached the mesh. */
const counts = (xs: string[]) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

describe("statementTransport — candidate delivery (identity dedup)", () => {
  it("F8: a fresh answer under the same gen gets its candidates delivered", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "our offer to be submitted")
    const g = fake.frames().find((f) => f.t === "d")!.gen as string
    const answer = (sdp: string) => ({ t: "d", from: "peer", name: "Peer", gen: g, desc: { type: "answer", sdp } })
    fake.push(answer("a1"))
    fake.push({ t: "c", from: "peer", gen: g, cands: [{ candidate: "a1-c1" }, { candidate: "a1-c2" }] })
    // the peer reloads, reads our offer again from the store, answers it anew
    fake.push(answer("a2"))
    fake.push({ t: "c", from: "peer", gen: g, cands: [{ candidate: "a2-c1" }] })
    await until(() => candsDelivered(handlers).includes("a2-c1"), "a2-c1 to be delivered")
    // a fixed settle only to let a duplicate (which must not come) show up
    await settle()
    const got = candsDelivered(handlers)
    expect(got).toContain("a2-c1")
    expect([...counts(got).values()].every((n) => n === 1)).toBe(true)
    transport.close()
  })

  it("F2: delivers every candidate of the current generation once the window slides", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push(offer("G", "o1"))
    const cand = (i: number) => ({ candidate: `c${i}` })
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => cand(a + i))
    fake.push({ t: "c", from: "peer", gen: "G", cands: range(1, 40) })
    fake.push({ t: "c", from: "peer", gen: "G", cands: range(2, 41) }) // the 41st slid c1 out
    fake.push({ t: "c", from: "peer", gen: "G", cands: range(3, 42) })
    await until(() => candsDelivered(handlers).includes("c42"), "c42 to be delivered")
    // a fixed settle only to let a duplicate (which must not come) show up
    await settle()
    const got = candsDelivered(handlers)
    // c1..c42, each exactly once (the slid-over c2..c40 are not re-delivered)
    expect(got).toEqual(range(1, 42).map((c) => c.candidate))
    transport.close()
  })

  it("an old-bundle peer's cumulative plaintext frames deliver each candidate once", async () => {
    // Exactly the CandFrame an unfixed sender emits: plaintext, the
    // cumulative list for the gen, re-flushed unchanged on every heartbeat.
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push(offer("G", "o1"))
    fake.push({ t: "c", from: "peer", gen: "G", cands: [{ candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 }] })
    fake.push({
      t: "c", from: "peer", gen: "G",
      cands: [{ candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 }, { candidate: "c2", sdpMid: "0", sdpMLineIndex: 0 }],
    })
    // heartbeat self-heal: the same frame read again
    fake.push({
      t: "c", from: "peer", gen: "G",
      cands: [{ candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 }, { candidate: "c2", sdpMid: "0", sdpMLineIndex: 0 }],
    })
    await until(() => candsDelivered(handlers).includes("c2"), "c2 to be delivered")
    // a fixed settle only to let a duplicate (which must not come) show up
    await settle()
    expect(candsDelivered(handlers)).toEqual(["c1", "c2"])
    // the init reaches the mesh untouched
    const firstCand = handlers.onSignal.mock.calls.find(([, d]) => (d as { rtc: { cand?: unknown } }).rtc.cand)!
    expect(firstCand[1]).toEqual({ rtc: { cand: { candidate: "c1", sdpMid: "0", sdpMLineIndex: 0 } } })
    transport.close()
  })

  it("an old-bundle peer's cand frame ahead of its desc is held, then delivered once", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push({ t: "c", from: "peer", gen: "G", cands: [{ candidate: "c1" }, { candidate: "c2" }] })
    await settle() // absence: nothing may be delivered while the desc is missing, so there is nothing to wait for
    expect(candsDelivered(handlers)).toEqual([])
    fake.push(offer("G", "o1"))
    fake.push({ t: "c", from: "peer", gen: "G", cands: [{ candidate: "c1" }, { candidate: "c2" }] })
    await until(() => candsDelivered(handlers).includes("c2"), "c2 to be delivered")
    // a fixed settle only to let a duplicate (which must not come) show up
    await settle()
    expect(candsDelivered(handlers)).toEqual(["c1", "c2"])
    transport.close()
  })

  it("a PEER_TTL forget, a same-gen re-trickle, then a new gen: nothing is lost", async () => {
    // Holds whether the TTL forget drops the receive state (main) or keeps
    // it (the F4 fix): the dedup set lives exactly as long as its gen.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const fake = fakeStore()
      const { transport, handlers } = await open(fake)
      fake.push(offer("G", "o1"))
      fake.push({ t: "c", from: "peer", gen: "G", cands: [{ candidate: "c1" }, { candidate: "c2" }] })
      await until(() => candsDelivered(handlers).includes("c2"), "c2 to be delivered")
      await vi.advanceTimersByTimeAsync(60_000) // silent past PEER_TTL_MS (45 s)
      expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer")
      // it comes back: the heartbeat re-announce of the same offer, then the
      // cumulative list with one more candidate
      fake.push(offer("G", "o1"))
      fake.push({
        t: "c", from: "peer", gen: "G",
        cands: [{ candidate: "c1" }, { candidate: "c2" }, { candidate: "c3" }],
      })
      await until(() => candsDelivered(handlers).includes("c3"), "c3 to be delivered")
      // a fixed settle only to let a duplicate (which must not come) show up
      await settle()
      const sameGen = counts(candsDelivered(handlers))
      for (const c of ["c1", "c2", "c3"]) expect(sameGen.get(c) ?? 0).toBeGreaterThanOrEqual(1)
      expect(sameGen.get("c3")).toBe(1)
      // a new gen whose PC happens to reuse a line: delivered again, once
      fake.push(offer("G2", "o2"))
      fake.push({ t: "c", from: "peer", gen: "G2", cands: [{ candidate: "c1" }, { candidate: "c4" }] })
      fake.push({ t: "c", from: "peer", gen: "G2", cands: [{ candidate: "c1" }, { candidate: "c4" }] })
      await until(() => candsDelivered(handlers).includes("c4"), "c4 to be delivered")
      // a fixed settle only to let a duplicate (which must not come) show up
      await settle()
      const after = counts(candsDelivered(handlers))
      expect(after.get("c1")).toBe((sameGen.get("c1") ?? 0) + 1)
      expect(after.get("c4")).toBe(1)
      transport.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a new gen starts delivery afresh, even for a candidate line seen in the old gen", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push(offer("G1", "o1"))
    fake.push({ t: "c", from: "peer", gen: "G1", cands: [{ candidate: "c1" }] })
    fake.push(offer("G2", "o2"))
    fake.push({ t: "c", from: "peer", gen: "G2", cands: [{ candidate: "c1" }] })
    await until(() => candsDelivered(handlers).length >= 2, "both c1 lines to be delivered")
    // a fixed settle only to let a duplicate (which must not come) show up
    await settle()
    expect(candsDelivered(handlers)).toEqual(["c1", "c1"])
    transport.close()
  })
})
