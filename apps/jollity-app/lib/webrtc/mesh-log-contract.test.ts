// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The recovery lines a reader of exported game logs parses
 * (PARSER_VISIBLE_RTC_LOG_CONTRACT in legacy-decision-capture.ts; the
 * "(attempt n)" and "(heal n)" counters read as the recovery budget), pinned
 * word for word for a known count sequence of each ladder, with the base of
 * each heal record (rtc.heal_ms runs from the attempt's instant).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { encodeView, encodeViewFrame } from "./link-view"
import type { HealEvent } from "./heal"
import { chromeStats } from "./test-stats"
import { FakeChannel, FakePC, sdp, setupMesh } from "./test-pc"

const live = { readyState: "live" }
const camera = { getVideoTracks: () => [live], getTracks: () => [] }
const RECOVERY = /self-heal|media-stall|unseen|first-contact offer/

const state = (pc: FakePC, next: RTCPeerConnectionState) => {
  pc.connectionState = next
  pc.onconnectionstatechange!()
}
const frames = (pc: FakePC, decoded: number) => {
  pc.stats = chromeStats({ t: 1000 + decoded, decoded, lost: 0, received: 10, bytesSent: 0, freezes: 0, cpu: 0 })
}
const offer = (body: string) => ({ rtc: { desc: { type: "offer", sdp: body } } }) as never
const answer = (body: string) => ({ rtc: { desc: { type: "answer", sdp: body } } }) as never

/** every rtcLog line of the recovery ladders, as the debug sheet joins it */
function recoveryLines(): string[] {
  const lines: string[] = []
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    const line = parts.map((part) => (typeof part === "string" ? part : String(part))).join(" ")
    if (line.startsWith("[jollity-rtc]") && RECOVERY.test(line)) lines.push(line)
  })
  return lines
}

async function healed(myId: string, peerId: string, local?: unknown, members?: string[]) {
  const heals: HealEvent[] = []
  const made = await setupMesh(myId, peerId, { ...(members ? { members } : {}), onRtcEvent: (_peer, { kind, ...event }) => kind === "heal" && heals.push(event as HealEvent) }, local)
  return { ...made, heals }
}

