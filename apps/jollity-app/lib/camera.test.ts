// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"

// a fake camera: every open is a new stream, and a stopped track reads ended.
// Tracks and the document are event targets, so a test can end, mute and
// background them the way the OS does. `failNext` makes the next opens fail;
// `slowNext` makes the next opens answer after that many ms, the way a cold
// camera does, and one slower than its timeout fails as `timeout` with the
// open still in flight, as getLocalMedia does.
let opened = 0
const stopped: number[] = []
const failNext: string[] = []
const slowNext: number[] = []
let mutedNext = 0
type FakeTrack = EventTarget & { readyState: string; muted: boolean; stop(): void; getSettings(): object }
type FakeStream = { id: number; getTracks(): FakeTrack[]; getVideoTracks(): FakeTrack[] }
function fakeStream(): FakeStream {
  const id = ++opened
  const startsMuted = mutedNext > 0
  if (startsMuted) mutedNext -= 1
  const track: FakeTrack = Object.assign(new EventTarget(), {
    readyState: "live",
    muted: startsMuted,
    stop() {
      stopped.push(id)
      track.readyState = "ended"
    },
    getSettings: () => ({}),
  })
  return { id, getTracks: () => [track], getVideoTracks: () => [track] }
}
const page = Object.assign(new EventTarget(), { visibilityState: "visible" })
vi.stubGlobal("document", page)
function setVisible(isVisible: boolean) {
  page.visibilityState = isVisible ? "visible" : "hidden"
  page.dispatchEvent(new Event("visibilitychange"))
}
vi.mock("./debug/log-store", () => ({ devLog: () => {} }))
vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("./journeys/game-trace", () => ({ cameraRecovering: vi.fn(), cameraRecovered: vi.fn(), currentGameTurn: () => 4 }))
vi.mock("./webrtc/media", () => {
  class CameraError extends Error {
    constructor(
      readonly reason: string,
      detail = reason,
      readonly late?: Promise<unknown>,
    ) {
      super(detail)
    }
  }
  return {
    CameraError,
    getLocalMedia: vi.fn(async () => {
      const reason = failNext.shift()
      if (reason) throw new CameraError(reason)
      const slow = slowNext.shift()
      if (slow === undefined) return fakeStream()
      const answer = new Promise<FakeStream>((resolve) => setTimeout(() => resolve(fakeStream()), slow))
      const timeoutMs = 6000
      if (slow <= timeoutMs) return answer
      await new Promise((resolve) => setTimeout(resolve, timeoutMs))
      throw new CameraError("timeout", `no answer in ${timeoutMs}ms`, answer)
    }),
  }
})

const { attachCameraPreview, cameraRecoveryGaveUp, cameraState, cameraTapState, holdCamera, openCamera, requestCameraJoinCheck, subscribeCamera, tapCamera, waitForCamera } = await import("./camera")
const { getLocalMedia } = await import("./webrtc/media")
const { cameraRecovering, cameraRecovered } = await import("./journeys/game-trace")
const { recorded, resetRecorded } = await import("./telemetry/testing")
const { getCameraDiagnosticSnapshot, resetCameraDiagnosticsForTest } = await import("./camera-diagnostics")
const { reportPageActivity } = await import("./page-lifecycle")

function trackOf(stream: MediaStream | null): FakeTrack {
  return (stream as unknown as FakeStream).getVideoTracks()[0]!
}
function idOf(stream: MediaStream | null): number {
  return (stream as unknown as FakeStream).id
}
function current(): MediaStream | null {
  const state = cameraState()
  return state.kind === "live" ? state.stream : null
}
/** a fake <video> presenting a stream: attach it, then call frame() to
 *  present a frame, as attachCameraPreview's observer would */
function preview(stream: MediaStream, options: { paused?: boolean; rejectPlay?: boolean; pendingPlay?: boolean } = {}) {
  let callback: VideoFrameRequestCallback | undefined
  const video = {
    srcObject: stream,
    currentTime: 0,
    readyState: 4,
    paused: options.paused ?? false,
    play: vi.fn(async () => {
      if (options.pendingPlay) return new Promise<void>(() => {})
      if (options.rejectPlay) throw new DOMException("blocked", "NotAllowedError")
      video.paused = false
    }),
    requestVideoFrameCallback: vi.fn((next: VideoFrameRequestCallback) => ((callback = next), 1)),
    cancelVideoFrameCallback: vi.fn(),
  }
  return { video, frame: () => callback?.(performance.now(), {} as VideoFrameCallbackMetadata) }
}

afterEach(async () => {
  setVisible(true)
  failNext.length = 0
  slowNext.length = 0
  mutedNext = 0
  // let every hold lapse, so each test starts with the camera off
  await vi.advanceTimersByTimeAsync(60_000)
  vi.useRealTimers()
  vi.mocked(getLocalMedia).mockClear()
  stopped.length = 0
  resetRecorded()
  resetCameraDiagnosticsForTest()
  vi.mocked(cameraRecovering).mockClear()
  vi.mocked(cameraRecovered).mockClear()
})

