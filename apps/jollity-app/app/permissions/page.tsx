// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The one-time permission gate — prompts EVERYTHING the game needs (the
 * dim2/jollity set, see lib/permissions.ts), one modal at a time, and goes
 * to the home screen once every check passes. A denial keeps you here with
 * the failed rows marked and one line saying what fixes it, with no button.
 *
 * A retry would do nothing. The host keeps the answer to its own
 * prompt for the product, and iOS keeps its own answer for the Polkadot app,
 * so after a refusal every ask answers no without a prompt.
 * The pass re-runs by itself on a camera grant change and when the app comes
 * back to the front, quietly: the rows and the line stay as they are until an
 * answer changes. "Open Settings" waits on a host capability to open the
 * settings page of the app.
 */
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  PERMISSION_ITEMS,
  allPermissionsGranted,
  cameraAnswerOf,
  markCameraAnswer,
  markPermissionsGranted,
  requestPermissionItem,
  requestTelemetryGrant,
  turnIssueInFlight,
  watchCameraGrant,
  type DenialReason,
  type PermissionId,
  type PermissionRowState,
} from "@/lib/permissions"
import { runAlone, runPermissionPass } from "@/lib/permission-pass"
import { CAMERA_PERMISSION_COPY, guidanceFor } from "@/lib/permission-copy"
import { watchPageHidden } from "@/lib/page-lifecycle"
import { lastIceOutcome } from "@/lib/webrtc/ice"

type Phase = "intro" | "requesting" | "failed" | "blocked"
type RowState = PermissionRowState

const REASON_LABEL: Record<DenialReason, string> = {
  denied: CAMERA_PERMISSION_COPY.denied.row,
  blocked: CAMERA_PERMISSION_COPY.blocked.row,
  "no-camera": CAMERA_PERMISSION_COPY["no-camera"].row,
  busy: "Camera in use",
  timeout: "No response",
  "host-error": "Host error",
}

function rowLabel(state: RowState): string {
  switch (state.kind) {
    case "idle":
      return ""
    case "asking":
      return "Asking…"
    case "granted":
      return "Allowed"
    case "denied":
      return REASON_LABEL[state.reason]
  }
}

/** Box at the end of a row, ticked when granted and crossed when refused. */
function StatusMark({ state }: { state: RowState }) {
  const face =
    state.kind === "granted" ? "✓" : state.kind === "denied" ? "✕" : state.kind === "asking" ? "…" : ""
  return (
    <span
      aria-hidden
      className={
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold " +
        (state.kind === "granted"
          ? "border-foreground bg-foreground text-background"
          : state.kind === "denied"
            ? "border-destructive text-destructive"
            : "border-border text-muted-foreground")
      }
    >
      {face}
    </span>
  )
}

