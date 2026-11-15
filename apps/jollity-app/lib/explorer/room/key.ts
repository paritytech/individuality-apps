// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The room's key.
 *
 * - A half is keyed by the actor explorer's canonical() (actor/canon.ts) of
 *   its projected world (the room's now, its own queued items, faultsLeft
 *   held at 0: the room keys faults once), after **per-field saturation**:
 *   each time field is clamped to "≥SAT" from its own largest threshold on,
 *   not from the global SAT. Every reader of a field compares it with a
 *   constant at most that field's cap, so two halves equal under the clamp
 *   take the same decisions (canon.ts's argument, field by field). The
 *   successor-equivalence test in room.test.ts is the evidence.
 * - A pair (lo, hi) is keyed by both halves, the room-side extras and the
 *   transport between them, with every remote connection id relative to
 *   the half it names (the sender's current session and epoch) and every
 *   session relative to the current one: the key is shift-invariant.
 * - Pair keys are interned by a 128-bit hash to a 32-bit id (one table for
 *   every pair position: all pairs are lo = initiator, hi = answerer); a
 *   phone's key (its FIFO's peer tags and its owed sweep) by its text. The
 *   room key is the tuple of those ids and faultsLeft, packed into a short
 *   string: exact over the interned ids.
 */
import { canonical, SAT, stableJson } from "../actor/canon"
import { cloneWorld, type ActorWorld } from "../actor/world"
import { SUPERVISOR_TIMING } from "../../webrtc/supervisor-timing"
import { ShardedIndex } from "../actor/bfs"
import { KICK_AFTER_HIDDEN_MS } from "../../state-machines/peer-actor"
import { DROP_DELAY_MS, epochOf, halfId, ICE_CONSENT_EXPIRY_MS, localNow, pairsOf, sessionOf, STABLE_HELLO_MS, type ConnId, type Gen, type Room } from "./model"

const t = SUPERVISOR_TIMING

/** Each time field's cap: one more than the largest offset any reader compares it with (world.ts deadlines, the peer-heard 20 s gap). */
export const FIELD_CAPS = {
  actor: {
    lastSignalAt: 45_001,
    lastAttemptAt: t.backoffMaxMs + 1,
  },
  facts: {
    lastSignalAt: Math.max(t.presenceFreshMs, 20_001) + 1,
    lastAttemptAt: SAT,
    firstHeardAt: t.initialTimeoutMs + 2,
    lastRecvDescAt: t.negotiationQuietMs + 1,
    offerSentAt: t.answerWaitMs + 1,
    yieldedAt: t.answerWaitMs + 1,
    upAt: t.connectedWithoutChannelMs + 1,
    downAt: Math.max(t.awayAfterMs + 1, t.dropChaseMs) + 1,
    disconnectedAt: t.disconnectGraceMs + 2,
  },
} as const

const SENTINEL = new Set(["upAt", "downAt", "disconnectedAt"])

/** A copy with every time at or past its field's cap moved to exactly SAT before now, so canonical() prints "≥SAT". */
function saturate(world: ActorWorld): ActorWorld {
  const out = cloneWorld(world)
  const now = world.now
  const clamp = (at: number | null, cap: number, sentinel: boolean): number | null => {
    if (at === null || (sentinel && at === 0)) return at
    return now - at >= cap ? now - SAT : at
  }
  let actor = out.actor
  for (const [field, cap] of Object.entries(FIELD_CAPS.actor) as [keyof typeof FIELD_CAPS.actor, number][]) {
    const at = clamp(actor[field], cap, false)
    if (at !== actor[field]) actor = { ...actor, [field]: at }
  }
  out.actor = actor
  const facts = out.facts as unknown as Record<string, number | null>
  for (const [field, cap] of Object.entries(FIELD_CAPS.facts)) facts[field] = clamp(facts[field]!, cap, SENTINEL.has(field))
  return out
}

/** The half's world as keyed: its phone's now (model.ts localNow; the room's now without the frozen clock), its own queued items in FIFO order, faults held at 0. */
function keyedHalf(room: Room, i: number, j: number): ActorWorld {
  const world = room.halves[i]![j]!
  const items = room.phones[i]!.queue.filter((entry) => entry.peer === j).map((entry) => entry.item)
  return { ...world, now: localNow(room, i), faultsLeft: 0, queue: items }
}

const halfCache = new WeakMap<ActorWorld, { now: number; key: string }>()

/** canonical() of the saturated half; cached per (half object, now) when it has no queued items. */
function halfKey(room: Room, i: number, j: number): string {
  const world = room.halves[i]![j]!
  const queued = room.phones[i]!.queue.some((entry) => entry.peer === j)
  if (!queued) {
    const hit = halfCache.get(world)
    if (hit && hit.now === localNow(room, i)) return hit.key
  }
  const key = canonical(saturate(keyedHalf(room, i, j)))
  if (!queued) halfCache.set(world, { now: localNow(room, i), key })
  return key
}

/** A remote connection id relative to the half that owns it. */
function rel(room: Room, owner: [number, number], id: ConnId | null): string | null {
  if (id === null) return null
  const current = halfId(room, owner[0], owner[1])
  return `${sessionOf(current) - sessionOf(id)}.${epochOf(current) - epochOf(id)}`
}

/**
 * A generation relative to the phone that minted it, as seen from half (i, j): `s` (minted by i) or `p`
 * (by j), its session back from that phone's current one, and its offer count back from that half's
 * count: the current one, or for an older session the count it ended with. One origin on both sides
 * of a reload, so a gen keys the same before and after its minter reloads, and a shifted counter
 * (every count and every gen of the session moved together) keys the same.
 */
function relGen(room: Room, i: number, j: number, gen: Gen | null): string | null {
  if (gen === null) return null
  const side = gen.by === i ? "s" : "p"
  const other = gen.by === i ? j : i
  const back = room.phones[gen.by]!.session - gen.session
  const extra = room.extras[gen.by]![other]!
  const origin = back === 0 ? extra.offers : extra.ended.find((entry) => entry.session === gen.session)?.offers
  if (origin === undefined) throw new Error(`no offer count kept for phone ${gen.by}'s session ${gen.session}`)
  return `${side}${back}.${origin - gen.n}`
}

function extraKey(room: Room, i: number, j: number) {
  const extra = room.extras[i]![j]!
  const remote: [number, number] = [j, i]
  return {
    out: relGen(room, i, j, extra.out),
    inboundGen: relGen(room, i, j, extra.inboundGen),
    answeringGen: relGen(room, i, j, extra.answeringGen),
    held: rel(room, remote, extra.heldRemote),
    answering: rel(room, remote, extra.answering),
    inbound: rel(room, remote, extra.inbound),
    left: extra.left.map((id) => rel(room, remote, id)),
    srd: extra.srd.map((entry) => ({ c: entry.commandEpoch - room.halves[i]![j]!.actor.commandEpoch, from: rel(room, remote, entry.from) })),
    // the codec guard (model.ts codecGuard): keyed only while one runs, so a room with none keys as before
    // the frozen clock's consent expiry (model.ts consentLost): keyed only when set
    ...(extra.consentLost ? { lost: 1 } : {}),
    ...(extra.guard ? { guard: { e: extra.guard.epoch - room.halves[i]![j]!.meshConnectionEpoch, c: extra.guard.original - room.halves[i]![j]!.actor.commandEpoch, r: extra.guard.rolled, o: extra.guard.offered } } : {}),
  }
}

function directionKey(room: Room, from: number, to: number) {
  const slot = room.slots[from]![to]
  const admitted = room.admitted[to]![from]
  return {
    slot: slot && { kind: slot.kind, from: rel(room, [from, to], slot.from), gen: relGen(room, from, to, slot.gen), read: slot.readBy === null ? "no" : slot.readBy === room.phones[to]!.session ? "now" : "old", drop: room.now - slot.publishedAt > DROP_DELAY_MS },
    lane: room.lanes[from]![to]!.map((frame) => frame.kind),
    admitted: admitted === null ? null : room.phones[from]!.session - admitted,
  }
}

/** The pair (lo, hi)'s full key text. */
export function pairKey(room: Room, lo: number, hi: number): string {
  return stableJson({
    lo: halfKey(room, lo, hi),
    hi: halfKey(room, hi, lo),
    xlo: extraKey(room, lo, hi),
    xhi: extraKey(room, hi, lo),
    up: directionKey(room, lo, hi),
    down: directionKey(room, hi, lo),
  })
}

/** The beat's age is kept exact up to the longest beat period (model.ts STABLE_HELLO_MS) and clamped past it. */
const BEAT_CAP = STABLE_HELLO_MS + 1

export function phoneKey(room: Room, i: number): string {
  const phone = room.phones[i]!
  const beat = room.beat ? `|b${phone.lastBeat === null || phone.lastBeat === undefined ? "n" : Math.min(localNow(room, i) - phone.lastBeat, BEAT_CAP)}` : ""
  // the frozen page clock (model.ts): hidden for how long on its own clock (only the kick, > 8 s, reads it), frozen for how long on the room's (only ice:silent, at 5 s and 30 s, reads it); the lag itself is never keyed (shift-invariant)
  const page = phone.hiddenAt === undefined ? "" : `|h${Math.min(localNow(room, i) - phone.hiddenAt, KICK_AFTER_HIDDEN_MS + 1)}${phone.frozenAt === undefined ? "" : `f${Math.min(room.now - phone.frozenAt, ICE_CONSENT_EXPIRY_MS)}`}`
  // an RTX-unsafe engine (model.ts Phone.rtxUnsafe) changes what the phone's halves may do; a safe phone keys as before
  return `${phone.owesSweep ? 1 : 0}|${phone.queue.map((entry) => entry.peer).join(",")}${beat}${phone.rtxUnsafe ? "|x" : ""}${phone.freezable ? "|z" : ""}${page}`
}

/** A 128-bit hash as eight UTF-16 code units: four 32-bit multiply-xorshift lanes. */
function hash128(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  let h3 = 0x9e3779b9
  let h4 = 0x85ebca6b
  for (let at = 0; at < text.length; at++) {
    const ch = text.charCodeAt(at)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
    h3 = Math.imul(h3 ^ ch, 2246822519)
    h4 = Math.imul(h4 ^ ch, 3266489917)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909)
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909)
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return String.fromCharCode(h1 >>> 16, h1 & 0xffff, h2 >>> 16, h2 & 0xffff, h3 >>> 16, h3 & 0xffff, h4 >>> 16, h4 & 0xffff)
}

