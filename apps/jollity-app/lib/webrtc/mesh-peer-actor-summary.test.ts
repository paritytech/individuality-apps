// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The per-game peer actor summary: the actor writes its own counts when the
 * room closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { monoNow } from "./mesh"
import { SUPERVISOR_TIMING } from "./supervisor-timing"
import { FakeChannel, FakePC, setupMesh, actorTakesMeshTimes } from "./test-pc"

const SUMMARY = "peer actor authority summary"

type Conn = { disconnectedAt: number; lastSignalAt: number }
type Internals = { conns: Map<string, Conn>; supervise(): void }

/** The summaries the mesh under test wrote (setupMesh reloads the modules, so read the store they use). */
async function summaries() {
  // devLog is a no-op without DEBUG_LOGS: an empty list would prove nothing
  expect((await import("../debug/flag")).DEBUG_LOGS).toBe(true)
  const { getDevLogEntries } = await import("../debug/log-store")
  return getDevLogEntries().filter((entry) => entry.message === SUMMARY).map((entry) => entry.data as Record<string, unknown>)
}

describe("the peer actor summary", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.advanceTimersByTime(60_000)
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("is written once at close with the counts of a rebuild and a rejected completion", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    const internals = mesh as unknown as Internals
    actorTakesMeshTimes(mesh) // the scenario back-dates Mesh's times by hand: the actor takes them
    const channel = pc.channels[0] ?? new FakeChannel()
    channel.readyState = "open"
    ;(channel.onopen as (() => void) | null)?.()
    pc.connectionState = "connected"
    ;(pc.onconnectionstatechange as () => void)()
    pc.connectionState = "disconnected"
    ;(pc.onconnectionstatechange as () => void)()
    internals.conns.get("b")!.lastSignalAt = monoNow()
    pc.restartIce.mockImplementation(() => { throw new DOMException("closed", "InvalidStateError") })
    internals.conns.get("b")!.disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
    internals.supervise() // restart-ice throws: rejected, then the actor rebuilds
    expect(FakePC.last).toHaveLength(2)
    expect(await summaries()).toEqual([]) // nothing until the room closes
    mesh.close()
    mesh.close()
    const [summary] = await summaries()
    expect(await summaries()).toHaveLength(1)
    expect(summary).toEqual({
      commands: { "restart-ice": 1, "replace-connection": 1 },
      teardown: { "close-connection": 1 },
      inFlightAtClose: 0,
      completions: { "supervisor-recovery": { resolved: 0, rejected: 1, stale: 0 } },
      ignored: {},
      actorStarts: 1,
      replacedExternally: 0,
      errors: 0,
    })
  })

  it("is written for an idle room too, with zero counts", async () => {
    const { mesh } = await setupMesh("a", "b")
    mesh.close()
    const [summary] = await summaries()
    expect(summary).toMatchObject({ commands: {}, completions: {}, ignored: {}, errors: 0, inFlightAtClose: 0 })
  })

  it("counts a connection Mesh replaced without the actor, and writes no error line for a clean game", async () => {
    const { mesh } = await setupMesh("a", "b")
    mesh.rebuildAll()
    // a fact for a connection the actor does not hold is dropped, and counted
    ;(mesh as unknown as { runner: { dispatch(peer: string, event: unknown): void } }).runner.dispatch("b", { type: "peer-heard", at: 0, roomEpoch: 0, connectionEpoch: 99 })
    mesh.close()
    const [summary] = await summaries()
    expect(summary).toMatchObject({ replacedExternally: 1, ignored: { "stale-connection": 1 }, errors: 0 })
    expect(summary).not.toHaveProperty("firstError")
  })

  it("counts an effect that throws, with the first message", async () => {
    const { mesh, pc } = await setupMesh("a", "b")
    const internals = mesh as unknown as Internals & { executePeerCommand: (peer: string, command: unknown) => unknown }
    actorTakesMeshTimes(mesh) // the scenario back-dates Mesh's times by hand: the actor takes them
    pc.connectionState = "connected"
    ;(pc.onconnectionstatechange as () => void)()
    pc.connectionState = "disconnected"
    ;(pc.onconnectionstatechange as () => void)()
    internals.conns.get("b")!.lastSignalAt = monoNow()
    internals.conns.get("b")!.disconnectedAt = monoNow() - (SUPERVISOR_TIMING.disconnectGraceMs + 1)
    vi.spyOn(internals, "executePeerCommand").mockImplementation(() => { throw new Error("boom") })
    internals.supervise()
    mesh.close()
    const [summary] = await summaries()
    expect(summary).toMatchObject({ errors: 2, firstError: "boom" })
  })
})
