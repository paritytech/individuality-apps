// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { stepPeerActor } from "../../state-machines/peer-actor"
import { bfs, hash64, ShardedIndex, type ActorBfsResult, type Stepper } from "./bfs"
import { peerTransitionTable } from "../../state-machines/peer.definition"
import { CAUSES, candidates, coverageObserver, EVENT_TYPES, mergeResults, renderCandidates, type Coverage } from "./candidates"
import { HELD_CONSTANTS } from "./world"

const BOUNDS = "d = 2, F = 1, H = n/a, from the 3 initial worlds (planted)"

/** A search with the coverage observer, its result carrying the coverage. */
function observed(depth: number, step: Stepper = stepPeerActor): ActorBfsResult {
  const observer = coverageObserver(step)
  const result = bfs({ depth, maxStates: 50_000, faults: 1 }, { step, observe: observer.observe, check: false })
  return { ...result, coverage: observer.coverage(`d = ${depth}, F = 1, H = n/a, from the 3 initial worlds`) }
}

const node = (link: string, extra: Record<string, unknown> = {}) => JSON.stringify({ actor: { link, away: "here", ...extra }, faultsLeft: 1 })

/** A planted graph: its own nodes and edges, and a coverage that reaches
 *  every cell, command, cause, site and guard but the ones a test leaves out. */
function planted(graph: Pick<ActorBfsResult["graph"], "nodes" | "edges"> & { expanded?: number; cut?: number[] }, coverage: Partial<Coverage> = {}): ActorBfsResult {
  const full = coverageObserver().coverage(BOUNDS)
  const everything = coverageObserver().everything()
  return {
    states: graph.nodes.length,
    edgeCount: graph.edges.length,
    capped: false,
    frontier: 0,
    constants: HELD_CONSTANTS,
    depthCompleted: 2,
    frontierClosed: false,
    cuts: { depth: 0, faults: 0, domain: 0 },
    violations: [],
    graph: { nodes: graph.nodes, edges: graph.edges, roots: [0], expanded: graph.expanded ?? graph.nodes.length, cut: graph.cut ?? [] },
    coverage: { ...full, ...everything, ...coverage },
  }
}

/** The region pairs the graph itself groups (not the sheet's pairs it is silent on). */
const graphPairs = (list: ReturnType<typeof candidates>) => list.filter((candidate) => candidate.kind === "equivalent-states" && !candidate.why.startsWith("the graph is silent"))

