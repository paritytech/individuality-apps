// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The source's game clock: the offset, the checks that moved it, its last chain
 * value, and "T", which is game now minus the current `game_date`. Two devices
 * that show the same T are in sync.
 */
import { useEffect, useState, useSyncExternalStore } from "react"
import { getClockSnapshot, subscribeClock, type ClockSnapshot } from "@/lib/debug/clock"
import { formatStamp } from "@/lib/format"

const serverSnapshot = (): ClockSnapshot | null => null

function signed(t: number | null): string {
  return t === null ? "—" : `${t >= 0 ? "+" : ""}${t}s`
}

export function ClockView() {
  const snapshot = useSyncExternalStore(subscribeClock, getClockSnapshot, serverSnapshot)
  const [open, setOpen] = useState(false)
  // Device time lives in state: `Date.now()` in render is impure. The collapsed
  // summary shows T too, so the tick runs while the sheet is mounted.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const deviceSeconds = Math.floor(nowMs / 1000)
  const chainNow = Math.floor((nowMs + (snapshot?.offsetMs ?? 0)) / 1000)
  const t = snapshot?.gameAt == null ? null : chainNow - snapshot.gameAt
  const summary = !snapshot
    ? "no source"
    : `T ${signed(t)} · offset ${snapshot.offsetMs}ms · ${snapshot.method}`

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="text-xs font-semibold">Game timing</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">{summary}</span>
      </button>

      {open && (
        <div className="max-h-[40vh] overflow-y-auto px-3 pb-2 font-mono text-[10px] leading-relaxed">
          {!snapshot ? (
            <p className="text-muted-foreground">No game source has started in this session.</p>
          ) : snapshot.chainSeconds === 0 ? (
            <p className="text-muted-foreground">no chain value yet</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                engine {snapshot.engine} · status {snapshot.status}
              </p>
              <p className="text-muted-foreground">
                offset {snapshot.offsetMs}ms · {snapshot.method} · peers {snapshot.peers} · last {formatStamp(snapshot.anchoredAtMs)} (
                {Math.floor((nowMs - snapshot.anchoredAtMs) / 1000)}s ago)
              </p>
              <p className="text-muted-foreground">
                chain now {formatStamp(chainNow * 1000)} · device {formatStamp(deviceSeconds * 1000)}
              </p>
              <p className="text-muted-foreground">
                game_date {snapshot.gameAt === null ? "—" : formatStamp(snapshot.gameAt * 1000)} · T {signed(t)}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
