// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface RemoteVideoObservation {
  key: string
  generation: number
  accept(): boolean
  onFirstFrame(video: HTMLVideoElement, current: () => boolean): void
  onWindow(video: HTMLVideoElement, current: () => boolean): void
}

/** Monotonic lease owned by one tile attachment lifecycle. */
export class RemoteAttachmentGeneration {
  private value = 0

  attach(): { generation: number; current: () => boolean } {
    const generation = ++this.value
    return { generation, current: () => this.value === generation }
  }

  invalidate(): void {
    this.value += 1
  }
}

/** First-frame transition and still offer in one callback, before React can
 * rerender the newly-seen role. */
export function acceptFirstRemoteFrame(
  current: () => boolean,
  markSeen: () => boolean,
  offer: () => void,
): boolean {
  if (!current() || !markSeen() || !current()) return false
  offer()
  return true
}

export function remoteObservationAllowed(
  video: HTMLVideoElement,
  stream: MediaStream,
  key: string,
  generation: number,
  observation: RemoteVideoObservation | undefined,
): boolean {
  return Boolean(
    observation &&
      observation.key === key &&
      observation.generation === generation &&
      video.srcObject === stream &&
      // Chromium presents one synthetic black rVFC while an incoming,
      // trackless transceiver is being closed. Its remote track is already
      // ended: that callback is teardown, not a decoded peer-camera frame.
      // A live track remains authoritative regardless of resolution, media
      // time or mute state, so genuine first frames stay eligible.
      stream.getVideoTracks().some((track) => track.readyState === "live") &&
      observation.accept(),
  )
}
