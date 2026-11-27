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
 */

export type LaunchSource = "notification" | "deeplink" | "app-icon" | "unknown"

export interface LaunchSourceReading {
  source: LaunchSource
  /** the notification moment or the deep-link route, when present */
  detail: string | null
}

/** Host open sources this build knows; anything else maps to `other`. */
const HOST_OPEN_SOURCES = {
  alarm: "notification",
  notification: "notification",
  deeplink: "deeplink",
} as const

const NOTIFICATION_PARAM = "jollity-notification"
const REMINDER_VALUE = "reminder"
const MOMENT_PARAM = "moment"

/** An open older than this is a stale value, not the open this page load answers. */
const MAX_OPEN_AGE_MS = 5 * 60 * 1000

interface HostBootstrapLike {
  openSource?: unknown
  openedAtEpochMs?: unknown
}

/** Read the host's open claim from its bootstrap. The session id is not needed
 *  here, so a bootstrap without a valid one still counts as a host open when
 *  its open fields are fresh. */
function hostOpen(root: typeof globalThis, now: number): { source: string; } | null {
  try {
    const value = (root as typeof globalThis & { __trinityHostTelemetry?: unknown }).__trinityHostTelemetry
    if (!value || typeof value !== "object") return null
    const bootstrap = value as HostBootstrapLike
    if (typeof bootstrap.openSource !== "string" || bootstrap.openSource === "") return null
    if (typeof bootstrap.openedAtEpochMs === "number" && Number.isFinite(bootstrap.openedAtEpochMs)) {
      if (bootstrap.openedAtEpochMs > now || now - bootstrap.openedAtEpochMs >= MAX_OPEN_AGE_MS) return null
    }
    return { source: bootstrap.openSource }
  } catch {
    return null
  }
}

function urlLaunch(search: string | undefined, pathname: string | undefined): LaunchSourceReading | null {
  try {
    if (typeof search !== "string" || search === "") return null
    const params = new URLSearchParams(search)
    if (params.get(NOTIFICATION_PARAM) === REMINDER_VALUE) {
      const moment = params.get(MOMENT_PARAM)
      return { source: "notification", detail: moment && moment !== "" ? moment : null }
    }
    // any other query on the launch URL is a deep link
    return { source: "deeplink", detail: typeof pathname === "string" && pathname !== "/" ? pathname : null }
  } catch {
    return null
  }
}

/** Classify one page start. Pure over its inputs so a test can drive every source. */
export function readLaunchSource(options: {
  root?: typeof globalThis
  now?: number
  search?: string
  pathname?: string
}): LaunchSourceReading {
  const root = options.root ?? globalThis
  const now = options.now ?? Date.now()
  const host = hostOpen(root, now)
  if (host) {
    const mapped = (HOST_OPEN_SOURCES as Record<string, LaunchSource>)[host.source] ?? null
    if (mapped === "notification") return { source: "notification", detail: host.source === "alarm" ? "alarm" : host.source }
    if (mapped) return { source: mapped, detail: null }
    // a host open with an unknown source is still a host open, not an icon tap;
    // keep the detail to the known vocabulary so no host free text is sent
    return { source: "unknown", detail: "host-other" }
  }
  const fromUrl = urlLaunch(options.search, options.pathname)
  if (fromUrl) return fromUrl
  return { source: "unknown", detail: null }
}
