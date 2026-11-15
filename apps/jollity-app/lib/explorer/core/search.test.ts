// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  isFault,
  parseLabel,
  type Label,
  type StepRecord,
} from "./labels"
import { mergeReports } from "./cli"
import { verdictLine, writeReport } from "./report"
import {
  search,
  replayCollisionPair,
  type Cut,
  type Leaf,
  type SearchRoom,
} from "./search"

class ToyRoom implements SearchRoom {
  private labels: Label[] = []
  private faults = 1

  constructor(
    private readonly options: {
      faults?: number
      violationDepth?: number
      horizonDepth?: number
      delayMs?: number
      planted?: boolean
      harnessDetail?: string
      events?: string[]
    } = {},
  ) {}

  enabled(): Label[] {
    this.options.events?.push(`enabled:${this.labels.join(",")}`)
    if (this.options.harnessDetail) {
      throw new Error(this.options.harnessDetail)
    }
    return this.labels.length % 2 === 0
      ? ["x", "env:reload:a"]
      : ["x", "y"]
  }

  async step(label: Label): Promise<StepRecord> {
    this.options.events?.push(`step:${label}`)
    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs))
    }
    this.labels.push(label)
    if (label === "env:reload:a") this.faults -= 1
    return {
      index: this.labels.length - 1,
      label,
      frames: [],
      commands: [],
      outcomes: [],
      accepted: [],
      clockMs: 0,
      turns: 0,
    }
  }

  async reset(): Promise<void> {
    this.options.events?.push("reset")
    this.labels = []
    this.faults = this.options.faults ?? 1
  }

  violations(): { property: string; atStep: number; detail: string }[] {
    if (
      this.options.planted !== false &&
      ["x,y,x", "env:reload:a,x,x,x"].includes(this.labels.join(","))
    ) {
      return [
        {
          property: "toy",
          atStep: this.labels.length - 1,
          detail: "planted",
        },
      ]
    }
    if (
      this.options.violationDepth !== undefined &&
      this.labels.length === this.options.violationDepth
    ) {
      return [
        {
          property: "sample",
          atStep: this.labels.length - 1,
          detail: this.labels.join(","),
        },
      ]
    }
    return []
  }

  faultsLeft(): number {
    return this.faults
  }

  horizonReached(): boolean {
    return (
      this.options.horizonDepth !== undefined &&
      this.labels.length >= this.options.horizonDepth
    )
  }

  fingerprint(): string {
    return this.labels.join(",")
  }
}

const makeRoom = (options?: ConstructorParameters<typeof ToyRoom>[0]) =>
  async (): Promise<SearchRoom> => new ToyRoom(options)

class UnevenRoom implements SearchRoom {
  private labels: Label[] = []

  enabled(): Label[] {
    if (this.labels.length === 0) return ["heavy", "light"]
    if (this.labels[0] === "heavy") {
      return ["heavy-0", "heavy-1", "heavy-2", "heavy-3", "heavy-4", "heavy-5"]
    }
    if (this.labels[0] === "light") return ["light-0"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return {
      index: this.labels.length - 1,
      label,
      frames: [],
      commands: [],
      outcomes: [],
      accepted: [],
      clockMs: 0,
      turns: 0,
    }
  }

  async reset(): Promise<void> {
    this.labels = []
  }

  violations(): [] {
    return []
  }

  faultsLeft(): number {
    return 1
  }

  horizonReached(): boolean {
    return false
  }
}

class ShardRegressionRoom implements SearchRoom {
  private labels: Label[] = []

  constructor(
    private readonly options: {
      throwOnRootStep?: boolean
      returnFromEarly?: boolean
    } = {},
  ) {}

  enabled(): Label[] {
    if (this.labels.length === 0) return ["early", "later"]
    if (this.labels[0] === "early") return ["early-0"]
    if (this.labels[0] === "later") return ["later-0", "later-1"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    if (this.options.throwOnRootStep && label === "early") {
      throw new Error("root replay failed")
    }
    this.labels.push(label)
    return {
      index: this.labels.length - 1,
      label,
      frames: [],
      commands: [],
      outcomes: [],
      accepted: [],
      clockMs: 0,
      turns: 0,
    }
  }

  async reset(): Promise<void> {
    this.labels = []
  }

  violations(): [] {
    return []
  }

  faultsLeft(): number {
    return 1
  }

  horizonReached(): boolean {
    return this.options.returnFromEarly === true && this.labels[0] === "early"
  }
}

class MutatingLeafRoom implements SearchRoom {
  private labels: Label[] = []
  private mutated = false

