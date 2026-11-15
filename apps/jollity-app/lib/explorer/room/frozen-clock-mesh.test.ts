// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// quiescence first: it traps the real timers before anything else loads
import "../mesh/quiescence"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isFault, type Label } from "../core/labels"
import { settled, steadyLink } from "../mesh/anchors"
import { fairPick } from "../mesh/fair"
import { exploreRoom, type Room as MeshRoom } from "../mesh/room"
import { fairRun, steadyAnchor } from "./checks"
import { candidateLabels, step, type Room } from "./model"

/**
 * The room's frozen page clock (model.ts, ROOM_FROZEN) against real Mesh, in
 * the two-phone mesh-pair room with its page clock (room.ts pageClock): side b
 * (room phone 1) hides and freezes, its performance.now() stops and its timers
 * wait while side a runs FROZEN_MS, then it thaws and shows. Not a
 * label-by-label translation (to-mesh.ts says why): what Mesh sees on return
 * is compared, the hiddenForMs page-away.ts hands setSelfAway, the commands
 * each side's actor issued from the hide on, a's away mark of b, and a steady
 * link after. The negative control is the same schedule with b's clock running
 * while hidden: hiddenForMs then exceeds KICK_AFTER_HIDDEN_MS and b sweeps.
 */
const FROZEN_MS = 64_000

interface Return {
  hiddenForMs: number | undefined
  /** b's actor commands from the show on */
  bOnShow: string[]
  /** a's actor commands while b was away, and at its return */
  aWhileAway: string[]
  /** a's away mark of b while it was away */
  aAway: string | null
  steady: boolean
}

const named = (command: { kind: string; cause?: string }) => command.kind
// weather: what the clock's sweeps and the media watch issue every period on both sides
const WEATHER = new Set(["read-stats"])

// ── the room ──

function roomReturn(frozen: boolean): Return {
  process.env.ROOM_BEAT = "1"
  process.env.ROOM_FROZEN = "1"
  try {
    let room: Room = steadyAnchor(2).room
    const out: Return = { hiddenForMs: undefined, bOnShow: [], aWhileAway: [], aAway: null, steady: false }
    let phase: "away" | "show" = "away"
    const take = (label: string) => {
      const next = step(room, label, { noFaults: true })
      if (!next) throw new Error(`${label} is not enabled`)
      for (const { phone, command } of next.edge.commands) {
        const name = named(command)
        if (WEATHER.has(name)) continue
        if (phone === 0 && phase === "away") out.aWhileAway.push(name)
        if (phone === 1 && phase === "show") out.bOnShow.push(name)
      }
      for (const { phone, event } of next.edge.steps) if (phone === 1 && event.type === "visibility-changed" && !event.hidden) out.hiddenForMs = event.hiddenForMs
      room = next.room
    }
    take("vis:1:hide")
    if (frozen) take("vis:1:freeze")
    const until = room.now + FROZEN_MS
    // side a alone runs its clock: its sweeps, its beat, the clock (no fault, no ICE silence: mesh-pair's PCs keep consent)
    while (room.now < until) {
      const enabled = candidateLabels(room).filter((label) => /^(tick|beat|advance):0$|^choice:0:resolved$|^beat:1$|^tick:1$/.test(label) && step(room, label, { noFaults: true }))
      const label = enabled.find((candidate) => !candidate.startsWith("advance")) ?? enabled[0]
      if (!label) break
      take(label)
    }
    out.aAway = room.halves[0]![1]!.facts.away
    phase = "show"
    take("vis:1:show")
    const run = fairRun(room)
    for (const label of run.labels) take(label)
    out.steady = run.steady
    return out
  } finally {
    delete process.env.ROOM_BEAT
    delete process.env.ROOM_FROZEN
  }
}

// ── real Mesh ──

let mesh: MeshRoom | undefined
afterEach(() => {
  mesh?.close()
  mesh = undefined
  vi.unstubAllGlobals()
})

/** a fair step, never one of the frozen side's own (its ops, frames to it, its beat) */
async function fairStep(since: Map<Label, number>, k: number, frozen: boolean): Promise<boolean> {
  const enabled = mesh!.enabled().filter((label) => !isFault(label) && !(frozen && /^pc:b\/|^(wire|lane):a>b:|^hb:b$|^env:.*:b$/.test(label)))
  for (const seen of [...since.keys()]) if (!enabled.includes(seen)) since.delete(seen)
  for (const label of enabled) if (!since.has(label)) since.set(label, k)
  if (enabled.length === 0) return false
  await mesh!.step(fairPick(enabled, since))
  return true
}

async function meshReturn(frozen: boolean): Promise<Return> {
  mesh = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000, faults: 0, horizonMs: 10_000_000, pageClock: true })
  const since = new Map<Label, number>()
  let k = 0
  for (; k < 400 && !(steadyLink(mesh) && settled(mesh)); k++) await fairStep(since, k, false)
  const out: Return = { hiddenForMs: undefined, bOnShow: [], aWhileAway: [], aAway: null, steady: false }
  const from = mesh.logs().commands.length
  mesh.page("b", "hide")
  if (frozen) mesh.page("b", "freeze")
  const until = Date.now() + FROZEN_MS
  while (Date.now() < until && (await fairStep(since, k++, frozen)));
  out.aAway = (mesh.internals("a").conns.get("b") as { away?: string | null } | undefined)?.away ?? null
  const shownAt = mesh.logs().commands.length
  out.hiddenForMs = mesh.page("b", "show")
  for (let n = 0; n < 400 && !(steadyLink(mesh) && settled(mesh)); n++) await fairStep(since, k++, false)
  out.steady = steadyLink(mesh) && settled(mesh)
  const commands = mesh.logs().commands
  for (const entry of commands.slice(from, shownAt)) if (entry.side === "a" && !WEATHER.has(entry.kind)) out.aWhileAway.push(entry.kind)
  for (const entry of commands.slice(shownAt)) if (entry.side === "b" && !WEATHER.has(entry.kind)) out.bOnShow.push(entry.kind)
  return out
}

describe("the room's frozen page clock on real Mesh", () => {
  it("replays a frozen-then-thawed return: Mesh sees the same hiddenForMs, the same commands and away mark, and the link comes back", async () => {
    const room = roomReturn(true)
    const real = await meshReturn(true)
    expect(real).toEqual(room)
    // the frozen clock hides the whole absence: no kick, no sweep
    expect(room.hiddenForMs).toBe(0)
    expect(room.bOnShow).not.toContain("sweep")
  })

  it("negative control: the same return with b's clock running, hiddenForMs is the whole absence and b sweeps, in Mesh and in the room", async () => {
    const room = roomReturn(false)
    const real = await meshReturn(false)
    expect(real).toEqual(room)
    expect(room.hiddenForMs).toBe(FROZEN_MS)
    expect(room.bOnShow).toContain("sweep")
  })
})
