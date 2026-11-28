// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LAUNCH SOURCE: what opened this page. A cold start carries no provenance in
 * the navigation entry alone, so the page reads the host's bootstrap
 * (`__trinityHostTelemetry.openSource`, set by the native host before the
 * product's first script) and the URL it was loaded with (a reminder
 * notification carries `jollity-notification=reminder`, a deep link any other
 * query). One source wins, in that order; the detail keeps the notification
 * moment or the deep-link route. Recorded once, on the session.link
 * observation, as string attributes (Sentry span attributes are string-typed).
 *
 * The launch URL is captured at module load: FrontDoor
 * (components/front-door.tsx) sends a held load home with router.replace in
 * an effect, and any client module evaluates before those effects run, so by
 * the time the session record reads the location the original one is gone.
 * Only a navigation of type "navigate" classifies the URL: a reload carries
 * the app's own queries (?game=N, ?lowpower=1) and is not a deep link.
 */

import { NOTIFICATION_MOMENTS, NOTIFICATION_PARAM, REMINDER_VALUE, MOMENT_PARAM } from "./notification-url"

export type LaunchSource = "notification" | "deeplink" | "unknown"

let launchUrl: { search: string; pathname: string } | null = null

/** Capture the location this page was loaded with. Runs once at module load;
 *  exported so a test can re-run it against a stubbed window. */
export function captureLaunchLocation(): void {
  try {
    if (typeof window === "undefined" || !window.location) {
      launchUrl = null
      return
    }
    launchUrl = { search: window.location.search, pathname: window.location.pathname }
  } catch {
    launchUrl = null
  }
}

captureLaunchLocation()

export interface LaunchSourceReading {
  source: LaunchSource
  /** the notification moment or the deep-link route, when present */
  detail: string | null
}

/** Host open sources this build knows; anything else maps to host-other. */
const HOST_OPEN_SOURCES = {
  alarm: "notification",
  notification: "notification",
  deeplink: "deeplink",
} as const

/** An open older than this is a stale value, not the open this page load answers. */
const MAX_OPEN_AGE_MS = 5 * 60 * 1000

/** Every literal this module can send as an attribute value, for the masking
 *  lane test: the source words, the known host open sources, the fallback
 *  details and the notification moments. */
export const LAUNCH_SOURCE_LITERALS = [
  "notification",
  "deeplink",
  "unknown",
  ...Object.keys(HOST_OPEN_SOURCES),
  "host-other",
  "other",
  "reload",
  ...NOTIFICATION_MOMENTS,
] as const

/** Read the host's open claim from its bootstrap. The session id is not needed
 *  here, so a bootstrap without a valid one still counts as a host open when
 *  its open fields are fresh. */
function hostOpen(root: typeof globalThis, now: number): LaunchSourceReading | null {
  try {
    const value = (root as typeof globalThis & { __trinityHostTelemetry?: unknown }).__trinityHostTelemetry
    if (!value || typeof value !== "object") return null
    const bootstrap = value as Record<string, unknown>
    const openSource = bootstrap.openSource
    if (typeof openSource !== "string" || openSource === "") return null
    const openedAt = bootstrap.openedAtEpochMs
    // no timestamp means no proof of freshness: a bootstrap that never reported
    // one is stale, so a later reload does not count as the same open again
    if (typeof openedAt !== "number" || !Number.isFinite(openedAt) || openedAt > now || now - openedAt >= MAX_OPEN_AGE_MS) return null
    const mapped = (HOST_OPEN_SOURCES as Record<string, LaunchSource>)[openSource]
    if (mapped === "notification") return { source: "notification", detail: openSource }
    if (mapped) return { source: mapped, detail: null }
    // a host open with an unknown source is still a host open, not an icon tap;
    // keep the detail to the known vocabulary so no host free text is sent
    return { source: "unknown", detail: "host-other" }
  } catch {
    return null
  }
}

function urlLaunch(search: string | undefined, pathname: string | undefined, navigationType: string | null): LaunchSourceReading | null {
  if (!search) return null
  // only a fresh navigation classifies the URL: a reload, back/forward or
  // prerender carries the app's own queries (?game=N, ?lowpower=1) and is
  // not a deep link, however it was opened. A browser that reports no
  // navigation type leaves the URL unclassified rather than calling it a
  // reload.
  if (navigationType !== "navigate") {
    return navigationType === null ? null : { source: "unknown", detail: "reload" }
  }
  const params = new URLSearchParams(search)
  if (params.get(NOTIFICATION_PARAM) === REMINDER_VALUE) {
    const moment = params.get(MOMENT_PARAM)
    // keep the detail to the known vocabulary so no URL free text is sent
    return { source: "notification", detail: moment !== null && NOTIFICATION_MOMENTS.has(moment) ? moment : moment ? "other" : null }
  }
  // any other query on the launch URL is a deep link
  return { source: "deeplink", detail: pathname && pathname !== "/" ? pathname : null }
}

/** The navigation entry's type, when the browser reports one. */
function navigationTypeOf(root: typeof globalThis): string | null {
  try {
    const perf = (root as typeof globalThis & { performance?: Performance }).performance
    if (!perf || typeof perf.getEntriesByType !== "function") return null
    const entry = perf.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
    return typeof entry?.type === "string" ? entry.type : null
  } catch {
    return null
  }
}

/** Classify one page start. Pure over its inputs so a test can drive every
 *  source; with no inputs it reads what was captured at module load. */
export function readLaunchSource(options: {
  root?: typeof globalThis
  now?: number
  search?: string
  pathname?: string
  navigationType?: string | null
}): LaunchSourceReading {
  const root = options.root ?? globalThis
  const now = options.now ?? Date.now()
  const captured = launchUrl ?? undefined
  const search = options.search ?? captured?.search
  const pathname = options.pathname ?? captured?.pathname
  const navigationType = options.navigationType !== undefined ? options.navigationType : navigationTypeOf(root)
  return hostOpen(root, now) ?? urlLaunch(search, pathname, navigationType) ?? { source: "unknown", detail: null }
}
