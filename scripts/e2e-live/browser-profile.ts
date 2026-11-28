// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Apply a bot Profile (profile.ts) to a Playwright context/page WITHOUT the
// journey knowing the details: the journey calls contextOptionsFor() when it
// makes the context and applyPageProfile() before the first goto, and gets the
// device, CPU limit, slow camera, shifted clock and background switch for free.
//
// Everything here is Chromium-only (CI runs Chromium): CPU throttling is CDP,
// the fake-media flags are Chromium flags. The scripts that run in the page
// are built as plain text (`*Script` functions) so tests can run them in a vm
// without a browser.
//
// "baseline" (profiles.ts) is NOT a profile here: botProfile() returns null for
// it and every caller then does what the journey did before profiles existed
// (390x844 Chromium viewport, the config's launch args, nothing injected).
//
// FAKE CAMERA FILE. Identity-specific 360p/720p Y4M clips are generated outside
// the repository and selected through E2E_FAKE_VIDEO_DIR. Boot runs generate a
// neutral harness clip; reserved game baseline keeps Chromium's own pattern.

import { devices, type BrowserContextOptions, type CDPSession, type Page } from "@playwright/test"
import { existsSync, readFileSync } from "node:fs"
import type { Check } from "./chain-checks"
import { identityFor, loadProfiles, type Profile, type TelemetryTorture } from "./profile"
import { profileForName } from "./profiles"
import { crewIdentity, type CrewIdentity } from "./crew/catalogue"
import { harnessCameraClipPath, identityCameraClipPath } from "./crew/camera-clip"
import { identityGesturePosePath } from "./crew/camera-frame"
import type { RolePlan } from "./roles"

const FALLBACK_VIEWPORT = { width: 390, height: 844 }

export function contextOptionsFor(profile: Profile): BrowserContextOptions {
  const d = (devices as Record<string, Record<string, unknown>>)[profile.device]
  if (!d) throw new Error(`unknown Playwright device ${JSON.stringify(profile.device)}`)
  // defaultBrowserType is a launch concern; newContext throws if it is set.
  const descriptor = { ...d }
  delete descriptor.defaultBrowserType
  // the device's SCREEN, not its `viewport`: Playwright's viewport already
  // subtracts the browser's own bars (iPhone 14: 390x664), while the journey
  // and the workbench's phone frame have always been the full 390x844
  const viewport = (d.screen ?? d.viewport ?? FALLBACK_VIEWPORT) as { width: number; height: number }
  return {
    ...descriptor,
    viewport,
    // a denied camera is a context WITHOUT the permission (and getUserMedia rejects, cameraBlockScript)
    permissions: profile.camera.mode === "denied" ? [] : ["camera"],
    ...(profile.locale && { locale: profile.locale }),
    ...(profile.timezoneId && { timezoneId: profile.timezoneId }),
  }
}

/** E2E_PROFILE's name -> its Profile, or null for the reserved "baseline" (profiles.ts). */
export const botProfile = (name: string | undefined, profiles: Profile[] = loadProfiles()): Profile | null => profileForName(name, profiles)

/** The fake-camera flags; a profile may pick the clip by resolution (null = baseline: Chromium's own pattern). */
export function chromiumArgsFor(profile: Profile | null, env: Record<string, string | undefined> = process.env): string[] {
  const args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
  const y4m = cameraClip(profile, env)
  if (y4m) args.push(`--use-file-for-fake-video-capture=${y4m}`)
  return args
}

/** The identity camera source, or the neutral harness source for boot-only runs. */
export function cameraClip(profile: Profile | null, env: Record<string, string | undefined> = process.env): string | undefined {
  const fallback = profile ? env[profile.camera.resolution === "360p" ? "E2E_FAKE_VIDEO_360P" : "E2E_FAKE_VIDEO_720P"] : undefined
  const dir = env.E2E_FAKE_VIDEO_DIR
  if (!dir) return fallback
  if (env.E2E_STAGE === "boot") {
    const name = profile?.name ?? env.E2E_PROFILE ?? "baseline"
    if (!/^[a-z0-9-]+$/.test(name)) return fallback
    const path = harnessCameraClipPath(dir, name, profile?.camera.resolution ?? "720p")
    return existsSync(path) ? path : fallback
  }
  if (!profile || (env.E2E_NETWORK && env.E2E_NETWORK !== "previewnet")) return fallback
  const username = identityFor(profile, "previewnet")
  if (!username) return fallback
  const identity = crewIdentity(username)
  const path = identityCameraClipPath(dir, identity.key, profile.camera.resolution)
  return existsSync(path) ? path : fallback
}

/** The one predicate used by both injection and the journey. Fresh-pool and
 * reserved profiles deliberately have no generated identity poses. */
export function hostGestureIdentity(profile: Profile | null, env: Record<string, string | undefined> = process.env): CrewIdentity | null {
  if (!profile || env.E2E_STAGE === "boot" || env.E2E_NETWORK !== "previewnet") return null
  const username = identityFor(profile, "previewnet")
  if (!username) return null
  try {
    const identity = crewIdentity(username)
    return existsSync(identityGesturePosePath(identity, "a")) && existsSync(identityGesturePosePath(identity, "b")) ? identity : null
  } catch {
    return null
  }
}

/** Shift Date.now() / new Date() / Date() by offsetS; performance.now() is untouched.
 *  The offset lives in globalThis.__e2eClockOffMs, so a jump mid-game (jumpClock) just rewrites it. */
export function clockScript(offsetS: number): string {
  return `(() => {
  globalThis.__e2eClockOffMs = ${JSON.stringify(offsetS * 1000)}
  const R = Date
  function D(...a) {
    if (!new.target) return new R(R.now() + globalThis.__e2eClockOffMs).toString()
    return a.length === 0 ? new R(R.now() + globalThis.__e2eClockOffMs) : new R(...a)
  }
  Object.setPrototypeOf(D, R)
  D.prototype = R.prototype
  D.now = () => R.now() + globalThis.__e2eClockOffMs
  globalThis.Date = D
})()`
}

/** Hold every video getUserMedia call for delayMs, so the first frame arrives late. */
export function cameraDelayScript(delayMs: number): string {
  return `(() => {
  const md = navigator.mediaDevices
  if (!md || !md.getUserMedia) return
  const real = md.getUserMedia.bind(md)
  md.getUserMedia = (c) => c && c.video
    ? new Promise((res) => setTimeout(res, ${JSON.stringify(delayMs)})).then(() => real(c))
    : real(c)
})()`
}

/** A camera that is not there: video getUserMedia rejects with the DOMException a real browser throws
 *  (denied: NotAllowedError, missing: NotFoundError). Audio-less, like the app's own calls. */
export function cameraBlockScript(mode: "denied" | "missing"): string {
  const name = mode === "denied" ? "NotAllowedError" : "NotFoundError"
  const text = mode === "denied" ? "Permission denied" : "Requested device not found"
  return `(() => {
  const md = navigator.mediaDevices
  if (!md || !md.getUserMedia) return
  const real = md.getUserMedia.bind(md)
  md.getUserMedia = (c) => c && c.video ? Promise.reject(new DOMException(${JSON.stringify(text)}, ${JSON.stringify(name)})) : real(c)
})()`
}

/** Platform-bugs#174 acceptance camera: every ordinary video open mutes in
 * under one second. A getUserMedia call made while user activation is live is
 * spared, unless the driver explicitly enables the activation-ignored proof. */
export function cameraMuteLoopScript(): string {
  return `(() => {
  const md = navigator.mediaDevices
  if (!md || !md.getUserMedia) return
  const real = md.getUserMedia.bind(md)
  let ignoreActivation = false
  let activationBypassArmed = false
  let opened = 0
  let muted = 0
  let activationBypasses = 0
  let current = null
  // The app reads the real track.muted (camera.ts goLive, watchTrack), so a
  // dispatched Event("mute") alone leaves it false and the still-muted path
  // never runs. While the persona holds a track muted, its muted reads true;
  // the getter lives on the track instance, so a reused stream (the same track
  // object handed back) keeps reading true until a bypassed open releases it.
  const held = new WeakMap()
  const holdMuted = (track) => {
    if (!track || held.has(track)) return
    held.set(track, Object.getOwnPropertyDescriptor(track, "muted"))
    Object.defineProperty(track, "muted", {
      configurable: true,
      get() { return true },
    })
  }
  const releaseMuted = (track) => {
    if (!track || !held.has(track)) return
    const original = held.get(track)
    held.delete(track)
    // a real MediaStreamTrack keeps muted on its prototype: drop the override and
    // the live value shows through. Anything else gets back exactly what it had.
    if (original) Object.defineProperty(track, "muted", original)
    else delete track.muted
  }
  const mute = (track) => {
    if (!track || track.readyState === "ended") return false
    holdMuted(track)
    track.dispatchEvent(new Event("mute"))
    muted += 1
    return true
  }
  md.getUserMedia = (constraints) => {
    const active = navigator.userActivation?.isActive === true
    const pending = real(constraints)
    if (!constraints || !constraints.video) return pending
    const bypass = active && activationBypassArmed && !ignoreActivation
    activationBypassArmed = false
    opened += 1
    return Promise.resolve(pending).then((stream) => {
      const track = stream.getVideoTracks()[0]
      current = track || null
      if (bypass) {
        // the tap path opened with live activation: this track is the live camera
        activationBypasses += 1
        releaseMuted(track)
      } else if (track) {
        holdMuted(track)
        setTimeout(() => mute(track), 0)
      }
      return stream
    })
  }
  globalThis.__e2eCameraMuteLoop = {
    armActivationBypass: () => { activationBypassArmed = true },
    setIgnoreActivation: (value) => { ignoreActivation = value === true },
    muteCurrent: () => mute(current),
    facts: () => ({ opened, muted, activationBypasses, ignoreActivation }),
  }
})()`
}