describe("holding the camera", () => {
  it("hands one stream from the waiting room to the game without reopening it", async () => {
    vi.useFakeTimers()
    const releaseWaitingRoom = holdCamera()
    const first = await openCamera()
    releaseWaitingRoom()
    // the game's code is still coming off the gateway
    await vi.advanceTimersByTimeAsync(8_000)
    const releaseGame = holdCamera()
    expect(await openCamera()).toBe(first)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    expect(stopped).toEqual([])
    releaseGame()
  })

  it("stops the camera once the last holder has been gone for the grace", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    await openCamera()
    release()
    await vi.advanceTimersByTimeAsync(10_001)
    expect(stopped).toHaveLength(1)
    expect(cameraState().kind).toBe("off")
  })

  it("shares one open between callers asking at once", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const [a, b] = await Promise.all([openCamera(), openCamera()])
    expect(a).toBe(b)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    release()
  })
})

describe("presented-frame health", () => {
  it("reopens once after three visible seconds without a frame and verifies the replacement", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    const view = preview(first!)
    const detachFirst = attachCameraPreview(view.video as unknown as HTMLVideoElement, first!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    const replacement = current()
    expect(replacement).not.toBe(first)
    detachFirst()
    const detachReplacement = attachCameraPreview(view.video as unknown as HTMLVideoElement, replacement!, "open")
    view.frame()
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    expect(recorded.metrics.filter((point) => point.name === "camera.no_frames")).toHaveLength(1)
    expect(recorded.metrics.filter((point) => point.name === "camera.reopen")).toHaveLength(1)
    detachReplacement()
    release()
  })

  it("does not recurse when the replacement also presents no frame", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    const view = preview(first!)
    attachCameraPreview(view.video as unknown as HTMLVideoElement, first!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    attachCameraPreview(view.video as unknown as HTMLVideoElement, current()!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    release()
  })

  it("repairs a stale own-tile attachment before checking its frames", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const old = await openCamera()
    const replacement = await openCamera(true)
    const view = preview(old!)
    requestCameraJoinCheck()
    const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, old!, "join")
    expect(view.video.srcObject).toBe(replacement)
    expect(recorded.metrics.filter((point) => point.name === "camera.stale_attachment")).toHaveLength(1)
    view.frame()
    detach()
    release()
  })

  it("cancels recovery once the last holder releases", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const currentStream = await openCamera()
    const view = preview(currentStream!)
    attachCameraPreview(view.video as unknown as HTMLVideoElement, currentStream!, "open")
    release()
    await vi.advanceTimersByTimeAsync(3_001)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
  })

  it("closes one incident when a later replacement generation presents a frame", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    const view = preview(first!)
    const detachFirst = attachCameraPreview(view.video as unknown as HTMLVideoElement, first!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    const intermediate = current()
    trackOf(intermediate).dispatchEvent(new Event("ended"))
    await vi.advanceTimersByTimeAsync(0)
    const latest = current()
    expect(latest).not.toBe(intermediate)
    detachFirst()
    const detachLatest = attachCameraPreview(view.video as unknown as HTMLVideoElement, latest!, "join")
    await vi.advanceTimersByTimeAsync(0)
    view.frame()
    expect(cameraRecovered).toHaveBeenCalled()
    detachLatest()
    release()
  })

  it("bounds an incident three seconds after the replacement becomes live", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    const view = preview(first!)
    attachCameraPreview(view.video as unknown as HTMLVideoElement, first!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    const detachReplacement = attachCameraPreview(view.video as unknown as HTMLVideoElement, current()!, "join")
    await vi.advanceTimersByTimeAsync(2_999)
    expect(cameraRecovered).not.toHaveBeenCalledWith("no-frame")
    await vi.advanceTimersByTimeAsync(1)
    expect(cameraRecovered).toHaveBeenCalledWith("no-frame")
    detachReplacement()
    release()
  })

  it("gives a replacement a fresh visible timeout after the page returns", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    const view = preview(first!)
    attachCameraPreview(view.video as unknown as HTMLVideoElement, first!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    const replacement = current()!
    attachCameraPreview(view.video as unknown as HTMLVideoElement, replacement, "join")
    reportPageActivity(true, true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(cameraRecovered).not.toHaveBeenCalledWith("no-frame")
    reportPageActivity(false, true)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(cameraRecovered).not.toHaveBeenCalledWith("no-frame")
    await vi.advanceTimersByTimeAsync(1)
    expect(cameraRecovered).toHaveBeenCalledWith("no-frame")
    release()
  })

  it("checks a replacement that attaches after an observerless handover gap", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    const view = preview(first!)
    const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, first!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    const replacement = current()!
    detach()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(cameraRecovered).toHaveBeenCalledWith("unresolved")

    const gameView = preview(replacement)
    const detachGame = attachCameraPreview(gameView.video as unknown as HTMLVideoElement, replacement, "join")
    gameView.frame()
    expect(recorded.metrics.filter((point) => point.name === "camera.first_frame_ms")).toHaveLength(1)
    detachGame()
    release()
  })

  it("detects no frames even while play remains pending forever", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const stream = await openCamera()
    const view = preview(stream!, { paused: true, pendingPlay: true })
    const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, stream!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    detach()
    release()
  })

  it("allows only one no-frame reopen per minute", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    const view = preview(first!)
    const detachFirst = attachCameraPreview(view.video as unknown as HTMLVideoElement, first!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    const replacement = current()
    detachFirst()
    const detachReplacement = attachCameraPreview(view.video as unknown as HTMLVideoElement, replacement!, "open")
    await vi.advanceTimersByTimeAsync(0)
    view.frame()
    detachReplacement()

    const next = await openCamera(true)
    const nextView = preview(next!)
    const detachNext = attachCameraPreview(nextView.video as unknown as HTMLVideoElement, next!, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(3)
    expect(recorded.metrics.filter((point) => point.name === "camera.reopen")).toHaveLength(1)
    expect(recorded.metrics.filter((point) => point.name === "camera.reopen_blocked")).toHaveLength(1)
    detachNext()
    release()
  })

  it("caps no-frame reopens at three per camera session", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    let stream = (await openCamera())!
    for (let attempt = 0; attempt < 3; attempt++) {
      const view = preview(stream)
      const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, stream, "open")
      await vi.advanceTimersByTimeAsync(3_000)
      const replacement = current()!
      detach()
      const detachReplacement = attachCameraPreview(view.video as unknown as HTMLVideoElement, replacement, "open")
      await vi.advanceTimersByTimeAsync(0)
      view.frame()
      detachReplacement()
      stream = replacement
      if (attempt < 2) {
        await vi.advanceTimersByTimeAsync(60_000)
        stream = (await openCamera(true))!
      }
    }
    await vi.advanceTimersByTimeAsync(60_000)
    stream = (await openCamera(true))!
    const blockedView = preview(stream)
    const detachBlocked = attachCameraPreview(blockedView.video as unknown as HTMLVideoElement, stream, "open")
    const opensBefore = vi.mocked(getLocalMedia).mock.calls.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(opensBefore)
    expect(recorded.metrics.filter((point) => point.name === "camera.reopen")).toHaveLength(3)
    expect(recorded.metrics.filter((point) => point.name === "camera.reopen_blocked")).toHaveLength(1)
    detachBlocked()
    release()
  })

  // spends the three-per-session no-frames budget, then lets a fourth silent camera hit it
  async function giveUp() {
    let stream = (await openCamera())!
    for (let attempt = 0; attempt < 3; attempt++) {
      const view = preview(stream)
      const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, stream, "open")
      await vi.advanceTimersByTimeAsync(3_000)
      const replacement = current()!
      detach()
      const detachReplacement = attachCameraPreview(view.video as unknown as HTMLVideoElement, replacement, "open")
      await vi.advanceTimersByTimeAsync(0)
      view.frame()
      detachReplacement()
      await vi.advanceTimersByTimeAsync(60_000)
      stream = (await openCamera(true))!
    }
    const blockedView = preview(stream)
    const detach = attachCameraPreview(blockedView.video as unknown as HTMLVideoElement, stream, "open")
    await vi.advanceTimersByTimeAsync(3_000)
    return detach
  }

  it("tells the player to restart the app once the no-frames budget is spent (#1338)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    expect(cameraRecoveryGaveUp()).toBe(false)
    const detach = await giveUp()
    expect(cameraRecoveryGaveUp()).toBe(true)
    detach()
    release()
  })

  it("tells the player to restart when the forced reopen is silent too (#1338)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const stream = (await openCamera())!
    const view = preview(stream)
    const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, stream, "open")
    await vi.advanceTimersByTimeAsync(3_000) // reopens once
    expect(cameraRecoveryGaveUp()).toBe(false)
    const replacement = current()!
    detach()
    const detachReplacement = attachCameraPreview(view.video as unknown as HTMLVideoElement, replacement, "open")
    await vi.advanceTimersByTimeAsync(3_000) // the replacement is silent as well
    expect(cameraRecoveryGaveUp()).toBe(true)
    detachReplacement()
    release()
  })

  it("drops the restart notice when a later camera generation presents a frame (#1338)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const detach = await giveUp()
    expect(cameraRecoveryGaveUp()).toBe(true)
    detach()
    await vi.advanceTimersByTimeAsync(60_000)
    const stream = (await openCamera(true))!
    const view = preview(stream)
    const detachNew = attachCameraPreview(view.video as unknown as HTMLVideoElement, stream, "open")
    await vi.advanceTimersByTimeAsync(0)
    view.frame()
    expect(cameraRecoveryGaveUp()).toBe(false)
    detachNew()
    release()
  })

  it("records later freeze episodes after each shown edge", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    await openCamera()
    reportPageActivity(true, true)
    reportPageActivity(false, true)
    reportPageActivity(true, true)
    reportPageActivity(false, true)
    expect(getCameraDiagnosticSnapshot().trail.filter((entry) => entry.event === "page.frozen")).toHaveLength(2)
    expect(getCameraDiagnosticSnapshot().trail.filter((entry) => entry.event === "page.shown" && entry.suspended === true)).toHaveLength(2)
    release()
  })
})

