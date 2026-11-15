// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The live log — the in-memory ring buffer (lib/debug/log-store.ts) rendered
 * through useSyncExternalStore, newest at the bottom, auto-scrolled. Flat and
 * chronological on purpose: one line is `time [tag] message`, the payload
 * folded under it. Color by level.
 */
import { useEffect, useRef, useSyncExternalStore } from "react"
import {
  getDevLogEntries,
  subscribeDevLog,
  type LogEntry,
  type LogLevel,
} from "@/lib/debug/log-store"

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: "text-muted-foreground",
  warn: "text-yellow-400",
  error: "text-destructive",
}

function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`
}

function payload(data: unknown): string | null {
  if (data === undefined) return null
  if (typeof data === "string") return data
  try {
    return JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 1)
  } catch {
    return String(data)
  }
}

function Line({ entry }: { entry: LogEntry }) {
  const body = payload(entry.data)
  return (
    <div className="border-b border-border/40 px-3 py-1 font-mono text-[11px] leading-snug">
      <div className="flex gap-2">
        <span className="shrink-0 tabular-nums text-muted-foreground/70">{stamp(entry.time)}</span>
        <span className="shrink-0 font-semibold text-foreground/80">[{entry.tag}]</span>
        <span className={LEVEL_CLASS[entry.level]}>{entry.message}</span>
      </div>
      {body ? (
        <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all text-muted-foreground/60">
          {body}
        </pre>
      ) : null}
    </div>
  )
}

export function LogView() {
  const entries = useSyncExternalStore(subscribeDevLog, getDevLogEntries, () => getDevLogEntries())
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // stick to the bottom only when already near it, so scrolling up to read
    // history is not yanked back by a new line
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) endRef.current?.scrollIntoView({ block: "end" })
  }, [entries])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {entries.length === 0 ? (
        <p className="px-3 py-4 font-mono text-[11px] text-muted-foreground/60">No log entries yet.</p>
      ) : (
        entries.map((entry) => <Line key={entry.id} entry={entry} />)
      )}
      <div ref={endRef} />
    </div>
  )
}
