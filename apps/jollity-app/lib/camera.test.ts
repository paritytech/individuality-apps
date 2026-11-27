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
 *  present a frame, as attachCameraPreview's observer would. Like a real
 *  element, it keeps one pending callback PER watcher (#1539 review: the
 *  normal preview watcher and the tap watcher both see the tapped stream's
 *  first frame), so frame() fires every registered callback. */
function preview(stream: MediaStream, options: { paused?: boolean; rejectPlay?: boolean; pendingPlay?: boolean } = {}) {
  let nextHandle = 0
  const callbacks = new Map<number, VideoFrameRequestCallback>()
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
    requestVideoFrameCallback: vi.fn((next: VideoFrameRequestCallback) => {
      const handle = ++nextHandle
      callbacks.set(handle, next)
      return handle
    }),
    cancelVideoFrameCallback: vi.fn((handle: number) => {
      callbacks.delete(handle)
    }),
  }
  return {
    video,
    frame: () => {
      for (const callback of [...callbacks.values()]) callback(performance.now(), {} as VideoFrameCallbackMetadata)
    },
  }
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

  it("keeps the 3 s cadence until the tap is offered (~9 s), then backs off 6 s, 12 s at the cap (#1539, Ionut 27 Nov)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      const opens = () => vi.mocked(getLocalMedia).mock.calls.length
      const before = opens()
      // the real stuck-camera pattern: each reopen comes back UNMUTED and
      // mutes again 500 ms later. The reopen keeps the 3 s cadence until the
      // tap is offered (the third still-muted check, ~9 s in), then backs
      // off 6 s, then 12 s, and keeps going at the 12 s cap once the tap is
      // offered or spent (Ionut, 27 Nov).
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const stream = current()!
        await vi.advanceTimersByTimeAsync(500)
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync([3_000, 3_000, 3_000, 6_000, 12_000, 12_000, 12_000][attempt]!)
        expect(opens()).toBe(before + attempt + 1)
        if (attempt === 2) expect(cameraTapState().tap).toBe("offered")
      }
      // the offer is still up: the automatic reopens after it did not clear it
      expect(cameraTapState().tap).toBe("offered")
    } finally {
      release()
    }
  })

  it("does not restart the tap episode on an unmuted reopen, so the report counts the whole dead span (#1535)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      // the real stuck-camera pattern: each reopen comes back UNMUTED and
      // mutes again 500 ms later, and no frame is ever presented. The 3 s
      // cadence holds until the tap is offered on the third check (~9 s).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stream = current()!
        await vi.advanceTimersByTimeAsync(500)
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync(3_000)
      }
      expect(cameraTapState().tap).toBe("offered")
      // the tap works: the tapped stream presents a frame
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      const tapped = current()!
      const view = preview(tapped)
      const detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, tapped, "open")
      view.frame()
      await vi.advanceTimersByTimeAsync(5_000) // the tap's frame window closes with frames
      detach()
      // the report counts the whole dead span (~10 s from the first mute),
      // not just the last one (~3 s): the unmuted reopens in between must
      // not have restarted the episode (#1535)
      expect(recorded.cameraRestores).toHaveLength(1)
      expect(recorded.cameraRestores[0]?.deadMs).toBeGreaterThanOrEqual(9_000)

      // a later incident after that healthy frame reports its own dead_ms
      await vi.advanceTimersByTimeAsync(60_000)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const stream = current()!
        await vi.advanceTimersByTimeAsync(500)
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync(3_000)
      }
      expect(cameraTapState().tap).toBe("offered")
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      const tapped2 = current()!
      const view2 = preview(tapped2)
      const detach2 = attachCameraPreview(view2.video as unknown as HTMLVideoElement, tapped2, "open")
      view2.frame()
      await vi.advanceTimersByTimeAsync(5_000)
      detach2()
      expect(recorded.cameraRestores).toHaveLength(2)
      expect(recorded.cameraRestores[1]?.deadMs).toBeLessThan(30_000)
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
    // the 3 s cadence holds until the tap is offered, so the third quick
    // check — the one that offers the tap — lands at 9 s (#1539, Ionut 27 Nov)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(cameraTapState().tap).toBe("offered")
    // an unmute no longer resets the backoff while the tap is offered (A'):
    // the next mute's check waits the 6 s step after check 3, not 3 s
    trackOf(current()!).dispatchEvent(new Event("unmute"))
    await vi.advanceTimersByTimeAsync(0)
    const opensBefore = vi.mocked(getLocalMedia).mock.calls.length
    const stream = current()!
    trackOf(stream).muted = true
    trackOf(stream).dispatchEvent(new Event("mute"))
    await vi.advanceTimersByTimeAsync(3_001)
    expect(vi.mocked(getLocalMedia).mock.calls.length).toBe(opensBefore) // A': a brief unmute is not health
    await vi.advanceTimersByTimeAsync(3_000)
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

    // the 3 s cadence holds until the tap is offered (#1539, Ionut 27 Nov) —
    // the presented frame above reset the backoff counter, so each of these
    // lands at the 3 s grace; each replacement mutes again 500 ms after it
    // opens
    const opensAtStart = vi.mocked(getLocalMedia).mock.calls.length
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = current()!
      await vi.advanceTimersByTimeAsync(500)
      trackOf(stream).muted = true
      trackOf(stream).dispatchEvent(new Event("mute"))
      await vi.advanceTimersByTimeAsync(3_000)
      expect(vi.mocked(getLocalMedia).mock.calls.length).toBe(opensAtStart + attempt + 1)
    }
    failNext.push("busy")
    tapCamera()
    await vi.advanceTimersByTimeAsync(0)
    expect(recorded.cameraRestores[0]?.deadMs).toBeLessThan(15_000)
    release()
  })

  it("offers after three quick still-muted tracks and adopts the stream opened synchronously by the tap", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    await openCamera()
    // the 3 s cadence holds until the tap is offered (#1539, Ionut 27 Nov);
    // each replacement mutes again 500 ms after it opens, so every check
    // reads quick and the tap is offered on the third, ~9 s in
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = current()!
      await vi.advanceTimersByTimeAsync(500)
      trackOf(stream).muted = true
      trackOf(stream).dispatchEvent(new Event("mute"))
      await vi.advanceTimersByTimeAsync(3_000)
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
      await vi.advanceTimersByTimeAsync(3_000)
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
      expect.objectContaining({ turnShown: 4, autoRetries: 3, tapped: true, outcome: "error", error: "busy" }),
    ])
    release()
  })

  it("retries a busy tap error at the 12 s cap, but a denied one never reopens by itself (#1539 Q3)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      const offerTap = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const stream = current()!
          await vi.advanceTimersByTimeAsync(500)
          trackOf(stream).muted = true
          trackOf(stream).dispatchEvent(new Event("mute"))
          await vi.advanceTimersByTimeAsync(3_000)
        }
        expect(cameraTapState().tap).toBe("offered")
      }
      const opens = () => vi.mocked(getLocalMedia).mock.calls.length

      // busy: the tap's own open is the only one at first, the 12 s retry
      // fires exactly once at 12 s, not before
      await offerTap()
      failNext.push("busy")
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      expect(cameraState()).toEqual({ kind: "unavailable", reason: "busy" })
      const afterTap = opens()
      await vi.advanceTimersByTimeAsync(11_999)
      expect(opens()).toBe(afterTap)
      await vi.advanceTimersByTimeAsync(1)
      expect(opens()).toBe(afterTap + 1)
      expect(cameraState().kind).toBe("live")
      // the spent tap gives no second offer in the same episode: only 12 s
      // of unmuted quiet (healthy) ends it, so the next mutes start afresh
      await vi.advanceTimersByTimeAsync(12_000)
      expect(cameraTapState().tap).toBe("none")

      // denied: terminal — no automatic reopen even long after
      await offerTap()
      failNext.push("denied")
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      expect(cameraState()).toEqual({ kind: "unavailable", reason: "denied" })
      const afterDenied = opens()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(opens()).toBe(afterDenied)
      expect(cameraState()).toEqual({ kind: "unavailable", reason: "denied" })
    } finally {
      release()
    }
  })

  it("counts every still-muted check of the episode in autoRetries (#1539 Q2)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      // five still-muted checks: waits 3,3,3,6,12; the tap is offered on the
      // third check, the tap error lands after the fifth
      for (const wait of [3_000, 3_000, 3_000, 6_000, 12_000]) {
        const stream = current()!
        await vi.advanceTimersByTimeAsync(500)
        trackOf(stream).muted = true
        trackOf(stream).dispatchEvent(new Event("mute"))
        await vi.advanceTimersByTimeAsync(wait)
      }
      expect(cameraTapState().tap).toBe("offered")
      failNext.push("busy")
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      expect(recorded.cameraRestores[0]).toMatchObject({ autoRetries: 5, outcome: "error", error: "busy" })
    } finally {
      release()
    }
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
        await vi.advanceTimersByTimeAsync(3_000)
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
      // Ionut 27 Nov) at the 12 s cap: the tapped stream's frame does NOT
      // reset the backoff (a frame while tapping is not health), and the fake
      // video now hands that frame to the normal preview watcher too, exactly
      // as the real app does — so the loop stays at the cap instead of
      // restarting at 3 s. Each replacement stream re-mutes from the start.
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