  enabled(): Label[] {
    if (this.labels.length === 0) return ["root"]
    if (this.labels.length === 1) return ["env:reload:a", "child"]
    if (this.labels.length === 2) return this.mutated ? [] : ["grandchild"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return {
      index: this.labels.length - 1,
      label,
      frames: [],
      commands: [],
      outcomes: [],
      accepted: [],
      clockMs: 0,
      turns: 0,
    }
  }

  async reset(): Promise<void> {
    this.labels = []
    this.mutated = false
  }

  violations(): [] {
    return []
  }

  faultsLeft(): number {
    return 0
  }

  horizonReached(): boolean {
    return false
  }

  mutate(): void {
    this.mutated = true
  }
}

class CollisionRoom implements SearchRoom {
  private labels: Label[] = []
  constructor(private readonly diverges: boolean) {}
  enabled(): Label[] { return this.labels.length < 3 ? ["next"] : [] }
  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }
  async reset(): Promise<void> { this.labels = [] }
  violations(): [] { return [] }
  faultsLeft(): number { return 0 }
  horizonReached(): boolean { return false }
  fingerprint(): string { return "same-key" }
  collisionState() {
    return {
      enabled: this.enabled().map((label) => ({ key: label, label })),
      workCounters: this.diverges ? `hidden:${this.labels[0]}` : "same",
      findings: [],
      gaps: [],
    }
  }
  async collisionDrain() {
    return { outcome: "clean", workCounters: "drained", findings: [], gaps: [] }
  }
}

class ConvergingRoom implements SearchRoom {
  private labels: Label[] = []

  enabled(): Label[] {
    if (this.labels.length === 0) return ["a", "b"]
    if (this.labels.length === 1) return ["tail"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }

  async reset(): Promise<void> { this.labels = [] }
  violations(): [] { return [] }
  faultsLeft(): number { return 1 }
  horizonReached(): boolean { return false }
  fingerprint(): string { return this.labels.length === 1 ? "joined" : this.labels.join(",") }
}

class RemainingDepthRoom implements SearchRoom {
  private labels: Label[] = []

  enabled(): Label[] {
    const path = this.labels.join(",")
    if (path === "") return ["long", "short"]
    if (path === "long") return ["join"]
    if (path === "long,join" || path === "short") return ["tail"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }

  async reset(): Promise<void> { this.labels = [] }
  violations(): [] { return [] }
  faultsLeft(): number { return 1 }
  horizonReached(): boolean { return false }
  fingerprint(): string {
    return this.labels.join(",") === "long,join" || this.labels.join(",") === "short"
      ? "joined"
      : this.labels.join(",")
  }
}

class FaultBudgetRoom implements SearchRoom {
  private labels: Label[] = []
  private faults = 1

  enabled(): Label[] {
    if (this.labels.length === 0) return ["env:reload:a", "x"]
    if (this.labels.length === 1) return ["env:reload:b"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    if (isFault(label)) this.faults -= 1
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }

  async reset(): Promise<void> { this.labels = []; this.faults = 1 }
  violations() {
    return this.labels.join(",") === "x,env:reload:b"
      ? [{ property: "needs-fault", atStep: 1, detail: "reachable with the remaining fault" }]
      : []
  }
  faultsLeft(): number { return this.faults }
  horizonReached(): boolean { return false }
  fingerprint(): string { return this.labels.length === 1 ? "joined" : this.labels.join(",") }
}

class SeenFirstChildRoom implements SearchRoom {
  private labels: Label[] = []
  readonly siblingParents: string[] = []

  enabled(): Label[] {
    const path = this.labels.join(",")
    if (path === "") return ["prime", "parent"]
    if (path === "prime") return ["prime-tail"]
    if (path === "parent") return ["seen-child", "sibling"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    if (label === "sibling") this.siblingParents.push(this.labels.join(","))
    this.labels.push(label)
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }

  async reset(): Promise<void> { this.labels = [] }
  violations(): [] { return [] }
  faultsLeft(): number { return 1 }
  horizonReached(): boolean { return false }
  fingerprint(): string {
    return this.labels.join(",") === "prime" || this.labels.join(",") === "parent,seen-child"
      ? "seen"
      : this.labels.join(",")
  }
}

class SampledCheckRoom implements SearchRoom {
  private labels: Label[] = []
  collisionReads = 0

