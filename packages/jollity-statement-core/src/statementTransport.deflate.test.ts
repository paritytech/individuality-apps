// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { statementTransport } from "./statementTransport"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers } from "./transport"

// `deflateBundles` (rule 7): a bundle that carries more than a hello goes out
// as a 0x01 byte and the deflate-raw of its JSON. A receiver reads either.

const enc = new TextEncoder()
const dec = new TextDecoder()
type AnyFrame = Record<string, unknown>

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer())
}
const deflated = async (frame: AnyFrame) => {
  const body = await pipe(enc.encode(JSON.stringify(frame)), new CompressionStream("deflate-raw"))
  return Uint8Array.from([0x01, ...body])
}

function fakeStore() {
  const submitted: WireStatement[] = []
  let onPage: ((page: { statements: Array<{ data?: string }> }) => void) | null = null
  const store: StatementStoreLike = {
    createProofAuthorized: async () => "fake-proof",
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
    submitted,
    pushBytes: (...data: Uint8Array[]) => onPage?.({ statements: data.map((d) => ({ data: toHex(d) })) }),
  }
}

/** a submitted statement's frame, whichever way it went */
async function read(wire: WireStatement): Promise<{ deflated: boolean; frame: AnyFrame }> {
  const bytes = fromHex(wire.data)
  if (bytes[0] !== 0x01) return { deflated: false, frame: JSON.parse(dec.decode(bytes)) as AnyFrame }
  const json = await pipe(bytes.subarray(1), new DecompressionStream("deflate-raw"))
  return { deflated: true, frame: JSON.parse(dec.decode(json)) as AnyFrame }
}

async function open(fake: ReturnType<typeof fakeStore>, deflateBundles = true) {
  const handlers = {
    onPeerJoined: vi.fn<(id: string, name: string, seen?: boolean) => void>(),
    onPeerLeft: vi.fn<(id: string) => void>(),
    onSignal: vi.fn<(from: string, data: unknown) => void>(),
    onOpen: vi.fn<() => void>(),
  } satisfies SignalHandlers
  const transport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
    bundle: true,
    deflateBundles,
  })({ base: "", room: "g7", id: "me", name: "me", handlers, peers: ["p1"] })
  await vi.waitFor(() => {
    if (handlers.onOpen.mock.calls.length === 0) throw new Error("not open yet")
  })
  return { transport, handlers }
}

const bigOffer = { type: "offer" as const, sdp: `v=0\r\n${"a=x-filler:0123456789abcdef\r\n".repeat(60)}` }

describe("statementTransport, deflated bundles", () => {
  it("sends a bundle with an offer deflated, and its JSON is the bundle", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake)
    transport.send("p1", { rtc: { desc: bigOffer } })

    let last: { deflated: boolean; frame: AnyFrame } | undefined
    await vi.waitFor(async () => {
      const all = await Promise.all(fake.submitted.map(read))
      last = all.reverse().find((x) => (x.frame.f as AnyFrame)?.["d:p1"])
      if (!last) throw new Error("no bundle with the offer yet")
    })
    expect(last!.deflated).toBe(true)
    expect((last!.frame.f as AnyFrame)["d:p1"]).toMatchObject({ t: "d", from: "me", desc: bigOffer })
    const wire = fake.submitted.find((w) => fromHex(w.data)[0] === 0x01)!
    expect(fromHex(wire.data).length).toBeLessThan(enc.encode(JSON.stringify(last!.frame)).length)
  })

  it("leaves a hello alone in plain JSON", async () => {
    const fake = fakeStore()
    await open(fake)

    await vi.waitFor(() => {
      if (fake.submitted.length === 0) throw new Error("no hello yet")
    })
    const first = await read(fake.submitted[0]!)
    expect(first.deflated).toBe(false)
    expect((first.frame.f as AnyFrame).p).toMatchObject({ t: "hello", from: "me" })
  })

  it("says its bye in plain JSON, and nothing still deflating goes out after it", async () => {
    const fake = fakeStore()
    const { transport } = await open(fake)
    transport.send("p1", { rtc: { desc: bigOffer } })
    await new Promise((r) => setTimeout(r, 100)) // the bundle with the offer is built
    transport.send("p1", { rtc: { desc: { ...bigOffer, sdp: `${bigOffer.sdp}a=x-more:1\r\n` } } })
    transport.close()

    let at = -1
    await vi.waitFor(async () => {
      const all = await Promise.all(fake.submitted.map(read))
      at = all.findIndex((x) => ((x.frame.f as AnyFrame)?.p as AnyFrame | undefined)?.t === "bye")
      if (at < 0) throw new Error("no bye yet")
    })
    expect(fromHex(fake.submitted[at]!.data)[0]).not.toBe(0x01)
    await new Promise((r) => setTimeout(r, 200)) // anything the chain still held
    expect(fake.submitted.length).toBe(at + 1)
  })

  it("reads a peer's deflated bundle, with deflating off on this side too", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake, false)

    fake.pushBytes(
      await deflated({
        t: "b",
        from: "p1",
        sid: "1-a",
        f: {
          p: { t: "hello", from: "p1", sid: "1-a", name: "p1" },
          "d:me": { t: "d", from: "p1", sid: "1-a", name: "p1", gen: "1-a.1", desc: bigOffer },
        },
      }),
    )

    await vi.waitFor(() => expect(handlers.onPeerJoined).toHaveBeenCalledWith("p1", "p1", true))
    await vi.waitFor(() => expect(handlers.onSignal).toHaveBeenCalledWith("p1", expect.objectContaining({ rtc: expect.objectContaining({ desc: bigOffer }) })))
  })

  it("drops a deflated bundle that inflates past its bound", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)

    // one page, read in order: the bomb first, then a plain hello
    fake.pushBytes(
      await deflated({ t: "b", from: "p1", sid: "1-a", f: { p: { t: "hello", from: "p1", sid: "1-a", name: "p1" } }, pad: " ".repeat(300 * 1024) }),
      enc.encode(JSON.stringify({ t: "b", from: "p1", sid: "1-b", f: { p: { t: "hello", from: "p1", sid: "1-b", name: "p1-plain" } } })),
    )

    await vi.waitFor(() => expect(handlers.onPeerJoined).toHaveBeenCalledWith("p1", "p1-plain", true))
    expect(handlers.onPeerJoined).not.toHaveBeenCalledWith("p1", "p1", true)
  })
})
