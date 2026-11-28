// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  DEAD_BAND_MS,
  PEER_AGREE_MS,
  PEER_MIN,
  PEER_PING_MS,
  PEER_RTT_MAX_MS,
} from "../../apps/jollity-app/lib/clock-sync"
import type { SlotResult } from "./result"

export const CLOCK_CONVERGENCE_BOUND_MS = DEAD_BAND_MS + PEER_RTT_MAX_MS / 2
/** A group compares two independently sampled page clocks. Each may be one
 * convergence bound from the true median. The extra 100 ms covers the
 * cross-runner/page-evaluation observation spread: the exact-head Previewnet
 * proof measured 62.5 ms at worst, rounded up rather than hidden in the
 * product-derived per-clock bound. */
export const CLOCK_GROUP_MEASUREMENT_ALLOWANCE_MS = 100
export const CLOCK_GROUP_SPREAD_BOUND_MS = 2 * CLOCK_CONVERGENCE_BOUND_MS + CLOCK_GROUP_MEASUREMENT_ALLOWANCE_MS

/** The live proof deliberately imports #1060's constants. A product-rule
 * mutation therefore changes this contract instead of leaving a duplicated
 * harness model green. */
export const CLOCK_PROTOCOL = {
  peerPingMs: PEER_PING_MS,
  peerRttMaxMs: PEER_RTT_MAX_MS,
  peerMin: PEER_MIN,
  peerAgreeMs: PEER_AGREE_MS,
  deadBandMs: DEAD_BAND_MS,
  convergenceBoundMs: CLOCK_CONVERGENCE_BOUND_MS,
  groupMeasurementAllowanceMs: CLOCK_GROUP_MEASUREMENT_ALLOWANCE_MS,
  groupSpreadBoundMs: CLOCK_GROUP_SPREAD_BOUND_MS,
} as const

type ClockLine = NonNullable<SlotResult["appClockEvidence"]>["timeline"][number]

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null
const text = (value: unknown): string | null => typeof value === "string" ? value : null
const lines = (result: SlotResult, message: string): ClockLine[] =>
  result.appClockEvidence?.timeline.filter((line) => line.message === message) ?? []
const session = (line: ClockLine): string => line.sessionId ?? "<legacy>"
const succeeded = (line: ClockLine): boolean => line.data?.result === "applied" || line.data?.result === "dead-band"
const converged = (line: ClockLine): boolean => {
  const peers = number(line.data?.peers)
  const medianMs = number(line.data?.medianMs)
  const offsetMs = number(line.data?.offsetMs)
  return succeeded(line) && peers !== null && peers >= PEER_MIN && medianMs !== null && offsetMs !== null
    && Math.abs(offsetMs - medianMs) <= CLOCK_CONVERGENCE_BOUND_MS
}

/** Validate the payloads emitted by the real #1060 state machine. This is not
 * a second clock implementation: it checks the authored decisions retained in
 * the bot artifact and uses the product constants above as its rule source. */
