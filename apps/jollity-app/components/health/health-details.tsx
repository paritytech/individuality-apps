// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * "What's wrong?" — the same content wherever a player asks the question:
 * behind the in-game notice's button, and on /connection-help when the 30s
 * isolation check sends them there. One component, so the two cannot drift
 * apart into two different stories about the same failure.
 *
 * Shows the blame rung with its fixes, then every rung with its own status, so
 * a player can see that (say) their internet and camera are fine and it is the
 * relay that isn't. `detail` — the technical line — is deliberately NOT here:
 * technical detail belongs in the debug sheet, not on the screen (the sign-up
 * refusal follows the same rule). Copy diagnostics is how it reaches someone
 * who can read it.
 */
import { useState } from "react"
import type { LadderVerdict } from "@jollity/statement-core"
import { Button } from "@/components/ui/button"
import { copyLogs } from "@/lib/debug/telemetry"
import { LAYER_COPY, STATUS_GLYPH, STATUS_LABEL, layerCopy } from "@/lib/health/copy"

export function HealthDetails({ verdict }: { verdict: LadderVerdict | null }) {
  const [note, setNote] = useState<string | null>(null)

  const onCopy = async () => {
    const { ok } = await copyLogs()
    setNote(ok ? "Diagnostics copied — paste them to whoever is helping." : "Couldn't copy automatically.")
  }

  const blame = verdict?.blame
  const copy = blame ? layerCopy(blame.layer) : null

  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      <div className="text-center">
        <h1 className="text-[28px] leading-9 font-bold">
          {copy ? copy.headline : "Everything looks fine from here."}
        </h1>
        {!copy && (
          <p className="mt-2 text-base leading-6 text-muted-foreground">
            If the game still isn&apos;t working, copy the diagnostics below and send them over.
          </p>
        )}
      </div>

      {copy && copy.fixes.length > 0 && (
        <div className="overflow-hidden rounded-xl bg-card text-left">
          {copy.fixes.map((fix, i) => (
            <div key={fix} className="flex min-h-[52px] items-center px-4">
              <div className={"flex-1 py-3 text-sm leading-5 " + (i > 0 ? "border-t" : "")}>{fix}</div>
            </div>
          ))}
        </div>
      )}

      {verdict && (
        <div className="overflow-hidden rounded-xl bg-card text-left">
          {verdict.rungs.map((rung, i) => (
            <div
              key={rung.layer}
              className={
                "flex items-center gap-3 px-4 py-2.5 text-sm " +
                (i > 0 ? "border-t " : "") +
                (rung.status === "fail" ? "text-foreground" : "text-muted-foreground")
              }
            >
              <span aria-hidden className="w-3 text-center font-mono">
                {STATUS_GLYPH[rung.status]}
              </span>
              <span className="flex-1">{LAYER_COPY[rung.layer].name}</span>
              <span className="text-xs">{STATUS_LABEL[rung.status]}</span>
            </div>
          ))}
        </div>
      )}

      <Button variant="secondary" onClick={() => void onCopy()}>
        Copy diagnostics
      </Button>
      {note && <p className="text-center text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}
