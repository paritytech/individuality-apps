// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const replayCapture = vi.hoisted(() => vi.fn())
vi.mock("./replay-capture", () => ({ captureReplayObservation: replayCapture }))
const resourceRead = vi.hoisted(() => vi.fn((includeDom = true) => ({
  installed: true, peerConnections: 1, glContexts: 1, glLive: 1, glLost: 0,
  videos: 1, videosWithStream: 1, videoMaxWidth: 640, videoMaxHeight: 360,
  videoPixels: 230_400, videoResolutions: "640x360", canvases: 1,
  ...(includeDom ? { domNodes: 17 } : {}),
})))
vi.mock("./resource-counters", () => ({ readPageResourceCounters: resourceRead }))
const lifecycleRecord = vi.hoisted(() => vi.fn())
vi.mock("./index", async (importOriginal) => ({ ...(await importOriginal<typeof import("./index")>()), pageLifecycleRecord: lifecycleRecord }))

const local = new Map<string, string>()
const session = new Map<string, string>()

import { enterScene, leaveAllScenes } from "./smoothness"
import { SESSION_ID } from "../debug/session-id"
import { resetJourneysForTests } from "./journeys"
import { captureLaunchLocation } from "./launch-source"
import {
  HEARTBEAT_MS,
  MAX_PAYOFF_SAMPLES_PER_PHASE,
  HOST_RELOAD_MAX_GAP_MS,
  LAST_SESSION_KEY,
  SESSION_LINEAGE_KEY,
  STALE_AFTER_MS,
  noteOwnReload,
  clearGameSessionState,
  noteHostChannelLost,
  noteHostChannelRestored,
  noteSessionChange,
  resetSessionRecordForTests,
  setSessionProbe,
  startSessionRecord,
  type PreviousSessionDiagnostic,
} from "./session-record"

const NOW = 1_800_000_000_000
const listeners = new Map<string, (event?: Event) => void>()
let hidden = false
let pathname = "/"
let search = ""
let navigationType: string | null = "navigate"
const record = vi.fn<(diagnostic: PreviousSessionDiagnostic) => void>()

