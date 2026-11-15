// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Mesh.links and onLinkChange: what the waiting room's dots read of each
 * link, and the word that it moved. The dots follow these events, never a
 * stats poll: a link added, their endpoint first heard, the link's state, its
 * path read once it is up or when the browser moves it to another pair, the
 * link gone.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { chromeStats } from "./test-stats"
import { setupMesh } from "./test-pc"

const relayed = () => chromeStats({ t: 1000, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
const direct = () => chromeStats({ t: 1000, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0, selected: "CPb" })
const candidate = { rtc: { cand: { candidate: "candidate:1 1 udp 1 1.1.1.1 1 typ host" } } } as never

async function linkedMesh() {
  const changes: string[] = []
  const { mesh, pc } = await setupMesh("a", "b", { onLinkChange: (peerId) => changes.push(peerId) })
  return { mesh, pc, changes }
}

/** let the path read (one getStats) land */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("Mesh.links", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("says when a link is added, with no endpoint and no path yet", async () => {
    const { mesh, changes } = await linkedMesh()
    expect(changes).toEqual(["b"])
    expect(mesh.links().get("b")).toEqual({ conn: "new", path: "unknown", endpoint: false })
    mesh.close()
  })

  it("says when their endpoint first arrives, and only then", async () => {
    const { mesh, changes } = await linkedMesh()
    await mesh.onRtc("b", candidate)
    await mesh.onRtc("b", candidate)
    expect(changes).toEqual(["b", "b"])
    expect(mesh.links().get("b")?.endpoint).toBe(true)
    mesh.close()
  })

  it("says when the link's state changes, and holds the path unknown until it is read", async () => {
    const { mesh, pc, changes } = await linkedMesh()
    pc.connectionState = "connecting"
    pc.onconnectionstatechange?.()
    expect(changes).toHaveLength(2)
    pc.stats = relayed()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    expect(changes).toHaveLength(3)
    expect(mesh.links().get("b")).toMatchObject({ conn: "connected", path: "unknown" })
    await settle()
    expect(changes).toHaveLength(4)
    expect(mesh.links().get("b")).toMatchObject({ conn: "connected", path: "relay" })
    mesh.close()
  })

  it("reads a link whose pair has no relay as direct", async () => {
    const { mesh, pc } = await linkedMesh()
    pc.stats = direct()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    await settle()
    expect(mesh.links().get("b")?.path).toBe("direct")
    mesh.close()
  })

  it("reads a link whose stats cannot be read as direct, as the report does, not as forever unknown", async () => {
    const { mesh, pc } = await linkedMesh()
    pc.getStats = async () => {
      throw new Error("closed")
    }
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    await settle()
    expect(mesh.links().get("b")?.path).toBe("direct")
    mesh.close()
  })

  it("forgets the path when the link goes down", async () => {
    const { mesh, pc } = await linkedMesh()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    await settle()
    pc.connectionState = "disconnected"
    pc.onconnectionstatechange?.()
    expect(mesh.links().get("b")).toMatchObject({ conn: "disconnected", path: "unknown", endpoint: true })
    mesh.close()
  })

  it("reads the path again when the browser moves the link to another pair", async () => {
    const { mesh, pc, changes } = await linkedMesh()
    const ice = Object.assign(new EventTarget(), { onselectedcandidatepairchange: null })
    Object.assign(pc, { sctp: { transport: { iceTransport: ice } } })
    pc.stats = relayed()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    await settle()
    const before = changes.length
    pc.stats = direct()
    ice.dispatchEvent(new Event("selectedcandidatepairchange"))
    await settle()
    expect(mesh.links().get("b")?.path).toBe("direct")
    expect(changes).toHaveLength(before + 1)
    mesh.close()
  })

  it("takes a path the report finds that no event announced", async () => {
    const { mesh, pc, changes } = await linkedMesh()
    pc.stats = relayed()
    pc.connectionState = "connected"
    pc.onconnectionstatechange?.()
    await settle()
    const before = changes.length
    pc.stats = direct()
    await mesh.report()
    expect(mesh.links().get("b")?.path).toBe("direct")
    expect(changes).toHaveLength(before + 1)
    // the same path again is no change
    await mesh.report()
    expect(changes).toHaveLength(before + 1)
    mesh.close()
  })

  it("says when the link is gone", async () => {
    const { mesh, changes } = await linkedMesh()
    mesh.setPeers([], [])
    expect(changes).toEqual(["b", "b"])
    expect(mesh.links().has("b")).toBe(false)
    mesh.close()
  })
})