export default function PermissionsPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>("intro")
  // nothing paints until the silent check decides — no gate flash for
  // players who already granted everything
  const [visible, setVisible] = useState(false)
  const [states, setStates] = useState<Record<PermissionId, RowState>>(
    () => Object.fromEntries(PERMISSION_ITEMS.map((item) => [item.id, { kind: "idle" }])) as Record<
      PermissionId,
      RowState
    >,
  )

  const setItem = (id: PermissionId, state: RowState) =>
    setStates((current) => ({ ...current, [id]: state }))

  const passInFlight = useRef(false)
  const requestAll = (automatic: boolean) =>
    runAlone(passInFlight, async () => {
      if (!automatic) setPhase("requesting")
      // one at a time, since the host shows one consent modal per request
      const pass = await runPermissionPass({
        items: PERMISSION_ITEMS.map((item) => item.id),
        request: requestPermissionItem,
        turnIssue: turnIssueInFlight,
        turnReceived: () => lastIceOutcome()?.turnReceived === true,
        requestTelemetry: requestTelemetryGrant,
        automatic,
        onAsking: (id) => setItem(id, { kind: "asking" }),
        onResult: (id, result) => {
          setItem(id, result.ok ? { kind: "granted" } : { kind: "denied", reason: result.reason ?? "denied" })
          if (id === "camera") {
            const answer = cameraAnswerOf(result)
            if (answer) void markCameraAnswer(answer)
          }
        },
      })
      if (pass.allGranted) {
        await markPermissionsGranted()
        router.replace("/")
        return
      }
      setPhase(pass.cameraBlocked ? "blocked" : "failed")
    })

  // react-hooks/refs bars a ref write during render, so an effect keeps it current
  const requestAllRef = useRef<(automatic: boolean) => Promise<void>>(async () => {})
  useEffect(() => {
    requestAllRef.current = requestAll
  })

  const view = { visible, phase, states }

  // fully granted users never see this screen — straight back to the app
  useEffect(() => {
    let cancelled = false
    void allPermissionsGranted().then((granted) => {
      if (cancelled) return
      if (granted) router.replace("/")
      else setVisible(true)
    })
    return () => {
      cancelled = true
    }
  }, [router])

  // self-heal: a grant change re-runs the checks, and so does the app coming
  // back to the front, where the player went to Settings or closed the app
  // holding the camera. iOS kills the app on a camera toggle, and the gate
  // then runs from the start.
  const stuck = phase === "blocked" || phase === "failed"
  useEffect(() => {
    if (!stuck) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    const rerun = () => {
      if (!cancelled) void requestAllRef.current(true)
    }
    void watchCameraGrant(rerun).then((stop) => {
      if (cancelled) stop()
      else unsubscribe = stop
    })
    const unwatchPage = watchPageHidden(() => {}, rerun)
    return () => {
      cancelled = true
      unsubscribe?.()
      unwatchPage()
    }
  }, [stuck])

  if (!view.visible) return null

  return (
    <div className="flex min-h-dvh flex-1 flex-col pt-6">
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">
          One-time setup
        </div>
        <h1 className="text-[28px] leading-9 font-bold">Camera &amp; connection</h1>
        <p className="max-w-[38ch] text-base leading-6 text-muted-foreground">
          The game shows your camera to the other players and streams video over
          the network. We&apos;ll ask for access once now, so nothing interrupts
          you mid-game.
        </p>

        <div aria-live="polite" className="mt-2 w-full max-w-sm overflow-hidden rounded-xl bg-card text-left">
          {PERMISSION_ITEMS.map((item, i) => (
            <div key={item.id} className="flex min-h-[52px] items-center px-4">
              <div
                className={
                  "flex flex-1 items-center justify-between gap-3 self-stretch py-3 " +
                  (i > 0 ? "border-t" : "")
                }
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-base">{item.title}</span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {item.description}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={
                      "text-xs font-semibold " +
                      (view.states[item.id].kind === "denied"
                        ? "text-destructive"
                        : view.states[item.id].kind === "granted"
                          ? "text-foreground"
                          : "text-muted-foreground")
                    }
                  >
                    {rowLabel(view.states[item.id])}
                  </span>
                  <StatusMark state={view.states[item.id]} />
                </div>
              </div>
            </div>
          ))}

        </div>
      </main>

      <footer className="flex flex-col items-center gap-3 px-4 pt-3 pb-6">
        <span
          role="status"
          className={
            "max-w-sm text-center text-xs font-medium " +
            (view.phase === "failed" || view.phase === "blocked"
              ? "text-destructive"
              : "text-muted-foreground/60")
          }
        >
          {view.phase === "failed" || view.phase === "blocked"
            ? guidanceFor(view.states)
            : view.phase === "requesting"
              ? "First-time statement-store setup may take a few minutes. Keep the Polkadot app open."
              : "You can change this later in your device settings."}
        </span>
        {view.phase === "intro" || view.phase === "requesting" ? (
          <Button
            size="lg"
            className="w-full max-w-sm"
            onClick={() => void requestAll(false)}
            disabled={view.phase === "requesting"}
          >
            {view.phase === "requesting" ? "Requesting…" : "Allow access"}
          </Button>
        ) : null}
      </footer>
    </div>
  )
}