export function clockEvidenceFailures(result: SlotResult): string[] {
  const evidence = result.appClockEvidence
  if (!evidence) return []
  // Results written before this proof schema remain gatherable. Current runs
  // always write both fields and are judged fail-closed below.
  if (!Array.isArray(evidence.samples) || !Array.isArray(evidence.timeline)) return []
  const failures: string[] = []
  const clockPersona = result.profile === "clock-wrong-then-corrected" || result.profile === "clock-ahead-then-corrected"
    || result.profile === "clock-step-while-hidden" || result.profile === "late-join-turn-5"
  if (evidence.turnEntries.length === 0) {
    if (clockPersona) failures.push("clock persona never reached turn-entry convergence evidence")
    return failures
  }
  if (evidence.toleranceMs !== CLOCK_CONVERGENCE_BOUND_MS)
    failures.push(`clock convergence bound is ${evidence.toleranceMs} ms, expected ${CLOCK_CONVERGENCE_BOUND_MS} ms (250 ms dead band + half the 1 s RTT cap)`)
  if (!evidence.samples.length) failures.push("clock has no persisted offset/method samples")

  const peerLines = lines(result, "clock peers")
  const peerDone = lines(result, "clock peer check done")
  const observedPeerQuorum = [...peerLines, ...peerDone].some((line) => (number(line.data?.peers) ?? 0) >= PEER_MIN)
  const successfulCompletion = (done: ClockLine): boolean => converged(done) && peerLines.some((line) =>
    succeeded(line) && session(line) === session(done) && line.data?.window === done.data?.window && line.ts <= done.ts)
  if ((clockPersona || observedPeerQuorum) && !peerLines.length) failures.push("clock has no peer verdict evidence")
  if ((clockPersona || observedPeerQuorum) && !peerDone.length) failures.push("clock has no completed peer-check evidence")
  for (const line of peerLines) {
    const peers = number(line.data?.peers)
    const resultName = text(line.data?.result)
    const agree = number(line.data?.agree)
    if ((resultName === "applied" || resultName === "dead-band") && (peers === null || peers < PEER_MIN))
      failures.push(`clock peer ${resultName} used fewer than ${PEER_MIN} peers`)
    if ((resultName === "applied" || resultName === "dead-band") && (agree === null || peers === null || 2 * agree <= peers))
      failures.push(`clock peer ${resultName} lacks a strict agreeing majority`)
  }

  for (const line of evidence.timeline) {
    if (line.message === "clock jumped") {
      const fromMs = number(line.data?.fromMs)
      const toMs = number(line.data?.toMs)
      if (fromMs !== null && toMs !== null && toMs < fromMs)
        failures.push(`clock moved backward in a ${String(line.data?.reason ?? "unknown")} jump`)
    }
    if (line.message === "clock correction") {
      const speed = line.data?.speed
      if (typeof speed === "number" && speed <= 0) failures.push(`clock correction used non-positive speed ${speed}`)
    }
  }

  const requiredWindow = result.profile === "clock-wrong-then-corrected" || result.profile === "clock-ahead-then-corrected" ? "pregame"
    : result.role.kind === "baseline" ? null // not evaluated: roles off
      : result.profile === "clock-step-while-hidden" ? "resume"
        : result.profile === "late-join-turn-5" ? "late"
          : null
  if (requiredWindow) {
    const opened = requiredWindow === "pregame" ? undefined : lines(result, "clock peer check").find((line) => line.data?.window === requiredWindow)
    const inWindow = (line: ClockLine) => line.data?.window === requiredWindow
      && (!opened || (session(line) === session(opened) && line.ts >= opened.ts))
    const verdict = peerLines.find((line) => inWindow(line) && succeeded(line))
    const done = peerDone.find((line) => inWindow(line) && succeeded(line)
      && (!verdict || (session(line) === session(verdict) && line.ts >= verdict.ts)))
    if (requiredWindow !== "pregame" && !opened) failures.push(`clock ${requiredWindow} peer check did not start`)
    if (!verdict) failures.push(`clock ${requiredWindow} peer check never reached an applied or dead-band verdict`)
    if (!done) failures.push(`clock ${requiredWindow} peer check did not complete successfully`)
    else {
      if (text(done.data?.method) === null) failures.push(`clock ${requiredWindow} peer check omitted clock.method evidence`)
      if (!converged(done)) failures.push(`clock ${requiredWindow} peer check did not finish within ${CLOCK_CONVERGENCE_BOUND_MS} ms of its peer median`)
      if (requiredWindow === "pregame") {
        const shownAtT0 = evidence.samples.find((sample) => sample.label === "turn-1")
        const medianMs = number(done.data?.medianMs)
        if (!shownAtT0) failures.push("clock persona has no displayed-offset sample at T-0")
        else if (medianMs === null || Math.abs(shownAtT0.offsetMs - medianMs) > CLOCK_CONVERGENCE_BOUND_MS)
          failures.push(`clock persona displayed offset at T-0 was not within ${CLOCK_CONVERGENCE_BOUND_MS} ms of its peer median`)
      }
    }
  } else if (observedPeerQuorum && !peerDone.some(successfulCompletion)) {
    // Incidental late windows may legitimately close after peers leave. A
    // non-persona still needs at least one successful peer proof, but every
    // incidental timer closure need not independently satisfy the persona rule.
    failures.push("clock has no successfully converged peer-check completion")
  }
  return failures
}
