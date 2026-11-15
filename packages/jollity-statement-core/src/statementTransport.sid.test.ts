// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Sessions on the signalling wire (#214, D with C): every frame carries `sid`,
 * minted once per page boot and prefixed with the boot's wall time so two sids
 * order, and an offer's gen is `<sid>.<counter>`.
 *
 * What it fixes:
 *  - the RELOAD REPLAY: a reloaded peer's old hello, offer and bye stay in the
 *    store for up to 30 s, and the bye cleared `offeredGens`, so the old offer
 *    was new again (F1 R3). A frame whose sid is older than the peer's current
 *    one is now dropped, the bye included;
 *  - F1 R1/R2: within one sid, an offer whose counter is below the last one
 *    adopted is dropped, however it got there (a reordered first copy, or more
 *    than 16 later offers);
 *  - #223's SDP sniffing as the reload signal: the transport raises
 *    `onPeerSession(peer, sid)` when a peer's sid changes, and the mesh
 *    rebuilds on it.
 * A frame without a sid keeps the old behaviour.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers, SignalTransport } from "./transport"

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

async function open(fake: ReturnType<typeof fakeStore>, id = "me", factory = statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {} })) {
  const handlers = {
    onPeerSession: vi.fn<(id: string, sid: string) => void>(),
    onPeerJoined: vi.fn<(id: string, name: string, seen?: boolean) => void>(),
    onPeerLeft: vi.fn<(id: string) => void>(),
    onSignal: vi.fn<(from: string, data: unknown) => void>(),
  } satisfies SignalHandlers
  const transport: SignalTransport = factory({ base: "", room: "room1", id, name: id, handlers })
  await until(fake.subscribed, "the transport to subscribe")
  return { transport, handlers }
}

const SID_A = "1800000000000-aaaa"
const SID_B = "1800000005000-bbbb" // the same peer after a reload: a later boot
const SID_C = "1800000009000-cccc"
const hello = (sid?: string) => ({ t: "hello", from: "peer", name: "Peer", ...(sid ? { sid } : {}) })
const bye = (sid?: string) => ({ t: "bye", from: "peer", ...(sid ? { sid } : {}) })
const offer = (sid: string | undefined, gen: string, sdp: string) => ({ t: "d", from: "peer", name: "Peer", gen, desc: { type: "offer", sdp }, ...(sid ? { sid } : {}) })
const answer = (sid: string | undefined, gen: string, sdp: string) => ({ t: "d", from: "peer", name: "Peer", gen, desc: { type: "answer", sdp }, ...(sid ? { sid } : {}) })
const delivered = (h: Awaited<ReturnType<typeof open>>["handlers"]) =>
  h.onSignal.mock.calls.map(([, d]) => (d as { rtc: { desc?: { sdp?: string } } }).rtc.desc?.sdp).filter((s): s is string => !!s)

afterEach(() => {
  vi.useRealTimers()
})

describe("statementTransport — sessions: every frame carries the boot's sid", () => {
  it("stamps hello, desc, cand and bye with one sid, and numbers its offers under it", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    transport.send("peer", { rtc: { cand: { candidate: "candidate:1 1 udp 1 1.1.1.1 1 typ host" } } })
    await until(() => fake.frames().some((f) => f.t === "c"), "the candidates") // after the 700 ms debounce
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } })
    await until(() => fake.frames().filter((f) => f.t === "d").length === 2 && fake.frames().some((f) => f.t === "hello"), "the frames")
    transport.close()
    await until(() => fake.frames().some((f) => f.t === "bye"), "the bye")
    const frames = fake.frames()
    const sid = frames[0]!.sid as string
    expect(sid).toMatch(/^\d+-[0-9a-z]+$/)
    expect(new Set(frames.map((f) => f.sid))).toEqual(new Set([sid]))
    const gens = frames.filter((f) => f.t === "d").map((f) => f.gen)
    expect(gens).toEqual([`${sid}.1`, `${sid}.2`])
  })

  it("keeps one sid for the page across rooms, and a later boot sorts after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(1_800_000_000_000)
    const fake = fakeStore()
    const factory = statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {} })
    const one = await open(fake, "me", factory)
    one.transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    const two = factory({ base: "", room: "room2", id: "me", name: "me", handlers: { onPeerJoined: () => {}, onPeerLeft: () => {}, onSignal: () => {} } })
    two.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } })
    await until(() => fake.frames().filter((f) => f.t === "d").length === 2, "both offers")
    const [a, b] = fake.frames().filter((f) => f.t === "d")
    expect(a!.sid).toBe(b!.sid)
    vi.setSystemTime(1_800_000_005_000) // the page reloads
    const fake2 = fakeStore()
    const reloaded = await open(fake2, "me", statementTransport({ resolveStore: async () => fake2.store, namespace: "test.ns", log: () => {} }))
    reloaded.transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o3" } } })
    await until(() => fake2.frames().some((f) => f.t === "d"), "the reloaded offer")
    const later = fake2.frames().find((f) => f.t === "d")!.sid as string
    expect(Number(later.split("-")[0])).toBeGreaterThan(Number((a!.sid as string).split("-")[0]))
  })
})

