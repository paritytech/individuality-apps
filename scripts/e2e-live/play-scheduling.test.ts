// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import * as record from "./record"

type FixtureTile = {
  id: string
  role: "coplayer" | "unseen"
  votable: boolean
  tapReady: boolean
  verdict: "pending" | "approve"
  cursorPointer: boolean
  transform: string
  box: { x: number; y: number; w: number; h: number }
  hit: "self"
}

type PlayFixture = {
  tileAt(read: number, now: number): FixtureTile[]
  afterClick?(id: string | null, tiles: FixtureTile[], now: number): void
  wait?(ms: number, now: number): number
  stageAt?(read: number, now: number): { stage: "play" | "confirm"; turn: number }
  stop?(facts: { loops: number; clicks: number; targetClicks: number }): boolean
}

const playSource = () => {
  const source = readFileSync(new URL("./journey.pw.ts", import.meta.url), "utf8")
  const tree = ts.createSourceFile("journey.ts", source, ts.ScriptTarget.Latest, true)
  const fn = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "play")
  if (!fn) throw new Error("play function not found")
  return ts.transpileModule(`${fn.getText(tree)}\nexports.play=play;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
}

async function runActualPlay(fixture: PlayFixture, maxLoops = 50) {
  let loops = 0
  let reads = 0
  let drivers = 0
  let clicks = 0
  let targetClicks = 0
  let now = 100_000
  let lastTiles: FixtureTile[] = []
  let lastStage: "play" | "confirm" = "play"
  let lastTurn = 6
  const page = {
    viewportSize: () => ({ width: 390, height: 844 }),
    url: () => "/game",
    getByRole: () => ({ count: async () => 0 }),
    waitForTimeout: async (ms: number) => {
      now = fixture.wait?.(ms, now) ?? now + ms
    },
    mouse: {
      click: async (x: number, y: number) => {
        clicks++
        const clicked = lastTiles.find((candidate) =>
          x >= candidate.box.x && x <= candidate.box.x + candidate.box.w && y >= candidate.box.y && y <= candidate.box.y + candidate.box.h,
        ) ?? null
        if (clicked?.id === "late-ready") targetClicks++
        fixture.afterClick?.(clicked?.id ?? null, lastTiles, now)
      },
    },
  }
  const context = {
    ...record,
    exports: {} as { play?: (...args: unknown[]) => Promise<unknown> },
    console,
    slots: [{ n: 1 }],
    OUT: "/unused",
    join: (...parts: string[]) => parts.join("/"),
    appendFileSync: () => {},
    Date: class extends Date {
      static override now() {
        return now
      }
    },
    parseRotateY: () => 0,
    parseRotY: () => 0,
    readPage: async () => {
      reads++
      const stage = fixture.stageAt?.(reads, now) ?? { stage: "play" as const, turn: 6 }
      lastStage = stage.stage
      lastTurn = stage.turn
      lastTiles = fixture.tileAt(reads, now)
      return { ducked: false, tiles: lastTiles }
    },
    readStage: () => ({ stage: lastStage, turn: lastTurn, turnsPerRound: 12 }),
    stampOf: () => ({ stage: lastStage === "play" ? "gameplay" : "ending", turn: lastTurn }),
    VOTABLE_STAGES: new Set(["gameplay", "introduction"]),
    stormTarget: () => null,
  }
  vm.createContext(context)
  vm.runInContext(playSource(), context)
  const play = context.exports.play
  if (!play) throw new Error("compiled play function missing")
  await play(page, 1, 200_000, {
    driver: {
      clockTick: async () => {
        loops++
      },
      hidden: () => false,
      pending: () => false,
      held: () => false,
      midGame: async () => {
        drivers++
        return null
      },
    },
    stopAfterAct: () => fixture.stop?.({ loops, clicks, targetClicks }) ?? loops > maxLoops,
  })
  return { loops: loops - 1, reads, drivers, clicks, targetClicks, elapsed: now - 100_000 }
}

const tile = (id: string, x: number, tapReady = true): FixtureTile => ({
  id,
  role: "coplayer",
  votable: true,
  tapReady,
  verdict: "pending",
  cursorPointer: true,
  transform: "none",
  box: { x, y: 10, w: 100, h: 100 },
  hit: "self",
})

describe("actual play scheduling", () => {
  it("services the role driver after a finite budget when an otherwise legal tile never stops moving", async () => {
    const result = await runActualPlay({ tileAt: (read) => [tile("moving", 10 + (read % 2) * 10)] })
    expect(result.clicks).toBe(0)
    expect(result.drivers).toBeGreaterThan(0)
    expect(result.elapsed).toBeGreaterThanOrEqual(10_000)
  })

  it("does not rearm priority when a stable click lands without changing the verdict", async () => {
    const result = await runActualPlay({ tileAt: () => [tile("swallowed", 10)] })
    expect(result.clicks).toBeGreaterThan(0)
    expect(result.drivers).toBeGreaterThan(0)
  })

  it("services role work normally with no candidate and rejects an Unseen candidate", async () => {
    const empty = await runActualPlay({ tileAt: () => [] }, 10)
    expect(empty.drivers).toBe(10)
    expect(empty.clicks).toBe(0)

    const unseen = await runActualPlay({ tileAt: () => [{ ...tile("unseen", 10), role: "unseen" }] }, 10)
    expect(unseen.drivers).toBe(10)
    expect(unseen.clicks).toBe(0)
  })

  it("expires priority on a stale stage or turn and services the due role action", async () => {
    const approved = new Set<string>()
    const result = await runActualPlay(
      {
        tileAt: () => [{ ...tile("first", 10), verdict: approved.has("first") ? "approve" : "pending" }],
        afterClick: (id) => {
          if (id) approved.add(id)
        },
        stageAt: (read) => read > 2 ? { stage: "confirm", turn: 7 } : { stage: "play", turn: 6 },
      },
      10,
    )
    expect(result.clicks).toBe(1)
    expect(result.drivers).toBeGreaterThan(0)
  })

  it("uses the actual pass to catch a viewer ready after the third baseline tap and a same-Page stall", async () => {
    const approved = new Set<string>()
    let baselineDoneAt: number | null = null
    let stalled = false
    const baseline = ["a", "b", "c"]
    const result = await runActualPlay({
      tileAt: (_read, now) => [
        ...baseline.map((id, index) => ({ ...tile(id, 10 + index * 110), verdict: approved.has(id) ? "approve" as const : "pending" as const })),
        {
          ...tile("late-ready", 10, baselineDoneAt !== null && now - baselineDoneAt >= 66),
          verdict: approved.has("late-ready") ? "approve" as const : "pending" as const,
          box: { x: 10, y: 120, w: 100, h: 100 },
        },
      ],
      afterClick: (id, _tiles, now) => {
        if (!id) return
        approved.add(id)
        if (baseline.every((candidate) => approved.has(candidate)) && baselineDoneAt === null) baselineDoneAt = now
      },
      wait: (ms, now) => {
        if (baselineDoneAt !== null && !stalled) {
          stalled = true
          return now + 2_600
        }
        return now + ms
      },
      stop: ({ targetClicks }) => targetClicks > 0,
    })
    expect(result.targetClicks).toBe(1)
    expect(result.clicks).toBe(4)
    expect(result.elapsed).toBeGreaterThanOrEqual(2_600)
  })
})
