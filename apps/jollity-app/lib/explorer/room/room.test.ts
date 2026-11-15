// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { readAnchorFixture } from "../actor/anchors"
import { canonical, SAT } from "../actor/canon"
import { cloneWorld, setSignaling, type ActorWorld } from "../actor/world"
import { roomBfs } from "./bfs"
import { fairRun, inclusion, localityViolations, quietViolations, recoveryViolations, roomAnchor, rp7Violations, steadyAnchor, steadyPair, steadyRoom } from "./checks"
import { FIELD_CAPS, fullRoomKey, Interner, pairKey, roomKey } from "./key"
import { candidateLabels, connId, deliverable, Edge, initialRoom, refreshNoLaneOther, staleAnswer, statementOfferWithoutLeave, step, walkRoom, type Gen, type Room } from "./model"

/** Times erased: the shared clock gives distances the single actor never sees (design 2.3). */
const timeless = (world: ActorWorld): unknown => {
  const key = JSON.parse(canonical({ ...world, faultsLeft: 0, queue: [] })) as Record<string, Record<string, unknown>>
  for (const part of ["actor", "facts"]) for (const field of Object.keys(key[part]!)) if (/At$/.test(field)) key[part]![field] = "t"
  key.mesh!.tickedAt = "t"
  // the room's halves read frames a different number of times than the actor's fair runs
  key.actor!.framesReadSequence = "r"
  return key
}