describe("no camera, no game", () => {
  it("reports a camera that cannot be opened, with the reason", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("denied")
    expect(await openCamera()).toBeNull()
    expect(cameraState()).toEqual({ kind: "unavailable", reason: "denied" })
    release()
  })

  it("retries a busy camera by itself, at a steady pace", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("busy")
    await openCamera()
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    expect(cameraState().kind).toBe("live")
    release()
  })

  it("does not reopen when the last holder releases before a retry fires", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("busy")
    await openCamera()
    release()
    await vi.advanceTimersByTimeAsync(2_001)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
  })

  it("does not retry a refusal by itself, but does when the player comes back", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("denied")
    await openCamera()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    // off to the settings to allow the camera, and back
    setVisible(false)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    expect(cameraState().kind).toBe("live")
    release()
  })

  it("keeps a room waiting until the camera opens", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("busy")
    let got: MediaStream | null | undefined
    void waitForCamera().then((stream) => (got = stream))
    await vi.advanceTimersByTimeAsync(0)
    expect(got).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2_001) // the retry
    expect(got).toBe(current())
    release()
  })

  it("remembers a holder-less hidden open when a holder arrives before return", async () => {
    vi.useFakeTimers()
    setVisible(false)
    const waiting = waitForCamera()
    await vi.advanceTimersByTimeAsync(0)
    expect(getLocalMedia).not.toHaveBeenCalled()

    const release = holdCamera()
    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(await waiting).toBe(current())
    expect(getLocalMedia).toHaveBeenCalledOnce()
    release()
  })

  it("lets a room that closes stop waiting", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("denied")
    const abort = new AbortController()
    const waiting = waitForCamera(abort.signal)
    abort.abort()
    expect(await waiting).toBeNull()
    release()
  })
})