describe("phase B: simplification candidates", () => {
  it("lists a field forced to its initial value that changes no command", () => {
    const clean = candidates(observed(3), { equivalenceDepth: 3 })
    const listed = (list: typeof clean) => list.filter((candidate) => candidate.kind === "field" && candidate.strength !== "static only").map((candidate) => candidate.item)
    const fields = listed(clean)
    // never set: constant within bounds, and not hidden by HELD_CONSTANTS
    expect(fields).toContain("actor.scope.game")
    // read for decisions within these bounds: never listed
    expect(fields).not.toContain("actor.initiator")
    expect(fields).not.toContain("actor.connectionEpoch")

  }, 120_000)

  it("groups states with identical labelled futures to depth 3", () => {
    // 0 and 1 differ only in their region, and behave alike on every label;
    // 2 issues a different command on "x"
    const nodes = [node("connecting"), node("link-down"), node("connected"), node("closed")]
    const edges: ActorBfsResult["graph"]["edges"] = [
      [0, "x", 3, ["replace-connection:failed:offer"]],
      [0, "y", 0, []],
      [1, "x", 3, ["replace-connection:failed:offer"]],
      [1, "y", 1, []],
      [2, "x", 3, ["restart-ice:soft-disconnect"]],
      [2, "y", 2, []],
    ]
    const list = candidates(planted({ nodes, edges }), { equivalenceDepth: 3 })
    const groups = graphPairs(list)
    expect(groups.map((candidate) => candidate.item)).toEqual(["regions connecting + link-down"])
    expect(groups[0]!.why).toMatch(/1 group/)
    // a node whose depth-3 future reaches past the expanded nodes is never grouped
    const open = candidates(planted({ nodes, edges, expanded: 2 }), { equivalenceDepth: 3 })
    expect(graphPairs(open)).toEqual([])
  })

  it("groups only to its depth: a difference at depth 2 or 3 splits, one at depth 4 does not, and a cut node never groups", () => {
    // A (connecting) and B (link-down) differ two steps on: x, then y issues another command
    const shallow = [node("connecting"), node("link-down"), node("connected", { id: "c" }), node("connected", { id: "d" }), node("closed")]
    const shallowEdges: ActorBfsResult["graph"]["edges"] = [
      [0, "x", 2, []], [1, "x", 3, []], [2, "y", 4, ["sweep"]], [3, "y", 4, ["request-keyframe"]], [4, "z", 4, []],
    ]
    expect(graphPairs(candidates(planted({ nodes: shallow, edges: shallowEdges }), { equivalenceDepth: 3 }))).toEqual([])

    // the same, four steps on: beyond the depth, so the two group (the bound, documented)
    const chain = (start: string, cmd: string, base: number) => {
      const nodes = [node(start), ...[1, 2, 3].map((i) => node("connected", { id: `${start}${i}` }))]
      const edges: ActorBfsResult["graph"]["edges"] = [[base, "x", base + 1, []], [base + 1, "x", base + 2, []], [base + 2, "x", base + 3, []], [base + 3, "x", 8, [cmd]]]
      return { nodes, edges }
    }
    const a = chain("connecting", "sweep", 0)
    const b = chain("link-down", "request-keyframe", 4)
    const deep = planted({ nodes: [...a.nodes, ...b.nodes, node("closed")], edges: [...a.edges, ...b.edges, [8, "x", 8, ["close-connection"]]] })
    expect(graphPairs(candidates(deep, { equivalenceDepth: 3 })).map((candidate) => candidate.item)).toEqual(["regions connecting + link-down"])

    // two nodes alike in every label, one of them with an edge cut for leaving its range
    const twins = [node("connecting"), node("link-down"), node("closed")]
    const twinEdges: ActorBfsResult["graph"]["edges"] = [[0, "x", 2, []], [1, "x", 2, []], [2, "x", 2, ["close-connection"]]]
    expect(graphPairs(candidates(planted({ nodes: twins, edges: twinEdges }), { equivalenceDepth: 3 }))).toHaveLength(1)
    expect(graphPairs(candidates(planted({ nodes: twins, edges: twinEdges, cut: [1] }), { equivalenceDepth: 3 }))).toEqual([])
  })

  it("marks an unreached cell present in the transition table as a likely generator gap", () => {
    const everything = coverageObserver().everything()
    const cells = { ...everything.cells }
    delete cells["connected|network-changed"]
    const list = candidates(planted({ nodes: [node("yielded")], edges: [] }, { cells }), { equivalenceDepth: 3 })
    const cell = list.find((candidate) => candidate.kind === "unreached-cell" && candidate.item === "connected × network-changed")
    expect(cell).toMatchObject({ likely: "generator-gap", bounds: BOUNDS })
    expect(cell!.why).toMatch(/transition table/)
    // the planted coverage reaches every other cell of the open regions
    expect(list.filter((candidate) => candidate.kind === "unreached-cell" && candidate.likely === "generator-gap")).toHaveLength(1)
  })

  it("reads a field the static slice finds a decision read for as a generator gap, not dead", () => {
    const fields = { "budgets.stallHeals": { values: ["0", "1"], matters: null, shadowOnly: null } }
    const list = candidates(planted({ nodes: [node("yielded")], edges: [] }, { fields }), { equivalenceDepth: 3 })
    expect(list.find((candidate) => candidate.item === "actor.budgets.stallHeals")).toMatchObject({ kind: "field", likely: "generator-gap", strength: "bounded only" })
  })

  it("marks the strong items the graph agrees with only by construction as static (graph vacuous)", () => {
    const list = candidates(observed(2), { equivalenceDepth: 3 })
    for (const item of ["actor.scope.game"]) {
      expect(list.find((candidate) => candidate.item === item)?.strength, item).toBe("static (graph vacuous)")
    }
  }, 120_000)

  it("opens with what is deletable now and what waits for design B", () => {
    const text = renderCandidates(candidates(observed(2), { equivalenceDepth: 3 }))
    const now = text.split("\n").find((line) => line.startsWith("- **Deletable now"))!
    expect(now).toContain("actor.scope.game")
    // the coverage gaps sit in their own section (region merges, when the
    // graph groups any, in theirs)
    expect(text).toMatch(/## Coverage gaps/)
  }, 120_000)

  it("never prints the word dead without 'uncovered within bounds'", () => {
    const text = renderCandidates(candidates(observed(2), { equivalenceDepth: 3 }))
    expect(text).toMatch(/\bdead\b/)
    for (const line of text.split("\n")) {
      if (/\bdead\b/i.test(line)) expect(line).toContain("uncovered within bounds")
    }
    expect(text).toMatch(/independent semantic argument/)
    // every item names what its "never" depends on
    for (const line of text.split("\n").filter((entry) => entry.startsWith("- **["))) expect(line).toContain("Depends on:")
  }, 120_000)

  it("never lists the backoff clock as removable", () => {
    const list = candidates(observed(2), { equivalenceDepth: 3 })
    for (const candidate of list.filter((entry) => /lastAttemptAt|attempted\(\)/.test(entry.item))) {
      expect(candidate.likely).toBe("defensive")
      expect(candidate.strength).toBe("defensive (keep)")
      expect(candidate.why).toContain("backoff clock")
    }
  }, 120_000)

  it("labels the stale and duplicate guards defensive, never dead", () => {
    const list = candidates(observed(2), { equivalenceDepth: 3 })
    // the world has one room generation: the stale-room guard is never reached
    const room = list.find((candidate) => candidate.kind === "unreached-guard" && candidate.item === "stale-room")
    expect(room).toMatchObject({ likely: "defensive", strength: "defensive (keep)" })
  }, 120_000)

  it("declares every actor event type in the live table", () => {
    const declared = new Set(Object.values(peerTransitionTable).flatMap((row) => Object.keys(row).map((cell) => cell.split(":")[0])))
    for (const type of EVENT_TYPES) expect(declared.has(type), type).toBe(true)
  })

  it("names every replace-connection cause the actor's source spells out", () => {
    const source = readFileSync(join(import.meta.dirname, "../../state-machines/peer-actor.ts"), "utf8")
    const literals = new Set<string>()
    for (const pattern of [/replace\("([^"]+)"/g, /recover\("([^"]+)", false\)/g, /reinitiate\("([^"]+)"\)/g, /startRemoteSession\("([^"]+)"/g]) {
      for (const match of source.matchAll(pattern)) literals.add(match[1]!)
    }
    expect(literals.size).toBeGreaterThan(10)
    for (const literal of literals) expect(Object.keys(CAUSES)).toContain(literal)
  })

  it("merges two runs by their node keys", () => {
    const a = planted({ nodes: [node("yielded"), node("connected")], edges: [[0, "x", 1, []]], expanded: 1 })
    const b = planted({ nodes: [node("connected"), node("connecting")], edges: [[0, "y", 1, ["sweep"]]], expanded: 1 })
    const merged = mergeResults([a, b])
    expect(merged.graph.nodes).toEqual([node("yielded"), node("connected"), node("connecting")])
    expect(merged.graph.edges).toEqual([[0, "x", 1, []], [1, "y", 2, ["sweep"]]])
    expect(new Set(merged.graph.expandedSet)).toEqual(new Set([0, 1]))
  })

  it("spreads full keys across the index shards by a hash of the whole key", () => {
    // canonical keys share a long common suffix
    const keys = Array.from({ length: 5000 }, (_, i) => `{"actor":{"n":${i}},"mesh":{"tickedAt":"earlier"}}`)
    const split = new ShardedIndex(16, 1000)
    keys.forEach((key, i) => split.set(key, i))
    expect(split.size).toBe(5000)
    expect(split.largest).toBeLessThan(1000)
    expect(hash64(keys[0]!)).toHaveLength(4)
  })
})
