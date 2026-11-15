// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi, type Mock } from "vitest"
import { statementTransport } from "./statementTransport"
import { sha256 } from "./statementCommon"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers } from "./transport"

// Rule 8 (#1959): a caller that names the room's other members gets a roster
// wire. Its presence goes under its own topic, and it subscribes to its
// members' topics alone, so a phone receives its co-players' bundles and
// nobody else's.

const enc = new TextEncoder()
const dec = new TextDecoder()
const NS = "test.ns"
const ROOM = "g7"
const topic = async (what: string) => toHex(await sha256(`${NS}|rtc:${ROOM}:${what}`))

type AnyFrame = Record<string, unknown>
type Sub = { filter: { matchAny: string[] }; cb: (page: { statements: Array<{ data?: string }> }) => void; unsubscribe: Mock<() => void>; live: boolean }

/** In-memory store: records submits and every subscription, pushes pages to the live ones. */
function fakeStore() {
  const submitted: WireStatement[] = []
  const subs: Sub[] = []
  const store: StatementStoreLike = {
    createProofAuthorized: async () => "fake-proof",
    submit: async (wire) => {
      submitted.push(wire)
    },
    subscribe: (filter, cb) => {
      const sub: Sub = {
        filter,
        cb,
        unsubscribe: vi.fn<() => void>(() => {
          sub.live = false
        }),
        live: true,
      }
      subs.push(sub)
      return { unsubscribe: sub.unsubscribe }
    },
  }
  return {
    store,
    submitted,
    subs,
    live: () => subs.filter((s) => s.live),
    push: (...frames: AnyFrame[]) => {
      const page = { statements: frames.map((f) => ({ data: toHex(enc.encode(JSON.stringify(f))) })) }
      for (const s of subs.filter((x) => x.live)) s.cb(page)
    },
  }
}

const decode = (wire: WireStatement): AnyFrame => JSON.parse(dec.decode(fromHex(wire.data))) as AnyFrame

function handlersWithSpies() {
  return {
    onPeerJoined: vi.fn<(id: string, name: string, seen?: boolean) => void>(),
    onPeerLeft: vi.fn<(id: string) => void>(),
    onSignal: vi.fn<(from: string, data: unknown) => void>(),
    onOpen: vi.fn<() => void>(),
  } satisfies SignalHandlers
}

async function open(fake: ReturnType<typeof fakeStore>, opts: { peers?: string[]; bundle?: boolean } = {}) {
  const handlers = handlersWithSpies()
  const transport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: NS,
    log: () => {},
    bundle: opts.bundle ?? true,
  })({ base: "", room: ROOM, id: "me", name: "me", handlers, peers: opts.peers })
  await vi.waitFor(() => {
    if (handlers.onOpen.mock.calls.length === 0) throw new Error("not open yet")
  })
  return { transport, handlers }
}

const hello = (from: string) => ({ t: "b", from, sid: "1-a", f: { p: { t: "hello", from, sid: "1-a", name: from } } })

describe("statementTransport, listening to the roster (rule 8, #1959)", () => {
  it("subscribes to its members' own topics alone, with no room topic and no inbox", async () => {
    const fake = fakeStore()
    await open(fake, { peers: ["p2", "p1", "me", "p1"] })

    expect(fake.subs).toHaveLength(1)
    expect(fake.subs[0]!.filter.matchAny).toEqual([await topic("from:p1"), await topic("from:p2")])
  })

  it("posts its bundle under its own topic, one topic a statement", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake, { peers: ["p1", "p2"] })
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "o-p1" } } })

    await vi.waitFor(() => {
      if (!fake.submitted.some((w) => (decode(w).f as AnyFrame)?.["d:p1"])) throw new Error("no bundle with the offer yet")
    })
    const mine = await topic("from:me")
    for (const wire of fake.submitted) expect(wire.topics).toEqual([mine])
  })

  it("says its bye under its own topic", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake, { peers: ["p1"] })
    transport.close()

    await vi.waitFor(() => {
      if (!fake.submitted.some((w) => (decode(w).f as AnyFrame)?.p && ((decode(w).f as AnyFrame).p as AnyFrame).t === "bye"))
        throw new Error("no bye yet")
    })
    const mine = await topic("from:me")
    for (const wire of fake.submitted) expect(wire.topics).toEqual([mine])
  })

  it("keeps the inbox when directed frames travel on their own (no bundle)", async () => {
    const fake = fakeStore()
    await open(fake, { peers: ["p1"], bundle: false })

    expect(fake.subs[0]!.filter.matchAny).toEqual([await topic("inbox:me"), await topic("from:p1")])
  })

  it("drops a frame from outside the roster, whatever topic it came under", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake, { peers: ["p1"] })

    fake.push(hello("stranger"), hello("p1"))

    await vi.waitFor(() => expect(handlers.onPeerJoined).toHaveBeenCalledWith("p1", "p1", true))
    expect(handlers.onPeerJoined).not.toHaveBeenCalledWith("stranger", expect.anything(), true)
  })

  it("subscribes again for a member added later, and lets the old subscription go once the new one is up", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake, { peers: ["p1"] })

    transport.setPeers!(["p1", "p3"])

    await vi.waitFor(() => expect(fake.subs).toHaveLength(2))
    expect(fake.subs[1]!.filter.matchAny).toEqual([await topic("from:p1"), await topic("from:p3")])
    expect(fake.subs[0]!.unsubscribe).toHaveBeenCalled()
    expect(fake.live()).toEqual([fake.subs[1]])

    fake.push(hello("p3"))
    await vi.waitFor(() => expect(handlers.onPeerJoined).toHaveBeenCalledWith("p3", "p3", true))
  })

  it("only grows: a roster named smaller, or empty for a render, keeps hearing everyone it named", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake, { peers: ["p1", "p2"] })

    transport.setPeers!([])
    transport.setPeers!(["p1"])
    fake.push(hello("p2"))

    await vi.waitFor(() => expect(handlers.onPeerJoined).toHaveBeenCalledWith("p2", "p2", true))
    expect(fake.subs).toHaveLength(1)
  })

  it("sends no filter at all for an empty roster (a store may read an empty one as everything)", async () => {
    const fake = fakeStore()
    await open(fake, { peers: [] })

    expect(fake.subs).toHaveLength(0)
  })

  it("without a roster, stays on the room topic: presence there, and the inbox and the room subscribed", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake)
    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "o-p1" } } })

    expect(fake.subs[0]!.filter.matchAny).toEqual([await topic("inbox:me"), await topic("")])
    await vi.waitFor(() => {
      if (fake.submitted.length === 0) throw new Error("nothing sent yet")
    })
    for (const wire of fake.submitted) expect(wire.topics).toEqual([await topic("")])
  })
})
