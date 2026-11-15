// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * F4: a PEER_TTL
 * forget must not strand a live negotiation.
 *
 * forgetPeer used to delete `out` as well. The mesh ignores onPeerLeft
 * (useMesh.ts), so its PC kept waiting on the offer it sent, while the
 * answer gate (`f.gen !== out.get(f.from)?.gen`) dropped every answer to
 * that offer and the heartbeat stopped re-announcing it. The link stayed
 * down until the round ended.
 *
 * The fix keeps ALL the negotiation state on forget (out, genOf, seenDesc,
 * seenCands, pendingCand), mirroring the mesh, which keeps its PC. Keeping
 * only `out` is not enough: genOf also labels our answer (send()), and the
 * model check found a lasso where a forget between the peer's offer and our
 * answer sent that answer under a stale gen, gated away for good.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
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

async function open(fake: ReturnType<typeof fakeStore>, id = "me") {
  const handlers = spies()
  const transport: SignalTransport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
  })({ base: "", room: "room1", id, name: id, handlers })
  await until(fake.subscribed, "the transport to subscribe")
  return { transport, handlers }
}

const descsDelivered = (h: ReturnType<typeof spies>) =>
  h.onSignal.mock.calls
    .map(([, d]) => (d as { rtc: { desc?: { sdp?: string } } }).rtc.desc?.sdp)
    .filter((s): s is string => !!s)

afterEach(() => {
  vi.useRealTimers()
})