/** The intern tables: pair keys by 128-bit hash, phone keys by text. */
export class Interner {
  private readonly pairs = new ShardedIndex(64)
  private readonly phones = new Map<string, number>()
  /** per pair id, a bit for each pair position it was seen at */
  private positions = new Uint8Array(1 << 16)
  /** the summed length of the pair key texts interned (for the savings figure) */
  pairKeyChars = 0

  pair(text: string, position: number): number {
    return this.pairHash(hash128(text), text.length, position)
  }

  /** pair() for a key text already hashed (roomKeyParts) */
  pairHash(hash: string, chars: number, position: number): number {
    let id = this.pairs.get(hash)
    if (id === undefined) {
      id = this.pairs.size
      this.pairs.set(hash, id)
      this.pairKeyChars += chars
      if (id >= this.positions.length) {
        const grown = new Uint8Array(this.positions.length * 2)
        grown.set(this.positions)
        this.positions = grown
      }
    }
    this.positions[id]! |= 1 << position
    return id
  }

  phone(text: string): number {
    let id = this.phones.get(text)
    if (id === undefined) {
      id = this.phones.size
      this.phones.set(text, id)
    }
    return id
  }

  /** roomKey's packed key without interning anything: null when a pair or phone text was never interned (then no state with it was keyed) */
  peekKey(parts: RoomKeyParts): string | null {
    const codes: number[] = []
    for (const hash of parts.pairHashes) {
      const id = this.pairs.get(hash)
      if (id === undefined) return null
      codes.push(id >>> 16, id & 0xffff)
    }
    for (const text of parts.phones) {
      const id = this.phones.get(text)
      if (id === undefined) return null
      codes.push(id)
    }
    codes.push(parts.faultsLeft)
    return String.fromCharCode(...codes)
  }

