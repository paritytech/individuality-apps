// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { devLog } from "../debug/log-store"

export interface LocalMediaOpts {
  video: boolean
  audio: boolean
  width: number
  height: number
  fps: number
  facing: "user" | "environment"
}

/** how long the camera gets to start before the open counts as failed (the
 *  open itself goes on: see getLocalMedia) */
const CAMERA_TIMEOUT_MS = 6000
/** Android hands the camera back asynchronously after a track stops, so an
 *  open straight after a close can find it still held: one retry, after this */
const BUSY_RETRY_MS = 600

/**
 * Why the camera did not open, in the terms the player can act on:
 *
 *  - `denied`    the player or the phone refused camera access
 *  - `no-camera` there is no camera to open (or no way to open one)
 *  - `busy`      another app, or a call, holds it
 *  - `timeout`   it never answered
 *  - `unknown`   anything else
 */
export type CameraFailure = "denied" | "no-camera" | "busy" | "timeout" | "unknown"

export class CameraError extends Error {
  constructor(
    readonly reason: CameraFailure,
    detail: string,
    /** a `timeout`'s open, still in flight: the caller owns it now, and either
     *  takes the camera it answers with or stops it */
    readonly late?: Promise<MediaStream>,
  ) {
    super(`camera ${reason}: ${detail}`)
    this.name = "CameraError"
  }
}

function classify(error: unknown): CameraError {
  if (error instanceof CameraError) return error
  const name = (error as { name?: string } | null)?.name ?? ""
  const detail = error instanceof Error ? `${name}: ${error.message}` : String(error)
  if (name === "NotAllowedError" || name === "SecurityError") return new CameraError("denied", detail)
  if (name === "NotFoundError" || name === "OverconstrainedError") return new CameraError("no-camera", detail)
  if (name === "NotReadableError" || name === "AbortError") return new CameraError("busy", detail)
  return new CameraError("unknown", detail)
}

/**
 * The local camera, within a timeout. A camera that cannot be opened is a
 * `CameraError`, never a stand-in: Jollity is played on camera, and a fake
 * video (a bouncing dot, say) only hides the failure from everyone.
 *
 * A TIMEOUT DOES NOT CANCEL THE OPEN. getUserMedia cannot be cancelled, and a
 * cold camera can answer a few seconds late (issue 226: five phones, each
 * fine on a retry two seconds later). The open goes back on the error as
 * `late`, so the caller can take that camera rather than ask for a second
 * one alongside it, which is the open Android fails.
 */
export async function getLocalMedia(config: LocalMediaOpts, options: { retryBusy?: boolean } = {}): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    throw new CameraError("no-camera", "this browser cannot open a camera")
  const constraints: MediaStreamConstraints = {
    video: config.video && {
      width: { ideal: config.width },
      height: { ideal: config.height },
      frameRate: { ideal: config.fps },
      facingMode: config.facing,
    },
    audio: config.audio,
  }
  let timedOut = false
  const gum = (async () => {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints)
    } catch (error) {
      const name = (error as DOMException)?.name
      if (options.retryBusy === false || timedOut || (name !== "NotReadableError" && name !== "AbortError")) throw error
      devLog("rtc", "camera busy, trying again", { error: name })
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS))
      return await navigator.mediaDevices.getUserMedia(constraints)
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CameraError("timeout", `no answer in ${CAMERA_TIMEOUT_MS}ms`, gum)), CAMERA_TIMEOUT_MS)
  })
  try {
    return await Promise.race([gum, timeout])
  } catch (error) {
    timedOut = true
    const failure = classify(error)
    devLog("camera", "camera did not open", { reason: failure.reason, detail: failure.message }, "error")
    throw failure
  } finally {
    clearTimeout(timer)
  }
}
