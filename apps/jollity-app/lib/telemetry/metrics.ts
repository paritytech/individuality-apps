// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE METRICS DOORWAY: Sentry's trace metrics (the `tracemetrics` dataset),
 * for numbers a dashboard aggregates — p95(value), avg(value) by metric.name.
 * Span attributes cannot do that (they arrive string-typed); a metric's VALUE
 * is a real number. Its attributes are strings, for filtering and grouping.
 *
 *  - Starts Sentry if nobody has, and is a no-op without it: the index's
 *    live rule (boot.ts `telemetryLive`).
 *  - Never throws.
 *  - The SDK adds user.id / user.name from the scope, never the scope's
 *    TAGS: the tags a dashboard filters on (scope-tags.ts SCOPE_TAGS) are
 *    copied onto every point here, from a snapshot read once per tag change.
 *    A tag nobody set is left out.
 *
 * DELIVERY (@sentry/core 11.x, metrics/internal.js and client.js): a point
 * goes into a per-client buffer, and the buffer becomes ONE `trace_metric`
 * envelope on a 5 s timer started by the first point after a flush, at 1000
 * points, on client.flush(), or when the page turns hidden (BrowserClient).
 * There is no per-name aggregation and no other cap. The envelope goes out
 * through client.sendEnvelope → the client's transport, which is init.ts's
 * retrying queue. Metrics use the same concurrent lane as events; only
 * QUEUE_CAP pressure displaces metrics before events. A webview
 * killed inside the SDK's five-second metric buffer can still lose the tail;
 * the SDK's own flush on hidden covers a backgrounded page.
 *
 * FLUSHING: `flushMetrics()` calls `Sentry.flush`, which flushes the whole
 * client (journeys, events), not just the metrics, so it is called only where
 * a page may be about to go: every hidden edge, the app going away and a
 * game's end (lib/journeys/game-trace.ts), right after a failure's log
 * (lib/telemetry/failures.ts), and a home screen that stays stuck
 * (lib/journeys/home-first-status.ts). Besides these, Sentry.flush is called
 * directly on pagehide (init.ts) and before a delivery-health snapshot
 * (health-event.ts).
 *
 * ONE UNIT PER NAME. Sentry's unit-typed aggregates filter by unit
 * (count(value,<name>,distribution,none) over millisecond points is 0), so a
 * name never changes unit.
 *
 * The catalogue of every metric name, unit and attribute is docs/metrics.md.
 */
import * as Sentry from "@sentry/react"
import { telemetryLive } from "./boot"
import { telemetryStarted } from "./init"
import { scopeTagAttrs } from "./scope-tags"

export type MetricAttrs = Record<string, string>
export type MetricUnit = "millisecond" | "second" | "percent" | "byte" | "none"

function attributes(attrs: MetricAttrs): MetricAttrs {
  return { ...scopeTagAttrs(), ...attrs }
}

/** The one guard every point goes through: a finite value, telemetry live,
 *  never a throw. */
function emit(value: number, send: (attributes: MetricAttrs) => void, attrs: MetricAttrs): void {
  try {
    if (!Number.isFinite(value) || !telemetryLive()) return
    send(attributes(attrs))
  } catch {
    /* never throws */
  }
}

/** one sample of a distribution (p50/p95/avg over its points) */
export function recordDistribution(name: string, value: number, unit: MetricUnit, attrs: MetricAttrs): void {
  emit(value, (attributes) => Sentry.metrics.distribution(name, value, { unit, attributes }), attrs)
}

/** a level at this moment */
export function recordGauge(name: string, value: number, unit: MetricUnit, attrs: MetricAttrs): void {
  emit(value, (attributes) => Sentry.metrics.gauge(name, value, { unit, attributes }), attrs)
}

/** `n` more of something */
export function recordCount(name: string, n: number, attrs: MetricAttrs): void {
  emit(n, (attributes) => Sentry.metrics.count(name, n, { attributes }), attrs)
}

/** Hand the buffered points (and everything else the client holds) to the
 *  transport now; they still wait while offline. Only where the page may be
 *  about to go (FLUSHING, in the header). */
export function flushMetrics(): void {
  try {
    if (!telemetryStarted()) return
    void Sentry.flush(2000).catch(() => false)
  } catch {
    /* never throws */
  }
}
