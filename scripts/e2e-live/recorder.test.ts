// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserContext, Page } from "@playwright/test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseRows, verdictTable, type TileRow } from "./record"
import { BotRecorder, captureRelaunchStorage, captureWithReservedRelaunchBudget, flushGameLog, installGameLogDeliveryFlag, proveNextOpenGameLogDelivery, readPage, recapTilesReady, staleUndurableTailError, TICK_MS } from "./recorder"
import vm from "node:vm"
import { clockScript } from "./browser-profile"
import { GAME_LOG_OUTBOX_KEY, resetGameLogOutboxForTests, settleGameLogOutbox } from "../../apps/jollity-app/lib/telemetry/game-log-outbox"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

const pageRow = (text: string) => ({
  url: "http://localhost/game",
  pillLabel: null,
  ducked: false,
  introHeadline: false,
  confirmButton: true,
  sessionStage: "confirm",
  sessionTurn: null,
  tiles: [
    { id: "flip", role: "coplayer", text, hasImage: false, votable: true },
  ],
})

describe("authoritative recap capture", () => {
  const storage = (value: string) => ({ cookies: [], origins: [{ origin: "http://localhost", localStorage: [{ name: "tail", value }] }] })

  const relaunchRig = (options: {
    evaluateError?: Error
    durable?: () => boolean
    beforePause?: () => void
    noCallFrames?: boolean
    noPauseEvent?: boolean
    readError?: Error
    storageValues?: string[]
    otherOrigin?: boolean
  } = {}) => {
    const calls: string[] = []
    let paused = false
    let pausedListener: ((event: { callFrames: { callFrameId: string }[] }) => void) | undefined
    const cdp = {
      once: (event: string, listener: typeof pausedListener) => {
        if (event === "Debugger.paused") pausedListener = listener
      },
      send: async (method: string) => {
        calls.push(method)
        if (method === "Debugger.pause") {
          options.beforePause?.()
          paused = true
          if (!options.noPauseEvent) pausedListener?.({ callFrames: options.noCallFrames ? [] : [{ callFrameId: "frame" }] })
        }
        if (method === "Debugger.evaluateOnCallFrame") {
          if (options.readError) throw options.readError
          return { result: { value: {
            tail: { durable: options.durable?.() ?? true, pendingLines: 1, newestLineAt: Date.now() - 1_000 },
            origin: "http://localhost",
            localStorage: [{ name: "tail", value: "frozen-snapshot" }],
          } } }
        }
        if (method === "Debugger.resume") paused = false
        return {}
      },
      detach: async () => { calls.push("detach") },
    }
    const page = {
      evaluate: async (run: (ms: number) => Promise<unknown>, ms: number) => {
        calls.push("settle")
        if (options.evaluateError) throw options.evaluateError
        await run(ms)
        return { durable: options.durable?.() ?? true, pendingLines: 1, newestLineAgeMs: 1_000 }
      },
    } as unknown as Page
    let storageCall = 0
    const context = {
      newCDPSession: async () => cdp,
      cookies: async () => [{ name: "session", value: "latest", domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" as const }],
      storageState: async () => {
        calls.push("storage")
        const value = options.storageValues?.[storageCall] ?? (storageCall === 0 ? "baseline-snapshot" : "fresh-fallback")
        storageCall += 1
        const snapshot = storage(value)
        if (options.otherOrigin) snapshot.origins.push({ origin: "https://other.example", localStorage: [{ name: "other", value: "preserved" }] })
        return snapshot
      },
    } as unknown as BrowserContext
    return { calls, context, page, paused: () => paused }
  }

  it("waits for the production debounce, freezes page motion, and snapshots a truly durable tail without sending", async () => {
    const rig = relaunchRig()

    const result = await captureRelaunchStorage(rig.page, rig.context, { settleMs: 0 })

    expect(result.checkpointed).toBe(true)
    expect(result.storage).toEqual({
      cookies: [{ name: "session", value: "latest", domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
      origins: [{ origin: "http://localhost", localStorage: [{ name: "tail", value: "frozen-snapshot" }] }],
    })
    expect(rig.calls).toEqual([
      "storage", "settle", "Debugger.enable", "Debugger.pause", "Debugger.evaluateOnCallFrame",
      "Debugger.resume", "Debugger.disable", "detach",
    ])
    expect(rig.paused()).toBe(false)
  })

  it("takes a fresh post-settle snapshot when page evaluation fails", async () => {
    const rig = relaunchRig({ evaluateError: new Error("renderer is closing") })

    const result = await captureRelaunchStorage(rig.page, rig.context, { settleMs: 0 })

    expect(result.checkpointed).toBe(false)
    expect(result.storage).toEqual(storage("fresh-fallback"))
    expect(rig.calls).toEqual(["storage", "settle", "storage"])
  })

  it("does not claim a durable snapshot when a line lands after settle but before the debugger pause", async () => {
    let durable = true
    const rig = relaunchRig({ durable: () => durable, beforePause: () => { durable = false } })

    const result = await captureRelaunchStorage(rig.page, rig.context, { settleMs: 0 })

    expect(result.checkpointed).toBe(false)
    expect(result.storage).toMatchObject({ origins: [{ origin: "http://localhost", localStorage: [{ name: "tail", value: "frozen-snapshot" }] }] })
  })

  it("replaces only the paused origin while preserving other origins and taking latest cookies", async () => {
    const rig = relaunchRig({ otherOrigin: true })

    const result = await captureRelaunchStorage(rig.page, rig.context, { settleMs: 0 })

    expect(result.storage.origins).toEqual([
      { origin: "https://other.example", localStorage: [{ name: "other", value: "preserved" }] },
      { origin: "http://localhost", localStorage: [{ name: "tail", value: "frozen-snapshot" }] },
    ])
    expect(result.storage.cookies).toEqual([expect.objectContaining({ name: "session", value: "latest" })])
  })

  it("records missing call frames, resumes, and falls back to the fresh post-settle snapshot", async () => {
    const rig = relaunchRig({ noCallFrames: true, durable: () => false })

    const result = await captureRelaunchStorage(rig.page, rig.context, { settleMs: 0 })

    expect(result.checkpointed).toBe(false)
    expect(result.checkpointError).toMatch(/no call frames/)
    expect(staleUndurableTailError(result)).toMatch(/required line/)
    expect(result.storage).toEqual(storage("fresh-fallback"))
    expect(rig.calls).toContain("Debugger.resume")
    expect(rig.paused()).toBe(false)
  })

  it("returns the best fresh fallback only after resuming when the frozen read throws", async () => {
    const rig = relaunchRig({ readError: new Error("renderer read failed") })

    const result = await captureRelaunchStorage(rig.page, rig.context, { settleMs: 0, budgetMs: 2_000 })

    expect(result.storage).toEqual(storage("fresh-fallback"))
    expect(rig.calls.indexOf("Debugger.resume")).toBeLessThan(rig.calls.lastIndexOf("storage"))
    expect(rig.paused()).toBe(false)
  })

  it("honours the pause deadline, resumes a late-paused renderer, and returns a usable snapshot", async () => {
    const rig = relaunchRig({ noPauseEvent: true })

    const result = await captureRelaunchStorage(rig.page, rig.context, { settleMs: 0, pauseTimeoutMs: 1, budgetMs: 100 })

    expect(result.checkpointed).toBe(false)
    expect(result.checkpointError).toMatch(/renderer pause timed out/)
    expect(result.storage).toEqual(storage("fresh-fallback"))
    expect(rig.calls).toContain("Debugger.resume")
    expect(rig.paused()).toBe(false)
  })

  it("fails aged unsaved required tails but tolerates a line still inside the production debounce margin", () => {
    expect(staleUndurableTailError({ checkpointed: false, pendingTailLines: 2, newestTailLineAgeMs: 301 })).toMatch(/2 required line/)
    expect(staleUndurableTailError({ checkpointed: false, pendingTailLines: 2, newestTailLineAgeMs: 299 })).toBeUndefined()
    expect(staleUndurableTailError({ checkpointed: true, pendingTailLines: 2, newestTailLineAgeMs: 1_000 })).toBeUndefined()
  })

  it("requires a replacement page to deliver a record that existed before boot", async () => {
    const page = { evaluate: async () => ({ pending: 2, delivered: 1 }) } as unknown as Page
    await expect(proveNextOpenGameLogDelivery(page, 100)).resolves.toEqual({ pending: 2, delivered: 1 })
    const none = { evaluate: async () => ({ pending: 0, delivered: 0 }) } as unknown as Page
    await expect(proveNextOpenGameLogDelivery(none, 100)).rejects.toThrow(/no pending game-log record/)
    const stuck = { evaluate: async () => ({ pending: 2, delivered: 0 }) } as unknown as Page
    await expect(proveNextOpenGameLogDelivery(stuck, 100)).rejects.toThrow(/delivered 0\/2/)
  })

  it("reserves time for storage capture when earlier evidence exhausts its share", async () => {
    vi.useFakeTimers()
    try {
      let snapshotCalls = 0
      let snapshotBudget = 0
      const captured = captureWithReservedRelaunchBudget({
        budgetMs: 1_000,
        reserveMs: 300,
        prepare: async () => await new Promise<void>(() => {}),
        capture: async (budgetMs) => {
          snapshotCalls += 1
          snapshotBudget = budgetMs
          return "snapshot"
        },
      })

      await vi.advanceTimersByTimeAsync(700)
      await expect(captured).resolves.toMatchObject({ preparationError: expect.any(Error), snapshot: "snapshot" })
      expect(snapshotCalls).toBe(1)
      expect(snapshotBudget).toBe(300)
    } finally {
      vi.useRealTimers()
    }
  })

  it("installs the bot game-log opt-in for this document and future navigations only when requested", async () => {
    const calls: string[] = []
    const page = {
      addInitScript: async (run: () => void) => { calls.push("init"); run() },
      evaluate: async (run: () => void) => { calls.push("current"); run() },
    } as unknown as Page
    delete (globalThis as { __jollityGameLogToSentry?: unknown }).__jollityGameLogToSentry
    await installGameLogDeliveryFlag(page, false)
    expect(calls).toEqual([])
    expect((globalThis as { __jollityGameLogToSentry?: unknown }).__jollityGameLogToSentry).toBeUndefined()
    await installGameLogDeliveryFlag(page, true)
    expect(calls).toEqual(["init", "current"])
    expect((globalThis as { __jollityGameLogToSentry?: unknown }).__jollityGameLogToSentry).toBe(true)
    delete (globalThis as { __jollityGameLogToSentry?: unknown }).__jollityGameLogToSentry
  })

  it("installs the bot game-log opt-in before a new page is created or navigated", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    const factoryStart = source.indexOf("const newBotPage = async")
    const factoryEnd = source.indexOf("test.beforeAll", factoryStart)
    const factory = source.slice(factoryStart, factoryEnd)
    const install = factory.indexOf("await installGameLogDeliveryInit(context)")
    const recover = factory.indexOf("await installTelemetryRecoveryInit(context)")
    const create = factory.indexOf("await context.newPage()")
    expect(factoryStart).toBeGreaterThan(-1)
    expect(install).toBeGreaterThan(-1)
    expect(recover).toBeGreaterThan(install)
    expect(create).toBeGreaterThan(install)
    expect(create).toBeGreaterThan(recover)
  })

  it("includes game-log flag installation in the flush timeout", async () => {
    vi.stubEnv("GAME_LOG_TO_SENTRY", "1")
    const page = {
      addInitScript: async () => new Promise<void>(() => {}),
      evaluate: async () => { throw new Error("evaluate must wait for flag installation") },
    } as unknown as Page
    const result = await Promise.race([
      flushGameLog(page, 10),
      new Promise<string>((resolve) => setTimeout(() => resolve("unbounded flag install"), 100)),
    ])
    expect(result).toContain("flush failed: Error: timed out after 0.01 s")
  })

  it("does not accept empty role copy, but accepts rendered Seen earlier or an actual still", () => {
    expect(recapTilesReady(pageRow("").tiles)).toBe(false)
    expect(recapTilesReady(pageRow("Seen earlier").tiles)).toBe(true)
    expect(recapTilesReady([{ ...pageRow("").tiles[0], hasImage: true }])).toBe(true)
  })

  it("waits past an empty confirm frame and retains the rendered role text", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recap-"))
    roots.push(root)
    const rows = [pageRow(""), pageRow("Seen earlier")]
    const page = {
      evaluate: async () => rows.shift() ?? pageRow("Seen earlier"),
      waitForTimeout: async () => {},
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.captureRecap(1000)
    expect(recorder.recap?.tiles.map((tile) => tile.text)).toEqual(["Seen earlier"])
  })
})

describe("authoritative timeline sampling", () => {
  it("brackets a held DOM read and persists its eventual authoritative session phase", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recorder-read-time-"))
    roots.push(root)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let release!: () => void
    let readStarted!: () => void
    const began = new Promise<void>((resolve) => (readStarted = resolve))
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const page = {
      evaluate: async () => {
        readStarted()
        await blocked
        return {
          ...pageRow("Seen earlier"),
          pillLabel: "Turn 5 of 6",
          confirmButton: false,
          sessionStage: "ending",
          sessionTurn: 5,
          snapshotAt: new Date().toISOString(),
          viewport: { width: 390, height: 844 },
          documentIdentity: "http://localhost/game|1234",
        }
      },
      screenshot: async () => {},
      waitForTimeout: sleep,
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    recorder.start()
    await began
    await sleep(20)
    const releasedAt = Date.now()
    release()
    await sleep(30)
    await recorder.stop()
    const row = JSON.parse(readFileSync(join(root, "tiles-1.jsonl"), "utf8").trim().split("\n")[0]) as Record<string, unknown>
    expect(row.t).toEqual(expect.any(String))
    expect(row.ms).toEqual(expect.any(Number))
    expect(row.sessionStage).toBe("ending")
    expect(row.sessionTurn).toBe(5)
    expect(row.pageGeneration).toBe(0)
    expect(row.documentIdentity).toBe("http://localhost/game|1234")
    expect(row.viewport).toEqual({ width: 390, height: 844 })
    expect(Date.parse(String(row.snapshotAt))).toBeGreaterThanOrEqual(releasedAt)
    expect(Date.parse(String(row.readStartedAt))).toBeLessThanOrEqual(Date.parse(String(row.snapshotAt)))
    expect(Date.parse(String(row.readCompletedAt))).toBeGreaterThanOrEqual(Date.parse(String(row.snapshotAt)))
    const shots = readFileSync(join(root, "screenshots-1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { t: string; status: string; turn: number; stage: string })
    expect(shots.map(({ status }) => status)).toEqual(["deferred"])
    expect(shots.every(({ turn, stage }) => turn === 5 && stage === "play")).toBe(true)
    expect(Date.parse(shots[0].t)).toBeGreaterThanOrEqual(Date.parse(String(row.readCompletedAt)))
  })

  it("continues across a stalled screenshot and records its eventual failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recorder-starvation-"))
    roots.push(root)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let turn: number | null = 10
    let intro = true
    let shotStarted = false
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const page = {
      evaluate: async () => ({
        url: "http://localhost/game",
        pillLabel: turn === null ? null : `Turn ${turn} of 12`,
        ducked: intro,
        introHeadline: intro,
        confirmButton: turn === null,
        sessionStage: turn === null ? "confirm" : intro ? "introduction" : "gameplay",
        sessionTurn: turn,
        tiles: [
          {
            id: "peer",
            role: "coplayer",
            hasImage: false,
            votable: true,
            tapReady: true,
            verdict: "approve",
            transform: null,
            attrs: {},
            text: turn === null ? "Seen earlier" : "",
            aria: [],
            box: { x: 0, y: 0, w: 100, h: 100 },
            visible: true,
            hit: "self",
          },
        ],
      }),
      screenshot: async () => {
        if (shotStarted) return
        shotStarted = true
        intro = false
        await Promise.race([blocked, sleep(50)])
        throw new Error("controlled screenshot timeout")
      },
      waitForTimeout: sleep,
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    recorder.start()
    while (!shotStarted) await sleep(1)
    // wait for the row that proves each turn was sampled, not a fixed 300 ms: a loaded runner can stretch one 250 ms tick past it
    const timelineRows = () =>
      readFileSync(join(root, "tiles-1.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { turn?: number })
    const seen = async (n: number) => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !timelineRows().some((row) => row.turn === n)) await sleep(10)
    }
    turn = 11
    await seen(11)
    turn = 12
    await seen(12)
    const during = timelineRows()
    let stopped = false
    const stopping = recorder.stop().then(() => (stopped = true))
    await sleep(0)
    expect(stopped).toBe(false)
    release()
    await stopping

    expect(during.some((row) => row.turn === 11)).toBe(true)
    expect(during.some((row) => row.turn === 12)).toBe(true)
    const shotLog = join(root, "screenshots-1.jsonl")
    expect(existsSync(shotLog)).toBe(true)
    expect(readFileSync(shotLog, "utf8")).toContain("controlled screenshot timeout")
  })

  it("bounds a serialized shared-Page adapter, records deferral, drains holds and rebinds cleanly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const root = mkdtempSync(join(tmpdir(), "jollity-recorder-shared-page-"))
    roots.push(root)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let stage: "introduction" | "ending" = "introduction"
    let busy: Promise<void> | null = null
    let releaseBusy: (() => void) | null = null
    let firstShot = true
    let shotStarted!: () => void
    const started = new Promise<void>((resolve) => (shotStarted = resolve))
    const rows = () => ({
      url: "http://localhost/game",
      pillLabel: "Turn 5 of 6",
      ducked: stage === "introduction",
      introHeadline: stage === "introduction",
      confirmButton: false,
      sessionStage: stage,
      sessionTurn: 5,
      snapshotAt: new Date().toISOString(),
      viewport: { width: 390, height: 844 },
      documentIdentity: "http://localhost/game|shared-a",
      tiles: [],
    })
    const page = {
      evaluate: async () => {
        await busy
        return rows()
      },
      screenshot: async ({ timeout }: { timeout?: number }) => {
        if (!firstShot) return
        firstShot = false
        shotStarted()
        let release!: () => void
        busy = new Promise<void>((resolve) => {
          release = resolve
          releaseBusy = resolve
        })
        await new Promise<void>((resolve, reject) => {
          const timer = timeout === undefined ? null : setTimeout(() => reject(new Error("shared screenshot timed out")), timeout)
          void busy!.then(() => {
            if (timer) clearTimeout(timer)
            resolve()
          })
        }).finally(() => {
          release()
          busy = null
          releaseBusy = null
        })
      },
      waitForTimeout: sleep,
    } as unknown as Page
    // FAKE CLOCK: every bound below (the 1 s screenshot timeout, the 2 s evidence ceiling, the 250 ms tick) is a duration on the
    // recorder's own clock, so the test advances that clock instead of racing it on a loaded runner (#634). Real I/O is only
    // synchronous fs, which needs no waiting.
    const recorder = new BotRecorder(page, 1, root, root)
    const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
    const until = async (done: () => boolean, budgetMs: number) => {
      for (let spent = 0; !done() && spent < budgetMs; spent += 10) await advance(10)
      expect(done()).toBe(true)
    }
    try {
      recorder.start()
      await started
      stage = "ending"
      const actorStarted = Date.now()
      const actorRead = page.evaluate(() => null).then(() => Date.now() - actorStarted)
      let drained = false
      const holding = recorder.gate.hold().then(() => (drained = true))
      const watchdog = sleep(2200).then(() => releaseBusy?.())
      // the hold must drain on the screenshot's own 1 s timeout, long before the 2.2 s watchdog would free the page
      await until(() => drained, 2_000)
      await holding
      recorder.gate.release()
      expect(await actorRead).toBeLessThan(2000)
      await advance(2200 + 700) // run out the watchdog (a no-op: the page is free) and the settle window
      await watchdog

      const replacement = { ...page, evaluate: async () => ({ ...rows(), documentIdentity: "http://localhost/game|shared-b" }) } as unknown as Page
      recorder.rebind(replacement)
      await until(() => readFileSync(join(root, "tiles-1.jsonl"), "utf8").includes("shared-b"), 5_000)
      const stopping = recorder.stop()
      await advance(TICK_MS)
      await stopping
    } finally {
      vi.useRealTimers()
    }

    const timeline = parseRows(readFileSync(join(root, "tiles-1.jsonl"), "utf8"))
    const snapshots = timeline.flatMap((row) => row.snapshotAt ? [Date.parse(row.snapshotAt)] : [])
    expect(Math.max(...snapshots.slice(1).map((at, index) => at - snapshots[index]))).toBeLessThan(2000)
    expect(timeline.some((row) => row.pageGeneration === 1 && row.documentIdentity?.endsWith("shared-b"))).toBe(true)
    const statuses = readFileSync(join(root, "screenshots-1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { status: string; reason?: string; trigger?: string })
    expect(statuses.map(({ status }) => status)).toEqual(expect.arrayContaining(["queued", "started", "error", "deferred"]))
    expect(statuses.find(({ status }) => status === "deferred")?.reason).toMatch(/observation/i)
    expect(statuses.some(({ status, trigger }) => status === "deferred" && trigger === "stage")).toBe(true)
    expect(statuses.some(({ status, trigger }) => status === "deferred" && trigger === "periodic")).toBe(true)
    expect(busy).toBeNull()
  }, 10_000)

  it("writes a typed role action between actual observations without breaking bounded continuity", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recorder-role-action-"))
    roots.push(root)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let read = 0
    let thirdStarted!: () => void
    let releaseThird!: () => void
    const third = new Promise<void>((resolve) => (thirdStarted = resolve))
    const held = new Promise<void>((resolve) => (releaseThird = resolve))
    const tile = (role: "unseen" | "coplayer", id: string): TileRow => ({
      id,
      role,
      votable: role === "coplayer",
      tapReady: false,
      verdict: "reject",
      cursorPointer: false,
      rotateY: 0,
      rotY: 0,
      attrs: { "data-tile-role": role },
      text: "",
      aria: [],
      box: { x: 0, y: 0, w: 100, h: 100 },
      visible: true,
      hit: "self",
      tapped: false,
      click: null,
    })
    const page = {
      evaluate: async () => {
        read++
        if (read === 3) {
          thirdStarted()
          await held
        }
        const role = read >= 3 ? "coplayer" : "unseen"
        return {
          url: "http://localhost/game",
          pillLabel: "Turn 5 of 6",
          ducked: false,
          introHeadline: false,
          confirmButton: false,
          sessionStage: read === 1 ? "gameplay" : "ending",
          sessionTurn: 5,
          snapshotAt: new Date().toISOString(),
          viewport: { width: 390, height: 844 },
          documentIdentity: "http://localhost/game|role-action",
          tiles: [tile(role, "peer"), tile("unseen", "self")],
        }
      },
      screenshot: async () => {
        throw new Error("critical observation window must defer screenshots")
      },
      waitForTimeout: sleep,
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    recorder.start()
    await third
    recorder.mark("video-suppressed", "0 outbound tracks")
    releaseThird()
    while (read < 4) await sleep(10)
    await recorder.stop()

    const jsonl = readFileSync(join(root, "tiles-1.jsonl"), "utf8")
    const timeline = parseRows(jsonl)
    const annotation = timeline.find((row) => row.recordType === "role-action")
    expect(annotation).toMatchObject({
      roleAction: { id: "video-suppressed", detail: "0 outbound tracks" },
      role: "video-suppressed: 0 outbound tracks",
    })
    expect(verdictTable(timeline, "self").turns[0]?.verdicts.peer).toBe("no-opportunity")
  })

  it("keeps a native-style renderer stall unknown instead of manufacturing continuity", async () => {
    const root = mkdtempSync(join(tmpdir(), "jollity-recorder-native-stall-"))
    roots.push(root)
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    let read = 0
    const tile = (role: "unseen" | "coplayer", id: string): TileRow => ({
      id,
      role,
      votable: role === "coplayer",
      tapReady: false,
      verdict: "reject",
      cursorPointer: false,
      rotateY: 0,
      rotY: 0,
      attrs: { "data-tile-role": role },
      text: "",
      aria: [],
      box: { x: 0, y: 0, w: 100, h: 100 },
      visible: true,
      hit: "self",
      tapped: false,
      click: null,
    })
    const page = {
      evaluate: async () => {
        read++
        if (read === 3) await sleep(2100)
        const role = read >= 3 ? "coplayer" : "unseen"
        return {
          url: "http://localhost/game",
          pillLabel: "Turn 5 of 6",
          ducked: false,
          introHeadline: false,
          confirmButton: false,
          sessionStage: read === 1 ? "gameplay" : "ending",
          sessionTurn: 5,
          snapshotAt: new Date().toISOString(),
          viewport: { width: 390, height: 844 },
          documentIdentity: "http://localhost/game|native-stall",
          tiles: [tile(role, "peer"), tile("unseen", "self")],
        }
      },
      screenshot: async () => {
        throw new Error("critical observation window must defer screenshots")
      },
      waitForTimeout: sleep,
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    recorder.start()
    while (read < 3) await sleep(10)
    await sleep(2150)
    await recorder.stop()
    const timeline = parseRows(readFileSync(join(root, "tiles-1.jsonl"), "utf8"))
    expect(timeline.some((row) => Date.parse(row.readCompletedAt ?? "") - Date.parse(row.readStartedAt ?? "") > 2000)).toBe(true)
    expect(verdictTable(timeline, "self").turns[0]?.verdicts.peer).toBe("unknown")
  }, 10_000)
})

describe("readPage stamps snapshotAt on the runner's clock (game 317, bot 3: a +75 s profile clock)", () => {
  // the page function runs for real in a vm with the profile's own clockScript, over an empty game page
  const inPage = (offsetS: number | null) => {
    const ctx = vm.createContext({ document: { querySelector: () => null, querySelectorAll: () => [] }, location: { href: "http://localhost/game" }, performance: { timeOrigin: 1 }, innerWidth: 412, innerHeight: 915 })
    if (offsetS !== null) vm.runInContext(clockScript(offsetS), ctx)
    return { evaluate: async (fn: () => unknown) => vm.runInContext(`(${fn.toString()})()`, ctx) } as unknown as Page
  }
  for (const offsetS of [75, -300, 0, null])
    it(`inside the read bracket with the page clock at ${offsetS === null ? "no clock script" : `${offsetS} s`}`, async () => {
      const before = Date.now()
      const p = await readPage(inPage(offsetS))
      const at = Date.parse(p.snapshotAt)
      expect(at).toBeGreaterThanOrEqual(before)
      expect(at).toBeLessThanOrEqual(Date.now())
    })
  it("a mid-game jump (jumpClock rewrites __e2eClockOffMs) is taken off too", async () => {
    const page = inPage(0)
    await page.evaluate(() => ((globalThis as { __e2eClockOffMs?: number }).__e2eClockOffMs = 30_000))
    const before = Date.now()
    const at = Date.parse((await readPage(page)).snapshotAt)
    expect(at - before).toBeLessThan(1000)
  })
})

describe("telemetry ground truth fails closed", () => {
  const line = (ts: number, message: string) => ({ ts, sessionId: "s", version: "v", level: "info" as const, tag: "telemetry", message })
  const pageExport = (entries: ReturnType<typeof line>[], to = entries.at(-1)?.ts ?? 0) => ({
    json: JSON.stringify({ meta: {}, entries }),
    records: [{
      name: "jollity.telemetry.game-log-outbox.v1.chunk.test",
      value: JSON.stringify({ gameIndex: 7, to }),
    }],
  })
  it("waits for the replacement document to reinstall its export hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-reload-")); roots.push(root)
    let hookWaitMs = 0
    const page = {
      evaluate: async (_run: unknown, waitMs: number) => {
        hookWaitMs = waitMs
        return pageExport([line(1, "ready after reload")])
      },
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    expect(await recorder.snapshotReopenedDevLog("postreload", 2_000)).toContain("1 lines")
    expect(hookWaitMs).toBe(1_900)
  })

  it("keeps genuine duplicate occurrences and filters away pre-game lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-truth-")); roots.push(root)
    const entries = [line(1, "boot"), line(2, "game 7 handover"), line(3, "same"), line(3, "same")]
    const page = { evaluate: async () => pageExport(entries) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("one")
    await recorder.snapshotDevLog("two")
    const truth = recorder.telemetryGroundTruth(7)
    expect(truth.lines.map((entry) => entry.message)).toEqual(["game 7 handover", "same", "same"])
    expect(truth.unavailable).toBeUndefined()
    expect(truth.truthCutoffAt).toBe(3)
    expect(truth.unpersistedAtKill).toBe(0)
  })

  it("reports distinct current-game pending chunks and delivered receipts as durable evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-durable-chunks-")); roots.push(root)
    const entries = [line(1, "game 7 handover"), line(2, "tap")]
    const page = {
      evaluate: async () => ({
        json: JSON.stringify({ meta: {}, entries }),
        records: [
          { name: "jollity.telemetry.game-log-outbox.v1.chunk.corrupt", value: "{" },
          {
            name: "jollity.telemetry.game-log-outbox.v1.chunk.pending-1",
            value: JSON.stringify({ id: "pending-1", gameIndex: 7, to: 2, lines: entries }),
          },
          {
            name: "jollity.telemetry.game-log-outbox.v1",
            value: JSON.stringify({ chunkIds: [], delivered: [{ kind: "chunk", id: "delivered-2", gameIndex: 7, to: 2 }] }),
          },
        ],
      }),
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("chunks")
    const truth = recorder.telemetryGroundTruth(7)
    expect(truth.durableChunkIds).toEqual(["delivered-2", "pending-1"])
    expect(truth.durableChunkBytes).toBeGreaterThan(0)
    expect(truth.unavailable).toMatch(/unreadable page checkpoint evidence/)
  })

  it("retains the cold-start fact even though its line precedes the game handover", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-cold-")); roots.push(root)
    const entries = [
      { ...line(1, "clock ready"), tag: "clock", data: { gapMs: 400, late: true } },
      line(2, "game 7 handover"),
    ]
    const page = { evaluate: async () => pageExport(entries) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("cold")
    const truth = recorder.telemetryGroundTruth(7)
    expect(truth.coldStart).toBe(true)
    expect(truth.lines.map((entry) => entry.message)).toEqual(["game 7 handover"])
  })

  it("does not take a clock that was ready before the game for a cold start", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-warm-")); roots.push(root)
    const entries = [
      { ...line(1, "clock ready"), tag: "clock", data: { gapMs: 400, late: false } },
      line(2, "game 7 handover"),
    ]
    const page = { evaluate: async () => pageExport(entries) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("ready")
    expect(recorder.telemetryGroundTruth(7).coldStart).toBe(false)
  })

  it("exposes app-side sign-up broadcast time instead of treating a harness click as progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-signup-")); roots.push(root)
    const entries = [
      { ...line(100, "tapped Register"), tag: "harness" },
      { ...line(150, "returning sign-up broadcast for player"), tag: "signup" },
    ]
    const page = { evaluate: async () => pageExport(entries).json } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    expect(await recorder.observeDevLogAt("signup", "sign-up broadcast for")).toBe(150)
    expect(recorder.latestDevLogAt("signup", "sign-up broadcast for")).toBe(150)
    expect(recorder.latestDevLogAt("harness", "sign-up broadcast for")).toBeNull()
  })

  it("marks a later failed document export unavailable instead of trusting an earlier partial snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-fail-")); roots.push(root)
    let calls = 0
    const page = { evaluate: async () => (++calls === 1 ? pageExport([line(2, "game 7 handover")]) : Promise.reject(new Error("dead page"))) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("good")
    await recorder.snapshotDevLog("dead")
    expect(recorder.telemetryGroundTruth(7).unavailable).toMatch(/document export failed.*dead page/)
  })

  it("requires a successful snapshot or export for every replacement page", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-docs-")); roots.push(root)
    const good = { evaluate: async () => pageExport([line(2, "game 7 handover")]) } as unknown as Page
    const empty = { evaluate: async () => JSON.stringify({ meta: {}, entries: [] }) } as unknown as Page
    const recorder = new BotRecorder(good, 1, root, root)
    await recorder.snapshotDevLog("before-pause")
    recorder.rebind(empty)
    await recorder.exportDevLog()
    expect(recorder.telemetryGroundTruth(7, 2).unavailable).toMatch(/documents without a successful snapshot\/export: 1/)
  })

  it("verifies pre-kill truth through the reopened host ring even when storageState has no pending outbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-storage-")); roots.push(root)
    const entries = [line(20_000, "game 7 handover"), line(20_001, "persisted by host ring")]
    let current = entries
    const makePage = () => ({ evaluate: async () => pageExport(current) } as unknown as Page)
    const page = makePage()
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("prekill-1")
    expect(recorder.recoverPersistedTelemetry({ origins: [] }, "kill-1", 40_000)).toContain("host ring verification deferred")
    recorder.rebind(makePage())
    expect(await recorder.recoverReopenedTelemetry("reopen-1")).toContain("misses 0")
    expect(recorder.telemetryGroundTruth(7, 2).unavailable).toBeUndefined()
    expect(recorder.telemetryGroundTruth(7, 2).unpersistedAtKill).toBe(0)

    await recorder.snapshotDevLog("prekill-2")
    recorder.recoverPersistedTelemetry({ origins: [] }, "kill-2", 40_000)
    current = entries.slice(0, 1)
    recorder.rebind(makePage())
    expect(await recorder.recoverReopenedTelemetry("reopen-2")).toContain("misses 1")
    expect(recorder.telemetryGroundTruth(7, 3).unpersistedAtKill).toBe(1)
    expect(recorder.telemetryGroundTruth(7, 3).unavailable).toMatch(/reopened durable stores miss 1/)
  })

  it("keeps recent lines informational instead of requiring an unflushed host-ring copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-recent-")); roots.push(root)
    const entries = [line(20_000, "game 7 handover"), line(39_500, "too recent to flush")]
    let current = entries
    const recorder = new BotRecorder({ evaluate: async () => pageExport(current) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry({ origins: [] }, "kill", 40_000)
    current = entries.slice(0, 1)
    recorder.rebind({ evaluate: async () => pageExport(current) } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen")).toContain("misses 0 required")
    expect(recorder.telemetryGroundTruth(7, 2).unavailable).toBeUndefined()
    expect(recorder.telemetryGroundTruth(7, 2).unpersistedAtKill).toBe(1)
  })

  it("requires only a provably retained suffix when sparse flushes exceed the ring slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-ring-slots-")); roots.push(root)
    const entries = [line(1_000, "game 7 handover"), ...Array.from({ length: 33 }, (_, i) => line(2_000 + i * 11_000, `sparse flush ${i}`))]
    let current = entries
    const recorder = new BotRecorder({ evaluate: async () => pageExport(current) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry({ origins: [] }, "kill", 500_000)
    current = entries.slice(-32)
    recorder.rebind({ evaluate: async () => pageExport(current) } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen")).toContain("misses 0 required")
    const truth = recorder.telemetryGroundTruth(7, 2)
    expect(truth.unavailable).toBeUndefined()
    expect(truth.unpersistedAtKill).toBe(2)
  })

  it("lets a recent multi-chunk flush evict an otherwise old ring candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-ring-recent-")); roots.push(root)
    const old = line(20_000, "game 7 handover")
    const recent = Array.from({ length: 40 }, (_, i) => line(31_000 + i, `recent flush ${i}`))
    let current = [old, ...recent]
    const recorder = new BotRecorder({ evaluate: async () => pageExport(current) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry({ origins: [] }, "kill", 40_000)
    current = recent.slice(-32)
    recorder.rebind({ evaluate: async () => pageExport(current) } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen")).toContain("misses 0 required")
    const truth = recorder.telemetryGroundTruth(7, 2)
    expect(truth.unavailable).toBeUndefined()
    expect(truth.unpersistedAtKill).toBe(9)
  })

  it("records a reopened export failure without misclassifying every line as durability loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-reopen-failed-")); roots.push(root)
    const entries = [line(20_000, "game 7 handover"), line(20_001, "required old line")]
    const recorder = new BotRecorder({ evaluate: async () => pageExport(entries) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry({ origins: [] }, "kill", 40_000)
    recorder.rebind({ evaluate: async () => Promise.reject(new Error("replacement dead")) } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen")).toContain("not evaluated")
    const truth = recorder.telemetryGroundTruth(7, 2)
    expect(truth.unpersistedAtKill).toBe(0)
    expect(truth.unavailable).toMatch(/replacement dead/)
    expect(truth.unavailable).not.toMatch(/durable stores miss/)
  })

  it("accepts pre-kill truth recovered from the replacement page's pre-boot outbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-reopened-outbox-")); roots.push(root)
    const handover = line(2, "game 7 handover")
    const pending = line(3, "persisted only in pre-boot outbox")
    const recorder = new BotRecorder({ evaluate: async () => pageExport([handover, pending]) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry({ origins: [] }, "kill", 10)
    recorder.rebind({
      evaluate: async () => ({
        json: pageExport([handover]).json,
        records: [{
          name: "jollity.telemetry.game-log-outbox.v1.chunk.reopened",
          value: JSON.stringify({ gameIndex: 7, to: 3, lines: [pending] }),
        }],
      }),
    } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen")).toContain("misses 0")
    const truth = recorder.telemetryGroundTruth(7, 2)
    expect(truth.unpersistedAtKill).toBe(0)
    expect(truth.unavailable).toBeUndefined()
  })

  it("preserves structured devLog lifecycle data for guards", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-lifecycle-")); roots.push(root)
    const entries = [{
      ts: 1,
      sessionId: "s",
      version: "v",
      level: "info" as const,
      tag: "rtc",
      message: "mesh opening",
      data: { room: "g7:alice_bob", self: "alice", peers: ["bob"] },
    }]
    const page = { evaluate: async () => pageExport(entries) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("lifecycle")
    expect(recorder.devlogEvidence().lines).toEqual([
      expect.objectContaining({ sessionId: "s", message: "mesh opening", data: entries[0].data }),
    ])
  })

  it("accepts a pre-kill chunk by exact delivered receipt after startup deletes it and play overwrites the ring", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-delivered-receipt-")); roots.push(root)
    const required = line(20_000, "game 7 handover")
    const chunkId = "7:session:begin:1:0"
    const saved = {
      origins: [{ localStorage: [
        { name: GAME_LOG_OUTBOX_KEY, value: JSON.stringify({ chunkIds: [chunkId], delivered: [] }) },
        { name: `${GAME_LOG_OUTBOX_KEY}.chunk.${encodeURIComponent(chunkId)}`, value: JSON.stringify({ id: chunkId, gameIndex: 7, to: 20_000, lines: [required] }) },
      ] }],
    }
    const recorder = new BotRecorder({ evaluate: async () => pageExport([required]) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry(saved, "kill", 40_000)
    const later = Array.from({ length: 40 }, (_, i) => line(40_001 + i, `post-reopen play ${i}`))
    recorder.rebind({
      evaluate: async () => ({
        json: pageExport(later).json,
        records: [{
          name: GAME_LOG_OUTBOX_KEY,
          value: JSON.stringify({ chunkIds: [], delivered: [{ kind: "chunk", id: chunkId, gameIndex: 7, to: 20_000 }] }),
        }],
      }),
    } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen", 2_000)).toContain("misses 0 required")
    const truth = recorder.telemetryGroundTruth(7, 2)
    expect(truth.unpersistedAtKill).toBe(0)
    expect(truth.unavailable).toBeUndefined()
  })

  it("does not let a foreign delivered receipt satisfy a required outbox chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-wrong-receipt-")); roots.push(root)
    const required = line(20_000, "game 7 handover")
    const chunkId = "7:session:begin:1:0"
    const saved = {
      origins: [{ localStorage: [
        { name: GAME_LOG_OUTBOX_KEY, value: JSON.stringify({ chunkIds: [chunkId], delivered: [] }) },
        { name: `${GAME_LOG_OUTBOX_KEY}.chunk.${encodeURIComponent(chunkId)}`, value: JSON.stringify({ id: chunkId, gameIndex: 7, to: 20_000, lines: [required] }) },
      ] }],
    }
    const recorder = new BotRecorder({ evaluate: async () => pageExport([required]) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry(saved, "kill", 40_000)
    recorder.rebind({
      evaluate: async () => ({
        json: pageExport([line(40_001, "later")]).json,
        records: [{ name: GAME_LOG_OUTBOX_KEY, value: JSON.stringify({ chunkIds: [], delivered: [{ kind: "chunk", id: "other" }] }) }],
      }),
    } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen", 2_000)).toContain("misses 1 required")
    expect(recorder.telemetryGroundTruth(7, 2).unavailable).toMatch(/durable stores miss 1/)
  })

  it("does not treat a dangling reopened index id as durable chunk evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-dangling-index-")); roots.push(root)
    const required = line(20_000, "game 7 handover")
    const chunkId = "7:session:begin:1:0"
    const saved = {
      origins: [{ localStorage: [
        { name: GAME_LOG_OUTBOX_KEY, value: JSON.stringify({ chunkIds: [chunkId], delivered: [] }) },
        { name: `${GAME_LOG_OUTBOX_KEY}.chunk.${encodeURIComponent(chunkId)}`, value: JSON.stringify({ id: chunkId, gameIndex: 7, to: 20_000, lines: [required] }) },
      ] }],
    }
    const recorder = new BotRecorder({ evaluate: async () => pageExport([required]) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry(saved, "kill", 40_000)
    recorder.rebind({
      evaluate: async () => ({
        json: pageExport([line(40_001, "later")]).json,
        records: [{ name: GAME_LOG_OUTBOX_KEY, value: JSON.stringify({ chunkIds: [chunkId], delivered: [] }) }],
      }),
    } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen", 2_000)).toContain("misses 1 required")
    expect(recorder.telemetryGroundTruth(7, 2).unavailable).toMatch(/durable stores miss 1/)
  })

  it("retries a bounded early recovery when the replacement hook becomes ready late", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-delayed-hook-")); roots.push(root)
    const required = line(20_000, "game 7 handover")
    const chunkId = "7:session:begin:1:0"
    const saved = {
      origins: [{ localStorage: [
        { name: GAME_LOG_OUTBOX_KEY, value: JSON.stringify({ chunkIds: [chunkId], delivered: [] }) },
        { name: `${GAME_LOG_OUTBOX_KEY}.chunk.${encodeURIComponent(chunkId)}`, value: JSON.stringify({ id: chunkId, gameIndex: 7, to: 20_000, lines: [required] }) },
      ] }],
    }
    const recorder = new BotRecorder({ evaluate: async () => pageExport([required]) } as unknown as Page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    recorder.recoverPersistedTelemetry(saved, "kill", 40_000)
    let attempts = 0
    recorder.rebind({
      evaluate: async () => {
        if (++attempts === 1) throw new Error("hook hydrating")
        return {
          json: pageExport([line(40_001, "replacement ready")]).json,
          records: [{ name: GAME_LOG_OUTBOX_KEY, value: JSON.stringify({ chunkIds: [], delivered: [{ kind: "chunk", id: chunkId }] }) }],
        }
      },
    } as unknown as Page)
    expect(await recorder.recoverReopenedTelemetry("reopen", 50)).toContain("misses 0 required")
    expect(attempts).toBe(2)
    const truth = recorder.telemetryGroundTruth(7, 2)
    expect(truth.unavailable).toBeUndefined()
    expect(truth.unpersistedAtKill).toBe(0)
  })

  it("reads pending browser outbox lines without requiring a browser-local debug ring", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-overlap-")); roots.push(root)
    const shared = line(2, "game 7 handover")
    const page = { evaluate: async () => pageExport([shared]) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("prekill")
    const storage = { origins: [{ origin: "http://localhost", localStorage: [
      { name: "jollity.telemetry.game-log-outbox.v1.chunk.1", value: JSON.stringify({ gameIndex: 7, to: 2, lines: [shared] }) },
    ] }] }
    expect(recorder.recoverPersistedTelemetry(storage, "kill", 10)).toContain("1 pending browser-outbox line(s)")
    expect(recorder.telemetryGroundTruth(7).lines).toEqual([expect.objectContaining({ message: "game 7 handover" })])
  })

  it("uses a pending page checkpoint as truth even when Sentry receives nothing after the fault", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-cutoff-")); roots.push(root)
    const entries = [line(1, "game 7 handover"), line(3, "post-fault line")]
    const page = { evaluate: async () => pageExport(entries, 3) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("post-fault")
    const truth = recorder.telemetryGroundTruth(7)
    expect(truth.truthCutoffAt).toBe(3)
    expect(truth.unavailable).toBeUndefined()
  })

  it("retains the healthy chest checkpoint sampled before settlement when the later export has no receipts", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-settled-cutoff-")); roots.push(root)
    const entries = [line(1, "game 7 handover"), line(3, "report boundary"), line(9, "chest boundary")]
    const values = new Map<string, string>([[GAME_LOG_OUTBOX_KEY, JSON.stringify({
      chunkIds: [],
      delivered: [
        {
          id: "game-7-report", beginId: "game-7", gameIndex: 7, sessionId: "session", account: null,
          deviceId: "device", seq: 1, part: 0, checkpoint: "report", capturedAt: 1, from: 1, to: 3,
        },
        {
          id: "game-7-chest", beginId: "game-7", gameIndex: 7, sessionId: "session", account: null,
          deviceId: "device", seq: 2, part: 0, checkpoint: "chest", capturedAt: 2, from: 4, to: 9,
        },
      ],
      settledGames: [],
      evicted: [],
    })]])
    const storage = {
      get length() { return values.size },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    } as Storage
    vi.stubGlobal("localStorage", storage)
    resetGameLogOutboxForTests()
    let reads = 0
    const records = () => [...values].map(([name, value]) => ({ name, value }))
    const page = {
      evaluate: async () => {
        if (reads++ === 0) return { ...pageRow("Seen earlier"), telemetryOutboxRecords: records() }
        return {
          probe: { url: "http://localhost/game", hook: "object" },
          json: JSON.stringify({ meta: {}, entries }),
          longTasks: [],
          records: records(),
        }
      },
      waitForTimeout: async () => {},
    } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.captureRecap(1000)
    settleGameLogOutbox(7)
    expect(JSON.parse(storage.getItem(GAME_LOG_OUTBOX_KEY)!).delivered).toEqual([])
    await recorder.exportDevLog()
    const truth = recorder.telemetryGroundTruth(7)
    expect(truth.truthCutoffAt).toBe(9)
    expect(truth.unavailable).toBeUndefined()
    resetGameLogOutboxForTests()
    vi.unstubAllGlobals()
  })

  it("fails closed when no page-owned checkpoint or send boundary was captured", async () => {
    const root = mkdtempSync(join(tmpdir(), "recorder-no-cutoff-")); roots.push(root)
    const entries = [line(1, "game 7 handover")]
    const page = { evaluate: async () => ({ json: JSON.stringify({ meta: {}, entries }), records: [] }) } as unknown as Page
    const recorder = new BotRecorder(page, 1, root, root)
    await recorder.snapshotDevLog("no-checkpoint")
    expect(recorder.telemetryGroundTruth(7).unavailable).toMatch(/no page-owned checkpoint\/send evidence/)
  })

  it("snapshots truth after the final flush checkpoint and before contexts close", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    const flush = source.indexOf("pages.map((p) => flushGameLog(p))")
    const postFlush = source.indexOf('snapshotDevLog("post-checkpoint-flush")')
    const close = source.indexOf("contexts.map((c) => c.close")
    expect(flush).toBeGreaterThan(-1)
    expect(postFlush).toBeGreaterThan(flush)
    expect(close).toBeGreaterThan(postFlush)
  })

  it("keeps the recorder sampler alive from play through settlement", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    const playFinally = source.indexOf("// on any failure too: what the bots saw and filed is the evidence")
    const settlement = source.indexOf('test("(d) settlement:', playFinally)
    const afterAll = source.indexOf("test.afterAll(async")
    const finalFlush = source.indexOf("pages.map((p) => flushGameLog(p))")
    const finalStop = source.indexOf("await r.stop()", afterAll)
    expect(playFinally).toBeGreaterThan(-1)
    expect(settlement).toBeGreaterThan(playFinally)
    expect(source.slice(playFinally, settlement)).not.toContain("await r.stop()")
    expect(finalStop).toBeGreaterThan(finalFlush)
  })

  it("preserves pre-kill evidence ordering and recovers storage before replacement boot", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    const retireStart = source.indexOf("async function collectRetirementEvidence")
    const retireEnd = source.indexOf("async function reopenPage", retireStart)
    const retire = source.slice(retireStart, retireEnd)
    expect(retire).toContain("readSeen(old, true)")
    expect(retire.indexOf("snapshotDevLog")).toBeGreaterThan(-1)
    expect(retire.indexOf("captureRelaunchStorage")).toBeGreaterThan(retire.indexOf("snapshotDevLog"))
    expect(retire.indexOf("await Promise.all(tasks)")).toBeGreaterThan(retire.indexOf("captureRelaunchStorage"))
    expect(retire.indexOf("await Promise.all(tasks)")).toBeGreaterThan(retire.indexOf("snapshotDevLog"))

    const reopenStart = retireEnd
    const reopenEnd = source.indexOf("async function relaunch", reopenStart)
    const reopen = source.slice(reopenStart, reopenEnd)
    expect(reopen.indexOf("recoverPersistedTelemetry")).toBeGreaterThan(-1)
    expect(reopen.indexOf("newContext(")).toBeGreaterThan(reopen.indexOf("recoverPersistedTelemetry"))
    expect(reopen).not.toContain("recoverReopenedTelemetry")
    expect(reopen.indexOf("queueReopenedTelemetryRecovery")).toBeGreaterThan(reopen.indexOf("bindReplacementPage"))
    expect(reopen.indexOf("queueReopenedTelemetryRecovery")).toBeLessThan(reopen.indexOf("settledHome"))
    const playFinally = source.indexOf("// on any failure too: what the bots saw and filed is the evidence")
    expect(source.indexOf('recoverPendingReopenedTelemetry("post-play")', playFinally)).toBeGreaterThan(playFinally)
    expect(source).toContain('recoverPendingReopenedTelemetry("after-all-fallback")')

    const hostCrashStart = source.indexOf("async function crashHost")
    const hostCrashEnd = source.indexOf("\n/** the role's own assertions", hostCrashStart)
    const hostCrash = source.slice(hostCrashStart, hostCrashEnd)
    expect(hostCrash.indexOf("collectRetirementEvidence")).toBeLessThan(hostCrash.indexOf("requestHostCrash"))
    expect(hostCrash).toContain("Math.min(2_000")
    expect(hostCrash.indexOf("beforeEvidence")).toBeLessThan(hostCrash.indexOf("gate?.hold()"))

    const t6Start = source.indexOf("async function freezeAndReopenAfterReport")
    const t6End = source.indexOf("\nasync function ", t6Start + 10)
    const t6 = source.slice(t6Start, t6End)
    expect(t6).toContain("readSeen(old, true)")
    expect(t6.indexOf('snapshotDevLog("T6-prepause")')).toBeGreaterThan(-1)
    expect(t6.indexOf("captureRelaunchStorage")).toBeGreaterThan(t6.indexOf('snapshotDevLog("T6-prepause")'))
    expect(t6).toContain("await proveNextOpenGameLogDelivery")
    expect(t6.indexOf("freezePageUntilCrash")).toBeGreaterThan(t6.indexOf("captureRelaunchStorage"))

    const reloadStart = source.indexOf("async function reloadAct")
    const reloadEnd = source.indexOf("async function hideAct", reloadStart)
    expect(source.slice(reloadStart, reloadEnd)).toContain("readSeen(page, true)")
  })

  it("does not count the Register click itself as T2 app progress", () => {
    const source = readFileSync(join(process.cwd(), "scripts/e2e-live/journey.pw.ts"), "utf8")
    const registerStart = source.indexOf("async function register")
    const registerEnd = source.indexOf('\ntest("(b) sign-up', registerStart)
    const register = source.slice(registerStart, registerEnd)
    const clickStart = register.indexOf("const tapped = await button.click")
    const homeStart = register.indexOf("const home = await readHome", clickStart)
    expect(register.slice(clickStart, homeStart)).not.toContain("telemetryProgressAtMs")
    expect(register).toContain('observeDevLogAt("signup", "sign-up broadcast for")')
    expect(register).toContain('home.registered === "true" || /You\'re in/.test(home.text)')
  })
})
