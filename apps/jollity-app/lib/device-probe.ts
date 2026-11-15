// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The device probe: a short frame-time measure on the final countdown. It turns
 * low power mode on for a weak device, or when it cannot measure the device.
 * The result lives in memory only.
 */
import { useSyncExternalStore } from "react"
import { devLog } from "./debug/log-store"
import { setLowPower, type LowPowerReason } from "./low-power"
import { pageHidden, watchPageHidden } from "./page-lifecycle"
import { recordDistribution, setLowPowerTags } from "./telemetry"
import { percentile } from "./telemetry/util"

/** secondsToStart at which the probe mounts */
export const PROBE_AT_SECONDS = 20
export const PROBE_WARMUP_MS = 500
export const PROBE_MEASURE_MS = 2000
/** one verdict change per tile; longer than the 400 ms tile turn */
export const PROBE_TURN_MS = 600
export const PROBE_OPACITY = 0.005
/** the longest one sample may run; a browser that stops rAF ends the sample here */
export const PROBE_SAMPLE_LIMIT_MS = 4000
/** samples that may end on a hidden page, per page load, before low power comes on */
export const PROBE_MAX_ATTEMPTS = 3
/**
 * The verdict bands, on one sample's p95 frame time. Measured on real phones
 * (#522): a phone averaging ~47 fps read a p95 of exactly 50 ms and was
 * switched on that one sample, while the clearly weak phones read p95 83 ms
 * (avg ~30 fps) and p95 133 ms (avg ~23 fps). So a p95 below 45 ms is fine at
 * once, 60 ms and over is weak at once (both clear cases sit well above it),
 * and the band between asks for a second sample.
 */
export const PROBE_BORDERLINE_FROM_MS = 45
export const PROBE_WEAK_FROM_MS = 60
/**
 * The second sample of a borderline phone confirms weak above this line
 * (strict). Intended: a second sample between 50 and 60 ms switches to low
 * power, because that phone read borderline twice running; exactly 50 ms
 * clears it.
 */
export const PROBE_CONFIRM_ABOVE_MS = 50
/**
 * A STEADY CAP is not a weak device (#495). An iPhone at 5 % battery
 * runs iOS Low Power Mode, which caps web content at 30 fps: every frame is
 * ~33 ms, and a few drops on top push the p95 to ~59 ms, inside the borderline
 * band. That phone plays the game smoothly, so it keeps the full look. A
 * borderline sample is steady when all three hold:
 * - its median is within the cap's window (28 to 38 ms: a 30 Hz cadence, with
 *   jitter room), so a 60 fps phone with a spiky tail is not mistaken for it;
 * - at most 10 % of its frames are drops (45 ms or slower: a missed frame on
 *   top of the cap), so a phone that stutters often is still judged janky;
 * - its p95 is under the weak line (60 ms), so a clear weak sample (the Android
 *   phones that read a p95 of 83 to 267 ms) is never rescued by its median.
 * A steady sample still asks for the second sample (an OS cap and a weak phone
 * that tops out at 30 fps read alike on one sample): the phone is cleared when
 * the second sample is steady too (rule steady-cap) or fine, and a weak phone
 * that drops again is confirmed weak.
 */
export const PROBE_STEADY_MEDIAN_FROM_MS = 28
export const PROBE_STEADY_MEDIAN_TO_MS = 38
export const PROBE_STEADY_MAX_DROP_SHARE = 0.1
/** change it when the probe setup or the thresholds change */
export const PROBE_VERSION = 5

export interface ProbeSample {
  p95Ms: number
  medianMs: number
  frames: number
  /** a steady cadence at a cap (see PROBE_STEADY_*) */
  steady: boolean
}

/**
 * which rule decided: fine, steady-cap (a steady borderline sample, confirmed by a steady second one), weak (one clear sample), weak-confirmed (a borderline
 * sample and a second one strictly above 50 ms), borderline-fine (the second sample
 * cleared it), no-frames (a sample saw no frame deltas), no-verdict (the page hid
 * PROBE_MAX_ATTEMPTS times mid-sample). no-frames and no-verdict turn low power on.
 */
export type ProbeRule = "fine" | "steady-cap" | "weak" | "weak-confirmed" | "borderline-fine" | "no-frames" | "no-verdict"

export interface ProbeResult {
  /** the deciding (last) sample; null when no sample finished */
  p95Ms: number | null
  frames: number
  weak: boolean
  /** every sample taken, in order */
  samples: ProbeSample[]
  rule: ProbeRule
  /** samples that ended on a hidden page */
  attempts: number
}

