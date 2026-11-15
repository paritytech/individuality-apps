// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { armDeadlines, stepPeerActor, type PeerActorEvent } from "../../state-machines/peer-actor"
import { decideFromTick, snapshotOf, withTimes } from "../../state-machines/peer-actor.test-helper"
import { peerMutationProbes, peerScenarios } from "../../state-machines/peer.definition"
import { ALPHABET } from "./alphabet"
import { bfs, collisionBound, hash64, ShardedIndex, fairWorlds, FAIR_RUNS, seedWorlds, successor, type Stepper } from "./bfs"
import { canonical, DOMAIN, normaliseCommands, outOfDomain, SAT } from "./canon"
import { ACTOR_MUTATIONS } from "./mutations"
import { formatLayerProgress } from "./run"
import { cloneWorld, initialWorlds, nextDeadline, START_NOW, tickEvent, type ActorWorld, type Queued } from "./world"

const answerer = (): ActorWorld => cloneWorld(initialWorlds()[1]!.world)
const initiator = (): ActorWorld => cloneWorld(initialWorlds()[0]!.world)
const entry = (key: string) => ALPHABET.find((candidate) => candidate.key === key)!

/** A deterministic generator, so a failing pair can be replayed. */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shiftEvent = (event: PeerActorEvent, connection: number, command: number, read: number): PeerActorEvent => {
  const out: Record<string, unknown> = { ...event, connectionEpoch: event.connectionEpoch + connection }
  if ("commandEpoch" in event) out.commandEpoch = event.commandEpoch + command
  if ("readSequence" in event) out.readSequence = event.readSequence + read
  return out as unknown as PeerActorEvent
}

/** The same world with every connection epoch, command epoch and read sequence moved by a constant. */
function shiftEpochs(world: ActorWorld, connection: number, command: number, read: number): ActorWorld {
  const next = cloneWorld(world)
  const actor = world.actor
  next.actor = {
    ...actor,
    connectionEpoch: actor.connectionEpoch + connection,
    commandEpoch: actor.commandEpoch + command,
    openCommands: Object.fromEntries(Object.entries(actor.openCommands).map(([kind, epoch]) => [kind, (epoch as number) + command])),
    framesReadSequence: actor.framesReadSequence + read,
  }
  next.meshConnectionEpoch += connection
  next.nextReadSequence += read
  next.pending = next.pending.map((entry) => ({ ...entry, commandEpoch: entry.commandEpoch + command, connectionEpoch: entry.connectionEpoch + connection }))
  next.queue = next.queue.map((item): Queued => item.type === "event" ? { type: "event", event: shiftEvent(item.event, connection, command, read) } : item.type === "choice" ? { type: "choice", command: { ...item.command, commandEpoch: item.command.commandEpoch + command, connectionEpoch: item.command.connectionEpoch + connection } } : item)
  if (next.mesh.refusedEpoch !== null) next.mesh.refusedEpoch += connection
  return next
}

/** the actor's own recovery times (design B, B1) */
const ACTOR_TIMES = ["upAt", "connectingSince", "downAt", "disconnectedAt", "firstHeardAt", "lastRecvDescAt", "offerSentAt", "yieldedAt"] as const

/** Every time, `now` included, moved by a constant: absolute times are not in the key. */
function shiftTime(world: ActorWorld, by: number): ActorWorld {
  const next = cloneWorld(world)
  const move = (at: number | null) => (at === null ? null : at + by)
  const moveSentinel = (at: number) => (at === 0 ? 0 : at + by)
  next.now += by
  next.actor = { ...world.actor, lastSignalAt: move(world.actor.lastSignalAt), lastAttemptAt: move(world.actor.lastAttemptAt) }
  for (const field of ACTOR_TIMES) next.actor[field] = move(world.actor[field])
  next.actor.deadlines = armDeadlines(next.actor)
  for (const field of ["lastSignalAt", "firstHeardAt", "lastRecvDescAt", "offerSentAt", "yieldedAt"] as const) next.facts[field] = move(world.facts[field] ?? null)
  for (const field of ["upAt", "downAt", "disconnectedAt"] as const) next.facts[field] = moveSentinel(world.facts[field])
  if (next.mesh.tickedAt !== null) next.mesh.tickedAt += by
  next.queue = next.queue.map((item) => {
    if (item.type !== "event") return item
    const event: Record<string, unknown> = { ...item.event }
    if (typeof event.now === "number") event.now += by
    if (typeof event.at === "number") event.at += by
    return { type: "event", event: event as unknown as PeerActorEvent }
  })
  return next
}

