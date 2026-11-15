// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// quiescence first: it traps the real timers before anything else loads
import "../mesh/quiescence"
import { afterEach, describe, expect, it, vi } from "vitest"
import { isFault, type Label } from "../core/labels"
import { settled, steadyLink } from "../mesh/anchors"
import { fairPick } from "../mesh/fair"
import { exploreRoom, type Room as MeshRoom } from "../mesh/room"
import { fairRun } from "./checks"
import { initialRoom, step, walkRoom, type Room } from "./model"

/**
 * The room's codec guard (model.ts codecGuard) against real Mesh, in the
 * two-phone mesh-pair room. Not a label-by-label translation (to-mesh.ts says
 * why): both sides are driven fairly to a steady link, and the guarded half's
 * lane-offer program is compared, the commands it issued, the order its
 * promises settled in, each outcome, and the lane offers it sent.
 *
 * Mesh is made to take the guard as the room's choice says: its engine is
 * not RTX-safe (navigator stubbed; rtxSafeEngine, mesh.ts 343-354) and the
 * initiator's offers carry RTX (ExploreRoomOptions.rtxOffers, the browser
 * not honouring the codec preferences). `navigator` is one global, so both
 * Meshes read the same engine; only side a's offers carry RTX. The negative
 * control stubs a safe engine (Android Chrome 124) with the same offers.
 */
const UNSAFE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
const SAFE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"

/** the guarded half's lane-offer program: commands issued, then promises in the order they settled */
interface Program {
  issued: string[]
  settled: string[]
  laneOffers: number
  steady: boolean
}

// ── the room ──

const TO_LANE_OFFER = [
  "hello:0@1", "hello:1@0", "h:0>1:local-offer-requested", "h:0>1:complete:send-offer:statement:resolved", "w:0>1:deliver",
  "h:1>0:complete:set-remote-description:statement-offer:resolved", "h:1>0:complete:send-answer:statement:resolved", "w:1>0:deliver",
  "h:0>1:complete:set-remote-description:statement-answer:resolved", "ice:0-1:up", "chan:0-1:open", "h:0>1:local-offer-requested",
]
const GUARDED = ["h:0>1:codec-guard-rtx", "h:0>1:complete:rollback:resolved", "h:0>1:complete:send-offer:lane:resolved", "h:0>1:complete:send-offer:lane:resolved"]

const commandName = (command: { kind: string; lane?: boolean; cause?: string }) =>
  command.kind === "rollback" ? `rollback:${command.cause}` : command.kind === "send-offer" ? `send-offer:${command.lane ? "lane" : "statement"}` : command.kind
const LANE_PROGRAM = /^(send-offer:lane|rollback:.*)$/

/** Walks the labels, then the fair run, recording half 0>1's lane-offer program. */
function roomProgram(unsafe: number[], labels: readonly string[]): Program {
  let room: Room = initialRoom(2, 0, false, unsafe)
  const program: Program = { issued: [], settled: [], laneOffers: 0, steady: false }
  const byEpoch = new Map<number, string>()
  const take = (label: string) => {
    if (label === "lane:0>1:deliver" && room.lanes[0]![1]![0]?.kind === "offer") program.laneOffers += 1
    const next = step(room, label)
    if (!next) throw new Error(`${label} is not enabled`)
    for (const { phone, peer, command } of next.edge.commands) {
      const name = commandName(command as never)
      if (phone !== 0 || peer !== 1 || !LANE_PROGRAM.test(name)) continue
      program.issued.push(name)
      byEpoch.set(command.commandEpoch, name)
    }
    for (const { phone, peer, event } of next.edge.steps) {
      if (phone !== 0 || peer !== 1 || event.type !== "command-completed") continue
      const name = byEpoch.get(event.commandEpoch)
      if (name) program.settled.push(`${name}:${event.outcome}`)
    }
    room = next.room
  }
  for (const label of labels) take(label)
  const run = fairRun(room)
  for (const label of run.labels) take(label)
  program.laneOffers += room.lanes[0]![1]!.filter((frame) => frame.kind === "offer").length
  program.steady = run.steady
  return program
}