  get pairCount(): number {
    return this.pairs.size
  }

  /** distinct pair states seen at each position */
  perPosition(count: number): number[] {
    const out = new Array<number>(count).fill(0)
    for (let id = 0; id < this.pairs.size; id++) for (let position = 0; position < count; position++) if (this.positions[id]! & (1 << position)) out[position]! += 1
    return out
  }
}

export interface RoomKey {
  /** the packed tuple: what the visited set holds */
  key: string
  /** the full text length (the pair, phone and fault parts), for the savings figure */
  fullChars: number
}

/**
 * The room key's format. Bump it whenever a pair's or a phone's key text, or stateIdOf, changes for the
 * same room: a tiled run (tiled.ts) stores it and refuses to resume or extend files of another format.
 * 1: before #1580's last fix; 2: generations keyed from the same origin across a reload (`ended`);
 * 3: statement-slot age keyed only as the drop-delay threshold.
 */
export const ROOM_KEY_FORMAT = 3

/**
 * The room key's parts before interning: each pair's key text hashed to 128 bits, each phone's key text,
 * faultsLeft. Self-contained (no intern table), so a state written by one process is read by another
 * (the tiled map, tiled.ts).
 */
export interface RoomKeyParts {
  /** per pair position, hash128 of its key text (8 UTF-16 code units) */
  pairHashes: string[]
  pairChars: number[]
  phones: string[]
  faultsLeft: number
}

