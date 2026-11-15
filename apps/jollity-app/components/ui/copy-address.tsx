// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * A tap-to-copy account address — the funding target on the "needs deposit"
 * screen. Shows the address middle-truncated so it reads as one tidy line, and
 * copies the FULL address to the clipboard on click/touch (host-sandbox-safe:
 * see lib/clipboard). A short "Copied" confirmation replaces the hint.
 */
import { useState } from "react"
import { copyToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"

/** first 6 … last 6 — enough to recognise, tap to get the whole thing */
function middleTruncate(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 6)}…${address.slice(-6)}`
}

export function CopyAddress({ address, label }: { address: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    const ok = await copyToClipboard(address)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={`Copy ${label ?? "account"} address`}
      className={cn(
        "group mt-1 flex max-w-full items-center gap-2 rounded-full border border-border bg-card",
        "px-3.5 py-2 text-muted-foreground transition-colors active:bg-muted",
        "hover:border-foreground/20 hover:text-foreground",
      )}
    >
      <span className="font-mono text-xs tracking-tight tabular-nums">{middleTruncate(address)}</span>
      {copied ? (
        <span className="flex items-center gap-1 text-[11px] font-medium text-foreground">
          <CheckIcon /> Copied
        </span>
      ) : (
        <span className="flex items-center gap-1 text-[11px] font-medium opacity-70 group-hover:opacity-100">
          <CopyIcon /> Copy
        </span>
      )}
    </button>
  )
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
