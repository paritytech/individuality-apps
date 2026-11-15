// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * Low power mode: one switch for the mode. A change applies live.
 * Nothing is stored, so a reload turns the mode off.
 */
import { useState } from "react"
import { getLowPowerReason, setLowPower, useLowPower } from "@/lib/low-power"
import { useProbeResult, type ProbeResult } from "@/lib/device-probe"

function Row({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-2 py-1 text-left"
    >
      <span>{label}</span>
      <span className={on ? "text-foreground" : "text-muted-foreground"}>{on ? "on" : "off"}</span>
    </button>
  )
}

function probeLine(result: ProbeResult | undefined): string {
  if (!result) return "Device check: not run"
  const samples = result.samples.map((s) => `p95 ${Math.round(s.p95Ms)} ms · ${s.frames} frames`).join(" / ")
  const verdict = result.weak ? "low power on" : "full mode kept"
  return `Device check: ${samples || "no sample"} · ${result.rule} · ${verdict}`
}

export function LowPowerView() {
  const lowPower = useLowPower()
  const probe = useProbeResult()
  const [open, setOpen] = useState(false)

  const summary = lowPower ? `on (${getLowPowerReason()})` : "off"

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-[10px] text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="text-xs font-semibold">Low power</span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">{summary}</span>
      </button>

      {open && (
        <div className="max-h-[40vh] overflow-y-auto px-3 pb-2 font-mono text-[10px] leading-relaxed">
          <Row label="Low power mode" on={lowPower} onToggle={() => setLowPower(!lowPower, "debug-menu")} />
          <p className="py-1 text-muted-foreground">Reason: {lowPower ? getLowPowerReason() : "none"}</p>
          <p className="py-1 text-muted-foreground">{probeLine(probe)}</p>
        </div>
      )}
    </div>
  )
}