export function roomKeyParts(room: Room): RoomKeyParts {
  const pairHashes: string[] = []
  const pairChars: number[] = []
  for (const [lo, hi] of pairsOf(room.n)) {
    const text = pairKey(room, lo, hi)
    pairHashes.push(hash128(text))
    pairChars.push(text.length)
  }
  return { pairHashes, pairChars, phones: Array.from({ length: room.n }, (_, i) => phoneKey(room, i)), faultsLeft: room.faultsLeft }
}

/**
 * The state's 128-bit id: hash128 of the exact tuple the interned key packs (the pair hashes, the phone
 * texts, faultsLeft), as 16 bytes. Two rooms with equal interned keys have equal ids; the converse holds up
 * to a 128-bit collision, the same assumption pair interning already makes.
 */
export function stateIdOf(parts: RoomKeyParts, elapsed?: number): Uint8Array {
  // with a time horizon the room time past the anchor is part of the state: a state's futures depend on the time left
  const hash = hash128(`${parts.pairHashes.join("")}|${parts.phones.join("|")}|${parts.faultsLeft}${elapsed === undefined ? "" : `|e${elapsed}`}`)
  const out = new Uint8Array(16)
  for (let at = 0; at < 8; at++) {
    const unit = hash.charCodeAt(at)
    out[at * 2] = unit >>> 8
    out[at * 2 + 1] = unit & 0xff
  }
  return out
}

/** A 32-bit number from a state id, for order-free sampling (1 in N states). */
export const stateSample = (id: Uint8Array): number => ((id[0]! << 24) | (id[1]! << 16) | (id[2]! << 8) | id[3]!) >>> 0

/** Order-free inclusion sampling: whether sub-sequence `ordinal` of the edge `label` from the state `id` is compared (1 in `every`). */
export function inclusionSampled(id: Uint8Array, label: string, ordinal: number, every: number): boolean {
  let h = (stateSample(id) ^ Math.imul(ordinal + 1, 0x9e3779b1)) | 0
  for (let at = 0; at < label.length; at++) h = Math.imul(h ^ label.charCodeAt(at), 0x01000193)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) % every === 0
}

/** The room's key: interned pair ids, phone ids and faultsLeft, packed two code units per id. */
export function roomKey(room: Room, interner: Interner, parts: RoomKeyParts = roomKeyParts(room)): RoomKey {
  const codes: number[] = []
  let fullChars = 0
  for (let position = 0; position < parts.pairHashes.length; position++) {
    fullChars += parts.pairChars[position]!
    const id = interner.pairHash(parts.pairHashes[position]!, parts.pairChars[position]!, position)
    codes.push(id >>> 16, id & 0xffff)
  }
  for (const text of parts.phones) {
    fullChars += text.length
    codes.push(interner.phone(text))
  }
  codes.push(parts.faultsLeft)
  return { key: String.fromCharCode(...codes), fullChars: fullChars + 1 }
}

/** The un-interned key (for tests): the full texts joined. */
export function fullRoomKey(room: Room): string {
  return [...pairsOf(room.n).map(([lo, hi]) => pairKey(room, lo, hi)), ...Array.from({ length: room.n }, (_, i) => phoneKey(room, i)), String(room.faultsLeft)].join("\n")
}