export interface CameraMuteLoopFacts {
  opened: number
  muted: number
  activationBypasses: number
  ignoreActivation: boolean
}

export const armCameraMuteLoopActivationBypass = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const control = (globalThis as unknown as { __e2eCameraMuteLoop?: { armActivationBypass(): void } }).__e2eCameraMuteLoop
    if (!control) throw new Error("camera mute-loop control was not installed")
    control.armActivationBypass()
  })

export const readCameraMuteLoop = (page: Page): Promise<CameraMuteLoopFacts> =>
  page.evaluate(() => {
    const control = (globalThis as unknown as { __e2eCameraMuteLoop?: { facts(): CameraMuteLoopFacts } }).__e2eCameraMuteLoop
    if (!control) throw new Error("camera mute-loop control was not installed")
    return control.facts()
  })

export const setCameraMuteLoopIgnoreActivation = (page: Page, value: boolean): Promise<void> =>
  page.evaluate((ignore) => {
    const control = (globalThis as unknown as { __e2eCameraMuteLoop?: { setIgnoreActivation(value: boolean): void } }).__e2eCameraMuteLoop
    if (!control) throw new Error("camera mute-loop control was not installed")
    control.setIgnoreActivation(ignore)
  }, value)

export const muteCameraMuteLoopCurrent = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const control = (globalThis as unknown as { __e2eCameraMuteLoop?: { muteCurrent(): boolean } }).__e2eCameraMuteLoop
    if (!control) throw new Error("camera mute-loop control was not installed")
    return control.muteCurrent()
  })

/** A return-only media switch for video-role E2E profiles. Camera acquisition,
 * permissions and peer setup remain real; only the sender's video track is
 * replaced with null until the driver explicitly enables it. The page-facing
 * facts deliberately expose counts and state, never track/device identifiers. */
function outboundVideoHookScript(mode: "controlled" | "one-way"): string {
  const oneWay = mode === "one-way"
  return `(() => {
  const PC = globalThis.RTCPeerConnection
  if (!PC || !PC.prototype.addTrack) return
  ${oneWay ? faultLogScript("one-way-video") : ""}
  ${oneWay ? peerRecoveryScript("one-way-video") : ""}
  const real = PC.prototype.addTrack
  let videos = []
  let enabled = false
  const closed = (owner) => owner.connectionState === "closed" || owner.signalingState === "closed"
  const liveVideos = () => {
    videos = videos.filter(({ owner }) => !closed(owner))
    return videos
  }
  ${oneWay ? `const suppress = (sender) => {
    const replaceTrack = sender.replaceTrack.bind(sender)
    sender.replaceTrack = () => replaceTrack(null)
    return sender
  }` : ""}
  const replaceLive = async (trackOf) => {
    const current = [...liveVideos()]
    await Promise.all(current.map(async (video) => {
      try {
        await video.sender.replaceTrack(trackOf(video))
      } catch (error) {
        // close() makes replaceTrack reject. That obsolete owner is no longer
        // part of the proof, but a failure on any still-live owner must remain
        // fatal instead of being hidden by the lifecycle guard.
        if (!closed(video.owner)) throw error
      }
    }))
    return liveVideos().length
  }
  PC.prototype.addTrack = function(track, ...streams) {
    if (track && track.kind === "video" && !enabled) {
      // Do not briefly attach the real camera and then remove it. A rebuilt
      // peer connection can encode/present one frame in that asynchronous
      // addTrack -> replaceTrack(null) gap, which defeats the never-video
      // proof even though every later stats sample correctly reads zero.
      const sender = ${oneWay ? "suppress(" : ""}this.addTransceiver("video", { direction: "sendrecv", streams }).sender${oneWay ? ")" : ""}
      videos.push({ owner: this, sender, track })
      ${oneWay ? `const initiatorPeer = this.__jollityE2EPolite === false && typeof this.__jollityE2EPeerId === "string" ? this.__jollityE2EPeerId : null
      report("outgoing-video-" + videos.length, "sender-track=null" + (initiatorPeer ? " initiator-peer=" + initiatorPeer : ""))
      if (initiatorPeer) provePeerRecovered(initiatorPeer)` : ""}
      return sender
    }
    const sender = real.call(this, track, ...streams)
    if (track && track.kind === "video") videos.push({ owner: this, sender, track })
    return sender
  }
  ${oneWay ? `globalThis.__e2ePeerFault = { facts: () => ({ kind: "one-way-video", suppressed: liveVideos().length }) }` : `globalThis.__e2eOutboundVideo = {
    enable: async () => {
      enabled = true
      const senders = await replaceLive(({ track }) => track)
      return { enabled, senders }
    },
    disable: async () => {
      enabled = false
      const senders = await replaceLive(() => null)
      return { enabled, senders }
    },
    facts: () => ({ enabled, senders: liveVideos().length }),
  }`}
})()`
}

export function outboundVideoScript(): string {
  return outboundVideoHookScript("controlled")
}

export type OutboundVideoFacts = { enabled: boolean; senders: number }
/** Enabling the controller is only a request until a real peer sender exists. */
export const outboundVideoIsLive = (facts: OutboundVideoFacts | null): facts is OutboundVideoFacts => !!facts && facts.enabled && facts.senders > 0
export const setOutboundVideo = (page: Page, enabled: boolean): Promise<OutboundVideoFacts> =>
  page.evaluate(async (on) => {
    const control = (globalThis as unknown as { __e2eOutboundVideo?: { enable(): Promise<OutboundVideoFacts>; disable(): Promise<OutboundVideoFacts> } }).__e2eOutboundVideo
    if (!control) throw new Error("outbound video control was not installed")
    return on ? control.enable() : control.disable()
  }, enabled)

export const readOutboundVideo = (page: Page): Promise<OutboundVideoFacts> =>
  page.evaluate(() => {
    const control = (globalThis as unknown as { __e2eOutboundVideo?: { facts(): OutboundVideoFacts } }).__e2eOutboundVideo
    if (!control) throw new Error("outbound video control was not installed")
    return control.facts()
  })

/** Harness-only host animation at the camera source. The app receives one
 * canvas track and remains solely responsible for sender parking/reopens. */
