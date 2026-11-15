// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * F7 (#214): an answer is labelled with the gen of the offer it answers.
 *
 * The transport used to label an answer with whatever `genOf` held when the
 * mesh sent it. The mesh answers asynchronously (it gathers first), so a
 * newer offer delivered meanwhile moved `genOf`, and the answer to the OLD
 * offer went out under the NEW offer's gen. The offerer's answer gate then
 * took it as the answer to its new offer: a description from a connection
 * that answered something else. The reload case makes this ordinary: the
 * store still holds the peer's offer to our previous boot, we answer it, and
 * the peer re-offers to our new boot while we gather.
 *
 * The fix (option B): the transport hands each offer's gen to the mesh with
 * the offer (`rtc.gen`), the mesh echoes it on its answer, and `send()` labels
 * the answer with it. A payload without a gen keeps today's label.
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

async function open(fake: ReturnType<typeof fakeStore>, id = "me") {
  const handlers = {
    onPeerJoined: vi.fn<(id: string, name: string, seen?: boolean) => void>(),
    onPeerLeft: vi.fn<(id: string) => void>(),
    onSignal: vi.fn<(from: string, data: unknown) => void>(),
  } satisfies SignalHandlers
  const transport: SignalTransport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
  })({ base: "", room: "room1", id, name: id, handlers })
  await until(fake.subscribed, "the transport to subscribe")
  return { transport, handlers }
}

const offerFrom = (gen: string, sdp: string) => ({ t: "d", from: "peer", name: "Peer", gen, desc: { type: "offer", sdp } })
const descs = (fake: ReturnType<typeof fakeStore>, type: string) =>
  fake.frames().filter((f) => f.t === "d" && (f.desc as { type?: string } | undefined)?.type === type)

afterEach(() => {
  vi.useRealTimers()
})

describe("statementTransport — F7: an answer carries the gen of the offer it answers", () => {
  it("hands each offer's gen to the mesh with the offer", async () => {
    const fake = fakeStore()
    const { handlers } = await open(fake)
    fake.push(offerFrom("g0", "sdp0"))
    await until(() => handlers.onSignal.mock.calls.some(([, d]) => JSON.stringify(d).includes("sdp0")), "the offer sdp0 to be delivered")
    expect(handlers.onSignal).toHaveBeenCalledWith("peer", { rtc: { desc: { type: "offer", sdp: "sdp0" }, gen: "g0" } })
  })

  it("labels the answer to an old offer with that offer's gen, even after a newer offer moved the generation (the reload case)", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    // after our reload the store still holds the peer's offer to our previous boot
    fake.push(offerFrom("g0", "sdp-old"))
    await until(() => handlers.onSignal.mock.calls.some(([, d]) => JSON.stringify(d).includes("sdp-old")), "the offer sdp-old to be delivered")
    // while the mesh gathers its answer to it, the peer re-offers to our new boot
    fake.push(offerFrom("g1", "sdp-new"))
    await until(() => handlers.onSignal.mock.calls.some(([, d]) => JSON.stringify(d).includes("sdp-new")), "the offer sdp-new to be delivered")
    // the mesh's answer to the OLD offer comes out now, echoing its gen
    transport.send("peer", { rtc: { desc: { type: "answer", sdp: "ans-old" }, gen: "g0" } })
    await until(() => descs(fake, "answer").length === 1, "the answer to be submitted")
    expect(descs(fake, "answer")[0]!.gen).toBe("g0") // not g1: the peer's gate must not take it for g1's answer
    // and its candidates ride the same gen
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    transport.send("peer", { rtc: { cand: { candidate: "candidate:1 1 udp 1 1.1.1.1 1 typ host" } } })
    await vi.advanceTimersByTimeAsync(800)
    vi.useRealTimers()
    await until(() => fake.frames().some((f) => f.t === "c"), "the candidates to be submitted")
    expect(fake.frames().find((f) => f.t === "c")!.gen).toBe("g0")
  })

  it("does not send an answer to an offer older than the last one adopted from that boot", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    const sid = "1800000000000-aaaa"
    fake.push({ ...offerFrom(`${sid}.1`, "sdp-old"), sid }, { ...offerFrom(`${sid}.2`, "sdp-new"), sid })
    await until(() => handlers.onSignal.mock.calls.some(([, d]) => JSON.stringify(d).includes("sdp-new")), "the offer sdp-new to be delivered")
    // the live answer goes first, then the slower run's answer to the superseded offer
    transport.send("peer", { rtc: { desc: { type: "answer", sdp: "ans-new" }, gen: `${sid}.2` } })
    transport.send("peer", { rtc: { desc: { type: "answer", sdp: "ans-old" }, gen: `${sid}.1` } })
    await until(() => descs(fake, "answer").length >= 1, "the answer to be submitted")
    await settle() // absence: the stale answer must NOT follow, so there is nothing to wait for
    // the stale one never replaces the live one in the queue, the store slot or the heartbeat
    expect(descs(fake, "answer").map((f) => (f.desc as { sdp: string }).sdp)).toEqual(["ans-new"])
  })

  it("labels an answer without a gen with the current generation, as before", async () => {
    const fake = fakeStore()
    const { transport, handlers } = await open(fake)
    fake.push(offerFrom("g0", "sdp0"))
    await until(() => handlers.onSignal.mock.calls.some(([, d]) => JSON.stringify(d).includes("sdp0")), "the offer sdp0 to be delivered")
    transport.send("peer", { rtc: { desc: { type: "answer", sdp: "ans" } } })
    await until(() => descs(fake, "answer").length === 1, "the answer to be submitted")
    expect(descs(fake, "answer")[0]!.gen).toBe("g0")
  })
})
