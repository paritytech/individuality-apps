// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The canonical key of a world, and the declared range of
 * every bounded value.
 *
 * The key is the JSON of the whole world, with sorted object keys, and:
 * 1. Epochs relative. Connection epochs (the actor's, Mesh's, the pending
 *    commands', a refused offer's) are kept as `x - actor.connectionEpoch`,
 *    command epochs as `x - actor.commandEpoch`, the read sequence as
 *    `framesReadSequence - nextReadSequence`. The pending and queue order is
 *    kept.
 * 2. Times as distances `now - t`, exact below SAT and "≥SAT" from it on.
 *    null ("never") and the sentinel 0 of upAt, downAt and disconnectedAt are
 *    their own tokens, never a distance. `now` itself is dropped.
 * 3. Everything else exact: counters, budgets, framesSeen, the round.
 * Never peer.definition's display key, nor its witness-time shift.
 */
import type { PeerActorCommand, PeerActorEvent, PeerActorState } from "../../state-machines/peer-actor"
import type { ActorWorld, PendingCommand, Queued } from "./world"

/** One more than the largest threshold any time comparison uses (presenceFreshMs, 45000). */
export const SAT = 45_001

type Token = number | "never" | "zero" | "≥SAT"

/** A nullable time: null is "never", a real time its distance from now. */
function age(now: number, at: number | null): Token {
  if (at === null) return "never"
  const distance = now - at
  return distance >= SAT ? "≥SAT" : distance
}

/** upAt, downAt, disconnectedAt: 0 is "never" in Mesh's copies (the world's facts). */
function sentinelAge(now: number, at: number): Token {
  return at === 0 ? "zero" : age(now, at)
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, child]) => [key, sorted(child)]))
  }
  return value
}

export const stableJson = (value: unknown): string => JSON.stringify(sorted(value))

interface Bases {
  now: number
  connection: number
  command: number
  read: number
}

const NULLABLE_TIMES = ["lastSignalAt", "firstHeardAt", "lastRecvDescAt", "offerSentAt", "yieldedAt"] as const
const SENTINEL_TIMES = ["upAt", "downAt", "disconnectedAt"] as const
const ACTOR_TIMES = ["upAt", "connectingSince", "downAt", "disconnectedAt", "firstHeardAt", "lastRecvDescAt", "offerSentAt", "yieldedAt"] as const

function canonActor(actor: PeerActorState, bases: Bases) {
  // the deadlines are functions of the times and failures keyed here:
  // keyed again as ages they would keep counting past SAT and split
  // states that merge
  const { connectionEpoch: _connection, commandEpoch: _command, deadlines: _deadlines, ...rest } = actor
  void _connection
  void _command
  void _deadlines
  return {
    ...rest,
    openCommands: Object.fromEntries(Object.entries(actor.openCommands).map(([kind, epoch]) => [kind, (epoch as number) - bases.command])),
    framesReadSequence: actor.framesReadSequence - bases.read,
    lastSignalAt: age(bases.now, actor.lastSignalAt),
    lastAttemptAt: age(bases.now, actor.lastAttemptAt),
    // the actor's own recovery times: null is never
    ...Object.fromEntries(ACTOR_TIMES.map((field) => [field, age(bases.now, actor[field])])),
  }
}

function canonPending(entry: PendingCommand, bases: Bases) {
  return { ...entry, commandEpoch: entry.commandEpoch - bases.command, connectionEpoch: entry.connectionEpoch - bases.connection }
}

/** A fact or completion waiting in the drain, in the same relative terms. */
function canonEvent(event: PeerActorEvent, bases: Bases): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event, connectionEpoch: event.connectionEpoch - bases.connection }
  if ("commandEpoch" in event) out.commandEpoch = event.commandEpoch - bases.command
  if ("readSequence" in event) out.readSequence = event.readSequence - bases.read
  if (event.now !== undefined) out.now = bases.now - event.now
  if ("at" in event && typeof event.at === "number") out.at = age(bases.now, event.at)
  if (event.type === "description-observed" && event.newRemoteSession) out.newRemoteSession = { at: age(bases.now, event.newRemoteSession.at) }
  return out
}

function canonQueued(item: Queued, bases: Bases) {
  if (item.type === "event") return { type: "event", event: canonEvent(item.event, bases) }
  if (item.type === "choice") return { type: "choice", command: canonPending(item.command, bases) }
  return item
}

