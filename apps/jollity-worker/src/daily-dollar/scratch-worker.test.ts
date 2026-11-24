// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { encodeGestureEvent, RendererNode, type GesturePhase } from "@parity/truapi"
import type { ActionListener, WorkerHost } from "../host"
import {
  BRUSH, REVEAL_PERMILLE, SCRATCH_END, SCRATCH_FOIL_KEY, SCRATCH_MOVE, SCRATCH_PAN_KEY, SCRATCH_REVEAL, SCRATCH_START,
  cellsUnderStroke, createWorkerScratchCard, gridFor, lookFor, ticketTree, totalCells,
} from "./scratch-worker"

const LOOK = lookFor("Ios")
const { ticket: TICKET, grid: GRID } = LOOK
const TOTAL_CELLS = totalCells(LOOK)
const CELL_W = TICKET.width / GRID.columns
const CELL_H = TICKET.height / GRID.rows
const centre = (cell: number) => ({ x: ((cell % GRID.columns) + 0.5) * CELL_W, y: (Math.floor(cell / GRID.columns) + 0.5) * CELL_H })

const event = (phase: GesturePhase, x: number, y: number) =>
  encodeGestureEvent({ phase, x: Math.round(x * 100), y: Math.round(y * 100), fractionPermille: Math.round((1000 * x) / TICKET.width) })

function fakeHost(platform = "Ios"): WorkerHost {
  const stored = new Map<string, unknown>()
  return {
    hostInfo: async () => ({ info: { name: "test", version: "1", platform }, failed: false }),
    storage: {
      readJSON: async (key: string) => stored.get(key) ?? null,
      writeJSON: async (key: string, value: unknown) => void stored.set(key, value),
    },
    chat: { postMessage: vi.fn(async () => "m1") },
  } as unknown as WorkerHost
}

/** A rendered card: what it sent, and a way to act on it as the host would. */
async function renderedCard(platform = "Ios") {
  const sent: RendererNode[] = []
  let listener: ActionListener = () => undefined
  const flushes: Array<() => void> = []
  const card = createWorkerScratchCard(fakeHost(platform), (flush) => flushes.push(flush))
  card.render({ messageId: "m1", messageType: "jollity.ddscratch", payload: new Uint8Array() } as never, (node) => sent.push(node), (cb) => {
    listener = cb
    return () => undefined
  })
  await vi.waitFor(() => expect(sent.length).toBe(1))
  return {
    card,
    sent,
    act: (actionId: string, payload?: Uint8Array) => listener(actionId, payload),
    flush: () => flushes.splice(0).forEach((f) => f()),
  }
}

const tagsOf = (node: RendererNode): string[] => {
  const kids = "value" in node && node.value && "children" in node.value ? (node.value.children as RendererNode[]) : []
  return [node.tag, ...kids.flatMap(tagsOf)]
}

describe("the worker-drawn scratch brush", () => {
  it("a dab clears every cell whose centre is within the brush, and only those", () => {
    const at = { x: 136, y: 170 }
    const cells = cellsUnderStroke(at, at, new Set(), LOOK)
    for (let cell = 0; cell < TOTAL_CELLS; cell++) {
      const c = centre(cell)
      expect(cells.includes(cell)).toBe(Math.hypot(c.x - at.x, c.y - at.y) <= BRUSH)
    }
  })

  it("a fast stroke between two far moves leaves no gap along its path", () => {
    const cells = new Set(cellsUnderStroke({ x: 20, y: 20 }, { x: 250, y: 320 }, new Set(), LOOK))
    for (let t = 0; t <= 1; t += 0.01) {
      const x = 20 + 230 * t
      const y = 20 + 300 * t
      const column = Math.min(GRID.columns - 1, Math.floor(x / CELL_W))
      const row = Math.min(GRID.rows - 1, Math.floor(y / CELL_H))
      expect(cells.has(row * GRID.columns + column)).toBe(true)
    }
  })

  it("never names a cell already cleared, nor one outside the ticket", () => {
    const first = cellsUnderStroke({ x: 0, y: 0 }, { x: 0, y: 0 }, new Set(), LOOK)
    expect(first.every((cell) => cell >= 0 && cell < TOTAL_CELLS)).toBe(true)
    expect(cellsUnderStroke({ x: 0, y: 0 }, { x: 0, y: 0 }, new Set(first), LOOK)).toEqual([])
  })

  it("every point the host's 52-point brush draws lies within a cell's diagonal of a cell it cleared", () => {
    // A curve, as a person scratches, heard as the paced points the worker gets.
    const points = Array.from({ length: 24 }, (_, i) => ({ x: 145 + 90 * Math.cos(i / 6), y: 190 + 120 * Math.sin(i / 6) }))
    const cleared = new Set<number>()
    points.forEach((point, i) => cellsUnderStroke(points[Math.max(0, i - 1)] ?? point, point, cleared, LOOK).forEach((cell) => cleared.add(cell)))
    const diagonal = Math.hypot(CELL_W, CELL_H)
    const toSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
      return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y)
    }
    let drawn = 0
    for (let x = 0.5; x < TICKET.width; x += 2) {
      for (let y = 0.5; y < TICKET.height; y += 2) {
        const p = { x, y }
        if (!points.some((point, i) => i > 0 && toSegment(p, points[i - 1] ?? point, point) <= BRUSH)) continue
        drawn += 1
        expect([...cleared].some((cell) => Math.hypot(centre(cell).x - x, centre(cell).y - y) <= diagonal)).toBe(true)
      }
    }
    expect(drawn).toBeGreaterThan(1000)
  })
})