/** where the probe ran: the dial, or the probe screen after it */
export type ProbeStage = "countdown" | "late"

/** what survives an unmount: the finished samples and the hidden attempts */
export interface ProbeProgress {
  samples: ProbeSample[]
  attempts: number
}

export type SampleBand = "fine" | "borderline" | "weak"

/** p95 and median of the frame deltas, and whether the cadence is a steady cap; undefined with no frames */
export function judge(deltas: readonly number[]): ProbeSample | undefined {
  const p95 = percentile(deltas, 0.95)
  const median = percentile(deltas, 0.5)
  if (p95 === undefined || median === undefined) return undefined
  const drops = deltas.filter((d) => d >= PROBE_BORDERLINE_FROM_MS).length
  const steady =
    p95 < PROBE_WEAK_FROM_MS &&
    median >= PROBE_STEADY_MEDIAN_FROM_MS &&
    median <= PROBE_STEADY_MEDIAN_TO_MS &&
    drops / deltas.length <= PROBE_STEADY_MAX_DROP_SHARE
  return { p95Ms: p95, medianMs: median, frames: deltas.length, steady }
}

export function bandOf(p95Ms: number): SampleBand {
  if (p95Ms >= PROBE_WEAK_FROM_MS) return "weak"
  return p95Ms >= PROBE_BORDERLINE_FROM_MS ? "borderline" : "fine"
}

/** the result for the samples so far; the second one confirms or clears a borderline first */
export function decide(samples: readonly ProbeSample[]): Omit<ProbeResult, "attempts"> | undefined {
  const [first, second] = samples
  if (!first) return undefined
  const done = (last: ProbeSample, weak: boolean, rule: ProbeRule): Omit<ProbeResult, "attempts"> => ({
    p95Ms: last.p95Ms,
    frames: last.frames,
    weak,
    samples: [...samples],
    rule,
  })
  const band = bandOf(first.p95Ms)
  if (band === "fine") return done(first, false, "fine")
  if (band === "weak") return done(first, true, "weak")
  // a steady first sample is still confirmed: an OS or app cap and a weak phone that tops out at
  // 30 fps look alike on one sample, and the weak one drops again on the second
  if (!second) return undefined
  if (second.steady || second.p95Ms <= PROBE_CONFIRM_ABOVE_MS)
    return done(second, false, first.steady && second.steady ? "steady-cap" : "borderline-fine")
  return done(second, true, "weak-confirmed")
}

/** the check could not measure the device: low power on, with the samples that finished */
export function abortedResult(samples: readonly ProbeSample[], rule: "no-frames" | "no-verdict"): Omit<ProbeResult, "attempts"> {
  const last = samples[samples.length - 1]
  return { p95Ms: last?.p95Ms ?? null, frames: last?.frames ?? 0, weak: true, samples: [...samples], rule }
}

/**
 * rAF frame deltas over `ms`; calls `done(null)` if the page hides, and the deltas so far
 * after `limitMs`. Returns the cancel.
 */
export function sampleFrames(ms: number, done: (deltas: number[] | null) => void, limitMs = PROBE_SAMPLE_LIMIT_MS): () => void {
  const deltas: number[] = []
  let start = -1
  let last = -1
  let raf = 0
  let limit: ReturnType<typeof setTimeout> | undefined
  let over = false
  let unwatch = () => {}

  const stop = (): boolean => {
    if (over) return false
    over = true
    if (raf) cancelAnimationFrame(raf)
    clearTimeout(limit)
    unwatch()
    return true
  }
  const finish = (result: number[] | null): void => {
    if (stop()) done(result)
  }
  const onFrame = (ts: number): void => {
    raf = 0
    if (pageHidden()) return finish(null)
    if (last >= 0) deltas.push(ts - last)
    else start = ts
    last = ts
    if (ts - start >= ms) return finish(deltas)
    raf = requestAnimationFrame(onFrame)
  }

  // a hidden page runs no frames, so the event must end the measure
  unwatch = watchPageHidden(() => finish(null))
  if (pageHidden()) finish(null)
  else {
    raf = requestAnimationFrame(onFrame)
    // a browser that stops rAF never reaches `ms` of frames
    limit = setTimeout(() => finish(deltas), limitMs)
  }
  return () => {
    stop()
  }
}

/**
 * The whole check, continued from `progress`: warm-up, a sample, and for a borderline
 * first sample a second warm-up and sample. A hidden page waits until it shows, and a
 * sample that the page ends is retried, up to PROBE_MAX_ATTEMPTS. Calls `done` once,
 * always with a verdict. The cancel reports nothing; `progress` keeps the finished
 * samples for the next run. Worst case 2 x (0.5 + 2) s on a visible page.
 */
