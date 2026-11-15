// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import { calculateSnapshot } from "@jollity/game-chain/game"

const captured = vi.hoisted(() => [] as Array<{ tag: string; message: string; data: Record<string, unknown> }>)
vi.mock("../debug/log-store", () => ({ devLog: (tag: string, message: string, data: Record<string, unknown>) => captured.push({ tag, message, data }), addDevLogSink: () => () => {} }))
vi.mock("@sentry/react", () => ({ withScope: () => {}, captureEvent: () => {} }))
vi.mock("./init", () => ({ expectDelivery: async () => false, takeAttachmentDropped: () => false, sendLogEnvelope: async () => false, takeLogRejected: () => false }))
vi.mock("../debug/flag", () => ({ DEBUG_LOGS: true, APP_VERSION: "a".repeat(64), BUILD_COMMIT: `jollity-build-commit:${"b".repeat(40)}` }))
vi.mock("../debug/session-id", () => ({ SESSION_ID: "00000000-0000-4000-8000-000000000001", newId: () => "a".repeat(32) }))
vi.mock("../chain-clock", () => ({ readChainClock: () => ({ offset: 0, block: 9999999 }) }))
import { captureReplayObservation } from "./replay-capture"
import { createReplayTurnObserver } from "./replay-turns"
import { ReplayReceiverObserver } from "./replay-receiver"
import { captureReplayClock } from "./replay-clock"
import { enqueueFullGameLog, GAME_LOG_OUTBOX_KEY, GAME_LOG_OUTBOX_MAX_BYTES, resetGameLogOutboxForTests } from "./game-log-outbox"

