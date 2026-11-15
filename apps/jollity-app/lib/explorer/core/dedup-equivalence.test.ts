// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { exitCode, mergeReports } from "./cli"
import { isFault, type Label, type StepRecord } from "./labels"
import { search, type SearchResult, type SearchRoom } from "./search"
import { readMeshAnchor } from "../mesh/anchors"
import { exploreRoom, type ScenarioName } from "../mesh/room"
import { SCENARIOS } from "../mesh/scenarios"

interface EquivalenceOutcome {
  result: SearchResult
  minimumDepthByKey: Map<string, number>
  gaps: Set<string>
}

const sorted = (values: Iterable<string>): string[] => [...values].sort()
const findings = (result: SearchResult): string[] => sorted(result.findings.map(({ property, detail }) => `${property}|${detail}`))
const code = (result: SearchResult) => exitCode({
  violations: result.findings.length,
  mutantMissed: false,
  harnessError: result.levels.some((level) => level.cuts.harness > 0),
  inconclusive: result.inconclusive,
})

async function runRoom(options: {
  scenario: ScenarioName
  depth: number
  dedup: boolean
  warmup?: readonly Label[]
  shards?: number
}): Promise<EquivalenceOutcome> {
  const warmup = options.warmup ?? []
  const parts: SearchResult[] = []
  const minimumDepthByKey = new Map<string, number>()
  const gaps = new Set<string>()
  const of = options.shards ?? 1
  for (let index = 0; index < of; index += 1) {
    const room = await exploreRoom({
      scenario: options.scenario,
      phaseOffsetMs: 1000,
      faults: SCENARIOS[options.scenario].defaults.faults + warmup.filter(isFault).length,
      horizonMs: SCENARIOS[options.scenario].defaults.horizonMs,
    })
    let depth = 0
    const observe = () => {
      const key = `${room.fingerprint()}\0F=${room.faultsLeft()}`
      minimumDepthByKey.set(key, Math.min(minimumDepthByKey.get(key) ?? Number.POSITIVE_INFINITY, depth))
      for (const gap of room.gaps()) gaps.add(`${gap.property}|${gap.issue ?? ""}|${gap.detail}`)
    }
    const searched: SearchRoom = {
      enabled: () => room.enabled(),
      async step(label) {
        const record = await room.step(label)
        depth += 1
        observe()
        return record
      },
      async reset() {
        await room.reset()
        for (const label of warmup) await room.step(label)
        depth = 0
        observe()
      },
      violations: () => room.violations().map((violation) => ({ ...violation, atStep: Math.max(0, violation.atStep - warmup.length) })),
      faultsLeft: () => room.faultsLeft(),
      horizonReached: () => room.horizonReached(),
      fingerprint: () => room.fingerprint(),
      collisionState: () => room.collisionState(),
      collisionDrain: () => room.collisionDrain(),
    }
    try {
      parts.push(await search(async () => searched, {
        depth: options.depth,
        budgetMs: 120_000,
        continueAfterViolation: true,
        ...(options.dedup ? { dedup: {} } : {}),
        ...(of > 1 ? { shard: { index, of, depth: 2 as const } } : {}),
      }))
    } finally {
      room.close()
    }
  }
  return { result: parts.length === 1 ? parts[0]! : mergeReports(parts), minimumDepthByKey, gaps }
}

function expectEquivalent(full: EquivalenceOutcome, reduced: EquivalenceOutcome): void {
  expect(code(reduced.result)).toBe(code(full.result))
  expect(findings(reduced.result)).toEqual(findings(full.result))
  expect(sorted(reduced.gaps)).toEqual(sorted(full.gaps))
  expect(reduced.result.closedAtDepth).toBe(full.result.closedAtDepth)
  expect(reduced.result.levels.every((level) => level.cuts.harness === 0)).toBe(true)
  expect(full.result.levels.every((level) => level.cuts.harness === 0)).toBe(true)
  expect([...reduced.minimumDepthByKey].sort()).toEqual([...full.minimumDepthByKey].sort())
}

