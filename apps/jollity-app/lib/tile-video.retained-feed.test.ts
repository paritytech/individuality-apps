// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const R = vi.hoisted(() => {
  type Cell = { value?: unknown; deps?: unknown[]; cleanup?: () => void }
  const cells: Cell[] = []
  let cursor = 0
  let body: (() => void) | null = null
  const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const render = () => {
    cursor = 0
    body?.()
  }
  const useRef = <T,>(value: T) => {
    const i = cursor++
    return (cells[i] ??= { value: { current: value } }).value as { current: T }
  }
  const useState = <T,>(value: T) => {
    const i = cursor++
    cells[i] ??= { value }
    return [cells[i].value as T, (next: T | ((old: T) => T)) => {
      cells[i].value = typeof next === "function" ? (next as (old: T) => T)(cells[i].value as T) : next
    }] as const
  }
  const useEffect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = cursor++
    if (cells[i] && same(cells[i].deps, deps)) return
    cells[i]?.cleanup?.()
    const cleanup = fn()
    cells[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }
  }
  return {
    useRef,
    useState,
    useCallback: <T,>(fn: T, deps: unknown[]) => {
      const i = cursor++
      if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn, deps }
      return cells[i].value as T
    },
    useEffect,
    useLayoutEffect: useEffect,
    mount(fn: () => void) {
      cells.splice(0)
      body = fn
      render()
    },
    rerender: render,
    unmount() {
      cells.forEach((cell) => cell.cleanup?.())
      cells.splice(0)
      body = null
    },
  }
})

vi.mock("react", () => ({
  useRef: R.useRef,
  useState: R.useState,
  useCallback: R.useCallback,
  useEffect: R.useEffect,
  useLayoutEffect: R.useLayoutEffect,
}))
vi.mock("@/lib/camera", () => ({ attachCameraPreview: vi.fn() }))
vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("@/lib/video-playback", async () => await import("./video-playback"))
vi.mock("@/lib/camera-frame", async () => await import("./camera-frame"))
vi.mock("@/lib/peer-video-observation", async () => await import("./peer-video-observation"))

import { useTileVideo } from "../components/game/tile/tile-video"
import type { RemoteVideoObservation } from "./peer-video-observation"

type Track = MediaStreamTrack & { unmute(): void }

function remoteTrack(muted: boolean): Track {
  const listeners = new Set<() => void>()
  return {
    kind: "video",
    muted,
    readyState: "live",
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "unmute" && typeof listener === "function") listeners.add(listener as () => void)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "unmute" && typeof listener === "function") listeners.delete(listener as () => void)
    },
    unmute() {
      Object.assign(this, { muted: false })
      for (const listener of listeners) listener()
    },
  } as unknown as Track
}

describe("retained remote feed observation", () => {
  let stream: MediaStream
  let replacement: MediaStream
  let replacementTrack: Track
  let video: HTMLVideoElement
  let frameCallbacks: Map<number, VideoFrameRequestCallback>
  let nextFrame: number
  let marks: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    const originalTrack = remoteTrack(false)
    replacementTrack = remoteTrack(true)
    stream = { getVideoTracks: () => [originalTrack] } as unknown as MediaStream
    replacement = { getVideoTracks: () => [replacementTrack] } as unknown as MediaStream
    frameCallbacks = new Map()
    nextFrame = 1
    marks = vi.fn()
    video = {
      srcObject: null,
      readyState: 2,
      currentTime: 0,
      paused: false,
      ended: false,
      play: vi.fn(async () => {}),
      remove: vi.fn(),
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => {
        const id = nextFrame++
        frameCallbacks.set(id, callback)
        return id
      }),
      cancelVideoFrameCallback: vi.fn((id: number) => frameCallbacks.delete(id)),
      className: "",
    } as unknown as HTMLVideoElement
    vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 })
    vi.stubGlobal("document", { visibilityState: "visible", createElement: () => video })
  })

  afterEach(() => {
    R.unmount()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const frame = () => {
    const callbacks = [...frameCallbacks.values()]
    frameCallbacks.clear()
    for (const callback of callbacks) callback(0, {} as VideoFrameCallbackMetadata)
  }

  function mount() {
    const observation: RemoteVideoObservation = {
      key: "peer-a",
      generation: 0,
      accept: () => true,
      onFirstFrame: (_video, current) => {
        if (current()) marks()
      },
      onWindow: () => {},
    }
    R.mount(() => useTileVideo(stream, false, undefined, false, observation))
    // A state update made by the attachment effect is committed by React on
    // the next render; the tiny hook harness drives that render explicitly.
    R.rerender()
  }

  function replace() {
    stream = replacement
    R.rerender()
    expect(video.srcObject).not.toBe(replacement)
    // This callback belongs to the element while its retained old feed is
    // still showing. It must neither promote nor consume the replacement's
    // one-shot first-frame evidence.
    frame()
    expect(marks).not.toHaveBeenCalled()
  }

  it.each([
    ["track unmute", () => replacementTrack.unmute()],
    ["warmup timeout", () => vi.advanceTimersByTime(4_000)],
  ])("renews the real frame observer when the replacement is shown by %s", (_label, show) => {
    mount()
    replace()
    show()
    R.rerender()
    expect(video.srcObject).toBe(replacement)
    frame()
    expect(marks).toHaveBeenCalledOnce()
  })
})