describe("recovery", () => {
  it("reopens a camera whose track ended, as Android does to a background app", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    trackOf(first).readyState = "ended"
    trackOf(first).dispatchEvent(new Event("ended"))
    await vi.advanceTimersByTimeAsync(0)
    expect(current()).not.toBe(first)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    release()
  })

  it("waits for the page to be in front before reopening", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    setVisible(false)
    trackOf(first).readyState = "ended"
    trackOf(first).dispatchEvent(new Event("ended"))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    release()
  })

  it("leaves a camera that unmutes on its own, as iOS does on return", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    trackOf(first).dispatchEvent(new Event("mute"))
    expect(cameraState()).toMatchObject({ kind: "live", muted: true })
    await vi.advanceTimersByTimeAsync(1_000)
    trackOf(first).dispatchEvent(new Event("unmute"))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(current()).toBe(first)
    expect(cameraState()).toMatchObject({ muted: false })
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    release()
  })

  it("reopens a camera that stays muted in front of the player", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    trackOf(first).dispatchEvent(new Event("mute"))
    await vi.advanceTimersByTimeAsync(3_001)
    expect(current()).not.toBe(first)
    expect(stopped).toContain(idOf(first))
    release()
  })

  it("backs the still-muted reopen off 3 s, 6 s, 12 s and keeps the 12 s cap once the tap is offered (#1539)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      const opens = () => vi.mocked(getLocalMedia).mock.calls.length
      const before = opens()
      // the real stuck-camera pattern: each reopen comes back UNMUTED and
      // mutes again 500 ms later. The reopen must back off 3 s, 6 s, 12 s
      // instead of looping every 3 s, and keep going at the 12 s cap once
      // the tap is offered (Ionut, 27 Nov).
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const stream = current()!
        await vi.advanceTimersByTimeAsync(500)
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync([3_000, 6_000, 12_000, 12_000, 12_000, 12_000][attempt]!)
        expect(opens()).toBe(before + attempt + 1)
        if (attempt === 2) expect(cameraTapState().tap).toBe("offered")
      }
      // the offer is still up: the automatic reopens after it did not clear it
      expect(cameraTapState().tap).toBe("offered")
    } finally {
      release()
    }
  })

  it("restarts the tap episode on a healthy reopen, so a later incident reports its own dead_ms (#1535)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      const first = await openCamera()
      await vi.advanceTimersByTimeAsync(500)
      trackOf(first).muted = true
      trackOf(first).dispatchEvent(new Event("mute"))
      await vi.advanceTimersByTimeAsync(3_000)
      const healthy = current()!
      expect(healthy).not.toBe(first) // a healthy reopen, no frame seen yet
      // present a frame on the healthy camera: genuinely healthy
      const view = preview(healthy)
      const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, healthy, "open")
      view.frame()
      detach()
      await vi.advanceTimersByTimeAsync(60_000) // much later, a new incident

      // the still-muted reopen backs off 3 s, 6 s, 12 s (#1539); each
      // replacement mutes again 500 ms after it opens, as a stuck camera does
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stream = current()!
        await vi.advanceTimersByTimeAsync(500)
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync([3_000, 6_000, 12_000][attempt]!)
      }
      // no tap is offered on slow mutes; unmute to end the episode, then run
      // a fresh quick-streak incident (replacements muted from the start) so
      // the tap is offered and its report proves the episode restarted
      trackOf(current()!).dispatchEvent(new Event("unmute"))
      await vi.advanceTimersByTimeAsync(0)
      mutedNext = 3
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stream = current()!
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync([3_000, 6_000, 12_000][attempt]!)
        if (attempt === 2) expect(cameraTapState().tap).toBe("offered")
      }
      failNext.push("busy")
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      // the episode began at the new incident, not 60+ s earlier (#1535)
      expect(recorded.cameraRestores[0]?.deadMs).toBeLessThan(30_000)
    } finally {
      release()
    }
  })

  it("does not reopen a still-muted camera after its last holder leaves", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    release()
    trackOf(first).muted = true
    trackOf(first).dispatchEvent(new Event("mute"))
    await vi.advanceTimersByTimeAsync(3_001)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
  })

  it("counts tracks already muted when opened as quick and offers the tap", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    mutedNext = 2
    await vi.advanceTimersByTimeAsync(500)
    trackOf(first).muted = true
    trackOf(first).dispatchEvent(new Event("mute"))
    // the still-muted reopen backs off 3 s, 6 s, 12 s (#1539), so the third
    // quick check — the one that offers the tap — lands at 21 s
    await vi.advanceTimersByTimeAsync(21_000)
    expect(cameraTapState().tap).toBe("offered")
    // an unmute still resets the backoff while the tap is offered: the next
    // mute's check reopens at the 3 s grace again, not the 12 s cap
    trackOf(current()!).dispatchEvent(new Event("unmute"))
    await vi.advanceTimersByTimeAsync(0)
    const opensBefore = vi.mocked(getLocalMedia).mock.calls.length
    const stream = current()!
    trackOf(stream).muted = true
    trackOf(stream).dispatchEvent(new Event("mute"))
    await vi.advanceTimersByTimeAsync(3_001)
    expect(vi.mocked(getLocalMedia).mock.calls.length).toBe(opensBefore + 1)
    release()
  })

  it("starts a later offered episode at the later mute after a healthy replacement frame", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    await vi.advanceTimersByTimeAsync(500)
    trackOf(first).muted = true
    trackOf(first).dispatchEvent(new Event("mute"))
    await vi.advanceTimersByTimeAsync(3_000)
    const healthy = current()!
    const view = preview(healthy)
    const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, healthy, "open")
    view.frame()
    detach()
    await vi.advanceTimersByTimeAsync(60_000)

    // the still-muted reopen backs off 3 s, 6 s, 12 s (#1539) — the presented
    // frame above reset the backoff counter, so the first of these lands at
    // the 3 s grace; each replacement mutes again 500 ms after it opens
    const opensAtStart = vi.mocked(getLocalMedia).mock.calls.length
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = current()!
      await vi.advanceTimersByTimeAsync(500)
      trackOf(stream).muted = true
      trackOf(stream).dispatchEvent(new Event("mute"))
      await vi.advanceTimersByTimeAsync([3_000, 6_000, 12_000][attempt]!)
      expect(vi.mocked(getLocalMedia).mock.calls.length).toBe(opensAtStart + attempt + 1)
    }
    failNext.push("busy")
    tapCamera()
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded.cameraRestores[0]?.deadMs).toBeLessThan(30_000)
    release()
  })

  it("offers after three quick still-muted tracks and adopts the stream opened synchronously by the tap", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    await openCamera()
    // the still-muted reopen backs off 3 s, 6 s, 12 s (#1539); each
    // replacement mutes again 500 ms after it opens, so every check reads
    // quick and the tap is offered on the third
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = current()!
      await vi.advanceTimersByTimeAsync(500)
      trackOf(stream).muted = true
      trackOf(stream).dispatchEvent(new Event("mute"))
      await vi.advanceTimersByTimeAsync([3_000, 6_000, 12_000][attempt]!)
    }
    expect(cameraTapState()).toMatchObject({ tap: "offered", opening: false })

    let adopted: MediaStream | null = null
    const unsubscribe = subscribeCamera(() => {
      const camera = cameraState()
      if (camera.kind === "live") adopted = camera.stream
    })
    const callsBefore = vi.mocked(getLocalMedia).mock.calls.length
    tapCamera()
    expect(getLocalMedia).toHaveBeenCalledTimes(callsBefore + 1)
    expect(cameraTapState().tap).toBe("tapping")
    await vi.advanceTimersByTimeAsync(0)
    expect(adopted).toBe(current())
    unsubscribe()
    release()
  })

  it("spends a busy tap after exactly one open and raises the restart notice", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    await openCamera()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = current()!
      await vi.advanceTimersByTimeAsync(500)
      trackOf(stream).muted = true
      trackOf(stream).dispatchEvent(new Event("mute"))
      await vi.advanceTimersByTimeAsync([3_000, 6_000, 12_000][attempt]!)
    }
    failNext.push("busy")
    const callsBefore = vi.mocked(getLocalMedia).mock.calls.length
    tapCamera()
    await vi.advanceTimersByTimeAsync(0)

    expect(getLocalMedia).toHaveBeenCalledTimes(callsBefore + 1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(callsBefore + 1)
    expect(cameraTapState().tap).toBe("spent")
    expect(cameraRecoveryGaveUp()).toBe(true)
    expect(cameraState()).toEqual({ kind: "unavailable", reason: "busy" })
    expect(recorded.cameraRestores).toEqual([
      expect.objectContaining({ turnShown: 4, autoRetries: 2, tapped: true, outcome: "error", error: "busy" }),
    ])
    release()
  })

  it("records still_muted when a tapped stream frames and then mutes inside five seconds", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    let detach: (() => void) | undefined
    try {
      await openCamera()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stream = current()!
        await vi.advanceTimersByTimeAsync(500)
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync([3_000, 6_000, 12_000][attempt]!)
      }
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      const tapped = current()!
      const view = preview(tapped)
      detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, tapped, "open")
      view.frame()
      trackOf(tapped).muted = true
      trackOf(tapped).dispatchEvent(new Event("mute"))

      expect(recorded.cameraRestores).toEqual([
        expect.objectContaining({ tapped: true, outcome: "still_muted", frames5s: 1 }),
      ])
      expect(cameraTapState().tap).toBe("spent")
      expect(cameraRecoveryGaveUp()).toBe(true)
      // the automatic still-muted loop keeps going after a spent tap (#1539,
      // Ionut 27 Nov): the tapped observer's frame does not reset the backoff
      // counter (only a presented-frame check, an unmute or a page return
      // does), so the loop is already at the 12 s cap; each replacement
      // stream re-mutes from the start and every 12 s check reopens the camera
      mutedNext = 3
      const opensBefore = vi.mocked(getLocalMedia).mock.calls.length
      await vi.advanceTimersByTimeAsync(12_001)
      expect(vi.mocked(getLocalMedia).mock.calls.length).toBe(opensBefore + 1)
      await vi.advanceTimersByTimeAsync(12_001)
      expect(vi.mocked(getLocalMedia).mock.calls.length).toBe(opensBefore + 2)
      await vi.advanceTimersByTimeAsync(12_001)
      expect(vi.mocked(getLocalMedia).mock.calls.length).toBe(opensBefore + 3)
    } finally {
      detach?.()
      release()
    }
  })

  it("stops watching once the camera is released", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    release()
    await vi.advanceTimersByTimeAsync(10_001)
    trackOf(first).dispatchEvent(new Event("ended"))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
  })
})