describe("statementTransport — sessions: a reloaded peer's old boot is dropped", () => {
  it("drops the old boot's offer when it is read again after the bye and the new hello (the reload replay, F1 R3)", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    fake.push(hello(SID_A), offer(SID_A, `${SID_A}.1`, "old"))
    await settle()
    fake.push(bye(SID_A), hello(SID_B))
    await settle()
    fake.push(offer(SID_A, `${SID_A}.1`, "old")) // still in the store for up to 30 s
    await settle()
    expect(delivered(handlers)).toEqual(["old"]) // once, before the reload, and never again
  })

  it("drops the old boot's offer read again after its bye, before the new boot is heard (the reload window)", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    fake.push(hello(SID_A), offer(SID_A, `${SID_A}.1`, "old"))
    await settle()
    fake.push(bye(SID_A))
    await settle()
    fake.push(offer(SID_A, `${SID_A}.1`, "old")) // a resubscribe re-reads it while the peer is still loading
    await settle()
    expect(delivered(handlers)).toEqual(["old"])
    // the same page reopening the room offers under the next counter, and that is live
    fake.push(offer(SID_A, `${SID_A}.2`, "reopened"))
    await settle()
    expect(delivered(handlers)).toEqual(["old", "reopened"])
  })

  it("drops every frame of an older boot once a newer one is heard, the bye included", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    fake.push(hello(SID_B))
    await settle()
    handlers.onPeerJoined.mockClear()
    fake.push(hello(SID_A), offer(SID_A, `${SID_A}.4`, "old"), bye(SID_A))
    await settle()
    expect(handlers.onPeerJoined).not.toHaveBeenCalled()
    expect(handlers.onSignal).not.toHaveBeenCalled()
    expect(handlers.onPeerLeft).not.toHaveBeenCalled() // the old boot's bye does not tear the new one down
    fake.push(offer(SID_B, `${SID_B}.1`, "new"))
    await settle()
    expect(delivered(handlers)).toEqual(["new"])
  })

  it("raises onPeerSession once per change, on a hello, never on first sight, and before the new session's frames are delivered", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    const order: string[] = []
    handlers.onPeerSession.mockImplementation((_peer, sid) => void order.push(`session ${sid}`))
    handlers.onSignal.mockImplementation((_peer, d) => void order.push(`signal ${(d as { rtc: { desc?: { sdp?: string } } }).rtc.desc?.sdp}`))
    fake.push(hello(SID_A), offer(SID_A, `${SID_A}.1`, "a1"), hello(SID_A))
    await settle()
    // only a hello switches: the new boot's offer that came first waits for its re-announce
    fake.push(offer(SID_B, `${SID_B}.1`, "b1"), hello(SID_B), offer(SID_B, `${SID_B}.1`, "b1"), hello(SID_B))
    await settle()
    fake.push(hello(SID_A)) // the old boot's heartbeat, late
    await settle()
    fake.push(hello(SID_C))
    await settle()
    expect(handlers.onPeerSession.mock.calls).toEqual([
      ["peer", SID_B],
      ["peer", SID_C],
    ])
    expect(order).toEqual(["signal a1", `session ${SID_B}`, "signal b1", `session ${SID_C}`])
  })

  it("forgets our negotiation with the old boot: its new boot's answer to our old offer is not taken", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push(hello(SID_A))
    await settle()
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "ours" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "our offer")
    const gen = fake.frames().find((f) => f.t === "d")!.gen as string
    // the reloaded peer read our offer off the store and answered it from its fresh connection
    fake.push(hello(SID_B), answer(SID_B, gen, "theirs"))
    await settle()
    expect(handlers.onPeerSession).toHaveBeenCalledWith("peer", SID_B)
    expect(delivered(handlers)).toEqual([]) // the mesh rebuilt on the session event and offers anew
  })
})

