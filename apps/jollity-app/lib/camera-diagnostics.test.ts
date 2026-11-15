// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./debug/log-store", () => ({ devLog: vi.fn() }))
const mocks = vi.hoisted(() => ({ metrics: [] as Array<{ name: string; value: number }> }))
vi.mock("./telemetry", () => ({
  cameraTrail: vi.fn(),
  cameraNoFrames: vi.fn(),
  recordCount: (name: string, value: number) => mocks.metrics.push({ name, value }),
  recordDistribution: (name: string, value: number) => mocks.metrics.push({ name, value }),
  recordGauge: (name: string, value: number) => mocks.metrics.push({ name, value }),
}))

const diagnostics = await import("./camera-diagnostics")
const { devLog } = await import("./debug/log-store")

function stream(deviceId = "secret-device") {
  const track = { readyState: "live", muted: false, enabled: true, getSettings: () => ({ width: 480, height: 480, frameRate: 24, deviceId }) }
  return { getVideoTracks: () => [track] } as unknown as MediaStream
}

afterEach(() => {
  diagnostics.resetCameraDiagnosticsForTest()
  mocks.metrics.length = 0
  vi.mocked(devLog).mockClear()
})

describe("camera diagnostics", () => {
  it("uses opaque ids and never retains a raw device id", () => {
    const s = stream()
    diagnostics.acceptCameraStream(s, 1)
    diagnostics.recordCameraReuse(s)
    const text = JSON.stringify(diagnostics.getCameraDiagnosticSnapshot())
    expect(text).not.toContain("secret-device")
    expect(text).toContain('"streamId":"c')
    expect(text).toContain("device_id_hash")
  })

  it("detects a stale attachment and counts it", () => {
    const old = stream("old")
    const current = stream("current")
    diagnostics.acceptCameraStream(current, 1)
    expect(diagnostics.recordSelfAttach({} as HTMLVideoElement, old, current, "join")).toBe(true)
    expect(mocks.metrics.filter((row) => row.name === "camera.stale_attachment")).toHaveLength(1)
  })

  it("repairs an element left on the old stream without calling a normal stream swap stale", () => {
    const old = stream("old")
    const current = stream("current")
    diagnostics.acceptCameraStream(current, 1)
    const video = { srcObject: old } as HTMLVideoElement
    expect(diagnostics.recordSelfAttach(video, current, current, "join")).toBe(false)
    expect(mocks.metrics.filter((row) => row.name === "camera.stale_attachment")).toHaveLength(0)
  })

  it("derives outbound fps only from the same track and increasing counter", () => {
    diagnostics.observeCameraOutbound([{ quality: { link: 1, at: 1_000, outbound: { framesSent: 10, trackIdentifier: "raw-track" } } }])
    diagnostics.observeCameraOutbound([{ quality: { link: 1, at: 2_000, outbound: { framesSent: 34, trackIdentifier: "raw-track" } } }])
    expect(mocks.metrics.find((row) => row.name === "camera.outbound_fps")?.value).toBe(24)
    expect(diagnostics.cameraOutboundAdvancing()).toBe(true)
    expect(JSON.stringify(diagnostics.getCameraDiagnosticSnapshot())).not.toContain("raw-track")
    diagnostics.acceptCameraStream(stream("replacement"), 3_000)
    expect(diagnostics.cameraOutboundAdvancing()).toBe(false)
  })

  it("retains self samples but keeps outbound detail out of the persisted trail", () => {
    const s = stream()
    diagnostics.acceptCameraStream(s, 1)
    diagnostics.recordCameraTrail("self.window", s, { frames: 240 })
    diagnostics.recordCameraTrail("outbound.video", s, { frames_encoded: 240 })
    expect(diagnostics.getCameraDiagnosticSnapshot().trail.map((entry) => entry.event)).toEqual(["self.window"])
  })

  it("puts the ordered pre-handover trail in one durable summary line", () => {
    const s = stream()
    diagnostics.acceptCameraStream(s, 1)
    diagnostics.recordCameraTrail("open.resolved", s, { attempt: 1 })
    diagnostics.recordCameraTrail("self.first_frame", s, { first_frame_ms: 12 })
    for (let n = 0; n < 15; n++) diagnostics.recordCameraTrail("self.window", s, { frames: 240, elapsed_ms: 10_000, fps: 24 })
    diagnostics.cameraHandoverSummary(208)
    diagnostics.cameraHandoverSummary(208)
    const summary = vi.mocked(devLog).mock.calls.find((call) => call[1] === "camera.handover_summary")
    expect(summary?.[2]).toMatchObject({ stream_id: expect.stringMatching(/^c/) })
    const trail = (summary?.[2] as { trail: Array<Record<string, unknown>> }).trail
    expect(trail[0]).toMatchObject({ event: "open.resolved", attempt: 1 })
    expect(trail[1]).toMatchObject({ event: "self.first_frame", first_frame_ms: 12 })
    expect(vi.mocked(devLog).mock.calls.filter((call) => call[1] === "camera.handover_summary")).toHaveLength(1)
    expect(JSON.stringify(summary?.[2]).length).toBeLessThan(4_096)
  })

  it("keeps a worst-case handover summary within the durable payload limit", () => {
    const s = stream("long-secret-device-identifier")
    diagnostics.acceptCameraStream(s, 123_456.789_123)
    for (let n = 0; n < 24; n++) {
      diagnostics.recordCameraTrail("self.window", s, {
        checkpoint: n % 2 ? "join" : "open",
        frames: 240,
        elapsed_ms: 10_000.987_654,
        fps: 23.987_654_321,
      })
      if (n < 5) diagnostics.recordCameraTrail("outbound.video", s, {
        frames_encoded: 999_999_999,
        frames_sent: 999_999_999,
        limitation: "bandwidth",
        track_id: "t999999999",
      })
    }
    diagnostics.cameraHandoverSummary(999_999)
    const summary = vi.mocked(devLog).mock.calls.find((call) => call[1] === "camera.handover_summary")
    expect(JSON.stringify(summary?.[2]).length).toBeLessThan(4_096)
    expect((summary?.[2] as { trail: Array<{ event: string }> }).trail).toHaveLength(24)
    expect((summary?.[2] as { trail: Array<{ event: string }> }).trail.every((entry) => entry.event !== "outbound.video")).toBe(true)
  })

  it("clears the persisted trail when the camera closes", () => {
    const s = stream()
    diagnostics.recordCameraTrail("stream.opened", s)
    diagnostics.clearCameraTrail()
    expect(diagnostics.getCameraDiagnosticSnapshot().trail).toEqual([])
  })
})
