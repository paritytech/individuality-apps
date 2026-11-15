// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The drain's cheaper work counters against the computation they replaced:
 * the PC order kept as PCs register (it was a sort on every read), the fake
 * clock's cached due times, and the transport model's counts. Randomized:
 * synthetic sequences for the clock and the PC order, and random schedules
 * over real rooms for the whole workCounters string, compared at every drain
 * turn.
 */
// quiescence first: it traps the real timers before anything else loads
import { dueTimesOf, installFakeClock } from "./quiescence"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FakePC } from "../../webrtc/test-pc"
import { ControlledPC, Controller } from "./controlled-pc"
import type { Room } from "./room"
import { randomSchedules, rng } from "./random-schedules"
import type { Side } from "../core/labels"

interface Info { side: Side; n: number; id: string; queue: { op: string; index: number; remoteOffer: boolean }[]; negotiationNeeded: boolean }
type Entry = [FakePC, Info]

/** the PC order as it was computed before: a sort by side then n */
const sortedReference = (controller: Controller): Entry[] =>
  [...(controller as unknown as { pcs: Map<FakePC, Info> }).pcs]
    .sort(([, x], [, y]) => (x.side === y.side ? x.n - y.n : x.side < y.side ? -1 : 1))

const sortedNow = (controller: Controller): readonly Entry[] => (controller as unknown as { sorted(): readonly Entry[] }).sorted()

/** room.workCounters() as it was computed before this change */
function workCountersReference(room: Room): string {
  const internals = room as unknown as {
    controller: Controller
    log: { wire: unknown[]; commands: unknown[]; outcomes: unknown[]; accepted: unknown[]; externalFacts: unknown[] }
    model: { deliverable(): unknown[]; inFlight(side: Side): unknown[] }
    meshes: unknown[]
  }
  const controller = internals.controller
  const sorted = sortedReference(controller)
  const parts: (string | number)[] = []
  const pending: string[] = []
  for (const [, info] of sorted) if (info.queue.length > 0) pending.push(`${info.id}:${info.queue[0]!.op}:${info.queue[0]!.index}`)
  parts.push(pending.join(","))
  const gathering = sorted.filter(([pc]) => pc.iceGatheringState === "gathering" && pc.signalingState !== "closed").map(([, info]) => info.id)
  const negotiation = sorted.filter(([pc, info]) =>
    info.negotiationNeeded && pc.signalingState === "stable" && !info.queue.some((item) => item.remoteOffer),
  ).map(([, info]) => info.id)
  parts.push(`g${gathering.join(",")}`, `n${negotiation.join(",")}`, `s${controller.pendingStats().join(",")}`)
  parts.push(`l${controller.lanes().map(({ from, to, size }) => `${from}${to}${size}`).join(",")}`)
  const clock = (Date as unknown as { clock: { timers?: Record<string, { callAt: number }> } }).clock
  parts.push(`t${dueTimesOf(clock.timers).join(",")}`)
  const log = internals.log
  parts.push(`w${log.wire.length}`, `d${internals.model.deliverable().length}`, `i${internals.model.inFlight("a").length},${internals.model.inFlight("b").length}`)
  parts.push(`c${log.commands.length}`, `o${log.outcomes.length}`, `x${log.accepted.length}`, `e${log.externalFacts.length}`)
  for (const mesh of internals.meshes) {
    const meshInternals = mesh as { actorWork: Map<string, Set<unknown>>; answering: Map<string, unknown>; conns: Map<string, { pc: FakePC; channel?: { readyState: string } | null }> }
    let work = 0
    for (const set of meshInternals.actorWork.values()) work += set.size
    parts.push(`m${work}:${meshInternals.answering.size}`)
    for (const conn of meshInternals.conns.values()) parts.push(`${conn.pc.signalingState}:${conn.pc.connectionState}:${conn.pc.iceGatheringState}:${conn.channel?.readyState ?? "-"}`)
  }
  return parts.join("|")
}

afterEach(() => {
  vi.useRealTimers()
  FakePC.controller = null
})

describe("the controller's PC order", () => {
  it("equals a sort by side then n after every registration, over random interleavings and resets", () => {
    const random = rng(1)
    const controller = new Controller()
    FakePC.controller = controller
    let checks = 0
    for (let round = 0; round < 200; round++) {
      if (random() < 0.1) controller.reset()
      const side: Side = random() < 0.5 ? "a" : "b"
      const before = sortedNow(controller)
      const snapshot = [...before]
      controller.building(side, () => new ControlledPC())
      // a caller iterating the old order is not disturbed by a PC built meanwhile
      expect([...before]).toEqual(snapshot)
      expect(sortedNow(controller)).toEqual(sortedReference(controller))
      checks++
    }
    expect(checks).toBe(200)
  })
})

describe("the fake clock's cached due times", () => {
  it("equal the clock's own timers after every set, clear, fire and nested change", () => {
    const random = rng(2)
    const clock = installFakeClock()
    const timers = () => (Date as unknown as { clock: { timers?: Record<string, { callAt: number }> } }).clock.timers
    const live: ReturnType<typeof setTimeout>[] = []
    const check = () => expect(clock.dueTimes()).toEqual(dueTimesOf(timers()))
    const nested = () => {
      check()
      if (random() < 0.5) live.push(setTimeout(() => undefined, Math.floor(random() * 500)))
      if (random() < 0.3 && live.length > 0) clearTimeout(live.splice(Math.floor(random() * live.length), 1)[0])
      check()
    }
    for (let round = 0; round < 2000; round++) {
      const roll = random()
      if (roll < 0.35) live.push(setTimeout(random() < 0.5 ? nested : () => undefined, Math.floor(random() * 1000)))
      else if (roll < 0.45) live.push(setInterval(nested, 1 + Math.floor(random() * 300)))
      else if (roll < 0.6 && live.length > 0) {
        const [handle] = live.splice(Math.floor(random() * live.length), 1)
        if (random() < 0.5) clearTimeout(handle)
        else clearInterval(handle)
      } else if (roll < 0.9 && dueTimesOf(timers()).length > 0) clock.next()
      else if (dueTimesOf(timers()).length > 0) vi.advanceTimersByTime(Math.floor(random() * 200))
      check()
    }
  })
})

describe("the drain's work counters", () => {
  // the anchors with long warmups, the default scenario, and the outage path
  for (const [name, seed] of [["steady", 11], ["rejoin-two-offers", 12], ["mid-glare", 13], ["ice-disconnected", 14]] as const) {
    it(`equal the reference computation at every drain turn over random schedules: ${name}`, async () => {
      let compared = 0
      const mismatches: string[] = []
      const nodes = await randomSchedules(name, { schedules: 6, depth: 10, seed }, (room) => {
        const wrapped = room as unknown as { workCounters(): string; __wrapped?: boolean }
        if (wrapped.__wrapped) return
        const fast = room.workCounters.bind(room)
        wrapped.workCounters = () => {
          const value = fast()
          const reference = workCountersReference(room)
          compared++
          if (value !== reference && mismatches.length < 5) mismatches.push(`${value}\n  !=\n${reference}`)
          return value
        }
        wrapped.__wrapped = true
      })
      expect(mismatches).toEqual([])
      expect(nodes).toBeGreaterThan(6)
      expect(compared).toBeGreaterThan(nodes)
    }, 300_000)
  }
})
