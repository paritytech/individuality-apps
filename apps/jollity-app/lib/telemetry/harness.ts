// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE LIVE E2E BOTS' READ-ONLY HOOK, `window.__jollityHarness`. A scripted
 * player reads the page's own logs and measurements through it before the
 * page closes, so a run that fails early still leaves its evidence.
 *
 * Two locks keep it off real players' pages:
 *  - only a development build or a previewnet build (NEXT_PUBLIC_E2E_HARNESS,
 *    deploy.yml) imports this module at all (components/debug/debug-boot.tsx);
 *  - even there it installs only in development, or on a page whose test tag
 *    (NEXT_PUBLIC_SENTRY_TAG) is set. A deploy bakes the tag empty, and a test
 *    runner sets it in the copy of the bundle it serves to its own browser.
 *
 * Every method reads; none changes what the app does, except flushGameLog,
 * which sends the game log early (once, as the payoff would).
 */
import { buildLogsExport } from "../debug/telemetry"
import { devLog } from "../debug/log-store"
import { getClockSnapshot } from "../debug/clock"
import { chainNowMs, readChainClock } from "../chain-clock"
import { getHealthSnapshot } from "../health/snapshot"
import { getLowPower, getLowPowerReason } from "../low-power"
import { sendAdaptationSnapshot, type SendAdaptationSnapshot } from "../webrtc/send-adaptation-driver"
import { flushGameLog, type GameLogFlush } from "./index"
import { gameLogTailDurable, gameLogTailState, type GameLogTailState } from "./game-log-outbox"
import { configFromEnvironment } from "./init"
import { longTaskSnapshot, type LongTaskRecord } from "./smoothness"

export const HARNESS_HOOK = "__jollityHarness"

export interface HarnessHook {
  /** The manual export's JSON (lib/debug/telemetry.ts): every line this page holds. */
  exportLogs(): Promise<string>
  /** The page's longest main-thread stalls, the numbers behind ui.long_task_ms. */
  smoothness(): LongTaskRecord[]
  /** The last handed-over game's log to Sentry now, unless it already went. */
  flushGameLog(): Promise<GameLogFlush>
  /** Whether the current game-log tail is saved. Never persists, seals or sends. */
  gameLogTailDurable(): boolean
  gameLogTailState(): GameLogTailState
  sendAdaptation(): SendAdaptationSnapshot & { lowPower: boolean; lowPowerReason: string }
  /** The chain clock the game's state machine runs on (GameSource.nowSeconds),
   *  or null before it has a chain anchor. */
  gameClock(): {
    nowMs: number
    nowSeconds: number
    offset: number
    block: number | null
    sync: { offsetMs: number; method: string; peers: number } | null
  } | null
  /** A line in this page's debug log, so a runner's own steps sit in the same export. */
  devLog(tag: string, message: string): void
  mesh(): { turnServers: number; peers: number } | null
}

/** A development build, or a page whose test tag is set. The tag is read at
 *  runtime from the telemetry config (its `testTag:""` literal is the one a
 *  runner rewrites in the bytes it serves), never compared at build time,
 *  which would fold to false. It is read even without a DSN; that read does
 *  not turn telemetry on. */
export function harnessEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === "development" || (configFromEnvironment({ allowHarnessOnly: true })?.testTag ?? "") !== ""
}

export function installHarnessHook(
  target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  enabled = harnessEnabled(),
): void {
  if (!enabled) return
  const hook: HarnessHook = {
    exportLogs: async () => (await buildLogsExport()).json,
    smoothness: longTaskSnapshot,
    flushGameLog,
    gameLogTailDurable,
    gameLogTailState: () => gameLogTailState(),
    sendAdaptation: () => ({ ...sendAdaptationSnapshot(), lowPower: getLowPower(), lowPowerReason: getLowPowerReason() }),
    gameClock: () => {
      const nowMs = chainNowMs()
      const clock = readChainClock()
      const sync = getClockSnapshot()
      return nowMs === null || clock === null ? null : {
        nowMs,
        nowSeconds: Math.floor(nowMs / 1000),
        ...clock,
        sync: sync ? { offsetMs: sync.offsetMs, method: sync.method, peers: sync.peers } : null,
      }
    },
    devLog: (tag, message) => devLog(tag, message),
    mesh: () => {
      const snapshot = getHealthSnapshot()
      return snapshot ? { turnServers: snapshot.turnServers, peers: snapshot.peers.length } : null
    },
  }
  target[HARNESS_HOOK] = Object.freeze(hook)
}