describe("statementTransport — sessions: offers order by their counter within a boot (F1 R1/R2)", () => {
  it("drops an older offer whose first copy arrives after a newer one (R1)", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    fake.push(hello(SID_A), offer(SID_A, `${SID_A}.3`, "third"))
    await settle()
    fake.push(offer(SID_A, `${SID_A}.2`, "second"))
    await settle()
    expect(delivered(handlers)).toEqual(["third"])
  })

  it("drops an old offer after more than 16 newer ones (R2)", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    for (let n = 1; n <= 20; n++) fake.push(offer(SID_A, `${SID_A}.${n}`, `o${n}`))
    await settle(60)
    fake.push(offer(SID_A, `${SID_A}.1`, "o1"))
    await settle()
    expect(delivered(handlers)).toHaveLength(20)
  })

  it("still delivers a re-announce of the current offer's candidates and keeps it delivered once", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    fake.push({ t: "c", from: "peer", sid: SID_A, gen: `${SID_A}.2`, cands: [{ candidate: "c1" }] })
    await settle()
    fake.push(offer(SID_A, `${SID_A}.2`, "two"), offer(SID_A, `${SID_A}.2`, "two"))
    await settle()
    expect(delivered(handlers)).toEqual(["two"])
    expect(handlers.onSignal.mock.calls.filter(([, d]) => (d as { rtc: { cand?: unknown } }).rtc.cand)).toHaveLength(1)
  })
})

describe("statementTransport — sessions: a frame without a sid", () => {
  it("is taken as before, and raises no session event", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    fake.push(hello(SID_A), offer(SID_A, `${SID_A}.1`, "a1"))
    await settle()
    fake.push(hello(), offer(undefined, "uuid-gen", "plain"), { ...hello(), sid: 42 })
    await settle()
    expect(delivered(handlers)).toEqual(["a1", "plain"])
    expect(handlers.onPeerSession).not.toHaveBeenCalled()
    fake.push(bye())
    await settle()
    expect(handlers.onPeerLeft).toHaveBeenCalledWith("peer")
  })
})

describe("statementTransport — sessions: a wrong clock never locks a player out", () => {
  // boot A at T, then the phone's clock is corrected back an hour and the page
  // reloads as boot B: B's sid sorts OLDER than A's
  const T = 1_800_000_000_000
  const BOOT_A = `${T}-aaaa`
  const BOOT_B = `${T - 3_600_000}-bbbb`

  async function openAt(fake: ReturnType<typeof fakeStore>, clock: { ms: number }) {
    return open(fake, "me", statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {}, now: () => clock.ms }))
  }

  it("takes the reloaded boot at once when the old one said bye", async () => {
    const fake = fakeStore()
    const clock = { ms: 0 }
    const { handlers } = await openAt(fake, clock)
    fake.push(hello(BOOT_A), offer(BOOT_A, `${BOOT_A}.1`, "a1"))
    await settle()
    clock.ms += 1_000
    fake.push(bye(BOOT_A))
    await settle()
    clock.ms += 3_000
    fake.push(hello(BOOT_B), offer(BOOT_B, `${BOOT_B}.1`, "b1"))
    await settle()
    expect(handlers.onPeerSession.mock.calls).toEqual([["peer", BOOT_B]])
    expect(delivered(handlers)).toEqual(["a1", "b1"])
  })

  it("takes the reloaded boot once the old one has gone silent, when its bye never arrived", async () => {
    const fake = fakeStore()
    const clock = { ms: 0 }
    const { handlers } = await openAt(fake, clock)
    fake.push(hello(BOOT_A), offer(BOOT_A, `${BOOT_A}.1`, "a1"))
    await settle()
    // B is up 3 s later; while A was heard lately, B's frames could be a replay, and wait
    clock.ms += 3_000
    fake.push(hello(BOOT_B), offer(BOOT_B, `${BOOT_B}.1`, "b1"))
    await settle()
    expect(delivered(handlers)).toEqual(["a1"])
    // B keeps beating every 8 s; A says nothing more
    for (let beat = 0; beat < 3; beat++) {
      clock.ms += 8_000
      fake.push(hello(BOOT_B), offer(BOOT_B, `${BOOT_B}.1`, "b1"))
      await settle()
    }
    expect(handlers.onPeerSession.mock.calls).toEqual([["peer", BOOT_B]])
    expect(delivered(handlers)).toEqual(["a1", "b1"])
    // and the old boot, read again off the store, does not take it back
    fake.push(hello(BOOT_A), offer(BOOT_A, `${BOOT_A}.1`, "a1"))
    await settle()
    expect(handlers.onPeerSession).toHaveBeenCalledTimes(1)
    expect(delivered(handlers)).toEqual(["a1", "b1"])
  })

  it("stamps its own sid from the session clock it is given, not the wall clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(T - 3_600_000) // the wall clock an hour behind
    const fake = fakeStore()
    const { transport } = await open(fake, "me", statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {}, sessionNow: () => T }))
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "the offer")
    expect((fake.frames().find((f) => f.t === "d")!.sid as string).startsWith(`${T}-`)).toBe(true)
  })
})