function storage(map: Map<string, string>): Storage {
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

function previous(over: Record<string, unknown> = {}) {
  local.set(
    LAST_SESSION_KEY,
    JSON.stringify({
      sessionId: "old-session",
      lineageId: "old-lineage",
      lastSeenAt: NOW - 20_000,
      cleanExit: false,
      inGame: true,
      gameIndex: 248,
      turn: 3,
      screen: "game.round",
      liveVideo: 4,
      heapMb: 51,
      hidden: false,
      ...over,
    }),
  )
}

function saved(): Record<string, unknown> {
  return JSON.parse(local.get(LAST_SESSION_KEY) ?? "{}") as Record<string, unknown>
}

async function start() {
  return startSessionRecord({ record })
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  local.clear()
  session.clear()
  listeners.clear()
  hidden = false
  pathname = "/"
  search = ""
  navigationType = "navigate"
  record.mockReset()
  replayCapture.mockReset()
  lifecycleRecord.mockReset()
  resourceRead.mockClear()
  leaveAllScenes()
  resetSessionRecordForTests()
  resetJourneysForTests()
  vi.stubGlobal("localStorage", storage(local))
  vi.stubGlobal("sessionStorage", storage(session))
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: (event?: Event) => void) => listeners.set(`window:${name}`, fn),
    location: { get pathname() { return pathname }, get search() { return search } },
  })
  vi.stubGlobal("performance", {
    timeOrigin: NOW - 1000,
    now: () => 1000,
    getEntriesByType: (type: string) => (type === "navigation" ? [{ type: navigationType }] : []),
  })
  // the launch URL is captured at module load; re-capture it per test against
  // the stubbed location, as a real page load would have
  captureLaunchLocation()
  vi.stubGlobal("document", {
    addEventListener: (name: string, fn: (event?: Event) => void) => listeners.set(`document:${name}`, fn),
    get visibilityState() {
      return hidden ? "hidden" : "visible"
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("previous-session classification", () => {
  it("rounds the epoch time origin to integer milliseconds before capture", async () => {
    vi.stubGlobal("performance", {
      timeOrigin: 1_792_413_000_123.456,
      getEntriesByType: () => [{ type: "reload" }],
    })
    vi.stubGlobal("__trinityHostTelemetry", {
      hostSessionId: "123e4567-e89b-42d3-a456-426614174000",
    })
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      timeOriginMs: 1_792_413_000_123,
      navigationType: "reload",
      hostSessionId: "123e4567-e89b-42d3-a456-426614174000",
    }))
  })

  it("records an absent native host explicitly without waiting", async () => {
    navigationType = null
    captureLaunchLocation()
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      hostSessionId: null,
      navigationType: null,
    }))
  })

  it("maps heartbeat and exported log sessions without guessing legacy identity", async () => {
    previous()
    await start()
    expect(saved().logSessionId).toBe(SESSION_ID)
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      heartbeatSessionId: saved().sessionId,
      logSessionId: SESSION_ID,
      previousHeartbeatSessionId: "old-session",
      previousLogSessionId: null,
      previousExitClassification: "crash-or-kill-foreground",
    }))
  })

  it("preserves explicit prior log identity on the next opening", async () => {
    previous({ logSessionId: "prior-exported-page" })
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({ previousLogSessionId: "prior-exported-page" }))
    await start()
    expect(replayCapture).toHaveBeenCalledOnce()
  })

  it("emits exactly one unknown diagnostic when there is no previous session", async () => {
    await expect(start()).resolves.toMatchObject({ classification: "unknown" })
    expect(record).toHaveBeenCalledOnce()
  })

  it("classifies a pagehide as a clean close and preserves persisted", async () => {
    previous({ cleanExit: true, pagehideSeen: true, pagehidePersisted: true })
    await expect(start()).resolves.toMatchObject({ classification: "clean-close", pagehideSeen: true, pagehidePersisted: true })
  })

  it("classifies a hidden page with no pagehide as killed in the background", async () => {
    previous({ hidden: true })
    await expect(start()).resolves.toMatchObject({ classification: "killed-background", lastVisibility: "hidden" })
  })

  it("classifies a visible stopped heartbeat with no pagehide as a foreground crash or kill", async () => {
    previous()
    await expect(start()).resolves.toMatchObject({
      classification: "crash-or-kill-foreground",
      gapMs: 20_000,
      gameIndex: 248,
      turn: 3,
      screen: "game.round",
      heapMb: 51,
    })
  })

  it("classifies the same lineage reopening within seconds as a host reload", async () => {
    session.set(SESSION_LINEAGE_KEY, "same-lineage")
    previous({
      lineageId: "same-lineage",
      lastSeenAt: NOW - 150,
      hostChannelLost: true,
    })
    await expect(start()).resolves.toMatchObject({ classification: "host-reload" })
  })

  it("classifies the iOS disconnect then pagehide pattern as a host reload", async () => {
    session.set(SESSION_LINEAGE_KEY, "same-lineage")
    previous({
      lineageId: "same-lineage",
      lastSeenAt: NOW - 100,
      hostChannelLost: true,
      cleanExit: true,
      pagehideSeen: true,
    })
    await expect(start()).resolves.toMatchObject({ classification: "host-reload", pagehideSeen: true })
  })

  it("keeps an ordinary same-lineage page refresh as a clean close", async () => {
    session.set(SESSION_LINEAGE_KEY, "same-lineage")
    previous({ lineageId: "same-lineage", lastSeenAt: NOW - 150, cleanExit: true, pagehideSeen: true })
    await expect(start()).resolves.toMatchObject({ classification: "clean-close" })
  })

  it("keeps a same-lineage hidden kill as a background kill", async () => {
    session.set(SESSION_LINEAGE_KEY, "same-lineage")
    previous({ lineageId: "same-lineage", lastSeenAt: NOW - 150, hidden: true })
    await expect(start()).resolves.toMatchObject({ classification: "killed-background" })
  })

  it("does not call an older same-lineage record a host reload", async () => {
    session.set(SESSION_LINEAGE_KEY, "same-lineage")
    previous({
      lineageId: "same-lineage",
      lastSeenAt: NOW - HOST_RELOAD_MAX_GAP_MS - 1,
      hostChannelLost: true,
      cleanExit: true,
      pagehideSeen: true,
    })
    await expect(start()).resolves.toMatchObject({ classification: "clean-close" })
  })

  it("classifies our explicit reload marker before pagehide", async () => {
    previous({ ownReload: true, cleanExit: true, pagehideSeen: true })
    await expect(start()).resolves.toMatchObject({ classification: "own-reload" })
  })

  it("does not guess from a stale or future heartbeat", async () => {
    previous({ lastSeenAt: NOW - STALE_AFTER_MS })
    await expect(start()).resolves.toMatchObject({ classification: "unknown" })
    resetSessionRecordForTests()
    previous({ lastSeenAt: NOW + 1 })
    await expect(start()).resolves.toMatchObject({ classification: "unknown", gapMs: undefined })
  })

  it("keeps the classification when the diagnostic sink throws", async () => {
    previous({ hidden: true })
    await expect(
      startSessionRecord({
        record: () => {
          throw new Error("sink failed")
        },
      }),
    ).resolves.toMatchObject({ classification: "killed-background" })
  })

})

