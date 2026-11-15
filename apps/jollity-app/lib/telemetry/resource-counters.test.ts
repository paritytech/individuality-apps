// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest"
import { EMPTY_PAGE_RESOURCE_COUNTERS, readPageResourceCounters, RESOURCE_COUNTERS_INIT_SCRIPT } from "./resource-counters"
import { setupMesh } from "../webrtc/test-pc"

const install = () => (new Function(RESOURCE_COUNTERS_INIT_SCRIPT) as () => void)()

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __jollityResourceCounters?: unknown }).__jollityResourceCounters
})

describe("page resource counters", () => {
  it("reads live peer, WebGL, video resolution, canvas and DOM load", () => {
    class Peer {
      connectionState = "connected"
      signalingState = "stable"
    }
    const gl = { isContextLost: () => false }
    class Canvas {
      getContext() { return gl }
    }
    const videos = [
      { srcObject: {}, videoWidth: 640, videoHeight: 360 },
      { srcObject: {}, videoWidth: 1280, videoHeight: 720 },
      { srcObject: null, videoWidth: 1920, videoHeight: 1080 },
    ]
    vi.stubGlobal("RTCPeerConnection", Peer)
    vi.stubGlobal("HTMLCanvasElement", Canvas)
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) => selector === "video" ? videos : selector === "canvas" ? [{}, {}] : [],
      getElementsByTagName: () => Array.from({ length: 17 }),
    })
    install()
    new RTCPeerConnection()
    new HTMLCanvasElement().getContext("webgl")
    expect(readPageResourceCounters()).toMatchObject({
      installed: true,
      peerConnections: 1,
      glContexts: 1,
      glLive: 1,
      videos: 3,
      videosWithStream: 2,
      videoMaxWidth: 1280,
      videoMaxHeight: 720,
      videoPixels: 1_152_000,
      videoResolutions: "640x360,1280x720",
      canvases: 2,
      domNodes: 17,
    })
  })

  it("keeps native constructor and getContext results when diagnostic hooks throw", () => {
    const nativeContext = { isContextLost: () => false }
    class Peer { marker = "native" }
    class Canvas { getContext() { return nativeContext } }
    vi.stubGlobal("RTCPeerConnection", Peer)
    vi.stubGlobal("HTMLCanvasElement", Canvas)
    vi.stubGlobal("WeakRef", class { constructor() { throw new Error("registry unavailable") } })
    install()
    expect(new RTCPeerConnection()).toMatchObject({ marker: "native" })
    expect(new HTMLCanvasElement().getContext("webgl")).toBe(nativeContext)
  })

  it("counts a connection constructed through the mesh's captured constructor", async () => {
    vi.stubGlobal("document", {
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
    })
    vi.stubGlobal("RTCPeerConnection", class {})
    install()
    // setupMesh replaces the global after the hook was installed, matching a
    // bundled mesh that captured its constructor before beforeInteractive ran.
    const { mesh } = await setupMesh("a", "b")
    expect(readPageResourceCounters()).toMatchObject({ installed: true, peerConnections: 1 })
    mesh.close()
  })

  it("fails closed to zeros when no registry or DOM exists", () => {
    expect(readPageResourceCounters()).toEqual(EMPTY_PAGE_RESOURCE_COUNTERS)
  })
})
