// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The connection footer's headline and its line (lib/waiting-room.ts
 * `waitingFooter`): Title medium in the primary text colour, Body medium in
 * the secondary. With an `info` text the headline has an info button, and the
 * button shows the text in a tooltip over it. The tooltip closes on a tap on
 * it, or when the headline changes.
 */
import { useState } from "react"
import { Info } from "lucide-react"
import type { WaitingFooter } from "@/lib/waiting-room"

export function StatusLine({ footer }: { footer: WaitingFooter }) {
  // the headline the tooltip was opened on: a new headline closes it
  const [openOn, setOpenOn] = useState<string | null>(null)
  const open = footer.info !== null && openOn === footer.text
  return (
    <span
      role="status"
      data-testid={footer.testId}
      data-restart-advice={footer.restartAdvice}
      className="relative flex flex-col items-center text-center whitespace-nowrap"
    >
      <span className="inline-flex items-center gap-1.5 text-base leading-6 font-semibold text-foreground">
        {footer.text}
        {footer.info !== null ? (
          <button
            type="button"
            aria-label="What could have happened"
            aria-expanded={open}
            // its own tap, not the footer's
            onClick={(e) => {
              e.stopPropagation()
              setOpenOn(open ? null : footer.text)
            }}
            className="-mx-1 -my-0.5 grid size-6 place-items-center rounded-full text-muted-foreground"
          >
            <Info aria-hidden size={16} strokeWidth={2} />
          </button>
        ) : null}
      </span>
      {footer.detail !== null ? <span className="text-sm leading-5 text-muted-foreground">{footer.detail}</span> : null}
      {open ? (
        <span
          role="tooltip"
          onClick={(e) => {
            e.stopPropagation()
            setOpenOn(null)
          }}
          className="waiting-fade-in absolute bottom-[calc(100%+10px)] left-1/2 z-10 w-max max-w-[300px] -translate-x-1/2 rounded-[14px] bg-card px-3.5 py-2.5 text-left text-[13px] leading-[18px] whitespace-normal text-muted-foreground shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
        >
          {footer.info}
        </span>
      ) : null}
    </span>
  )
}