export function hostGestureScript(poseA: string, poseB: string): string {
  const workerSource = `
let reader, writer, canvas, context, active = false, muted = false, poses = null, framesIn = 0, framesOut = 0
const stats = () => postMessage({ type: "stats", framesIn, framesOut })
onmessage = (event) => {
  const message = event.data
  if (message.type === "init") {
    reader = message.readable.getReader()
    writer = message.writable.getWriter()
    canvas = new OffscreenCanvas(message.width, message.height)
    context = canvas.getContext("2d", { alpha: false })
    pump()
  } else if (message.type === "active") {
    active = message.active
    if (message.poses) poses = message.poses
  } else if (message.type === "muted") muted = message.muted
}
async function pump() {
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const frame = result.value
      framesIn += 1
      if (muted) frame.close()
      else if (!active || !poses) {
        await writer.write(frame)
        frame.close()
        framesOut += 1
      } else {
        const phase = (performance.now() % 2000) / 1000
        const mix = phase <= 1 ? phase : 2 - phase
        context.globalAlpha = 1
        context.drawImage(poses[0], 0, 0, canvas.width, canvas.height)
        context.globalAlpha = mix
        context.drawImage(poses[1], 0, 0, canvas.width, canvas.height)
        context.globalAlpha = 1
        const output = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined, alpha: "discard" })
        frame.close()
        await writer.write(output)
        output.close()
        framesOut += 1
      }
      if (framesIn % 30 === 0) stats()
    }
    await writer.close()
  } catch (error) {
    postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
    try { await writer.abort(error) } catch {}
  } finally {
    stats()
  }
}`
  return `(() => {
  const md = navigator.mediaDevices
  if (!md || !md.getUserMedia || !globalThis.MediaStream) return
  const real = md.getUserMedia.bind(md)
  let active = false
  const sources = new Set()
  const workerUrl = URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], { type: "text/javascript" }))
  const decode = (source) => fetch(source).then((response) => {
    if (!response.ok) throw new DOMException("host gesture pose failed to decode", "NotReadableError")
    return response.blob()
  }).then((blob) => createImageBitmap(blob)).catch((error) => {
    throw error instanceof DOMException ? error : new DOMException(error instanceof Error ? error.message : String(error), "NotReadableError")
  })
  const enableSource = async (source) => {
    if (!source.ready) {
      source.readyPromise ??= Promise.all([decode(${JSON.stringify(poseA)}), decode(${JSON.stringify(poseB)})])
        .then((poses) => {
          source.worker.postMessage({ type: "active", active: true, poses }, poses)
          source.ready = true
        })
        .catch(() => {
          source.readyPromise = null
          source.worker.postMessage({ type: "active", active: false })
        })
      await source.readyPromise
    } else source.worker.postMessage({ type: "active", active: true })
  }
  md.getUserMedia = async (constraints) => {
    const native = await real(constraints)
    if (!constraints || !constraints.video) return native
    try {
      const nativeTrack = native.getVideoTracks()[0]
      if (!nativeTrack) return native
      const Processor = globalThis.MediaStreamTrackProcessor
      const Generator = globalThis.MediaStreamTrackGenerator
      if (!Processor || !Generator || !globalThis.Worker || !globalThis.OffscreenCanvas || !globalThis.VideoFrame) {
        throw new DOMException("host gesture worker pipeline is unavailable", "NotSupportedError")
      }
      const settings = nativeTrack.getSettings ? nativeTrack.getSettings() : {}
      const width = settings.width || 640
      const height = settings.height || 360
      const processor = new Processor({ track: nativeTrack })
      const output = new Generator({ kind: "video" })
      const generatedSettings = output.getSettings?.bind(output)
      output.getSettings = () => ({ ...(generatedSettings ? generatedSettings() : {}), width, height, frameRate: settings.frameRate || 15 })
      const worker = new Worker(workerUrl)
      const source = { worker, native, nativeTrack, output, width, height, ready: false, readyPromise: null, framesIn: 0, framesOut: 0, stopped: false }
      sources.add(source)
      worker.onmessage = (event) => {
        if (event.data.type === "stats") {
          source.framesIn = event.data.framesIn
          source.framesOut = event.data.framesOut
        } else if (event.data.type === "error") output.stop()
      }
      worker.postMessage({ type: "init", readable: processor.readable, writable: output.writable, width, height }, [processor.readable, output.writable])
      const stop = output.stop.bind(output)
      output.stop = () => {
        if (source.stopped) return
        source.stopped = true
        sources.delete(source)
        worker.terminate()
        stop()
        for (const track of native.getTracks()) track.stop()
      }
      nativeTrack.addEventListener("ended", () => {
        output.stop()
        output.dispatchEvent(new Event("ended"))
      }, { once: true })
      nativeTrack.addEventListener("mute", () => {
        worker.postMessage({ type: "muted", muted: true })
        output.dispatchEvent(new Event("mute"))
      })
      nativeTrack.addEventListener("unmute", () => {
        worker.postMessage({ type: "muted", muted: false })
        output.dispatchEvent(new Event("unmute"))
      })
      if (active) await enableSource(source)
      return new MediaStream([output, ...native.getAudioTracks()])
    } catch (error) {
      // Gestures are harness decoration, never a prerequisite for the camera.
      // Keep the already-live native track when a runner cannot build the
      // optional processor/generator/worker pipeline; rejecting here turns a
      // harness limitation into the app's real camera-denied outcome.
      console.warn("[e2e-host-gesture] transform unavailable; keeping native camera: " + (error instanceof Error ? error.message : String(error)))
      return native
    }
  }
  globalThis.__e2eHostGesture = {
    enable: async () => {
      active = true
      await Promise.all([...sources].map(enableSource))
      return globalThis.__e2eHostGesture.facts()
    },
    disable: async () => {
      active = false
      for (const source of sources) source.worker.postMessage({ type: "active", active: false })
      return globalThis.__e2eHostGesture.facts()
    },
    facts: () => {
      const current = [...sources]
      return {
        active,
        ready: current.length > 0 && current.every((source) => source.ready),
        sources: current.length,
        framesIn: current.reduce((sum, source) => sum + source.framesIn, 0),
        framesOut: current.reduce((sum, source) => sum + source.framesOut, 0),
        width: current.at(-1)?.width || 0,
        height: current.at(-1)?.height || 0,
        frameRate: current.at(-1)?.nativeTrack.getSettings?.().frameRate || 15,
      }
    },
  }
})()`
}

export interface HostGestureFacts { active: boolean; ready: boolean; sources: number; framesIn: number; framesOut: number; width: number; height: number; frameRate: number }
export function nextHostGestureTurn(current: number | null, facts: { hostIntroHeadline: boolean; turn: number | null; stage: string; sessionStage?: string | null }): number | null {
  const latched = facts.hostIntroHeadline && facts.turn !== null ? facts.turn : current
  const liveStage = facts.sessionStage
    ? facts.sessionStage === "introduction" || facts.sessionStage === "gameplay"
    : facts.stage === "intro" || facts.stage === "play"
  return liveStage && facts.turn === latched ? latched : null
}
export const setHostGesture = (page: Page, active: boolean): Promise<HostGestureFacts> =>
  page.evaluate(async (on) => {
    const control = (globalThis as unknown as { __e2eHostGesture?: { enable(): Promise<HostGestureFacts>; disable(): Promise<HostGestureFacts> } }).__e2eHostGesture
    if (!control) throw new Error("host gesture control was not installed")
    return on ? control.enable() : control.disable()
  }, active)

export const readHostGesture = (page: Page): Promise<HostGestureFacts | null> =>
  page.evaluate(() => {
    const control = (globalThis as unknown as { __e2eHostGesture?: { facts(): HostGestureFacts } }).__e2eHostGesture
    return control?.facts() ?? null
  }).catch(() => null)

/** Jump the page's clock to a new offset (the device's clock drifting or being corrected mid-game). */
export const jumpClock = (page: Page, offsetS: number): Promise<void> =>
  page.evaluate((ms) => {
    ;(globalThis as unknown as { __e2eClockOffMs: number }).__e2eClockOffMs = ms
  }, offsetS * 1000)

/** The page clock's offset from the runner's, read back (seconds): proof that a jump took, from the page itself. */
export const readClockOffsetS = async (page: Page): Promise<number> => ((await page.evaluate(() => Date.now())) - Date.now()) / 1000

/** Let backgroundPage()/foregroundPage() flip document.hidden / visibilityState. */
export function visibilityScript(): string {
  return `(() => {
  const real = (k) => Object.getOwnPropertyDescriptor(Document.prototype, k)
  const h = real("hidden"), v = real("visibilityState")
  window.__e2eHidden = false
  Object.defineProperty(document, "hidden", { configurable: true, get: () => (window.__e2eHidden ? true : h.get.call(document)) })
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (window.__e2eHidden ? "hidden" : v.get.call(document)) })
})()`
}

/** The page's monotonic clock with a hold, and a heartbeat that proves a freeze (the freeze role, freezePage):
 *  performance.now() reads `__e2ePerfOffMs` behind the real one (0 until a freeze sets it, so a no-op otherwise), and a
 *  200 ms timer records in `__e2eMaxGapMs` the longest it went without a tick, on the REAL monotonic clock. */
export function freezeScript(): string {
  return `(() => {
  const real = performance.now.bind(performance)
  globalThis.__e2ePerfOffMs = 0
  performance.now = () => real() - globalThis.__e2ePerfOffMs
  globalThis.__e2eMaxGapMs = 0
  let last = real()
  setInterval(() => {
    const n = real()
    if (n - last > globalThis.__e2eMaxGapMs) globalThis.__e2eMaxGapMs = n - last
    last = n
  }, 200)
})()`
}

/** The init scripts a profile needs, in order. Role-only page interception is
 * selected from the resolved plan, not the profile's dormant role definition. */
export function initScriptsFor(profile: Profile, pageLoad = 0, roleKind: RolePlan["kind"] = profile.role.kind): string[] {
  const s: string[] = []
  if (roleKind === "kill-relaunch" || roleKind === "background" || roleKind === "hidden-step") s.push(visibilityScript())
  if (profile.clockOffsetS !== 0) s.push(clockScript(profile.clockOffsetS))
  if (profile.camera.delayMs > 0) s.push(cameraDelayScript(profile.camera.delayMs))
  if (profile.camera.mode === "denied" || profile.camera.mode === "missing") s.push(cameraBlockScript(profile.camera.mode))
  if (profile.camera.muteLoop) s.push(cameraMuteLoopScript())
  if (roleKind === "video-return") s.push(outboundVideoScript())
  if (profile.dataChannelFault) s.push(dataChannelFaultScript(profile.dataChannelFault.dropRenegotiationOffers))
  if (profile.peerFault) s.push(peerFaultScript(profile.peerFault.kind))
  // a clock jump (or the hidden-step role's step) needs the offset variable even when the starting offset is 0
  if ((profile.clockJumps?.length || roleKind === "hidden-step") && profile.clockOffsetS === 0) s.splice(roleKind === "hidden-step" ? 1 : 0, 0, clockScript(0))
  if (roleKind === "freeze") s.push(freezeScript())
  const torture = profile.telemetryTorture
  const faultThisLoad = torture && (!torture.pageLoads || torture.pageLoads.includes(pageLoad))
  if (faultThisLoad && torture.fault === "host-storage-hang") {
    s.push(hostStorageHangScript(torture.fetchGateS ?? torture.durationS ?? 60, torture.activateAtTurn !== undefined && pageLoad === 0))
  }
  const fetchGateThisLoad = torture && ((torture.fault === "ios-fetch-gate" && faultThisLoad) || torture.fetchGatePageLoads?.includes(pageLoad))
  // The first document's mid-game gate is armed by activateTelemetryFault.
  // Any later page load explicitly listed by the profile must start armed in
  // its init script, before app boot/outbox drain can issue the first fetch.
  if (fetchGateThisLoad) s.push(sentryFetchGateScript(torture.fetchGateS ?? torture.durationS ?? 120, torture.activateAtTurn !== undefined && pageLoad === 0))
  if (faultThisLoad && torture.fault === "no-localstorage") s.push(noLocalStorageScript())
  // last, so it wraps every other fetch hook and stamps the app's own call
  if (faultThisLoad && torture.fault === "sentry-429") s.push(telemetryStartStampScript())
  return s
}

