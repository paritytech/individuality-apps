// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Label } from "../core/labels"
import type { Finding } from "../core/search"
import type { LivenessResult } from "./room"

export interface LivenessBoundCheck {
  kind: "liveness-bound"
  boundS: number
}

export type LivenessBoundFinding = Finding & { check: LivenessBoundCheck }

/**
 * L1's tally over a run (`--liveness`): counts, costs, and the leaf that
 * needed the most fake time, so a run states a recovery bound K per anchor.
 * With `boundS` (`--liveness-bound-s`), a leaf that is steady only after more
 * than that many fake seconds is an L1 finding.
 */
export interface LivenessTally {
  every: number
  checked: number
  steady: number
  stuck: number
  harness: number
  drainSteps: number
  fakeMs: number
  realMs: number
  maxRealMs: number
  maxDrainSteps: number
  maxFakeMs: number
  /** the leaf (past the anchor's warmup) that was steady only after the most fake time */
  worst?: { fakeMs: number; steps: number; labels: Label[] }
}

export function newTally(every: number): LivenessTally {
  return { every, checked: 0, steady: 0, stuck: 0, harness: 0, drainSteps: 0, fakeMs: 0, realMs: 0, maxRealMs: 0, maxDrainSteps: 0, maxFakeMs: 0 }
}

/** the typed "recovered too late" finding for a steady leaf past `boundS` */
export function livenessBoundFinding(result: Pick<LivenessResult, "steady" | "ms">, labels: readonly Label[], boundS: number): LivenessBoundFinding | undefined {
  if (!result.steady || result.ms <= boundS * 1000) return undefined
  return {
    property: "L1",
    labels: [...labels],
    atStep: labels.length - 1,
    detail: `recovered after ${Math.ceil(result.ms / 100) / 10} s, bound ${boundS} s`,
    sampled: false,
    check: { kind: "liveness-bound", boundS },
  }
}

/** counts one checked leaf; returns the "recovered too late" finding when `boundS` is set and exceeded */
export function recordLeaf(tally: LivenessTally, result: Pick<LivenessResult, "steady" | "ms" | "steps">, labels: readonly Label[], boundS?: number): Finding | undefined {
  tally.checked++
  tally.drainSteps += result.steps
  tally.fakeMs += result.ms
  if (!result.steady) {
    tally.stuck++
    return undefined
  }
  tally.steady++
  tally.maxDrainSteps = Math.max(tally.maxDrainSteps, result.steps)
  if (tally.worst === undefined || result.ms > tally.worst.fakeMs) tally.worst = { fakeMs: result.ms, steps: result.steps, labels: [...labels] }
  tally.maxFakeMs = Math.max(tally.maxFakeMs, result.ms)
  return boundS === undefined ? undefined : livenessBoundFinding(result, labels, boundS)
}

export function livenessSummary(l: LivenessTally) {
  const per = (total: number) => (l.checked === 0 ? 0 : Math.round((total / l.checked) * 10) / 10)
  return {
    every: l.every,
    checked: l.checked,
    steady: l.steady,
    stuck: l.stuck,
    harness: l.harness,
    meanDrainSteps: per(l.drainSteps),
    meanFakeS: per(l.fakeMs / 1000),
    maxDrainSteps: l.maxDrainSteps,
    maxFakeS: Math.round(l.maxFakeMs / 100) / 10,
    ...(l.worst ? { worst: { fakeMs: l.worst.fakeMs, fakeS: Math.round(l.worst.fakeMs / 100) / 10, steps: l.worst.steps, labels: l.worst.labels } } : {}),
    meanRealMs: per(l.realMs),
    maxRealMs: Math.round(l.maxRealMs),
    totalRealS: Math.round(l.realMs / 100) / 10,
  }
}

type Summary = ReturnType<typeof livenessSummary>

/** shard summaries added up: counts add, maxima and the worst path take the largest */
export function mergeLivenessSummaries(parts: readonly Summary[]): Summary {
  const sum = (pick: (part: Summary) => number) => parts.reduce((total, part) => total + pick(part), 0)
  const checked = sum((part) => part.checked)
  const mean = (pick: (part: Summary) => number) => (checked === 0 ? 0 : Math.round((parts.reduce((total, part) => total + pick(part) * part.checked, 0) / checked) * 10) / 10)
  type Worst = NonNullable<Summary["worst"]>
  const rawFakeMs = (worst: Worst) => (worst as Worst & { fakeMs?: number }).fakeMs ?? worst.fakeS * 1000
  const pathKey = (labels: readonly Label[]) => JSON.stringify(labels)
  const worst = parts.map((part) => part.worst).filter((candidate): candidate is Worst => candidate !== undefined).reduce<Summary["worst"]>((best, candidate) => {
    if (best === undefined) return candidate
    if (rawFakeMs(candidate) !== rawFakeMs(best)) return rawFakeMs(candidate) > rawFakeMs(best) ? candidate : best
    const pathOrder = pathKey(candidate.labels).localeCompare(pathKey(best.labels))
    if (pathOrder !== 0) return pathOrder < 0 ? candidate : best
    return candidate.steps < best.steps ? candidate : best
  }, undefined)
  return {
    every: parts[0]!.every,
    checked,
    steady: sum((part) => part.steady),
    stuck: sum((part) => part.stuck),
    harness: sum((part) => part.harness),
    meanDrainSteps: mean((part) => part.meanDrainSteps),
    meanFakeS: mean((part) => part.meanFakeS),
    maxDrainSteps: Math.max(...parts.map((part) => part.maxDrainSteps)),
    maxFakeS: Math.max(...parts.map((part) => part.maxFakeS)),
    ...(worst ? { worst } : {}),
    meanRealMs: mean((part) => part.meanRealMs),
    maxRealMs: Math.max(...parts.map((part) => part.maxRealMs)),
    totalRealS: Math.round(sum((part) => part.totalRealS) * 10) / 10,
  }
}
