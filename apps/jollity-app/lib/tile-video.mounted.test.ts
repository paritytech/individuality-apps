// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest"

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

const camera = vi.hoisted(() => ({
  watchers: [] as { options: { onFirstFrame(): void; onWindow(): void; onTimeout(): void }; stop: ReturnType<typeof vi.fn> }[],
}))
vi.mock("./telemetry", async () => (await import("./telemetry/testing")).fakeTelemetryModule())
vi.mock("@/lib/video-playback", async () => await import("./video-playback"))
vi.mock("@/lib/camera-frame", () => ({
  observeCameraFrames: (_video: HTMLVideoElement, options: { onFirstFrame(): void; onWindow(): void; onTimeout(): void }) => {
    const watcher = { options, stop: vi.fn() }
    camera.watchers.push(watcher)
    return watcher
  },
}))
vi.mock("@/lib/camera", () => ({ attachCameraPreview: vi.fn() }))
vi.mock("@/lib/peer-video-observation", async () => await import("./peer-video-observation"))
vi.mock("./snapshot-quality", () => ({
  SNAPSHOT_MIN_SOURCE_EDGE: 1,
  SNAPSHOT_SIZE: 2,
  snapshotScore: () => ({ ok: true, score: { sharpness: 1, brightness: 1, sourceEdge: 2 } }),
}))

import { useTileVideo } from "../components/game/tile/tile-video"
import { acceptFirstRemoteFrame, type RemoteVideoObservation } from "./peer-video-observation"
import { useSnapshots, type SnapshotCandidates } from "./use-snapshots"

describe("mounted remote observer lifecycle", () => {
  let stream: MediaStream
  let track: { readyState: MediaStreamTrackState }
  let key: string
  let snapshots: SnapshotCandidates
  let marks: ReturnType<typeof vi.fn<() => boolean>>
  let blobs: ((blob: Blob | null) => void)[]
  let revoked: string[]

  beforeEach(() => {
    camera.watchers = []
    track = { readyState: "live" }
    stream = { getVideoTracks: () => [track] } as unknown as MediaStream
    key = "peer-a"
    marks = vi.fn(() => true)
    blobs = []
    revoked = []
    const video = {
      srcObject: null,
      videoWidth: 2,
      videoHeight: 2,
      readyState: 2,
      paused: false,
      ended: false,
      play: vi.fn(async () => {}),
      remove: vi.fn(),
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      className: "",
    } as unknown as HTMLVideoElement
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(16) }) }),
      toBlob: (resolve: (blob: Blob | null) => void) => blobs.push(resolve),
    }
    vi.stubGlobal("document", { createElement: (tag: string) => (tag === "video" ? video : canvas) })
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:${blobs.length}`),
      revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
    })
  })

  it("suppresses stale callbacks and late canvas results across replacement, timeout and unmount", async () => {
    const Mounted = () => {
      snapshots = useSnapshots(false)
      const observation: RemoteVideoObservation = {
        key,
        generation: 0,
        accept: () => true,
        onFirstFrame: (video, current) =>
          void acceptFirstRemoteFrame(current, marks, () => snapshots.offer(key, video, false, current)),
        onWindow: (video, current) => snapshots.offer(key, video, false, current),
      }
      useTileVideo(stream, false, undefined, false, observation)
    }
    R.mount(Mounted)
    R.rerender()
    expect(camera.watchers).toHaveLength(1)
    camera.watchers[0].options.onFirstFrame()
    expect(marks).toHaveBeenCalledOnce()
    expect(blobs).toHaveLength(1)

    track = { readyState: "live" }
    stream = { getVideoTracks: () => [track] } as unknown as MediaStream
    key = "peer-b"
    R.rerender()
    R.rerender()
    expect(camera.watchers).toHaveLength(2)
    expect(camera.watchers[0].stop).toHaveBeenCalledOnce()
    camera.watchers[0].options.onFirstFrame()
    camera.watchers[0].options.onWindow()
    expect(marks).toHaveBeenCalledOnce()
    blobs[0](new Blob(["old"]))
    await Promise.resolve()
    await Promise.resolve()
    expect(revoked).toEqual(["blob:1"])
    expect(snapshots.photoFor("peer-a")).toBeUndefined()

    camera.watchers[1].options.onTimeout()
    expect(marks).toHaveBeenCalledOnce()
    camera.watchers[1].options.onFirstFrame()
    expect(marks).toHaveBeenCalledTimes(2)
    R.unmount()
    camera.watchers[1].options.onWindow()
    expect(blobs).toHaveLength(2)
    blobs[1](new Blob(["new-but-unmounted"]))
    await Promise.resolve()
    await Promise.resolve()
    expect(revoked).toEqual(["blob:1", "blob:2"])
  })

  it("does not promote an ended receiver when Chromium presents its synthetic close frame", () => {
    const Mounted = () => {
      const observation: RemoteVideoObservation = {
        key,
        generation: 0,
        accept: () => true,
        onFirstFrame: (_video, current) => void acceptFirstRemoteFrame(current, marks, () => {}),
        onWindow: () => {},
      }
      useTileVideo(stream, false, undefined, false, observation)
    }
    R.mount(Mounted)
    R.rerender()
    expect(camera.watchers).toHaveLength(1)

    // Native Chromium queues one black rVFC while closing a trackless
    // receiver. The associated remote track is ended by then, so it is not a
    // decoded peer-camera frame and must not create durable vote evidence.
    track.readyState = "ended"
    camera.watchers[0].options.onFirstFrame()
    expect(marks).not.toHaveBeenCalled()
  })

  // In Low Power Mode, iOS forces native controls onto a video with the autoplay attribute
  it("makes the tile video without the autoplay attribute", () => {
    let get: (() => HTMLVideoElement) | undefined
    R.mount(() => {
      get = useTileVideo(stream, false, undefined)
    })
    const video = get!()
    expect(video.autoplay).not.toBe(true)
    expect(vi.mocked(video.setAttribute).mock.calls.map(([name]) => name)).not.toContain("autoplay")
    R.unmount()
  })
})
