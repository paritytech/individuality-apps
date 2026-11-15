// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// quiescence first: it traps the real timers before anything else loads
import "./mesh/quiescence"
import { execSync, spawnSync } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { ACTOR_ANCHOR_NAMES, ACTOR_ANCHORS, anchorFile, anchorNames, captureAnchor, loadAnchor, readAnchorFixture, walkAnchor } from "./actor/anchors"
import { canonical } from "./actor/canon"
import { fairPick } from "./mesh/fair"
import { MESH_ANCHOR_NAMES, MESH_ANCHORS, meshAnchorFile, readMeshAnchor, type MeshAnchorName } from "./mesh/anchors"
import { exploreRoom, type Room } from "./mesh/room"
import type { Label } from "./core/labels"

/** EXPLORER_CAPTURE_ANCHORS=1 rewrites every fixture from its definition instead of checking it. */
const CAPTURE = process.env.EXPLORER_CAPTURE_ANCHORS === "1"
const sha = () => execSync("git rev-parse --short=12 HEAD", { encoding: "utf8" }).trim()
const write = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("peer-actor anchors", () => {
  it.runIf(CAPTURE)("captures every anchor's world with the source commit", () => {
    const at = sha()
    for (const name of ACTOR_ANCHOR_NAMES) write(anchorFile(name), captureAnchor(name, at))
  })

  it.each(ACTOR_ANCHOR_NAMES)("%s: the committed world is its prefix's walk ", (name) => {
    const fixture = readAnchorFixture(name)
    const fresh = captureAnchor(name, fixture.sourceSha)
    expect(fixture.keys, `refresh anchor ${name}: its prefix changed`).toEqual([...ACTOR_ANCHORS[name].keys])
    // the committed key is the captured shape's; the upgraded world is checked against today's
    expect(canonical(fixture.world), `refresh anchor ${name}: the walk no longer reaches the committed world`).toBe(fresh.key)
    expect(fixture.world, `refresh anchor ${name}`).toEqual(fresh.world)
    expect(fixture.sourceSha).toMatch(/^[0-9a-f]{7,40}$/)
  })

  it.each(ACTOR_ANCHOR_NAMES)("%s: starts the search with the search's own F, whatever the prefix spent", (name) => {
    for (const faults of [0, 1, 2]) {
      expect(loadAnchor(name, faults).faultsLeft).toBe(faults)
      expect(walkAnchor(name, faults).faultsLeft).toBe(faults)
    }
    // the loaded world is the walked one: same key, F aside
    expect(canonical(loadAnchor(name, 1))).toBe(canonical(walkAnchor(name, 1)))
  })

  it("rests every anchor between drains, or at a choice (a stable position)", () => {
    for (const name of ACTOR_ANCHOR_NAMES) {
      const world = walkAnchor(name, 1)
      expect(world.queue.every((entry) => entry.type === "choice"), name).toBe(true)
      expect(world.actor.link, name).not.toBe("closed")
    }
  })

  it("reads --anchor as one name, a list, or all", () => {
    expect(anchorNames("all")).toEqual(ACTOR_ANCHOR_NAMES)
    expect(anchorNames("steady-initiator,camera-off-on")).toEqual(["steady-initiator", "camera-off-on"])
    expect(() => anchorNames("nowhere")).toThrow(/unknown peer-actor anchor: nowhere/)
  })

  it("names a mesh anchor only where the room has one", () => {
    for (const name of ACTOR_ANCHOR_NAMES) {
      const mesh = (ACTOR_ANCHORS[name] as { mesh?: string }).mesh
      if (mesh !== undefined) expect(MESH_ANCHOR_NAMES).toContain(mesh)
    }
  })
})

/** The fair scheduler from the room's start until the anchor holds. */
async function fairUntil(room: Room, holds: (room: Room) => boolean, limit = 80): Promise<Label[]> {
  const since = new Map<Label, number>()
  const labels: Label[] = []
  for (let step = 0; step < limit; step++) {
    if (holds(room)) return labels
    const enabled = room.enabled()
    for (const label of [...since.keys()]) if (!enabled.includes(label)) since.delete(label)
    for (const label of enabled) if (!since.has(label)) since.set(label, step)
    const pick = fairPick(enabled, since)
    labels.push(pick)
    await room.step(pick)
  }
  throw new Error(`the fair run did not reach the anchor in ${limit} labels`)
}

/** a fixed label, or clock:next until the label is enabled */
type RecipeStep = Label | { clockUntil: Label }

