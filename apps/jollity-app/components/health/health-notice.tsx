// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The player sees that something is wrong, without hunting for it: this says
 * what broke, as soon as it is sure, and keeps them in the game while they
 * read it.
 *
 * The blame is debounced both ways (`useDebouncedBlame`), so a round
 * transition does not flash the notice.
 *
 * A rung marked `knownBlocker` never raises this on its own (see
 * `classifyLadder`): it is set when this handset received no TURN credentials,
 * and putting a permanent warning over a game that plays fine on the same LAN
 * would train players to ignore the notice.
 */
import { useState } from "react"
import type { LadderVerdict } from "@jollity/statement-core"
import { Button } from "@/components/ui/button"
import { HealthDetails } from "./health-details"
import { noticeHeadline } from "@/lib/health/copy"
import type { HealthNoticeVariant } from "@/lib/health/notice"
import { useDebouncedBlame } from "@/lib/health/use-debounced-blame"

export function HealthNotice({
  verdict,
  variant = "connection",
  hostAnswering = false,
  noUsablePath = false,
}: {
  verdict: LadderVerdict | null
  variant?: HealthNoticeVariant
  hostAnswering?: boolean
  noUsablePath?: boolean
}) {
  const blame = useDebouncedBlame(verdict, hostAnswering, noUsablePath)
  const [open, setOpen] = useState(false)

  if (variant === "host-reconnecting")
    return (
      <div
        role="status"
        data-testid="host-stuck-bar"
        data-restart-advice="reconnecting"
        className="fixed inset-x-0 top-0 z-[810] bg-secondary px-4 py-2.5 text-center text-sm font-medium text-secondary-foreground"
      >
        Reconnecting…
      </div>
    )

  if (variant === "host-stuck")
    return (
      <div
        role="alert"
        data-testid="host-stuck-bar"
        className="fixed inset-x-0 top-0 z-[810] bg-destructive px-4 py-2.5 text-center text-sm font-medium text-destructive-foreground"
      >
        Your Polkadot app is stuck, restart it
      </div>
    )

  if (!blame) return null

  if (open) {
    return (
      <div
        role="dialog"
        aria-label="Connection details"
        className="fixed inset-0 z-[900] flex flex-col items-center justify-center gap-6 bg-background/97 px-6 backdrop-blur-sm"
      >
        <HealthDetails verdict={verdict} />
        <Button variant="tertiary" onClick={() => setOpen(false)}>
          Back to the game
        </Button>
      </div>
    )
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[800] flex items-center gap-3 bg-destructive px-4 py-2.5 text-sm font-medium text-destructive-foreground"
    >
      <span className="flex-1 text-left">{noticeHeadline(blame.layer)}</span>
      <Button size="xs" variant="secondary" className="flex-none" onClick={() => setOpen(true)}>
        What&apos;s wrong?
      </Button>
    </div>
  )
}