class WeakFieldRoom implements SearchRoom {
  private labels: Label[] = []

  constructor(private readonly omitted: "opLog" | "timerTieRank" | "inputLog") {}

  enabled(): Label[] {
    if (this.labels.length === 0) return ["left", "right"]
    if (this.labels.length === 1) return ["tail"]
    return []
  }
  async step(label: Label): Promise<StepRecord> {
    this.labels.push(label)
    return { index: this.labels.length - 1, label, frames: [], commands: [], outcomes: [], accepted: [], clockMs: 0, turns: 0 }
  }
  async reset(): Promise<void> { this.labels = [] }
  violations() { return this.labels.join(",") === "right,tail" ? [{ property: this.omitted, atStep: 1, detail: "weak key hid the right future" }] : [] }
  faultsLeft(): number { return 1 }
  horizonReached(): boolean { return false }
  fingerprint(): string {
    const branch = this.labels[0] ?? "root"
    return JSON.stringify({
      stage: this.labels.length,
      opLog: this.omitted === "opLog" ? branch : "same",
      timerTieRank: this.omitted === "timerTieRank" ? branch : "same",
      inputLog: this.omitted === "inputLog" ? branch : "same",
    })
  }
  weakFingerprint(): string {
    const branch = this.labels[0] ?? "root"
    const state: Record<string, unknown> = {
      stage: this.labels.length,
      opLog: this.omitted === "opLog" ? branch : "same",
      timerTieRank: this.omitted === "timerTieRank" ? branch : "same",
      inputLog: this.omitted === "inputLog" ? branch : "same",
    }
    delete state[this.omitted]
    return JSON.stringify(state)
  }
}

describe("dedup equivalence", () => {
  const consoleLog = console.log
  const consoleWarn = console.warn
  beforeAll(() => {
    console.log = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.log = consoleLog
    console.warn = consoleWarn
  })

  for (const scenario of Object.keys(SCENARIOS) as ScenarioName[]) {
    for (const shards of [1, 3]) {
      it(`${scenario}, ${shards} shard${shards === 1 ? "" : "s"}`, async () => {
        const depth = 3
        const full = await runRoom({ scenario, depth, dedup: false, shards })
        const reduced = await runRoom({ scenario, depth, dedup: true, shards })
        expectEquivalent(
          full,
          reduced,
        )
        expect(reduced.result.levels.some((level) => (level.seen ?? 0) > 0)).toBe(true)
      }, 120_000)
    }
  }

  for (const anchor of ["steady", "after-reload", "rejoin-queued-offers"] as const) {
    it(`anchor ${anchor}`, async () => {
      const { scenario, warmup } = readMeshAnchor(anchor)
      expectEquivalent(
        await runRoom({ scenario, depth: 3, warmup, dedup: false }),
        await runRoom({ scenario, depth: 3, warmup, dedup: true }),
      )
    }, 120_000)
  }

  for (const omitted of ["opLog", "timerTieRank", "inputLog"] as const) {
    it(`negative control: removing ${omitted} fails the equivalence gate`, async () => {
      const fullRoom = new WeakFieldRoom(omitted)
      const exactRoom = new WeakFieldRoom(omitted)
      const reducedRoom = new WeakFieldRoom(omitted)
      const full = await search(async () => fullRoom, { depth: 2, budgetMs: 10_000 })
      const exact = await search(async () => exactRoom, {
        depth: 2,
        budgetMs: 10_000,
        dedup: {},
      })
      const reduced = await search(async () => reducedRoom, {
        depth: 2,
        budgetMs: 10_000,
        dedup: { key: (room) => (room as WeakFieldRoom).weakFingerprint() },
      })
      expect(findings(full)).toContain(`${omitted}|weak key hid the right future`)
      expect(findings(exact)).toContain(`${omitted}|weak key hid the right future`)
      expect(findings(reduced)).not.toContain(`${omitted}|weak key hid the right future`)
    })
  }
})
