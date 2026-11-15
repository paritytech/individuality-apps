// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

export interface PageResourceCounters {
  installed: boolean
  peerConnections: number
  glContexts: number
  glLive: number
  glLost: number
  videos: number
  videosWithStream: number
  videoMaxWidth: number
  videoMaxHeight: number
  videoPixels: number
  videoResolutions: string
  canvases: number
  domNodes?: number
}

export const EMPTY_PAGE_RESOURCE_COUNTERS: PageResourceCounters = {
  installed: false,
  peerConnections: 0,
  glContexts: 0,
  glLive: 0,
  glLost: 0,
  videos: 0,
  videosWithStream: 0,
  videoMaxWidth: 0,
  videoMaxHeight: 0,
  videoPixels: 0,
  videoResolutions: "none",
  canvases: 0,
  domNodes: 0,
}

interface ResourceCounterState {
  peerConnections: WeakRef<RTCPeerConnection>[]
  glContexts: WeakRef<WebGLRenderingContext | WebGL2RenderingContext>[]
  seenPeers?: WeakSet<RTCPeerConnection>
}

/** The mesh resolves its constructor at module load, which can precede the
 * beforeInteractive wrapper in a bundled module graph. Register at the actual
 * construction seam as well; the weak set makes wrapper + seam idempotent. */
export function registerPagePeerConnection(peer: RTCPeerConnection): void {
  try {
    const state = (globalThis as typeof globalThis & { __jollityResourceCounters?: ResourceCounterState }).__jollityResourceCounters
    if (!state) return
    state.seenPeers ??= new WeakSet()
    if (state.seenPeers.has(peer)) return
    state.seenPeers.add(peer)
    const retained = state.peerConnections.filter((ref) => { try { return !!ref.deref() } catch { return false } })
    state.peerConnections.splice(0, state.peerConnections.length, ...retained, new WeakRef(peer))
  } catch {
    /* diagnostics never affect the connection */
  }
}

/** Installed before application modules run. Every hook returns the native
 * result even when the diagnostic registry itself fails. */
export const RESOURCE_COUNTERS_INIT_SCRIPT = String.raw`(() => {
  try {
    if (globalThis.__jollityResourceCounters) return
    const state = { peerConnections: [], glContexts: [], seenPeers: new WeakSet(), seenGl: new WeakSet() }
    globalThis.__jollityResourceCounters = state
    const remember = (list, value) => {
      try {
        const retained = list.filter((ref) => { try { return !!ref.deref() } catch { return false } })
        list.splice(0, list.length, ...retained, new WeakRef(value))
      } catch {}
    }

    try {
      if (globalThis.RTCPeerConnection) {
        const NativePeerConnection = globalThis.RTCPeerConnection
        class CountedPeerConnection extends NativePeerConnection {
          constructor(...args) {
            super(...args)
            try {
              if (!state.seenPeers.has(this)) {
                state.seenPeers.add(this)
                remember(state.peerConnections, this)
              }
            } catch {}
          }
        }
        Object.setPrototypeOf(CountedPeerConnection, NativePeerConnection)
        globalThis.RTCPeerConnection = CountedPeerConnection
      }
    } catch {}

    try {
      if (globalThis.HTMLCanvasElement) {
        const nativeGetContext = HTMLCanvasElement.prototype.getContext
        HTMLCanvasElement.prototype.getContext = function (...args) {
          const context = nativeGetContext.apply(this, args)
          try {
            const kind = String(args[0] || "")
            if (context && (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") && !state.seenGl.has(context)) {
              state.seenGl.add(context)
              remember(state.glContexts, context)
            }
          } catch {}
          return context
        }
      }
    } catch {}
  } catch {}
})()`

function collectPageResourceCounters(includeDom: boolean): PageResourceCounters | null {
  try {
    const state = (globalThis as typeof globalThis & {
      __jollityResourceCounters?: ResourceCounterState
    }).__jollityResourceCounters
    if (!state) return null
    const alive = <T extends object>(refs: WeakRef<T>[]): T[] => {
      const values: T[] = []
      const retainedRefs: WeakRef<T>[] = []
      for (const ref of refs) {
        try {
          const value = ref.deref()
          if (value) { values.push(value); retainedRefs.push(ref) }
        } catch {}
      }
      try { refs.splice(0, refs.length, ...retainedRefs) } catch {}
      return values
    }
    const peerConnections = alive(state.peerConnections)
    const glContexts = alive(state.glContexts)
    const videos = [...document.querySelectorAll("video")]
    const liveVideos = videos.filter((video) => video.srcObject != null)
    const resolutions = liveVideos.map((video) => [Number(video.videoWidth) || 0, Number(video.videoHeight) || 0])
    let domNodes: number | undefined
    if (includeDom) {
      try { domNodes = document.getElementsByTagName("*").length } catch { /* unavailable in minimal pages/test contexts */ }
    }
    return {
      installed: true,
      peerConnections: peerConnections.filter((pc) => pc.connectionState !== "closed" && pc.signalingState !== "closed").length,
      glContexts: glContexts.length,
      glLive: glContexts.filter((gl) => typeof gl.isContextLost !== "function" || !gl.isContextLost()).length,
      glLost: glContexts.filter((gl) => typeof gl.isContextLost === "function" && gl.isContextLost()).length,
      videos: videos.length,
      videosWithStream: liveVideos.length,
      videoMaxWidth: Math.max(0, ...resolutions.map(([width]) => width)),
      videoMaxHeight: Math.max(0, ...resolutions.map(([, height]) => height)),
      videoPixels: resolutions.reduce((total, [width, height]) => total + width * height, 0),
      videoResolutions: [...new Set(resolutions.map(([width, height]) => width + "x" + height))].slice(0, 8).join(",") || "none",
      canvases: document.querySelectorAll("canvas").length,
      ...(domNodes === undefined ? {} : { domNodes }),
    }
  } catch { return null }
}

export function readPageResourceCounters(includeDom = true): PageResourceCounters {
  try {
    return collectPageResourceCounters(includeDom) ?? { ...EMPTY_PAGE_RESOURCE_COUNTERS }
  } catch {
    return { ...EMPTY_PAGE_RESOURCE_COUNTERS }
  }
}
