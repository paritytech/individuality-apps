// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

const stage = vi.hoisted(() => {
  // the scene code in ./proto reads the media queries as it loads
  window.matchMedia ??= (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  // no GL here: the stage's destroy finds no context to hand back
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
  return {
    /** the friends the page hands the scene (chainDraw.friends) */
    friends: [] as { index: number; colour: string }[],
    held: false,
    started: false,
    /** who's playing's names, by ticket index, and the page's ear for them */
    names: new Map<number, string>(),
    onName: (() => {}) as (index: number) => void,
  }
})
// a stand-in for the scene: it keeps what the page hands it, and says what the test says
vi.mock("./proto/scenes/wheel/slit/scene.js", () => ({
  createSlit: (_ctx: unknown, opts: { chainDraw: { friends: { index: number; colour: string }[] } }) => {
    stage.friends = opts.chainDraw.friends
    return {
      frame: () => {},
      dispose: () => {},
      names: { refresh: () => {} },
      friendsHeld: () => stage.held,
      timeline: { at: () => 0, started: () => stage.started, scrub: () => false, release: () => {}, busy: () => false },
      debug: () => ({ slit: {} }),
    }
  },
  slitParams: () => {},
}))
vi.mock("./baked-coin", () => ({ keepBakes: () => {}, releaseBakes: () => {} }))
vi.mock("./names", () => ({
  nameCache: () => async () => null,
  rowLabels: (slots: readonly string[], _nameOf: unknown, onName: (index: number) => void) => {
    stage.onName = onName
    return { labelOf: (index: number) => stage.names.get(index) ?? `#${slots[index]!.slice(0, 4)}`, prefer: () => {}, stop: () => {} }
  },
  rowName: (name: string) => name.trim().toUpperCase(),
}))

const { mountWheel } = await import("./mount")
const { SLIT } = await import("./proto/scenes/wheel/slit/config.js")

const slot = (n: number) => n.toString(16).padStart(64, "0")
/** a draw of `count` tickets, the player's the first */
const drawOf = (count: number, friends: readonly string[]) => {
  const tickets = Array.from({ length: count }, (_, i) => slot(i + 1))
  return { tickets, mine: tickets[0]!, target: slot(1), won: false, winners: 1, prize: { amount: "1", unit: "CASH", prefix: "$" }, friends }
}
/** ticket `index`'s name is read */
const named = (index: number, name: string) => {
  stage.names.set(index, name.toUpperCase())
  stage.onName(index)
}

let mounted: { destroy?: () => void } | null = null
afterEach(() => {
  mounted?.destroy?.()
  mounted = null
  stage.names.clear()
  stage.held = false
  stage.started = false
})

describe("mountWheel's friends", () => {
  it("stands its usual time while none of the contacts is in the draw", () => {
    mounted = mountWheel(document.createElement("div"), drawOf(4, ["alice", "bob", "carol"]))
    const usual = SLIT.spinStartMs
    named(1, "dave")
    named(2, "erin")
    expect(stage.friends).toEqual([])
    expect(SLIT.spinStartMs).toBe(usual)
  })

  it("marks a contact whose name is read, and stands longer for each one found", () => {
    mounted = mountWheel(document.createElement("div"), drawOf(4, ["alice", "bob.07"]))
    const usual = SLIT.spinStartMs
    named(1, "alice")
    const one = SLIT.spinStartMs
    named(2, "bob.07")
    expect(stage.friends.map((friend) => friend.index)).toEqual([1, 2])
    expect(one).toBeGreaterThan(usual)
    expect(SLIT.spinStartMs).toBeGreaterThan(one)
  })

  it("matches the whole name: a device name is not its person's", () => {
    mounted = mountWheel(document.createElement("div"), drawOf(3, ["alice"]))
    named(1, "alice.07")
    expect(stage.friends).toEqual([])
  })

  it("never marks the player's own ticket", () => {
    mounted = mountWheel(document.createElement("div"), drawOf(3, ["alice"]))
    named(0, "alice")
    expect(stage.friends).toEqual([])
  })

  it("marks six friends at most", () => {
    const names = Array.from({ length: 9 }, (_, i) => `friend${i}`)
    mounted = mountWheel(document.createElement("div"), drawOf(10, names))
    names.forEach((name, i) => named(i + 1, name))
    expect(stage.friends).toHaveLength(6)
  })

  it("stops lengthening the stand once the visit has begun, or the wheel turns", () => {
    mounted = mountWheel(document.createElement("div"), drawOf(4, ["alice", "bob", "carol"]))
    named(1, "alice")
    const visiting = SLIT.spinStartMs
    stage.held = true
    named(2, "bob")
    expect(SLIT.spinStartMs).toBe(visiting)
    stage.held = false
    stage.started = true
    named(3, "carol")
    expect(SLIT.spinStartMs).toBe(visiting)
    expect(stage.friends).toHaveLength(3)
  })
})
