// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * T1: the explorer's controlled peer connection (design 2.2). Unit level: a
 * Controller and its ControlledPCs, driven by hand, no room and no Mesh,
 * except the last case, which runs a Mesh test with no controller at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FakeChannel, FakePC, sdp, setupMesh } from "../../webrtc/test-pc"
import { ControlledPC, Controller, ICE_FAILED_MS } from "./controlled-pc"
import type { Side } from "../core/labels"

type Desc = { type: string; sdp: string }
type Handler = ((event: { data: unknown }) => void) | null

let controller: Controller

const build = (side: Side) => controller.building(side, () => new ControlledPC())
const attr = (body: string | undefined, name: string) => new RegExp(`^a=${name}:(.*)$`, "m").exec(body ?? "")?.[1]?.trim()
/** one real turn: every ready promise job has run (no fake timers here) */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const domName = async (promise: Promise<unknown>) => promise.then(() => "resolved", (error: DOMException) => error.name)

/** a/1 offers, b/1 answers; every op resolved by hand. */
async function negotiate(a: FakePC, b: FakePC) {
  const ids = [controller.pcId(a), controller.pcId(b)]
  const sld = a.setLocalDescription()
  controller.resolve(ids[0], "sld")
  await sld
  const srd = b.setRemoteDescription(a.localDescription as Desc)
  controller.resolve(ids[1], "srd")
  await srd
  const answer = b.setLocalDescription()
  controller.resolve(ids[1], "sld")
  await answer
  const back = a.setRemoteDescription(b.localDescription as Desc)
  controller.resolve(ids[0], "srd")
  await back
}

/** negotiated, gathered, and connected by the benign network */
async function connect(a: FakePC, b: FakePC) {
  await negotiate(a, b)
  controller.gather(controller.pcId(a))
  controller.gather(controller.pcId(b))
  controller.applyBenignNetwork()
}