// ── real Mesh ──

let mesh: MeshRoom | undefined
// only `navigator` is put back: exploreRoom's own stubs stay as it left them
const originalNavigator = globalThis.navigator
afterEach(() => {
  mesh?.close()
  mesh = undefined
  vi.stubGlobal("navigator", originalNavigator)
})

/** The fair scheduler from the start to a steady, settled link; side a's lane-offer program. */
async function meshProgram(userAgent: string): Promise<Program> {
  vi.stubGlobal("navigator", { userAgent, vendor: userAgent.includes("iPhone") ? "Apple Computer, Inc." : "Google Inc.", onLine: true })
  mesh = await exploreRoom({ scenario: "single-offer", phaseOffsetMs: 1000, faults: 0, horizonMs: 10_000_000, rtxOffers: ["a"] })
  const since = new Map<Label, number>()
  let steady = false
  for (let k = 0; k < 400 && !steady; k++) {
    const enabled = mesh.enabled().filter((label) => !isFault(label))
    for (const seen of [...since.keys()]) if (!enabled.includes(seen)) since.delete(seen)
    for (const label of enabled) if (!since.has(label)) since.set(label, k)
    await mesh.step(fairPick(enabled, since))
    steady = steadyLink(mesh) && settled(mesh)
  }
  const logs = mesh.logs()
  const names = new Map<number, string>()
  const issued: string[] = []
  for (const entry of logs.commands) {
    const name = commandName(entry.command as never)
    if (entry.side !== "a" || !LANE_PROGRAM.test(name)) continue
    issued.push(name)
    names.set(entry.id, name)
  }
  const settledNames = logs.outcomes.filter((entry) => names.has(entry.commandId)).map((entry) => `${names.get(entry.commandId)}:${entry.outcome}`)
  const laneOffers = logs.wire.filter((entry) => entry.channel === "lane" && entry.from === "a" && entry.kind === "offer" && entry.fate === "sent").length
  return { issued, settled: settledNames, laneOffers, steady }
}

/** side a's current local description toward b */
const localSdp = (room: MeshRoom): string => room.internals("a").conns.get("b")?.pc.localDescription?.sdp ?? ""

describe("the room's codec guard on real Mesh", () => {
  it("replays the room's guard trace: rollback, the stripped offer, then the guarded offer, one lane offer, a steady link", async () => {
    const room = roomProgram([0], [...TO_LANE_OFFER, ...GUARDED])
    expect(room).toEqual({
      issued: ["send-offer:lane", "rollback:codec-guard", "send-offer:lane"],
      settled: ["rollback:codec-guard:resolved", "send-offer:lane:resolved", "send-offer:lane:resolved"],
      laneOffers: 1,
      steady: true,
    })
    const real = await meshProgram(UNSAFE)
    expect(real).toEqual(room)
    // the offer Mesh holds, and sent, is the stripped one
    expect(mesh!.logs().ops.filter((entry) => entry.op === "rollback").map((entry) => entry.outcome)).toEqual(["resolved"])
    expect(localSdp(mesh!)).not.toMatch(/rtx\//)
  })

  it("negative control: a safe engine takes no guard, in Mesh and in the room, with the same offers", async () => {
    const real = await meshProgram(SAFE)
    expect(real.issued).not.toContain("rollback:codec-guard")
    // not vacuous: the offer still carries RTX, a safe engine keeps it (codecGuardNeeded 2188)
    expect(localSdp(mesh!)).toMatch(/a=rtpmap:97 rtx\/90000/)
    // the room: the guard is never enabled on a safe phone, and the same prefix settles the lane offer once
    const prefix = walkRoom(initialRoom(2, 0, false, []), TO_LANE_OFFER)
    expect(step(prefix, "h:0>1:codec-guard-rtx")).toBeNull()
    const room = roomProgram([], [...TO_LANE_OFFER, "h:0>1:complete:send-offer:lane:resolved"])
    expect(real).toEqual(room)
    expect(room).toEqual({ issued: ["send-offer:lane"], settled: ["send-offer:lane:resolved"], laneOffers: 1, steady: true })
  })
})