describe("the worker-drawn scratch card", () => {
  it("draws the ticket as a keyed location pan over the prize and the foil", () => {
    const tree = ticketTree(LOOK, { day: "0x01", outcome: "win" }, new Set([0, 3]), "Scratch")
    const json = JSON.stringify(tree)
    expect(tagsOf(tree)).toEqual(expect.arrayContaining(["Gesture", "CoverGrid", "Image"]))
    expect(json).toContain(`"key":"${SCRATCH_PAN_KEY}"`)
    expect(json).toContain('"location":true')
    expect(json).toContain(`"cleared":"0x09`)
    expect(RendererNode.dec(RendererNode.enc(tree))).toBeTruthy()
  })

  it("asks the host to say when 55% of the foil is scratched with the finger up", () => {
    const tree = ticketTree(LOOK, { day: "0x01", outcome: "win" }, new Set(), "Scratch")
    const reveal = `"reveal":{"pan":"${SCRATCH_PAN_KEY}","atPermille":550,"action":"${SCRATCH_REVEAL}"}`
    expect(JSON.stringify(tree)).toContain(reveal)
    const decoded = JSON.stringify(RendererNode.dec(RendererNode.enc(tree)), (_, v) => (typeof v === "bigint" ? Number(v) : v))
    expect(decoded).toContain(reveal)
  })

  it("asks the host for a 52-point round brush that follows the ticket's pan, in the tree only", () => {
    const tree = ticketTree(LOOK, { day: "0x01", outcome: "win" }, new Set(), "Scratch")
    expect(JSON.stringify(tree)).toContain(`"brush":{"pan":"${SCRATCH_PAN_KEY}","width":52}`)
    const decoded = JSON.stringify(RendererNode.dec(RendererNode.enc(tree)), (_, v) => (typeof v === "bigint" ? Number(v) : v))
    expect(decoded).toContain(`"brush":{"pan":"${SCRATCH_PAN_KEY}","width":52}`)
  })

  it("takes the ticket's size and pictures for the platform the host reports", () => {
    const ios = lookFor("Ios")
    const android = lookFor("Android")
    expect(ios.ticket).toEqual({ width: 290, height: 380 })
    expect(android.ticket).toEqual({ width: 309, height: 400 })
    expect(lookFor(undefined)).toEqual(ios)
    expect(ios.foil).toBe("chat-card/dd-foil-ios.png")
    expect(android.prize.win).toBe("chat-card/dd-ticket-android-win.png")
    const json = JSON.stringify(ticketTree(android, { day: "0x01", outcome: "miss" }, new Set(), "Scratch"))
    expect(json).toContain("chat-card/dd-foil-android.png")
    expect(json).toContain("chat-card/dd-ticket-android-miss.png")
    expect(json).toContain('{"tag":"Width","value":309}')
  })

  it("draws the Android look once the host says it is Android", async () => {
    const { sent } = await renderedCard("Android")
    expect(JSON.stringify(sent[0])).toContain("chat-card/dd-foil-android.png")
  })

  it("answers each move it handles with a few cleared cells, never a tree, and only the newest move", async () => {
    const { sent, act, flush } = await renderedCard()
    act(SCRATCH_START, event("Started", 30, 30))
    expect(sent.at(-1)?.tag).toBe("ClearCells")
    const before = sent.length
    act(SCRATCH_MOVE, event("Moved", 40, 30))
    act(SCRATCH_MOVE, event("Moved", 60, 30))
    flush()
    expect(sent.length).toBe(before + 1)
    const answer = sent.at(-1)!
    expect(answer.tag).toBe("ClearCells")
    if (answer.tag !== "ClearCells") return
    expect(answer.value.key).toBe(SCRATCH_FOIL_KEY)
    // The newest point (60, 30) was reached along the whole segment from the last one handled.
    expect(answer.value.cells.length).toBeGreaterThan(0)
    expect(RendererNode.enc(answer).length).toBeLessThan(200)
    // A move over cells already cleared still answers, with none.
    act(SCRATCH_MOVE, event("Moved", 60, 30))
    flush()
    expect(sent.at(-1)).toEqual({ tag: "ClearCells", value: { key: SCRATCH_FOIL_KEY, cells: [] } })
  })

  it("reveals past the threshold with a tree that has no foil, then shows the result in the card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { sent, act, flush } = await renderedCard()
      for (let y = 10; y <= TICKET.height; y += 40) {
        act(SCRATCH_START, event("Started", 0, y))
        act(SCRATCH_MOVE, event("Moved", TICKET.width, y))
        flush()
        act(SCRATCH_END, event("Ended", TICKET.width, y))
      }
      act(SCRATCH_REVEAL)
      const trees = sent.filter((node) => node.tag !== "ClearCells")
      const revealed = trees.at(-1)!
      expect(tagsOf(revealed)).not.toContain("CoverGrid")
      expect(JSON.stringify(revealed)).toContain("$1.00")
      expect(sent.filter((node) => node.tag === "ClearCells").length).toBeGreaterThan(3)
      // The prize for 1.8 s, then the failed claim, then the result 0.9 s later.
      expect(JSON.stringify(revealed)).toContain("Nice one! Claiming it now")
      await vi.advanceTimersByTimeAsync(1700)
      expect(JSON.stringify(sent.at(-1))).not.toContain("Retry claim")
      await vi.advanceTimersByTimeAsync(200)
      expect(JSON.stringify(sent.at(-1))).toContain("The claim did not go through")
      expect(tagsOf(sent.at(-1)!)).toContain("Gesture")
      await vi.advanceTimersByTimeAsync(1000)
      expect(JSON.stringify(sent.at(-1))).toContain("Retry claim")
    } finally {
      vi.useRealTimers()
    }
  })

  it("reveals only when the host says so, never on a lift alone, however much is scratched", async () => {
    const { sent, act, flush } = await renderedCard()
    act(SCRATCH_START, event("Started", 0, 10))
    for (let y = 10; y <= TICKET.height; y += 20) {
      act(SCRATCH_MOVE, event("Moved", y % 40 === 10 ? TICKET.width : 0, y))
      flush()
    }
    act(SCRATCH_END, event("Ended", 0, TICKET.height))
    expect(sent.every((node) => node.tag === "ClearCells" || tagsOf(node).includes("CoverGrid"))).toBe(true)
    act(SCRATCH_REVEAL)
    expect(tagsOf(sent.at(-1)!)).not.toContain("CoverGrid")
    expect(sent.at(-1)?.tag).not.toBe("ClearCells")
  })

  it("ignores a reveal once the ticket is no longer under the foil", async () => {
    const { sent, act } = await renderedCard()
    act(SCRATCH_REVEAL)
    const count = sent.length
    act(SCRATCH_REVEAL)
    expect(sent.length).toBe(count)
  })

  it("redraws a half-scratched ticket with every cell it cleared, since a tree always wins", async () => {
    const { card, sent, act } = await renderedCard()
    act(SCRATCH_START, event("Started", 100, 100))
    act(SCRATCH_END, event("Ended", 100, 100))
    const cleared = new Set(sent.flatMap((node) => (node.tag === "ClearCells" ? node.value.cells : [])))
    expect(cleared.size).toBeGreaterThan(0)
    expect(cleared.size).toBeLessThan((REVEAL_PERMILLE / 1000) * TOTAL_CELLS)
    // The card scrolled away and back: the same message renders again, from memory.
    const redraws: RendererNode[] = []
    card.render({ messageId: "m1", messageType: "jollity.ddscratch", payload: new Uint8Array() } as never, (node) => redraws.push(node), () => () => undefined)
    const json = JSON.stringify(redraws[0])
    const hex = /"cleared":"0x([0-9a-f]*)"/.exec(json)?.[1] ?? ""
    const bits = new Set<number>()
    for (let i = 0; i < hex.length / 2; i++) {
      const byte = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16)
      for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) bits.add(8 * i + bit)
    }
    expect(bits).toEqual(cleared)
  })
})

describe("the foil's cell size", () => {
  it("cuts the ticket into cells of about 8 points, inside the renderer's 128 a side", () => {
    expect(GRID).toEqual(gridFor(TICKET))
    expect(gridFor(TICKET)).toEqual({ columns: 36, rows: 48 })
    expect(lookFor("Android").grid).toEqual({ columns: 39, rows: 50 })
    for (const platform of ["Ios", "Android"]) expect(Math.max(lookFor(platform).grid.columns, lookFor(platform).grid.rows)).toBeLessThanOrEqual(128)
  })

  it("clears about the brush's area in a dab", () => {
    const at = { x: 136, y: 170 }
    const cells = cellsUnderStroke(at, at, new Set(), LOOK).length
    const brushArea = Math.PI * BRUSH * BRUSH
    expect(Math.abs(cells * (CELL_W * CELL_H) - brushArea) / brushArea).toBeLessThan(0.1)
  })
})
