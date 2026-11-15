// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The named anchors for the pure-actor search: stable positions a real
 * game reaches, from which the search goes deep. A game is hundreds of actor
 * events, and a search from the start closes only about d = 7, so the short
 * windows after an unusual moment (a round change, a reload, a rejoin, away
 * and back, a network change, the camera off and on) are searched from just
 * after that moment instead.
 *
 * The source of truth is each anchor's label prefix: real alphabet keys,
 * walked from `initialWorlds` as the fair runs are. The committed fixture
 * (`anchors/<name>.json`) is that walk's world with the commit it was
 * captured at, so a run reads a fixed position; anchors.test.ts walks every
 * prefix again and fails with "refresh anchor <name>" when the fixture no
 * longer matches (a field added or removed, a step that changed). Recapture
 * with `EXPLORER_CAPTURE_ANCHORS=1 npx vitest run --config
 * vitest.explore.config.ts lib/explorer/anchors.test.ts` (from
 * apps/jollity-app).
 *
 * The fault budget: a prefix may itself spend faults (a reload and a network
 * change are fault labels), so the anchor's world starts the search with the
 * search's own F. F counts faults past the anchor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { FAIR_RUNS, walk } from "./bfs"
import { canonical } from "./canon"
import { initialWorlds, upgradeWorld, type ActorWorld } from "./world"

export interface ActorAnchor {
  /** which initial world the prefix starts from */
  from: "initiator" | "answerer"
  keys: readonly string[]
  /** what the position is, for the README and the report */
  doc: string
  /** the mesh-pair anchor (mesh/anchors.ts) at the same moment, when the room can reach it */
  mesh?: string
}

/** The fair runs' ends with the peer heard: connected, the lane answered, video flowing, presence fresh. */
const STEADY = {
  initiator: [...FAIR_RUNS.initiator, "peer-heard"],
  answerer: [...FAIR_RUNS.answerer, "peer-heard"],
} as const

export const ACTOR_ANCHORS = {
  "steady-initiator": {
    from: "initiator",
    keys: STEADY.initiator,
    doc: "connected and steady mid-round: the initiator's fair run (statement offer answered, channel open, lane offer answered, frames advancing), then the peer heard",
    mesh: "steady",
  },
  "steady-answerer": {
    from: "answerer",
    keys: STEADY.answerer,
    doc: "the same steady link from the answerer's side",
    mesh: "steady",
  },
  "round-changed": {
    from: "initiator",
    keys: [...STEADY.initiator, "round-changed"],
    doc: "just after a round change on a steady link: the round's budgets and seen-video facts start over",
  },
  "peer-reloaded-initiator": {
    from: "initiator",
    keys: [...STEADY.initiator, "peer-session-changed"],
    doc: "just after the peer reloaded (a new session): the initiator replaced the connection and is about to offer again",
    mesh: "after-reload",
  },
  "peer-reloaded-answerer": {
    from: "answerer",
    keys: [...STEADY.answerer, "peer-session-changed"],
    doc: "just after the peer reloaded, from the answerer's side: the connection replaced, waiting for the new session's offer",
    mesh: "after-reload",
  },
  "rejoin-queued-offers": {
    from: "answerer",
    keys: [...STEADY.answerer, "peer-session-changed", "description:statement-offer"],
    doc: "a rejoin with offers queued (#1385's shape): the peer reloaded, its first new offer is being applied, and another offer can still arrive",
    mesh: "rejoin-queued-offers",
  },
  "away-and-back": {
    from: "initiator",
    keys: [...STEADY.initiator, "peer-away:said", "peer-away:back"],
    doc: "after the peer said it was away and came back on the open channel (its mark-back still open)",
  },
  "hidden-and-shown": {
    from: "initiator",
    keys: [...STEADY.initiator, "visibility:hide", "visibility:show-long"],
    doc: "after this phone was hidden for more than 8 s and shown again: the kick's sweep has run, a keyframe asked for",
  },
  "network-changed": {
    from: "initiator",
    keys: [...STEADY.initiator, "network-changed", "complete:restart-ice:resolved"],
    doc: "after a network change: the ICE restart it asked for has resolved, the link recovering",
  },
  "camera-off-on": {
    from: "initiator",
    keys: [...STEADY.initiator, "stats:camera-down", "stats:advance", "stats:camera-up"],
    doc: "after our camera went off and came back on, with the peer's video still advancing",
  },
} as const satisfies Record<string, ActorAnchor>

export type ActorAnchorName = keyof typeof ACTOR_ANCHORS
export const ACTOR_ANCHOR_NAMES = Object.keys(ACTOR_ANCHORS) as ActorAnchorName[]

const isActorAnchor = (name: string): name is ActorAnchorName => Object.hasOwn(ACTOR_ANCHORS, name)

/** The committed fixture of one anchor. */
export interface ActorAnchorFixture {
  name: string
  from: ActorAnchor["from"]
  keys: string[]
  doc: string
  /** the commit (git HEAD) the world was captured at */
  sourceSha: string
  /** canonical(world), for a quick drift check */
  key: string
  world: ActorWorld
}

export const anchorFile = (name: string): string => resolve(import.meta.dirname, "anchors", `${name}.json`)

/** Walks one anchor's prefix (with the given fault budget for the walk, then F past it). */
export function walkAnchor(name: ActorAnchorName, faults: number): ActorWorld {
  const anchor: ActorAnchor = ACTOR_ANCHORS[name]
  const start = initialWorlds(Math.max(faults, anchor.keys.length)).find((entry) => entry.label === anchor.from)!.world
  const world = walk(start, anchor.keys)
  world.faultsLeft = faults
  return world
}

/** The fixture a capture writes: the walked world with F = 0 (a run sets its own). */
export function captureAnchor(name: ActorAnchorName, sourceSha: string): ActorAnchorFixture {
  const anchor: ActorAnchor = ACTOR_ANCHORS[name]
  const world = walkAnchor(name, 0)
  // through JSON, so the committed world is exactly what a load reads back
  const stored = JSON.parse(JSON.stringify(world)) as ActorWorld
  return { name, from: anchor.from, keys: [...anchor.keys], doc: anchor.doc, sourceSha, key: canonical(stored), world: stored }
}

/** The committed fixture, its world upgraded to the current shape (upgradeWorld:
 *  a fixture captured before the actor kept its own times). Its `key` is the
 *  one it was captured with. */
export function readAnchorFixture(name: ActorAnchorName): ActorAnchorFixture {
  const fixture = JSON.parse(readFileSync(anchorFile(name), "utf8")) as ActorAnchorFixture
  return { ...fixture, world: upgradeWorld(fixture.world) }
}

/** The committed anchor's world, ready to search with F faults past it. */
export function loadAnchor(name: ActorAnchorName, faults: number): ActorWorld {
  const world = readAnchorFixture(name).world
  world.faultsLeft = faults
  return world
}

/** `--anchor`'s value as a list of anchor names ("all" is every one). */
export function anchorNames(value: string): ActorAnchorName[] {
  if (value === "all") return [...ACTOR_ANCHOR_NAMES]
  const names = value.split(",")
  for (const name of names) if (!isActorAnchor(name)) throw new Error(`unknown peer-actor anchor: ${name} (have ${ACTOR_ANCHOR_NAMES.join(", ")}, or all)`)
  return names as ActorAnchorName[]
}
