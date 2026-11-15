// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Frame order through the seal, and what close() lets out.
 *
 * With `keys` a directed frame is sealed (deflate + AES-GCM) before
 * it is queued, and two seals for one channel can finish in either order.
 * The frame ISSUED last must be the one the channel keeps: a heartbeat
 * re-announce of the old offer must not land over a rebuild's new offer, a
 * shorter candidate list must not land over the cumulative one, and a
 * candidate flush that sealed across a new offer must not go out under
 * either generation's label.
 *
 * After close() only the bye goes out: a frame waiting for its channel, or
 * one still sealing, is dropped.
 *
 * And what the keys guarantee: every directed frame is sealed to the peer's
 * on-chain identifier, nothing directed goes or is taken in the clear, and a
 * sealed frame opens only under the header it was sealed with.
 */
import { p256 } from "@noble/curves/nist.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptionKeyBytes, sharedSecret } from "./crypto"
import { statementTransport, type SignallingKeys } from "./statementTransport"
import { fromHex, toHex, type StatementStoreLike, type WireStatement } from "./store"
import type { SignalHandlers, SignalTransport } from "./transport"

const dec = new TextDecoder()
type AnyFrame = Record<string, unknown>
type Sealed = { iv: string; ct: string; z?: 1 }

/** In-memory store. `hold(frame)` may return a promise the submit waits on. */
function fakeStore(opts: { hold?: (f: AnyFrame) => Promise<void> | undefined } = {}) {
  const submitted: WireStatement[] = []
  let onPage: ((page: { statements: Array<{ data?: string }> }) => void) | null = null
  const decode = (w: WireStatement) => JSON.parse(dec.decode(fromHex(w.data))) as AnyFrame
  const store: StatementStoreLike = {
    createProofAuthorized: () => Promise.resolve("fake-proof"),
    submit: async (wire) => {
      await opts.hold?.(decode(wire))
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
    push: (...frames: AnyFrame[]) =>
      onPage?.({
        statements: frames.map((f) => ({ data: toHex(new TextEncoder().encode(JSON.stringify(f))) })),
      }),
    subscribed: () => onPage !== null,
    frames: () => submitted.map(decode),
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r))
// crypto.subtle (digests, seals, deflate) resolves off the event loop, so on a
// slow runner a fixed count of setImmediate rounds can finish first. Every
// positive condition is waited on with `until`; `settle` keeps a real-time
// floor for the checks that something did NOT happen.
const settle = async (rounds = 20, minMs = 20) => {
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

function handlers(): SignalHandlers {
  return { onPeerJoined: vi.fn(), onPeerLeft: vi.fn(), onSignal: vi.fn() }
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const enc = new TextEncoder()
/** A registered key pair: the secret and the identifier the chain holds. */
function registered() {
  const secret = p256.utils.randomSecretKey()
  return { secret, identifier: p256.getPublicKey(secret, false) }
}
const me = registered()

/** The remote peer: its registered key, and its half of the pair key with us. */
async function remotePeer(name = "peer") {
  const own = registered()
  const aes = await crypto.subtle.importKey(
    "raw",
    // the transport's default label scheme is HKDF's info
    encryptionKeyBytes(sharedSecret(own.secret, me.identifier), enc.encode("rtc")) as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
  const header = (f: AnyFrame, from: string, to: string, z?: 1) =>
    enc.encode(`${f.t}|${from}|${to}|${f.gen}|${f.sid ?? ""}|${z ?? 0}`)
  return {
    identifier: own.identifier,
    /** opens a frame we sent it */
    async open(f: AnyFrame): Promise<AnyFrame> {
      const s = f.s as Sealed
      const raw = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv), additionalData: header(f, "me", name, s.z) }, aes, unb64(s.ct)),
      )
      const body = s.z
        ? new Uint8Array(
            await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer(),
          )
        : raw
      return JSON.parse(dec.decode(body)) as AnyFrame
    },
    /** seals a frame from it to us: the payload as JSON, or `deflated` bytes as they are;
     *  `to` seals it as if for another recipient (a replay test) */
    async seal(f: AnyFrame, payload: unknown, deflated?: Uint8Array, to = "me"): Promise<AnyFrame> {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const z = deflated ? (1 as const) : undefined
      const ct = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: header(f, name, to, z) },
          aes,
          (deflated ?? enc.encode(JSON.stringify(payload))) as BufferSource,
        ),
      )
      return { ...f, s: { iv: b64(iv), ct: b64(ct), ...(z ? { z } : {}) } }
    },
  }
}

