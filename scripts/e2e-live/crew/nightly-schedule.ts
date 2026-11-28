// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export const NIGHTLY_TIME_ZONE = "Europe/Zurich"
export const NIGHTLY_WINDOW = "03:00–09:00 Europe/Zurich"

export type SuiteInvocation = { suiteId: string; classification: "manual" | "nightly" }

function zurichMinuteOfDay(now: Date): number {
  if (!Number.isFinite(now.getTime())) throw new Error("nightly clock must be a valid instant")
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: NIGHTLY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)
  const value = (type: "hour" | "minute"): number => {
    const parsed = Number(parts.find((part) => part.type === type)?.value)
    if (!Number.isInteger(parsed)) throw new Error(`nightly clock did not provide ${type}`)
    return parsed
  }
  return value("hour") * 60 + value("minute")
}

/** Scheduled work may start late, but never runs into daytime PreviewNet use. */
export function isZurichNightlyWindow(now: Date): boolean {
  const minute = zurichMinuteOfDay(now)
  return minute >= 3 * 60 && minute < 9 * 60
}

export function invocationFor(eventName: string | undefined, runId: number, now = new Date()): SuiteInvocation {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error("GITHUB_RUN_ID must be a positive whole number")
  if (eventName === "workflow_dispatch") return { suiteId: `manual-suite-run-${runId}`, classification: "manual" }
  if (eventName !== "schedule") throw new Error("unsupported complete-suite caller")
  if (!isZurichNightlyWindow(now)) throw new Error(`scheduled suite started outside ${NIGHTLY_WINDOW}`)
  return { suiteId: `nightly-suite-run-${runId}`, classification: "nightly" }
}