describe("the explorer's controlled peer connection", () => {
  beforeEach(() => {
    controller = new Controller()
    FakePC.controller = controller
    FakePC.last = []
  })
  afterEach(() => {
    FakePC.controller = null
    FakePC.last = []
  })

  it("queues SRD, SLD, candidates and rollback per PC and enables only the head", async () => {
    const a = build("a")
    const b = build("b")
    expect([controller.pcId(a), controller.pcId(b)]).toEqual(["a/1", "b/1"])
    const offer = a.setLocalDescription()
    const rollback = a.setLocalDescription({ type: "rollback" })
    const remote = b.setRemoteDescription({ type: "offer", sdp: sdp("x1") })
    const cand = b.addIceCandidate({ candidate: "candidate:1" })
    // nothing runs without the explorer
    await turn()
    expect(a.localDescription).toBeNull()
    expect(a.signalingState).toBe("stable")
    expect(controller.pending()).toEqual([
      { pc: "a/1", op: "sld", index: 0 },
      { pc: "b/1", op: "srd", index: 0 },
    ])
    expect(() => controller.resolve("a/1", "rollback")).toThrow(/not the head/)
    controller.resolve("a/1", "sld")
    await offer
    expect(a.signalingState).toBe("have-local-offer")
    expect(controller.pending()).toEqual([
      { pc: "a/1", op: "rollback", index: 1 },
      { pc: "b/1", op: "srd", index: 0 },
    ])
    controller.resolve("a/1", "rollback")
    await rollback
    expect(a.signalingState).toBe("stable")
    controller.resolve("b/1", "srd")
    await remote
    expect(controller.pending()).toEqual([{ pc: "b/1", op: "cand", index: 1 }])
    controller.reject("b/1", "cand", "OperationError")
    expect(await domName(cand)).toBe("OperationError")
    expect(controller.pending()).toEqual([])
    expect(controller.opLog().map(({ pc, op, outcome }) => `${pc} ${op} ${outcome}`)).toEqual([
      "a/1 sld resolved", "a/1 rollback resolved", "b/1 srd resolved", "b/1 cand rejected",
    ])
  })

  it("routes settlements and browser callbacks through the per-side input chokepoint", async () => {
    const inputs: Array<{ side: Side; kind: string; value: unknown }> = []
    controller = new Controller((side, kind, value, run) => {
      inputs.push({ side, kind, value })
      return run()
    })
    FakePC.controller = controller
    const a = build("a")
    const b = build("b")
    const tracked: string[] = []
    b.ontrack = ({ track }) => tracked.push((track as unknown as { id: string }).id)
    a.onicecandidate = () => {}
    a.onicegatheringstatechange = () => {}
    a.onconnectionstatechange = () => {}
    a.oniceconnectionstatechange = () => {}
    b.onconnectionstatechange = () => {}
    b.oniceconnectionstatechange = () => {}
    let far: FakeChannel | undefined
    b.ondatachannel = ({ channel }: { channel: FakeChannel }) => { far = channel }
    a.addTrack({ kind: "video" } as MediaStreamTrack)
    const channel = a.createDataChannel("jollity") as unknown as FakeChannel

    expect(() => channel.send("early")).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    expect(inputs.at(-1)).toMatchObject({ side: "a", kind: "lane:send", value: { fate: "refused", errorClass: "InvalidStateError" } })

    await connect(a, b)
    expect(tracked).toEqual(["b/1-remote-0"])
    expect(inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ side: "b", kind: "pc:ontrack" }),
      expect.objectContaining({ side: "a", kind: "pc:onicecandidate" }),
      expect.objectContaining({ side: "a", kind: "pc:onicegatheringstatechange" }),
      expect.objectContaining({ side: "a", kind: "pc:dispatch:icegatheringstatechange" }),
      expect.objectContaining({ side: "a", kind: "pc:onconnectionstatechange" }),
      expect.objectContaining({ side: "b", kind: "pc:ondatachannel" }),
      expect.objectContaining({ side: "a", kind: "op:resolved" }),
    ]))

    const closed: Side[] = []
    channel.onclose = () => closed.push("a")
    far!.onclose = () => closed.push("b")
    channel.close()
    await turn()
    expect(closed.sort()).toEqual(["a", "b"])
    expect(inputs.filter(({ kind }) => kind === "channel:onclose").map(({ side }) => side).sort()).toEqual(["a", "b"])
  })

  it("records reject classes and errors thrown while applying an operation", async () => {
    const a = build("a")
    const rejected = a.addIceCandidate({ candidate: "candidate:1" })
    controller.reject("a/1", "cand", "OperationError")
    await expect(rejected).rejects.toMatchObject({ name: "OperationError", message: "explorer: cand rejected" })
    expect(controller.opLog().at(-1)).toMatchObject({ outcome: "rejected", errorClass: "OperationError", error: "explorer: cand rejected" })

    const applied = a.addIceCandidate({ candidate: "candidate:2" })
    controller.resolve("a/1", "cand")
    await expect(applied).rejects.toMatchObject({ name: "InvalidStateError", message: "The remote description was null" })
    expect(controller.opLog().at(-1)).toMatchObject({ outcome: "rejected", errorClass: "InvalidStateError", error: "The remote description was null" })
  })

  it("writes SDP with its pc, role and the offer an answer answers", async () => {
    const a = build("a")
    const b = build("b")
    controller.step = 3
    await negotiate(a, b)
    const offer = a.localDescription!.sdp
    expect(offer).toMatch(/^o=- a1 /m)
    expect(attr(offer, "x-pc")).toBe("a/1")
    expect(attr(offer, "x-role")).toBe("offer")
    expect(attr(offer, "x-offer")).toBe("a/1#1")
    const answer = b.localDescription!.sdp
    expect(answer).toMatch(/a=x-answers:a\/1\/u1\/a\/1#1/)
    expect(attr(answer, "x-pc")).toBe("b/1")
    expect(attr(answer, "x-role")).toBe("answer")
    expect(controller.opLog()).toEqual([
      { pc: "a/1", op: "sld", outcome: "resolved", sdpRole: "offer", xPc: "a/1", xOffer: "a/1#1", step: 3 },
      { pc: "b/1", op: "srd", outcome: "resolved", sdpRole: "offer", xPc: "a/1", xOffer: "a/1#1", step: 3 },
      { pc: "b/1", op: "sld", outcome: "resolved", sdpRole: "answer", xPc: "b/1", xOffer: "a/1#1", step: 3 },
      { pc: "a/1", op: "srd", outcome: "resolved", sdpRole: "answer", xPc: "b/1", xOffer: "a/1#1", step: 3 },
    ])
  })

  it("restarts ICE for real: a new ufrag and negotiation needed", async () => {
    const a = build("a")
    const b = build("b")
    await negotiate(a, b)
    const fired = vi.fn(async () => {})
    a.onnegotiationneeded = fired
    expect(controller.negotiationNeeded()).toEqual([])
    a.restartIce()
    expect(controller.negotiationNeeded()).toEqual(["a/1"])
    controller.fireNegotiationNeeded("a/1")
    expect(fired).toHaveBeenCalledTimes(1)
    expect(controller.negotiationNeeded()).toEqual([])
    const reoffer = a.setLocalDescription()
    controller.resolve("a/1", "sld")
    await reoffer
    expect(attr(a.localDescription!.sdp, "ice-ufrag")).toBe("u2")
    expect(attr(a.localDescription!.sdp, "x-offer")).toBe("a/1#2")
  })

  it("closes for real: queued ops reject with InvalidStateError and both channel ends close", async () => {
    const a = build("a")
    const b = build("b")
    const mine = a.createDataChannel("jollity") as unknown as FakeChannel
    const theirs: FakeChannel[] = []
    b.ondatachannel = ({ channel }: { channel: FakeChannel }) => theirs.push(channel)
    await connect(a, b)
    expect([mine.readyState, theirs[0]?.readyState]).toEqual(["open", "open"])
    const closed: string[] = []
    mine.onclose = () => closed.push("a")
    theirs[0].onclose = () => closed.push("b")
    const queued = a.setRemoteDescription({ type: "offer", sdp: sdp("x1") })
    a.close()
    expect(a.signalingState).toBe("closed")
    expect(a.connectionState).toBe("closed")
    expect(await domName(queued)).toBe("InvalidStateError")
    expect(await domName(a.setLocalDescription())).toBe("InvalidStateError")
    expect(await domName(a.addIceCandidate(null))).toBe("InvalidStateError")
    expect(controller.pending()).toEqual([])
    expect([mine.readyState, theirs[0].readyState]).toEqual(["closed", "closed"])
    await turn()
    expect(closed.sort()).toEqual(["a", "b"])
    // the queued op, and the two made after the close, are all logged as rejected
    expect(controller.opLog().slice(-3).map(({ pc, op, outcome }) => `${pc} ${op} ${outcome}`)).toEqual([
      "a/1 srd rejected", "a/1 sld rejected", "a/1 cand rejected",
    ])
  })

  it("pairs channels: send reaches the far end's lane FIFO and throws when not open", async () => {
    const a = build("a")
    const b = build("b")
    const mine = a.createDataChannel("jollity") as unknown as FakeChannel
    expect(() => mine.send("early")).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    let theirs: FakeChannel | undefined
    b.ondatachannel = ({ channel }: { channel: FakeChannel }) => { theirs = channel }
    await connect(a, b)
    const heard: unknown[] = []
    const mineHeard: unknown[] = []
    ;(theirs!.onmessage as Handler) = ({ data }) => heard.push(data)
    ;(mine.onmessage as Handler) = ({ data }) => mineHeard.push(data)
    mine.send("one")
    mine.send("two")
    theirs!.send("back")
    expect(controller.lanes()).toEqual([{ from: "a", to: "b", size: 2 }, { from: "b", to: "a", size: 1 }])
    expect(heard).toEqual([])
    controller.deliverLane("a", "b")
    expect(heard).toEqual(["one"])
    controller.deliverLane("b", "a")
    expect(mineHeard).toEqual(["back"])
    expect(controller.lanes()).toEqual([{ from: "a", to: "b", size: 1 }])
    // a close drops what is in flight, and the closed end refuses to send
    mine.close()
    expect(controller.lanes()).toEqual([])
    expect(heard).toEqual(["one"])
    expect(() => mine.send("late")).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
    expect(() => theirs!.send("late")).toThrow(expect.objectContaining({ name: "InvalidStateError" }))
  })

  it("flags negotiationneeded on a first data channel, on addTrack and on restartIce, not on a second channel", async () => {
    const a = build("a")
    a.createDataChannel("first")
    expect(controller.negotiationNeeded()).toEqual(["a/1"])
    const fired = vi.fn(async () => {})
    a.onnegotiationneeded = fired
    controller.fireNegotiationNeeded("a/1")
    expect(fired).toHaveBeenCalledTimes(1)
    const offer = a.setLocalDescription()
    controller.resolve("a/1", "sld")
    await offer
    expect(a.localDescription!.sdp).toMatch(/^m=application/m)
    a.createDataChannel("second")
    expect(controller.negotiationNeeded()).toEqual([])
    // the flag shows only while stable
    a.restartIce()
    expect(controller.negotiationNeeded()).toEqual([])
    const back = a.setLocalDescription({ type: "rollback" })
    controller.resolve("a/1", "rollback")
    await back
    expect(controller.negotiationNeeded()).toEqual(["a/1"])
    const tracked = build("a")
    tracked.addTrack({ kind: "video" } as MediaStreamTrack)
    const restarted = build("b")
    restarted.restartIce()
    expect(controller.negotiationNeeded()).toEqual(["a/1", "a/2", "b/1"])
  })

  it("defers negotiationneeded while a remote-offer SRD is queued", async () => {
    const a = build("a")
    const remote = a.setRemoteDescription({ type: "offer", sdp: sdp("b1") })
    a.addTrack({ kind: "video" } as MediaStreamTrack)

    expect(controller.pending()).toEqual([{ pc: "a/1", op: "srd", index: 0 }])
    expect(controller.negotiationNeeded()).toEqual([])

    controller.resolve("a/1", "srd")
    await remote
  })

  it("clears restartIce negotiationneeded when the side sets its own answer", async () => {
    const a = build("a")
    const remote = a.setRemoteDescription({ type: "offer", sdp: sdp("b1") })
    a.restartIce()
    controller.resolve("a/1", "srd")
    await remote

    const answer = a.setLocalDescription()
    controller.resolve("a/1", "sld")
    await answer

    expect(a.localDescription?.type).toBe("answer")
    expect(controller.negotiationNeeded()).toEqual([])
  })

  it("connects a pair only when identities match, opens the offerer's channel and delivers ondatachannel", async () => {
    // a/1 offers twice; b/1 answers the first offer, a/1 applies that answer
    // to its second: the pair never connects
    const a = build("a")
    const b = build("b")
    const sld = a.setLocalDescription()
    controller.resolve("a/1", "sld")
    await sld
    const srd = b.setRemoteDescription(a.localDescription as Desc)
    controller.resolve("b/1", "srd")
    await srd
    const answer = b.setLocalDescription()
    controller.resolve("b/1", "sld")
    await answer
    const undo = a.setLocalDescription({ type: "rollback" })
    controller.resolve("a/1", "rollback")
    await undo
    const second = a.setLocalDescription()
    controller.resolve("a/1", "sld")
    await second
    expect(attr(a.localDescription!.sdp, "x-offer")).toBe("a/1#2")
    const wrong = a.setRemoteDescription(b.localDescription as Desc)
    controller.resolve("a/1", "srd")
    await wrong
    controller.gather("a/1")
    controller.gather("b/1")
    controller.applyBenignNetwork()
    expect([a.connectionState, b.connectionState]).toEqual(["new", "new"])

    // a matching pair connects only once both are gathered
    const c = build("a")
    const d = build("b")
    const channel = c.createDataChannel("jollity") as unknown as FakeChannel
    const events: string[] = []
    c.onconnectionstatechange = () => events.push(`c pc ${c.connectionState}`)
    c.oniceconnectionstatechange = () => events.push(`c ice ${c.iceConnectionState}`)
    d.onconnectionstatechange = () => events.push(`d pc ${d.connectionState}`)
    d.oniceconnectionstatechange = () => events.push(`d ice ${d.iceConnectionState}`)
    channel.onopen = () => events.push(`c open ${channel.readyState}`)
    d.ondatachannel = ({ channel: far }: { channel: FakeChannel }) => events.push(`d datachannel ${far.readyState}`)
    await negotiate(c, d)
    controller.gather("a/2")
    controller.applyBenignNetwork()
    expect(events).toEqual([])
    controller.gather("b/2")
    expect(controller.gathering()).toEqual([])
    controller.applyBenignNetwork()
    expect([c.connectionState, d.connectionState, c.iceConnectionState, d.iceConnectionState]).toEqual(["connected", "connected", "connected", "connected"])
    expect(events).toEqual(["c pc connected", "c ice connected", "d pc connected", "d ice connected", "c open open", "d datachannel open"])
    // applied once
    controller.applyBenignNetwork()
    expect(events).toHaveLength(6)
    expect([a.connectionState, b.connectionState]).toEqual(["new", "new"])
  })

  it("opens a channel the answerer created too, and hands the offerer its far end", async () => {
    const a = build("a")
    const b = build("b")
    const offered = a.createDataChannel("jollity") as unknown as FakeChannel
    const own = b.createDataChannel("jollity") as unknown as FakeChannel // b holds its own (glare, recovery)
    const atA: FakeChannel[] = []
    const atB: FakeChannel[] = []
    a.ondatachannel = ({ channel }: { channel: FakeChannel }) => atA.push(channel)
    b.ondatachannel = ({ channel }: { channel: FakeChannel }) => atB.push(channel)
    await connect(a, b)
    expect([offered.readyState, own.readyState]).toEqual(["open", "open"])
    expect([atA.length, atB.length]).toEqual([1, 1])
    expect([atA[0].readyState, atB[0].readyState]).toEqual(["open", "open"])
    // b's own channel is paired with a's far end
    const heard: unknown[] = []
    ;(atA[0].onmessage as Handler) = ({ data }) => heard.push(data)
    own.send("from b")
    controller.deliverLane("b", "a")
    expect(heard).toEqual(["from b"])
    // closing the incoming end (Mesh's lower-id rule) closes both
    atA[0].close()
    expect(own.readyState).toBe("closed")
  })

  it("opens two owner channels in canonical owner-PC order regardless of creation order", async () => {
    const opened = async (creationOrder: readonly Side[]) => {
      controller = new Controller()
      FakePC.controller = controller
      const a = build("a")
      const b = build("b")
      const pcs = { a, b }
      const events: string[] = []
      for (const side of creationOrder) {
        const channel = pcs[side].createDataChannel("jollity") as unknown as FakeChannel
        channel.onopen = () => events.push(side)
      }
      await connect(a, b)
      return events
    }

    expect(await opened(["a", "b"])).toEqual(["a", "b"])
    expect(await opened(["b", "a"])).toEqual(["a", "b"])
  })

  it("rejects getStats on a closed PC with InvalidStateError", async () => {
    const a = build("a")
    a.close()
    expect(await domName(a.getStats())).toBe("InvalidStateError")
    expect(controller.pendingStats()).toEqual([])
  })

  it("auto-resolves getStats in the step that asked", async () => {
    expect(controller.statsPolicy).toBe("auto")
    const a = build("a")
    const b = build("b")
    const video = { kind: "video", id: "a-camera" } as MediaStreamTrack
    a.addTrack(video)
    await negotiate(a, b)
    const asked = a.getStats()
    expect(controller.pendingStats()).toEqual(["a/1"])
    // settled within the same real turn, i.e. inside the step's drain
    expect(await Promise.race([asked.then(() => "stats"), turn().then(() => "turn")])).toBe("stats")
    expect(controller.pendingStats()).toEqual([])
    // b received a's video (ontrack on its SRD), so its decoded frames grow by 30 a read
    const decoded = async () => {
      const report = await b.getStats() as unknown as Map<string, { type: string; kind?: string; framesDecoded?: number }> | Record<string, { type: string; kind?: string; framesDecoded?: number }>
      const values = report instanceof Map ? [...report.values()] : Object.values(report)
      return values.find((entry) => entry.type === "inbound-rtp" && entry.kind === "video")?.framesDecoded
    }
    const first = await decoded()
    expect(await decoded()).toBe(first! + 30)
  })

  describe("an ICE timeout (a remote peer PC that is gone)", () => {
    afterEach(() => vi.useRealTimers())

    it("fails a PC whose peer PC closed once ICE_FAILED_MS has passed, and never a connected pair", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const woken: number[] = []
      controller.wake = (ms) => woken.push(ms)
      const a = build("a")
      const b = build("b")
      const c = build("a")
      const d = build("b")
      await connect(c, d)
      await negotiate(a, b)
      controller.gather("a/1")
      controller.gather("b/1")
      b.close()
      controller.applyBenignNetwork()
      // a/1 holds b/1's answer and b/1 is gone; the connected pair is left alone
      expect(woken).toEqual([ICE_FAILED_MS])
      expect(controller.iceTimedOut()).toEqual([])
      vi.advanceTimersByTime(ICE_FAILED_MS - 1)
      expect(controller.iceTimedOut()).toEqual([])
      expect(() => controller.failIce("a/1")).toThrow(/no ICE timeout due/)
      vi.advanceTimersByTime(1)
      expect(controller.iceTimedOut()).toEqual(["a/1"])
      const states: string[] = []
      a.oniceconnectionstatechange = () => states.push(a.iceConnectionState)
      controller.failIce("a/1")
      expect(states).toEqual(["failed"])
      expect(a.connectionState).toBe("failed")
      expect(c.connectionState).toBe("connected")
      expect(controller.iceTimedOut()).toEqual([])
    })

    it("enables nothing for a matched pair, connected or not yet", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const woken: number[] = []
      controller.wake = (ms) => woken.push(ms)
      const a = build("a")
      const b = build("b")
      await negotiate(a, b)
      controller.gather("a/1")
      controller.applyBenignNetwork()
      controller.gather("b/1")
      controller.applyBenignNetwork()
      vi.advanceTimersByTime(10 * ICE_FAILED_MS)
      expect(woken).toEqual([])
      expect(controller.iceTimedOut()).toEqual([])
    })
  })

  describe("an outage (env:ice)", () => {
    const decoded = async (pc: FakePC) => {
      const report = await pc.getStats() as unknown as Map<string, { type: string; kind?: string; framesDecoded?: number }> | Record<string, { type: string; kind?: string; framesDecoded?: number }>
      const values = report instanceof Map ? [...report.values()] : Object.values(report)
      return values.find((entry) => entry.type === "inbound-rtp" && entry.kind === "video")?.framesDecoded
    }
    /** a/1 (video, channel) connected to b/1, the channel open */
    async function linked() {
      const a = build("a")
      const b = build("b")
      a.addTrack({ kind: "video", id: "a-camera" } as MediaStreamTrack)
      const channel = a.createDataChannel("jollity") as unknown as FakeChannel
      let far: FakeChannel | undefined
      b.ondatachannel = ({ channel: end }: { channel: FakeChannel }) => { far = end }
      await connect(a, b)
      expect(channel.readyState).toBe("open")
      return { a, b, channel, far: far! }
    }
    /** a restart (or plain renegotiation) from a, gathered on both sides, then the benign network */
    async function renegotiate(a: FakePC, b: FakePC, restart: boolean) {
      if (restart) a.restartIce()
      await negotiate(a, b)
      controller.gather(controller.pcId(a))
      controller.gather(controller.pcId(b))
      controller.applyBenignNetwork()
    }

    it("moves one PC to disconnected or failed and fires both events on it alone", async () => {
      for (const state of ["disconnected", "failed"] as const) {
        const { a, b } = await linked()
        const heard: string[] = []
        a.onconnectionstatechange = () => heard.push(`a conn ${a.connectionState}`)
        a.oniceconnectionstatechange = () => heard.push(`a ice ${a.iceConnectionState}`)
        b.onconnectionstatechange = () => heard.push("b conn")
        b.oniceconnectionstatechange = () => heard.push("b ice")
        controller.setIceState(controller.pcId(a), state)
        expect([a.connectionState, a.iceConnectionState, b.connectionState]).toEqual([state, state, "connected"])
        expect(heard).toEqual([`a conn ${state}`, `a ice ${state}`])
        expect(() => controller.setIceState(controller.pcId(a), state)).toThrow(/not connected/)
        controller.reset()
      }
    })

    it("carries no video frames on either side and no lane frames while the pair is down", async () => {
      const { a, b, channel, far } = await linked()
      const before = await decoded(b)
      expect(await decoded(b)).toBe(before! + 30)
      controller.setIceState(controller.pcId(a), "disconnected")
      const held = await decoded(b)
      expect(await decoded(b)).toBe(held) // b still reads connected, but its link is down
      channel.send("over a dead link")
      far.send("back over it")
      // the frames wait (SCTP retransmits), the lanes are not deliverable
      expect(controller.lanes()).toEqual([])
      expect(() => controller.deliverLane("a", "b")).toThrow(/empty or down/)
      expect(controller.fingerprintState()).toMatchObject({ drops: [{ pair: "a/1|b/1" }] })
      void a
    })

    it("heals a down pair only after an ICE restart, not after a plain renegotiation, and only the down PC hears connected", async () => {
      const { a, b, channel } = await linked()
      const heard: string[] = []
      a.onconnectionstatechange = () => heard.push(`a ${a.connectionState}`)
      b.onconnectionstatechange = () => heard.push(`b ${b.connectionState}`)
      controller.setIceState(controller.pcId(b), "failed")
      channel.send("held")
      await renegotiate(a, b, false)
      expect([a.connectionState, b.connectionState]).toEqual(["connected", "failed"])
      expect(controller.lanes()).toEqual([])
      await renegotiate(a, b, true)
      expect([a.connectionState, b.connectionState]).toEqual(["connected", "connected"])
      expect(heard).toEqual(["b failed", "b connected"])
      // the held frame goes over, frames decode again, and the drop record is gone
      expect(controller.lanes()).toEqual([{ from: "a", to: "b", size: 1 }])
      const now = await decoded(b)
      expect(await decoded(b)).toBe(now! + 30)
      expect(controller.fingerprintState()).toMatchObject({ drops: [] })
    })

    it("never reconnects a pair that was not taken down (a renegotiation of a live pair fires no event)", async () => {
      const { a, b } = await linked()
      const heard: string[] = []
      a.onconnectionstatechange = () => heard.push("a")
      b.onconnectionstatechange = () => heard.push("b")
      await renegotiate(a, b, true)
      expect(heard).toEqual([])
    })
  })

  it("behaves exactly as before with no controller", async () => {
    FakePC.controller = null
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => {})
    FakePC.operationsChain = true
    try {
      const { mesh, pc, signals } = await setupMesh("b", "a")
      expect(vi.isMockFunction(pc.restartIce)).toBe(true)
      pc.iceGatheringState = "gathering"
      const stored = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("111") }, gen: "A.1" } })
      const fresh = mesh.onRtc("a", { rtc: { desc: { type: "offer", sdp: sdp("222") }, gen: "A.2" } })
      await vi.advanceTimersByTimeAsync(30_000)
      await Promise.all([stored, fresh])
      const sent = (signals as { rtc: { desc?: { type: string }; gen?: string } }[]).filter((s) => s.rtc.desc).map((s) => ({ type: s.rtc.desc!.type, gen: s.rtc.gen }))
      expect(sent).toEqual([{ type: "answer", gen: "A.2" }])
      expect(FakePC.last).toHaveLength(2)
      expect(pc.close).toHaveBeenCalled()
      expect(FakePC.last[1].remoteDescription?.sdp).toBe(sdp("222"))
      expect(FakePC.last[1].localDescription?.type).toBe("answer")
      // the channel's send and close are still plain spies
      const channel = FakePC.last[1].channels[0] ?? new FakeChannel()
      expect(vi.isMockFunction(channel.send) && vi.isMockFunction(channel.close)).toBe(true)
      mesh.close()
    } finally {
      FakePC.operationsChain = false
      vi.useRealTimers()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})