function basesOf(world: ActorWorld): Bases {
  return { now: world.now, connection: world.actor.connectionEpoch, command: world.actor.commandEpoch, read: world.nextReadSequence }
}

/** The world's key. */
export function canonical(world: ActorWorld): string {
  const bases = basesOf(world)
  const facts: Record<string, unknown> = { ...world.facts }
  for (const field of NULLABLE_TIMES) facts[field] = age(world.now, world.facts[field] ?? null)
  for (const field of SENTINEL_TIMES) facts[field] = sentinelAge(world.now, world.facts[field])
  return stableJson({
    actor: canonActor(world.actor, bases),
    meshConnectionEpoch: world.meshConnectionEpoch - bases.connection,
    facts,
    pending: world.pending.map((entry) => canonPending(entry, bases)),
    queue: world.queue.map((item) => canonQueued(item, bases)),
    faultsLeft: world.faultsLeft,
    mesh: {
      ...world.mesh,
      refusedEpoch: world.mesh.refusedEpoch === null ? null : world.mesh.refusedEpoch - bases.connection,
      tickedAt: world.mesh.tickedAt === world.now ? "now" : "earlier",
    },
  })
}

/** Commands with their epochs relative to the issuing actor's epochs before
 *  the step: worlds that differ by an epoch shift then issue equal lists. */
export function normaliseCommands(commands: readonly PeerActorCommand[], before: Pick<PeerActorState, "commandEpoch" | "connectionEpoch">): string {
  // `at` is the clock of the fact the command was decided on, the world's now
  return stableJson(commands.map((command) => ({ ...command, commandEpoch: command.commandEpoch - before.commandEpoch, connectionEpoch: command.connectionEpoch - before.connectionEpoch, ...(command.at === undefined ? {} : { at: "now" }) })))
}

/** The declared range of every value the key keeps exact or relative. A
 *  world outside it is cut ("domain"), never merged into another key. */
export const DOMAIN = {
  meshConnectionOffset: [-2, 2],
  commandOffset: [-40, 0],
  pendingConnectionOffset: [-4, 0],
  readOffset: [-16, 0],
  failCount: 6,
  stallHeals: 4,
  unseenHeals: 2,
  roundBudgets: 1,
  roundGeneration: 2,
  framesSeen: 2,
  pending: 8,
  queue: 8,
} as const

const within = (value: number, [low, high]: readonly [number, number]) => value >= low && value <= high

/** The first value outside its declared range, or null. */
export function outOfDomain(world: ActorWorld): string | null {
  const { actor } = world
  const conn = actor.connectionEpoch
  const command = actor.commandEpoch
  if (!within(world.meshConnectionEpoch - conn, DOMAIN.meshConnectionOffset)) return "meshConnectionEpoch"
  for (const epoch of Object.values(actor.openCommands)) if (!within((epoch as number) - command, DOMAIN.commandOffset)) return "openCommands"
  for (const entry of world.pending) {
    if (!within(entry.commandEpoch - command, DOMAIN.commandOffset)) return "pending.commandEpoch"
    if (!within(entry.connectionEpoch - conn, DOMAIN.pendingConnectionOffset)) return "pending.connectionEpoch"
  }
  if (!within(actor.framesReadSequence - world.nextReadSequence, DOMAIN.readOffset)) return "framesReadSequence"
  if (actor.budgets.failCount > DOMAIN.failCount) return "failCount"
  if (actor.budgets.stallHeals > DOMAIN.stallHeals) return "stallHeals"
  if (actor.budgets.unseenHeals > DOMAIN.unseenHeals) return "unseenHeals"
  for (const budget of ["noVideoRebuilds", "negotiationImmediate", "negotiationUnseen", "glareRebuilds"] as const) {
    if (actor.budgets[budget] > DOMAIN.roundBudgets) return budget
  }
  if (actor.roundGeneration > DOMAIN.roundGeneration) return "roundGeneration"
  if (actor.framesSeen > DOMAIN.framesSeen || world.facts.framesSeen > DOMAIN.framesSeen) return "framesSeen"
  if (world.pending.length > DOMAIN.pending) return "pending"
  if (world.queue.length > DOMAIN.queue) return "queue"
  return null
}