describe("statementTransport — F4: a PEER_TTL forget keeps the live negotiation", () => {
  it("F4: the answer to our live offer still lands after a PEER_TTL forget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push({ t: "hello", from: "peer", name: "Peer" })
    await until(() => handlers.onPeerJoined.mock.calls.length > 0, "the peer to join")
    // the mesh (re)offers to the peer, which then goes quiet (backgrounded)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "our offer to be submitted")
    const gen = fake.frames().find((f) => f.t === "d")!.gen as string
    for (let beat = 0; beat < 7; beat++) {
      await settle() // pacing: let the digests behind each heartbeat finish before the clock moves
      await vi.advanceTimersByTimeAsync(8_000)
    }
    await until(() => handlers.onPeerLeft.mock.calls.length > 0, "the TTL forget to fire")
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer") // the TTL fired

    // the heartbeat keeps re-announcing our offer after the forget, so a
    // peer that comes back after the store slot expired can still read it
    const ours = () => fake.frames().filter((f) => f.t === "d" && f.gen === gen).length
    const before = ours()
    await vi.advanceTimersByTimeAsync(8_000)
    // the re-announce is submitted after real async work (sha256): wait for it, do not count on a fixed settle (#372)
    await until(() => ours() > before, "the heartbeat to re-announce our offer")
    expect(ours()).toBeGreaterThan(before)

    // the peer comes back and answers OUR offer, with OUR gen
    fake.push({ t: "hello", from: "peer", name: "Peer" })
    fake.push({ t: "d", from: "peer", name: "Peer", gen, desc: { type: "answer", sdp: "a2" } })
    await until(() => descsDelivered(handlers).includes("a2"), "the answer to be delivered")
    expect(descsDelivered(handlers)).toContain("a2")
    transport.close()
  })

  // The keep-out-only lasso. Realism: every
  // directed frame refreshes lastBeat, so in production this needs more
  // than PEER_TTL_MS between the peer's offer and our answer. The model
  // had no clock; keeping genOf costs nothing and closes it anyway.
  it("an answer sent after a forget carries the gen of the offer it answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push({ t: "d", from: "peer", name: "Peer", gen: "G", desc: { type: "offer", sdp: "o1" } })
    await until(() => descsDelivered(handlers).length > 0, "the offer to be delivered")
    await settle() // absence: a duplicate delivery must not follow, so there is nothing to wait for
    expect(descsDelivered(handlers)).toEqual(["o1"])
    for (let beat = 0; beat < 7; beat++) {
      await settle() // pacing: let the digests behind each heartbeat finish before the clock moves
      await vi.advanceTimersByTimeAsync(8_000)
    }
    await until(() => handlers.onPeerLeft.mock.calls.length > 0, "the TTL forget to fire")
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer") // the TTL fired
    transport.send("peer", { rtc: { desc: { type: "answer", sdp: "a1" } } })
    await until(
      () => fake.frames().some((f) => (f.desc as { type?: string } | undefined)?.type === "answer"),
      "our answer to be submitted",
    )
    const ans = fake.frames().find((f) => (f.desc as { type?: string } | undefined)?.type === "answer")!
    expect(ans.gen).toBe("G")
    transport.close()
  })

  // Why the receive-side dedup is kept as well: the mesh's PC survives the
  // forget, so a re-announce of a desc it already applied must stay deduped
  // (a second answer in `stable` is the setRemoteDescription error that
  // generation gating exists to prevent).
  it("a forget does not re-deliver a desc the mesh already applied", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "our offer to be submitted")
    const gen = fake.frames().find((f) => f.t === "d")!.gen as string
    const answer = { t: "d", from: "peer", name: "Peer", gen, desc: { type: "answer", sdp: "a1" } }
    fake.push(answer)
    await until(() => descsDelivered(handlers).length > 0, "the answer to be delivered")
    await settle() // absence: a duplicate delivery must not follow, so there is nothing to wait for
    expect(descsDelivered(handlers)).toEqual(["a1"])
    for (let beat = 0; beat < 7; beat++) {
      await settle() // pacing: let the digests behind each heartbeat finish before the clock moves
      await vi.advanceTimersByTimeAsync(8_000)
    }
    await until(() => handlers.onPeerLeft.mock.calls.length > 0, "the TTL forget to fire")
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer") // the TTL fired
    fake.push({ t: "hello", from: "peer", name: "Peer" })
    fake.push(answer) // the peer's heartbeat re-announces its answer
    await settle() // absence: the re-announce must NOT be delivered, so there is nothing to wait for
    expect(descsDelivered(handlers)).toEqual(["a1"])
    transport.close()
  })

  // A bye is an explicit, final leave (the peer's transport closed): it
  // reclaims the negotiation state, so we stop spending statement
  // allowance re-announcing our desc to a peer that is gone. Only the
  // PEER_TTL forget, which may be a backgrounded phone, keeps it.
  it("a bye reclaims out: no re-announce to that peer afterwards", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "our offer to be submitted")
    const gen = fake.frames().find((f) => f.t === "d")!.gen as string
    const ours = () => fake.frames().filter((f) => f.t === "d" && f.gen === gen).length
    fake.push({ t: "bye", from: "peer" })
    await until(() => handlers.onPeerLeft.mock.calls.length > 0, "the bye to be handled")
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer")
    const before = ours()
    for (let beat = 0; beat < 3; beat++) {
      await vi.advanceTimersByTimeAsync(8_000)
      await settle() // absence: no re-announce may follow, so there is nothing to wait for
    }
    expect(ours()).toBe(before)
    transport.close()
  })

  it("a TTL forget keeps out: our offer is still re-announced", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push({ t: "hello", from: "peer", name: "Peer" })
    await until(() => handlers.onPeerJoined.mock.calls.length > 0, "the peer to join")
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "our offer to be submitted")
    const gen = fake.frames().find((f) => f.t === "d")!.gen as string
    const ours = () => fake.frames().filter((f) => f.t === "d" && f.gen === gen).length
    // Each heartbeat re-announces our offer once. Its submit lands after real async work (sha256), so wait for
    // every beat's re-announce before the next beat: one still in flight would either be counted in the wrong
    // window or have the next beat's identical frame coalesced into it (#372).
    const beat = async () => {
      const was = ours()
      await vi.advanceTimersByTimeAsync(8_000)
      await until(() => ours() > was, "the heartbeat to re-announce our offer")
      await settle()
    }
    for (let i = 0; i < 7; i++) await beat()
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer") // the TTL fired
    const before = ours()
    for (let i = 0; i < 3; i++) await beat()
    expect(ours()).toBe(before + 3)
    transport.close()
  })
})
