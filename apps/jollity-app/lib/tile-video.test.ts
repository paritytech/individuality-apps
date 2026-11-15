// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import {
  remoteObservationAllowed,
  RemoteAttachmentGeneration,
  acceptFirstRemoteFrame,
  type RemoteVideoObservation,
} from "./peer-video-observation"

describe("remote video observation guard", () => {
  const stream = { getVideoTracks: () => [{ readyState: "live" }] } as unknown as MediaStream
  const video = { srcObject: stream } as HTMLVideoElement
  const observation: RemoteVideoObservation = {
    key: "peer-a",
    generation: 4,
    accept: () => true,
    onFirstFrame: vi.fn(),
    onWindow: vi.fn(),
  }

  it("accepts only the current player, stream, generation, and roster/freeze state", () => {
    expect(remoteObservationAllowed(video, stream, "peer-a", 4, observation)).toBe(true)
    expect(remoteObservationAllowed(video, { getVideoTracks: () => [] } as unknown as MediaStream, "peer-a", 4, observation)).toBe(false)
    expect(remoteObservationAllowed(video, stream, "peer-b", 4, observation)).toBe(false)
    expect(remoteObservationAllowed(video, stream, "peer-a", 5, observation)).toBe(false)
    expect(remoteObservationAllowed(video, stream, "peer-a", 4, { ...observation, accept: () => false })).toBe(false)
  })

  it("rejects Chromium's close-time callback once the only remote video track ended", () => {
    const ended = { getVideoTracks: () => [{ readyState: "ended" }] } as unknown as MediaStream
    expect(remoteObservationAllowed({ srcObject: ended } as HTMLVideoElement, ended, "peer-a", 4, observation)).toBe(false)
  })

  it("keeps every callback from a live track eligible, including a muted first black frame", () => {
    const liveMuted = { getVideoTracks: () => [{ readyState: "live", muted: true }] } as unknown as MediaStream
    const firstBlackFrame = { srcObject: liveMuted, videoWidth: 2, videoHeight: 2 } as HTMLVideoElement
    expect(remoteObservationAllowed(firstBlackFrame, liveMuted, "peer-a", 4, observation)).toBe(true)
  })

  it("invalidates queued frame and canvas work on replacement and cleanup", () => {
    const lifecycle = new RemoteAttachmentGeneration()
    const first = lifecycle.attach()
    expect(first.current()).toBe(true)
    const replacement = lifecycle.attach()
    expect(first.current()).toBe(false)
    expect(replacement.current()).toBe(true)
    lifecycle.invalidate()
    expect(replacement.current()).toBe(false)
  })

  it("offers the first decoded frame immediately from the synchronous seen transition", () => {
    const mark = vi.fn(() => true)
    const offer = vi.fn()
    expect(acceptFirstRemoteFrame(() => true, mark, offer)).toBe(true)
    expect(mark).toHaveBeenCalledOnce()
    expect(offer).toHaveBeenCalledOnce()
  })
})