describe("launch source on session.link", () => {
  // classification itself is covered in launch-source.test.ts; these pin the wiring
  it("records the launch source read from the host bootstrap and the URL", async () => {
    vi.stubGlobal("__trinityHostTelemetry", {
      hostSessionId: "123e4567-e89b-42d3-a456-426614174000",
      openSource: "alarm",
      openedAtEpochMs: NOW - 1_000,
    })
    search = "?jollity-notification=reminder&moment=start-5m"
    captureLaunchLocation()
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      "app.launch_source": "notification",
      "app.launch_detail": "alarm",
    }))
  })

  it("records a cold start on /game?card=humanity as a deeplink with its route, from the URL captured at module load", async () => {
    // FrontDoor has already router.replace'd to "/" by the time the session
    // record runs; the module-load capture still holds the launch location
    pathname = "/game"
    search = "?card=humanity"
    captureLaunchLocation()
    await start()
    pathname = "/"
    search = ""
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      "app.launch_source": "deeplink",
      "app.launch_detail": "/game",
    }))
  })

  it("does not record a reload of /prize-draw?game=248 as a deeplink", async () => {
    pathname = "/prize-draw"
    search = "?game=248"
    navigationType = "reload"
    captureLaunchLocation()
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      "app.launch_source": "unknown",
      "app.launch_detail": "reload",
    }))
  })

  it("records unknown when nothing says what opened the page", async () => {
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      "app.launch_source": "unknown",
      "app.launch_detail": null,
    }))
  })
})

describe("concurrent page flag on session.link", () => {
  it.each([
    ["flags a previous session that was killed and seen half a second ago as a concurrent page", NOW - 500, {}, "true"],
    ["does not flag a previous session seen long ago", NOW - 20_000, {}, "false"],
    ["does not flag a quick reload whose previous record ended cleanly", NOW - 300, { cleanExit: true, pagehideSeen: true }, "false"],
    ["does not flag a quick own-reload", NOW - 300, { ownReload: true, cleanExit: true, pagehideSeen: true }, "false"],
  ])("%s", async (_name, lastSeenAt, over, expected) => {
    previous({ lastSeenAt, ...over })
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      "app.concurrent_page": expected,
    }))
  })

  it("does not flag a quick host reload whose record ended cleanly", async () => {
    session.set(SESSION_LINEAGE_KEY, "old-lineage")
    previous({ lineageId: "old-lineage", lastSeenAt: NOW - 150, hostChannelLost: true, cleanExit: true, pagehideSeen: true })
    await expect(start()).resolves.toMatchObject({ classification: "host-reload" })
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      "app.concurrent_page": "false",
    }))
  })

  it("does not flag a first page with no previous session", async () => {
    await start()
    expect(replayCapture).toHaveBeenCalledWith("session.link", expect.objectContaining({
      "app.concurrent_page": "false",
    }))
  })
})

