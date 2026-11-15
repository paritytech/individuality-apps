// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The named anchors for the two-phone room: the actor anchors
 * (actor/anchors.ts) the room can reach, each as a warmup of real enabled
 * labels on a base scenario. `npm run explore -- --machine mesh-pair
 * --scenario <anchor>` searches from the warmup's end: every schedule
 * replays the warmup after its reset (as the mutant self-test does), the
 * bounds count labels past it, and a witness holds the warmup and its own
 * labels under the base scenario, so `--replay` re-runs it as any other.
 *
 * The room's labels are the PCs, the statement wire, the lane, the clock and
 * the base scenario's env labels (env:reload, env:signal-throws, and in
 * every scenario env:network, a network change). It has no round change,
 * away mark, ICE restart or camera label, so those anchors are actor-only
 * (the README lists which is which). Its
 * ICE-failure label (env:ice) lives only in the outage scenario, which starts
 * from the steady anchor (scenarios.ts `from`); there is no after-ICE-drop
 * anchor yet.
 *
 * Seven anchors are the room's own, with no actor twin: mid-glare,
 * half-open, mid-rebuild and lost-signal, the outage scenario's
 * ice-failed and ice-disconnected (steady, then one env:ice drop), which start
 * the search at the drop, and network-all (steady, then env:network on a and
 * on b: the abstract room's network-all moment on one pair). On the fair
 * schedule a failed link recovers 13
 * labels past ice-failed and a disconnected one 27 past ice-disconnected (two beats included).
 *
 * The warmups are captured by anchors.test.ts (the fair scheduler from the
 * start, or a fixed prefix) into anchors/<name>.json with the source commit;
 * the same test replays each and checks its position still holds.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Label } from "../core/labels"
import { PRECONDITIONS } from "../mutants/preconditions"
import type { Room, ScenarioName } from "./room"

export interface MeshAnchor {
  /** the scenario the warmup runs on, and whose env labels the search may take */
  scenario: ScenarioName
  doc: string
  /** the position the warmup must end in, read from the harness's records and Mesh's connections */
  holds(room: Room): boolean
}

const other = (side: "a" | "b") => (side === "a" ? "b" : "a")

/** both sides connected over a stable connection with the channel open */
export function steadyLink(room: Room): boolean {
  return (["a", "b"] as const).every((side) => {
    const conn = room.internals(side).conns.get(other(side))
    return conn?.pc.connectionState === "connected" && conn.pc.signalingState === "stable" && conn.channel?.readyState === "open"
  })
}

/** nothing but the clock, the heartbeat and fault labels is enabled: every owned wait has settled */
export const settled = (room: Room): boolean => room.enabled().every((label) => label === "clock:next" || label.startsWith("hb:") || label.startsWith("env:") || label.includes(":drop") || label.includes(":reject:"))

/** the side's last statement frame of this kind that went on the wire */
const lastPublished = (room: Room, side: "a" | "b", kind: "offer" | "answer") =>
  room.logs().wire.findLast((entry) => entry.channel === "statement" && entry.from === side && entry.kind === kind && entry.fate === "published")

/** the side's last published offer still waits on the wire for the other side */
const offerInFlight = (room: Room, side: "a" | "b"): boolean => {
  const offer = lastPublished(room, side, "offer")
  return offer?.id !== undefined && room.enabled().includes(`wire:${side}>${other(side)}:${offer.id}:deliver`)
}

const connOf = (room: Room, side: "a" | "b") => room.internals(side).conns.get(other(side))

const helloCount = (room: Room, side: "a" | "b") =>
  room.logs().wire.filter((entry) => entry.channel === "statement" && entry.from === side && entry.kind === "hello" && entry.fate === "published").length

/** a's PC reads `state` after its env:ice drop, b's still reads connected */
const iceDown = (room: Room, state: "failed" | "disconnected"): boolean =>
  room.logs().inputs.some((input) => input.side === "a" && input.kind === "env:ice")
  && connOf(room, "a")?.pc.connectionState === state && connOf(room, "b")?.pc.connectionState === "connected"