describe("reporting a camera that cannot open", () => {
  const cameraFailures = () => recorded.failures.filter((failure) => failure.kind === "camera-unavailable")

  it("sends one event per outage, not one per retry", async () => {
    vi.useFakeTimers()
    failNext.push("busy", "busy", "busy")
    const release = holdCamera()
    await openCamera()
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000)
    expect(vi.mocked(getLocalMedia).mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(cameraState().kind).toBe("live")
    expect(cameraFailures()).toHaveLength(1)
    expect(cameraFailures()[0]).toMatchObject({ details: { reason: "busy", context: { open: "first" } }, expected: false })
    release()
  })

  it("reports a new outage after the camera came back, as a recovery", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const stream = await openCamera()
    failNext.push("busy")
    trackOf(stream).readyState = "ended"
    trackOf(stream).dispatchEvent(new Event("ended"))
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraFailures()).toHaveLength(1)
    expect(cameraFailures()[0].details.context).toMatchObject({ open: "recovery" })
    release()
  })
})

describe("telling the game trace about a recovery", () => {
  it("opens a recovery when a live track ends, and closes it when the camera is back", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const stream = await openCamera()
    trackOf(stream).readyState = "ended"
    trackOf(stream).dispatchEvent(new Event("ended"))
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraRecovering).toHaveBeenCalledWith("track-ended")
    expect(cameraRecovered).toHaveBeenCalled()
    release()
  })
})