/** Drop a bounded number of outbound renegotiation offers while leaving
 * answers, ICE, every other lane and later offers untouched.
 * The counter is document-local and deliberately expires, so the watchdog's
 * rebuilt connection can negotiate video normally. Browser console lines and
 * facts() make the injected fault visible in the gathered bot artifact. */
export function dataChannelFaultScript(dropRenegotiationOffers: number): string {
  const lane = [...new TextEncoder().encode("webrtc_renegotiation_internal_use_case")]
  return `(() => {
  const DC = globalThis.RTCDataChannel
  if (!DC || !DC.prototype.send) return
  const real = DC.prototype.send
  const lane = ${JSON.stringify(lane)}
  let remaining = ${JSON.stringify(dropRenegotiationOffers)}
  let dropped = 0
  ${wireScriptPrelude}
  const isRenegotiationOffer = (value) => {
    return signalTag(value, lane) === 0
  }
  DC.prototype.send = function(value) {
    if (remaining > 0 && isRenegotiationOffer(value)) {
      remaining -= 1
      dropped += 1
      const fault = \`offer-\${dropped}\`
      this.__e2eDataChannelFaultId = fault
      const message = \`[e2e-data-channel-fault] dropped renegotiation offer fault=\${fault} \${dropped}/${JSON.stringify(dropRenegotiationOffers)}\`
      console.log(message)
      globalThis.__jollityHarness?.devLog?.("rtc", message)
      return
    }
    return real.call(this, value)
  }
  globalThis.__e2eDataChannelFault = { facts: () => ({ dropped, remaining }) }
})()`
}

/** Browser-boundary recovery faults used only by explicit acceptance personas.
 * Each hook is inert outside its exact wire/track condition and publishes a
 * fact plus a devLog line only after the condition was actually injected. */
export function peerFaultScript(kind: NonNullable<Profile["peerFault"]>["kind"]): string {
  if (kind === "late-signal") return lateStatementSignalScript()
  if (kind === "one-way-video") return oneWayVideoScript()
  return lanePeerFaultScript(kind)
}

const PEER_FAULT_MARKERS: Record<NonNullable<Profile["peerFault"]>["kind"], string> = {
  "glare-forcer": "[e2e-peer-fault] glare-forcer fired",
  "late-signal": "[e2e-peer-fault] late-signal fired",
  "one-way-video": "[e2e-peer-fault] one-way-video fired",
  "dropped-answer": "[e2e-peer-fault] dropped-answer fired",
}

const PEER_RECOVERY_MARKERS: Record<Exclude<NonNullable<Profile["peerFault"]>["kind"], "dropped-answer">, string> = {
  "glare-forcer": "[e2e-peer-fault] glare-forcer recovered",
  "late-signal": "[e2e-peer-fault] late-signal recovered",
  "one-way-video": "[e2e-peer-fault] one-way-video recovered",
}

function faultLogScript(kind: NonNullable<Profile["peerFault"]>["kind"]): string {
  const marker = PEER_FAULT_MARKERS[kind]
  return `const report = (fault, detail) => {
    const message = ${JSON.stringify(marker)} + " fault=" + fault + (detail ? " " + detail : "")
    console.log(message)
    globalThis.__jollityHarness?.devLog?.("rtc", message)
  }`
}

/** A fired fault is accepted only after a newer app-owned mesh snapshot shows
 * that the exact affected peer is connected and decoded video after the fire. */
function peerRecoveryScript(kind: Exclude<NonNullable<Profile["peerFault"]>["kind"], "dropped-answer">): string {
  const marker = PEER_RECOVERY_MARKERS[kind]
  return `let recoveryReported = false
  const provePeerRecovered = (peerId, requireRebuild = false) => {
    if (recoveryReported || typeof peerId !== "string") return
    const read = globalThis.__jollityHarness?.peerFaultMesh
    if (typeof read !== "function") return
    const before = read()
    const beforePeer = before?.peers?.find(({ id }) => id === peerId)
    const after = before?.at ?? -Infinity
    const framesBefore = typeof beforePeer?.frames === "number" ? beforePeer.frames : -1
    const linkBefore = beforePeer?.statsLink
    const check = () => {
      const snapshot = read()
      const peer = snapshot?.peers?.find(({ id }) => id === peerId)
      const framesAdvanced = typeof peer?.frames === "number" && peer.frames > 0 && (peer.frames > framesBefore || peer.frames < framesBefore)
      const rebuilt = !requireRebuild || (typeof linkBefore === "number" && typeof peer?.statsLink === "number" && peer.statsLink !== linkBefore)
      if (snapshot && snapshot.at > after && peer?.conn === "connected" && framesAdvanced && rebuilt) {
        recoveryReported = true
        const message = ${JSON.stringify(marker)} + " peer=" + peerId + " connected frames=" + peer.frames
        console.log(message)
        globalThis.__jollityHarness?.devLog?.("rtc", message)
        return
      }
      setTimeout(check, 500)
    }
    setTimeout(check, 500)
  }`
}

/** Shared, dependency-free SCALE/wire helpers interpolated into page scripts.
 * Keeping one copy matters: these hooks all run before app boot and therefore
 * cannot import the TrUAPI codec at runtime. */
const wireScriptPrelude = `
  const bytesOf = (value) => value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null
  const compact = (bytes, offset = 0) => {
    if (!bytes || offset >= bytes.length) return null
    const mode = bytes[offset] & 3
    if (mode === 0) return { prefix: 1, length: bytes[offset] >>> 2 }
    if (mode === 1 && offset + 2 <= bytes.length) return { prefix: 2, length: (bytes[offset] | bytes[offset + 1] << 8) >>> 2 }
    if (mode === 2 && offset + 4 <= bytes.length) return { prefix: 4, length: (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 2 }
    return null
  }
  const wireHeader = (value) => {
    const bytes = bytesOf(value)
    const request = compact(bytes)
    const at = request && request.prefix + request.length
    return bytes && at !== null && at + 3 <= bytes.length
      ? { bytes, valueAt: at + 3, trait: bytes[at], method: bytes[at + 1], type: bytes[at + 2] }
      : null
  }
  const signalTag = (value, lane) => {
    const bytes = bytesOf(value)
    const size = compact(bytes)
    if (!bytes || !size || size.length !== lane.length || size.prefix + size.length > bytes.length) return null
    if (!lane.every((byte, index) => bytes[size.prefix + index] === byte)) return null
    const dataAt = size.prefix + size.length
    const dataSize = compact(bytes, dataAt)
    const at = dataSize && dataAt + dataSize.prefix
    return at !== null && at < bytes.length ? bytes[at] : null
  }
  const jsonPayloads = (value) => {
    const bytes = bytesOf(value)
    if (!bytes) return []
    const text = new TextDecoder().decode(bytes)
    const values = []
    for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
      let depth = 0, quoted = false, escaped = false
      for (let at = start; at < text.length; at += 1) {
        const char = text[at]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === "\\\\") escaped = true
          else if (char === "\\\"") quoted = false
        } else if (char === "\\\"") quoted = true
        else if (char === "{") depth += 1
        else if (char === "}" && --depth === 0) {
          try { values.push(JSON.parse(text.slice(start, at + 1))) } catch {}
          break
        }
      }
    }
    return values
  }`

/** Deliver an older SDP page after a newer SDP page for the same directed
 * peer link. Trait 14/method 0/type 1 is the generated statement-store
 * Receive frame; every other host message passes through synchronously. */