describe("the recovery lines a log reader parses, for a known count sequence", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("a dropped link: an ICE restart (attempt 1), then rebuilds (attempt 2, 3), each heal timed from its attempt", async () => {
    const lines = recoveryLines()
    const { mesh, pc, heals } = await healed("a", "b")
    const restartAt: number[] = []
    pc.restartIce.mockImplementation(() => { restartAt.push(performance.now()) })
    pc.channels[0]!.readyState = "open"
    state(pc, "connected")
    state(pc, "disconnected")
    for (let i = 0; i < 4; i++) {
      mesh.markSeen("b")
      await vi.advanceTimersByTimeAsync(3000)
    }
    expect(restartAt).toHaveLength(1)
    expect(FakePC.last).toHaveLength(2) // the restart's backoff ran out: rebuilt
    const second = FakePC.last[1]!
    state(second, "failed")
    for (let i = 0; i < 4; i++) {
      mesh.markSeen("b")
      await vi.advanceTimersByTimeAsync(3000)
    }
    expect(FakePC.last).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1234)
    state(FakePC.last[2]!, "connected")
    expect(lines).toEqual([
      "[jollity-rtc] self-heal: ICE restart b (attempt 1)",
      "[jollity-rtc] self-heal: rebuild b (attempt 2)",
      "[jollity-rtc] self-heal: rebuild b (attempt 3)",
    ])
    expect(heals.map((event) => [event.trigger, event.action, event.attempt, event.healed, event.end])).toEqual([
      ["disconnected", "ice_restart", 1, false, "next_attempt"],
      ["disconnected", "rebuild", 2, false, "next_attempt"],
      ["failed", "rebuild", 3, true, "connected"],
    ])
    // each record runs from its attempt's instant, the sweep that made it:
    // the restart's until the rebuild one backoff later, the last rebuild's
    // (made on the last sweep) until it connects
    expect(heals[0]!.healMs).toBe(6000)
    expect(heals.at(-1)!.healMs).toBe(1234)
    mesh.close()
  })

  it("an offer left unanswered: connectBy rebuilds as offerer without changing the attempt line", async () => {
    const lines = recoveryLines()
    const create = FakePC.prototype.createDataChannel
    vi.spyOn(FakePC.prototype, "createDataChannel").mockImplementation(function (this: FakePC, label: string, options?: RTCDataChannelInit) {
      const channel = create.call(this, label, options)
      if (this.channels.length === 1) queueMicrotask(() => void this.onnegotiationneeded?.())
      return channel
    })
    const { mesh, pc, heals } = await healed("a", "b")
    await vi.advanceTimersByTimeAsync(0)
    await mesh.onRtc("b", answer(sdp("111")))
    state(pc, "connected")
    state(pc, "failed")
    await vi.advanceTimersByTimeAsync(3100)
    expect(FakePC.last).toHaveLength(2)
    for (let i = 0; i < 6; i++) {
      await mesh.onRtc("b", offer(sdp("222")))
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(FakePC.last).toHaveLength(3)
    const third = FakePC.last[2]!
    await mesh.onRtc("b", offer(sdp("222")))
    await vi.advanceTimersByTimeAsync(0)
    const channel = new FakeChannel()
    channel.readyState = "open"
    ;(third.ondatachannel as (event: { channel: FakeChannel }) => void)({ channel })
    await vi.advanceTimersByTimeAsync(777)
    state(third, "connected")
    expect(lines).toEqual([
      "[jollity-rtc] self-heal: rebuild b (attempt 1)",
      "[jollity-rtc] self-heal: rebuild b (attempt 1)",
    ])
    expect(heals.map((event) => [event.trigger, event.action, event.attempt, event.end])).toEqual([
      ["failed", "rebuild", 1, "next_attempt"],
      ["never_connected", "rebuild", 2, "connected"],
    ])
    // the yield's record runs from the sweep that yielded, 100 ms before the
    // last advance ended (sweeps fall every 3 s from the mesh's start)
    expect(heals[1]!.healMs).toBe(100 + 777)
    mesh.close()
  })

  it("a video that stops: one ICE restart (heal 1), then a rebuild (heal 2, attempt 1) (#1523 F5)", async () => {
    const lines = recoveryLines()
    const { mesh, pc, heals } = await healed("a", "b", camera)
    state(pc, "connected")
    frames(pc, 50)
    await vi.advanceTimersByTimeAsync(4000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(FakePC.last).toHaveLength(2)
    expect(lines).toEqual([
      "[jollity-rtc] media-stall: connected but no inbound video → ICE restart (heal 1) b",
      "[jollity-rtc] media-stall: connected but no inbound video → rebuild (heal 2) b",
      "[jollity-rtc] self-heal: rebuild b (attempt 1)",
    ])
    expect(heals.map((event) => [event.trigger, event.action, event.attempt, event.end])).toEqual([
      ["media_stall", "ice_restart", 1, "next_attempt"],
    ])
    // the restart's record runs from its own sweep to the rebuild's
    expect(heals.map((event) => event.healMs)).toEqual([12000])
    mesh.close()
  })

  it("the peer cannot see us: one ICE restart, the last until the peer leaves (#1523 F5)", async () => {
    const lines = recoveryLines()
    const ROOM = ["a", "b", "c"]
    const { mesh, pc } = await healed("a", "b", camera, ROOM)
    pc.channels[0]!.readyState = "open"
    state(pc, "connected")
    const tell = (row: string) => (pc.channels[0]!.onmessage as (e: { data: unknown }) => void)({ data: encodeViewFrame(row).buffer })
    for (let i = 0; i < 20; i++) {
      tell(encodeView(ROOM, (m) => ({ a: "2", b: "-", c: "0" } as Record<string, "-" | "0" | "2">)[m]!))
      frames(pc, 30 * (i + 1))
      await vi.advanceTimersByTimeAsync(4_000)
    }
    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(lines).toEqual([
      "[jollity-rtc] unseen: signalingState=stable the peer says it decodes none of our video → ICE restart, the last until this peer leaves b",
    ])
    mesh.close()
  })
})
