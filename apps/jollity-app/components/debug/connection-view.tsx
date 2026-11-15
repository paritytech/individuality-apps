// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The technical half of the health ladder: every rung with its own status and
 * its raw `detail`, the signalling counters, and the per-peer WebRTC rows the
 * verdict was computed from.
 *
 * This is where the answer to "is it STUN, TURN, the store, or the internet?"
 * actually lives. `pair` is the decisive field: `host/host` means same LAN,
 * `srflx` means STUN did its job, `relay` means TURN is carrying it, and blank
 * means no path was ever nominated.
 *
 * Shown collapsed by default — the log is what people open this sheet for, and
 * a wall of counters above it would push the log off a phone screen.
 *
 * Deliberately shows EVERY rung, including the ones `classifyLadder` blanked
 * as "not evaluated" once something above them failed: the verdict is a
 * diagnosis, and this is the evidence it was read from.
 */
import { useState, useSyncExternalStore } from "react"
import { formatStamp } from "@/lib/format"
import { getHealthSnapshot, subscribeHealth, type HealthSnapshot } from "@/lib/health/snapshot"
import type { LayerStatus } from "@jollity/statement-core"

const STATUS_CLASS: Record<LayerStatus, string> = {
  ok: "text-muted-foreground",
  warn: "text-yellow-400",
  fail: "text-destructive",
  unknown: "text-muted-foreground/50",
}
const GLYPH: Record<LayerStatus, string> = { ok: "✓", warn: "!", fail: "✕", unknown: "–" }

const serverSnapshot = (): HealthSnapshot | null => null

export function ConnectionView() {
  const snapshot = useSyncExternalStore(subscribeHealth, getHealthSnapshot, serverSnapshot)
  const [open, setOpen] = useState(false)

  const blame = snapshot?.verdict.blame
  const summary = !snapshot ? "no mesh" : blame ? `blame: ${blame.layer}` : "all rungs ok"

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="text-xs font-semibold">Connection</span>
        <span
          className={"truncate font-mono text-[10px] " + (blame ? "text-destructive" : "text-muted-foreground")}
        >
          {summary}
        </span>
      </button>

      {open && (
        <div className="max-h-[40vh] overflow-y-auto px-3 pb-2 font-mono text-[10px] leading-relaxed">
          {!snapshot ? (
            <p className="text-muted-foreground">No mesh has opened in this session.</p>
          ) : (
            <>
              {/* the READ TIME, not an age: `Date.now()` in render is impure
                  and the value would drift between renders for no reason. Same
                  stamp shape as log-view, so the two read as one timeline. */}
              <p className="text-muted-foreground/70">
                read {formatStamp(snapshot.at)} · signalling {(snapshot.signalElapsedMs / 1000).toFixed(0)}s · room{" "}
                {(snapshot.inCallElapsedMs / 1000).toFixed(0)}s
              </p>

              {snapshot.verdict.rungs.map((rung) => (
                <div key={rung.layer} className={"mt-1 " + STATUS_CLASS[rung.status]}>
                  <span>
                    {GLYPH[rung.status]} {rung.layer}
                    {rung.knownBlocker ? " (known blocker)" : ""}
                  </span>
                  <div className="pl-4 break-words opacity-80">{rung.detail}</div>
                  {rung.expected && <div className="pl-4 break-words opacity-60">expected: {rung.expected}</div>}
                </div>
              ))}

              <p className="mt-2 text-muted-foreground">
                {snapshot.stats
                  ? `store ${snapshot.stats.kind}: live=${snapshot.stats.storeLive} sub=${snapshot.stats.subActive} sent=${snapshot.stats.framesSent} ok=${snapshot.stats.submitsOk} failed=${snapshot.stats.submitsFailed} recv=${snapshot.stats.framesRecv} inflight=${snapshot.stats.inflight}${snapshot.stats.lastError ? ` err=${snapshot.stats.lastError}` : ""}`
                  : "store: no transport"}
              </p>

              {snapshot.peers.length === 0 ? (
                <p className="text-muted-foreground/60">no peers</p>
              ) : (
                snapshot.peers.map((peer) => (
                  <div key={peer.id} className="text-muted-foreground">
                    {peer.id.slice(0, 8)} conn={peer.conn} ice={peer.ice} gather={peer.gather} pair=
                    {peer.pair ?? "none"} frames={peer.frames ?? 0}
                  </div>
                ))
              )}

              {snapshot.sessions &&
                [...snapshot.sessions].map(([id, session]) => (
                  <div key={id} className="text-muted-foreground/70">
                    {id.slice(0, 8)} sent={session.sent} acked={session.acked} recv={session.received} failed=
                    {session.submitsFailed} queued={session.queued}
                  </div>
                ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