export function lateStatementSignalScript(): string {
  return `(() => {
  const MP = globalThis.MessagePort
  if (!MP) return
  const descriptor = Object.getOwnPropertyDescriptor(MP.prototype, "onmessage")
  if (!descriptor?.set || !descriptor.get) return
  ${faultLogScript("late-signal")}
  ${peerRecoveryScript("late-signal")}
  ${wireScriptPrelude}
  const isStatementReceive = (value) => {
    const header = wireHeader(value)
    return header?.trait === 14 && header.method === 0 && header.type === 1
  }
  const descriptions = (value) => {
    const found = []
    for (const payload of jsonPayloads(value)) {
      // jsonPayloads deliberately scans every opening brace to recover JSON
      // from an opaque wire frame. Only the outer bundle owns directed slots;
      // nested description objects have no target and must never become the
      // synthetic key from>subscribed.
      if (payload?.t !== "b") continue
      const frames = Object.entries(payload.f ?? {})
      for (const [slot, frame] of frames) if (frame?.t === "d" && typeof frame.from === "string" && typeof frame.gen === "string" && slot.startsWith("d:")) {
        const target = slot.slice(2)
        found.push({ key: frame.from + ">" + target, from: frame.from, target, gen: frame.gen })
      }
    }
    return found
  }
  const seen = new Map()
  const descriptionsByKey = new Map()
  let held = null
  let heldDescription = null
  let reordered = 0
  let generationRequest = "waiting"
  let generationPeer = null
  let generationKey = null
  let localId = null
  let completedPeer = null
  let replayEvidence = null
  let reported = false
  const maybeReport = () => {
    if (reported || completedPeer !== generationPeer || !replayEvidence || replayEvidence.key !== generationKey || !localId || !replayEvidence.key.endsWith(">" + localId)) return
    reported = true
    report("store-sdp-order-1", "peer=" + generationPeer + " link=" + replayEvidence.key + " newer=" + replayEvidence.newer + " older=" + replayEvidence.older)
    provePeerRecovered(generationPeer)
  }
  const requestGenerations = () => {
    if (generationRequest !== "waiting" || !generationPeer) return
    const force = globalThis.__jollityHarness?.forceStatementGenerationsOnce
    if (typeof force !== "function") {
      setTimeout(requestGenerations, 100)
      return
    }
    generationRequest = "running"
    Promise.resolve(force("late-signal-two-generations", generationPeer)).then((result) => {
      if (result === null || result?.rejectedReason === "requested peer not eligible") {
        generationRequest = "waiting"
        setTimeout(requestGenerations, 100)
        return
      }
      if (result?.rejectedReason) generationRequest = "rejected:" + result.rejectedReason
      else if (result?.replacements === 2 && result?.peerId === generationPeer) {
        generationRequest = "complete"
        completedPeer = result.peerId
        maybeReport()
      } else generationRequest = "rejected:missing-result"
    }, (error) => { generationRequest = "rejected:" + String(error) })
  }
  let selectionRetry = false
  const retrySelection = () => {
    if (selectionRetry) return
    selectionRetry = true
    setTimeout(() => {
      selectionRetry = false
      selectDirectedPeer()
    }, 100)
  }
  const selectDirectedPeer = () => {
    if (generationPeer || selectionRetry) return
    const read = globalThis.__jollityHarness?.peerFaultMesh
    const mesh = typeof read === "function" ? read() : null
    const self = mesh?.selfId
    if (typeof self !== "string") {
      retrySelection()
      return
    }
    localId = self
    const connected = new Set(mesh?.peers?.filter(({ conn }) => conn === "connected").map(({ id }) => id) ?? [])
    const baseline = [...descriptionsByKey.values()].find(({ from, target }) => target === localId && from !== localId && connected.has(from))
    if (!baseline) {
      retrySelection()
      return
    }
    generationPeer = baseline.from
    generationKey = baseline.key
    setTimeout(requestGenerations, 100)
  }
  Object.defineProperty(MP.prototype, "onmessage", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get() { return descriptor.get.call(this) },
    set(handler) {
      if (typeof handler !== "function") return descriptor.set.call(this, handler)
      const wrapped = (event) => {
        if (reordered > 0 || !isStatementReceive(event.data)) return handler.call(this, event)
        const descs = descriptions(event.data)
        for (const description of descs) descriptionsByKey.set(description.key, description)
        selectDirectedPeer()
        if (!held) {
          // The live host can receive subscription pages before this port ever
          // exposes a local submit, so bootstrap the exact directed link from
          // inbound SDP instead of waiting for an unrelated outbound frame.
          const replacement = generationKey ? descs.find(({ key, gen }) => key === generationKey && seen.has(key) && seen.get(key) !== gen) : undefined
          for (const { key, gen } of descs) seen.set(key, gen)
          if (!replacement) {
            const delivered = handler.call(this, event)
            return delivered
          }
          held = event
          heldDescription = replacement
          return handler.call(this, event)
        }
        const newer = descs.find(({ key, gen }) => key === heldDescription.key && gen !== heldDescription.gen)
        for (const { key, gen } of descs) seen.set(key, gen)
        if (!newer) return handler.call(this, event)
        const older = held
        held = null
        const olderDescription = heldDescription
        heldDescription = null
        handler.call(this, event)
        queueMicrotask(() => {
          handler.call(this, older)
          reordered += 1
          replayEvidence = { key: olderDescription.key, newer: newer.gen, older: olderDescription.gen }
          maybeReport()
        })
      }
      descriptor.set.call(this, wrapped)
    },
  })
  globalThis.__e2ePeerFault = { facts: () => ({ kind: "late-signal", held: held !== null, reordered, generationRequest, generationPeer, observedKeys: [...descriptionsByKey.keys()] }) }
})()`
}

/** Keep incoming video untouched while every local video addTrack becomes a
 * sendrecv transceiver with no sender track. Audio and non-video tracks pass. */
export function oneWayVideoScript(): string {
  return outboundVideoHookScript("one-way")
}

/** Lane-level faults need to associate a data channel with its owning peer
 * connection. Glare first creates a local offer before delivering the peer's
 * already-arrived offer; dropped-answer discards one Answer for the same
 * remote media stream on a PC created after an earlier PC closed (the
 * observable rebuild boundary). */
export function lanePeerFaultScript(kind: "glare-forcer" | "dropped-answer"): string {
  const lane = [...new TextEncoder().encode("webrtc_renegotiation_internal_use_case")]
  return `(() => {
  const NativePC = globalThis.RTCPeerConnection
  const DC = globalThis.RTCDataChannel
  if (!NativePC || !DC) return
  ${faultLogScript(kind)}
  ${kind === "glare-forcer" ? peerRecoveryScript("glare-forcer") : ""}
  const lane = ${JSON.stringify(lane)}
  ${wireScriptPrelude}
  const owners = new WeakMap()
  const closedLinks = new Set()
  let closed = 0, recovered = 0, droppedOwner = null, droppedLink = null, attempting = false, starting = false, started = false
  let fired = 0
  const remoteLink = (pc) => {
    const sdp = pc.remoteDescription?.sdp || ""
    return /^a=msid:([^\\s]+)/m.exec(sdp)?.[1] || null
  }
  const sendsVideo = (sdp) => (sdp || "").split(/\\r?\\n(?=m=)/).some((section) => {
    if (!section.startsWith("m=video ") || section.split(" ")[1] === "0") return false
    const direction = /^a=(sendrecv|sendonly|recvonly|inactive)\\s*$/m.exec(section)?.[1] || "sendrecv"
    return direction === "sendrecv" || direction === "sendonly"
  })
  // The SDP direction alone passes a peer whose video sender is nulled (the
  // one-way-video persona): glare there recovers, but frames stay 0 and the
  // recovery proof can never be met. Fire only on a peer already decoding.
  // The skip line deliberately does not contain the "fired" marker.
  const skippedFrameless = new Set()
  const peerDecoding = (pc) => {
    const id = pc.__jollityE2EPeerId
    const frames = globalThis.__jollityHarness?.peerFaultMesh?.()?.peers?.find((peer) => peer.id === id)?.frames
    if (typeof frames === "number" && frames > 0) return true
    if (typeof id === "string" && !skippedFrameless.has(id)) {
      skippedFrameless.add(id)
      const message = "[e2e-peer-fault] glare-forcer skipped peer=" + id + " frames=" + (typeof frames === "number" ? frames : "unknown") + " not-sending: glare not-evaluated on this peer, retrying on its next lane offer"
      console.log(message)
      globalThis.__jollityHarness?.devLog?.("rtc", message)
    }
    return false
  }
  const maybeRecovered = (pc) => {
    const link = remoteLink(pc)
    if (fired > 0 && recovered === 0 && pc !== droppedOwner && link && link === droppedLink && pc.connectionState === "connected") {
      recovered = 1
      const message = "[e2e-peer-fault] dropped-answer recovered link=" + link
      console.log(message)
      globalThis.__jollityHarness?.devLog?.("rtc", message)
    }
  }
  const forceRebuild = (request, pc) => {
    const peer = pc?.__jollityE2EPeerId
    const force = globalThis.__jollityHarness?.forcePeerRebuildOnce
    if (typeof peer !== "string" || typeof force !== "function") return null
    return Promise.resolve(force(request, peer))
  }
  const maybeStartDroppedAnswer = (pc) => {
    if (${JSON.stringify(kind)} !== "dropped-answer" || starting || started || pc.__jollityE2EPolite !== true || pc.connectionState !== "connected" || !remoteLink(pc)) return
    const request = forceRebuild("dropped-answer-first", pc)
    if (!request) return
    starting = true
    void request.then((result) => {
      starting = false
      if (result?.rebuilt === true) started = true
    }, () => { starting = false })
  }
  class PeerConnection extends NativePC {
    constructor(...args) {
      super(...args)
      this.addEventListener("datachannel", (event) => {
        owners.set(event.channel, this)
      })
      this.addEventListener("connectionstatechange", () => { maybeStartDroppedAnswer(this); maybeRecovered(this) })
      this.addEventListener("signalingstatechange", () => { maybeStartDroppedAnswer(this); maybeRecovered(this) })
      this.addEventListener("track", () => { maybeStartDroppedAnswer(this); maybeRecovered(this) })
    }
    async setRemoteDescription(...args) {
      const result = await super.setRemoteDescription(...args)
      maybeStartDroppedAnswer(this)
      maybeRecovered(this)
      return result
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args)
      owners.set(channel, this)
      return channel
    }
    close() {
      closed += 1
      const link = remoteLink(this)
      if (link) closedLinks.add(link)
      return super.close()
    }
  }
  Object.setPrototypeOf(PeerConnection, NativePC)
  globalThis.RTCPeerConnection = PeerConnection
  if (${JSON.stringify(kind)} === "dropped-answer") {
    const send = DC.prototype.send
    DC.prototype.send = function(value) {
      const owner = owners.get(this)
      const link = owner && remoteLink(owner)
      if (fired === 0 && link && closedLinks.has(link) && signalTag(value, lane) === 1) {
        fired = 1
        droppedOwner = owner
        droppedLink = link
        this.__e2ePeerFaultId = "answer-1"
        report("answer-1", "same-stream-rebuild=" + link)
        void Promise.resolve().then(() => forceRebuild("dropped-answer-second", owner)).catch(() => null)
        return
      }
      return send.call(this, value)
    }
  } else {
    const descriptor = Object.getOwnPropertyDescriptor(DC.prototype, "onmessage")
    if (!descriptor?.set || !descriptor.get) return
    Object.defineProperty(DC.prototype, "onmessage", {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get() { return descriptor.get.call(this) },
      set(handler) {
        if (typeof handler !== "function") return descriptor.set.call(this, handler)
        const wrapped = (event) => {
          const owner = owners.get(this)
          const negotiatedVideo = sendsVideo(owner?.remoteDescription?.sdp)
          if (fired > 0 || attempting || signalTag(event.data, lane) !== 0 || !owner || owner.__jollityE2EPolite !== true || owner.connectionState !== "connected" || !negotiatedVideo || !peerDecoding(owner)) {
            return handler.call(this, event)
          }
          // Game 1426 reached the intended collision before this hook could
          // manufacture one: the lane offer arrived while the polite peer was
          // already in have-local-offer. Count that real glare and let the app
          // take its normal rebuild-instead-of-rollback path.
          if (owner.signalingState === "have-local-offer") {
            fired = 1
            report("glare-1", "existing-local-offer-before-remote-offer video-negotiated")
            provePeerRecovered(owner.__jollityE2EPeerId, true)
            return handler.call(this, event)
          }
          if (owner.signalingState !== "stable") return handler.call(this, event)
          attempting = true
          void Promise.resolve(owner.setLocalDescription()).then(() => {
            fired = 1
            attempting = false
            report("glare-1", "local-offer-before-remote-offer video-negotiated")
            provePeerRecovered(owner.__jollityE2EPeerId, true)
            handler.call(this, event)
          }, () => {
            attempting = false
            handler.call(this, event)
          })
        }
        descriptor.set.call(this, wrapped)
      },
    })
  }
  globalThis.__e2ePeerFault = { facts: () => ({ kind: ${JSON.stringify(kind)}, fired, closed, recovered }) }
})()`
}