describe("review #1539 design rows", () => {
  const opens = () => vi.mocked(getLocalMedia).mock.calls.length
  async function cycle(muteAfterMs: number, frameAtMs?: number) {
    const stream = current()!
    let detach: (() => void) | undefined
    if (frameAtMs !== undefined) {
      await vi.advanceTimersByTimeAsync(frameAtMs)
      const view = preview(stream)
      detach = attachCameraPreview(view.video as unknown as HTMLVideoElement, stream, "open")
      view.frame()
      await vi.advanceTimersByTimeAsync(muteAfterMs - frameAtMs)
    } else await vi.advanceTimersByTimeAsync(muteAfterMs)
    trackOf(stream).muted = true
    trackOf(stream).dispatchEvent(new Event("mute"))
    detach?.()
  }
  async function expectWait(waitMs: number) {
    const before = opens()
    await vi.advanceTimersByTimeAsync(waitMs - 1)
    expect(opens(), `no reopen before ${waitMs}`).toBe(before)
    await vi.advanceTimersByTimeAsync(1)
    expect(opens(), `reopen at ${waitMs}`).toBe(before + 1)
  }

  it("row 2: slow mutes (+2.5 s, no preview) back off 3,3,3,6,12,12 and never offer", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      for (const wait of [3_000, 3_000, 3_000, 6_000, 12_000, 12_000]) { await cycle(2_500); await expectWait(wait) }
      expect(cameraTapState().tap).toBe("none")
    } finally { release() }
  })

  it("row 2 with a preview: frame at +0.1 s, mute at +2.5 s still backs off", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      for (const wait of [3_000, 3_000, 3_000, 6_000, 12_000, 12_000]) { await cycle(2_500, 100); await expectWait(wait) }
    } finally { release() }
  })

  it("row 13: quick mute after a presented frame keeps the episode and the offer, and backs off", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      for (const [i, wait] of [3_000, 3_000, 3_000, 6_000, 12_000].entries()) {
        await cycle(500, 200); await expectWait(wait)
        if (i >= 2) expect(cameraTapState().tap).toBe("offered")
      }
      failNext.push("busy")
      tapCamera()
      await vi.advanceTimersByTimeAsync(0)
      expect(recorded.cameraRestores[0]?.deadMs).toBeGreaterThanOrEqual(9_000)
    } finally { release() }
  })

  it("row 3: quick, slow, quick, quick offers on check 4 and waits 3,3,3,6,12", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      // a slow check sets the streak back to 1, so the third quick-in-a-row
      // check is the fourth one; the wait is indexed by the check count alone
      for (const [i, [muteAfter, wait]] of ([[500, 3_000], [2_500, 3_000], [500, 3_000], [500, 6_000], [500, 12_000]] as const).entries()) {
        await cycle(muteAfter); await expectWait(wait)
        expect(cameraTapState().tap).toBe(i >= 3 ? "offered" : "none")
      }
    } finally { release() }
  })

  it("boundary: re-mute 11.9 s after the frame keeps the backoff; 13 s resets it", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      for (const wait of [3_000, 3_000, 3_000, 6_000]) { await cycle(500); await expectWait(wait) }
      await cycle(11_900 + 100, 100); await expectWait(12_000)
      await cycle(13_000 + 100, 100); await expectWait(3_000)
    } finally { release() }
  })

  it("no preview: a reopen that stays unmuted 12 s is health (armed at goLive), drops the tap and resets the backoff", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      for (const wait of [3_000, 3_000, 3_000, 6_000]) { await cycle(500); await expectWait(wait) }
      expect(cameraTapState().tap).toBe("offered")
      await vi.advanceTimersByTimeAsync(300_000) // five healthy minutes
      expect(cameraTapState().tap, "tap button still up after 5 healthy minutes").toBe("none")
      await cycle(0); await expectWait(3_000)
    } finally { release() }
  })

  it("row 7: hiding cancels the health timer and resets the backoff; the return re-checks at 3 s (#1539)", async () => {
    vi.useFakeTimers()
    const release = holdCamera()
    try {
      await openCamera()
      // build the backoff up first, so the 3 s grace after the return proves
      // the hide reset it; the last reopen is unmuted, so its health timer is
      // armed at goLive and the hide 5 s later must cancel it
      for (const wait of [3_000, 3_000, 3_000, 6_000]) { await cycle(500); await expectWait(wait) }
      expect(cameraTapState().tap).toBe("offered")
      await vi.advanceTimersByTimeAsync(5_000)
      setVisible(false)
      const opensWhileHidden = opens()
      await vi.advanceTimersByTimeAsync(60_000)
      // no healthy fired while hidden (the timer was cancelled on hide), and
      // nothing opened a camera from the background
      expect(cameraTapState().tap).toBe("none")
      expect(opens()).toBe(opensWhileHidden)
      setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      // the hide reset the backoff: the first still-muted check after the
      // return waits the 3 s grace again
      const stream = current()!
      trackOf(stream).muted = true
      trackOf(stream).dispatchEvent(new Event("mute"))
      const afterMute = opens()
      await vi.advanceTimersByTimeAsync(2_999)
      expect(opens(), "reopened before the 3 s grace").toBe(afterMute)
      await vi.advanceTimersByTimeAsync(1)
      expect(opens(), "no reopen at the 3 s grace").toBe(afterMute + 1)
    } finally { release() }
  })
})