/** Hold crypto.subtle.encrypt calls while held; release them in any order. */
function sealGate() {
  const orig = crypto.subtle.encrypt.bind(crypto.subtle)
  const waiting: Array<() => void> = []
  let held = false
  const spy = vi
    .spyOn(crypto.subtle, "encrypt")
    .mockImplementation(async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
      if (held) await new Promise<void>((r) => waiting.push(r))
      return orig(...args)
    })
  return {
    hold: () => (held = true),
    pending: () => waiting.length,
    /** release the i-th held seal (0 = the oldest still held) */
    release: (i: number) => waiting.splice(i, 1)[0]!(),
    restore: () => spy.mockRestore(),
  }
}

async function openPlain(fake: ReturnType<typeof fakeStore>) {
  const transport: SignalTransport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    log: () => {},
  })({ base: "", room: "room1", id: "me", name: "me", handlers: handlers() })
  await until(fake.subscribed, "the transport to subscribe")
  return transport
}

async function openSealed(
  fake: ReturnType<typeof fakeStore>,
  opts: { peerIdentifier?: SignallingKeys["peerIdentifier"]; handlers?: SignalHandlers } = {},
) {
  const peer = await remotePeer()
  const lookups: string[] = []
  const transport = statementTransport({
    resolveStore: async () => fake.store,
    namespace: "test.ns",
    keys: {
      secret: async () => me.secret,
      peerIdentifier:
        opts.peerIdentifier ??
        (async (id) => {
          lookups.push(id)
          return id === "peer" ? peer.identifier : null
        }),
    },
    log: () => {},
  })({ base: "", room: "room1", id: "me", name: "Me", handlers: opts.handlers ?? handlers() })
  await until(() => fake.frames().some((f) => f.t === "hello"), "our first hello")
  fake.push({ t: "hello", from: "peer", name: "Peer" }) // → its key looked up
  await settle() // pacing: let the hello finish registering the peer before the test sends
  return { transport, peer, lookups }
}

/** The statement the store keeps for a frame type: the highest expiry wins. */
function kept(fake: ReturnType<typeof fakeStore>, t: "d" | "c") {
  return fake.submitted
    .map((w) => ({ w, f: JSON.parse(dec.decode(fromHex(w.data))) as AnyFrame }))
    .filter(({ f }) => f.t === t)
    .reduce((a, b) => (b.w.expiry > a.w.expiry ? b : a)).f
}
const count = (fake: ReturnType<typeof fakeStore>, t: string) => fake.frames().filter((f) => f.t === t).length

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("statementTransport with keys — the frame issued last is the one the channel keeps", () => {
  it("a newer offer is not overwritten by an older one whose seal finished later", async () => {
    const fake = fakeStore()
    const gate = sealGate()
    const { transport, peer } = await openSealed(fake)
    gate.hold()
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => gate.pending() === 1, "o1's seal")
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } }) // a rebuild re-offers
    await until(() => gate.pending() === 2, "o2's seal")
    gate.release(1) // o2's seal finishes first
    await until(() => count(fake, "d") === 1, "o2 to reach the store")
    gate.release(0) // o1's seal finishes last
    await settle() // absence: the late o1 seal must not overwrite o2, so there is nothing to wait for
    const opened = (await peer.open(kept(fake, "d"))) as { desc: { sdp: string } }
    expect(opened.desc.sdp).toBe("o2")
    transport.close()
  })

  it("the cumulative candidate list is not overwritten by a shorter one whose seal finished later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const fake = fakeStore()
    const gate = sealGate()
    const { transport, peer } = await openSealed(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => count(fake, "d") === 1, "o1 to reach the store")
    gate.hold()
    transport.send("peer", { rtc: { cand: { candidate: "c1" } } })
    await vi.advanceTimersByTimeAsync(700) // debounce → flush [c1]
    await until(() => gate.pending() === 1, "the [c1] seal")
    transport.send("peer", { rtc: { cand: { candidate: "c2" } } })
    await vi.advanceTimersByTimeAsync(700) // debounce → flush [c1, c2]
    await until(() => gate.pending() === 2, "the [c1, c2] seal")
    gate.release(1) // [c1, c2] finishes first
    await until(() => count(fake, "c") === 1, "[c1, c2] to reach the store")
    gate.release(0) // [c1] finishes last
    await settle() // absence: the late [c1] seal must not overwrite [c1, c2], so there is nothing to wait for
    const opened = (await peer.open(kept(fake, "c"))) as { cands: Array<{ candidate: string }> }
    expect(opened.cands.map((c) => c.candidate)).toEqual(["c1", "c2"])
    transport.close()
  })

  it("candidates sealed across a new offer go out under no generation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const fake = fakeStore()
    const gate = sealGate()
    const { transport, peer } = await openSealed(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => count(fake, "d") === 1, "o1 to reach the store")
    const g1 = fake.frames().find((f) => f.t === "d")!.gen
    gate.hold()
    transport.send("peer", { rtc: { cand: { candidate: "old-c1" } } })
    await vi.advanceTimersByTimeAsync(700) // debounce → flush, sealing [old-c1]
    await until(() => gate.pending() === 1, "the [old-c1] seal")
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } }) // a new generation
    await until(() => gate.pending() === 2, "o2's seal")
    while (gate.pending() > 0) gate.release(0)
    await until(() => count(fake, "d") === 2, "o2 to reach the store")
    await settle() // absence: the dead generation's candidates must not follow, so there is nothing to wait for
    const g2 = fake.frames().filter((f) => f.t === "d").map((f) => f.gen).find((g) => g !== g1)
    expect(g2).toBeTruthy()
    // the old generation's candidates are dead once the new offer is out: they
    // would only overwrite the cand slot, and the receiver's pending buffer
    for (const f of fake.frames().filter((f) => f.t === "c")) {
      const opened = (await peer.open(f)) as { cands: Array<{ candidate: string }> }
      expect(opened.cands.map((c) => c.candidate)).not.toContain("old-c1")
    }
    transport.close()
  })
})