const sentryRequest = `(url) => { const raw = url && typeof url === "object" && "url" in url ? url.url : url; const value = String(raw).toLowerCase(); return value.includes("sentry") || value.includes("/envelope/") }`

/** Drop only host-storage RPC sends. TrUAPI carries SCALE-encoded binary
 * frames over WebSocket/MessagePort. Trait 7 is localStorage in the pinned
 * @parity/truapi wire table; leaving those requests unsent reproduces a host
 * call which never answers without stalling browser localStorage or Sentry's
 * outbox. */
export function hostStorageHangScript(durationS = 60, startsInactive = false): string {
  return `(() => {
  let dropped = 0
  let activatedAt = ${startsInactive ? "0" : "Date.now()"}
  let release = activatedAt ? activatedAt + ${JSON.stringify(durationS * 1000)} : 0
  ${wireScriptPrelude}
  const blocked = (value) => {
    return wireHeader(value)?.trait === 7
  }
  const active = () => activatedAt > 0 && Date.now() < release
  const ws = WebSocket.prototype.send
  WebSocket.prototype.send = function(value) { if (!active() || !blocked(value)) return ws.call(this, value); dropped += 1 }
  if (globalThis.MessagePort) {
    const mp = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function(value, transfer) { if (!active() || !blocked(value)) return mp.call(this, value, transfer || []); dropped += 1 }
  }
  globalThis.__e2eHostStorageHang = {
    activate: (ms) => { activatedAt = Date.now(); release = activatedAt + ms; return release },
    facts: () => ({ dropped, activatedAt, release, active: active() }),
  }
})()`
}

export interface HostStorageHangEvidence {
  dropped: number
  activatedAt: number
  release: number
  active: boolean
}

export const readHostStorageHangEvidence = (page: Page): Promise<HostStorageHangEvidence | null> =>
  page.evaluate(() => (globalThis as unknown as { __e2eHostStorageHang?: { facts(): HostStorageHangEvidence } }).__e2eHostStorageHang?.facts() ?? null).catch(() => null)

/** Safari/iOS can leave the page fetch used by Sentry pending. Release after
 * a bounded gate so the same document proves recovery. */
export function sentryFetchGateScript(durationS: number, startsInactive = false): string {
  return `(() => {
  const real = fetch.bind(globalThis)
  const sentry = ${sentryRequest}
  let release = ${startsInactive ? "0" : `Date.now() + ${JSON.stringify(durationS * 1000)}`}
  let held = 0
  globalThis.__e2eTelemetryGate = {
    activate: (ms) => { release = Date.now() + ms; return release },
    facts: () => ({ release, held }),
  }
  globalThis.fetch = (...args) => {
    if (!sentry(args[0]) || Date.now() >= release) return real(...args)
    held += 1
    return new Promise((resolve, reject) => setTimeout(() => real(...args).then(resolve, reject), Math.max(0, release - Date.now())))
  }
})()`
}

export const readTelemetryGateEvidence = (page: Page): Promise<{ release: number; held: number } | null> =>
  page
    .evaluate(() => {
      const control = (globalThis as unknown as { __e2eTelemetryGate?: { facts(): { release: number; held: number } } }).__e2eTelemetryGate
      return control?.facts() ?? null
    })
    .catch(() => null)

export function noLocalStorageScript(): string {
  return `(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("Storage disabled by E2E", "SecurityError") } })
})()`
}

interface TelemetryRouteState {
  activatedAt: number
  until: number
  /** route-handler times; the sentry-block fault's evidence */
  attempts: number[]
  /** every Sentry request the route saw, and the page's start stamps (T8) */
  routed: number
  stamps: number[]
  first429At: number | null
}
const telemetryRouteState = new WeakMap<Page, TelemetryRouteState>()
const stampBound = new WeakSet<Page>()
const TELEMETRY_STAMP_BINDING = "__e2eTelemetryStamp"
const STATIC_RESOURCE_TYPES = new Set(["document", "script", "stylesheet", "image", "font", "media", "manifest"])

/** T8: the page stamps each Sentry fetch when the APP calls it, on the real
 * wall clock (performance.timeOrigin + now, which clockScript's offset Date
 * does not touch), and hands it to the harness through a binding. A route
 * handler can run long after its request started, and request.timing() is
 * still empty inside one, so handler time cannot tell an in-flight request
 * from a premature retry. The request itself goes out unchanged. */
export function telemetryStartStampScript(): string {
  return `(() => {
  const real = fetch.bind(globalThis)
  const sentry = ${sentryRequest}
  globalThis.fetch = (...args) => {
    if (sentry(args[0])) {
      try {
        const at = performance.timeOrigin + performance.now()
        Promise.resolve(globalThis.${TELEMETRY_STAMP_BINDING}(at)).catch(() => {})
      } catch {}
    }
    return real(...args)
  }
})()`
}

/** T8's attempts: page start stamps inside the fault. Fails closed: a Sentry
 * request that reached the route without a stamp (not a page fetch, or the
 * hook missing) could be a premature retry nobody can date. */
export function t8Attempts(state: Pick<TelemetryRouteState, "activatedAt" | "routed" | "stamps">): number[] {
  const unstamped = state.routed - state.stamps.length
  if (unstamped > 0) throw new Error(`T8 NOT PROVEN: ${unstamped} Sentry request(s) reached the route without a page start stamp, so the Retry-After check cannot date them`)
  return state.activatedAt > 0 ? state.stamps.filter((at) => at >= state.activatedAt) : []
}

/** Network-side Sentry faults. Returns true when a route was installed. */
export async function applyTelemetryRoute(page: Page, torture: TelemetryTorture, pageLoad: number): Promise<boolean> {
  if (torture.pageLoads && !torture.pageLoads.includes(pageLoad)) return false
  if (torture.fault !== "sentry-block" && torture.fault !== "sentry-429") return false
  const active = torture.activateAtTurn === undefined ? Date.now() : 0
  const state: TelemetryRouteState = { activatedAt: active, until: active ? active + (torture.durationS ?? 60) * 1000 : 0, attempts: [], routed: 0, stamps: [], first429At: null }
  telemetryRouteState.set(page, state)
  if (torture.fault === "sentry-429" && !stampBound.has(page)) {
    stampBound.add(page)
    await page.exposeBinding(TELEMETRY_STAMP_BINDING, (_source, at: unknown) => {
      if (typeof at === "number" && Number.isFinite(at)) telemetryRouteState.get(page)?.stamps.push(at)
    })
  }
  await page.route("**/*", async (route) => {
    const request = route.request()
    if (!/sentry|\/api\/\d+\/envelope\//i.test(request.url())) return route.continue()
    // a bundle file whose name says sentry is not a send; anything else
    // (fetch, xhr, beacon, ping) must carry a page stamp
    if (!STATIC_RESOURCE_TYPES.has(request.resourceType())) state.routed += 1
    const now = Date.now()
    if (state.activatedAt > 0) state.attempts.push(now)
    if (state.activatedAt === 0 || now >= state.until) return route.continue()
    if (torture.fault === "sentry-429") {
      // Taken BEFORE fulfil: the page cannot have seen the 429 earlier, so a
      // request it started before this moment was already in flight. Taken
      // after, a retry the app fires the instant the 429 lands could predate
      // it and pass.
      const sentAt = Date.now()
      await route.fulfill({
        status: 429,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Retry-After",
          "retry-after": String(torture.retryAfterS ?? 120),
        },
        body: "rate limited by telemetry torture harness",
      })
      state.first429At ??= sentAt
      return
    }
    return route.abort("internetdisconnected")
  })
  return true
}

/** The fault's evidence. For sentry-429 the attempts are the page's own start
 * stamps (t8Attempts, which throws NOT PROVEN on an undated request). */
