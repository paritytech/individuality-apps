// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * NETWORK CHANGES DURING THE GAME: the page going offline and online, and the
 * connection's type changing (Wi-Fi to cellular), told as one stream of
 * `NetChange`. A Wi-Fi to cellular switch drops WebRTC links, and a dropped
 * link can only be matched to its cause if the change is on the same
 * timeline: lib/journeys/game-trace.ts files each one as a `net.change` step
 * on the join or the game journey, a line in the game log and a
 * `net.changes` count.
 *
 * The connection is read through lib/telemetry/device.ts (the reader the
 * scope tags use). navigator.connection is Android / Chromium only: where it
 * is missing (iOS) online and offline still come, and the connection fields
 * say `unsupported` instead of being left out. Framework-free, no Sentry.
 * Never throws: telemetry never breaks the page.
 */
import { connectionAttrs, connectionSnapshot, watchConnection, type ConnectionSnapshot } from "../telemetry/device"
import { UNSUPPORTED } from "../webrtc/gather"
import { safely } from "../webrtc/rtc-events"

export interface NetChange {
  event: "online" | "offline" | "change"
  /** span attributes: text only (numbers do not aggregate there). The
   *  connection's own (net.type, net.effective, net.rtt, net.downlink) are
   *  lib/telemetry/device.ts's; a `change` adds net.from_type and net.from_effective. */
  attrs: Record<string, string>
}

/** A retry-worthy path transition. Chromium fires connection.change for
 * bandwidth estimates too; only a real transport type change counts. Going
 * offline cannot repair anything, so the browser's later online edge owns the
 * retry. */
export function retryableNetworkChange(change: NetChange): boolean {
  if (change.event === "online") return change.attrs["net.online"] === "true"
  if (change.event !== "change") return false
  const before = change.attrs["net.from_type"]
  const after = change.attrs["net.type"]
  return Boolean(before && after && before !== after)
}

const onLine = (): string => (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" ? String(navigator.onLine) : UNSUPPORTED)

/** Calls back on every online, offline and connection change; returns the
 *  stop function, which removes every listener it added. Never throws. */
export function watchNetwork(onChange: (change: NetChange) => void): () => void {
  try {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {}
    let before: ConnectionSnapshot | null = connectionSnapshot()
    const tell = (event: NetChange["event"]) =>
      safely(() => {
        const now = connectionSnapshot()
        const attrs: Record<string, string> = {
          "net.event": event,
          "net.online": onLine(),
          ...(now ? connectionAttrs(now) : { "net.type": UNSUPPORTED, "net.effective": UNSUPPORTED, "net.connection": UNSUPPORTED }),
        }
        if (event === "change" && before) {
          attrs["net.from_type"] = before.type
          attrs["net.from_effective"] = before.effectiveType
        }
        before = now
        onChange({ event, attrs })
      })
    const online = () => tell("online")
    const offline = () => tell("offline")
    window.addEventListener("online", online)
    window.addEventListener("offline", offline)
    const stopConnection = watchConnection(() => tell("change"))
    return () =>
      safely(() => {
        window.removeEventListener("online", online)
        window.removeEventListener("offline", offline)
        stopConnection()
      })
  } catch {
    return () => {}
  }
}
