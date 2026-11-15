// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE SCOPE TAGS a metric point carries, read once per change.
 *
 * Sentry copies user.id / user.name onto a metric, never the scope's TAGS,
 * so metrics.ts copies the ones a dashboard splits by (SCOPE_TAGS) onto
 * every point. Reading them is `getScopeData()` on two scopes, a full copy
 * of each, so it is done once and kept: every tag the app sets goes through
 * `setScopeTags` (init.ts, index.ts), which drops the snapshot, and the next
 * point reads afresh. A leaf: it imports nothing of ours, so init, index and
 * metrics can all use it without a cycle.
 */
import * as Sentry from "@sentry/react"

/** scope tags every point carries, when set */
export const SCOPE_TAGS = [
  "product",
  "host.kind",
  "session.id",
  "env.source",
  "test.tag",
  "game.index",
  "device.os",
  "device.os_version",
  "device.model",
  "device.gpu",
  "device.engine",
  "device.engine_version",
  "host.app",
  "host.app_version",
  "host.session_id",
  "host.native_app_version",
  "host.app_build",
  "host.app_variant",
  "host.source_commit",
  "truapi.host_version",
  "truapi.core_version",
  "truapi.codec_version",
  "truapi.schema_version",
  "net.type",
  "net.effective",
  "lowpower",
  "lowpower.reason",
  "probe",
  // what the device says it can encode/decode for WebRTC (media-caps.ts, #627)
  "rtc.cap.h264.encode",
  "rtc.cap.h264.decode",
  "rtc.cap.h264_high.encode",
  "rtc.cap.h264_high.decode",
  "rtc.cap.vp8.encode",
  "rtc.cap.vp8.decode",
  "rtc.cap.vp9.encode",
  "rtc.cap.vp9.decode",
  "rtc.cap.av1.encode",
  "rtc.cap.av1.decode",
  "rtc.sps_tap",
] as const

let snapshot: Record<string, string> | null = null

/** Set scope tags (undefined removes one), and drop the snapshot. */
export function setScopeTags(tags: Record<string, string | undefined>): void {
  snapshot = null
  Sentry.setTags(tags)
}

/** For a writer that bypasses setScopeTags (a reset). */
export function invalidateScopeTags(): void {
  snapshot = null
}

/** The SCOPE_TAGS that are set, as strings. The caller must not mutate it. */
export function scopeTagAttrs(): Readonly<Record<string, string>> {
  if (snapshot) return snapshot
  const tags = { ...Sentry.getIsolationScope().getScopeData().tags, ...Sentry.getCurrentScope().getScopeData().tags }
  const out: Record<string, string> = {}
  for (const key of SCOPE_TAGS) {
    const value = tags[key]
    if (value !== undefined && value !== null && value !== "") out[key] = String(value)
  }
  snapshot = out
  return out
}
