// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** One immutable, already-scrubbed startup identity per page. Game capture
 * starts after app-open; keep this line outside the capped log buffers so
 * chunks and range-filtered full exports can retain its original provenance.
 * No storage, host, telemetry boot or replay-capture dependencies here. */
import { APP_VERSION } from "./flag"
import type { SinkEntry } from "./log-store"
import { SESSION_ID } from "./session-id"

export interface RetainedSessionLink {
  readonly ts: number
  readonly sessionId: string
  readonly lineId: string
  readonly version: string
  readonly level: SinkEntry["level"]
  readonly tag: string
  readonly message: string
  readonly data?: string
}

let retained: RetainedSessionLink | null = null

/** Called by the existing log sinks, including before a game is active. */
export function retainSessionLink(entry: SinkEntry): void {
  if (entry.tag !== "replay" || entry.message !== "session.link") return
  const data = entry.dataText()
  retained = Object.freeze({
    ts: entry.time,
    sessionId: SESSION_ID,
    lineId: `${SESSION_ID}:${entry.id}`,
    version: APP_VERSION,
    level: entry.level,
    tag: entry.tag,
    message: entry.message,
    ...(data === undefined ? {} : { data }),
  })
}

export function readSessionLink(): RetainedSessionLink | null {
  return retained
}

export function resetSessionLinkForTests(): void {
  retained = null
}