describe("a cold first open (issue 226)", () => {
  const cameraFailures = () => recorded.failures.filter((failure) => failure.kind === "camera-unavailable")
  const metric = (name: string) => recorded.metrics.filter((point) => point.name === name)

  it("keeps a first open that answers late instead of opening the camera a second time", async () => {
    vi.useFakeTimers()
    slowNext.push(12_000)
    const release = holdCamera()
    void openCamera()
    await vi.advanceTimersByTimeAsync(6_001)
    // the player is told, and the open goes on
    expect(cameraState()).toEqual({ kind: "unavailable", reason: "timeout" })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(cameraState().kind).toBe("live")
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    expect(stopped).toEqual([])
    release()
  })

  it("takes a late camera that answers in the same moment the open gives up", async () => {
    vi.useFakeTimers()
    const { CameraError } = await import("./webrtc/media")
    const answered = fakeStream()
    vi.mocked(getLocalMedia).mockImplementationOnce(async () => {
      throw new CameraError("timeout", "no answer in 6000ms", Promise.resolve(answered as unknown as MediaStream))
    })
    const release = holdCamera()
    await openCamera()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(current()).toBe(answered)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    expect(stopped).toEqual([])
    release()
  })

  it("makes a retry wait for the open still in flight rather than open alongside it", async () => {
    vi.useFakeTimers()
    slowNext.push(25_000)
    const release = holdCamera()
    void openCamera()
    await vi.advanceTimersByTimeAsync(24_000) // past the timeout and the first retry
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(cameraState().kind).toBe("live")
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    release()
  })

  it("opens again once a late open is past the ceiling, and closes the late one if it ever comes", async () => {
    vi.useFakeTimers()
    slowNext.push(60_000)
    const release = holdCamera()
    void openCamera()
    await vi.advanceTimersByTimeAsync(30_001)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    const second = current()
    expect(second).not.toBeNull()
    await vi.advanceTimersByTimeAsync(30_000)
    // the late camera came, and was closed rather than taken
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).not.toBe(idOf(second))
    expect(current()).toBe(second)
    release()
  })

  it("waits for the page to be in front before the first open", async () => {
    vi.useFakeTimers()
    setVisible(false)
    const release = holdCamera()
    void openCamera()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getLocalMedia).not.toHaveBeenCalled()
    expect(cameraFailures()).toHaveLength(0)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    expect(cameraState().kind).toBe("live")
    release()
  })

  it("never stops retrying by itself, even a camera it cannot find", async () => {
    vi.useFakeTimers()
    failNext.push("no-camera")
    const release = holdCamera()
    await openCamera()
    await vi.advanceTimersByTimeAsync(2_001)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    expect(cameraState().kind).toBe("live")
    release()
  })

  it("says in the failure how many attempts and how long, and whether the page was hidden", async () => {
    vi.useFakeTimers()
    slowNext.push(12_000)
    const release = holdCamera()
    void openCamera()
    await vi.advanceTimersByTimeAsync(1_000)
    setVisible(false)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(cameraFailures()).toHaveLength(1)
    expect(cameraFailures()[0]!.details.context).toMatchObject({
      open: "first",
      attempts: "1",
      since_first_ms: "6000",
      hidden: "true",
    })
    release()
  })

  it("keeps a busy camera on 2 s waits, and a later failure continues the backoff where the busy retries left it", async () => {
    vi.useFakeTimers()
    failNext.push("busy", "busy", "busy", "busy", "unknown", "unknown")
    const release = holdCamera()
    await openCamera()
    await vi.advanceTimersByTimeAsync(4 * 2_000 + 2_000 + 4_000)
    expect(metric("camera.retry").map((point) => [point.attrs["camera.reason"], point.attrs["camera.wait_ms"]])).toEqual([
      ["busy", "2000"],
      ["busy", "2000"],
      ["busy", "2000"],
      ["busy", "2000"],
      ["unknown", "10000"],
    ])
    release()
  })

  it("backs off a failure other than busy, without the 2 s busy pace", async () => {
    vi.useFakeTimers()
    failNext.push("unknown", "unknown", "unknown")
    const release = holdCamera()
    await openCamera()
    await vi.advanceTimersByTimeAsync(2_000 + 4_000)
    expect(metric("camera.retry").map((point) => point.attrs["camera.wait_ms"])).toEqual(["2000", "4000", "8000"])
    release()
  })

  it("counts every retry with its attempt, reason and wait", async () => {
    vi.useFakeTimers()
    failNext.push("busy", "busy")
    const release = holdCamera()
    await openCamera()
    await vi.advanceTimersByTimeAsync(2_000 + 4_000)
    expect(metric("camera.retry").map((point) => point.attrs)).toEqual([
      { "camera.open": "first", "camera.reason": "busy", "camera.attempt": "1", "camera.wait_ms": "2000", "camera.trigger": "open" },
      { "camera.open": "first", "camera.reason": "busy", "camera.attempt": "2", "camera.wait_ms": "2000", "camera.trigger": "open" },
    ])
    release()
  })

  it("records the time from the first attempt to the first live camera, once", async () => {
    vi.useFakeTimers()
    failNext.push("busy", "busy")
    const release = holdCamera()
    await openCamera()
    await vi.advanceTimersByTimeAsync(2_000 + 4_000)
    expect(cameraState().kind).toBe("live")
    expect(metric("camera.first_open_ms")).toEqual([
      {
        type: "distribution",
        name: "camera.first_open_ms",
        value: 4_000,
        unit: "millisecond",
        attrs: { "camera.attempts": "3", "camera.late": "false" },
      },
    ])
    release()
  })

  it("marks a first open that answered late", async () => {
    vi.useFakeTimers()
    slowNext.push(12_000)
    const release = holdCamera()
    void openCamera()
    await vi.advanceTimersByTimeAsync(12_001)
    expect(metric("camera.first_open_ms")[0]).toMatchObject({ value: 12_000, attrs: { "camera.attempts": "1", "camera.late": "true" } })
    release()
  })
})

