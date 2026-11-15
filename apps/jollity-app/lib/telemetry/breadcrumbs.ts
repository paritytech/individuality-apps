// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The devLog sink that turns every log line into a breadcrumb: its tag as
 * the category, its level, its data as text. Sentry keeps the last 100 on
 * each event. A breadcrumb is context, never an event of its own.
 *
 * The sink's entry is already mnemonic-scrubbed (lib/debug/log-store.ts
 * scrubs once for every sink), so nothing here scrubs again.
 */
import * as Sentry from "@sentry/react"
import type { Breadcrumb } from "@sentry/react"
import { addDevLogSink, type SinkEntry } from "../debug/log-store"

const MAX_DATA_CHARS = 2_000

export function breadcrumbFor(entry: SinkEntry): Breadcrumb {
  const crumb: Breadcrumb = {
    category: entry.tag,
    level: entry.level === "warn" ? "warning" : entry.level,
    message: entry.message,
    timestamp: entry.time / 1000,
  }
  let text = entry.dataText()
  if (text !== undefined) {
    if (text.length > MAX_DATA_CHARS) text = `${text.slice(0, MAX_DATA_CHARS)}…[truncated]`
    crumb.data = { data: text }
  }
  return crumb
}

export function installBreadcrumbSink(): () => void {
  return addDevLogSink((entry) => {
    try {
      Sentry.addBreadcrumb(breadcrumbFor(entry))
    } catch {
      /* never throws */
    }
  })
}