describe("statementTransport — after close() only the bye goes out", () => {
  it("drops a desc waiting behind its channel's in-flight submit", async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let o1Started = false
    const fake = fakeStore({
      hold: (f) => {
        if ((f.desc as { sdp?: string } | undefined)?.sdp !== "o1") return undefined
        o1Started = true
        return held
      },
    })
    const transport = await openPlain(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => o1Started, "o1's submit to start")
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } }) // waits for o1's channel
    await settle() // pacing: o2 is queued behind o1's channel before the close; it has no observable signal
    transport.close()
    release()
    await until(() => count(fake, "bye") === 1, "the bye")
    await until(() => count(fake, "d") >= 1, "o1, already in flight, to land")
    await settle() // absence: o2 must never go, so there is nothing to wait for
    const sdps = fake.frames().map((f) => (f.desc as { sdp?: string } | undefined)?.sdp).filter(Boolean)
    expect(sdps).toEqual(["o1"]) // o2 never goes
  })

  it("drops a desc whose seal is still pending at close", async () => {
    const fake = fakeStore()
    const gate = sealGate()
    const { transport } = await openSealed(fake)
    gate.hold()
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => gate.pending() === 1, "o1's seal")
    transport.close()
    gate.release(0)
    await until(() => count(fake, "bye") === 1, "the bye")
    await settle() // absence: no desc may follow the bye, so there is nothing to wait for
    expect(count(fake, "d")).toBe(0)
  })

  it("sends nothing for a send() after close", async () => {
    const fake = fakeStore()
    const transport = await openPlain(fake)
    transport.close()
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "late" } } })
    await until(() => count(fake, "bye") === 1, "the bye")
    await settle() // absence: no desc may follow the bye, so there is nothing to wait for
    expect(count(fake, "d")).toBe(0)
  })
})