/** Every time already at or past SAT moved further back: the key merges these. */
function perturbAboveSat(world: ActorWorld, rand: () => number): ActorWorld {
  const next = cloneWorld(world)
  const old = (at: number | null) => at !== null && world.now - at >= SAT
  const back = (at: number, floor: number) => Math.max(floor, at - 1 - Math.floor(rand() * 60_000))
  const actor = { ...world.actor }
  if (old(actor.lastSignalAt)) actor.lastSignalAt = back(actor.lastSignalAt!, -1e9)
  if (old(actor.lastAttemptAt)) actor.lastAttemptAt = back(actor.lastAttemptAt!, -1e9)
  // the actor's own copies move with Mesh's (they stay equal: design B, B1)
  next.actor = actor
  for (const field of ["lastSignalAt", "firstHeardAt", "lastRecvDescAt", "offerSentAt", "yieldedAt"] as const) {
    if (old(world.facts[field] ?? null)) next.facts[field] = back(world.facts[field]!, -1e9)
  }
  // a sentinel time stays positive: 0 means never
  for (const field of ["upAt", "downAt", "disconnectedAt"] as const) {
    if (world.facts[field] > 0 && old(world.facts[field])) next.facts[field] = back(world.facts[field], 1)
  }
  for (const field of ACTOR_TIMES) {
    if (field === "connectingSince") {
      if (old(actor.connectingSince)) actor.connectingSince = back(actor.connectingSince!, 1)
      continue
    }
    const mesh = next.facts[field]
    if (old(actor[field])) actor[field] = typeof mesh === "number" && mesh > 0 && world.facts[field] === actor[field] ? mesh : back(actor[field]!, 1)
  }
  return next
}

/** The probes no reachable world kills, by why (d = 4-5, F = 2, from the start, the fair runs and the seed runs). */
const UNREACHED_PROBES: Record<string, string> = {
  // a shape Mesh never stamps with the actor driving
  "remove stale connection epoch check": "the probe rewrites peer-heard only, and Mesh stamps peer-heard with the connection it holds; the stale-connection gate itself is exercised by complete:overtaken",
  "adopt a connection the actor already holds": "Mesh tells a replace only for a connection the actor does not hold (startActor 4637, replaceForActor 4819)",
  "recover while the page is hidden": "supervise() returns on a hidden page (3370): no sweep reaches a hidden actor",
  // a value the world holds constant (HELD_CONSTANTS)
  "restart ICE without restartIce": "canRestartIce is held true: an engine without restartIce is not modelled (design 8.2)",
  // not reachable in the world
  "re-initiate a yielded connection that has a channel": "the world gives a channel only on channel-observed open, which needs a connected link, so a description; a yielded connection has neither",
  "re-initiate a yielded connection that took an offer": "a description cancels yieldedAt before a later clock can reach the stranded rule",
}

const supervisorView = { initiator: false, lastAttemptAt: null, budgets: { failCount: 0, noVideoRebuilds: 0 } }
const NOW = START_NOW