export function runProbe(progress: ProbeProgress, done: (result: ProbeResult) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelSample = () => {}
  let unwatch = () => {}
  const finish = (result: Omit<ProbeResult, "attempts">): void => done({ ...result, attempts: progress.attempts })
  const next = (): void => {
    if (pageHidden()) {
      // the wait for the page to show is not an attempt
      unwatch = watchPageHidden(() => {}, () => {
        unwatch()
        next()
      })
      return
    }
    timer = setTimeout(() => {
      cancelSample = sampleFrames(PROBE_MEASURE_MS, (deltas) => {
        if (deltas === null) {
          progress.attempts += 1
          if (progress.attempts >= PROBE_MAX_ATTEMPTS) return finish(abortedResult(progress.samples, "no-verdict"))
          return next()
        }
        const sample = judge(deltas)
        if (!sample) return finish(abortedResult(progress.samples, "no-frames"))
        progress.samples.push(sample)
        const result = decide(progress.samples)
        if (result) finish(result)
        else next()
      })
    }, PROBE_WARMUP_MS)
  }
  next()
  return () => {
    clearTimeout(timer)
    cancelSample()
    unwatch()
  }
}

let result: ProbeResult | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** why a weak probe turned low power on */
function probeReason(rule: ProbeRule): LowPowerReason {
  if (rule === "weak-confirmed") return "probe-weak-confirmed"
  return rule === "no-frames" || rule === "no-verdict" ? "probe-no-verdict" : "probe-weak"
}

/** the one progress of this page load; an unmount keeps it for the next mount */
const progress: ProbeProgress = { samples: [], attempts: 0 }

/** runs the check from where the last mount left it, and applies its verdict. Returns the cancel. */
export function startProbe(stage: ProbeStage): () => void {
  return runProbe(progress, (next) => applyProbe(next, stage))
}

/** stores the result, logs it, turns low power mode on when weak, and sends the probe metrics */
export function applyProbe(next: ProbeResult, stage: ProbeStage): void {
  result = next
  for (const listener of listeners) listener()
  const list = next.samples
    .map((s, i) => `#${i + 1} p95 ${Math.round(s.p95Ms)} ms, median ${Math.round(s.medianMs)} ms, ${s.frames} frames`).join("; ")
  const mode = next.weak ? `low power on (${probeReason(next.rule)})` : "full mode kept"
  devLog("low-power", `device check (${stage}, ${next.attempts} hidden): ${list || "no sample"}; rule ${next.rule}, ${mode}`)
  setLowPowerTags({ probe: "done" })
  if (next.weak) setLowPower(true, probeReason(next.rule))
  // no sample, no frame time to send
  if (next.samples.length === 0) return
  // after the tag calls, so the points carry the final probe and lowpower tags
  const attrs = {
    "probe.version": String(PROBE_VERSION),
    "probe.borderline_from_ms": String(PROBE_BORDERLINE_FROM_MS),
    "probe.weak_from_ms": String(PROBE_WEAK_FROM_MS),
    "probe.rule": next.rule,
    "probe.stage": stage,
    "probe.attempts": String(next.attempts),
  }
  // one point per device: the deciding (last) sample, so count() and p95() stay one per device
  const decided = { ...attrs, "probe.samples": String(next.samples.length) }
  recordDistribution("ui.probe_frame_ms", next.p95Ms ?? 0, "millisecond", { stat: "p95", ...decided })
  // the median of the deciding sample under its own name, so ui.probe_frame_ms stays one point per device
  const median = next.samples[next.samples.length - 1]?.medianMs
  if (median !== undefined) recordDistribution("ui.probe_frame_median_ms", median, "millisecond", decided)
  recordDistribution("ui.probe_frames", next.frames, "none", decided)
  // the detail, under its own names, one point per sample
  next.samples.forEach((sample, i) => {
    const sampleAttrs = { ...decided, "probe.sample": String(i + 1) }
    recordDistribution("ui.probe_sample_ms", sample.p95Ms, "millisecond", { stat: "p95", ...sampleAttrs })
    recordDistribution("ui.probe_sample_frames", sample.frames, "none", sampleAttrs)
  })
}

export function getProbeResult(): ProbeResult | undefined {
  return result
}

const serverResult = () => undefined

export function useProbeResult(): ProbeResult | undefined {
  return useSyncExternalStore(subscribe, getProbeResult, serverResult)
}