describe("statementTransport with keys — end to end to the on-chain identifiers", () => {
  it("seals every directed frame to the peer's identifier and puts no SDP or candidate on the wire", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const fake = fakeStore()
    const { transport, peer } = await openSealed(fake)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "secret-sdp" } } })
    transport.send("peer", { rtc: { cand: { candidate: "secret-cand" } } })
    await vi.advanceTimersByTimeAsync(700)
    await until(() => count(fake, "d") === 1 && count(fake, "c") === 1, "the desc and the candidates")
    const wire = fake.submitted.map((w) => dec.decode(fromHex(w.data))).join("\n")
    expect(wire).not.toContain("secret-sdp")
    expect(wire).not.toContain("secret-cand")
    expect(fake.frames().find((f) => f.t === "d")!.desc).toBeUndefined()
    expect(((await peer.open(kept(fake, "d"))) as { desc: { sdp: string } }).desc.sdp).toBe("secret-sdp")
    transport.close()
  })

  // the submit queue tells `replaced` when a waiting statement's bytes change
  // (statementTransport submitWire): a re-seal under a fresh IV changed them
  // on every heartbeat, though nothing in the frame had
  it.each([false, true])("re-announces an unchanged offer as the same bytes (bundle %s), so a wait for its channel is not told as replaced", async (bundle) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const fake = fakeStore()
    const peer = await remotePeer()
    const transport = statementTransport({
      resolveStore: async () => fake.store,
      namespace: "test.ns",
      bundle,
      keys: { secret: async () => me.secret, peerIdentifier: async () => peer.identifier },
      log: () => {},
    })({ base: "", room: "room1", id: "me", name: "Me", handlers: handlers() })
    await until(fake.subscribed, "the transport to subscribe")
    fake.push({ t: "hello", from: "peer", name: "Peer" })
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    const carrying = () =>
      fake.submitted
        .map((w) => ({ data: w.data, f: JSON.parse(dec.decode(fromHex(w.data))) as AnyFrame }))
        .map(({ data, f }) => ({ data, d: f.t === "b" ? (f.f as Record<string, AnyFrame>)["d:peer"] : f.t === "d" ? f : undefined }))
        .filter((x) => x.d)
    // the seal resolves off the event loop, and the bundle's debounce on the fake clock
    const advanceUntil = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 400 && !cond(); i++) await vi.advanceTimersByTimeAsync(50)
      if (!cond()) throw new Error(`timed out waiting for ${what}`)
    }
    await advanceUntil(() => carrying().length >= 1, "the offer")
    await advanceUntil(() => carrying().length >= 2, "a heartbeat's re-announce")
    const sent = carrying()
    expect(new Set(sent.map((x) => JSON.stringify(x.d!.s))).size).toBe(1)
    expect(new Set(sent.map((x) => x.data)).size).toBe(1) // the whole statement unchanged
    expect(((await peer.open(sent[0]!.d!)) as { desc: { sdp: string } }).desc.sdp).toBe("o1")
    transport.close()
  })

  it("sends a peer with no identifier on chain nothing, not even in the clear", async () => {
    const fake = fakeStore()
    const { transport } = await openSealed(fake, { peerIdentifier: async () => null })
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await settle(40, 50) // absence: nothing may go to it, so there is nothing to wait for
    expect(count(fake, "d")).toBe(0)
    transport.close()
  })

  it("asks again for a missing identifier only after a while", async () => {
    let clock = 0
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const fake = fakeStore()
    const lookups: string[] = []
    const { transport } = await openSealed(fake, {
      peerIdentifier: async (id) => {
        lookups.push(id)
        return null
      },
    })
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => lookups.length === 1, "the first lookup")
    await settle()
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } })
    await settle()
    expect(lookups).toHaveLength(1) // within the retry window
    clock += 10_001
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o3" } } })
    await until(() => lookups.length === 2, "the lookup to be asked again")
    transport.close()
  })

  it("looks nobody up for a hello: the game's room carries every player's", async () => {
    const fake = fakeStore()
    const { transport, lookups } = await openSealed(fake)
    fake.push({ t: "hello", from: "stranger", name: "Stranger" })
    await settle()
    expect(lookups).toEqual([])
    transport.close()
  })

  it("reads its own secret when the room subscribes, before anything is sent, and still looks no peer up", async () => {
    const fake = fakeStore()
    const secret = vi.fn(async () => me.secret)
    const peerIdentifier = vi.fn(async () => null)
    const transport = statementTransport({
      resolveStore: async () => fake.store,
      namespace: "test.ns",
      keys: { secret, peerIdentifier },
      log: () => {},
    })({ base: "", room: "room1", id: "me", name: "Me", handlers: handlers() })
    await until(fake.subscribed, "the transport to subscribe")
    await until(() => secret.mock.calls.length === 1, "the own secret's read")
    fake.push({ t: "hello", from: "peer", name: "Peer" })
    await settle()
    expect(secret).toHaveBeenCalledTimes(1)
    expect(peerIdentifier).not.toHaveBeenCalled()
    transport.close()
  })

  it("does not hold one peer's frames behind another peer's slow lookup", async () => {
    const h = handlers()
    const fake = fakeStore()
    let releaseSlow!: (id: Uint8Array | null) => void
    const peerRef: { identifier?: Uint8Array } = {}
    const { transport, peer } = await openSealed(fake, {
      handlers: h,
      peerIdentifier: (id) =>
        id === "slow" ? new Promise((r) => (releaseSlow = r)) : Promise.resolve(peerRef.identifier ?? null),
    })
    peerRef.identifier = peer.identifier
    fake.push({ t: "d", from: "slow", name: "Slow", gen: "s1", s: { iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" } })
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, { desc: { type: "offer", sdp: "fast" } }))
    await until(() => (h.onSignal as ReturnType<typeof vi.fn>).mock.calls.length > 0, "the other peer's offer")
    releaseSlow(null)
    transport.close()
  })

  it("asks again for its own secret after a miss, not once a room", async () => {
    let clock = 0
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const fake = fakeStore()
    const peer = await remotePeer()
    let reads = 0
    const transport = statementTransport({
      resolveStore: async () => fake.store,
      namespace: "test.ns",
      keys: {
        secret: async () => (++reads === 1 ? null : me.secret),
        peerIdentifier: async () => peer.identifier,
      },
      log: () => {},
    })({ base: "", room: "room1", id: "me", name: "Me", handlers: handlers() })
    await until(fake.subscribed, "the transport to subscribe")
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => reads === 1, "the first read")
    await settle()
    expect(count(fake, "d")).toBe(0)
    clock += 10_001
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } })
    await until(() => count(fake, "d") === 1, "the offer, once the secret is found")
    expect(((await peer.open(kept(fake, "d"))) as { desc: { sdp: string } }).desc.sdp).toBe("o2")
    expect(transport.stats?.()?.sealed?.ownKeyMissing).toBe(1)
    transport.close()
  })

  it("asks for its own secret less often after three misses, once the room is two minutes old", async () => {
    let clock = 0
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const fake = fakeStore()
    const peer = await remotePeer()
    let reads = 0
    const transport = statementTransport({
      resolveStore: async () => fake.store,
      namespace: "test.ns",
      keys: { secret: async () => (reads++, null), peerIdentifier: async () => peer.identifier },
      log: () => {},
    })({ base: "", room: "room1", id: "me", name: "Me", handlers: handlers() })
    const offerAt = async (at: number, sdp: string) => {
      clock = at
      transport.send("peer", { rtc: { desc: { type: "offer", sdp } } })
      await settle()
    }
    await until(() => reads === 1, "the read at subscribe") // miss 1
    await settle()
    await offerAt(10_010, "o2") // miss 2
    await offerAt(20_020, "o3") // miss 3, but the room is young: still every 10 s
    await offerAt(30_030, "o4") // miss 4
    expect(reads).toBe(4)
    await offerAt(130_000, "o5") // miss 5, the room past two minutes: now every 20 s
    expect(reads).toBe(5)
    await offerAt(140_010, "o6") // 10 s after it: not yet
    expect(reads).toBe(5)
    await offerAt(150_020, "o7") // 20 s after it
    expect(reads).toBe(6)
    transport.close()
  })

  it("sees its own key that arrives late at join within a retry, not a backoff", async () => {
    let clock = 0
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const fake = fakeStore()
    const peer = await remotePeer()
    // storage away at join: the key is there from +25 s
    const transport = statementTransport({
      resolveStore: async () => fake.store,
      namespace: "test.ns",
      keys: { secret: async () => (clock >= 25_000 ? me.secret : null), peerIdentifier: async () => peer.identifier },
      log: () => {},
    })({ base: "", room: "room1", id: "me", name: "Me", handlers: handlers() })
    await until(fake.subscribed, "the transport to subscribe")
    await settle()
    // the mesh offers every second (a heartbeat or a rebuild): the first one
    // that goes out is sealed with the key
    let sentAt = -1
    for (let t = 1_000; t <= 60_000 && sentAt < 0; t += 1_000) {
      clock = t
      transport.send("peer", { rtc: { desc: { type: "offer", sdp: `o${t}` } } })
      await settle()
      if (count(fake, "d") > 0) sentAt = t
    }
    expect(sentAt).toBeGreaterThanOrEqual(25_000)
    expect(sentAt).toBeLessThanOrEqual(35_000)
    transport.close()
  })

  it("counts why sealed frames were dropped: in the clear, failed to open, no identifier, within the retry window", async () => {
    const h = handlers()
    const fake = fakeStore()
    const { transport, peer } = await openSealed(fake, { handlers: h })
    const sealed = () => transport.stats?.()?.sealed
    expect(sealed()).toEqual({
      ownKeyMissing: 0,
      peerIdMissing: 0,
      openFailed: 0,
      plaintextDropped: 0,
      droppedAtLookupCap: 0,
      droppedInBackoff: 0,
    })
    fake.push({ t: "d", from: "peer", name: "Peer", gen: "g-plain", desc: { type: "offer", sdp: "plain" } })
    await until(() => sealed()?.plaintextDropped === 1, "the plaintext drop")
    const good = await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, { desc: { type: "offer", sdp: "o" } })
    fake.push({ ...good, s: { ...(good.s as Sealed), z: 1 } })
    await until(() => sealed()?.openFailed === 1, "the failed open")
    const junk = { t: "d", from: "nobody", name: "N", gen: "g", s: { iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" } }
    fake.push(junk)
    await until(() => sealed()?.peerIdMissing === 1, "the missing identifier")
    await settle()
    fake.push(junk)
    await until(() => sealed()?.droppedInBackoff === 1, "the drop within the retry window")
    expect(h.onSignal).not.toHaveBeenCalled()
    transport.close()
  })

  it("opens what the peer sealed to it and drops a desc sent in the clear", async () => {
    const h = handlers()
    const fake = fakeStore()
    const { transport, peer } = await openSealed(fake, { handlers: h })
    fake.push({ t: "d", from: "peer", name: "Peer", gen: "g-plain", desc: { type: "offer", sdp: "plain" } })
    await settle()
    expect(h.onSignal).not.toHaveBeenCalled()
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, { desc: { type: "offer", sdp: "sealed" } }))
    await until(() => (h.onSignal as ReturnType<typeof vi.fn>).mock.calls.length > 0, "the sealed offer")
    expect(JSON.stringify((h.onSignal as ReturnType<typeof vi.fn>).mock.calls)).toContain("sealed")
    transport.close()
  })

  it("drops a sealed frame replayed under another generation", async () => {
    const h = handlers()
    const fake = fakeStore()
    const { transport, peer } = await openSealed(fake, { handlers: h })
    const sealed = await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, { desc: { type: "offer", sdp: "o" } })
    fake.push({ ...sealed, gen: "g2" })
    await settle(40, 50)
    expect(h.onSignal).not.toHaveBeenCalled()
    transport.close()
  })

  it("two players link through each other's on-chain keys alone", async () => {
    const pages: Array<(page: { statements: Array<{ data?: string }> }) => void> = []
    const bus: StatementStoreLike = {
      createProofAuthorized: () => Promise.resolve("fake-proof"),
      submit: async (wire) => {
        for (const page of pages) page({ statements: [{ data: wire.data }] })
      },
      subscribe: (_filter, cb) => {
        pages.push(cb)
        return { unsubscribe: () => {} }
      },
    }
    const alice = registered()
    const bob = registered()
    const chain: Record<string, Uint8Array> = { alice: alice.identifier, bob: bob.identifier }
    const open = (id: string, secret: Uint8Array, h: SignalHandlers) =>
      statementTransport({
        resolveStore: async () => bus,
        namespace: "test.ns",
        keys: { secret: async () => secret, peerIdentifier: async (peer) => chain[peer] ?? null },
        log: () => {},
      })({ base: "", room: "room1", id, name: id, handlers: h })
    const hb = handlers()
    const a = open("alice", alice.secret, handlers())
    const b = open("bob", bob.secret, hb)
    await until(() => pages.length === 2, "both to subscribe")
    await settle()
    a.send("bob", { rtc: { desc: { type: "offer", sdp: "alice-offer" } } })
    await until(() => JSON.stringify((hb.onSignal as ReturnType<typeof vi.fn>).mock.calls).includes("alice-offer"), "bob to open alice's offer")
    a.close()
    b.close()
  })

  it("drops a sealed frame replayed under another session", async () => {
    const h = handlers()
    const fake = fakeStore()
    const { transport, peer } = await openSealed(fake, { handlers: h })
    const sealed = await peer.seal({ t: "d", from: "peer", name: "Peer", sid: "100-a", gen: "100-a.1" }, { desc: { type: "offer", sdp: "replayed" } })
    fake.push({ ...sealed, sid: "100-b", gen: "100-b.1" }, { ...sealed, sid: "100-b" })
    await settle(40, 50)
    expect(h.onSignal).not.toHaveBeenCalled()
    // the session itself was admitted: a frame sealed under it opens
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", sid: "100-b", gen: "100-b.2" }, { desc: { type: "offer", sdp: "fresh" } }))
    await until(() => (h.onSignal as ReturnType<typeof vi.fn>).mock.calls.length > 0, "the frame sealed under the session")
    expect(JSON.stringify((h.onSignal as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("replayed")
    transport.close()
  })

  it("drops a sealed frame replayed under another sender or for another recipient", async () => {
    const h = handlers()
    const fake = fakeStore()
    const peerRef: { identifier?: Uint8Array } = {}
    // mallory's identifier is the peer's, so the pair key is the same and only the header differs
    const { transport, peer } = await openSealed(fake, {
      handlers: h,
      peerIdentifier: async (id) => (id === "peer" || id === "mallory" ? peerRef.identifier! : null),
    })
    peerRef.identifier = peer.identifier
    const asPeer = await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, { desc: { type: "offer", sdp: "o" } })
    fake.push({ ...asPeer, from: "mallory", name: "Mallory" }) // another sender
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g2" }, { desc: { type: "offer", sdp: "o" } }, undefined, "carol")) // for another recipient
    await settle(40, 50)
    expect(h.onSignal).not.toHaveBeenCalled()
    transport.close()
  })

  it.each([false, true])("runs a whole offer, answer and candidates exchange sealed (bundle %s)", async (bundle) => {
    const pages: Array<(page: { statements: Array<{ data?: string }> }) => void> = []
    const bus: StatementStoreLike = {
      createProofAuthorized: () => Promise.resolve("fake-proof"),
      submit: async (wire) => {
        for (const page of pages) page({ statements: [{ data: wire.data }] })
      },
      subscribe: (_filter, cb) => {
        pages.push(cb)
        return { unsubscribe: () => {} }
      },
    }
    const alice = registered()
    const bob = registered()
    const chain: Record<string, Uint8Array> = { alice: alice.identifier, bob: bob.identifier }
    const open = (id: string, secret: Uint8Array, h: SignalHandlers) =>
      statementTransport({
        resolveStore: async () => bus,
        namespace: "test.ns",
        bundle,
        keys: { secret: async () => secret, peerIdentifier: async (peer) => chain[peer] ?? null },
        log: () => {},
      })({ base: "", room: "room1", id, name: id, handlers: h })
    const ha = handlers()
    const hb = handlers()
    const a = open("alice", alice.secret, ha)
    const b = open("bob", bob.secret, hb)
    const got = (h: SignalHandlers, text: string) => JSON.stringify((h.onSignal as ReturnType<typeof vi.fn>).mock.calls).includes(text)
    await until(() => pages.length === 2, "both to subscribe")
    await settle()
    a.send("bob", { rtc: { desc: { type: "offer", sdp: "alice-offer" } } })
    await until(() => got(hb, "alice-offer"), "bob to open alice's offer")
    b.send("alice", { rtc: { desc: { type: "answer", sdp: "bob-answer" } } })
    await until(() => got(ha, "bob-answer"), "alice to open bob's answer")
    a.send("bob", { rtc: { cand: { candidate: "alice-cand" } } })
    b.send("alice", { rtc: { cand: { candidate: "bob-cand" } } })
    await until(() => got(hb, "alice-cand") && got(ha, "bob-cand"), "both sides' candidates")
    a.close()
    b.close()
  })

  it("drops what a peer's old session sent while its key was looked up, and opens its new session's", async () => {
    const h = handlers()
    const fake = fakeStore()
    const answers: Array<() => void> = []
    const peerRef: { identifier?: Uint8Array } = {}
    const { transport, peer } = await openSealed(fake, {
      handlers: h,
      peerIdentifier: (id) => new Promise((r) => answers.push(() => r(id === "peer" ? peerRef.identifier! : null))),
    })
    peerRef.identifier = peer.identifier
    fake.push({ t: "hello", from: "peer", sid: "100-a", name: "Peer" })
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", sid: "100-a", gen: "100-a.1" }, { desc: { type: "offer", sdp: "old-boot" } }))
    await until(() => answers.length === 1, "the lookup for the old session's frame")
    // the peer reloads while its key is looked up
    fake.push({ t: "hello", from: "peer", sid: "200-b", name: "Peer" })
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", sid: "200-b", gen: "200-b.1" }, { desc: { type: "offer", sdp: "new-boot" } }))
    await until(() => answers.length === 2, "the lookup for the new session's frame")
    for (const answer of answers) answer()
    await until(() => (h.onSignal as ReturnType<typeof vi.fn>).mock.calls.length > 0, "the new session's offer")
    await settle()
    const calls = JSON.stringify((h.onSignal as ReturnType<typeof vi.fn>).mock.calls)
    expect(calls).toContain("new-boot")
    expect(calls).not.toContain("old-boot")
    transport.close()
  })

  it("drops a sealed frame whose compression flag was flipped", async () => {
    const h = handlers()
    const fake = fakeStore()
    const { transport, peer } = await openSealed(fake, { handlers: h })
    const sealed = await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, { desc: { type: "offer", sdp: "o" } })
    fake.push({ ...sealed, s: { ...(sealed.s as Sealed), z: 1 } })
    await settle(40, 50)
    expect(h.onSignal).not.toHaveBeenCalled()
    transport.close()
  })

  it("refuses a sealed payload that inflates past its bound", async () => {
    const h = handlers()
    const fake = fakeStore()
    const { transport, peer } = await openSealed(fake, { handlers: h })
    const huge = enc.encode(JSON.stringify({ desc: { type: "offer", sdp: "x".repeat(200_000) } }))
    const bomb = new Uint8Array(
      await new Response(new Blob([huge]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer(),
    )
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, null, bomb))
    await settle(40, 50)
    expect(h.onSignal).not.toHaveBeenCalled()
    transport.close()
  })

  it("starts only a bounded number of lookups for frames from strangers", async () => {
    const fake = fakeStore()
    const asked: string[] = []
    const { transport } = await openSealed(fake, {
      peerIdentifier: (peer) => {
        asked.push(peer)
        return new Promise(() => {}) // never answers
      },
    })
    for (let i = 0; i < 50; i++)
      fake.push({ t: "d", from: `stranger-${i}`, name: "S", gen: "g", s: { iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" } })
    await settle(40, 50)
    expect(asked.length).toBe(16)
    expect(transport.stats?.()?.sealed?.droppedAtLookupCap).toBe(34)
    transport.close()
  })

  it("opens the first frames of twelve co-players at once, with no wait for a re-announce", async () => {
    const h = handlers()
    const fake = fakeStore()
    const names = Array.from({ length: 12 }, (_, i) => `co-${i}`)
    const peers = new Map(await Promise.all(names.map(async (n) => [n, await remotePeer(n)] as const)))
    const answers: Array<() => void> = []
    const { transport } = await openSealed(fake, {
      handlers: h,
      // every lookup is in flight at once: none answers before all frames are in
      peerIdentifier: (id) => new Promise((r) => answers.push(() => r(peers.get(id)?.identifier ?? null))),
    })
    for (const n of names)
      fake.push(await peers.get(n)!.seal({ t: "d", from: n, name: n, gen: `${n}.1` }, { desc: { type: "offer", sdp: `from-${n}` } }))
    await until(() => answers.length === 12, "a lookup for each co-player")
    for (const answer of answers) answer()
    const opened = () => (h.onSignal as ReturnType<typeof vi.fn>).mock.calls.length
    await until(() => opened() === 12, "all twelve offers")
    transport.close()
  })

  it("gives up a lookup that never answers and asks again later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const fake = fakeStore()
    const asked: string[] = []
    const { transport } = await openSealed(fake, {
      peerIdentifier: (peer) => {
        asked.push(peer)
        return new Promise(() => {}) // hangs
      },
    })
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o1" } } })
    await until(() => asked.length === 1, "the first lookup")
    await vi.advanceTimersByTimeAsync(15_001 + 10_001)
    transport.send("peer", { rtc: { desc: { type: "offer", sdp: "o2" } } })
    await until(() => asked.length === 2, "the lookup to be asked again")
    transport.close()
  })

  it("lets go of the key least recently used, not a co-player's in use, when strangers fill the cache", async () => {
    const h = handlers()
    const fake = fakeStore()
    const asked: string[] = []
    const peerRef: { identifier?: Uint8Array } = {}
    const { transport, peer } = await openSealed(fake, {
      handlers: h,
      peerIdentifier: async (id) => {
        asked.push(id)
        return id === "peer" ? peerRef.identifier! : registered().identifier
      },
    })
    peerRef.identifier = peer.identifier
    const offers = () => (h.onSignal as ReturnType<typeof vi.fn>).mock.calls.length
    // anyone with an allowance can post under the `from` of any registered
    // player: each frame looks a real key up, at most 16 at a time
    let strangers = 0
    const fill = async (n: number) => {
      for (const end = strangers + n; strangers < end; ) {
        const batch = Math.min(8, end - strangers)
        const before = asked.length
        for (let i = 0; i < batch; i++)
          fake.push({ t: "d", from: `stranger-${strangers++}`, name: "S", gen: "g", s: { iv: "AAAAAAAAAAAAAAAA", ct: "AAAA" } })
        await until(() => asked.length === before + batch, "the strangers' lookups")
        await settle() // their keys land in the cache, their lookups end
      }
    }
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g1" }, { desc: { type: "offer", sdp: "o1" } }))
    await until(() => offers() === 1, "the co-player's first offer")
    await fill(255) // the cache is full: the co-player's key is its oldest entry
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g2" }, { desc: { type: "offer", sdp: "o2" } }))
    await until(() => offers() === 2, "the co-player's second offer")
    await fill(8) // past the cap: the least recently used keys go
    fake.push(await peer.seal({ t: "d", from: "peer", name: "Peer", gen: "g3" }, { desc: { type: "offer", sdp: "o3" } }))
    await until(() => offers() === 3, "the co-player's third offer")
    expect(asked.filter((id) => id === "peer")).toHaveLength(1) // its key in use was kept
    transport.close()
  })
})