export const telemetryRouteEvidence = (page: Page): { activatedAt: number; until: number; attempts: number[]; first429At: number | null } | null => {
  const state = telemetryRouteState.get(page)
  if (!state) return null
  const attempts = stampBound.has(page) ? t8Attempts(state) : [...state.attempts]
  return { activatedAt: state.activatedAt, until: state.until, attempts, first429At: state.first429At }
}

/** Attempts after the first 429 response which violate its Retry-After window.
 * Concurrent sends that were already in flight before that response are not
 * retries and therefore cannot violate a header they had not received. */
export const retryAfterViolations = (attempts: readonly number[], retryMs: number, first429At: number | null): number[] => {
  if (first429At === null) return []
  const ordered = [...attempts].sort((a, b) => a - b)
  return ordered.filter((at) => at > first429At && at < first429At + retryMs)
}

export const telemetryActivationProven = (activateAtTurn: number | undefined, started: boolean, recoveryAtMs: number | null): boolean =>
  activateAtTurn === undefined || (started && recoveryAtMs !== null)

/** Progress must be observed while the storage interceptor is actually
 * active. Eventual progress after release does not prove T2 recovery. */
export const progressDuringActiveFault = (progressAtMs: number | null, activatedAtMs: number, releaseAtMs: number): boolean =>
  progressAtMs !== null && progressAtMs >= activatedAtMs && progressAtMs < releaseAtMs

/** Start an armed mid-game transport fault and return its recovery deadline. */
export async function activateTelemetryFault(page: Page, torture: TelemetryTorture): Promise<number | null> {
  const durationMs = (torture.fetchGateS ?? torture.durationS ?? 60) * 1000
  const route = telemetryRouteState.get(page)
  if (route) {
    route.activatedAt = Date.now()
    route.until = route.activatedAt + (torture.durationS ?? 60) * 1000
  }
  const gate = await page
    .evaluate((ms) => {
      const control = (globalThis as unknown as { __e2eTelemetryGate?: { activate(durationMs: number): number } }).__e2eTelemetryGate
      return control?.activate(ms) ?? null
    }, durationMs)
    .catch(() => null)
  const storage = await page
    .evaluate((ms) => {
      const control = (globalThis as unknown as { __e2eHostStorageHang?: { activate(durationMs: number): number } }).__e2eHostStorageHang
      return control?.activate(ms) ?? null
    }, durationMs)
    .catch(() => null)
  return route?.until ?? gate ?? storage
}

/** What the page itself reports, to prove the profile took (journey stage (a), profile-check.mts). */
export interface PageFacts {
  userAgent: string
  innerWidth: number
  innerHeight: number
  touch: boolean
  timeZone: string
  language: string
  /** Date.now() in the page minus the caller's Date.now() at the same moment, ms */
  clockSkewMs: number
}
export const readPageFacts = (page: Page): Promise<PageFacts> => {
  const outer = Date.now()
  return page.evaluate(
    (o) => ({ userAgent: navigator.userAgent, innerWidth: window.innerWidth, innerHeight: window.innerHeight, touch: navigator.maxTouchPoints > 0, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, language: navigator.language, clockSkewMs: Date.now() - o }),
    outer,
  )
}

/** Time one video getUserMedia call in the page and read the frame size it got; the tracks are stopped again.
 *  A rejection comes back as `error` (the DOMException name), never thrown. */
export const timeGetUserMedia = (page: Page): Promise<{ ms: number; width: number; height: number; error?: string }> =>
  page.evaluate(async () => {
    const t0 = performance.now()
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      const ms = performance.now() - t0
      const s = stream.getVideoTracks()[0]?.getSettings() ?? {}
      stream.getTracks().forEach((t) => t.stop())
      return { ms, width: s.width ?? 0, height: s.height ?? 0 }
    } catch (e) {
      return { ms: performance.now() - t0, width: 0, height: 0, error: (e as Error).name }
    }
  })

/** Probe configured camera behavior during boot, and also during a game when
 *  the camera failure is the profile's terminal expected outcome. */
export function shouldProbeCamera(profile: Profile | null, stage: string): boolean {
  if (!profile || (profile.camera.delayMs === 0 && (profile.camera.mode ?? "ok") === "ok")) return false
  return stage === "boot" || profile.expectedOutcome?.kind === "camera-unavailable"
}

/** Pure: facts + camera timing against the profile -> one check per knob it sets. */
export function profileChecks(profile: Profile, device: { userAgent?: string; viewport?: { width: number; height: number } | null }, f: PageFacts, cameraMs: number | null, cameraError?: string): Check[] {
  const out: Check[] = []
  const add = (name: string, ok: boolean, detail: string) => out.push({ name: `profile ${profile.name}: ${name}`, status: ok ? "pass" : "fail", detail })
  add("device user agent", f.userAgent === device.userAgent, f.userAgent.slice(0, 80))
  add("viewport", !device.viewport || (f.innerWidth === device.viewport.width && f.innerHeight === device.viewport.height), `${f.innerWidth}x${f.innerHeight}${device.viewport ? ` (device ${device.viewport.width}x${device.viewport.height})` : ""}`)
  const want = profile.clockOffsetS * 1000
  add("clock offset", Math.abs(f.clockSkewMs - want) < 3000, `page clock is ${f.clockSkewMs} ms off the runner's (wanted ${want})`)
  if (profile.timezoneId) add("time zone", f.timeZone === profile.timezoneId, `the page says ${f.timeZone}`)
  if (profile.locale) add("locale", f.language === profile.locale, `navigator.language is ${f.language}`)
  const mode = profile.camera.mode
  if (mode === "denied" || mode === "missing") add(`camera ${mode}`, cameraError === (mode === "denied" ? "NotAllowedError" : "NotFoundError"), `getUserMedia ${cameraError ? `rejected ${cameraError}` : "did not reject"}`)
  else if (profile.camera.delayMs > 0 && cameraMs !== null) add("camera delay", cameraMs >= profile.camera.delayMs - 200, `getUserMedia took ${Math.round(cameraMs)} ms (wanted >= ${profile.camera.delayMs})`)
  return out
}

const normalizeDisplayedTime = (text: string): string => text.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim()

/** Compare the app's visible local game time with the chain's authoritative
 * gameAt, formatted in the hour cycle and time zone of this profile. */
export function displayedGameTimeCheck(profile: Profile, gameAt: number, pageText: string): Check {
  if (!profile.locale || !profile.timezoneId) return { name: `profile ${profile.name}: displayed game time`, status: "unchecked", detail: "profile has no locale/timezone" }
  const { hour12 } = new Intl.DateTimeFormat(profile.locale, { hour: "numeric" }).resolvedOptions()
  const expected = normalizeDisplayedTime(new Intl.DateTimeFormat(hour12 ? "en-US" : "en-GB", {
    timeZone: profile.timezoneId,
    hour: hour12 ? "numeric" : "2-digit",
    minute: "2-digit",
  }).format(new Date(gameAt * 1000)))
  const actual = normalizeDisplayedTime(pageText)
  return {
    name: `profile ${profile.name}: displayed game time`,
    status: new RegExp(`(?<!\\d)${expected}`).test(actual) ? "pass" : "fail",
    detail: `chain gameAt ${gameAt} formats as ${expected} in ${profile.locale}/${profile.timezoneId}`,
  }
}

/** Call before the first goto. */
export async function applyPageProfile(page: Page, profile: Profile, pageLoad = 0, roleKind: RolePlan["kind"] = profile.role.kind): Promise<void> {
  for (const s of initScriptsFor(profile, pageLoad, roleKind)) await page.addInitScript(s)
  const gestureIdentity = hostGestureIdentity(profile)
  if (gestureIdentity) {
    const dataUrl = (pose: "a" | "b") => `data:image/webp;base64,${readFileSync(identityGesturePosePath(gestureIdentity, pose)).toString("base64")}`
    await page.addInitScript(hostGestureScript(dataUrl("a"), dataUrl("b")))
  }
  if (profile.cpuThrottle > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottle })
  }
}

const setHidden = (h: boolean) => {
  ;(window as unknown as { __e2eHidden: boolean }).__e2eHidden = h
  document.dispatchEvent(new Event("visibilitychange"))
}
/** The tab goes to the background: hidden=true, visibilitychange fired. */
export const backgroundPage = (page: Page): Promise<void> => page.evaluate(setHidden, true)
/** And back to the foreground. */
export const foregroundPage = (page: Page): Promise<void> => page.evaluate(setHidden, false)

/** THE VISIBLE FREEZE: stop the page's JS for `ms` (CDP Debugger.pause: the main thread parks in the debugger at the
 *  next script, so no timer, rAF or message handler runs) while the page stays visible and fires no visibility, freeze
 *  or pagehide event. With `holdMonotonic`, performance.now() is held back by the time paused (freezeScript's offset,
 *  written in the paused frame itself, so no app code runs between the thaw and the hold), as a phone's monotonic
 *  clock stops with a frozen WebView (lib/device-clock.ts). Returns how long the page was paused and whether the hold
 *  was written. Never call page.evaluate on the page while this runs: it waits for the thaw. */
