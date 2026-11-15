// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers } from "./transport"

const enc = new TextEncoder()
const dec = new TextDecoder()

type AnyFrame = Record<string, unknown>

/** In-memory StatementStoreLike: records submits, lets tests push inbound pages. */
function fakeStore(opts: { hangSubmits?: boolean } = {}) {
  const submitted: Array<WireStatement & { proof: unknown }> = []
  const hung: Array<() => void> = []
  let onPage: ((page: { statements: Array<{ data?: string }> }) => void) | null =
    null
  const store: StatementStoreLike = {
    createProofAuthorized: async () => "fake-proof",
    submit: async (wire) => {
      submitted.push(wire)
      if (opts.hangSubmits) await new Promise<void>((r) => hung.push(r))
    },
    subscribe: (_filter, cb) => {
      onPage = cb
      return { unsubscribe: vi.fn() }
    },
  }
  return {
    store,
    submitted,
    releaseHung: () => {
      for (const r of hung.splice(0)) r()
    },
    /** Deliver frames as if read from the chain. */
    push: (...frames: AnyFrame[]) =>
      onPage?.({
        statements: frames.map((f) => ({
          data: toHex(enc.encode(JSON.stringify(f))),
        })),
      }),
    subscribed: () => onPage !== null,
  }
}

function decodeFrame(wire: WireStatement): AnyFrame {
  return JSON.parse(dec.decode(fromHex(wire.data))) as AnyFrame
}

function handlersWithSpies() {
  const onPeerJoined = vi.fn<(id: string, name: string, seen?: boolean) => void>()
  const onPeerLeft = vi.fn<(id: string) => void>()
  const onSignal = vi.fn<(from: string, data: unknown) => void>()
  return { onPeerJoined, onPeerLeft, onSignal } satisfies SignalHandlers
}

async function openTransport(fake: ReturnType<typeof fakeStore>) {
  const handlers = handlersWithSpies()
  const transport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
  })({ base: "", room: "room1", id: "me", name: "Me", handlers })
  await vi.waitFor(() => {
    if (!fake.subscribed()) throw new Error("not subscribed yet")
  })
  return { transport, handlers }
}

/** The desc submit for a given offer/answer, parsed. */
async function waitForFrame(
  fake: ReturnType<typeof fakeStore>,
  pred: (f: AnyFrame) => boolean,
): Promise<AnyFrame> {
  let found: AnyFrame | undefined
  await vi.waitFor(() => {
    found = fake.submitted.map(decodeFrame).find(pred)
    if (!found) throw new Error("frame not submitted yet")
  })
  return found!
}