describe("a hidden page and a refusal (#226 review)", () => {
  const cameraFailures = () => recorded.failures.filter((failure) => failure.kind === "camera-unavailable")
  const metric = (name: string) => recorded.metrics.filter((point) => point.name === name)

  it("retries one return denial after a short wake beat without exposing or reporting it", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    setVisible(false)
    trackOf(first).readyState = "ended"
    trackOf(first).dispatchEvent(new Event("ended"))
    failNext.push("denied")

    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraState()).toEqual({ kind: "opening" })
    expect(cameraFailures()).toHaveLength(0)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(499)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(cameraState().kind).toBe("live")
    expect(getLocalMedia).toHaveBeenCalledTimes(3)
    expect(cameraFailures()).toHaveLength(0)
    expect(metric("camera.retry").map((point) => point.attrs)).toEqual([
      {
        "camera.open": "recovery",
        "camera.reason": "denied",
        "camera.attempt": "1",
        "camera.wait_ms": "500",
        "camera.trigger": "return",
      },
    ])
    release()
  })

  it("reports one denial when the return retry is also denied", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    const first = await openCamera()
    setVisible(false)
    trackOf(first).readyState = "ended"
    trackOf(first).dispatchEvent(new Event("ended"))
    failNext.push("denied", "denied")

    setVisible(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(cameraState()).toEqual({ kind: "unavailable", reason: "denied" })
    expect(cameraFailures()).toHaveLength(1)
    expect(cameraFailures()[0]).toMatchObject({
      details: { reason: "denied", context: { open: "recovery", attempts: "2", hidden: "true" } },
      expected: true,
    })
    expect(getLocalMedia).toHaveBeenCalledTimes(3)
    release()
  })

  it("still exposes and reports a denial that was not triggered by a return", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("denied")
    await openCamera()
    expect(cameraState()).toEqual({ kind: "unavailable", reason: "denied" })
    expect(cameraFailures()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    release()
  })

  it("schedules and counts no retry while the page is hidden, and reopens once on return", async () => {
    vi.useFakeTimers()
    slowNext.push(100_000) // never answers in time
    const release = holdCamera()
    void openCamera()
    await vi.advanceTimersByTimeAsync(1_000)
    setVisible(false) // the timeout lands while hidden
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cameraState()).toEqual({ kind: "unavailable", reason: "timeout" })
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    expect(metric("camera.retry")).toHaveLength(0)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    expect(cameraState().kind).toBe("live")
    release()
  })

  it("defers a pending retry that fires after the page becomes hidden", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    failNext.push("busy")
    await openCamera()
    setVisible(false)
    await vi.advanceTimersByTimeAsync(2_001)
    expect(getLocalMedia).toHaveBeenCalledTimes(1)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getLocalMedia).toHaveBeenCalledTimes(2)
    expect(cameraState().kind).toBe("live")
    release()
  })

  it("gives a returned refusal one retry, never a loop", async () => {
    vi.useFakeTimers()
    failNext.push("denied", "denied", "denied")
    const release = holdCamera()
    await openCamera()
    setVisible(false)
    setVisible(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getLocalMedia).toHaveBeenCalledTimes(3)
    release()
  })

  it("stops the camera it does not keep when a late answer lands on a live one", async () => {
    vi.useFakeTimers()
    const { CameraError } = await import("./webrtc/media")
    let answer!: (stream: MediaStream) => void
    const late = new Promise<MediaStream>((resolve) => (answer = resolve))
    vi.mocked(getLocalMedia).mockImplementationOnce(async () => {
      throw new CameraError("timeout", "no answer in 6000ms", late)
    })
    const release = holdCamera()
    await openCamera()
    // past the ceiling a fresh open goes live
    await vi.advanceTimersByTimeAsync(30_001)
    const fresh = current()
    expect(fresh).not.toBeNull()
    answer(fakeStream() as unknown as MediaStream)
    await vi.advanceTimersByTimeAsync(0)
    expect(current()).toBe(fresh)
    expect(stopped).toHaveLength(1)
    release()
  })
})
