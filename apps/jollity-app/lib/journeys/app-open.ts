// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * journey.app-open — from boot to the home screen being ready.
 *
 * Opened lazily by its first step, dated at the page's navigation start, so
 * the host channel (lib/game-source.ts), the People genesis (lib/engine.ts)
 * and the silent permission check (lib/use-permission-gate.ts) each add their
 * step without knowing who came first. The gate ends it. Framework-free.
 */
import { storageTelemetry } from "../host/storage"
import { startSessionRecord } from "../telemetry/session-record"
import { pageResourceSample, previousSessionEnd, recoverInterruptedJourneys, startJourney, telemetryLive, type Attrs, type Journey, type Step } from "../telemetry"

export type AppOpenStep = "host.connect" | "host.identity" | "chain.genesis" | "permissions.check"
export type AppOpenOutcome = "ready" | "gate" | "no-source"

let journey: Journey<"app-open"> | null = null

function bootAt(): number {
  const origin = typeof performance !== "undefined" ? performance.timeOrigin : 0
  return origin > 0 ? Math.round(origin) : Date.now()
}

function current(): Journey<"app-open"> {
  if (!journey) {
    journey = startJourney("app-open", {}, { startedAt: bootAt() })
    notePreviousExit(journey)
  }
  return journey
}

/** The open journey is where the last session's ending is told: it reads the
 *  last-session record (lib/telemetry/session-record.ts), sends its one
 *  diagnostic verdict, and tags this journey `previous.exit`. */
function notePreviousExit(open: Journey<"app-open">): void {
  if (!telemetryLive()) return
  void startSessionRecord({
    record: previousSessionEnd,
    sample: pageResourceSample,
    recover: recoverInterruptedJourneys,
  })
    .then((diagnostic) => open.set({ "previous.exit": diagnostic.classification }))
    .catch(() => false)
}

export function appOpenStep(name: AppOpenStep, attrs?: Attrs): Step {
  return current().step(name, attrs)
}

export function noteAppOpenHost(info: { name: string; version: string } | null, readFailed = false): void {
  current().set({
    "host.app": info?.name || "unknown",
    "host.app_version": readFailed ? "version read failed" : info?.version || "host sent no version",
  })
}

export function endAppOpen(outcome: AppOpenOutcome, attrs?: Attrs): void {
  current().end(outcome, { ...storageTelemetry(), ...attrs })
}

/** The gate's decision, measured: no source, a granted player, or the gate. */
export async function runGateCheck(hasSource: boolean, check: () => Promise<boolean>): Promise<AppOpenOutcome> {
  if (!hasSource) {
    endAppOpen("no-source")
    return "no-source"
  }
  const step = appOpenStep("permissions.check")
  let granted = false
  try {
    granted = await check()
  } finally {
    step.end({ "permissions.granted": granted ? "true" : "false" })
  }
  const outcome: AppOpenOutcome = granted ? "ready" : "gate"
  endAppOpen(outcome)
  return outcome
}

/** The check the gate runs. The development skip
 *  (NEXT_PUBLIC_SKIP_PERMISSION_GATE) passes it without asking, so the open
 *  still ends "ready" and asks telemetry's grant like any player's: skipping
 *  the whole gate would leave the network signal closed, and lib/telemetry
 *  would hold every envelope of that session for good (#303). */
export function gateCheckFor(skip: boolean, check: () => Promise<boolean>): () => Promise<boolean> {
  return skip ? () => Promise.resolve(true) : check
}

export function resetAppOpenForTests(): void {
  journey = null
}
