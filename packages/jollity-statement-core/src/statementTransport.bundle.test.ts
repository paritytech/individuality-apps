// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { sha256 } from "./statementCommon"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers } from "./transport"

const enc = new TextEncoder()
const dec = new TextDecoder()

type AnyFrame = Record<string, unknown>

/** In-memory StatementStoreLike: records submits, lets tests push inbound pages. */
function fakeStore() {
  const submitted: Array<WireStatement & { proof: unknown }> = []
  let onPage: ((page: { statements: Array<{ data?: string }> }) => void) | null = null
  const store: StatementStoreLike = {
    createProofAuthorized: async () => "fake-proof",
    submit: async (wire) => {
      submitted.push(wire)
    },
    subscribe: (_filter, cb) => {
      onPage = cb
      return { unsubscribe: vi.fn() }
    },
  }
  return {
    store,
    submitted,
    push: (...frames: AnyFrame[]) => onPage?.({ statements: frames.map((f) => ({ data: toHex(enc.encode(JSON.stringify(f))) })) }),
    subscribed: () => onPage !== null,
  }
}

const decode = (wire: WireStatement): AnyFrame => JSON.parse(dec.decode(fromHex(wire.data))) as AnyFrame

function handlersWithSpies() {
  const onPeerJoined = vi.fn<(id: string, name: string, seen?: boolean) => void>()
  const onPeerLeft = vi.fn<(id: string) => void>()
  const onSignal = vi.fn<(from: string, data: unknown) => void>()
  return { onPeerJoined, onPeerLeft, onSignal } satisfies SignalHandlers
}

async function open(fake: ReturnType<typeof fakeStore>, id = "me") {
  const handlers = handlersWithSpies()
  const transport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
    bundle: true,
  })({ base: "", room: "g7", id, name: id, handlers })
  await vi.waitFor(() => {
    if (!fake.subscribed()) throw new Error("not subscribed yet")
  })
  return { transport, handlers }
}

/** the newest bundle this side published */
async function latestBundle(fake: ReturnType<typeof fakeStore>, pred: (b: AnyFrame) => boolean = () => true) {
  let found: { wire: WireStatement; bundle: AnyFrame } | undefined
  await vi.waitFor(() => {
    const all = fake.submitted.map((wire) => ({ wire, bundle: decode(wire) })).filter((x) => x.bundle.t === "b")
    found = [...all].reverse().find((x) => pred(x.bundle))
    if (!found) throw new Error("no bundle yet")
  })
  return found!
}

const framesOf = (bundle: AnyFrame) => bundle.f as Record<string, AnyFrame>

describe("statementTransport, one statement per phone (bundle)", () => {
  it("puts the hello and the offers to every peer in one statement on this phone's channel", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake)

    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "o-p1" } } })
    transport.send("p2", { rtc: { desc: { type: "offer", sdp: "o-p2" } } })

    const { wire, bundle } = await latestBundle(fake, (b) => !!framesOf(b)["d:p1"] && !!framesOf(b)["d:p2"])
    expect(framesOf(bundle).p).toMatchObject({ t: "hello", from: "me" })
    expect(framesOf(bundle)["d:p1"]).toMatchObject({ t: "d", from: "me", desc: { type: "offer", sdp: "o-p1" } })
    expect(framesOf(bundle)["d:p2"]).toMatchObject({ t: "d", from: "me", desc: { type: "offer", sdp: "o-p2" } })
    // every statement of ours is on one channel, under the room topic
    const channels = new Set(fake.submitted.map((w) => w.channel))
    expect(channels.size).toBe(1)
    expect(wire.channel).toBe(toHex(await sha256("test.ns|rtc:g7:bundle:me")))
    expect(wire.topics).toEqual([toHex(await sha256("test.ns|rtc:g7:"))])
    transport.close()
  })

  it("takes the hello and only the frames addressed to it, through the generation gate", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)

    fake.push({
      t: "b",
      from: "p1",
      f: {
        p: { t: "hello", from: "p1", name: "P1" },
        "d:me": { t: "d", from: "p1", name: "P1", gen: "g1", desc: { type: "offer", sdp: "o-for-me" } },
        "d:p2": { t: "d", from: "p1", name: "P1", gen: "g2", desc: { type: "offer", sdp: "o-for-p2" } },
      },
    })
    await vi.waitFor(() => expect(handlers.onSignal).toHaveBeenCalledTimes(1))
    expect(handlers.onPeerJoined).toHaveBeenCalledWith("p1", "P1", true)
    expect(handlers.onSignal).toHaveBeenCalledWith("p1", { rtc: { desc: { type: "offer", sdp: "o-for-me" }, gen: "g1" } })

    // the same bundle read again (a keepalive, a re-read page) delivers nothing twice
    fake.push({
      t: "b",
      from: "p1",
      f: {
        p: { t: "hello", from: "p1", name: "P1" },
        "d:me": { t: "d", from: "p1", name: "P1", gen: "g1", desc: { type: "offer", sdp: "o-for-me" } },
      },
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(handlers.onSignal).toHaveBeenCalledTimes(1)
    transport.close()
  })

  it("answers ride the same statement, labelled with the offer they answer", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake)

    transport.send("p0", { rtc: { desc: { type: "answer", sdp: "a-p0" }, gen: "s0.1" } })
    transport.send("p9", { rtc: { desc: { type: "offer", sdp: "o-p9" } } })

    const { bundle } = await latestBundle(fake, (b) => !!framesOf(b)["d:p0"] && !!framesOf(b)["d:p9"])
    expect(framesOf(bundle)["d:p0"]).toMatchObject({ gen: "s0.1", desc: { type: "answer" } })
    expect(framesOf(bundle)["d:p9"]).toMatchObject({ desc: { type: "offer" } })
    transport.close()
  })

  it("a peer that said bye leaves our bundle, and our own leave goes out alone", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake)

    transport.send("p1", { rtc: { desc: { type: "offer", sdp: "o-p1" } } })
    await latestBundle(fake, (b) => !!framesOf(b)["d:p1"])
    fake.push({ t: "b", from: "p1", f: { p: { t: "bye", from: "p1" } } })
    transport.send("p2", { rtc: { desc: { type: "offer", sdp: "o-p2" } } })
    const { bundle } = await latestBundle(fake, (b) => !!framesOf(b)["d:p2"])
    expect(framesOf(bundle)["d:p1"]).toBeUndefined()

    transport.close()
    const last = await latestBundle(fake, (b) => (framesOf(b).p as AnyFrame | undefined)?.t === "bye")
    expect(Object.keys(framesOf(last.bundle))).toEqual(["p"])
  })
})
