// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * T15's differential against T3's room: every event the real flag-on Mesh
 * delivered to an actor on the slice-1 scenarios' fair runs is rebuilt by the
 * world's alphabet, in lockstep, and must issue the same commands. An event
 * no entry rebuilds, or rebuilds with other commands, is an alphabet gap.
 */
// quiescence first: it traps the real timers before anything else loads
import "../mesh/quiescence"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createPeerActorState, stepPeerActor, type PeerActorEvent, type PeerActorState } from "../../state-machines/peer-actor"
import { isFault, type Label, type Side } from "../core/labels"
import { fairPick } from "../mesh/fair"
import { exploreRoom, type Room, type ScenarioName } from "../mesh/room"
import { ALPHABET } from "./alphabet"
import { shape } from "./shape"
import { commandLabel, successor } from "./bfs"
import { freshBook, freshFacts, ROOM, type ActorWorld } from "./world"

const consoleLog = console.log
const PHASE_OFFSET_MS = 1000
const consoleWarn = console.warn

/** The room's actor at its start (startActor, after setRound(1)): its first
 *  connection starts at Mesh's monoNow() then (performance.now() + 1), and b
 *  starts the phase offset later. */
function startActor(side: Side): PeerActorState {
  const connectingSince = side === "a" ? 1 : 1 + PHASE_OFFSET_MS
  const state = createPeerActorState({ game: ROOM.game, roomEpoch: ROOM.roomEpoch, peer: side === "a" ? "b" : "a" }, { initiator: side === "a", standby: false, cameraLive: true, connectionEpoch: 1, connectingSince })
  return { ...state, roundGeneration: 1 }
}

function startWorld(side: Side, actor: PeerActorState, now: number): ActorWorld {
  const initiator = side === "a"
  return { actor, meshConnectionEpoch: 1, now, facts: freshFacts({}, initiator), pending: [], nextReadSequence: 1, faultsLeft: 99, queue: [], mesh: freshBook(initiator) }
}

const eventTime = (event: PeerActorEvent): number | undefined => (event.type === "clock" ? event.now : event.now ?? ("at" in event && typeof event.at === "number" ? event.at : undefined))

export interface Gap { scenario: ScenarioName; side: Side; index: number; shape: string; why: string }

/** The events the room's actor took on one side, in order, checked against the alphabet. */
function differential(scenario: ScenarioName, side: Side, events: PeerActorEvent[]): { gaps: Gap[]; matched: number } {
  const gaps: Gap[] = []
  let actor = startActor(side)
  let world = startWorld(side, actor, 0)
  let matched = 0
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    const real = stepPeerActor(actor, event)
    const time = eventTime(event)
    if (time !== undefined && time > world.now) world = { ...world, now: time }
    const want = shape(event)
    let found = false
    // the entry whose drain takes the most of the room's events: a statement
    // description's drain starts with onSignal's peer-heard, which a lone
    // peer-heard entry (markSeen's) would otherwise take first
    let best: { edge: NonNullable<ReturnType<typeof successor>>; rest: number } | null = null
    for (const entry of ALPHABET) {
      const edge = successor(world, entry)
      const first = edge?.steps[0]
      if (!edge || !first || shape(first.event) !== want) continue
      if (first.result.commands.map(commandLabel).join() !== real.commands.map(commandLabel).join()) continue
      // the drain's later steps must be the room's next events
      const rest = edge.steps.slice(1)
      if (rest.some((step, k) => !events[index + 1 + k] || shape(step.event) !== shape(events[index + 1 + k]!))) continue
      if (!best || rest.length > best.rest) best = { edge, rest: rest.length }
    }
    if (best) {
      let after = real.state
      for (let k = 0; k < best.rest; k++) after = stepPeerActor(after, events[++index]!).state
      actor = after
      world = best.edge.world
      found = true
      matched += 1 + best.rest
    }
    if (!found) {
      const built = ALPHABET.map((entry) => successor(world, entry)?.steps[0]).filter((step) => step && shape(step.event) === want)
      gaps.push({ scenario, side, index, shape: want, why: built.length === 0 ? "no entry builds it in this world" : "built, with other commands or another drain" })
    }
    if (!found) actor = real.state
    // the room's actor is the truth: the world follows it, keeping its own facts
    world = { ...world, actor }
    if (actor.connectionEpoch !== world.meshConnectionEpoch && event.type === "connection-replaced-externally") world = { ...world, meshConnectionEpoch: actor.connectionEpoch }
  }
  return { gaps, matched }
}

async function fairRun(room: Room, max: number): Promise<Label[]> {
  const since = new Map<Label, number>()
  const taken: Label[] = []
  while (taken.length < max) {
    const enabled = room.enabled()
    for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
    for (const label of enabled) if (!since.has(label)) since.set(label, taken.length)
    if (enabled.filter((label) => !isFault(label)).length === 0) break
    const label = fairPick(enabled, since)
    await room.step(label)
    taken.push(label)
  }
  return taken
}

describe("slice 3 against the room", () => {
  beforeAll(() => {
    console.log = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.log = consoleLog
    console.warn = consoleWarn
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("rebuilds each actor event the room accepted through ALPHABET.build and gets the same commands, or reports an alphabet gap", async () => {
    const gaps: Gap[] = []
    let total = 0
    let matched = 0
    for (const scenario of ["single-offer", "rejoin-two-offers"] as const) {
      const room = await exploreRoom({ scenario, phaseOffsetMs: PHASE_OFFSET_MS })
      try {
        await fairRun(room, 60)
        for (const side of ["a", "b"] as const) {
          const events = room.logs().accepted.filter((entry) => entry.side === side && entry.kind === "accepted").map((entry) => entry.event as PeerActorEvent)
          // the replay from the start reaches the room's own actor
          let replayed = startActor(side)
          for (const event of events) replayed = stepPeerActor(replayed, event).state
          expect(replayed, `${scenario} ${side}`).toEqual(room.internals(side).runner!.state(side === "a" ? "b" : "a"))
          const result = differential(scenario, side, events)
          total += events.length
          matched += result.matched
          gaps.push(...result.gaps)
        }
      } finally {
        room.close()
      }
    }
    consoleLog(`room differential: ${matched} of ${total} accepted events rebuilt with the same commands; gaps: ${JSON.stringify(gaps, null, 1)}`)
    expect(total).toBeGreaterThan(10)
    expect(gaps).toEqual([])
  })
})