describe("twelve-turn replay capture budget", () => {
  it("keeps a realistic complete game compact including five changing receiver links", async () => {
    captured.length = 0
    const start = 1_792_411_200
    const timing = { gameDate: start, reportEnds: start + 210, rounds: 2, maxGroupSize: 6 }
    const members = Array.from({ length: 6 }, (_, i) => `5${String(i).repeat(47)}`)
    const roomKey = `g260:${members.join("_")}`
    const turns = createReplayTurnObserver(captureReplayObservation)
    const receiver = new ReplayReceiverObserver({ roomKey, selfId: members[0], meshGeneration: 1 }, (data) => captureReplayObservation("receiver-quality", data))
    for (let ms = 0; ms <= 151_000; ms += 500) {
      const snapshot = calculateSnapshot(start + ms / 1000, timing)
      const round = snapshot.kind === "round" ? snapshot.round : null
      turns.observe({ gameIndex: 260, timing, roomKey, meshRound: round, hostId: snapshot.kind === "round" ? members[snapshot.hostPosition] : null,
        clockReady: true, sourceClockReady: true, snapshot, sourceNowSeconds: start + ms / 1000, commitMonotonicMs: ms })
      if (ms % 3000 === 0 && round !== null) {
        const changed = Math.floor(ms / 15000) % 2 === 1
        receiver.observe(members.slice(1).map((id, index) => ({ id, quality: {
          at: start * 1000 + ms, link: index + 1, transportId: "selected-relay-pair", localType: "relay", remoteType: "srflx", protocol: "udp",
          inbound: { id: `inbound-${index}`, width: changed ? 320 : 640, height: changed ? 180 : 360, fps: changed ? 12 : 24,
            framesDecoded: ms / 1000 * 12, packetsReceived: ms / 1000 * 60, packetsLost: 0, framesDropped: 0, freezeCount: 0,
            jitterMs: 12, jitterBufferDelay: ms / 1000 * .2, jitterBufferEmittedCount: ms / 1000 * 12, totalDecodeTime: ms / 1000 * .03,
            codec: "H264", codecFmtp: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", decoderImplementation: "VideoToolbox", powerEfficientDecoder: true },
        } })), ms, false, 260, round, { startedMonotonicMs: ms - 10, completedMonotonicMs: ms, roundAtRequest: round, roundAtCompletion: round })
      }
      if (ms % 6000 === 0) {
        const state = { shownMs: 0, targetMs: 0, correcting: false, method: "none", peers: 5, window: null }
        captureReplayClock("clock-anchor", { engine: "chain", game: 260, window: { index: 260, from: start, until: start + 210 }, block: 9999999 + ms / 6000,
          chainMs: (start + ms / 1000) * 1000, previousChainMs: (start + ms / 1000 - 6) * 1000, previousReceiptDeviceMs: start * 1000 + ms - 6000,
          receipt: { deviceMs: start * 1000 + ms, wallMs: start * 1000 + ms, monotonicMs: ms, sampling: "sequential-callback-samples" },
          first: false, gapMs: 0, beforeOffsetMs: 0, afterOffsetMs: 0, decision: "held", reason: "held", after: state })
      }
    }
    turns.stop()
    const lines = captured.map((row, i) => ({ ts: start * 1000 + i, sessionId: "00000000-0000-4000-8000-000000000001", lineId: `00000000-0000-4000-8000-000000000001:${i}`, level: "info", ...row, data: JSON.stringify(row.data) }))
    const utf8 = new TextEncoder().encode(JSON.stringify(lines)).length
    const utf16Storage = JSON.stringify(lines).length * 2
    const largestPayload = Math.max(...captured.map((row) => new TextEncoder().encode(JSON.stringify(row.data)).length))
    const counts = Object.fromEntries([...new Set(captured.map((row) => row.message))].map((kind) => [kind, captured.filter((row) => row.message === kind).length]))
    const byKind = Object.fromEntries(Object.keys(counts).map((kind) => [kind, new TextEncoder().encode(JSON.stringify(lines.filter((row) => row.message === kind))).length]))
    process.stdout.write(`Replay twelve-turn fixture budget ${JSON.stringify({ counts, byKind, utf8, utf16Storage, largestPayload })}\n`)
    expect(largestPayload).toBeLessThan(4096)
    expect(utf16Storage).toBeLessThan(1024 * 1024)
    // A deliberately sizeable legacy-log fixture, not a claim about an actual
    // player's capture: 300 records with 300-character messages plus metadata.
    const legacy = Array.from({ length: 300 }, (_, i) => ({ ts: start * 1000 + i, sessionId: "old-page", version: "a".repeat(64), level: "info", tag: "rtc", message: "x".repeat(300) }))
    const baselineUtf8 = new TextEncoder().encode(JSON.stringify(legacy)).length
    const entries = [...legacy, ...lines.map((line) => ({ ...line, version: "a".repeat(64), data: JSON.parse(line.data) as unknown }))]
    const afterUtf8 = new TextEncoder().encode(JSON.stringify(entries)).length
    const stored = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      get length() { return stored.size }, key: (i: number) => [...stored.keys()][i] ?? null,
      getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key),
    })
    vi.stubEnv("NEXT_PUBLIC_TELEMETRY_LOGS", "1")
    resetGameLogOutboxForTests()
    try {
      // Both deliveries fail: the entire previous-game copy stays queued when
      // the current game's enriched copy arrives. Exercise actual packing/caps.
      for (const gameIndex of [259, 260]) await enqueueFullGameLog({ gameIndex, stage: "payoff", trace: null, filename: `game-${gameIndex}.json`,
        json: JSON.stringify({ meta: { gameIndex }, entries }), capturedAt: start * 1000 })
      const index = JSON.parse(stored.get(GAME_LOG_OUTBOX_KEY)!) as { evicted: unknown[]; fullCopies: unknown[] }
      const storedBytes = [...stored].reduce((sum, [key, value]) => sum + (key.length + value.length) * 2, 0)
      process.stdout.write(`Replay offline two-game budget ${JSON.stringify({ baselineUtf8, afterUtf8, storedBytes, limitBytes: GAME_LOG_OUTBOX_MAX_BYTES })}\n`)
      expect(index.evicted).toHaveLength(0)
      expect(index.fullCopies).toHaveLength(2)
      expect(storedBytes).toBeLessThan(GAME_LOG_OUTBOX_MAX_BYTES * .85)
    } finally {
      resetGameLogOutboxForTests()
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })
})
