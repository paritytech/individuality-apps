// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * STORE-CLOCK CALIBRATION IN THE WAITING ROOM (docs/time-and-clocks.md,
 * Rule 2). The store clock (lib/store-clock.ts) learns its acceptance margin
 * from the node's first `alreadyExpired`. Left to the game, that first
 * rejection lands on a real signalling statement, mid-connect. So once the
 * player is signed up (the pallet grants the statement allowance on
 * `sign_up`), the waiting room submits ONE calibration statement on the
 * player's own channel (statement-core `calibrateStoreClock`), and in-game
 * signalling starts on the margin it learned.
 *
 *  - Home (the waiting room) calls `useStoreCalibration` while registered.
 *  - The game session waits for it before the mesh opens
 *    (`useCalibratedSignalling`), at most CALIBRATION_WAIT_MS: on the usual
 *    path it finished minutes ago, and on a LATE JOIN (no waiting room) this
 *    is where it runs.
 *  - It cannot finish (no allowance yet, offline, a timeout): the transport's
 *    one-shot re-stamp stays the fallback, and a later call may try again
 *    after RETRY_AFTER_MS.
 */
import { useEffect, useState } from "react"
import {
  calibrateStoreClock,
  calibrationLabels,
  type CreateTransport,
  type ResolveStore,
  type StoreCalibration,
} from "@jollity/statement-core"
import { devLog } from "./debug/log-store"
import { describeError } from "./host/error-detail"
import { storeClock } from "./store-clock"
import { storeCalibrated } from "./journeys/game-trace"
import { observeLegacyDecision } from "./webrtc/legacy-decision-capture"

/** the longest the mesh waits on a calibration still running */
export const CALIBRATION_WAIT_MS = 6_000
/** a calibration still unanswered after this long is a failure (a store that
 *  never resolves, a host that never answers): kept for RETRY_AFTER_MS, then
 *  tried again. Over the sign + submit timeouts of both stamps. */
export const CALIBRATION_TIMEOUT_MS = 45_000
/** a calibration that failed may be tried again after this long */
const RETRY_AFTER_MS = 30_000

export type Calibrate = () => Promise<StoreCalibration>

export interface StoreCalibrationState {
  status: "idle" | "running" | "succeeded" | "failed"
  failedAtMs: number | null
}

export type StoreCalibrationInput =
  | { type: "request"; nowMs: number }
  | { type: "settled"; nowMs: number; outcome: StoreCalibration["outcome"] }

export type StoreCalibrationCommand = { type: "start" }

export function createStoreCalibrationState(): StoreCalibrationState {
  return { status: "idle", failedAtMs: null }
}

/** Pure coordinator for retained calibration attempts. The host below owns
 * the promise and turns its completion into a settled event. */
export function storeCalibrationStep(
  state: StoreCalibrationState,
  event: StoreCalibrationInput,
): { state: StoreCalibrationState; commands: StoreCalibrationCommand[] } {
  if (event.type === "request") {
    if (
      state.status === "idle"
      || (state.status === "failed"
        && state.failedAtMs !== null
        && event.nowMs - state.failedAtMs >= RETRY_AFTER_MS)
    ) {
      return { state: { status: "running", failedAtMs: null }, commands: [{ type: "start" }] }
    }
    return { state: { ...state }, commands: [] }
  }
  if (state.status !== "running") return { state: { ...state }, commands: [] }
  return event.outcome === "failed"
    ? { state: { status: "failed", failedAtMs: event.nowMs }, commands: [] }
    : { state: { status: "succeeded", failedAtMs: null }, commands: [] }
}

/**
 * The page's calibration over `resolveStore`, run at most once at a time and
 * kept once it settled (accepted, learned, or rejected on both stamps). A
 * failure is kept for RETRY_AFTER_MS, then a call tries again.
 */
export function storeCalibrator(options: {
  resolveStore: ResolveStore
  namespace: string
  id: string
  labelPrefix?: string
  /** told of every finished run (default: the game trace) */
  onResult?: (result: StoreCalibration) => void
  now?: () => number
}): Calibrate {
  const now = options.now ?? (() => Date.now())
  const tell = options.onResult ?? storeCalibrated
  let run: Promise<StoreCalibration> | null = null
  let state = createStoreCalibrationState()
  const attempt = async (started: number): Promise<StoreCalibration> => {
    const store = await options.resolveStore().catch((error: unknown) => {
      devLog("statement", "calibration could not resolve the statement store", { detail: describeError(error) }, "warn")
      return null
    })
    return store
      ? await calibrateStoreClock({
          store,
          clock: storeClock(),
          labels: calibrationLabels(options.namespace, options.id, options.labelPrefix),
        })
      : { outcome: "failed", marginMs: storeClock().marginMs(), durationMs: now() - started, attempts: 0, reason: "no statement store" }
  }
  const once = async (): Promise<StoreCalibration> => {
    const started = now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<StoreCalibration>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            outcome: "failed",
            marginMs: storeClock().marginMs(),
            durationMs: now() - started,
            attempts: 0,
            reason: "calibration timeout",
          }),
        CALIBRATION_TIMEOUT_MS,
      )
    })
    const result = await Promise.race([attempt(started), timedOut]).finally(() => clearTimeout(timer))
    state = storeCalibrationStep(state, { type: "settled", nowMs: now(), outcome: result.outcome }).state
    tell(result)
    return result
  }
  return () => {
    const result = storeCalibrationStep(state, { type: "request", nowMs: now() })
    state = result.state
    if (result.commands.some((command) => command.type === "start")) run = once()
    if (!run) throw new Error("calibration state has no retained run")
    return run
  }
}

/** The waiting room: calibrate while `wanted` (the player is signed up). */
export function useStoreCalibration(calibrate: Calibrate | undefined, wanted: boolean): void {
  useEffect(() => {
    if (!calibrate || !wanted) return
    void calibrate()
  }, [calibrate, wanted])
}

/**
 * The signalling transport, held back until the calibration settled or
 * CALIBRATION_WAIT_MS passed, so the mesh's first statement goes out on the
 * learned margin. No calibration: at once.
 */
export function useCalibratedSignalling(
  signalling: CreateTransport | undefined,
  calibrate: Calibrate | undefined,
): CreateTransport | undefined {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!signalling) return
    if (!calibrate) {
      observeLegacyDecision({
        kind: "calibration-release",
        at: performance.now(),
        event: "signalling-released",
        decision: "release",
        landingState: "ready",
        calibrationRelease: { reason: "no-calibrator" },
      })
      return
    }
    let live = true
    let released = false
    const release = (reason: "settled" | "timeout") => {
      if (!live || released) return
      released = true
      observeLegacyDecision({
        kind: "calibration-release",
        at: performance.now(),
        event: "signalling-released",
        decision: "release",
        landingState: "ready",
        calibrationRelease: { reason },
      })
      setReady(true)
    }
    const timer = setTimeout(() => release("timeout"), CALIBRATION_WAIT_MS)
    void calibrate()
      .catch(() => undefined)
      .then(() => release("settled"))
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [signalling, calibrate])
  return !calibrate || ready ? signalling : undefined
}