describe("slice 3: the pure peer-actor search", () => {
  it("formats one deterministic progress line for a finished BFS layer", () => {
    expect(formatLayerProgress({
      depth: 4,
      states: 12_345,
      added: 6_789,
      elapsedMs: 98_765,
      heapUsedMb: 432,
      cuts: { depth: 6_789, faults: 17, domain: 3 },
    })).toBe("peer-actor depth=4 states_new=6789 states_total=12345 elapsed_ms=98765 heap_used_mb=432 cuts_depth=6789 cuts_faults=17 cuts_domain=3")
  })

  it("keys keep pending identity, command order and read-sequence offsets", () => {
    const base = answerer()
    base.actor = { ...base.actor, commandEpoch: 5, openCommands: { "send-answer": 5, "set-remote-description": 4 } }
    const withPending = (pending: ActorWorld["pending"]) => ({ ...cloneWorld(base), pending })
    const current = withPending([{ kind: "send-answer", commandEpoch: 5, connectionEpoch: 1, lane: false }])
    const older = withPending([{ kind: "send-answer", commandEpoch: 4, connectionEpoch: 1, lane: false }])
    expect(canonical(current)).not.toBe(canonical(older))
    const a = { kind: "send-answer" as const, commandEpoch: 5, connectionEpoch: 1, lane: false }
    const b = { kind: "set-remote-description" as const, commandEpoch: 4, connectionEpoch: 1, lane: false, description: "offer" as const }
    expect(canonical(withPending([a, b]))).not.toBe(canonical(withPending([b, a])))
    const reads = (taken: number, next: number) => {
      const world = cloneWorld(base)
      world.actor = { ...world.actor, framesReadSequence: taken }
      world.nextReadSequence = next
      return canonical(world)
    }
    expect(reads(3, 4)).toBe(reads(13, 14))
    expect(reads(3, 4)).not.toBe(reads(3, 5))
  })

  it("keys keep exact distances below SAT and merge only above it", () => {
    const at = (distance: number) => {
      const world = answerer()
      world.facts.lastSignalAt = world.now - distance
      return canonical(world)
    }
    expect(at(100)).not.toBe(at(101))
    expect(at(SAT - 1)).not.toBe(at(SAT))
    expect(at(SAT)).toBe(at(SAT + 5000))
    expect(at(SAT + 1)).toBe(at(500_000))
  })

  it("keys keep 0 as a sentinel before age conversion: downAt, upAt and disconnectedAt at 0, now - 1 and now - 50_000 give three keys, and decideSupervisor differs where it distinguishes them", () => {
    const fixtures = {
      // markAway reads downAt (decideSupervisor)
      downAt: { browserConnectionState: "disconnected", everConnected: true, lastSignalAt: NOW - 1000 },
      // the channel stall reads upAt (258)
      upAt: { browserConnectionState: "connected", everConnected: true, lastSignalAt: NOW - 1000 },
      // the grace reads disconnectedAt (279)
      disconnectedAt: { browserConnectionState: "disconnected", everConnected: true, laneOpen: true, hasChannel: true, lastSignalAt: NOW - 1000 },
    } as const
    for (const [field, facts] of Object.entries(fixtures) as [keyof typeof fixtures, Partial<ActorWorld["facts"]>][]) {
      const world = (at: number) => {
        const next = answerer()
        Object.assign(next.facts, facts, { [field]: at })
        return next
      }
      const rows = [0, NOW - 1, NOW - 50_000].map(world)
      expect(new Set(rows.map(canonical)).size, field).toBe(3)
      const decide = (row: ActorWorld) => decideFromTick({ ...row.facts, now: row.now }, supervisorView)
      expect(decide(rows[0]!), field).not.toEqual(decide(rows[2]!))
      expect(decide(rows[0]!), field).toEqual(decide(rows[1]!))
    }
  })

  it("the successor comparison normalises command epochs to the actor's pre-step epochs", () => {
    const world = initiator()
    const twin = shiftEpochs(world, 7, 11, 3)
    expect(canonical(twin)).toBe(canonical(world))
    const one = successor(world, entry("local-offer-requested"))!
    const two = successor(twin, entry("local-offer-requested"))!
    expect(one.commands.map((command) => command.commandEpoch)).not.toEqual(two.commands.map((command) => command.commandEpoch))
    expect(normaliseCommands(one.commands, world.actor)).toBe(normaliseCommands(two.commands, twin.actor))
    expect(canonical(one.world)).toBe(canonical(two.world))
  })

  it("keys keep the 0 and null never-sentinels distinct from every distance", () => {
    const downAt = [0, NOW - 1, NOW - 50_000].map((at) => {
      const world = answerer()
      world.facts.downAt = at
      return canonical(world)
    })
    expect(new Set(downAt).size).toBe(3)
    const attempt = [null, NOW - 50_000].map((at) => {
      const world = answerer()
      world.actor = withTimes(world.actor, { lastAttemptAt: at })
      return canonical(world)
    })
    expect(attempt[0]).not.toBe(attempt[1])
  })

  it("successor equivalence: equal keys give equal successor keys and commands for every alphabet event", () => {
    const worlds = [
      ...bfs({ depth: 6, maxStates: 30_000, faults: 1 }, { keepWorlds: true, check: false }).worlds!,
      ...bfs({ depth: 3, maxStates: 30_000, faults: 1 }, { initial: fairWorlds(1), keepWorlds: true, check: false }).worlds!,
    ]
    // worlds whose times have aged past SAT: the fair runs, then time advanced
    // flip by flip, then a short search from there
    const aged: ActorWorld[] = []
    for (let world of fairWorlds(1)) {
      for (let flips = 0; flips < 8; flips++) {
        const next = successor(world, entry("advance"))
        if (!next) break
        world = next.world
      }
      aged.push(world)
    }
    worlds.push(...bfs({ depth: 2, maxStates: 30_000, faults: 1 }, { initial: aged, keepWorlds: true, check: false }).worlds!)
    const rand = random(1428)
    let perturbed = 0
    for (let pair = 0; pair < 500; pair++) {
      const world = worlds[Math.floor(rand() * worlds.length)]!
      const kind = pair % 3
      const twin = kind === 0 ? shiftEpochs(world, 1 + Math.floor(rand() * 9), 1 + Math.floor(rand() * 9), Math.floor(rand() * 5)) : kind === 1 ? shiftTime(world, 1 + Math.floor(rand() * 90_000)) : perturbAboveSat(world, rand)
      if (kind === 2 && JSON.stringify(twin) !== JSON.stringify(world)) perturbed += 1
      expect(canonical(twin), `pair ${pair}`).toBe(canonical(world))
      for (const candidate of ALPHABET) {
        const one = successor(world, candidate)
        const two = successor(twin, candidate)
        expect(Boolean(two), `pair ${pair} ${candidate.key}`).toBe(Boolean(one))
        if (!one || !two) continue
        expect(canonical(two.world), `pair ${pair} ${candidate.key}`).toBe(canonical(one.world))
        expect(normaliseCommands(two.commands, twin.actor), `pair ${pair} ${candidate.key}`).toBe(normaliseCommands(one.commands, world.actor))
      }
    }
    expect(perturbed).toBeGreaterThan(0)

    // the deterministic sentinel rows: different keys, and successors that
    // differ where decideSupervisor does (markAway reads downAt)
    const row = (downAt: number) => {
      const world = answerer()
      Object.assign(world.facts, { browserConnectionState: "disconnected", everConnected: true, lastSignalAt: NOW - 1000, downAt })
      world.actor = withTimes({ ...world.actor, everConnected: true }, { downAt: downAt === 0 ? null : downAt })
      return world
    }
    const rows = [0, NOW - 1, NOW - 50_000].map(row)
    expect(new Set(rows.map(canonical)).size).toBe(3)
    const ticked = rows.map((world) => successor(world, entry("supervisor-tick"))!)
    expect(ticked[0]!.commands.some((command) => command.kind === "mark-away")).toBe(false)
    expect(ticked[1]!.commands.some((command) => command.kind === "mark-away")).toBe(false)
    expect(ticked[2]!.commands.some((command) => command.kind === "mark-away")).toBe(true)
    const attempts = [null, NOW - 50_000].map((at) => {
      const world = row(0)
      world.actor = withTimes(world.actor, { lastAttemptAt: at })
      return world
    })
    expect(canonical(attempts[0]!)).not.toBe(canonical(attempts[1]!))
  })

  it("advance moves now to the next comparison flip and emits one clock fact from the world's facts", () => {
    const world = answerer()
    world.facts.lastSignalAt = NOW - 1000
    world.facts.firstHeardAt = NOW - 1000
    // the world reads the actor's own times (design B, B3a), which stay equal to the tick's copies
    world.actor = withTimes(world.actor, { lastSignalAt: NOW - 1000, firstHeardAt: NOW - 1000, connectingSince: NOW - 1000 })
    // the earliest flip is the stored inclusive connectBy deadline.
    expect(nextDeadline(world)).toBe(NOW - 1000 + 18_000)
    const built = entry("advance").build(world)!
    expect(built.world.now).toBe(NOW + 17_000)
    expect(built.event).toEqual(tickEvent(built.world))
    expect(built.event).toEqual({ type: "clock", now: NOW + 17_000, snapshot: snapshotOf({ ...world.facts, now: NOW + 17_000 }), roomEpoch: 1, connectionEpoch: 1 })
    const edge = successor(world, entry("advance"))!
    expect(edge.steps.filter((step) => step.event.type === "clock")).toHaveLength(1)
  })

  it("never uses peer.definition's relativeTo", () => {
    const files = readdirSync(__dirname).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(/relativeTo/)
  })

  it("cuts a value that leaves its declared range instead of merging it", () => {
    // a failed link, due and backed off: the next sweep's rebuild counts a failure past the range
    const world = answerer()
    world.actor = { ...world.actor, budgets: { ...world.actor.budgets, failCount: DOMAIN.failCount } }
    Object.assign(world.facts, { browserConnectionState: "failed", lastSignalAt: NOW - 1000 })
    expect(outOfDomain(world)).toBeNull()
    const result = bfs({ depth: 2, maxStates: 10_000, faults: 0 }, { initial: [world], keepWorlds: true })
    expect(result.cuts.domain).toBeGreaterThan(0)
    for (const kept of result.worlds!) expect(outOfDomain(kept)).toBeNull()
    expect(bfs({ depth: 2, maxStates: 10, faults: 0 }, { initial: [{ ...world, actor: { ...world.actor, budgets: { ...world.actor.budgets, failCount: DOMAIN.failCount + 1 } } }] })).toMatchObject({ states: 0, cuts: { domain: 1 } })
  })

  it("walks both fair runs on enabled labels only", () => {
    expect(fairWorlds(1)).toHaveLength(FAIR_RUNS.initiator.length + FAIR_RUNS.answerer.length)
    for (const world of fairWorlds(1).filter((_, index, all) => index === FAIR_RUNS.initiator.length - 1 || index === all.length - 1)) {
      expect(world.facts).toMatchObject({ browserConnectionState: "connected", laneOpen: true, framesSeen: 1 })
      // the region stays negotiating after the lane renegotiation: only a
      // connected or channel-open fact moves it back (the connection-observed and channel-observed arms)
      expect(world.actor).toMatchObject({ laneOpen: true })
    }
  })

  it("reaches the frontier or names its cuts at depth 8", () => {
    // the state count grows about 6.5 times a level, so depth 8 runs under a
    // state cap; a cap stop says so (capped, frontier), it is never a depth cut
    for (const [name, initial] of [["start", undefined], ["fair runs", fairWorlds(1)]] as const) {
      const run = bfs({ depth: 8, maxStates: 150_000, faults: 1 }, initial ? { initial } : {})
      expect(run.depthCompleted, name).toBeGreaterThanOrEqual(name === "start" ? 4 : 2)
      if (run.capped) expect(run.frontier, name).toBeGreaterThan(0)
      else expect(run.frontierClosed || run.cuts.depth > 0, name).toBe(true)
      expect(run.violations, name).toEqual([])
      console.log(`peer-actor BFS from ${name}: d = 8, F = 1, H = n/a (event-driven), completed d = ${run.depthCompleted}${run.capped ? `, stopped by the state cap (150,000) with ${run.frontier} worlds unexpanded` : ""}; ${run.states} states, ${run.graph.edges.length} edges, frontier ${run.frontierClosed ? "closed" : "open"}, cuts ${JSON.stringify(run.cuts)}`)
    }
  })

  it("hash compaction gives the same search as full keys at depth 5", () => {
    const strip = (run: ReturnType<typeof bfs>) => ({ states: run.states, edgeCount: run.edgeCount, depthCompleted: run.depthCompleted, frontierClosed: run.frontierClosed, capped: run.capped, frontier: run.frontier, cuts: run.cuts, violations: run.violations })
    const full = bfs({ depth: 5, maxStates: 1_000_000, faults: 1 })
    const hashed = bfs({ depth: 5, maxStates: 1_000_000, faults: 1 }, { hash: true, graph: false })
    expect(strip(hashed)).toEqual(strip(full))
    expect(hashed.graph.nodes).toEqual([])
    expect(full.edgeCount).toBe(full.graph.edges.length)
    console.log(`hash compaction at d = 5: ${full.states} states either way; birthday bound on a collision ${collisionBound(full.states).toExponential(2)}`)
  })

  it("a split visited index gives the same search as one Map at depth 5", () => {
    const strip = (run: ReturnType<typeof bfs>) => ({ states: run.states, edgeCount: run.edgeCount, depthCompleted: run.depthCompleted, frontierClosed: run.frontierClosed, capped: run.capped, frontier: run.frontier, cuts: run.cuts, violations: run.violations, nodes: run.graph.nodes })
    const one = bfs({ depth: 5, maxStates: 1_000_000, faults: 1 }, { shards: 1, check: false })
    const split = bfs({ depth: 5, maxStates: 1_000_000, faults: 1 }, { shards: 64, check: false })
    expect(strip(split)).toEqual(strip(one))
  })

  it("a split index holds more entries than one shard can", () => {
    const keys = Array.from({ length: 5000 }, (_, i) => hash64(`synthetic world ${i}`))
    const split = new ShardedIndex(16, 1000)
    keys.forEach((key, i) => split.set(key, i))
    expect(split.size).toBe(5000)
    expect(split.largest).toBeLessThanOrEqual(1000)
    keys.forEach((key, i) => expect(split.get(key)).toBe(i))
    const single = new ShardedIndex(1, 1000)
    expect(() => keys.forEach((key, i) => single.set(key, i))).toThrow(RangeError)
  })

  it("kills every peerMutationProbes mutation", () => {
    expect(ACTOR_MUTATIONS.map((probe) => probe.mutation), "keeps the probe list in step").toEqual(peerMutationProbes.map((probe) => probe.mutation))
    const worlds = [
      ...bfs({ depth: 5, maxStates: 15_000, faults: 2 }, { keepWorlds: true, check: false }).worlds!,
      ...bfs({ depth: 4, maxStates: 25_000, faults: 2 }, { initial: fairWorlds(2), keepWorlds: true, check: false }).worlds!,
      ...bfs({ depth: 4, maxStates: 25_000, faults: 2 }, { initial: seedWorlds(2), keepWorlds: true, check: false }).worlds!,
    ]
    const witnessType = (key: string) => peerScenarios.find((scenario) => scenario.events[0]!.key === key)!.events[0]!.event.type
    // each probe mutates the step for its witness's event type only, as it is written
    const scoped = (type: PeerActorEvent["type"], mutate: Stepper): Stepper => (state, event) => (event.type === type ? mutate(state, event) : stepPeerActor(state, event))
    const mutants: [name: string, [type: PeerActorEvent["type"], step: Stepper]][] = [
      ...ACTOR_MUTATIONS.map((probe): [string, [PeerActorEvent["type"], Stepper]] => [probe.mutation, [witnessType(probe.witness), scoped(witnessType(probe.witness), probe.mutate as Stepper)]]),
    ]
    // worlds outside, mutants inside: each clean successor is computed once
    const alive = new Map(mutants)
    const differs = (world: ActorWorld, candidate: (typeof ALPHABET)[number], clean: NonNullable<ReturnType<typeof successor>>, mutant: Stepper): boolean => {
      let mutated
      try {
        mutated = successor(world, candidate, mutant)
      } catch {
        return true
      }
      if (!mutated) return true
      return canonical(mutated.world) !== canonical(clean.world) || normaliseCommands(mutated.commands, world.actor) !== normaliseCommands(clean.commands, world.actor)
    }
    for (const world of worlds) {
      if (alive.size === 0) break
      for (const candidate of ALPHABET) {
        const clean = successor(world, candidate)
        if (!clean) continue
        // a mutant scoped to an event type the edge never steps behaves as the clean one
        const types = new Set(clean.steps.map((step) => step.event.type))
        for (const [name, [type, mutant]] of alive) if (types.has(type) && differs(world, candidate, clean, mutant)) alive.delete(name)
      }
    }
    const survivors = [...alive.keys()].sort()
    // Every probe the faithful world can reach is killed. These are not, and
    // each says why: they are the next task's evidence, never a gap to close
    // by building an event Mesh cannot send.
    expect(survivors).toEqual(Object.keys(UNREACHED_PROBES).sort())

  })

  it("keeps a reason for every alphabet exclusion", () => {
    for (const candidate of ALPHABET) {
      if (candidate.excluded) expect(candidate.excluded.length).toBeGreaterThan(20)
      if (candidate.uncertain) expect(candidate.uncertain.length).toBeGreaterThan(20)
    }
  })

  // "rebuilds each actor event the room accepted through ALPHABET.build …" is in room-differential.test.ts
})