/** The room's own anchors: an optional base anchor's warmup, then fixed steps. */
const RECIPES: Partial<Record<MeshAnchorName, { from?: MeshAnchorName; steps: RecipeStep[] }>> = {
  // a's offer published and left on the wire; b's supervisor times out, rebuilds and offers
  "mid-glare": {
    steps: ["pc:a/1:negotiationneeded", "wire:a>b:wire-1:deliver", "wire:b>a:wire-2:deliver", "pc:a/1:sld:resolve", "pc:a/1:gather", { clockUntil: "pc:b/2:negotiationneeded" }, "pc:b/2:negotiationneeded", "pc:b/2:sld:resolve", "pc:b/2:gather"],
  },
  // the new b reads a's stored first offer and applies it; a never heard b's new hello
  "half-open": { from: "after-reload", steps: ["wire:a>b:wire-1:deliver", "wire:a>b:wire-3:deliver", "pc:b/2:srd:resolve"] },
  // a hears b's new hello, replaces its connected a/1 and offers from a/2
  "mid-rebuild": { from: "after-reload", steps: ["wire:b>a:wire-5:deliver", "pc:a/2:negotiationneeded", "pc:a/2:sld:resolve", "pc:a/2:gather"] },
  // b's answer to a's first offer dropped, then two clock ticks (a recovers only at about 33 s)
  // the outage scenario's: steady, then one drop on a's side
  "ice-failed": { from: "steady", steps: ["env:ice:a:failed"] },
  "ice-disconnected": { from: "steady", steps: ["env:ice:a:disconnected"] },
  // the abstract room's network-all moment on a pair: a's network change, then b's at once
  "network-all": { from: "steady", steps: ["env:network:a", "env:network:b"] },
  "lost-signal": {
    steps: ["pc:a/1:negotiationneeded", "wire:a>b:wire-1:deliver", "wire:b>a:wire-2:deliver", "pc:a/1:sld:resolve", "pc:a/1:gather", "wire:a>b:wire-3:deliver", "pc:b/1:srd:resolve", "pc:b/1:sld:resolve", "pc:b/1:gather", "wire:b>a:wire-4:drop", "clock:next", "clock:next"],
  },
}

async function runRecipe(room: Room, recipe: { from?: MeshAnchorName; steps: RecipeStep[] }): Promise<Label[]> {
  const labels: Label[] = recipe.from ? [...readMeshAnchor(recipe.from).warmup] : []
  await room.replay(labels)
  for (const step of recipe.steps) {
    if (typeof step === "string") {
      await room.step(step)
      labels.push(step)
      continue
    }
    for (let tick = 0; !room.enabled().includes(step.clockUntil); tick++) {
      if (tick >= 80) throw new Error(`the clock did not enable ${step.clockUntil} in 80 ticks`)
      await room.step("clock:next")
      labels.push("clock:next")
    }
  }
  return labels
}

async function captureWarmup(name: MeshAnchorName): Promise<Label[]> {
  const room = await exploreRoom({ scenario: MESH_ANCHORS[name].scenario, phaseOffsetMs: 1000 })
  try {
    if (name === "steady") return await fairUntil(room, MESH_ANCHORS.steady.holds)
    if (name === "after-reload") return [...readMeshAnchor("steady").warmup, "env:reload:b"]
    if (name === "rejoin-queued-offers") return (JSON.parse(readFileSync(resolve(import.meta.dirname, "mutants/M1385-on.json"), "utf8")) as { warmup: Label[] }).warmup
    const recipe = RECIPES[name]
    if (!recipe) throw new Error(`no capture recipe for mesh anchor ${name}`)
    return await runRecipe(room, recipe)
  } finally {
    room.close()
  }
}

describe("mesh-pair anchors", () => {
  it.runIf(CAPTURE)("captures every anchor's warmup with the source commit", async () => {
    const at = sha()
    // in order: after-reload builds on steady's file, half-open and mid-rebuild on after-reload's
    for (const name of MESH_ANCHOR_NAMES) {
      write(meshAnchorFile(name), { name, scenario: MESH_ANCHORS[name].scenario, doc: MESH_ANCHORS[name].doc, sourceSha: at, warmup: await captureWarmup(name) })
    }
  })

  it.each(MESH_ANCHOR_NAMES)("%s: the committed warmup replays clean, and the anchor holds", async (name) => {
    const fixture = readMeshAnchor(name)
    expect(fixture.scenario).toBe(MESH_ANCHORS[name].scenario)
    expect(fixture.sourceSha).toMatch(/^[0-9a-f]{7,40}$/)
    expect(fixture.warmup, `refresh anchor ${name}`).toEqual(await captureWarmup(name))
    const room = await exploreRoom({ scenario: fixture.scenario, phaseOffsetMs: 1000 })
    try {
      await room.replay(fixture.warmup)
      expect(room.violations(), name).toEqual([])
      expect(MESH_ANCHORS[name].holds(room), `refresh anchor ${name}: the position does not hold`).toBe(true)
    } finally {
      room.close()
    }
  })
})

describe("npm run explore -- --machine mesh-pair over the anchors", () => {
  it("searches every mesh anchor past its warmup and writes one merged report (exit 0, clean)", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "explorer-mesh-anchors-")), "result")
    const run = spawnSync("npm", ["run", "explore", "--", "--machine", "mesh-pair", "--anchor", "all", "--depth", "2", "--no-self-test", "--workers", "2", "--out", out], { cwd: resolve(import.meta.dirname, "../../../.."), encoding: "utf8" })
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const merged = JSON.parse(readFileSync(join(out, "anchors.json"), "utf8"))
    expect(merged.rows.map((row: { anchor: string }) => row.anchor)).toEqual([...MESH_ANCHOR_NAMES].sort())
    for (const row of merged.rows) expect(row, row.anchor).toMatchObject({ exit: 0, closedAtDepth: 2, violations: 0 })
    const steady = JSON.parse(readFileSync(join(out, "steady", "report.json"), "utf8"))
    // past the warmup only the clock and b's reload are enabled at the root
    expect(steady.source).toMatchObject({ anchor: "steady", warmupLength: readMeshAnchor("steady").warmup.length })
  }, 300_000)
})