  constructor(private readonly duplicates: number) {}

  enabled(): Label[] {
    if (this.labels.length === 0) return Array.from({ length: this.duplicates + 1 }, (_, index) => `branch-${index}`)
    if (this.labels.length === 1) return ["tail"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }

  async reset(): Promise<void> { this.labels = [] }
  violations(): [] { return [] }
  faultsLeft(): number { return 1 }
  horizonReached(): boolean { return false }
  fingerprint(): string { return this.labels.length === 1 ? "joined" : this.labels.join(",") }
  collisionState() {
    this.collisionReads += 1
    return {
      enabled: this.enabled().map((label) => ({ key: label, label })),
      workCounters: "same",
      findings: [],
      gaps: [],
    }
  }
  async collisionDrain() { return { outcome: "clean", workCounters: "same", findings: [], gaps: [] } }
}

/** Depth-two nodes all share one key, so every later one is checked against the kept p,m. */
class KeptPathRoom implements SearchRoom {
  private labels: Label[] = []
  readonly prefixes = new Set<string>()

  enabled(): Label[] {
    if (this.labels.length === 0) return ["p", "q"]
    if (this.labels.length === 1) return ["m", "n"]
    if (this.labels.length === 2) return ["end"]
    return []
  }

  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }

  async reset(): Promise<void> { this.labels = [] }
  violations(): [] { return [] }
  faultsLeft(): number { return 0 }
  horizonReached(): boolean { return false }
  fingerprint(): string { return this.labels.length === 2 ? "joined" : this.labels.join(",") }
  collisionState() {
    this.prefixes.add(this.labels.slice(0, 2).join(","))
    const enabled = this.labels.length === 2 ? ["end"] : this.enabled()
    return { enabled: enabled.map((label) => ({ key: label, label })), workCounters: "same", findings: [], gaps: [] }
  }
  async collisionDrain() { return { outcome: "clean", workCounters: "same", findings: [], gaps: [] } }
}

describe("search", () => {
  it("replays a checked prune against the exact path that kept its key", async () => {
    const room = new KeptPathRoom()
    const result = await search(async () => room, { depth: 3, budgetMs: 10_000, dedup: { check: { oneIn: 1 } } })
    expect(result.levels[2]).toMatchObject({ seen: 3, cuts: { harness: 0, seen: 3 } })
    // the left side of every replay is the kept p,m; the right sides are the three pruned nodes
    expect([...room.prefixes].sort()).toEqual(["p,m", "p,n", "q,m", "q,n"])
  })

  it("deduplicates converged states with a seen leaf while staying off by default", async () => {
    const plain = await search(async () => new ConvergingRoom(), { depth: 2, budgetMs: 10_000 })
    const deduped = await search(async () => new ConvergingRoom(), { depth: 2, budgetMs: 10_000, dedup: {} })

    expect(plain.levels[1]?.cuts).toMatchObject({ depth: 2, seen: 0 })
    expect(deduped.levels[1]?.cuts).toMatchObject({ depth: 1, seen: 1 })
    expect(deduped.levels[1]?.leaves).toBe(2)
  })

  it("re-expands a key first reached with less remaining depth", async () => {
    const result = await search(async () => new RemainingDepthRoom(), {
      depth: 3,
      budgetMs: 10_000,
      dedup: {},
    })

    expect(result.levels[2]?.cuts).toMatchObject({ depth: 1, quiet: 1, seen: 0 })
    expect(result.levels[2]?.expanded).toBe(5)
  })

  it("keys dedup by faultsLeft and the negative control loses the fault-dependent violation", async () => {
    const exact = await search(async () => new FaultBudgetRoom(), {
      depth: 2,
      budgetMs: 10_000,
      dedup: {},
    })
    const weakened = await search(async () => new FaultBudgetRoom(), {
      depth: 2,
      budgetMs: 10_000,
      dedup: { includeFaults: false },
    })

    expect(exact.findings.map(({ property }) => property)).toContain("needs-fault")
    expect(weakened.findings).toEqual([])
  })

  it("restores the parent after a seen first child so the next sibling continues", async () => {
    const room = new SeenFirstChildRoom()
    const result = await search(async () => room, { depth: 3, budgetMs: 10_000, dedup: {} })

    expect(result.levels[2]?.cuts.seen).toBeGreaterThan(0)
    expect(room.siblingParents).toContain("parent")
  })

  it("samples every ordered 100th seen node for depth-two ground-truth replay", async () => {
    const below = new SampledCheckRoom(99)
    await search(async () => below, { depth: 2, budgetMs: 10_000, dedup: { check: { oneIn: 100 } } })
    expect(below.collisionReads).toBe(0)

    const sampled = new SampledCheckRoom(100)
    await search(async () => sampled, { depth: 2, budgetMs: 10_000, dedup: { check: { oneIn: 100 } } })
    expect(sampled.collisionReads).toBeGreaterThan(0)
  })

  it("reports shared-prefix dedup counters only in their owner shard", async () => {
    const parts = await Promise.all(
      [0, 1].map((index) =>
        search(async () => new ConvergingRoom(), {
          depth: 2,
          budgetMs: 10_000,
          dedup: {},
          shard: { index, of: 2, depth: 2 },
        }),
      ),
    )

    expect(parts[0]?.levels[0]).toMatchObject({ expanded: 1, seen: 0 })
    expect(parts[1]?.levels[0]).toMatchObject({ expanded: 0, seen: 0 })
    expect(parts[0]?.levels[1]).toMatchObject({ expanded: 2, seen: 0, cuts: { seen: 0 } })
    expect(parts[1]?.levels[1]).toMatchObject({ expanded: 0, seen: 1, cuts: { seen: 1 } })
  })

  it("enumerates the full tree at each depth: 2, 4, 8 leaves for depths 1-3", async () => {
    const result = await search(makeRoom({ planted: false }), {
      depth: 3,
      budgetMs: 10_000,
    })

    expect(result.levels.map(({ leaves }) => leaves)).toEqual([2, 4, 8])
    expect(result.closedAtDepth).toBe(3)
  })

  it("continues the first child from its parent's live room", async () => {
    const events: string[] = []

    await search(makeRoom({ planted: false, events }), {
      depth: 2,
      budgetMs: 10_000,
    })

    expect(events[events.indexOf("enabled:x") + 1]).toBe("step:x")
  })

  it("replays before the first child when a leaf mutated the live room", async () => {
    const result = await search(async () => new MutatingLeafRoom(), {
      depth: 3,
      budgetMs: 10_000,
      onLeaf: async (leaf) => {
        if (leaf.cut === "faults") (leaf.room as MutatingLeafRoom).mutate()
      },
    })

    expect(result.levels[2]?.cuts).toMatchObject({ depth: 1, quiet: 0 })
  })

  it("reports a default-off census without changing verdicts, leaves or findings", async () => {
    const plain = await search(makeRoom({ planted: false }), {
      depth: 3,
      budgetMs: 10_000,
    })
    const census = await search(makeRoom({ planted: false }), {
      depth: 3,
      budgetMs: 10_000,
      census: true,
    })

    expect(plain.levels.every((level) => level.census === undefined)).toBe(true)
    expect(census.levels.map((level) => level.census)).toEqual([
      { depthLeaves: 2, distinctFingerprints: 2, ratio: 1 },
      { depthLeaves: 4, distinctFingerprints: 4, ratio: 1 },
      { depthLeaves: 6, distinctFingerprints: 6, ratio: 1 },
    ])
    const verdictShape = (result: Awaited<ReturnType<typeof search>>) => ({
      levels: result.levels.map(({ depth, leaves, cuts, details }) => ({ depth, leaves, cuts, details })),
      findings: result.findings,
      closedAtDepth: result.closedAtDepth,
      inconclusive: result.inconclusive,
    })
    expect(verdictShape(census)).toEqual(verdictShape(plain))
    expect(census.findings).toEqual(plain.findings)
    expect(census.closedAtDepth).toBe(plain.closedAtDepth)
    expect(census.inconclusive).toBe(plain.inconclusive)
  })

  it("reports mean enabled labels and cut counts per depth", async () => {
    const result = await search(makeRoom(), { depth: 2, budgetMs: 10_000 })

    expect(result.levels.map(({ meanEnabled }) => meanEnabled)).toEqual([2, 2])
    expect(result.levels[1]?.cuts).toEqual({
      depth: 4,
      faults: 0,
      horizon: 0,
      quiet: 0,
      seen: 0,
      harness: 0,
    })
    expect(
      [
        "pc:a/1:srd:resolve",
        "pc:b/2:sld:reject:OperationError",
        "pc:a/1:gather",
        "pc:b/2:negotiationneeded",
        "pc:a/1:stats",
        "wire:a>b:f1:deliver",
        "wire:b>a:f2:capture",
        "lane:a>b:deliver",
        "clock:next",
        "env:reload:a",
        "env:signal-throws:b",
        "env:rebuild:a",
        "env:lane-close:b",
        "env:ice:a:disconnected",
        "env:network:b",
        "env:round",
      ].map((label) => parseLabel(label).kind),
    ).toEqual([
      "pc-operation",
      "pc-operation",
      "pc-gather",
      "pc-negotiationneeded",
      "pc-stats",
      "wire",
      "wire",
      "lane",
      "clock-next",
      "environment",
      "environment",
      "environment",
      "environment",
      "environment-ice",
      "environment-network",
      "environment-round",
    ])
    expect(isFault("env:ice:b:failed")).toBe(true)
    expect(isFault("env:network:a")).toBe(true)
    expect(isFault("wire:a>b:f1:deliver")).toBe(false)
    expect(() => parseLabel("unknown")).toThrow("unknown explorer label")
  })

  it("keeps the shortest planted violation when a longer path also violates", async () => {
    const result = await search(makeRoom(), { depth: 4, budgetMs: 10_000 })

    expect(result.findings).toContainEqual({
      property: "toy",
      labels: ["x", "y", "x"],
      atStep: 2,
      detail: "planted",
      sampled: false,
    })
  })

  it("cuts fault labels once the budget is spent and counts the cut", async () => {
    const result = await search(makeRoom({ faults: 0 }), {
      depth: 1,
      budgetMs: 10_000,
    })

    expect(result.levels[0]?.leaves).toBe(2)
    expect(result.levels[0]?.cuts).toMatchObject({ depth: 1, faults: 1 })
  })

  it("counts only depth leaves and never assigns a parent fingerprint to a fault cut", async () => {
    const result = await search(makeRoom({ faults: 0, planted: false }), {
      depth: 1,
      budgetMs: 10_000,
      census: true,
    })

    expect(result.levels[0]).toMatchObject({
      leaves: 2,
      cuts: { depth: 1, faults: 1 },
      census: { depthLeaves: 1, distinctFingerprints: 1, ratio: 1 },
      _censusKeys: ["x"],
    })
  })

  it("collision replay compares key-independent work and drain ground truth", async () => {
    const mismatch = await replayCollisionPair(new CollisionRoom(true), ["x"], ["y"], 2)
    expect(mismatch).toMatchObject({ left: ["x"], right: ["y"], suffix: [] })
    expect(mismatch?.leftNode?.state.workCounters).toBe("hidden:x")
    expect(mismatch?.rightNode?.state.workCounters).toBe("hidden:y")
    expect(await replayCollisionPair(new CollisionRoom(false), ["x"], ["y"], 2)).toBeNull()
  })

  it("counts every fault cut after the single fault is spent", async () => {
    const result = await search(makeRoom({ planted: false }), {
      depth: 3,
      budgetMs: 10_000,
    })

    expect(result.levels[2]?.cuts.faults).toBe(2)
  })

  it("stops on the time budget and says inconclusive", async () => {
    const result = await search(makeRoom({ delayMs: 5 }), {
      depth: 5,
      budgetMs: 1,
    })

    expect(result.inconclusive).toBe(true)
    expect(result.closedAtDepth).toBe(0)
  })

  it("reads its budget and level times from the clock it is given, not performance", async () => {
    // a room that fakes timers restarts performance at each reset; the given clock runs on
    let t = 0
    const result = await search(makeRoom(), { depth: 6, budgetMs: 100, now: () => (t += 10) })
    expect(result.inconclusive).toBe(true)
    expect(result.closedAtDepth).toBeLessThan(6)
    expect(result.levels[0]!.elapsedMs).toBeGreaterThan(0)
  })

  it("calls onLeaf for every leaf with its cut", async () => {
    const leaves: { labels: Label[]; cut: Cut }[] = []
    const onLeaf = async (leaf: Leaf) => {
      leaves.push({ labels: [...leaf.labels], cut: leaf.cut })
    }

    const result = await search(makeRoom({ faults: 0 }), {
      depth: 1,
      budgetMs: 10_000,
      onLeaf,
    })

    expect(leaves).toHaveLength(result.levels[0]?.leaves ?? 0)
    expect(leaves.map(({ cut }) => cut).sort()).toEqual(["depth", "faults"])
    expect(leaves.find(({ cut }) => cut === "faults")?.labels).toEqual([
      "env:reload:a",
    ])
  })

  it("preserves harness detail and counts it per level", async () => {
    const leaves: Leaf[] = []
    const result = await search(makeRoom({ harnessDetail: "watchdog" }), {
      depth: 1,
      budgetMs: 10_000,
      onLeaf: async (leaf) => {
        leaves.push(leaf)
      },
    })

    expect(leaves).toHaveLength(1)
    expect(leaves[0]?.detail).toBe("watchdog")
    expect(result.levels[0]?.details).toEqual({ watchdog: 1 })
  })

  it("propagates an error thrown by onLeaf", async () => {
    await expect(
      search(makeRoom({ planted: false }), {
        depth: 1,
        budgetMs: 10_000,
        onLeaf: async () => {
          throw new Error("consumer failed")
        },
      }),
    ).rejects.toThrow("consumer failed")
  })

  it("does not hand a violation to onLeaf as a normal depth leaf", async () => {
    const leaves: Leaf[] = []
    const result = await search(makeRoom(), {
      depth: 3,
      budgetMs: 10_000,
      onLeaf: async (leaf) => {
        leaves.push(leaf)
      },
    })

    expect(result.levels[2]?.leaves).toBe(7)
    expect(result.levels[2]?.cuts.depth).toBe(5)
    expect(leaves).not.toContainEqual(
      expect.objectContaining({ labels: ["x", "y", "x"] }),
    )
  })

  it("samples reproducibly beyond depth + 1 and changes paths with the seed", async () => {
    const bounds = {
      depth: 3,
      budgetMs: 10_000,
      sample: { count: 4, seed: 742, depth: 6 },
    }

    const first = await search(makeRoom({ violationDepth: 6 }), bounds)
    const second = await search(makeRoom({ violationDepth: 6 }), bounds)
    const different = await search(makeRoom({ violationDepth: 6 }), {
      ...bounds,
      sample: { ...bounds.sample, seed: 92_817 },
    })
    const firstSampled = first.findings.filter(({ sampled }) => sampled)

    expect(firstSampled).toEqual(
      second.findings.filter(({ sampled }) => sampled),
    )
    expect(firstSampled.some(({ labels }) => labels.length > bounds.depth + 1)).toBe(
      true,
    )
    expect(different.findings.filter(({ sampled }) => sampled)).not.toEqual(
      firstSampled,
    )
  })

  it("reports the last closed depth when the budget stops the next level", async () => {
    const result = await search(makeRoom({ delayMs: 5, planted: false }), {
      depth: 2,
      budgetMs: 30,
    })

    expect(result).toMatchObject({ closedAtDepth: 1, inconclusive: true })
    expect(
      verdictLine(result, { depth: 2, faults: 1, horizonMs: 120_000 }),
    ).toBe("clean at d = 1, F = 1, H = 120 s (inconclusive)")
  })

  it("says whether the frontier closed or the depth bound stopped the search", () => {
    const base = { levels: [], closedAtDepth: 4, inconclusive: false, findings: [] }
    const bounds = { depth: 4, faults: 1, horizonMs: 0 }
    expect(verdictLine(base, bounds)).toBe("clean at d = 4, F = 1, H = 0 s (closed at the depth bound)")
    expect(verdictLine({ ...base, frontierClosed: true }, bounds)).toBe("clean at d = 4, F = 1, H = 0 s (frontier closed)")
    expect(verdictLine(base, { ...bounds, dedup: true })).toBe("clean at d = 4, F = 1, H = 0 s (closed at the depth bound, dedup on the room fingerprint)")
  })

  it("writes a verdict line with its bounds and never the bare word clean", async () => {
    const result = await search(makeRoom({ planted: false }), {
      depth: 3,
      budgetMs: 10_000,
    })
    const verdict = verdictLine(result, {
      depth: 3,
      faults: 1,
      horizonMs: 120_000,
    })
    const dir = await mkdtemp(join(tmpdir(), "explorer-report-"))

    await writeReport(dir, "toy", result, {
      bounds: { depth: 3, faults: 1, horizonMs: 120_000 },
      source: { commit: "test", dirty: false },
    })

    expect(verdict).toMatch(
      /^clean at d = 3, F = 1, H = 120 s \((closed at the depth bound|frontier closed|inconclusive)\)$/,
    )
    expect(verdict).not.toBe("clean")
    await expect(readFile(join(dir, "report.json"), "utf8")).resolves.toContain(
      '"machine": "toy"',
    )
    await expect(readFile(join(dir, "summary.md"), "utf8")).resolves.toContain(
      verdict,
    )
  })

  it("writes census counts and ratios to report.json and summary.md", async () => {
    const result = await search(makeRoom({ planted: false }), {
      depth: 2,
      budgetMs: 10_000,
      census: true,
    })
    const dir = await mkdtemp(join(tmpdir(), "explorer-census-report-"))
    await writeReport(dir, "toy", result, {
      bounds: { depth: 2, faults: 0, horizonMs: 0 },
      source: { commit: "test", dirty: false },
    })

    const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"))
    expect(report.levels[1].census).toEqual({ depthLeaves: 4, distinctFingerprints: 4, ratio: 1 })
    expect(report.levels[1]._censusKeys).toBeUndefined()
    await expect(readFile(join(dir, "summary.md"), "utf8")).resolves.toContain(
      "4 leaves, 4 depth leaves, 4 distinct fingerprints, ratio 1.00x",
    )
  })

  it("two shards together give the unsharded leaf count", async () => {
    const shape = (result: Awaited<ReturnType<typeof search>>) => ({
      levels: result.levels.map(({ depth, leaves, meanEnabled, cuts, details }) => ({
        depth,
        leaves,
        meanEnabled,
        cuts,
        details,
      })),
      closedAtDepth: result.closedAtDepth,
      inconclusive: result.inconclusive,
      findings: result.findings,
    })
    for (const options of [{}, { faults: 0 }, { horizonDepth: 3 }]) {
      const whole = await search(makeRoom(options), { depth: 5, budgetMs: 10_000 })
      for (const of of [2, 3]) {
        const parts = await Promise.all(
          Array.from({ length: of }, (_, index) =>
            search(makeRoom(options), {
              depth: 5,
              budgetMs: 10_000,
              shard: { index, of },
            }),
          ),
        )
        // each shard does only part of the work
        expect(parts[0].levels[4].leaves).toBeLessThan(whole.levels[4].leaves)
        expect(shape(mergeReports(parts))).toEqual(shape(whole))
      }
    }
  })

  it("deals uneven root work by depth-two pairs", async () => {
    const leaves = await Promise.all(
      [0, 1].map(async (index) => {
        const result = await search(async () => new UnevenRoom(), {
          depth: 2,
          budgetMs: 10_000,
          shard: { index, of: 2, ...{ depth: 2 } },
        })
        return result.levels[1]?.leaves
      }),
    )

    expect(leaves).toEqual([3, 4])
  })

  it("records a shared-prefix harness cut when replay fails in one shard", async () => {
    const result = await search(
      async () => new ShardRegressionRoom({ throwOnRootStep: true }),
      {
        depth: 2,
        budgetMs: 10_000,
        shard: { index: 1, of: 2, depth: 2 },
      },
    )

    expect(result.levels[1]?.cuts.harness).toBe(1)
    expect(result.closedAtDepth).toBe(1)
  })

  it("deals later pairs identically when an earlier root returns", async () => {
    const laterLeaves = async (returnFromEarly: boolean): Promise<string[]> => {
      const labels: string[] = []
      await search(
        async () => new ShardRegressionRoom({ returnFromEarly }),
        {
          depth: 2,
          budgetMs: 10_000,
          shard: { index: 0, of: 2, depth: 2 },
          onLeaf: async (leaf) => {
            if (leaf.labels[0] === "later") labels.push(leaf.labels.join(","))
          },
        },
      )
      return labels
    }

    expect(await laterLeaves(true)).toEqual(await laterLeaves(false))
  })

  it("rejects a shard outside its plan", async () => {
    await expect(
      search(makeRoom(), { depth: 1, budgetMs: 1_000, shard: { index: 2, of: 2 } }),
    ).rejects.toThrow(RangeError)
  })
})
