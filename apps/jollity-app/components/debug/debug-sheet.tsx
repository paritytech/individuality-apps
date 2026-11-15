// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The debug sheet — a slide-up overlay that shows the live log and the
 * controls that copy, save or clear it (Copy / Download / Clear). Summoned by
 * useDebugSheet (Cmd/Ctrl+D, or 5 taps in the top third on a phone).
 *
 * Save hands the actual file to the native share sheet on a phone (save to
 * Files/iCloud or send it on) and downloads it on desktop; Copy is the
 * always-works fallback (Clipboard API → execCommand → manual reveal) for a
 * host that exposes neither. Clear is two-step.
 */
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { APP_VERSION, buildCommitShort, LOG_PRODUCT } from "@/lib/debug/flag"
import { clearDevLog } from "@/lib/debug/log-store"
import {
  clearTelemetry,
  copyLogs,
  downloadLogs,
  getTelemetryStats,
} from "@/lib/debug/telemetry"
import { LogView } from "./log-view"
import { ConnectionView } from "./connection-view"
import { ClockView } from "./clock-view"
import { CameraStatusView } from "./camera-status-view"
import { LowPowerView } from "./low-power-view"

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(0)} KB`
}

export function DebugSheet({ onClose }: { onClose: () => void }) {
  const [note, setNote] = useState<string | null>(null)
  const [reveal, setReveal] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const stats = getTelemetryStats()

  const onCopy = async () => {
    const { ok, text } = await copyLogs()
    setNote(ok ? "Copied all logs to clipboard" : "Clipboard blocked — copy from the box below")
    setReveal(ok ? null : text)
  }
  const onDownload = async () => {
    const outcome = await downloadLogs()
    setNote(
      outcome === "shared"
        ? "Shared the log file"
        : outcome === "downloaded"
          ? "Downloaded the log file"
          : "Couldn't save — use Copy instead",
    )
  }
  const onClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    await clearTelemetry()
    clearDevLog()
    setConfirmClear(false)
    setNote("Logs cleared")
    setReveal(null)
  }

  return (
    <div
      role="dialog"
      aria-label="Debug logs"
      className="fixed inset-0 z-[999] flex flex-col bg-background/95 backdrop-blur-sm xl:inset-auto xl:right-3 xl:bottom-3 xl:h-[80vh] xl:w-[420px] xl:rounded-xl xl:border xl:border-border xl:shadow-2xl"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Debug logs</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            v{APP_VERSION} · {buildCommitShort()} · {LOG_PRODUCT} · {stats.count} this session · {kb(stats.approxBytes)}
          </p>
        </div>
        <Button size="icon-sm" variant="tertiary" aria-label="Close" onClick={onClose}>
          ✕
        </Button>
      </header>

      <LowPowerView />
      <ConnectionView />
      <ClockView />
      <CameraStatusView />

      <LogView />

      {note ? (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">{note}</p>
      ) : null}
      {reveal ? (
        <textarea
          readOnly
          value={reveal}
          onFocus={(e) => e.currentTarget.select()}
          className="mx-3 mb-2 h-24 rounded-md border border-border bg-card p-2 font-mono text-[10px]"
        />
      ) : null}

      <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button size="sm" className="flex-1" onClick={() => void onCopy()}>
          Copy
        </Button>
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => void onDownload()}>
          Download
        </Button>
        <Button
          size="sm"
          variant={confirmClear ? "destructive" : "tertiary"}
          onClick={() => void onClear()}
          onBlur={() => setConfirmClear(false)}
        >
          {confirmClear ? "Confirm" : "Clear"}
        </Button>
      </footer>
    </div>
  )
}
