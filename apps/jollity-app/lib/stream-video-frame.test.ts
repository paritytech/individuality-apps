// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

const observed = vi.hoisted(() => ({
  options: undefined as { onFirstFrame(): void; onTimeout(): void } | undefined,
  stop: vi.fn(),
}))

vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("@/lib/video-playback", async () => await import("./video-playback"))
vi.mock("@/lib/camera-frame", () => ({
  observeCameraFrames: (_video: HTMLVideoElement, options: { onFirstFrame(): void; onTimeout(): void }) => {
    observed.options = options
    return { stop: observed.stop }
  },
}))

import { observeFirstPresentedFrame } from "../components/game/stream-video"

describe("stream video presented-frame bridge", () => {
  beforeEach(() => {
    observed.options = undefined
    observed.stop.mockClear()
  })

  it("does not report loading as a frame and exposes observer cleanup", () => {
    const video = {} as HTMLVideoElement
    const arrived = vi.fn()
    const observation = observeFirstPresentedFrame(video, arrived)

    expect(arrived).not.toHaveBeenCalled()
    observed.options?.onTimeout()
    expect(arrived).not.toHaveBeenCalled()
    observed.options?.onFirstFrame()
    expect(arrived).toHaveBeenCalledOnce()
    expect(arrived).toHaveBeenCalledWith(video)

    observation.stop()
    expect(observed.stop).toHaveBeenCalledOnce()
  })
})