describe("statementTransport", () => {
  it("submits one desc per generation and gen-gates a stale answer", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await openTransport(fake)

    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    const descFrame = await waitForFrame(fake, (f) => f.t === "d")
    const gen = descFrame.gen as string
    expect(gen).toBeTruthy()

    // stale answer (wrong gen) → dropped
    fake.push({
      t: "d",
      from: "peer",
      name: "Peer",
      gen: "stale-gen",
      desc: { type: "answer", sdp: "a-stale" },
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(handlers.onSignal).not.toHaveBeenCalled()

    // the answer for OUR generation → delivered
    fake.push({
      t: "d",
      from: "peer",
      name: "Peer",
      gen,
      desc: { type: "answer", sdp: "a1" },
    })
    await vi.waitFor(() => expect(handlers.onSignal).toHaveBeenCalledTimes(1))
    expect(handlers.onSignal).toHaveBeenCalledWith("peer", {
      rtc: { desc: { type: "answer", sdp: "a1" } },
    })
    transport.close()
  })

  it("coalesces trickle candidates into one cumulative overwriting slot", async () => {
    const fake = fakeStore()
    const { transport } = await openTransport(fake)

    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await waitForFrame(fake, (f) => f.t === "d")
    transport.send("peer", { rtc: { cand: { candidate: "c1" } } })
    transport.send("peer", { rtc: { cand: { candidate: "c2" } } })
    transport.send("peer", { rtc: { cand: { candidate: "c3" } } })

    const candFrame = await waitForFrame(fake, (f) => f.t === "c")
    expect(
      (candFrame.cands as Array<{ candidate: string }>).map((c) => c.candidate),
    ).toEqual(["c1", "c2", "c3"])
    // exactly one cand submit for the burst — not one per candidate
    expect(fake.submitted.map(decodeFrame).filter((f) => f.t === "c")).toHaveLength(1)

    // a straggler flushes the CUMULATIVE list (overwrites the same slot)
    transport.send("peer", { rtc: { cand: { candidate: "c4" } } })
    await vi.waitFor(() => {
      const flushes = fake.submitted.map(decodeFrame).filter((f) => f.t === "c")
      if (flushes.length < 2) throw new Error("second flush pending")
      expect(
        (flushes[1]!.cands as Array<{ candidate: string }>).map((c) => c.candidate),
      ).toEqual(["c1", "c2", "c3", "c4"])
    })
    transport.close()
  })

  it("buffers candidates that arrive before their generation's desc", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await openTransport(fake)

    // cand frame for gen G arrives first (the store may reorder)
    fake.push({ t: "c", from: "peer", gen: "G", cands: [{ candidate: "c1" }] })
    await new Promise((r) => setTimeout(r, 50))
    expect(handlers.onSignal).not.toHaveBeenCalled()

    // its desc lands → desc delivered, buffered candidates released after it
    fake.push({
      t: "d",
      from: "peer",
      name: "Peer",
      gen: "G",
      desc: { type: "offer", sdp: "o1" },
    })
    await vi.waitFor(() => expect(handlers.onSignal).toHaveBeenCalledTimes(2))
    expect(handlers.onSignal.mock.calls[0]![1]).toEqual({
      rtc: { desc: { type: "offer", sdp: "o1" }, gen: "G" }, // the offer goes with its gen (F7)
    })
    expect(handlers.onSignal.mock.calls[1]![1]).toEqual({
      rtc: { cand: { candidate: "c1" } },
    })
    transport.close()
  })

  it("dedups a re-read of the same desc (heartbeat re-announce is idempotent)", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await openTransport(fake)
    const offer = {
      t: "d",
      from: "peer",
      name: "Peer",
      gen: "G",
      desc: { type: "offer", sdp: "o1" },
    }
    fake.push(offer)
    fake.push(offer)
    await vi.waitFor(() => expect(handlers.onSignal).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    expect(handlers.onSignal).toHaveBeenCalledTimes(1)
    transport.close()
  })

  it("never delivers an offer of a generation it already delivered, once we have offered ourselves", async () => {
    // The peer's heartbeat re-announces its offer every HEARTBEAT_MS. Our own
    // recovery offer clears the receive-side dedup for that peer, so the old
    // offer used to reach the mesh again and take the generation back: the
    // mesh answered it under the OLD gen, that answer overwrote our offer in
    // the store, and the peer's answer to our offer failed the gate.
    const fake = fakeStore()
    const { transport, handlers } = await openTransport(fake)
    const theirOffer = { t: "d", from: "peer", name: "Peer", gen: "G1", desc: { type: "offer", sdp: "o1" } }
    fake.push(theirOffer)
    await vi.waitFor(() => expect(handlers.onSignal).toHaveBeenCalledTimes(1))
    transport.send("peer", { rtc: { desc: { type: "answer", sdp: "a1" } } })
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } }) // our recovery offer
    const ours = await waitForFrame(fake, (f) => f.t === "d" && (f.desc as { type?: string } | undefined)?.type === "offer")
    fake.push(theirOffer) // their heartbeat re-announces the old offer
    await new Promise((r) => setTimeout(r, 50))
    expect(handlers.onSignal).toHaveBeenCalledTimes(1)
    // their answer to OUR offer still passes the gate
    fake.push({ t: "d", from: "peer", name: "Peer", gen: ours.gen, desc: { type: "answer", sdp: "a2" } })
    await vi.waitFor(() => expect(handlers.onSignal).toHaveBeenCalledTimes(2))
    expect(handlers.onSignal).toHaveBeenLastCalledWith("peer", { rtc: { desc: { type: "answer", sdp: "a2" } } })
    transport.close()
  })

  it("carries our view of the room on the hello, and hands a peer's to onView", async () => {
    const fake = fakeStore()
    const onView = vi.fn<(from: string, view: string) => void>()
    const handlers = { ...handlersWithSpies(), onView }
    const transport = statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {} })({ base: "", room: "room1", id: "me", name: "Me", handlers })
    transport.setView?.("ab12:-3") // before the first heartbeat: its hello carries it
    await vi.waitFor(() => {
      if (!fake.subscribed()) throw new Error("not subscribed yet")
    })
    fake.push({ t: "hello", from: "peer", name: "Peer", view: "ab12:3-" })
    await vi.waitFor(() => expect(onView).toHaveBeenCalledWith("peer", "ab12:3-"))
    fake.push({ t: "hello", from: "peer2", name: "Peer2" }) // an older client: no view
    await new Promise((r) => setTimeout(r, 50))
    expect(onView).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      const hellos = fake.submitted.map(decodeFrame).filter((f) => f.t === "hello")
      if (!hellos.some((f) => f.view === "ab12:-3")) throw new Error("no hello with the view yet")
    })
    transport.close()
  })

  it("hello/bye drive the roster; own frames are ignored", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await openTransport(fake)
    // open() already announced the room list optimistically ("room1", seen=false)
    fake.push({ t: "hello", from: "peer", name: "Peer" })
    await vi.waitFor(() =>
      expect(handlers.onPeerJoined).toHaveBeenCalledWith("peer", "Peer", true),
    )
    const joinsAfterHello = handlers.onPeerJoined.mock.calls.length
    fake.push({ t: "hello", from: "me", name: "Me" }) // own heartbeat read back
    fake.push({ t: "bye", from: "peer" })
    await vi.waitFor(() => expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer"))
    // own hello never re-enters the roster
    expect(handlers.onPeerJoined).toHaveBeenCalledTimes(joinsAfterHello)
    transport.close()
  })

  it("caps concurrent submits at 2 (backpressure semaphore)", async () => {
    const fake = fakeStore({ hangSubmits: true })
    const { transport } = await openTransport(fake)
    // 4 outbound descs to distinct peers, all racing for submit slots
    for (const to of ["p1", "p2", "p3", "p4"])
      transport.send(to, { rtc: { desc: { type: "offer", sdp: `o-${to}` } } })
    await vi.waitFor(() => {
      // ≥2 submits started (one may be the heartbeat hello), but never >2 at once
      if (fake.submitted.length < 2) throw new Error("submits pending")
    })
    expect(transport.stats!().inflight).toBeLessThanOrEqual(2)
    const before = fake.submitted.length
    await new Promise((r) => setTimeout(r, 100))
    expect(fake.submitted.length).toBe(before) // queued behind the semaphore, not submitted
    fake.releaseHung()
    await vi.waitFor(() => {
      if (fake.submitted.length < 4) throw new Error("queued submits pending")
      fake.releaseHung()
    })
    transport.close()
    fake.releaseHung()
  })
})
