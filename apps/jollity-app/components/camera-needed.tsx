// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * NO CAMERA, NO GAME — what the player reads when their camera could not be
 * opened or was lost, and the one thing they can do about it.
 *
 * The same words in the waiting room (inline, over the countdown, which keeps
 * running) and in the game (over the whole screen). The copy follows the
 * reason (lib/camera-help): turn it on in Settings, free it, or wait while
 * the app keeps trying. There is nothing to tap.
 */
import { Body } from "@/components/ui/screen"
import { tapCamera, type CameraFailure } from "@/lib/camera"
import { cameraHelp, type CameraTrouble } from "@/lib/camera-help"
import { CAMERA_RESTART_NOTICE, CAMERA_TAP_NOTICE } from "@/lib/camera-restart-notice"
import { CAMERA_OFF_LINE } from "@/lib/permission-copy"

const TAKING_LONGER = {
  heading: "Your camera is taking longer",
  body: "It's still starting. Stay on this screen, we keep trying.",
}

const COPY: Record<CameraFailure, { heading: string; body: string }> = {
  denied: {
    heading: "Jollity needs your camera",
    body: CAMERA_OFF_LINE,
  },
  "no-camera": {
    heading: "No camera found",
    body: "Jollity is played on camera, and we can't find one on this phone. We keep looking.",
  },
  busy: {
    heading: "Your camera is busy",
    body: "Another app or a call is using it. Close that, and your camera comes on here.",
  },
  timeout: TAKING_LONGER,
  unknown: TAKING_LONGER,
}

/** the waiting room once the handover is due: nothing promised past kickoff */
const STARTING = "The game is about to start, and it won't wait: no camera, no game."
/** over /game, where the game runs on underneath */
const IN_GAME = "The game goes on without you until your camera is on."

/** the words for a camera that will not start: the heading, what to do, and
 *  the warning once the game is due */
export function cameraNeededCopy(help: CameraTrouble): { heading: string; body: string; starting: string | null } {
  return { ...COPY[help.reason], starting: help.starting ? STARTING : null }
}

/** the heading and what to do (lib/camera-help). The caller places it. */
function CameraNeeded({ help, inGame = false, className = "" }: { help: CameraTrouble; inGame?: boolean; className?: string }) {
  const { heading, body, starting } = cameraNeededCopy(help)
  const note = inGame ? IN_GAME : starting
  return (
    <div role="alert" className={"flex flex-col items-center gap-3 text-center " + className}>
      <h2 className="text-xl leading-7 font-bold">{heading}</h2>
      <Body>{body}</Body>
      {note ? <Body className="font-semibold text-foreground">{note}</Body> : null}
    </div>
  )
}

/** the game's version: over everything, since there is nothing to play
 *  without a camera; the game keeps running underneath and resumes the
 *  moment the camera does */
export function CameraNeededOverlay({ reason }: { reason: CameraFailure }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 px-6 backdrop-blur-sm">
      <CameraNeeded help={cameraHelp(reason, false)!} inGame className="w-full max-w-sm" />
    </div>
  )
}

/** a strip at the top, beside the screen and never over its controls: the player
 *  can keep playing (their taps still count) while told to restart the app */
export function CameraRestartBanner() {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-2" data-testid="camera-restart-notice">
      <div role="alert" className="w-full max-w-sm rounded-lg border bg-background/95 px-3 py-2 text-center shadow-md">
        <div className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">{CAMERA_RESTART_NOTICE.eyebrow}</div>
        <h2 className="text-base leading-6 font-bold">{CAMERA_RESTART_NOTICE.heading}</h2>
        <p className="text-sm leading-5 text-muted-foreground">{CAMERA_RESTART_NOTICE.body}</p>
      </div>
    </div>
  )
}

/** The same non-blocking strip, with one activation-preserving camera tap. */
export function CameraTapBanner({ disabled }: { disabled: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-2" data-testid="camera-tap-notice">
      <div role="alert" className="w-full max-w-sm rounded-lg border bg-background/95 px-3 py-2 text-center shadow-md">
        <div className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground">{CAMERA_TAP_NOTICE.eyebrow}</div>
        <p className="text-sm leading-5 text-muted-foreground">{CAMERA_TAP_NOTICE.body}</p>
        <button
          type="button"
          data-testid="camera-tap"
          disabled={disabled}
          onClick={tapCamera}
          className="pointer-events-auto mt-2 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {CAMERA_TAP_NOTICE.button}
        </button>
      </div>
    </div>
  )
}