export async function freezePage(page: Page, ms: number, holdMonotonic: boolean): Promise<{ pausedMs: number; held: boolean; detail: string }> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("Debugger.enable")
    const paused = new Promise<{ callFrames: { callFrameId: string }[] }>((done) => cdp.once("Debugger.paused", done))
    await cdp.send("Debugger.pause")
    // a page with no script to run would not park: the app always has timers, so this is seconds at most
    const ev = await Promise.race([paused, new Promise<null>((done) => setTimeout(() => done(null), 10_000))])
    if (!ev) throw new Error("the page did not pause within 10 s")
    const t0 = Date.now()
    await new Promise((r) => setTimeout(r, ms))
    const pausedMs = Date.now() - t0
    let held = false
    let detail = "performance.now() not held"
    if (holdMonotonic && ev.callFrames[0]) {
      const r = (await cdp.send("Debugger.evaluateOnCallFrame", { callFrameId: ev.callFrames[0].callFrameId, expression: `globalThis.__e2ePerfOffMs = (globalThis.__e2ePerfOffMs || 0) + ${pausedMs}`, returnByValue: true }).catch((e: Error) => ({ result: { value: undefined }, error: e.message }))) as { result: { value?: unknown }; error?: string }
      held = typeof r.result.value === "number"
      detail = held ? `performance.now() held back ${pausedMs} ms in the paused frame` : `the hold was not written (${r.error ?? "no value"})`
    }
    await cdp.send("Debugger.resume")
    await cdp.send("Debugger.disable").catch(() => {})
    return { pausedMs, held, detail }
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/** A browser-level Fetch.requestPaused event, narrowed to what the T6
 * collector reads. Unload traffic (a pagehide keepalive fetch, a sendBeacon
 * Ping) is invisible to page.route and context.route, but the browser target's
 * Fetch domain sees it with the dying document's frameId. */
export interface PausedTelemetryRequest {
  requestId: string
  frameId?: string
  request: { url: string; postData?: string; postDataEntries?: { bytes?: string }[] }
}

/** The leak the collector caught: when, where to, and how it was attributed. */
export interface KilledDocumentLeak {
  at: number
  url: string
  by: "frame" | "session"
}

/** Sentry envelope URLs, the same two shapes applyTelemetryRoute matches. */
const T6_TELEMETRY_PATTERNS = [{ urlPattern: "*sentry*" }, { urlPattern: "*/api/*/envelope/*" }]
const isTelemetryUrl = (url: string): boolean => /sentry|\/api\/\d+\/envelope\//i.test(url)

/** How long after Target.targetDestroyed the collector stays open, so a
 * keepalive request the dying renderer already handed to the browser is still
 * caught after the target session (and its offline emulation) is gone. */
export const T6_LEAK_GRACE_MS = 2_000

const pausedRequestBody = (request: PausedTelemetryRequest["request"]): string => {
  if (typeof request.postData === "string") return request.postData
  return (request.postDataEntries ?? []).map((entry) => (entry.bytes ? Buffer.from(entry.bytes, "base64").toString("utf8") : "")).join("")
}

/** Is this paused telemetry request the killed document's? Its frame is the
 * authority (a large body can arrive without postData); the session UUID in
 * the envelope body is the second key, for a request that carries no frame. */
export function killedDocumentLeak(event: PausedTelemetryRequest, oldFrameIds: ReadonlySet<string>, oldSessionId: string): KilledDocumentLeak["by"] | null {
  if (!isTelemetryUrl(event.request.url)) return null
  if (event.frameId && oldFrameIds.has(event.frameId)) return "frame"
  if (oldSessionId && pausedRequestBody(event.request).includes(oldSessionId)) return "session"
  return null
}

const frameIdsOf = (tree: { frame?: { id?: string }; childFrames?: unknown[] } | undefined, into: Set<string>): Set<string> => {
  if (tree?.frame?.id) into.add(tree.frame.id)
  for (const child of tree?.childFrames ?? []) frameIdsOf(child as { frame?: { id?: string }; childFrames?: unknown[] }, into)
  return into
}

/** T6: pause immediately after report.landed and kill the target without ever
 * resuming it. Target-scoped Page.crash cannot execute while Debugger.pause
 * owns that same target (an earlier implementation timed out after 15 s), so
 * the kill is Target.closeTarget from the browser-control channel. Its reply
 * arrives when the close STARTS; the terminal boundary is
 * Target.targetDestroyed. Until that event the target session stays attached,
 * which keeps both the debugger pause and the offline emulation (detaching
 * drops the emulation and releases the pause, letting pagehide flush).
 *
 * A browser-level Fetch collector is open from before the close until
 * T6_LEAK_GRACE_MS after destruction. Every Sentry request from the old
 * document's frames, or carrying its session UUID, is failed and returned as a
 * leak: the caller must fail T6 on any, because an unload flush would make a
 * broken next-open drain look like a recovery. */
export async function freezePageUntilCrash(page: Page, ms: number, oldSessionId: string): Promise<{ pausedMs: number; killedAt: number; leaks: KilledDocumentLeak[] }> {
  const cdp = await page.context().newCDPSession(page)
  let control: CDPSession | null = null
  let rendererGone = false
  let targetDetached = false
  let collecting = false
  const leaks: KilledDocumentLeak[] = []
  let onPaused: ((event: PausedTelemetryRequest) => void) | undefined
  try {
    const browser = page.context().browser()
    if (!browser) throw new Error("paused page has no browser control channel")
    control = await browser.newBrowserCDPSession()
    const channel = control
    await cdp.send("Debugger.enable")
    await cdp.send("Network.enable")
    const target = (await cdp.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } }
    const targetId = target.targetInfo?.targetId
    if (!targetId) throw new Error("paused page target id unavailable")
    const tree = (await cdp.send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string }; childFrames?: unknown[] } }
    const oldFrames = frameIdsOf(tree.frameTree, new Set([targetId]))
    await channel.send("Target.setDiscoverTargets", { discover: true })
    const paused = new Promise<void>((done) => cdp.once("Debugger.paused", () => done()))
    await cdp.send("Debugger.pause")
    await Promise.race([paused, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("page did not pause within 10 s")), 10_000))])
    const started = Date.now()
    await new Promise((resolve) => setTimeout(resolve, ms))
    await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    // Every paused request is released, failed or continued, whatever happens:
    // this interceptor sits in front of every context on the browser.
    onPaused = (event: PausedTelemetryRequest) => {
      let by: KilledDocumentLeak["by"] | null = "frame"
      try {
        by = killedDocumentLeak(event, oldFrames, oldSessionId)
      } catch {
        // an unclassifiable request is treated as the old document's
      }
      if (by) leaks.push({ at: Date.now(), url: event.request.url, by })
      const release = by
        ? channel.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "InternetDisconnected" })
        : channel.send("Fetch.continueRequest", { requestId: event.requestId })
      void release.catch(() => {})
    }
    channel.on("Fetch.requestPaused", onPaused as never)
    await channel.send("Fetch.enable", { patterns: T6_TELEMETRY_PATTERNS })
    collecting = true
    let stopWatching: (() => void) | undefined
    const targetDestroyed = new Promise<void>((resolve) => {
      const listener = ({ targetId: destroyedId }: { targetId: string }) => {
        if (destroyedId === targetId) resolve()
      }
      stopWatching = () => channel.off("Target.targetDestroyed", listener)
      channel.on("Target.targetDestroyed", listener)
    })
    const killedAt = Date.now()
    try {
      const closed = (await Promise.race([
        channel.send("Target.closeTarget", { targetId }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("paused page target did not close within 15 s")), 15_000)),
      ])) as { success?: boolean }
      if (closed.success === false) throw new Error("browser control channel refused to close the paused page target")
      await Promise.race([
        targetDestroyed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("paused page renderer was not destroyed within 15 s")), 15_000)),
      ])
    } finally {
      stopWatching?.()
    }
    rendererGone = true
    // The target is gone, so dropping its emulation can release nothing; the
    // collector stays open across that drop and the grace that follows.
    await cdp.detach().catch(() => {})
    targetDetached = true
    await new Promise((resolve) => setTimeout(resolve, T6_LEAK_GRACE_MS))
    return { pausedMs: killedAt - started, killedAt, leaks: [...leaks] }
  } finally {
    if (collecting) await control?.send("Fetch.disable").catch(() => {})
    if (onPaused) control?.off("Fetch.requestPaused", onPaused as never)
    await control?.detach().catch(() => {})
    // If destruction could not be proven, leave the target session attached:
    // detaching it would drop offline emulation and release the pause, letting
    // the renderer's pagehide telemetry escape. Context teardown owns that.
    if (rendererGone && !targetDetached) await cdp.detach().catch(() => {})
  }
}

/** What the page says after a freeze: its longest timer gap, the performance.now() hold (both from freezeScript) and
 *  whether it ever went hidden (it must not: the freeze is the VISIBLE one). */
export const readFreeze = (page: Page): Promise<{ maxGapMs: number; heldMs: number; hidden: boolean }> =>
  page.evaluate(() => {
    const g = globalThis as unknown as { __e2eMaxGapMs?: number; __e2ePerfOffMs?: number }
    return { maxGapMs: g.__e2eMaxGapMs ?? 0, heldMs: g.__e2ePerfOffMs ?? 0, hidden: document.hidden }
  })
/** Start the heartbeat's measurement afresh (just before a freeze). */
export const resetFreezeGap = (page: Page): Promise<void> =>
  page.evaluate(() => {
    ;(globalThis as unknown as { __e2eMaxGapMs: number }).__e2eMaxGapMs = 0
  })

/** The store clock's saved state (lib/store-clock.ts), read for the reload role's proof. */
export const readSavedStoreClock = (page: Page): Promise<string | null> => page.evaluate(() => sessionStorage.getItem("jollity.storeClock")).catch(() => null)