describe("statementTransport — sessions: only a hello switches, and only a hello is liveness", () => {
  const T = 1_800_000_000_000
  const BOOT_A = `${T}-aaaa`
  const BOOT_B = `${T + 5_000}-bbbb`
  const WRONG = `${T - 3_600_000}-cccc` // a reload with its clock corrected back an hour

  async function openAt(fake: ReturnType<typeof fakeStore>, clock: { ms: number }) {
    return open(fake, "me", statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {}, now: () => clock.ms }))
  }

  it("does not let a superseded boot's desc or cand take the peer back after the live boot's bye", async () => {
    const fake = fakeStore()
    const clock = { ms: 0 }
    const { handlers } = await openAt(fake, clock)
    fake.push(hello(BOOT_A), hello(BOOT_B), offer(BOOT_B, `${BOOT_B}.1`, "b1"))
    await settle()
    fake.push(bye(BOOT_B)) // the live boot leaves (or reloads again)
    await settle()
    clock.ms += 1_000
    // A's per-pair slots are still inside their TTL and come back on a resubscribe
    fake.push(offer(BOOT_A, `${BOOT_A}.3`, "a3"), { t: "c", from: "peer", sid: BOOT_A, gen: `${BOOT_A}.3`, cands: [{ candidate: "c1" }] })
    await settle()
    expect(handlers.onPeerSession.mock.calls).toEqual([["peer", BOOT_B]])
    expect(delivered(handlers)).toEqual(["b1"])
    expect(handlers.onSignal.mock.calls.filter(([, d]) => (d as { rtc: { cand?: unknown } }).rtc.cand)).toHaveLength(0)
  })

  it("does not count a re-read desc as the session being heard", async () => {
    const fake = fakeStore()
    const clock = { ms: 0 }
    const { handlers } = await openAt(fake, clock)
    fake.push(hello(BOOT_A), offer(BOOT_A, `${BOOT_A}.1`, "a1"))
    await settle()
    // A's page is gone (no bye); its offer is re-read off the store twice
    for (const at of [10_000, 18_000]) {
      clock.ms = at
      fake.push(offer(BOOT_A, `${BOOT_A}.1`, "a1"))
      await settle()
    }
    clock.ms = 21_000 // 21 s after A's last hello, though 3 s after its last re-read
    fake.push(hello(WRONG), offer(WRONG, `${WRONG}.1`, "w1"))
    await settle()
    expect(handlers.onPeerSession.mock.calls).toEqual([["peer", WRONG]])
    expect(delivered(handlers)).toEqual(["a1", "w1"])
  })

  it("stamps a valid sid when the session clock gives no number", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake, "me", statementTransport({ resolveStore: async () => fake.store, namespace: "test.ns", log: () => {}, sessionNow: () => Number.NaN }))
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => fake.frames().some((f) => f.t === "d"), "the offer")
    expect(fake.frames().find((f) => f.t === "d")!.sid).toMatch(/^\d+-[0-9a-z]+$/)
  })
})