export const MESH_ANCHORS = {
  steady: {
    scenario: "rejoin-two-offers",
    doc: "connected and steady: the fair scheduler from the start until both links are connected and stable with the channel open and nothing but the clock and faults is left",
    holds: (room) => steadyLink(room) && settled(room),
  },
  "after-reload": {
    scenario: "rejoin-two-offers",
    doc: "just after b reloaded on a steady link: the steady warmup, then env:reload:b",
    holds: (room) => helloCount(room, "b") === 2 && room.internals("b").conns.get("a") !== undefined,
  },
  "rejoin-queued-offers": {
    scenario: "rejoin-two-offers",
    doc: "a rejoin with offers queued (#1385, M1385's warmup): a/1's offer captured by the new b, a/2's offer stored, both deliverable",
    holds: (room) => PRECONDITIONS.twoOffersDeliverable!(room),
  },
  "mid-glare": {
    scenario: "rejoin-two-offers",
    doc: "both phones have an offer in flight: a's first offer waits undelivered, b's supervisor times the link out, rebuilds and offers too (no fault)",
    holds: (room) => (["a", "b"] as const).every((side) => connOf(room, side)?.pc.signalingState === "have-local-offer" && offerInFlight(room, side)),
  },
  "half-open": {
    scenario: "rejoin-two-offers",
    doc: "one side connected, the other negotiating: after b's reload, a still reads connected on its old PC while b's new PC has applied a's stored offer",
    holds: (room) => {
      const a = connOf(room, "a")
      const b = connOf(room, "b")
      return a?.pc.connectionState === "connected" && b !== undefined && b.pc.connectionState !== "connected" && b.pc.signalingState !== "stable"
    },
  },
  "mid-rebuild": {
    scenario: "rejoin-two-offers",
    doc: "a rebuild under way: after b's reload, a hears b's new session, replaces its connected PC and its new PC's offer is in flight",
    holds: (room) => {
      const first = room.logs().wire.find((entry) => entry.channel === "statement" && entry.from === "a" && entry.kind === "offer" && entry.fate === "published")
      const latest = lastPublished(room, "a", "offer")
      const conn = connOf(room, "a")
      return first !== undefined && latest !== undefined && latest.xPc !== first.xPc && conn?.pc.signalingState === "have-local-offer" && conn.pc.connectionState !== "connected" && offerInFlight(room, "a")
    },
  },
  "lost-signal": {
    scenario: "rejoin-two-offers",
    doc: "an answer lost with the timers running: b answered a's first offer, the answer was dropped, a still waits in have-local-offer and the clock has moved on",
    holds: (room) => {
      const answer = lastPublished(room, "b", "answer")
      const conn = connOf(room, "a")
      return answer?.id !== undefined
        && !room.enabled().some((label) => label.startsWith(`wire:b>a:${answer.id}:`))
        && !room.logs().deliveries.some((delivery) => delivery.frameId === answer.id)
        // no recovery attempted yet: the actor's count (Mesh keeps none)
        && conn?.pc.signalingState === "have-local-offer" && room.internals("a").runner?.state("b")?.budgets.failCount === 0
        && room.enabled().includes("clock:next")
    },
  },
  "ice-failed": {
    scenario: "outage",
    doc: "just after a's link failed on a steady pair: the steady warmup, then env:ice:a:failed; a's PC reads failed, b's still connected, nothing healed yet",
    holds: (room) => iceDown(room, "failed"),
  },
  "ice-disconnected": {
    scenario: "outage",
    doc: "just after a's link went disconnected on a steady pair: the steady warmup, then env:ice:a:disconnected; a's PC reads disconnected, b's still connected, nothing healed yet",
    holds: (room) => iceDown(room, "disconnected"),
  },
  "network-all": {
    scenario: "rejoin-two-offers",
    doc: "a network change on both phones at one instant on a steady pair (the abstract room's network-all run): the steady warmup, then env:network:a and env:network:b, each side's repair issued, nothing negotiated yet",
    holds: (room) => (["a", "b"] as const).every((side) => room.logs().inputs.some((input) => input.side === side && input.kind === "env:network")),
  },
} as const satisfies Record<string, MeshAnchor>

export type MeshAnchorName = keyof typeof MESH_ANCHORS
export const MESH_ANCHOR_NAMES = Object.keys(MESH_ANCHORS) as MeshAnchorName[]
export const isMeshAnchor = (name: string): name is MeshAnchorName => Object.hasOwn(MESH_ANCHORS, name)

export interface MeshAnchorFixture {
  name: string
  scenario: ScenarioName
  doc: string
  sourceSha: string
  warmup: Label[]
}

export const meshAnchorFile = (name: string): string => resolve(import.meta.dirname, "anchors", `${name}.json`)

export function readMeshAnchor(name: MeshAnchorName): MeshAnchorFixture {
  return JSON.parse(readFileSync(meshAnchorFile(name), "utf8")) as MeshAnchorFixture
}