describe("the abstract room", () => {
  describe("Mesh fidelity gates", () => {
    const laneAnswerPending = () => walkRoom(roomAnchor(3, "network-all", 1).room, [
      "choice:2:resolved",
      "choice:2:resolved",
      "h:1>2:local-offer-requested",
      "h:1>2:complete:send-offer:lane:resolved",
      "advance:0",
      "lane:1>2:deliver",
      "h:2>1:complete:set-remote-description:lane-offer:resolved",
    ])
    const laneOfferPending = () => walkRoom(roomAnchor(3, "network-all", 1).room, [
      "choice:2:resolved",
      "choice:2:resolved",
      "h:0>1:local-offer-requested",
    ])
    const statementAnswerPending = () => walkRoom(initialRoom(2, 1, false), [
      "hello:0@1",
      "hello:1@0",
      "h:0>1:local-offer-requested",
      "h:0>1:complete:send-offer:statement:resolved",
      "w:0>1:deliver",
      "h:1>0:complete:set-remote-description:statement-offer:resolved",
    ])
    const changedHalf = (room: Room, i: number, j: number, change: (world: ActorWorld) => void): Room => {
      const halves = room.halves.map((row) => [...row])
      const world = cloneWorld(halves[i]![j]!)
      change(world)
      halves[i]![j] = world
      return { ...room, halves }
    }

    it.each([
      [0, ["choice:1:resolved", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:lane:resolved", "lane:0>1:deliver", "h:1>0:local-offer-requested", "h:1>0:complete:set-remote-description:lane-offer:resolved", "h:1>0:complete:send-answer:lane:resolved", "h:1>0:complete:send-offer:lane:resolved", "lane:1>0:deliver", "lane:1>0:deliver", "advance:0"]],
      [3, ["choice:1:resolved", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:lane:resolved", "advance:0", "lane:0>1:deliver", "h:1>0:local-offer-requested", "h:1>0:complete:set-remote-description:lane-offer:resolved", "h:1>0:complete:send-answer:lane:resolved", "h:1>0:complete:send-offer:lane:resolved", "tick:1", "advance:0", "tick:1", "advance:0", "lane:1>0:deliver", "lane:1>0:deliver"]],
    ] as const)("takes a lane offer during a pending lane-answer SRD as Mesh does (#1696), not as glare: room-next Q witness %i reaches steady", (_index, suffix) => {
      // the 6 Nov room-next run: network-all, 2 phones, phone 1 RTX-unsafe, beat on, no lane "other"
      const saved = { beat: process.env.ROOM_BEAT, unsafe: process.env.ROOM_RTX_UNSAFE }
      process.env.ROOM_BEAT = "1"
      process.env.ROOM_RTX_UNSAFE = "1"
      try {
        const room = walkRoom(roomAnchor(2, "network-all", 1).room, [...suffix])
        expect(recoveryViolations(room)).toEqual([])
      } finally {
        for (const [key, value] of [["ROOM_BEAT", saved.beat], ["ROOM_RTX_UNSAFE", saved.unsafe]] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    })

    /** The 6 Nov room-next config: network-all, 2 phones, phone 1 RTX-unsafe, beat on, no lane "other". */
    const roomNext = <T>(body: () => T): T => {
      const saved = { ROOM_BEAT: process.env.ROOM_BEAT, ROOM_RTX_UNSAFE: process.env.ROOM_RTX_UNSAFE, ROOM_NO_LANE_OTHER: process.env.ROOM_NO_LANE_OTHER }
      process.env.ROOM_BEAT = "1"
      process.env.ROOM_RTX_UNSAFE = "1"
      process.env.ROOM_NO_LANE_OTHER = "1"
      refreshNoLaneOther()
      try {
        return body()
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        refreshNoLaneOther()
      }
    }

    it("reads the session of an answer still being set, as Mesh's newSessionOver does (#1777): room-next RP6 witness 13 rebuilds for the new connection's offer", () => {
      roomNext(() => {
        // phone 1's connection 2 is setting phone 0's answer from 1002 when phone 0's rebuilt connection 1003 offers
        const prefix = ["choice:1:resolved", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:lane:resolved", "h:1>0:local-offer-requested", "lane:0>1:deliver", "h:1>0:local-offer-requested", "h:1>0:complete:send-offer:statement:resolved", "w:1>0:deliver", "h:0>1:complete:set-remote-description:statement-offer:resolved", "h:0>1:complete:send-answer:statement:resolved", "w:0>1:deliver", "ph:0:network", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved"]
        let room = roomAnchor(2, "network-all", 1).room
        for (const label of prefix) {
          const next = step(room, label)
          expect(next, label).not.toBeNull()
          expect(next!.edge.violations, label).toEqual([])
          room = next!.room
        }
        expect(room.halves[1]![0]!.meshConnectionEpoch).toBe(2)
        expect(room.extras[1]![0]!.heldRemote).toBeNull()
        expect(room.extras[1]![0]!.srd.map((srd) => srd.from)).toEqual([connId(1, 2)])

        const delivered = step(room, "w:0>1:deliver")!
        expect(delivered.edge.violations).toEqual([])
        // the offer is from another remote connection: 1002 is left and phone 1 takes it on a fresh connection
        expect(delivered.room.extras[1]![0]!.left).toContain(connId(1, 2))
        expect(delivered.room.halves[1]![0]!.meshConnectionEpoch).toBe(3)
        // the witness's next step, the old answer applied on connection 2, is gone with that connection
        expect(step(delivered.room, "h:1>0:complete:set-remote-description:statement-answer:resolved")).toBeNull()
        const overtaken = step(delivered.room, "h:1>0:complete:overtaken")!
        const applied = step(overtaken.room, "h:1>0:complete:set-remote-description:statement-offer:resolved")!
        expect([...overtaken.edge.violations, ...applied.edge.violations]).toEqual([])
      })
    })

    it("completes a statement answer stale only for the answer the alphabet settles (#1786): room-next R witness 29's current answer is not stale", () => {
      roomNext(() => {
        // phone 1 reloaded: connection 1's answer is still pending, and connection 2 has applied phone 0's offer from 1002
        const room = walkRoom(roomAnchor(2, "network-all", 1).room, ["choice:1:resolved", "h:0>1:stats:peer-cannot-see-us", "choice:0:resolved", "h:0>1:local-offer-requested", "advance:0", "ph:1:reload", "w:0>1:deliver", "ice:0>1:lost", "h:1>0:complete:set-remote-description:statement-offer:resolved", "beat:1", "h:0>1:local-offer-requested", "advance-jb:1", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver", "h:1>0:complete:set-remote-description:statement-offer:resolved"])
        expect(room.halves[1]![0]!.pending.filter((entry) => entry.kind === "send-answer").map((entry) => entry.connectionEpoch)).toEqual([1, 2])
        // nothing moved for connection 2's answer: Mesh sends it
        expect(step(room, "h:1>0:complete:send-answer:statement:stale:statement-answer")).toBeNull()
        expect(step(room, "h:1>0:complete:send-answer:statement:stale:statement-answer:displaced")).toBeNull()
        expect(step(room, "h:1>0:complete:send-answer:statement:resolved")).not.toBeNull()
      })
    })

    it.each([
      // d017.w013 RP6: connection 1's answer completes stale after connection 2 took 1002's offer
      ["RP6 d017.w013", ["choice:1:resolved", "advance:1", "ph:1:reload", "w:0>1:deliver", "ice:0>1:lost", "ice:0>1:lost", "h:1>0:complete:set-remote-description:statement-offer:resolved", "tick:0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver", "h:1>0:complete:send-answer:statement:stale:statement-answer", "beat:1", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver", "h:1>0:complete:set-remote-description:statement-offer:resolved"], "h:1>0:complete:set-remote-description:statement-offer:resolved"],
      // d016.w006 RP10: the displaced rejoin's fresh responder applied 2001's offer again
      ["RP10 d016.w006", ["choice:1:resolved", "h:1>0:local-offer-requested", "advance:1", "ph:0:reload", "h:0>1:local-offer-requested", "ice:1>0:lost", "beat:0", "h:1>0:local-offer-requested", "advance-jb:0", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver", "h:1>0:complete:set-remote-description:statement-offer:resolved", "h:1>0:complete:send-offer:statement:resolved", "h:1>0:complete:send-answer:statement:stale:statement-answer:displaced", "h:1>0:complete:set-remote-description:statement-offer:resolved"], "h:1>0:complete:send-answer:statement:stale:statement-answer"],
    ] as const)("ends only the answering entry of the answer's own connection, as endAnswering does: room-next 56beadfa %s no longer reaches its last step and reaches steady", (_name, prefix, last) => {
      roomNext(() => {
        const room = walkRoom(roomAnchor(2, "network-all", 1).room, [...prefix])
        // the new connection still holds the offer it is answering
        expect(room.extras[1]![0]!.answering).not.toBeNull()
        expect(step(room, last)).toBeNull()
        expect(recoveryViolations(room)).toEqual([])
      })
    })

    it("takes #1786's displaced answer as its own outcome: only when our own offer took the connection, and the polite side answers again on a fresh responder", () => {
      const pending = statementAnswerPending()
      const DISPLACED = "h:1>0:complete:send-answer:statement:stale:statement-answer:displaced"
      const STALE = "h:1>0:complete:send-answer:statement:stale:statement-answer"
      // the answer still answers the applied offer (have-remote-offer): neither bail
      expect(pending.halves[1]![0]!.mesh.signaling).toBe("have-remote-offer")
      expect(step(pending, DISPLACED)).toBeNull()
      expect(step(pending, STALE)).toBeNull()

      // our own offer took the connection during the gather: sendStatementAnswer's "displaced", not "stale"
      const offered = changedHalf(pending, 1, 0, (world) => setSignaling(world, "have-local-offer"))
      expect(step(offered, STALE)).toBeNull()
      const displaced = step(offered, DISPLACED)!
      expect(displaced).not.toBeNull()
      // phone 1 is polite: answer-displaced-rejoin, a fresh responder applying phone 0's offer again
      const half = displaced.room.halves[1]![0]!
      expect(half.meshConnectionEpoch).toBe(pending.halves[1]![0]!.meshConnectionEpoch + 1)
      expect(half.pending.filter((entry) => entry.connectionEpoch === half.meshConnectionEpoch).map((entry) => `${entry.kind}:${entry.description}`)).toEqual(["set-remote-description:offer"])

      // the impolite side leaves it to its own offer
      const impolite = changedHalf(offered, 1, 0, (world) => { world.actor = { ...world.actor, initiator: true } })
      expect(step(impolite, DISPLACED)!.room.halves[1]![0]!.meshConnectionEpoch).toBe(pending.halves[1]![0]!.meshConnectionEpoch)
    })

    it("rejects d008.w004's free lane-answer stale, but permits Mesh's epoch, round, and closed-lane causes", () => {
      const pending = laneAnswerPending()
      const label = "h:2>1:complete:send-answer:lane:stale:lane"
      expect(step(pending, label)).toBeNull()

      const reloaded = walkRoom(pending, ["ph:1:reload", "hello:1@2"])
      expect(reloaded.halves[2]![1]!.pending).toHaveLength(1)
      expect(step(reloaded, label)).not.toBeNull()
      expect(step(changedHalf(pending, 2, 1, (world) => { world.actor = { ...world.actor, roundGeneration: world.actor.roundGeneration + 1 } }), label)).not.toBeNull()
      expect(step(changedHalf(pending, 2, 1, (world) => { world.facts.laneOpen = false }), label)).not.toBeNull()
    })

    it("gates lane-offer stale while keeping a crossed remote offer's stale completion", () => {
      const label = "h:0>1:complete:send-offer:lane:stale:lane"
      const pending = laneOfferPending()
      expect(() => walkRoom(pending, [label])).toThrow(`${label} is not enabled`)
      expect(step(changedHalf(pending, 0, 1, (world) => { world.actor = { ...world.actor, roundGeneration: world.actor.roundGeneration + 1 } }), label)).not.toBeNull()
      expect(step(changedHalf(pending, 0, 1, (world) => { world.facts.laneOpen = false }), label)).not.toBeNull()

      const crossed = changedHalf(pending, 0, 1, (world) => {
        const offer = world.pending.find((entry) => entry.kind === "send-offer" && entry.lane)!
        world.pending.push({
          kind: "set-remote-description",
          commandEpoch: offer.commandEpoch + 1,
          connectionEpoch: offer.connectionEpoch,
          lane: true,
          description: "offer",
        })
      })
      expect(step(crossed, label)).not.toBeNull()
    })

    it.each([
      [10, ["choice:2:rejected", "choice:2:resolved", "h:0>1:local-offer-requested", "h:0>2:stats:same", "h:1>0:local-offer-requested", "h:1>0:complete:send-offer:lane:resolved", "lane:1>0:deliver"]],
      [14, ["choice:2:resolved", "choice:2:resolved", "h:1>2:local-offer-requested", "h:2>0:stats:advance", "h:2>1:local-offer-requested", "h:2>1:complete:send-offer:lane:resolved", "lane:2>1:deliver"]],
      [19, ["choice:2:rejected", "choice:2:resolved", "h:0>1:local-offer-requested", "h:0>2:stats:same", "h:1>0:local-offer-requested", "h:1>0:complete:send-offer:lane:resolved", "lane:1>0:deliver"]],
    ] as const)("rejects recount G witness %i's stale lane offer after ignore-offer", (_index, prefix) => {
      const pending = walkRoom(roomAnchor(3, "network-all", 1).room, prefix)
      const [, from, to] = /^lane:(\d+)>(\d+):deliver$/.exec(prefix.at(-1)!)!
      expect(step(pending, `h:${to}>${from}:complete:send-offer:lane:stale:lane`)).toBeNull()
    })

    it("allows statement-answer stale only after its connection or held offer moved", () => {
      const pending = statementAnswerPending()
      const label = "h:1>0:complete:send-answer:statement:stale:statement-answer"
      expect(step(pending, label)).toBeNull()

      const reloaded = walkRoom(pending, ["ph:0:reload", "hello:0@1"])
      expect(step(reloaded, label)).not.toBeNull()
      const extras = pending.extras.map((row) => [...row])
      extras[1]![0] = { ...extras[1]![0]!, inbound: connId(1, 99) }
      expect(step({ ...pending, extras }, label)).not.toBeNull()
    })

    it("treats statement drops as old linked delays and keys only that threshold", () => {
      const base = steadyAnchor(2).room
      const withFrame = (age: number, room: Room = base): Room => {
        const slots = room.slots.map((row) => [...row])
        slots[0]![1] = { kind: "offer", from: connId(1, 1), gen: null, readBy: null, publishedAt: room.now - age } as never
        return { ...room, faultsLeft: 1, slots }
      }
      const label = "w:0>1:drop"
      expect(step(withFrame(30_001, initialRoom(2, 1, false)), label)).toBeNull()
      expect(step(withFrame(30_000), label)).toBeNull()

      const old = withFrame(30_001)
      const older = withFrame(300_000)
      const young = withFrame(29_999)
      expect(step(old, label)).not.toBeNull()
      expect(steadyPair(step(old, label)!.room, 0, 1)).toBe(true)
      expect(pairKey(old, 0, 1)).toBe(pairKey(older, 0, 1))
      expect(pairKey(old, 0, 1)).not.toBe(pairKey(young, 0, 1))
    })

    it("drives both nearest reachable atomic HELLO paths without hitting the claims", () => {
      const statement = statementAnswerPending()
      expect(() => step(statement, "w:0>1:deliver")).not.toThrow()

      const reload = step(steadyAnchor(2).room, "ph:1:reload")!.room
      const next = step(reload, "hello:1@0")
      expect(next).not.toBeNull()
      expect(next!.edge.steps.map(({ event }) => event.type)).toContain("peer-session-changed")
      expect(next!.edge.steps.map(({ event }) => event.type)).toContain("peer-heard")
    })
  })

  it("reaches steady-3 by the fair scheduler, and each steady half matches the actor's steady anchor apart from times", () => {
    const { room } = steadyAnchor(3)
    expect(steadyRoom(room)).toBe(true)
    const initiator = readAnchorFixture("steady-initiator").world
    const answerer = readAnchorFixture("steady-answerer").world
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (i === j) continue
      const half = { ...room.halves[i]![j]!, now: room.now }
      expect(timeless(half), `half ${i}>${j}`).toEqual(timeless(i < j ? initiator : answerer))
    }
  })

  it("keeps every 2-phone half step inside the single-actor graph (inclusion on every edge, from the start and after a reload)", () => {
    const fromStart = roomBfs(initialRoom(2, 1), { depth: 6, maxStates: 200_000, inclusionEvery: 1, probeEvery: 0 })
    expect(fromStart.inclusion.checked).toBeGreaterThan(1000)
    expect(fromStart.inclusion.samples).toEqual([])
    expect(fromStart.inclusion.covered).toBe(fromStart.inclusion.stepped)
    const reload = roomAnchor(2, "reload", 1)
    // phone 1 of two is the answerer: its reload is the after-reload anchor of mesh-pair
    const afterReload = roomBfs(reload.room, { depth: 4, maxStates: 200_000, inclusionEvery: 1, probeEvery: 0 })
    expect(afterReload.inclusion.checked).toBeGreaterThan(1000)
    expect(afterReload.inclusion.samples).toEqual([])
    expect(afterReload.inclusion.covered).toBe(afterReload.inclusion.stepped)
    expect(fromStart.findingCounts).toEqual({})
    expect(afterReload.findingCounts).toEqual({})
  })

  it("records and compares every half a multi-half drain steps, and reports a wrong second half (coverage control)", () => {
    // a network change on phone 0: its half toward 1 stops at its restart choice, the change for its half toward 2 waits behind it
    const network = step(steadyAnchor(3).room, "ph:0:network", { inclusion: true })!
    expect(network.room.phones[0]!.queue.map((entry) => [entry.peer, entry.item.type])).toEqual([[1, "choice"], [2, "event"]])
    const resolved = step(network.room, "choice:0:resolved", { inclusion: true })!
    const stepped = new Set(resolved.edge.steps.map((actorStep) => `${actorStep.phone},${actorStep.peer}`))
    expect([...stepped].sort()).toEqual(["0,1", "0,2"])
    expect(resolved.edge.inclusion.filter((record) => record.steps > 0).map((record) => [`${record.phone},${record.peer}`, record.key, record.kind])).toEqual([
      ["0,1", "complete:restart-ice:resolved", "entry"],
      ["0,2", "network-changed", "drained"],
    ])
    const clean = inclusion(resolved.edge)
    expect(clean).toMatchObject({ checked: 2, stepped: 2, covered: 2, mismatches: [] })
    // a deliberately wrong second half is a mismatch
    const second = resolved.edge.inclusion[1]!
    const wrong = cloneWorld(second.after!)
    wrong.facts.framesSeen += 1
    second.after = wrong
    expect(inclusion(resolved.edge).mismatches.map((mismatch) => [mismatch.peer, mismatch.key])).toEqual([[2, "network-changed"]])
    // and a stepped half with no record is a coverage hole
    resolved.edge.inclusion.splice(1, 1)
    expect(inclusion(resolved.edge).mismatches.map((mismatch) => [mismatch.peer, mismatch.key])).toEqual([[2, "coverage"]])
  })

  it("recovers every 2-phone state to steady with the fair continuation when no fault follows the reload (RP10 on every state)", () => {
    const reload = roomAnchor(2, "reload", 0)
    const result = roomBfs(reload.room, { depth: 4, maxStates: 50_000, probeEvery: 1 })
    expect(result.probes.run).toBe(result.states - 1)
    expect(result.findings).toEqual([])
  })

  it("heals #1562's refused rejoin offer by connectBy, so RP10 comes back clean", () => {
    // the initiator hears the answerer's new session and rebuilds; its statement offer is refused (hard-sdp, one fault).
    // The actor only logs a statement-offer-sent rejection, the rebuilt link reads "new" with everConnected carried over,
    // connectBy applies even though this pair was connected before.
    const reload = roomAnchor(2, "reload", 1)
    const room = walkRoom(reload.room, ["hello:1@0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:rejected:statement-offer-sent:hard-sdp"])
    expect(recoveryViolations(room)).toEqual([])
  })

  describe("the transport's answer gate (statementTransport.ts dispatchDirected)", () => {
    // phone 0 offers, phone 1 answers; the answer waits in the store, unread by phone 0
    const answered = () => walkRoom(initialRoom(2, 1), [
      "hello:0@1",
      "hello:1@0",
      "h:0>1:local-offer-requested",
      "h:0>1:complete:send-offer:statement:resolved",
      "w:0>1:deliver",
      "h:1>0:complete:set-remote-description:statement-offer:resolved",
      "h:1>0:complete:send-answer:statement:resolved",
    ])

    it("an answer carries the gen of the offer it answers, and the offerer's current gen takes it to Mesh", () => {
      const room = answered()
      expect(room.slots[0]![1]!.gen).toEqual({ by: 0, session: 1, n: 1 })
      expect(room.slots[1]![0]).toMatchObject({ kind: "answer", gen: { by: 0, session: 1, n: 1 }, readBy: null })
      expect(room.extras[0]![1]!.out).toEqual({ by: 0, session: 1, n: 1 })
      expect(staleAnswer(room, 1, 0, room.slots[1]![0]!)).toBe(false)
      const next = step(room, "w:1>0:deliver", { inclusion: true })!
      expect(next.edge.gaps).toEqual([])
      expect(next.edge.steps.some(({ phone, event }) => phone === 0 && event.type === "description-observed" && event.description === "answer")).toBe(true)
      expect(inclusion(next.edge).mismatches).toEqual([])
    })

    it("a reloaded page reads its peer's stored answer to its old offer and drops it: the session is admitted, Mesh sees nothing", () => {
      const reloaded = step(answered(), "ph:0:reload")!.room
      expect(reloaded.extras[0]![1]!.out).toBeNull()
      const frame = deliverable(reloaded, 1, 0)!
      expect(frame.kind).toBe("answer")
      expect(staleAnswer(reloaded, 1, 0, frame)).toBe(true)
      const next = step(reloaded, "w:1>0:deliver", { inclusion: true })!
      expect(next.edge.gaps).toEqual([])
      expect(next.edge.steps).toEqual([])
      expect(next.room.halves[0]![1]).toBe(reloaded.halves[0]![1])
      expect(next.room.admitted[0]![1]).toBe(1)
      expect(next.room.slots[1]![0]!.readBy).toBe(2)
      // read once per session, like the dedup: the label is spent
      expect(deliverable(next.room, 1, 0)).toBeNull()
    })

    it("a newer offer of ours makes the answer to the older one stale", () => {
      // phone 0 offers again (its connection rebuilt by a lost link would do the same) before it reads the answer
      const room = answered()
      const extras = room.extras.map((row) => [...row])
      extras[0]![1] = { ...extras[0]![1]!, offers: 2, out: { by: 0, session: 1, n: 2 } }
      expect(staleAnswer({ ...room, extras }, 1, 0, room.slots[1]![0]!)).toBe(true)
    })

    it("keys a gen against one origin across its minter's reload: a shifted counter keeps equal keys and equal successors, ph:*:reload included", () => {
      // phone 0's counter and every gen of its current session moved together by 7: the same room under another representative
      const shifted = (room: Room): Room => {
        const session = room.phones[0]!.session
        const move = (gen: Gen | null): Gen | null => (gen && gen.by === 0 && gen.session === session ? { ...gen, n: gen.n + 7 } : gen)
        return {
          ...room,
          extras: room.extras.map((row, i) => row.map((extra, j) => ({ ...extra, offers: i === 0 && j !== 0 ? extra.offers + 7 : extra.offers, out: move(extra.out), inboundGen: move(extra.inboundGen), answeringGen: move(extra.answeringGen) }))),
          slots: room.slots.map((row) => row.map((frame) => frame && { ...frame, gen: move(frame.gen) })),
        }
      }
      const room = answered()
      const twin = shifted(room)
      expect(twin.extras[0]![1]!.out).toEqual({ by: 0, session: 1, n: 8 })
      expect(fullRoomKey(twin)).toBe(fullRoomKey(room))
      const labels = candidateLabels(room)
      expect(labels).toContain("ph:0:reload")
      expect(labels).toContain("ph:1:reload")
      let compared = 0
      for (const label of labels) {
        const a = step(room, label)
        const b = step(twin, label)
        expect(b === null, label).toBe(a === null)
        if (!a || !b) continue
        expect(fullRoomKey(b.room), label).toBe(fullRoomKey(a.room))
        compared += 1
        // and one step further, past the reload boundary
        for (const after of candidateLabels(a.room)) {
          const c = step(a.room, after)
          const d = step(b.room, after)
          expect(d === null, `${label}, ${after}`).toBe(c === null)
          if (c && d) expect(fullRoomKey(d.room), `${label}, ${after}`).toBe(fullRoomKey(c.room))
        }
      }
      expect(compared).toBeGreaterThan(10)
      // the reload keeps the old session's origin: its stale answer keys the same before and after
      const reloaded = step(room, "ph:0:reload")!.room
      expect(reloaded.extras[0]![1]!.ended).toEqual([{ session: 1, offers: 1 }])
    })

    it("admitting the peer's new session starts it over: the outgoing gen is dropped", () => {
      // phone 1 reloads; phone 0 hears its new session on its hello
      const room = step(answered(), "ph:1:reload")!.room
      expect(room.extras[0]![1]!.out).not.toBeNull()
      const next = step(room, "hello:1@0")!.room
      expect(next.extras[0]![1]!.out).toBeNull()
    })
  })

  describe("the interned key", () => {
    let cache: Room[] | undefined
    const reached = (): Room[] => (cache ??= roomBfs(roomAnchor(3, "reload", 1).room, { depth: 2, maxStates: 5_000, keepRooms: true }).rooms!)

    it("round-trips: equal packed keys exactly when the full texts are equal", () => {
      const interner = new Interner()
      const byPacked = new Map<string, string>()
      const byFull = new Map<string, string>()
      for (const room of reached()) {
        const packed = roomKey(room, interner).key
        const full = fullRoomKey(room)
        expect(byPacked.get(packed) ?? full).toBe(full)
        expect(byFull.get(full) ?? packed).toBe(packed)
        byPacked.set(packed, full)
        byFull.set(full, packed)
        // asking again gives the same ids
        expect(roomKey(room, interner).key).toBe(packed)
      }
      expect(byPacked.size).toBeGreaterThan(100)
    })

    it("is exact over the transport generations: rooms one step past the reached ones that share a key take the same labels to the same keys", () => {
      // successors are not deduplicated, so a key that merged two different gens would show here as two equal keys with different futures
      const groups = new Map<string, Room>()
      let compared = 0
      for (const room of reached().slice(0, 150)) {
        for (const label of candidateLabels(room)) {
          const next = step(room, label)
          if (!next) continue
          const key = fullRoomKey(next.room)
          const twin = groups.get(key)
          if (!twin) {
            groups.set(key, next.room)
            continue
          }
          if (twin === next.room) continue
          for (const after of candidateLabels(next.room)) {
            const a = step(twin, after)
            const b = step(next.room, after)
            expect(b === null, after).toBe(a === null)
            if (a && b) expect(fullRoomKey(b.room), after).toBe(fullRoomKey(a.room))
          }
          compared += 1
        }
      }
      expect(compared).toBeGreaterThan(50)
    })

    it("saturates each time field from its own cap: states equal under the key take equal successors (B3), and a field below its cap stays exact", () => {
      // move every time already at or past its cap a long way further back
      const older = (room: Room): Room => {
        const halves = room.halves.map((row) => row.map((world) => {
          if (!world) return world
          const copy = cloneWorld(world)
          const back = (at: number | null, cap: number) => (at !== null && at !== 0 && room.now - at >= cap ? at - 1_000_000 : at)
          copy.actor = { ...copy.actor, lastSignalAt: back(copy.actor.lastSignalAt, FIELD_CAPS.actor.lastSignalAt), lastAttemptAt: back(copy.actor.lastAttemptAt, FIELD_CAPS.actor.lastAttemptAt) }
          const facts = copy.facts as unknown as Record<string, number | null>
          for (const [field, cap] of Object.entries(FIELD_CAPS.facts)) facts[field] = back(facts[field]!, cap)
          return copy
        }))
        return { ...room, halves }
      }
      let compared = 0
      // a room whose clock moved, so distances pass their caps
      const rooms = reached().filter((room) => room.now > reached()[0]!.now)
      const sample = [...reached().slice(0, 40), ...rooms.slice(0, 40)]
      for (const room of sample) {
        const twin = older(room)
        expect(fullRoomKey(twin)).toBe(fullRoomKey(room))
        for (const label of candidateLabels(room)) {
          const a = step(room, label)
          const b = step(twin, label)
          expect(b === null, label).toBe(a === null)
          if (a && b) {
            expect(fullRoomKey(b.room), label).toBe(fullRoomKey(a.room))
            compared += 1
          }
        }
      }
      expect(compared).toBeGreaterThan(500)
      // negative control: a field moved while below its cap changes the key
      const room = rooms[0] ?? reached()[1]!
      const moved: Room = { ...room, halves: room.halves.map((row) => row.map((world) => world && { ...world, actor: { ...world.actor, lastSignalAt: room.now - 1_000 } })) }
      const again: Room = { ...room, halves: room.halves.map((row) => row.map((world) => world && { ...world, actor: { ...world.actor, lastSignalAt: room.now - 2_000 } })) }
      expect(fullRoomKey(moved)).not.toBe(fullRoomKey(again))
      void SAT
    })
  })

  describe("each room property trips on a hand-built bad state", () => {
    const steady = () => steadyAnchor(3).room

    it("RP1 and RP2: a label changes a half it does not name", () => {
      const room = steady()
      const edge = new Edge(room, false)
      const other = cloneWorld(room.halves[2]![0]!)
      other.facts.framesSeen = 0
      edge.setHalf(2, 0, other)
      expect(localityViolations(room, edge, "h:0>1:stats:same").map((v) => v.property)).toEqual(["RP1"])
      const sibling = new Edge(room, false)
      const same = cloneWorld(room.halves[0]![2]!)
      same.facts.framesSeen = 0
      sibling.setHalf(0, 2, same)
      expect(localityViolations(room, sibling, "h:0>1:stats:same").map((v) => v.property)).toEqual(["RP2"])
      expect(localityViolations(room, sibling, "ph:0:network")).toEqual([])
    })

    it("RP3: an open half disagrees with its phone", () => {
      const room = steady()
      const halves = room.halves.map((row) => [...row])
      halves[1]![2] = { ...halves[1]![2]!, actor: { ...halves[1]![2]!.actor, roundGeneration: 1 } }
      halves[2]![0] = { ...halves[2]![0]!, actor: { ...halves[2]![0]!.actor, hidden: true } }
      const properties = quietViolations({ ...room, halves }).map((v) => v.property)
      expect(properties.filter((p) => p === "RP3").length).toBe(2)
    })

    it("RP4: two initiators on a pair, and a statement offer from the answering half without its leave", () => {
      const room = steady()
      const halves = room.halves.map((row) => [...row])
      halves[2]![1] = { ...halves[2]![1]!, actor: { ...halves[2]![1]!.actor, initiator: true } }
      expect(quietViolations({ ...room, halves }).map((v) => v.property)).toContain("RP4")
      const offer = { kind: "send-offer" as const, lane: false, commandEpoch: 1, connectionEpoch: 1 }
      expect(statementOfferWithoutLeave(false, false, offer)).toBe(true)
      expect(statementOfferWithoutLeave(false, true, offer)).toBe(false)
      expect(statementOfferWithoutLeave(true, false, offer)).toBe(false)
      expect(statementOfferWithoutLeave(false, false, { ...offer, lane: true })).toBe(false)
    })

    it("RP6: one connection applies descriptions from two remote connections", () => {
      // two phones from the start: phone 1 has phone 0's offer pending on its connection
      const room = walkRoom(initialRoom(2, 1), ["hello:0@1", "hello:1@0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver"])
      const extras = room.extras.map((row) => [...row])
      extras[1]![0] = { ...extras[1]![0]!, heldRemote: connId(7, 1) }
      const next = step({ ...room, extras }, "h:1>0:complete:set-remote-description:statement-offer:resolved")
      expect(next!.edge.violations.map((v) => v.property)).toEqual(["RP6"])
      expect(step(room, "h:1>0:complete:set-remote-description:statement-offer:resolved")!.edge.violations).toEqual([])
    })

    it("RP7: a pair without the reloaded phone restarts on a fact that is not a stats read", () => {
      const room = steady()
      const edge = new Edge(room, false)
      edge.commands.push({ phone: 0, peer: 2, command: { kind: "restart-ice", cause: "soft-disconnect", commandEpoch: 9, connectionEpoch: 1 }, event: { type: "supervisor-tick" } as never })
      expect(rp7Violations(edge, { ...room, faultsLeft: 1 }, { reloaded: 1, faults: 1 }).map((v) => v.property)).toEqual(["RP7"])
      // a stall heal is network weather, and a fault past the anchor excuses it
      edge.commands[0]!.event = { type: "stats-observed" } as never
      expect(rp7Violations(edge, { ...room, faultsLeft: 1 }, { reloaded: 1, faults: 1 })).toEqual([])
      edge.commands[0]!.event = { type: "supervisor-tick" } as never
      expect(rp7Violations(edge, { ...room, faultsLeft: 0 }, { reloaded: 1, faults: 1 })).toEqual([])
    })

    it("RP10: a room whose transport refuses a phone's frames never recovers", () => {
      const reload = roomAnchor(3, "reload", 1).room
      expect(recoveryViolations(reload)).toEqual([])
      // phone 2 believes phone 1 has a newer session than it does: nothing from phone 1 is ever delivered to it
      const admitted = reload.admitted.map((row) => [...row])
      admitted[2]![1] = 99
      expect(recoveryViolations({ ...reload, admitted }).map((v) => v.property)).toEqual(["RP10"])
      expect(fairRun({ ...reload, admitted }).steady).toBe(false)
    })

    it("RP10: the fair scheduler fires the no-video deadline when only it heals the pair", () => {
      const pending = walkRoom(initialRoom(2, 0, true), [
        "h:0>1:local-offer-requested",
        "h:0>1:complete:send-offer:statement:resolved",
        "w:0>1:deliver",
        "h:1>0:complete:set-remote-description:statement-offer:resolved",
        "h:1>0:complete:send-answer:statement:resolved",
        "w:1>0:deliver",
        "h:0>1:complete:set-remote-description:statement-answer:resolved",
        "ice:0-1:up",
        "beat:0",
        "beat:1",
        "advance:0",
        "chan:0-1:open",
        "h:0>1:local-offer-requested",
      ])
      // Mesh can return stale when the round moves while the lane offer is pending.
      const halves = pending.halves.map((row) => [...row])
      const world = cloneWorld(halves[0]![1]!)
      world.actor = { ...world.actor, roundGeneration: world.actor.roundGeneration + 1 }
      halves[0]![1] = world
      const room = step({ ...pending, halves }, "h:0>1:complete:send-offer:lane:stale:lane")!.room
      const deadline = "h:0>1:stats:no-video-deadline"
      const healed = step(room, deadline)!

      expect(healed.edge.commands).toEqual([
        expect.objectContaining({ command: expect.objectContaining({ kind: "replace-connection", cause: "connected-no-video" }) }),
      ])
      expect(fairRun(healed.room).steady).toBe(true)

      const run = fairRun(room)
      expect(run.labels).toContain(deadline)
      expect(run.steady).toBe(true)
    })
  })

  describe("the codec guard on an RTX-unsafe phone (#559; model.ts codecGuard)", () => {
    // cold start to phone 0's lane offer pending, its channel open (the fair run's first 12 labels)
    const toLaneOffer = [
      "hello:0@1", "hello:1@0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver",
      "h:1>0:complete:set-remote-description:statement-offer:resolved", "h:1>0:complete:send-answer:statement:resolved", "w:1>0:deliver",
      "h:0>1:complete:set-remote-description:statement-answer:resolved", "ice:0-1:up", "chan:0-1:open", "h:0>1:local-offer-requested",
    ]
    const offering = (unsafe: number[]) => walkRoom(initialRoom(2, 2, false, unsafe), toLaneOffer)
    const enabled = (room: Room, prefix: string) => candidateLabels(room).filter((label) => label.startsWith(prefix) && step(room, label) !== null)
    const GUARD = "h:0>1:codec-guard-rtx"
    const OFFER = "h:0>1:complete:send-offer:lane:"

    it("is a choice on an unsafe phone only, keyed apart from a safe one", () => {
      expect(step(offering([]), GUARD)).toBeNull()
      expect(enabled(offering([0]), "h:0>1:").filter((label) => label === GUARD || label.startsWith(OFFER))).toEqual([
        `${OFFER}resolved`, `${OFFER}rejected:lane:hard-sdp`, `${OFFER}rejected:lane:other`, GUARD,
      ])
      // not a fault: the budget is untouched
      expect(step(offering([0]), GUARD)!.fault).toBe(false)
      expect(roomKey(offering([0]), new Interner())).not.toBe(roomKey(offering([]), new Interner()))
    })

    it("issues the actor's rollback and send-offer, and settles rollback, guard offer, guarded offer in Mesh's order with one lane frame", () => {
      const guarded = step(offering([0]), GUARD)!
      expect(guarded.edge.commands.map(({ command }) => `${command.kind}:${"cause" in command ? command.cause : "lane"}`)).toEqual(["rollback:codec-guard", "send-offer:lane"])
      // the guard's offer and the guarded one wait for the rollback (guardOfferForActor 4212, offerOnLane 4204)
      expect(enabled(guarded.room, "h:0>1:complete:")).toEqual(["h:0>1:complete:rollback:resolved", "h:0>1:complete:rollback:rejected:lane:hard-sdp", "h:0>1:complete:rollback:rejected:lane:other"])
      const rolled = walkRoom(guarded.room, ["h:0>1:complete:rollback:resolved"])
      expect(enabled(rolled, OFFER)).toEqual([`${OFFER}resolved`, `${OFFER}rejected:lane:hard-sdp`, `${OFFER}rejected:lane:other`])
      // the guard's stripped offer settles first and sends nothing
      const stripped = step(rolled, `${OFFER}resolved`)!
      expect(stripped.room.lanes[0]![1]).toEqual([])
      expect(stripped.room.halves[0]![1]!.pending.map((entry) => entry.cause ?? "lane")).toEqual(["lane"])
      // then the guarded offer: resolved only, and its one frame goes out
      expect(enabled(stripped.room, OFFER)).toEqual([`${OFFER}resolved`])
      const sent = step(stripped.room, `${OFFER}resolved`)!.room
      expect(sent.lanes[0]![1]!.map((frame) => frame.kind)).toEqual(["offer"])
      expect(sent.extras[0]![1]!.guard).toBeUndefined()
      expect(sent.halves[0]![1]!.mesh.codecGuard).toBe(false)
      expect(fairRun(sent).steady).toBe(true)
    })

    it("leaves the guarded offer stale, with no frame, when the rollback or the stripped offer fails", () => {
      const guarded = walkRoom(offering([0]), [GUARD])
      for (const [rollback, guardOffer] of [
        ["h:0>1:complete:rollback:rejected:lane:other", `${OFFER}stale:lane`],
        ["h:0>1:complete:rollback:resolved", `${OFFER}rejected:lane:hard-sdp`],
      ] as const) {
        const rolled = walkRoom(guarded, [rollback])
        // a failed rollback leaves the guard's offer only its stale bail (4212)
        if (rollback.includes("rejected")) expect(enabled(rolled, OFFER)).toEqual([`${OFFER}stale:lane`])
        const failed = walkRoom(rolled, [guardOffer])
        expect(enabled(failed, OFFER)).toEqual([`${OFFER}stale:lane`])
        const done = walkRoom(failed, [`${OFFER}stale:lane`])
        expect(done.lanes[0]![1]).toEqual([])
        expect(done.halves[0]![1]!.pending).toEqual([])
        expect(done.halves[0]![1]!.mesh.codecGuard).toBe(false)
      }
    })

    it("drops every charged lane rejection with reason other under ROOM_NO_LANE_OTHER=1, the guard's own included", () => {
      process.env.ROOM_NO_LANE_OTHER = "1"
      refreshNoLaneOther()
      try {
        expect(enabled(offering([0]), "h:0>1:").filter((label) => label === GUARD || label.startsWith(OFFER))).toEqual([`${OFFER}resolved`, `${OFFER}rejected:lane:hard-sdp`, GUARD])
        const guarded = walkRoom(offering([0]), [GUARD])
        expect(enabled(guarded, "h:0>1:complete:")).toEqual(["h:0>1:complete:rollback:resolved", "h:0>1:complete:rollback:rejected:lane:hard-sdp"])
        expect(enabled(walkRoom(guarded, ["h:0>1:complete:rollback:resolved"]), OFFER)).toEqual([`${OFFER}resolved`, `${OFFER}rejected:lane:hard-sdp`])
      } finally {
        delete process.env.ROOM_NO_LANE_OTHER
        refreshNoLaneOther()
      }
      expect(enabled(offering([0]), OFFER)).toContain(`${OFFER}rejected:lane:other`)
    })

    it("leaves an all-safe room's labels exactly as before the guard (tiled paths are label positions)", () => {
      // sha256 of candidateLabels(initialRoom(n, 1, false)).join("\n"), taken at the PR's base; re-taken
      // for #1786's statement-answer outcomes and #1797's distinct displaced key
      const pin = (n: number) => { const labels = candidateLabels(initialRoom(n, 1, false)); return [labels.length, createHash("sha256").update(labels.join("\n")).digest("hex").slice(0, 16)] }
      expect(pin(2)).toEqual([121, "3844cde08d225469"])
      expect(pin(3)).toEqual([348, "b6c2e05ffa4d61e5"])
      // an unsafe phone adds its guard label per half, after that half's own labels
      expect(candidateLabels(initialRoom(2, 1, false, [1])).filter((label) => !candidateLabels(initialRoom(2, 1, false)).includes(label))).toEqual(["h:1>0:codec-guard-rtx"])
    })

    it("lets the stripped offer resolve or go stale when a remote lane offer crossed it (as a plain lane offer may)", () => {
      const rolled = walkRoom(offering([0]), [GUARD, "h:0>1:complete:rollback:resolved"])
      expect(enabled(rolled, OFFER)).not.toContain(`${OFFER}stale:lane`)
      const halves = rolled.halves.map((row) => [...row])
      const world = cloneWorld(halves[0]![1]!)
      world.mesh.signaling = "have-remote-offer"
      halves[0]![1] = world
      expect(enabled({ ...rolled, halves }, OFFER).sort()).toEqual([`${OFFER}rejected:lane:hard-sdp`, `${OFFER}rejected:lane:other`, `${OFFER}resolved`, `${OFFER}stale:lane`])
    })

    it("drops the guard with its connection when a refused stripped offer replaces it", () => {
      const refused = step(walkRoom(offering([0]), [GUARD, "h:0>1:complete:rollback:resolved"]), `${OFFER}rejected:lane:hard-sdp`)!.room
      const half = refused.halves[0]![1]!
      expect(half.meshConnectionEpoch).toBeGreaterThan(1)
      expect(refused.extras[0]![1]!.guard).toBeUndefined()
    })

    it("guards a lane offer at most once", () => {
      const rolled = walkRoom(offering([0]), [GUARD, "h:0>1:complete:rollback:resolved", `${OFFER}resolved`])
      expect(step(rolled, GUARD)).toBeNull()
    })
  })
})