describe("synchronous evidence", () => {
  it("writes visibility, freeze and pagehide evidence synchronously", async () => {
    await start()
    hidden = true
    listeners.get("document:visibilitychange")?.()
    expect(saved()).toMatchObject({ hidden: true, cleanExit: false, visibilityChanges: 1 })
    listeners.get("document:freeze")?.()
    expect(saved().freezeSeen).toBe(true)
    listeners.get("window:pagehide")?.(Object.assign(new Event("pagehide"), { persisted: true }))
    expect(saved()).toMatchObject({ cleanExit: true, pagehideSeen: true, pagehidePersisted: true })
  })

  it("persists host-channel loss and clears it when the channel returns", async () => {
    await start()
    noteHostChannelLost()
    expect(saved().hostChannelLost).toBe(true)
    noteHostChannelRestored()
    expect(saved().hostChannelLost).toBe(false)
  })

  it("clears a bfcache pagehide when the same page becomes visible again", async () => {
    await start()
    listeners.get("document:freeze")?.()
    listeners.get("window:pagehide")?.(Object.assign(new Event("pagehide"), { persisted: true }))
    hidden = false
    listeners.get("document:visibilitychange")?.()
    expect(saved()).toMatchObject({ cleanExit: false, pagehideSeen: false, freezeSeen: false })
  })

  it("clears freeze evidence on an explicit lifecycle resume", async () => {
    await start()
    listeners.get("document:freeze")?.()
    expect(saved().freezeSeen).toBe(true)
    listeners.get("document:resume")?.()
    expect(saved().freezeSeen).toBe(false)
  })

  it("logs every page lifecycle edge with its event and state as it happens", async () => {
    // Given
    await start()

    // When
    hidden = true
    listeners.get("document:visibilitychange")?.()
    listeners.get("document:freeze")?.()
    listeners.get("window:pagehide")?.(Object.assign(new Event("pagehide"), { persisted: true }))
    hidden = false
    listeners.get("window:pageshow")?.(Object.assign(new Event("pageshow"), { persisted: true }))
    listeners.get("document:resume")?.()
    listeners.get("document:visibilitychange")?.()

    // Then
    expect(lifecycleRecord.mock.calls.map(([data]) => [data.event, data.state, data.persisted])).toEqual([
      ["visibilitychange", "hidden", undefined],
      ["freeze", "hidden", undefined],
      ["pagehide", "hidden", true],
      ["pageshow", "visible", true],
      ["resume", "visible", undefined],
      ["visibilitychange", "visible", undefined],
    ])
    expect(lifecycleRecord.mock.calls.every(([data]) => typeof data.monoMs === "number")).toBe(true)
  })

  it("logs resume and pageshow as hidden while the document stays hidden", async () => {
    // Given
    await start()
    hidden = true

    // When
    listeners.get("document:resume")?.()
    listeners.get("window:pageshow")?.(Object.assign(new Event("pageshow"), { persisted: false }))

    // Then
    expect(lifecycleRecord.mock.calls.map(([data]) => [data.event, data.state])).toEqual([
      ["resume", "hidden"],
      ["pageshow", "hidden"],
    ])
  })

  it("marks an app-initiated reload synchronously", async () => {
    await start()
    noteOwnReload()
    expect(saved().ownReload).toBe(true)
  })

  it("heartbeats while visible with screen, game, turn, links and memory position", async () => {
    pathname = "/game"
    setSessionProbe(() => ({ inGame: true, gameIndex: 248, turn: 8, liveVideo: 4 }))
    await start()
    enterScene("game.round")
    vi.setSystemTime(NOW + HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(saved()).toMatchObject({ inGame: true, gameIndex: 248, turn: 8, liveVideo: 4, screen: "game.round" })
    expect(saved().lastSeenAt).toBeGreaterThanOrEqual(NOW + HEARTBEAT_MS)
  })

  it("records the game route before its chain journey or scene is ready", async () => {
    pathname = "/products/dim2/game"
    await start()
    expect(saved()).toMatchObject({ inGame: true, screen: "game" })
  })

  it("does not heartbeat while hidden", async () => {
    await start()
    hidden = true
    listeners.get("document:visibilitychange")?.()
    const hiddenAt = saved().lastSeenAt
    vi.setSystemTime(NOW + HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(saved().lastSeenAt).toBe(hiddenAt)
  })

  it("coalesces position changes in one task", async () => {
    await start()
    const before = local.get(LAST_SESSION_KEY)
    enterScene("game.round")
    noteSessionChange()
    await flush()
    expect(local.get(LAST_SESSION_KEY)).not.toBe(before)
    expect(saved().screen).toBe("game.round")
  })

  it("writes fresh counters on a phase change and samples DOM only on the heartbeat", async () => {
    const sample = vi.fn()
    pathname = "/game"
    setSessionProbe(() => ({ inGame: true, gameIndex: 248, turn: 1, liveVideo: 1 }))
    await startSessionRecord({ record, sample })
    const fresh = { ...resourceRead() }
    delete fresh.domNodes
    resourceRead.mockImplementationOnce(() => ({ ...fresh, peerConnections: 3 }))
    enterScene("game.round")
    await flush()
    expect(saved().gameState).toMatchObject({ gameIndex: 248, phase: "game.round", counters: { peerConnections: 3 } })
    expect((saved().gameState as { counters: Record<string, unknown> }).counters).not.toHaveProperty("domNodes")
    expect(resourceRead).toHaveBeenLastCalledWith(false)

    vi.setSystemTime(NOW + HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(resourceRead).toHaveBeenLastCalledWith(true)
    expect(sample).toHaveBeenCalledOnce()
    expect(sample).toHaveBeenCalledWith(expect.objectContaining({ gameIndex: 248, phase: "game.round" }))
  })

  it("keeps game evidence through payoff phases and clears it only when payoff ends", async () => {
    pathname = "/game"
    setSessionProbe(() => ({ inGame: true, gameIndex: 248 }))
    await start()
    enterScene("draw.wheel")
    await flush()
    expect(saved().gameState).toMatchObject({ phase: "draw", gameIndex: 248 })
    enterScene("chest")
    await flush()
    expect(saved().gameState).toMatchObject({ phase: "chest", gameIndex: 248 })
    clearGameSessionState()
    expect(saved().gameState).toBeUndefined()
  })

  it("does not recreate a stalled payoff after later lifecycle saves", async () => {
    const sample = vi.fn()
    setSessionProbe(() => ({ inGame: false, gameIndex: 248 }))
    await startSessionRecord({ record, sample })
    enterScene("chest")
    await flush()
    expect(saved().gameState).toMatchObject({ phase: "chest" })
    clearGameSessionState()
    hidden = true
    listeners.get("document:visibilitychange")?.()
    listeners.get("document:freeze")?.()
    vi.setSystemTime(NOW + HEARTBEAT_MS)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(saved().gameState).toBeUndefined()
    expect(sample).not.toHaveBeenCalled()
  })

  it("caps evidence and sampling for a payoff phase that never finishes", async () => {
    const sample = vi.fn()
    setSessionProbe(() => ({ inGame: false, gameIndex: 248 }))
    await startSessionRecord({ record, sample })
    enterScene("chest")
    await flush()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * MAX_PAYOFF_SAMPLES_PER_PHASE)
    expect(sample).toHaveBeenCalledTimes(MAX_PAYOFF_SAMPLES_PER_PHASE)
    expect(saved().gameState).toBeUndefined()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5)
    expect(sample).toHaveBeenCalledTimes(MAX_PAYOFF_SAMPLES_PER_PHASE)
    expect(saved().gameState).toBeUndefined()
    enterScene("draw.wheel")
    await flush()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(sample).toHaveBeenCalledTimes(MAX_PAYOFF_SAMPLES_PER_PHASE + 1)
    expect(saved().gameState).toMatchObject({ phase: "draw" })
  })

  it("retains mid-game evidence across pagehide for the next boot", async () => {
    pathname = "/game"
    setSessionProbe(() => ({ inGame: true, gameIndex: 248 }))
    await start()
    enterScene("game.confirm")
    await flush()
    listeners.get("window:pagehide")?.(new Event("pagehide"))
    expect(saved()).toMatchObject({ cleanExit: true, gameState: { gameIndex: 248, phase: "game.confirm" } })
  })

  it("clears payoff evidence when that page ends cleanly", async () => {
    setSessionProbe(() => ({ inGame: false, gameIndex: 248 }))
    await start()
    enterScene("draw.wheel")
    await flush()
    expect(saved().gameState).toMatchObject({ phase: "draw" })
    listeners.get("window:pagehide")?.(new Event("pagehide"))
    expect(saved().gameState).toBeUndefined()
  })
})

describe("interrupted journey recovery", () => {
  it("establishes the new boot before recovering an interrupted game journey", async () => {
    const recovery = {
      name: "join",
      startedAt: NOW - 40_000,
      traceHeader: `${"a".repeat(32)}-${"b".repeat(16)}-1`,
      lastStep: "mesh.open",
      steps: [{ name: "camera.acquire", startedAt: NOW - 39_000, endedAt: NOW - 38_000 }],
    }
    previous({ openJourneys: [recovery] })
    const recover = vi.fn(() => expect(saved().sessionId).not.toBe("old-session"))
    await startSessionRecord({ record, recover })
    expect(recover).toHaveBeenCalledWith([recovery], "old-session", NOW - 20_000)
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ openJourneys: ["join"], openJourneySteps: ["join:mesh.open"] }))
  })

  it("does not recover a clean or stale record", async () => {
    const recovery = [{ name: "join", startedAt: NOW - 40_000, traceHeader: `${"a".repeat(32)}-${"b".repeat(16)}-1`, lastStep: "mesh.open", steps: [] }]
    const recover = vi.fn()
    previous({ cleanExit: true, pagehideSeen: true, openJourneys: recovery })
    await startSessionRecord({ record, recover })
    expect(recover).not.toHaveBeenCalled()
    resetSessionRecordForTests()
    previous({ lastSeenAt: NOW - STALE_AFTER_MS, openJourneys: recovery })
    await startSessionRecord({ record, recover })
    expect(recover).not.toHaveBeenCalled()
  })
})
