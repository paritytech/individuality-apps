// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { encodeGestureEvent, RendererNode, type GesturePhase } from "@parity/truapi"
import type { ActionListener, WorkerHost } from "../host"
import {
  BRUSH, REVEAL_PERMILLE, SCRATCH_END, SCRATCH_FOIL_KEY, SCRATCH_MOVE, SCRATCH_PAN_KEY, SCRATCH_REVEAL, SCRATCH_START,
  createWorkerScratchCard, lookFor, ticketTree,
} from "./scratch-worker"

const LOOK = lookFor("Ios")
const { ticket: TICKET } = LOOK

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

/** The foil's mask in a tree, or undefined once the foil is gone. */
const maskOf = (node: RendererNode): unknown => {
  const json = JSON.stringify(node, (_, v) => (typeof v === "bigint" ? Number(v) : v))
  const at = json.indexOf('{"tag":"Mask","value":')
  if (at < 0) return undefined
  let depth = 0
  for (let i = at; i < json.length; i++) {
    if (json[i] === "{") depth += 1
    if (json[i] === "}" && --depth === 0) return JSON.parse(json.slice(at, i + 1)).value
  }
  return undefined
}

const isAnswer = (node: RendererNode) => node.tag === "ExtendMask"

describe("the worker-drawn scratch card", () => {
  it("draws the ticket as a keyed location pan over the prize and a masked foil", () => {
    const tree = ticketTree(LOOK, { day: "0x01", outcome: "win" }, [], "Scratch")
    const json = JSON.stringify(tree)
    expect(tagsOf(tree)).toEqual(expect.arrayContaining(["Gesture", "Box", "Image"]))
    expect(json).toContain(`"key":"${SCRATCH_PAN_KEY}"`)
    expect(json).toContain('"location":true')
    expect(maskOf(tree)).toMatchObject({ key: SCRATCH_FOIL_KEY, mode: "Hide", shapes: [] })
    expect(RendererNode.dec(RendererNode.enc(tree))).toBeTruthy()
  })

  it("puts the mask on the box that holds the foil, so any foil node can sit under it", () => {
    const tree = ticketTree(LOOK, { day: "0x01", outcome: "win" }, [], "Scratch")
    const json = JSON.stringify(tree)
    const box = json.indexOf('{"tag":"Box","value":{"modifiers":[{"tag":"Width","value":290},{"tag":"Height","value":380},{"tag":"Mask"')
    expect(box).toBeGreaterThan(0)
    expect(json.indexOf(`"value":"${LOOK.foil}"`)).toBeGreaterThan(box)
  })

  it("asks the host for a 52-point line along the ticket's pan, in the tree only", () => {
    const tree = ticketTree(LOOK, { day: "0x01", outcome: "win" }, [], "Scratch")
    expect(maskOf(tree)).toMatchObject({ follow: { pan: SCRATCH_PAN_KEY, width: 100 * 2 * BRUSH } })
    expect(maskOf(RendererNode.dec(RendererNode.enc(tree)))).toMatchObject({ follow: { pan: SCRATCH_PAN_KEY, width: 5200 } })
  })

  it("asks the host to say when 55% of the foil is cleared with the finger up", () => {
    const tree = ticketTree(LOOK, { day: "0x01", outcome: "win" }, [], "Scratch")
    const share = { atPermille: 550, action: SCRATCH_REVEAL }
    expect(REVEAL_PERMILLE).toBe(550)
    expect(maskOf(tree)).toMatchObject({ clearedShare: share })
    expect(maskOf(RendererNode.dec(RendererNode.enc(tree)))).toMatchObject({ clearedShare: share })
  })

  it("takes the ticket's size and pictures for the platform the host reports", () => {
    const ios = lookFor("Ios")
    const android = lookFor("Android")
    expect(ios.ticket).toEqual({ width: 290, height: 380 })
    expect(android.ticket).toEqual({ width: 309, height: 400 })
    expect(lookFor(undefined)).toEqual(ios)
    expect(ios.foil).toBe("chat-card/dd-foil-ios.png")
    expect(android.prize.win).toBe("chat-card/dd-ticket-android-win.png")
    const json = JSON.stringify(ticketTree(android, { day: "0x01", outcome: "miss" }, [], "Scratch"))
    expect(json).toContain("chat-card/dd-foil-android.png")
    expect(json).toContain("chat-card/dd-ticket-android-miss.png")
    expect(json).toContain('{"tag":"Width","value":309}')
  })

  it("draws the Android look once the host says it is Android", async () => {
    const { sent } = await renderedCard("Android")
    expect(JSON.stringify(sent[0])).toContain("chat-card/dd-foil-android.png")
  })

  it("answers the start and the newest move it holds with an empty extend of a few bytes, never a tree", async () => {
    const { sent, act, flush } = await renderedCard()
    act(SCRATCH_START, event("Started", 30, 30))
    expect(sent.at(-1)).toEqual({ tag: "ExtendMask", value: { key: SCRATCH_FOIL_KEY, shapes: [] } })
    const before = sent.length
    act(SCRATCH_MOVE, event("Moved", 40, 30))
    act(SCRATCH_MOVE, event("Moved", 60, 30))
    flush()
    expect(sent.length).toBe(before + 1)
    expect(sent.at(-1)).toEqual({ tag: "ExtendMask", value: { key: SCRATCH_FOIL_KEY, shapes: [] } })
    expect(RendererNode.enc(sent.at(-1)!).length).toBeLessThan(20)
  })

  it("reveals when the host says so with a tree that has no foil, then shows the result in the card", async () => {
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
      const trees = sent.filter((node) => !isAnswer(node))
      const revealed = trees.at(-1)!
      expect(maskOf(revealed)).toBeUndefined()
      expect(JSON.stringify(revealed)).not.toContain(LOOK.foil)
      expect(JSON.stringify(revealed)).toContain("$1.00")
      expect(sent.filter(isAnswer).length).toBeGreaterThan(3)
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
    expect(sent.every((node) => isAnswer(node) || maskOf(node) !== undefined)).toBe(true)
    act(SCRATCH_REVEAL)
    expect(maskOf(sent.at(-1)!)).toBeUndefined()
    expect(isAnswer(sent.at(-1)!)).toBe(false)
  })

  it("ignores a reveal once the ticket is no longer under the foil", async () => {
    const { sent, act } = await renderedCard()
    act(SCRATCH_REVEAL)
    const count = sent.length
    act(SCRATCH_REVEAL)
    expect(sent.length).toBe(count)
  })

  it("redraws a half-scratched ticket with every stroke it heard, since a tree always wins", async () => {
    const { card, act, flush } = await renderedCard()
    act(SCRATCH_START, event("Started", 100, 100))
    act(SCRATCH_MOVE, event("Moved", 140, 120))
    flush()
    act(SCRATCH_END, event("Ended", 150, 120))
    act(SCRATCH_START, event("Started", 20, 300))
    act(SCRATCH_END, event("Ended", 20, 300))
    // The card scrolled away and back: the same message renders again, from memory.
    const redraws: RendererNode[] = []
    card.render({ messageId: "m1", messageType: "jollity.ddscratch", payload: new Uint8Array() } as never, (node) => redraws.push(node), () => () => undefined)
    expect(maskOf(redraws[0]!)).toMatchObject({
      shapes: [
        { tag: "Stroke", value: { width: 5200, points: [{ x: 10000, y: 10000 }, { x: 14000, y: 12000 }, { x: 15000, y: 12000 }] } },
        // A lone press: a dot as wide as the line.
        { tag: "Stroke", value: { width: 5200, points: [{ x: 2000, y: 30000 }, { x: 2000, y: 30000 }] } },
      ],
    })
  })
})
