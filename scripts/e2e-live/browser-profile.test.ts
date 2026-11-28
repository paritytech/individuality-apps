// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import vm from "node:vm"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { encodeChannelMessage, encodePeerConnectionSignal } from "@jollity/statement-core"
import {
  encodeWireMessage,
  MESSAGE_TYPE_RECEIVE,
  VersionedRemoteStatementStoreSubscribeItem,
  type SignedStatement,
} from "@parity/truapi"
import { activateTelemetryFault, applyTelemetryRoute, botProfile, cameraBlockScript, cameraClip, cameraDelayScript, cameraMuteLoopScript, chromiumArgsFor, clockScript, contextOptionsFor, dataChannelFaultScript, displayedGameTimeCheck, freezePageUntilCrash, freezeScript, hostGestureIdentity, hostGestureScript, hostStorageHangScript, initScriptsFor, killedDocumentLeak, lanePeerFaultScript, lateStatementSignalScript, nextHostGestureTurn, noLocalStorageScript, oneWayVideoScript, outboundVideoIsLive, outboundVideoScript, profileChecks, progressDuringActiveFault, retryAfterViolations, sentryFetchGateScript, shouldProbeCamera, T6_LEAK_GRACE_MS, t8Attempts, telemetryActivationProven, telemetryRouteEvidence, telemetryStartStampScript, visibilityScript } from "./browser-profile"
import { profileByName, profileFor } from "./profile"
import { advanceVideoRoleWindow, type VideoRoleControlState } from "./role-groups"

/** What the browser harness's peerFaultMesh hook returns: this app's harness is observation-only, so the test builds the snapshot itself. */
const projectPeerFaultMesh = (snapshot: { selfId: string; at: number; peers: ReadonlyArray<{ id: string; conn: string; frames?: number; statsLink?: number }> }) => ({
  selfId: snapshot.selfId,
  at: snapshot.at,
  peers: snapshot.peers.map(({ id, conn, frames, statsLink }) => ({ id, conn, frames: frames ?? 0, statsLink })),
})

describe("contextOptionsFor", () => {
  it("merges the device descriptor, asks for the camera and never carries defaultBrowserType", () => {
    const o = contextOptionsFor(profileFor(1))
    expect(o.permissions).toEqual(["camera"])
    expect(o.viewport?.width).toBe(390)
    expect(o.isMobile).toBe(true)
    expect(o.hasTouch).toBe(true)
    expect(o.userAgent).toMatch(/iPhone/)
    expect("defaultBrowserType" in o).toBe(false)
  })
  it("differs per device", () => {
    expect(contextOptionsFor(profileFor(2)).userAgent).toMatch(/Android/)
  })
})

describe("chromiumArgsFor", () => {
  it("always fakes the camera, and adds the profile identity's y4m when configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "crew-camera-"))
    writeFileSync(join(dir, "captain-baseline-720p.y4m"), "clip")
    writeFileSync(join(dir, "lady-latency-360p.y4m"), "clip")
    const env = { E2E_FAKE_VIDEO_DIR: dir }
    expect(chromiumArgsFor(profileFor(1), {})).toEqual(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    expect(chromiumArgsFor(profileFor(1), env)).toContain(`--use-file-for-fake-video-capture=${dir}/captain-baseline-720p.y4m`)
    expect(chromiumArgsFor(profileFor(2), env)).toContain(`--use-file-for-fake-video-capture=${dir}/lady-latency-360p.y4m`)
  })

  it("uses dedicated harness clips for every boot profile and never an identity clip", () => {
    const dir = mkdtempSync(join(tmpdir(), "crew-harness-"))
    writeFileSync(join(dir, "harness-slow-pixel7-lte-poor-360p.y4m"), "clip")
    writeFileSync(join(dir, "harness-baseline-720p.y4m"), "clip")
    const boot = { E2E_STAGE: "boot", E2E_FAKE_VIDEO_DIR: dir, E2E_PROFILE: "slow-pixel7-lte-poor" }
    expect(cameraClip(profileByName("slow-pixel7-lte-poor"), boot)).toBe(`${dir}/harness-slow-pixel7-lte-poor-360p.y4m`)
    expect(cameraClip(null, { ...boot, E2E_PROFILE: "baseline" })).toBe(`${dir}/harness-baseline-720p.y4m`)
  })

  it("keeps ordinary reserved baseline on Chromium's built-in fake camera", () => {
    expect(cameraClip(null, { E2E_FAKE_VIDEO_DIR: "/v", E2E_PROFILE: "baseline" })).toBeUndefined()
    expect(chromiumArgsFor(null, { E2E_FAKE_VIDEO_DIR: "/v", E2E_PROFILE: "baseline" })).toEqual([
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ])
  })

  it("falls back to Chromium when the selected generated source is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "crew-missing-camera-"))
    expect(cameraClip(profileByName("slow-pixel7-lte-poor"), { E2E_FAKE_VIDEO_DIR: dir })).toBeUndefined()
    expect(cameraClip(null, { E2E_STAGE: "boot", E2E_PROFILE: "baseline", E2E_FAKE_VIDEO_DIR: dir })).toBeUndefined()
  })

  it("preserves resolution clips for desk overrides, paseo, and missing generated identities", () => {
    const profile = profileByName("slow-pixel7-lte-poor")
    const fallback = { E2E_FAKE_VIDEO_360P: "/desk/360.y4m", E2E_FAKE_VIDEO_720P: "/desk/720.y4m" }
    expect(cameraClip(profile, fallback)).toBe("/desk/360.y4m")
    expect(cameraClip(profile, { ...fallback, E2E_NETWORK: "paseo-next-v2", E2E_FAKE_VIDEO_DIR: "/missing" })).toBe("/desk/360.y4m")
    expect(cameraClip(profile, { ...fallback, E2E_NETWORK: "previewnet", E2E_FAKE_VIDEO_DIR: "/missing" })).toBe("/desk/360.y4m")
  })
})

describe("init scripts", () => {
  it("uses one availability predicate for preview crew only", () => {
    const profile = profileFor(1)
    expect(hostGestureIdentity(profile, { E2E_NETWORK: "previewnet" })?.key).toBe("captain-baseline")
    expect(hostGestureIdentity(profile, { E2E_NETWORK: "paseo-next-v2" })).toBeNull()
    expect(hostGestureIdentity(profile, { E2E_NETWORK: "previewnet", E2E_STAGE: "boot" })).toBeNull()
    expect(hostGestureIdentity(null, { E2E_NETWORK: "previewnet" })).toBeNull()
  })
  it("latches only the host intro through that turn and clears at ending or handoff", () => {
    expect(nextHostGestureTurn(null, { hostIntroHeadline: false, turn: 2, stage: "intro", sessionStage: "introduction" })).toBeNull()
    expect(nextHostGestureTurn(null, { hostIntroHeadline: true, turn: 2, stage: "intro", sessionStage: "introduction" })).toBe(2)
    expect(nextHostGestureTurn(2, { hostIntroHeadline: false, turn: 2, stage: "play", sessionStage: "gameplay" })).toBe(2)
    expect(nextHostGestureTurn(2, { hostIntroHeadline: false, turn: 2, stage: "play", sessionStage: "ending" })).toBeNull()
    expect(nextHostGestureTurn(2, { hostIntroHeadline: false, turn: 3, stage: "intro", sessionStage: "introduction" })).toBeNull()
  })
  it("only the profile's own tweaks are installed", () => {
    expect(initScriptsFor(profileFor(1))).toHaveLength(0)
    expect(initScriptsFor(profileFor(2))).toHaveLength(1)
    expect(initScriptsFor(profileFor(3))).toHaveLength(1)
  })
  it("does not install outbound-video interception when the resolved role plan is baseline", () => {
    const scripts = initScriptsFor(profileByName("video-role-late-flip"), 0, "baseline").join("\n")
    expect(scripts).not.toContain("__e2eOutboundVideo")
    expect(scripts).not.toContain("RTCPeerConnection")
  })
  it("does not install other dormant role interceptors for a baseline plan", () => {
    expect(initScriptsFor(profileByName("kill-background-iphone13"), 0, "baseline").join("\n")).not.toContain("__e2eHidden")
    expect(initScriptsFor(profileByName("visible-freeze"), 0, "baseline").join("\n")).not.toContain("__e2eMaxGapMs")
  })
  it("installs each peer persona's one closed fault hook", () => {
    for (const name of ["glare-forcer", "late-signal", "one-way-video", "dropped-answer"]) {
      const scripts = initScriptsFor(profileByName(name))
      expect(scripts).toHaveLength(1)
      expect(scripts[0]).toContain(`[e2e-peer-fault] ${name} fired`)
      expect(scripts[0]).toContain("__e2ePeerFault")
    }
  })
  it("applies document-scoped torture faults only to selected loads", () => {
    const t4 = profileByName("telemetry-t4-kill-while-stuck")
    expect(initScriptsFor(t4, 0).join("\n")).toContain("__e2eTelemetryGate")
    expect(initScriptsFor(t4, 0).join("\n")).toContain("let activatedAt = 0")
    expect(initScriptsFor(t4, 1).join("\n")).not.toContain("__e2eTelemetryGate")
    expect(initScriptsFor(t4, 1).join("\n")).not.toContain("traitAt")
    const t5 = profileByName("telemetry-t5-stuck-first-reopen")
    expect(initScriptsFor(t5, 1).join("\n")).toContain("__e2eTelemetryGate")
    expect(initScriptsFor(t5, 1).join("\n")).toContain("wireHeader")
    expect(initScriptsFor(t5, 1).join("\n")).toContain("let activatedAt = Date.now()")
    expect(initScriptsFor(t5, 2).join("\n")).not.toContain("__e2eTelemetryGate")
    expect(initScriptsFor(t5, 2).join("\n")).not.toContain("traitAt")
  })
  it("the host-storage hang drops only TrUAPI localStorage trait frames", () => {
    const sent: number[][] = []
    class WebSocket {
      send(value: Uint8Array) { sent.push([...value]) }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, WebSocket, Uint8Array, ArrayBuffer })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(hostStorageHangScript(), ctx)
    const socket = new WebSocket()
    // SCALE string "a", then trait/method/message-type. Trait 7 is host
    // localStorage; trait 6 is entropy and must still reach the host.
    socket.send(new Uint8Array([4, 97, 7, 0, 0]))
    socket.send(new Uint8Array([4, 97, 6, 0, 0]))
    expect(sent).toEqual([[4, 97, 6, 0, 0]])
    expect(vm.runInContext("globalThis.__e2eHostStorageHang.facts()", ctx)).toMatchObject({ dropped: 1, active: true })
  })
  it("drops only the configured number of renegotiation offers", () => {
    const sent: Uint8Array[] = []
    const devLog = vi.fn()
    class RTCDataChannel {
      send(value: Uint8Array) { sent.push(value) }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCDataChannel, Uint8Array, ArrayBuffer, TextDecoder, console: { log: vi.fn() }, __jollityHarness: { devLog } })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(dataChannelFaultScript(2), ctx)
    const channel = new RTCDataChannel()
    const signal = (tag: "Offer" | "Answer") => encodeChannelMessage({
      id: "webrtc_renegotiation_internal_use_case",
      data: encodePeerConnectionSignal({ tag, value: "v=0" }),
    })
    const offer = signal("Offer")
    const answer = signal("Answer")
    const media = encodeChannelMessage({ id: "webrtc_media_state_use_case", data: new Uint8Array([0]) })
    channel.send(answer)
    channel.send(offer)
    channel.send(media)
    channel.send(offer)
    channel.send(offer)
    expect(sent).toEqual([answer, media, offer])
    expect(vm.runInContext("globalThis.__e2eDataChannelFault.facts()", ctx)).toEqual({ dropped: 2, remaining: 0 })
    expect(devLog).toHaveBeenNthCalledWith(1, "rtc", "[e2e-data-channel-fault] dropped renegotiation offer fault=offer-1 1/2")
    expect(vm.runInContext("globalThis.__e2eDataChannelFaultId", ctx)).toBeUndefined()
    expect((channel as unknown as { __e2eDataChannelFaultId?: string }).__e2eDataChannelFaultId).toBe("offer-2")
  })
  it("selects a peer from inbound SDP and replays only that peer's older generation after its newer one", async () => {
    class MessagePort {
      private handler: ((event: { data: Uint8Array }) => void) | null = null
      get onmessage() { return this.handler }
      set onmessage(value) { this.handler = value }
      postMessage(data: Uint8Array) { void data }
      deliver(data: Uint8Array) { this.handler?.({ data }) }
    }
    const logs: string[] = []
    let meshEvidenceAt = 1
    let meshEvidenceReads = 0
    const timers: Array<() => void> = []
    const peerFaultMesh = vi.fn(() => ({
      selfId: "me",
      at: meshEvidenceAt++,
      peers: [{ id: "peer-a", conn: "connected", frames: ++meshEvidenceReads >= 5 ? 8 : 7, statsLink: 1 }],
    }))
    const forceStatementGenerationsOnce = vi.fn()
      .mockResolvedValueOnce({ requestId: "late-signal-two-generations", peerId: "peer-a", replacements: 0, rejectedReason: "requested peer not eligible", duplicate: false })
      .mockResolvedValueOnce({ requestId: "late-signal-two-generations", peerId: "peer-a", replacements: 2, rejectedReason: null, duplicate: false })
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      MessagePort,
      Uint8Array,
      ArrayBuffer,
      TextDecoder,
      Object,
      Promise,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length },
      queueMicrotask,
      console: { log: (line: string) => logs.push(line) },
      __jollityHarness: { forceStatementGenerationsOnce, peerFaultMesh },
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(lateStatementSignalScript(), ctx)
    const port = new MessagePort()
    const delivered: number[] = []
    port.onmessage = ({ data }) => delivered.push(data.at(-1)!)
    const statement = (payload: unknown): SignedStatement => ({
      proof: { tag: "OnChain", value: { who: `0x${"11".repeat(32)}`, blockHash: `0x${"22".repeat(32)}`, event: 1n } },
      topics: [],
      data: `0x${Buffer.from(JSON.stringify(payload)).toString("hex")}`,
    })
    const wire = (requestId: string, methodId: number, messageType: number, value: Uint8Array) => encodeWireMessage({
      requestId,
      payload: { traitId: 14, methodId, messageType, value },
    })._unsafeUnwrap()
    const received = (marker: number, ...payloads: unknown[]) => {
      const frame = wire("subscribe", 0, MESSAGE_TYPE_RECEIVE, VersionedRemoteStatementStoreSubscribeItem.enc({
        tag: "V1",
        value: { statements: payloads.map(statement), isComplete: true },
      }))
      return new Uint8Array([...frame, marker])
    }
    const flushTimers = async () => {
      for (let pass = 0; pass < 4; pass += 1) {
        while (timers.length > 0) timers.shift()?.()
        await Promise.resolve()
      }
    }
    // The bot's own echoed bundle can arrive first. It identifies local=me,
    // but its descriptions are outbound and must not select a remote peer.
    port.deliver(received(1, { t: "b", from: "me", f: {
      "d:peer-a": { t: "d", from: "me", gen: "mine" },
    } }))
    // Game 1426's room-wide subscription exposed descriptions from senders
    // that were not current mesh peers. They must not become the forced peer.
    port.deliver(received(2, { t: "b", from: "peer-outside-mesh", f: {
      "d:me": { t: "d", from: "peer-outside-mesh", gen: "outside-g1" },
    } }))
    port.deliver(received(3, { t: "b", from: "peer-a", f: {
      "d:someone-else": { t: "d", from: "peer-a", gen: "other-stable" },
      "d:me": { t: "d", from: "peer-a", gen: "g1" },
    } }))
    // Repeating an unchanged multi-link bundle must not create a nested
    // peer-a>subscribed candidate, hold a page, or satisfy the fault.
    port.deliver(received(4, { t: "b", from: "peer-a", f: {
      "d:someone-else": { t: "d", from: "peer-a", gen: "other-stable" },
      "d:me": { t: "d", from: "peer-a", gen: "g1" },
    } }))
    await flushTimers()
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({
      held: false,
      reordered: 0,
      generationPeer: "peer-a",
      observedKeys: ["me>peer-a", "peer-outside-mesh>me", "peer-a>someone-else", "peer-a>me"],
    })
    port.deliver(received(5, { t: "b", from: "peer-b", f: { "d:me": { t: "d", from: "peer-b", gen: "b1" } } }))
    port.deliver(received(6, { t: "b", from: "peer-b", f: { "d:me": { t: "d", from: "peer-b", gen: "b2" } } }))
    port.deliver(received(7, { t: "b", from: "peer-b", f: { "d:me": { t: "d", from: "peer-b", gen: "b3" } } }))
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(logs).toEqual([])
    // A third-party slot changes first. It must not count as this bot's
    // replacement, request another generation, or become replay evidence.
    port.deliver(received(8, { t: "b", from: "peer-a", f: {
      "d:someone-else": { t: "d", from: "peer-a", gen: "other-changed" },
      "d:me": { t: "d", from: "peer-a", gen: "g1" },
    } }))
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    port.deliver(received(9, { t: "b", from: "peer-a", f: {
      "d:someone-else": { t: "d", from: "peer-a", gen: "other-changed-again" },
      "d:me": { t: "d", from: "peer-a", gen: "g2" },
    } }))
    // The first replacement must establish before the persona asks the same
    // link for another generation. Keep a replay copy, but do not strand g2.
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    port.deliver(received(10, { t: "b", from: "peer-a", f: {
      "d:someone-else": { t: "d", from: "peer-a", gen: "other-final" },
      "d:me": { t: "d", from: "peer-a", gen: "g3" },
    } }))
    await Promise.resolve()
    await Promise.resolve()
    await flushTimers()
    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9])
    expect(forceStatementGenerationsOnce).toHaveBeenCalledTimes(2)
    expect(forceStatementGenerationsOnce).toHaveBeenNthCalledWith(1, "late-signal-two-generations", "peer-a")
    expect(forceStatementGenerationsOnce).toHaveBeenNthCalledWith(2, "late-signal-two-generations", "peer-a")
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toEqual({
      kind: "late-signal",
      held: false,
      reordered: 1,
      generationRequest: "complete",
      generationPeer: "peer-a",
      observedKeys: ["me>peer-a", "peer-outside-mesh>me", "peer-a>someone-else", "peer-a>me", "peer-b>me"],
    })
    expect(logs).toEqual([
      "[e2e-peer-fault] late-signal fired fault=store-sdp-order-1 peer=peer-a link=peer-a>me newer=g3 older=g2",
      "[e2e-peer-fault] late-signal recovered peer=peer-a connected frames=8",
    ])
  })
  it("blocks only outgoing video and proves a real video sender was suppressed across direct sender replacements", async () => {
    const audioSender = { track: { kind: "audio" } }
    const videoReplacements: unknown[] = []
    const videoSender = { track: null, replaceTrack: async (track: unknown) => { videoReplacements.push(track) } }
    class RTCPeerConnection {
      __jollityE2EPeerId = "peer-z"
      __jollityE2EPolite = false
      addTrack(track: { kind: string }) { void track; return audioSender }
      addTransceiver() { return { sender: videoSender } }
    }
    const logs: string[] = []
    let at = 1
    let frames = 4
    const timers: Array<() => void> = []
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      RTCPeerConnection,
      console: { log: (line: string) => logs.push(line) },
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length },
      __jollityHarness: { peerFaultMesh: () => ({ selfId: "me", at: at++, peers: [{ id: "peer-z", conn: "connected", frames, statsLink: 1 }] }) },
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(oneWayVideoScript(), ctx)
    const pc = new RTCPeerConnection()
    expect(pc.addTrack({ kind: "audio" } as never)).toBe(audioSender)
    const sender = pc.addTrack({ kind: "video" } as never) as unknown as typeof videoSender
    expect(sender).toBe(videoSender)
    expect(logs).toEqual([
      "[e2e-peer-fault] one-way-video fired fault=outgoing-video-1 sender-track=null initiator-peer=peer-z",
    ])
    timers.shift()?.()
    expect(logs).toEqual([
      "[e2e-peer-fault] one-way-video fired fault=outgoing-video-1 sender-track=null initiator-peer=peer-z",
    ])
    // A replacement stream restarts its cumulative decoded-frame counter.
    frames = 2
    timers.shift()?.()
    const replacement = { kind: "video", id: "replacement-camera" }
    await sender.replaceTrack(replacement)
    expect(videoReplacements).toEqual([null])
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toEqual({ kind: "one-way-video", suppressed: 1 })
    expect(logs).toEqual([
      "[e2e-peer-fault] one-way-video fired fault=outgoing-video-1 sender-track=null initiator-peer=peer-z",
      "[e2e-peer-fault] one-way-video recovered peer=peer-z connected frames=2",
    ])
  })
  it("forces a local offer only on the polite incoming-channel side with sendrecv video", async () => {
    const devLog = vi.fn()
    class RTCDataChannel {
      private handler: ((event: { data: Uint8Array }) => void) | null = null
      get onmessage() { return this.handler }
      set onmessage(value) { this.handler = value }
      send() {}
      deliver(data: Uint8Array) { this.handler?.({ data }) }
    }
    class RTCPeerConnection {
      __jollityE2EPeerId = "peer-g"
      __jollityE2EPolite = true
      connectionState = "connected"
      signalingState = "stable"
      remoteDescription = { sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n" }
      private dataListeners: Array<(event: { channel: RTCDataChannel }) => void> = []
      addEventListener(type: string, listener: (event: { channel: RTCDataChannel }) => void) { if (type === "datachannel") this.dataListeners.push(listener) }
      createDataChannel() { const channel = new RTCDataChannel(); return channel }
      receiveDataChannel() { const channel = new RTCDataChannel(); for (const listener of this.dataListeners) listener({ channel }); return channel }
      async setLocalDescription() { this.signalingState = "have-local-offer" }
      close() {}
    }
    let at = 1
    let frames = 5
    let statsLink = 11
    const peerFaultMesh = () => projectPeerFaultMesh({
      selfId: "me",
      at: at++,
      peers: [{ id: "peer-g", conn: "connected", frames, statsLink }],
    })
    const timers: Array<() => void> = []
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      RTCPeerConnection,
      RTCDataChannel,
      Uint8Array,
      ArrayBuffer,
      TextDecoder,
      Object,
      Promise,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length },
      console: { log: vi.fn() },
      __jollityHarness: { devLog, peerFaultMesh },
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(lanePeerFaultScript("glare-forcer"), ctx)
    const Wrapped = (ctx as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection
    const pc = new Wrapped()
    const impolite = pc.createDataChannel()
    const channel = pc.receiveDataChannel()
    const received: Uint8Array[] = []
    channel.onmessage = ({ data }) => received.push(data)
    const offer = encodeChannelMessage({ id: "webrtc_renegotiation_internal_use_case", data: encodePeerConnectionSignal({ tag: "Offer", value: "v=0" }) })
    impolite.onmessage = ({ data }) => received.push(data)
    impolite.deliver(offer)
    expect(received).toEqual([offer])
    channel.deliver(offer)
    expect(received).toEqual([offer, offer])
    pc.remoteDescription = { sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n" }
    pc.__jollityE2EPolite = false
    channel.deliver(offer)
    expect(received).toEqual([offer, offer, offer])
    pc.__jollityE2EPolite = true
    impolite.deliver(offer)
    expect(received).toEqual([offer, offer, offer])
    await Promise.resolve()
    expect(pc.signalingState).toBe("have-local-offer")
    expect(received).toEqual([offer, offer, offer, offer])
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({ kind: "glare-forcer", fired: 1 })
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] glare-forcer fired fault=glare-1 local-offer-before-remote-offer video-negotiated")
    timers.shift()?.()
    expect(devLog).not.toHaveBeenCalledWith("rtc", expect.stringContaining("glare-forcer recovered"))
    frames = 6
    timers.shift()?.()
    expect(devLog).not.toHaveBeenCalledWith("rtc", expect.stringContaining("glare-forcer recovered"))
    statsLink = 12
    timers.shift()?.()
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] glare-forcer recovered peer=peer-g connected frames=6")
  })
  it("does not force glare on a peer with 0 decoded frames, and does on one that is sending", async () => {
    const devLog = vi.fn()
    class RTCDataChannel {
      private handler: ((event: { data: Uint8Array }) => void) | null = null
      get onmessage() { return this.handler }
      set onmessage(value) { this.handler = value }
      send() {}
      deliver(data: Uint8Array) { this.handler?.({ data }) }
    }
    class RTCPeerConnection {
      __jollityE2EPeerId = "peer-nulled"
      __jollityE2EPolite = true
      connectionState = "connected"
      signalingState = "stable"
      // the SDP still says sendrecv: a nulled sender (one-way-video) passes this check
      remoteDescription = { sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n" }
      private dataListeners: Array<(event: { channel: RTCDataChannel }) => void> = []
      addEventListener(type: string, listener: (event: { channel: RTCDataChannel }) => void) { if (type === "datachannel") this.dataListeners.push(listener) }
      createDataChannel() { return new RTCDataChannel() }
      receiveDataChannel() { const channel = new RTCDataChannel(); for (const listener of this.dataListeners) listener({ channel }); return channel }
      async setLocalDescription() { this.signalingState = "have-local-offer" }
      close() {}
    }
    let at = 1
    let frames = 0
    let statsLink = 3
    const timers: Array<() => void> = []
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      RTCPeerConnection,
      RTCDataChannel,
      Uint8Array,
      ArrayBuffer,
      TextDecoder,
      Object,
      Promise,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length },
      console: { log: vi.fn() },
      __jollityHarness: {
        devLog,
        peerFaultMesh: () => projectPeerFaultMesh({ selfId: "me", at: at++, peers: [{ id: "peer-nulled", conn: "connected", frames, statsLink }] }),
      },
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(lanePeerFaultScript("glare-forcer"), ctx)
    const Wrapped = (ctx as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection
    const pc = new Wrapped()
    const channel = pc.receiveDataChannel()
    const received: Uint8Array[] = []
    channel.onmessage = ({ data }) => received.push(data)
    const offer = encodeChannelMessage({ id: "webrtc_renegotiation_internal_use_case", data: encodePeerConnectionSignal({ tag: "Offer", value: "v=0" }) })

    channel.deliver(offer)
    await Promise.resolve()
    expect(pc.signalingState).toBe("stable")
    expect(received).toEqual([offer])
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({ fired: 0 })
    expect(devLog).not.toHaveBeenCalledWith("rtc", expect.stringContaining("glare-forcer fired"))
    expect(devLog).toHaveBeenCalledWith("rtc", expect.stringContaining("glare-forcer skipped peer=peer-nulled frames=0"))

    frames = 4
    channel.deliver(offer)
    await Promise.resolve()
    expect(pc.signalingState).toBe("have-local-offer")
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({ fired: 1 })
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] glare-forcer fired fault=glare-1 local-offer-before-remote-offer video-negotiated")
    timers.shift()?.()
    frames = 5
    statsLink = 4
    timers.shift()?.()
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] glare-forcer recovered peer=peer-nulled connected frames=5")
  })
  it("marks game 1426's already-colliding negotiated-video offer and waits for its rebuilt link", () => {
    const devLog = vi.fn()
    class RTCDataChannel {
      private handler: ((event: { data: Uint8Array }) => void) | null = null
      get onmessage() { return this.handler }
      set onmessage(value) { this.handler = value }
      send() {}
      deliver(data: Uint8Array) { this.handler?.({ data }) }
    }
    class RTCPeerConnection {
      __jollityE2EPeerId = "5FhY-game1426"
      __jollityE2EPolite = true
      connectionState = "connected"
      signalingState = "have-local-offer"
      remoteDescription = { sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n" }
      setLocalDescription = vi.fn()
      private dataListeners: Array<(event: { channel: RTCDataChannel }) => void> = []
      addEventListener(type: string, listener: (event: { channel: RTCDataChannel }) => void) { if (type === "datachannel") this.dataListeners.push(listener) }
      createDataChannel() { return new RTCDataChannel() }
      receiveDataChannel() { const channel = new RTCDataChannel(); for (const listener of this.dataListeners) listener({ channel }); return channel }
      close() {}
    }
    let at = 1
    let frames = 42
    let statsLink = 7
    const timers: Array<() => void> = []
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      RTCPeerConnection,
      RTCDataChannel,
      Uint8Array,
      ArrayBuffer,
      TextDecoder,
      Object,
      Promise,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length },
      console: { log: vi.fn() },
      __jollityHarness: {
        devLog,
        peerFaultMesh: () => projectPeerFaultMesh({
          selfId: "game1426-bot1",
          at: at++,
          peers: [{ id: "5FhY-game1426", conn: "connected", frames, statsLink }],
        }),
      },
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(lanePeerFaultScript("glare-forcer"), ctx)
    const Wrapped = (ctx as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection
    const pc = new Wrapped()
    const channel = pc.receiveDataChannel()
    const received: Uint8Array[] = []
    channel.onmessage = ({ data }) => received.push(data)
    const offer = encodeChannelMessage({ id: "webrtc_renegotiation_internal_use_case", data: encodePeerConnectionSignal({ tag: "Offer", value: "v=0" }) })

    channel.deliver(offer)

    expect(received).toEqual([offer])
    expect(pc.setLocalDescription).not.toHaveBeenCalled()
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] glare-forcer fired fault=glare-1 existing-local-offer-before-remote-offer video-negotiated")
    timers.shift()?.()
    expect(devLog).not.toHaveBeenCalledWith("rtc", expect.stringContaining("glare-forcer recovered"))
    frames = 1
    statsLink = 8
    timers.shift()?.()
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] glare-forcer recovered peer=5FhY-game1426 connected frames=1")
  })
  it("orchestrates original close, a later-msid dropped answer, and a second same-stream replacement", async () => {
    const sent: Uint8Array[] = []
    const devLog = vi.fn()
    const forcePeerRebuildOnce = vi.fn()
      .mockResolvedValueOnce({ rebuilt: false, rejectedReason: "peer left" })
      .mockResolvedValue({ rebuilt: true })
    class RTCDataChannel {
      get onmessage() { return null }
      set onmessage(_value: unknown) {}
      send(value: Uint8Array) { sent.push(value) }
    }
    class RTCPeerConnection {
      __jollityE2EPolite = true
      connectionState = "connected"
      signalingState = "stable"
      __jollityE2EPeerId: string
      remoteDescription: { sdp: string } | null = null
      private dataListeners: Array<(event: { channel: RTCDataChannel }) => void> = []
      private listeners = new Map<string, Array<(event?: unknown) => void>>()
      constructor(peer = "peer-account") {
        this.__jollityE2EPeerId = peer
      }
      addEventListener(type: string, listener: ((event: { channel: RTCDataChannel }) => void) | (() => void)) {
        if (type === "datachannel") this.dataListeners.push(listener as (event: { channel: RTCDataChannel }) => void)
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener as () => void)
        this.listeners.set(type, listeners)
      }
      createDataChannel() { return new RTCDataChannel() }
      async setRemoteDescription(value: { sdp: string }) {
        this.remoteDescription = value
        for (const listener of this.listeners.get("signalingstatechange") ?? []) listener()
      }
      setState(value: string) {
        this.connectionState = value
        for (const listener of this.listeners.get("connectionstatechange") ?? []) listener()
      }
      close() {}
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection, RTCDataChannel, Uint8Array, ArrayBuffer, TextDecoder, Object, Promise, console: { log: vi.fn() }, __jollityHarness: { devLog, forcePeerRebuildOnce } })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(lanePeerFaultScript("dropped-answer"), ctx)
    const Wrapped = (ctx as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection
    const signal = (tag: "Offer" | "Answer") => encodeChannelMessage({ id: "webrtc_renegotiation_internal_use_case", data: encodePeerConnectionSignal({ tag, value: "v=0" }) })
    const description = (stream: string, session: string) => ({ sdp: `v=0\r\no=- ${session} 2 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${session}\r\na=msid:${stream} video-track\r\n` })
    const offeringSide = new Wrapped("offering-account")
    offeringSide.__jollityE2EPolite = false
    await offeringSide.setRemoteDescription(description("offering-stream", "offering-session"))
    expect(forcePeerRebuildOnce).not.toHaveBeenCalled()
    const first = new Wrapped("peer-account")
    first.createDataChannel().send(signal("Answer"))
    expect(forcePeerRebuildOnce).not.toHaveBeenCalled()
    await first.setRemoteDescription(description("peer-stream", "session-1"))
    expect(forcePeerRebuildOnce).toHaveBeenCalledWith("dropped-answer-first", "peer-account")
    await Promise.resolve()
    first.setState("connected")
    expect(forcePeerRebuildOnce).toHaveBeenCalledTimes(2)
    expect(forcePeerRebuildOnce).toHaveBeenLastCalledWith("dropped-answer-first", "peer-account")
    await Promise.resolve()
    first.close()
    const otherLink = new Wrapped("other-account")
    await otherLink.setRemoteDescription(description("other-stream", "other-session"))
    otherLink.createDataChannel().send(signal("Answer"))
    const rebuilt = new Wrapped("peer-account")
    const channel = rebuilt.createDataChannel()
    channel.send(signal("Offer"))
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({ fired: 0 })
    await rebuilt.setRemoteDescription(description("peer-stream", "session-2"))
    channel.send(signal("Answer"))
    channel.send(signal("Answer"))
    await Promise.resolve()
    expect(sent).toEqual([signal("Answer"), signal("Answer"), signal("Offer"), signal("Answer")])
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({ kind: "dropped-answer", fired: 1, closed: 1, recovered: 0 })
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] dropped-answer fired fault=answer-1 same-stream-rebuild=peer-stream")
    expect(forcePeerRebuildOnce).toHaveBeenCalledWith("dropped-answer-second", "peer-account")
    const recovered = new Wrapped("peer-account")
    recovered.setState("connected")
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({ recovered: 0 })
    await recovered.setRemoteDescription(description("peer-stream", "session-3"))
    expect(vm.runInContext("globalThis.__e2ePeerFault.facts()", ctx)).toMatchObject({ recovered: 1 })
    expect(devLog).toHaveBeenCalledWith("rtc", "[e2e-peer-fault] dropped-answer recovered link=peer-stream")
  })
  it("keeps an activateAtTurn host-storage fault inert until armed, then releases it", () => {
    const sent: number[][] = []
    let now = 100
    class WebSocket {
      send(value: Uint8Array) { sent.push([...value]) }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, WebSocket, Uint8Array, ArrayBuffer, Date: { now: () => now } })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(hostStorageHangScript(3, true), ctx)
    const socket = new WebSocket()
    const storage = new Uint8Array([4, 97, 7, 0, 0])
    socket.send(storage)
    expect(sent).toHaveLength(1)
    expect(vm.runInContext("globalThis.__e2eHostStorageHang.facts()", ctx)).toMatchObject({ dropped: 0, active: false, release: 0 })
    expect(vm.runInContext("globalThis.__e2eHostStorageHang.activate(3000)", ctx)).toBe(3100)
    socket.send(storage)
    expect(sent).toHaveLength(1)
    now = 3100
    socket.send(storage)
    expect(sent).toHaveLength(2)
    expect(vm.runInContext("globalThis.__e2eHostStorageHang.facts()", ctx)).toMatchObject({ dropped: 1, active: false, activatedAt: 100, release: 3100 })
  })
  it("the no-localStorage profile throws SecurityError", () => {
    const ctx = vm.createContext({ globalThis: undefined as unknown, Object, DOMException })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(noLocalStorageScript(), ctx)
    expect(() => (ctx as { localStorage?: unknown }).localStorage).toThrow(/Storage disabled by E2E/)
  })
  it("the iOS fetch gate leaves non-Sentry requests alone", async () => {
    const calls: string[] = []
    const ctx = vm.createContext({ globalThis: undefined as unknown, fetch: async (url: string) => (calls.push(url), { ok: true }), Date, setTimeout, Math })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(sentryFetchGateScript(120), ctx)
    await (ctx as { fetch: (url: string) => Promise<unknown> }).fetch("https://example.test/data")
    expect(calls).toEqual(["https://example.test/data"])
  })
  it("the mid-game iOS gate is inert until armed, then holds Sentry until release", async () => {
    const calls: string[] = []
    let now = 100
    let timer: { run: () => void; ms: number } | undefined
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      fetch: async (url: string) => (calls.push(url), { ok: true }),
      Date: { now: () => now },
      Math,
      setTimeout: (run: () => void, ms: number) => ((timer = { run, ms }), 1),
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(sentryFetchGateScript(3, true), ctx)
    const fetch = (ctx as { fetch: (url: string) => Promise<unknown> }).fetch
    await fetch("https://sentry.example/api/1/envelope/")
    vm.runInContext("globalThis.__e2eTelemetryGate.activate(3000)", ctx)
    const pending = fetch("https://sentry.example/api/1/envelope/")
    expect(calls).toHaveLength(1)
    expect(timer?.ms).toBe(3000)
    now = 3100
    timer?.run()
    await pending
    expect(calls).toHaveLength(2)
  })
  it("checks every same-page attempt across the complete Retry-After window", () => {
    expect(retryAfterViolations([999, 1_000, 2_000, 121_000, 121_001], 120_000, 1_000)).toEqual([2_000])
    expect(retryAfterViolations([999, 1_000], 120_000, null)).toEqual([])
  })
  it("stamps a Sentry fetch's start on the real wall clock, before the request leaves", async () => {
    const calls: unknown[][] = []
    const stamps: number[] = []
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      fetch: async (...args: unknown[]) => (calls.push(args), { status: 429 }),
      // clockScript's offset clock: the stamp must not read it
      Date: { now: () => 9_999_999 },
      performance: { timeOrigin: 1_000_000, now: () => 234.5 },
      Promise,
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    ;(ctx as { __e2eTelemetryStamp?: unknown }).__e2eTelemetryStamp = async (at: number) => { stamps.push(at) }
    vm.runInContext(telemetryStartStampScript(), ctx)
    const fetch = (ctx as { fetch: (...args: unknown[]) => Promise<unknown> }).fetch
    const init = { method: "POST", body: "{}", keepalive: true }
    await fetch("https://o1.ingest.de.sentry.io/api/42/envelope/?sentry_key=k", init)
    await fetch("https://example.test/data")
    // the app's request goes out exactly as it asked
    expect(calls).toEqual([["https://o1.ingest.de.sentry.io/api/42/envelope/?sentry_key=k", init], ["https://example.test/data"]])
    expect(stamps).toEqual([1_000_234.5])
  })
  it("never lets a failing stamp break the app's fetch", async () => {
    const calls: unknown[] = []
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      fetch: async (url: unknown) => (calls.push(url), { status: 200 }),
      performance: { timeOrigin: 0, now: () => 1 },
      Promise,
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    ;(ctx as { __e2eTelemetryStamp?: unknown }).__e2eTelemetryStamp = () => { throw new Error("binding gone") }
    vm.runInContext(telemetryStartStampScript(), ctx)
    await (ctx as { fetch: (url: string) => Promise<unknown> }).fetch("https://sentry.example/api/1/envelope/")
    expect(calls).toEqual(["https://sentry.example/api/1/envelope/"])
  })
  it("installs T8's start stamp last, so it wraps every other fetch hook", () => {
    const t8 = profileByName("telemetry-t8-sentry-429")
    expect(initScriptsFor(t8, 0).at(-1)).toBe(telemetryStartStampScript())
    expect(initScriptsFor(profileByName("telemetry-t5-stuck-first-reopen"), 0)).not.toContain(telemetryStartStampScript())
  })
  it("judges a request by when the page started it, not when the route handler ran", () => {
    // The harness sends the 429 at 2_000 (its clock, before fulfil). Request
    // A was already in flight (page stamp 1_990) but Playwright handed it to
    // the route at 2_015; request B is a premature retry started at 2_400.
    const attempts = t8Attempts({ activatedAt: 1_000, routed: 2, stamps: [1_990, 2_400] })
    expect(retryAfterViolations(attempts, 120_000, 2_000)).toEqual([2_400])
    // stamps from before the fault started are not part of it
    expect(t8Attempts({ activatedAt: 1_995, routed: 2, stamps: [1_990, 2_400] })).toEqual([2_400])
  })
  it("dates T8 requests through the real route wiring, where timing().startTime is 0", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      type Page = Parameters<typeof applyTelemetryRoute>[0]
      let stamp: ((source: unknown, at: unknown) => void) | undefined
      let handler: ((route: unknown) => Promise<unknown>) | undefined
      const page = {
        exposeBinding: async (_name: string, callback: (source: unknown, at: unknown) => void) => { stamp = callback },
        route: async (_pattern: string, next: (route: unknown) => Promise<unknown>) => { handler = next },
        evaluate: async () => null,
      } as unknown as Page
      const fulfils: Array<() => void> = []
      const fulfilled: Array<{ status?: number; headers?: Record<string, string> }> = []
      const fakeRoute = () => ({
        request: () => ({
          url: () => "https://o1.ingest.de.sentry.io/api/42/envelope/?sentry_key=k",
          resourceType: () => "fetch",
          // what Playwright reports inside a route handler: no Response yet
          timing: () => ({ startTime: 0 }),
        }),
        fulfill: (options: { status?: number; headers?: Record<string, string> }) => {
          fulfilled.push(options)
          return new Promise<void>((resolve) => fulfils.push(resolve))
        },
        continue: async () => {},
        abort: async () => {},
      })
      const t8 = profileByName("telemetry-t8-sentry-429").telemetryTorture!
      expect(await applyTelemetryRoute(page, t8, 0)).toBe(true)
      await activateTelemetryFault(page, t8)

      stamp!(null, 1_000_050) // A
      stamp!(null, 1_000_090) // B: in flight beside A, before any 429 exists...
      vi.setSystemTime(1_000_100)
      const handledA = handler!(fakeRoute()) // A's 429 is being fulfilled
      vi.setSystemTime(1_000_200)
      fulfils.shift()!()
      await handledA
      expect(fulfilled[0]).toMatchObject({
        status: 429,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Retry-After",
          "retry-after": "120",
        },
      })
      vi.setSystemTime(1_000_300)
      const handledB = handler!(fakeRoute()) // ...but its handler runs after
      fulfils.shift()!()
      await handledB
      stamp!(null, 1_000_400) // C: a premature retry
      const handledC = handler!(fakeRoute())
      fulfils.shift()!()
      await handledC

      const evidence = telemetryRouteEvidence(page)!
      expect(evidence.first429At).toBe(1_000_100) // taken before fulfil
      expect(retryAfterViolations(evidence.attempts, t8.retryAfterS! * 1000, evidence.first429At)).toEqual([1_000_400])

      // a routed send the page never stamped cannot be dated: NOT PROVEN
      const handledD = handler!(fakeRoute())
      fulfils.shift()!()
      await handledD
      expect(() => telemetryRouteEvidence(page)).toThrow(/T8 NOT PROVEN/)
    } finally {
      vi.useRealTimers()
    }
  })
  it("fails T8 closed when a routed Sentry request carried no page stamp", () => {
    expect(() => t8Attempts({ activatedAt: 1_000, routed: 3, stamps: [1_990, 2_400] })).toThrow(/T8 NOT PROVEN.*1 Sentry request/)
    expect(() => t8Attempts({ activatedAt: 1_000, routed: 1, stamps: [] })).toThrow(/T8 NOT PROVEN/)
  })
  it("arms T5's first-reopen fetch gate in the init script before app boot", () => {
    const t5 = profileByName("telemetry-t5-stuck-first-reopen")
    expect(initScriptsFor(t5, 0).join("\n")).toContain("let release = 0")
    expect(initScriptsFor(t5, 1).join("\n")).not.toContain("let release = 0")
    expect(initScriptsFor(t5, 1).join("\n")).toContain("Date.now() + 3600000")
  })
  it("does not prove an armed persona whose turn or recovery deadline was never observed", () => {
    expect(telemetryActivationProven(1, false, null)).toBe(false)
    expect(telemetryActivationProven(1, true, null)).toBe(false)
    expect(telemetryActivationProven(1, true, 123)).toBe(true)
    expect(telemetryActivationProven(undefined, false, null)).toBe(true)
  })
  it("the clock script shifts Date.now, new Date and instanceof stays true", () => {
    const ctx = vm.createContext({ globalThis: undefined as unknown })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    const before = Date.now()
    vm.runInContext(`${clockScript(75)}; var now = Date.now(); var viaNew = new Date().getTime(); var fixed = new Date(5).getTime(); var ok = new Date() instanceof Date`, ctx)
    const c = ctx as unknown as { now: number; viaNew: number; fixed: number; ok: boolean }
    expect(c.now - before).toBeGreaterThanOrEqual(75_000)
    expect(c.now - before).toBeLessThan(76_000)
    expect(c.viaNew - before).toBeGreaterThanOrEqual(75_000)
    expect(c.fixed).toBe(5)
    expect(c.ok).toBe(true)
  })
  it("the camera script delays video getUserMedia only", async () => {
    // fake clock: the 60 ms delay is a timer on the script's own clock, so advance it rather than measure wall time on a loaded runner (#634)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const calls: string[] = []
      const md = { getUserMedia: async (c: { video?: boolean }) => (calls.push(c.video ? "v" : "a"), "stream") }
      const ctx = vm.createContext({ navigator: { mediaDevices: md }, setTimeout })
      vm.runInContext(cameraDelayScript(60), ctx)
      let settled = false
      const video = md.getUserMedia({ video: true }).then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(59)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await video
      expect(settled).toBe(true)
      await md.getUserMedia({ video: false }) // no timer to advance: it resolves without the clock moving
      expect(calls).toEqual(["v", "a"])
    } finally {
      vi.useRealTimers()
    }
  })
  it("the visibility script flips hidden and visibilityState", () => {
    class Document {
      get hidden() { return false }
      get visibilityState() { return "visible" }
    }
    const doc = new Document()
    const win: Record<string, unknown> = {}
    const ctx = vm.createContext({ Document, document: doc, window: win, Object })
    vm.runInContext(visibilityScript(), ctx)
    expect(doc.hidden).toBe(false)
    win.__e2eHidden = true
    expect(doc.hidden).toBe(true)
    expect(doc.visibilityState).toBe("hidden")
  })
  it("wraps the native camera at source, switches drawings, reopens fresh, and stops cleanly", async () => {
    const stopped: string[] = []
    let nativeId = 0
    const nativeTracks: { listeners: Record<string, () => void>; stop(): void }[] = []
    const mediaDevices = { getUserMedia: vi.fn(async (_constraints: { video?: boolean }) => {
      void _constraints
      const id = ++nativeId
      const listeners: Record<string, () => void> = {}
      const videoTrack = {
        kind: "video",
        listeners,
        getSettings: () => ({ width: 1280, height: 720, frameRate: 15 }),
        addEventListener: (name: string, listener: () => void) => { listeners[name] = listener },
        stop: () => stopped.push(`native-${id}`),
      }
      const stream = { getVideoTracks: () => [videoTrack], getAudioTracks: () => [], getTracks: () => [videoTrack] }
      nativeTracks.push(videoTrack)
      return stream
    }) }
    class MediaStream {
      constructor(public tracks: unknown[]) {}
      getVideoTracks(): { kind: string; stop(): void }[] { return this.tracks.filter((track) => (track as { kind?: string }).kind === "video") as { kind: string; stop(): void }[] }
    }
    class MediaStreamTrackProcessor { readable = {}; constructor(_options: unknown) { void _options } }
    class MediaStreamTrackGenerator {
      kind = "video"
      writable = {}
      stop = vi.fn()
      getSettings = () => ({ resizeMode: "none" })
      events: string[] = []
      dispatchEvent(event: Event) { this.events.push(event.type); return true }
      constructor(_options: unknown) { void _options }
    }
    const workers: { messages: unknown[]; terminated: boolean; onmessage?: (event: { data: unknown }) => void }[] = []
    class Worker {
      messages: unknown[] = []
      terminated = false
      onmessage?: (event: { data: unknown }) => void
      constructor(_url: string) { void _url; workers.push(this) }
      postMessage(message: unknown) { this.messages.push(message) }
      terminate() { this.terminated = true }
    }
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      navigator: { mediaDevices },
      MediaStream,
      MediaStreamTrackProcessor,
      MediaStreamTrackGenerator,
      Worker,
      OffscreenCanvas: class {},
      VideoFrame: class {},
      Blob: class {},
      URL: { createObjectURL: () => "blob:worker" },
      fetch: async () => ({ ok: true, blob: async () => ({}) }),
      createImageBitmap: async () => ({}),
      DOMException,
      Event,
      Error,
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(hostGestureScript("data:image/webp;base64,one", "data:image/webp;base64,two"), ctx)
    const control = (ctx as unknown as { __e2eHostGesture: {
      enable(): Promise<{ active: boolean; ready: boolean; sources: number }>
      disable(): Promise<{ active: boolean; ready: boolean; sources: number }>
      facts(): { active: boolean; ready: boolean; sources: number; frameRate: number; width: number; height: number }
    } }).__e2eHostGesture

    const first = await mediaDevices.getUserMedia({ video: true }) as unknown as MediaStream
    expect(first).toBeInstanceOf(MediaStream)
    expect((first.getVideoTracks()[0] as unknown as { getSettings(): unknown }).getSettings()).toMatchObject({ width: 1280, height: 720, frameRate: 15, resizeMode: "none" })
    expect(workers[0].messages[0]).toMatchObject({ type: "init", width: 1280, height: 720 })
    await control.enable()
    expect(workers[0].messages[1]).toMatchObject({ type: "active", active: true, poses: [{}, {}] })
    await mediaDevices.getUserMedia({ video: true })
    expect(control.facts()).toMatchObject({ active: true, ready: true, sources: 2, frameRate: 15, width: 1280, height: 720 })
    nativeTracks[0].listeners.mute()
    expect(workers[0].messages.at(-1)).toMatchObject({ type: "muted", muted: true })
    expect(first.getVideoTracks()[0]).toMatchObject({ events: ["mute"] })
    nativeTracks[0].listeners.ended()
    expect(stopped).toContain("native-1")
    expect(workers[0].terminated).toBe(true)
    expect(control.facts()).toMatchObject({ sources: 1 })
    await control.disable()
    expect(workers[1].messages.at(-1)).toMatchObject({ type: "active", active: false })
  })
  it("retries gesture decoding after a failed image load", async () => {
    let attempts = 0
    const track = { kind: "video", getSettings: () => ({}), addEventListener: vi.fn(), stop: vi.fn() }
    class MediaStream { constructor(public tracks: unknown[] = []) {} getVideoTracks() { return this.tracks.length ? [track] : [] } getAudioTracks() { return [] } getTracks() { return [track] } }
    class MediaStreamTrackProcessor { readable = {}; }
    class MediaStreamTrackGenerator { kind = "video"; writable = {}; stop = vi.fn(); dispatchEvent() { return true } }
    const workers: { messages: unknown[]; terminated: boolean }[] = []
    class Worker {
      onmessage?: (event: { data: unknown }) => void
      messages: unknown[] = []
      terminated = false
      constructor() { workers.push(this) }
      postMessage(message: unknown) { this.messages.push(message) }
      terminate() { this.terminated = true }
    }
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      navigator: { mediaDevices: { getUserMedia: async () => new MediaStream([track]) } },
      MediaStream,
      MediaStreamTrackProcessor,
      MediaStreamTrackGenerator,
      Worker,
      OffscreenCanvas: class {},
      VideoFrame: class {},
      Blob: class {},
      URL: { createObjectURL: () => "blob:worker" },
      fetch: async () => ({ ok: ++attempts > 2, blob: async () => ({}) }),
      createImageBitmap: async () => ({}),
      DOMException,
      Event,
      Error,
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(hostGestureScript("one", "two"), ctx)
    await (ctx as unknown as { navigator: { mediaDevices: { getUserMedia(c: unknown): Promise<unknown> } } }).navigator.mediaDevices.getUserMedia({ video: true })
    const enable = (ctx as unknown as { __e2eHostGesture: { enable(): Promise<unknown> } }).__e2eHostGesture.enable
    await expect(enable()).resolves.toMatchObject({ active: true, ready: false, sources: 1 })
    expect(track.stop).not.toHaveBeenCalled()
    expect(workers[0].terminated).toBe(false)
    expect(workers[0].messages.at(-1)).toMatchObject({ type: "active", active: false })
    await expect(enable()).resolves.toMatchObject({ active: true, ready: true, sources: 1 })
    expect(attempts).toBe(4)
  })
  it("keeps the native camera live when the optional gesture transform cannot start", async () => {
    const track = { kind: "video", stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720 }) }
    const native = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] }
    const warning = vi.fn()
    class MediaStream {}
    class MediaStreamTrackProcessor { constructor() { throw new Error("processor unavailable") } }
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      navigator: { mediaDevices: { getUserMedia: async () => native } },
      MediaStream,
      MediaStreamTrackProcessor,
      MediaStreamTrackGenerator: class {},
      Worker: class {},
      OffscreenCanvas: class {},
      VideoFrame: class {},
      Blob: class {},
      URL: { createObjectURL: () => "blob:worker" },
      console: { warn: warning },
      Error,
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(hostGestureScript("one", "two"), ctx)
    const stream = await (ctx as unknown as { navigator: { mediaDevices: { getUserMedia(c: unknown): Promise<unknown> } } }).navigator.mediaDevices.getUserMedia({ video: true })
    expect(stream).toBe(native)
    expect(track.stop).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("processor unavailable"))
  })
  it("suppresses video senders until enabled, without exposing media identifiers", async () => {
    const replacements: unknown[] = []
    const added: { track: unknown; streams: unknown[] }[] = []
    const transceived: { kind: string; init: unknown }[] = []
    class RTCPeerConnection {
      addTrack(track: unknown, ...streams: unknown[]) {
        added.push({ track, streams })
        return { replaceTrack: async (next: unknown) => replacements.push(next) }
      }
      addTransceiver(kind: string, init: unknown) {
        transceived.push({ kind, init })
        return { sender: { replaceTrack: async (next: unknown) => replacements.push(next) } }
      }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(outboundVideoScript(), ctx)
    const pc = new RTCPeerConnection()
    const video = { kind: "video", id: "must-not-leak" }
    const firstStream = { id: "first-stream" }
    const rebuiltStream = { id: "rebuilt-stream" }
    pc.addTrack(video, firstStream)
    // A peer-session rebuild while suppression is active must be just as
    // atomic as the first connection: neither native addTrack may see video.
    new RTCPeerConnection().addTrack(video, rebuiltStream)
    const audio = { kind: "audio" }
    pc.addTrack(audio, firstStream)
    await Promise.resolve()
    const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<unknown>; disable(): Promise<unknown>; facts(): unknown } }).__e2eOutboundVideo
    expect(control.facts()).toEqual({ enabled: false, senders: 2 })
    await control.enable()
    await control.disable()
    expect(added).toEqual([{ track: audio, streams: [firstStream] }])
    expect(transceived).toEqual([
      { kind: "video", init: { direction: "sendrecv", streams: [firstStream] } },
      { kind: "video", init: { direction: "sendrecv", streams: [rebuiltStream] } },
    ])
    expect(replacements).toEqual([video, video, null, null])
    expect(JSON.stringify(control.facts())).not.toContain("must-not-leak")
  })
  it.each([
    { label: "early", enableAtTurn: 3, disableAtTurn: 5 },
    { label: "late", enableAtTurn: 8, disableAtTurn: 10 },
  ])("disarms a pending $label enable at its exclusive deadline without fabricating proof", async ({ enableAtTurn, disableAtTurn }) => {
    type Sender = { track: unknown; replaceTrack(next: unknown): Promise<void> }
    const senders: Sender[] = []
    class RTCPeerConnection {
      connectionState = "connected"
      signalingState = "stable"
      addTrack(track: unknown) {
        const sender: Sender = { track, async replaceTrack(next) { this.track = next } }
        senders.push(sender)
        return sender
      }
      addTransceiver() {
        const sender: Sender = { track: null, async replaceTrack(next) { this.track = next } }
        senders.push(sender)
        return { sender }
      }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(outboundVideoScript(), ctx)
    const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<{ enabled: boolean; senders: number }>; disable(): Promise<{ enabled: boolean; senders: number }>; facts(): { enabled: boolean; senders: number } } }).__e2eOutboundVideo
    const state: VideoRoleControlState = { requested: false, enabled: false, disarmed: false, disabled: false }
    const actions: string[] = []
    const step = async (turn: number) => {
      const result = await advanceVideoRoleWindow({
        turn,
        stage: "play",
        window: { enableAtTurn, disableAtTurn },
        state,
        facts: control.facts(),
        setEnabled: (enabled) => enabled ? control.enable() : control.disable(),
      })
      if (result.action) actions.push(`${turn}:${result.action}`)
    }

    await step(enableAtTurn)
    expect(control.facts()).toEqual({ enabled: true, senders: 0 })
    await step(disableAtTurn)
    expect(control.facts()).toEqual({ enabled: false, senders: 0 })
    const late = new RTCPeerConnection().addTrack({ kind: "video" })
    expect(late.track).toBeNull()
    expect(actions).toEqual([])
  })

  it("keeps valid readiness distinct while rejecting a first sender at the deadline", async () => {
    type Sender = { track: unknown; replaceTrack(next: unknown): Promise<void> }
    const setup = (closeDuringDisable = false) => {
      const senders: Sender[] = []
      class RTCPeerConnection {
        connectionState = "connected"
        signalingState = "stable"
        private sender(track: unknown): Sender {
          const sender: Sender = { track, replaceTrack: async (next) => {
            if (closeDuringDisable && next === null) {
              this.close()
              throw new DOMException("closed during replace", "InvalidStateError")
            }
            sender.track = next
          } }
          return sender
        }
        addTrack(track: unknown) {
          const sender = this.sender(track)
          senders.push(sender)
          return sender
        }
        addTransceiver() {
          const sender = this.sender(null)
          senders.push(sender)
          return { sender }
        }
        close() {
          this.connectionState = "closed"
          this.signalingState = "closed"
        }
      }
      const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection })
      ;(ctx as { globalThis: unknown }).globalThis = ctx
      vm.runInContext(outboundVideoScript(), ctx)
      const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<{ enabled: boolean; senders: number }>; disable(): Promise<{ enabled: boolean; senders: number }>; facts(): { enabled: boolean; senders: number } } }).__e2eOutboundVideo
      return { control, RTCPeerConnection }
    }
    const run = async (readyAt: number) => {
      const { control, RTCPeerConnection } = setup()
      const state: VideoRoleControlState = { requested: false, enabled: false, disarmed: false, disabled: false }
      const actions: string[] = []
      let sender: Sender | undefined
      for (const turn of [2, 3, 4, 5]) {
        if (turn === readyAt) sender = new RTCPeerConnection().addTrack({ kind: "video" })
        const result = await advanceVideoRoleWindow({
          turn,
          stage: "play",
          window: { enableAtTurn: 3, disableAtTurn: 5 },
          state,
          facts: control.facts(),
          setEnabled: (enabled) => enabled ? control.enable() : control.disable(),
        })
        if (result.action) actions.push(`${turn}:${result.action}`)
      }
      return { actions, sender, facts: control.facts() }
    }
    expect((await run(2)).actions).toEqual(["3:enabled", "5:disabled"])
    const equality = await run(5)
    expect(equality.actions).toEqual([])
    expect(equality.sender?.track).toBeNull()
    expect(equality.facts.enabled).toBe(false)

    const cold = setup()
    const coldState: VideoRoleControlState = { requested: false, enabled: false, disarmed: false, disabled: false }
    const coldStep = await advanceVideoRoleWindow({
      turn: 6,
      stage: "play",
      window: { enableAtTurn: 3, disableAtTurn: 5 },
      state: coldState,
      facts: cold.control.facts(),
      setEnabled: (enabled) => enabled ? cold.control.enable() : cold.control.disable(),
    })
    expect(coldStep).toMatchObject({ action: null, changed: false })
    expect(new cold.RTCPeerConnection().addTrack({ kind: "video" }).track).toBeNull()
  })

  it.each([
    { label: "before the deadline", closeDuringDisable: false },
    { label: "during deadline replacement", closeDuringDisable: true },
  ])("keeps acknowledged disable proof pending when its owner closes $label", async ({ closeDuringDisable }) => {
    type Sender = { track: unknown; replaceTrack(next: unknown): Promise<void> }
    let closedDuringReplacement = false
    class RTCPeerConnection {
      connectionState = "connected"
      signalingState = "stable"
      private sender(track: unknown): Sender {
        const sender: Sender = { track, replaceTrack: async (next) => {
          if (closeDuringDisable && !closedDuringReplacement && next === null) {
            closedDuringReplacement = true
            this.close()
            throw new DOMException("closed during replace", "InvalidStateError")
          }
          sender.track = next
        } }
        return sender
      }
      addTrack(track: unknown) { return this.sender(track) }
      addTransceiver() { return { sender: this.sender(null) } }
      close() { this.connectionState = "closed"; this.signalingState = "closed" }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(outboundVideoScript(), ctx)
    const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<{ enabled: boolean; senders: number }>; disable(): Promise<{ enabled: boolean; senders: number }>; facts(): { enabled: boolean; senders: number } } }).__e2eOutboundVideo
    const state: VideoRoleControlState = { requested: false, enabled: false, disarmed: false, disabled: false }
    const actions: string[] = []
    const step = async (turn: number) => {
      const result = await advanceVideoRoleWindow({
        turn,
        stage: "play",
        window: { enableAtTurn: 3, disableAtTurn: 5 },
        state,
        facts: control.facts(),
        setEnabled: (enabled) => enabled ? control.enable() : control.disable(),
      })
      if (result.action) actions.push(`${turn}:${result.action}`)
    }
    const owner = new RTCPeerConnection()
    owner.addTrack({ kind: "video" })
    await step(3)
    if (!closeDuringDisable) owner.close()
    await step(5)
    expect(state).toMatchObject({ enabled: true, disarmed: true, disabled: false })
    const rebuilt = new RTCPeerConnection().addTrack({ kind: "video" })
    expect(rebuilt.track).toBeNull()
    await step(6)
    expect(actions).toEqual(["3:enabled", "6:disabled"])
    expect(state.disabled).toBe(true)
    expect(rebuilt.track).toBeNull()
  })
  it("keeps a sender added after an early enable live across the home-to-game navigation race", async () => {
    const replacements: unknown[] = []
    const added: unknown[] = []
    class RTCPeerConnection {
      addTrack(track: unknown) {
        added.push(track)
        return { replaceTrack: async (next: unknown) => replacements.push(next) }
      }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(outboundVideoScript(), ctx)
    const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<unknown>; disable(): Promise<unknown>; facts(): unknown } }).__e2eOutboundVideo
    await control.enable()
    expect(outboundVideoIsLive(control.facts() as never)).toBe(false)
    const video = { kind: "video" }
    new RTCPeerConnection().addTrack(video)
    await Promise.resolve()
    expect(control.facts()).toEqual({ enabled: true, senders: 1 })
    expect(outboundVideoIsLive(control.facts() as never)).toBe(true)
    expect(added).toEqual([video])
    expect(replacements).toEqual([])
    await control.disable()
    expect(replacements).toEqual([null])
  })
  it("retires a closed connection after rebuild so delayed disable only touches the live owner", async () => {
    const replacements: { owner: number; next: unknown }[] = []
    let nextOwner = 0
    class RTCPeerConnection {
      readonly owner = ++nextOwner
      connectionState = "new"
      signalingState = "stable"
      private sender() {
        return {
          replaceTrack: async (next: unknown) => {
            if (this.connectionState === "closed") throw new DOMException("closed", "InvalidStateError")
            replacements.push({ owner: this.owner, next })
          },
        }
      }
      addTrack(...args: unknown[]) { void args; return this.sender() }
      addTransceiver(...args: unknown[]) { void args; return { sender: this.sender() } }
      close() { this.connectionState = "closed"; this.signalingState = "closed" }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection, DOMException })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(outboundVideoScript(), ctx)
    const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<unknown>; disable(): Promise<unknown>; facts(): unknown } }).__e2eOutboundVideo
    const video = { kind: "video" }
    const old = new RTCPeerConnection()
    old.addTrack(video)
    await control.enable()
    old.close()
    const rebuilt = new RTCPeerConnection()
    rebuilt.addTrack(video)
    await expect(control.disable()).resolves.toEqual({ enabled: false, senders: 1 })
    expect(control.facts()).toEqual({ enabled: false, senders: 1 })
    expect(replacements).toEqual([
      { owner: old.owner, next: video },
      { owner: rebuilt.owner, next: null },
    ])
  })
  it("suppresses a close-during-replacement race but surfaces a live-owner failure", async () => {
    let mode: "close" | "fail" = "close"
    class RTCPeerConnection {
      connectionState = "new"
      signalingState = "stable"
      addTrack(...args: unknown[]) { void args; return this.addTransceiver().sender }
      addTransceiver(...args: unknown[]) {
        void args
        return { sender: { replaceTrack: async () => {
          if (mode === "close") {
            this.connectionState = "closed"
            this.signalingState = "closed"
            throw new DOMException("closed during replace", "InvalidStateError")
          }
          throw new Error("live sender failed")
        } } }
      }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection, DOMException })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(outboundVideoScript(), ctx)
    const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<unknown>; facts(): unknown } }).__e2eOutboundVideo
    const closed = new RTCPeerConnection()
    closed.addTrack({ kind: "video" })
    await expect(control.enable()).resolves.toEqual({ enabled: true, senders: 0 })
    expect(outboundVideoIsLive(control.facts() as never)).toBe(false)
    mode = "fail"
    const live = new RTCPeerConnection()
    live.connectionState = "disconnected"
    live.addTrack({ kind: "video" })
    await expect(control.enable()).rejects.toThrow("live sender failed")
  })
  it("does not count a sender whose owner closed before enable", async () => {
    let replacements = 0
    class RTCPeerConnection {
      connectionState = "new"
      signalingState = "stable"
      addTrack(...args: unknown[]) { void args; return this.addTransceiver().sender }
      addTransceiver(...args: unknown[]) { void args; return { sender: { replaceTrack: async () => { replacements++ } } } }
      close() { this.connectionState = "closed"; this.signalingState = "closed" }
    }
    const ctx = vm.createContext({ globalThis: undefined as unknown, RTCPeerConnection })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(outboundVideoScript(), ctx)
    const control = (ctx as unknown as { __e2eOutboundVideo: { enable(): Promise<unknown>; facts(): unknown } }).__e2eOutboundVideo
    const old = new RTCPeerConnection()
    old.addTrack({ kind: "video" })
    old.close()
    await expect(control.enable()).resolves.toEqual({ enabled: true, senders: 0 })
    expect(control.facts()).toEqual({ enabled: true, senders: 0 })
    expect(replacements).toBe(0)
    const rebuilt = new RTCPeerConnection()
    rebuilt.addTrack({ kind: "video" })
    await expect(control.enable()).resolves.toEqual({ enabled: true, senders: 1 })
    expect(replacements).toBe(1)
  })
})

describe("botProfile", () => {
  it("is null for the reserved baseline, the profile otherwise, and throws for a stranger", () => {
    expect(botProfile(undefined)).toBeNull()
    expect(botProfile("baseline")).toBeNull()
    expect(botProfile("slow-pixel7-lte-poor")?.cpuThrottle).toBe(4)
    expect(() => botProfile("nope")).toThrow(/not a known profile/)
  })
  it("baseline gets the plain fake-camera flags", () => {
    expect(chromiumArgsFor(null, { E2E_FAKE_VIDEO_360P: "/x.y4m" })).toEqual(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
  })
})

describe("profileChecks", () => {
  const p = profileFor(2)
  const dev = { userAgent: "UA", viewport: { width: 412, height: 915 } }
  const facts = { userAgent: "UA", innerWidth: 412, innerHeight: 915, touch: true, timeZone: "UTC", language: "en-US", clockSkewMs: 40 }
  it("passes when the page shows what the profile asked for", () => {
    expect(profileChecks(p, dev, facts, 9100).every((c) => c.status === "pass")).toBe(true)
  })
  it("fails each knob that did not take", () => {
    const bad = profileChecks(p, dev, { ...facts, userAgent: "other", innerWidth: 390, clockSkewMs: 9000 }, 100)
    expect(bad.filter((c) => c.status === "fail").map((c) => c.name.split(": ")[1])).toEqual(["device user agent", "viewport", "clock offset", "camera delay"])
  })
})

describe("camera profile probe", () => {
  it("runs terminal camera probes during a game without extending ordinary game boots", () => {
    expect(shouldProbeCamera(profileByName("camera-denied"), "all")).toBe(true)
    expect(shouldProbeCamera(profileByName("camera-missing"), "all")).toBe(true)
    expect(shouldProbeCamera(profileByName("slow-pixel7-lte-poor"), "all")).toBe(false)
    expect(shouldProbeCamera(profileByName("slow-pixel7-lte-poor"), "boot")).toBe(true)
  })
})

describe("the visible game time", () => {
  const gameAt = Date.UTC(2026, 6, 15, 2, 30) / 1000
  it("compares the chain gameAt in Los Angeles in 12-hour time with no leading zero", () => {
    expect(displayedGameTimeCheck(profileByName("locale-la-enus"), gameAt, "Next game Game starts at 7:30 PM").status).toBe("pass")
    expect(displayedGameTimeCheck(profileByName("locale-la-enus"), gameAt, "Game starts at 7:32 PM").status).toBe("fail")
    expect(displayedGameTimeCheck(profileByName("locale-la-enus"), gameAt, "Game starts at Jul 14 at 7:30 PM").status).toBe("pass")
    const earlyAfternoon = Date.UTC(2026, 6, 15, 20, 30) / 1000
    expect(displayedGameTimeCheck(profileByName("locale-la-enus"), earlyAfternoon, "Game starts at 11:30 PM").status).toBe("fail")
    expect(displayedGameTimeCheck(profileByName("locale-la-enus"), earlyAfternoon, "Game starts at 1:30 PM").status).toBe("pass")
  })
  it("formats Tokyo and Berlin in their own 24-hour local time", () => {
    expect(displayedGameTimeCheck(profileByName("locale-tokyo-jajp"), gameAt, "Game starts at 11:30").status).toBe("pass")
    expect(displayedGameTimeCheck(profileByName("locale-berlin-dede"), gameAt, "Game starts at 04:30").status).toBe("pass")
    expect(displayedGameTimeCheck(profileByName("locale-berlin-dede"), gameAt, "Game starts at 4:30").status).toBe("fail")
  })
})

describe("device scenario scripts", () => {
  it("mutes fresh tracks until the recovery click explicitly arms one activation bypass, with an override proving still-muted", async () => {
    const activation = { isActive: false }
    const timers: Array<() => void> = []
    class Track extends EventTarget {
      kind = "video"
    }
    const tracks: Track[] = []
    const md = {
      getUserMedia: async (constraints?: MediaStreamConstraints) => {
        void constraints
        const track = new Track()
        tracks.push(track)
        return { getVideoTracks: () => [track] }
      },
    }
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      navigator: { mediaDevices: md, userActivation: activation },
      setTimeout: (callback: () => void) => (timers.push(callback), timers.length),
      Event,
      Promise,
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(cameraMuteLoopScript(), ctx)
    const control = (ctx as unknown as { __e2eCameraMuteLoop: { armActivationBypass(): void; setIgnoreActivation(value: boolean): void; facts(): { opened: number; muted: number; activationBypasses: number } } }).__e2eCameraMuteLoop

    const first = await md.getUserMedia({ video: true })
    let firstMutes = 0
    first.getVideoTracks()[0].addEventListener("mute", () => firstMutes++)
    timers.shift()?.()
    expect(firstMutes).toBe(1)

    activation.isActive = true
    const permissionTap = await md.getUserMedia({ video: true })
    let permissionMutes = 0
    permissionTap.getVideoTracks()[0].addEventListener("mute", () => permissionMutes++)
    timers.shift()?.()
    expect(permissionMutes).toBe(1)

    control.armActivationBypass()
    const tapped = await md.getUserMedia({ video: true })
    let tappedMutes = 0
    tapped.getVideoTracks()[0].addEventListener("mute", () => tappedMutes++)
    expect(timers).toHaveLength(0)

    control.setIgnoreActivation(true)
    const ignored = await md.getUserMedia({ video: true })
    let ignoredMutes = 0
    ignored.getVideoTracks()[0].addEventListener("mute", () => ignoredMutes++)
    timers.shift()?.()
    expect(ignoredMutes).toBe(1)
    expect(control.facts()).toMatchObject({ opened: 4, muted: 3, activationBypasses: 1 })
  })

  it("reads track.muted as true while the persona holds a track muted, keeps it true when the same track comes back on a reuse, and releases it on a bypassed open", async () => {
    const activation = { isActive: false }
    const timers: Array<() => void> = []
    class Track extends EventTarget {
      kind = "video"
      muted = false
      readyState = "live"
    }
    const track = new Track()
    // the app's own open hands back this same track object on every call
    const md = { getUserMedia: async (constraints?: MediaStreamConstraints) => (void constraints, { getVideoTracks: () => [track] }) }
    const ctx = vm.createContext({
      globalThis: undefined as unknown,
      navigator: { mediaDevices: md, userActivation: activation },
      setTimeout: (callback: () => void) => (timers.push(callback), timers.length),
      Event,
      Promise,
      Object,
    })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(cameraMuteLoopScript(), ctx)
    const control = (ctx as unknown as { __e2eCameraMuteLoop: { armActivationBypass(): void; facts(): { opened: number; muted: number; activationBypasses: number } } }).__e2eCameraMuteLoop

    // after a mute, track.muted reads true (the app's goLive/watchTrack branch on it)
    await md.getUserMedia({ video: true })
    timers.shift()?.()
    expect(track.muted).toBe(true)

    // the stream is reused: the same track object comes back and must still read muted
    await md.getUserMedia({ video: true })
    timers.shift()?.()
    expect(track.muted).toBe(true)

    // the tap path opens with live activation: that track is the live camera again
    activation.isActive = true
    control.armActivationBypass()
    await md.getUserMedia({ video: true })
    expect(track.muted).toBe(false)
    expect(control.facts()).toMatchObject({ opened: 3, muted: 2, activationBypasses: 1 })
  })

  it("installs the mute-loop hook only for its acceptance persona", () => {
    expect(initScriptsFor(profileByName("camera-mute-loop")).join("\n")).toContain("__e2eCameraMuteLoop")
    expect(initScriptsFor(profileByName("camera-denied")).join("\n")).not.toContain("__e2eCameraMuteLoop")
  })

  it("a denied or missing camera rejects video getUserMedia with the real DOMException name, audio passes", async () => {
    class DOMException extends Error {
      constructor(m: string, readonly n: string) { super(m); this.name = n }
    }
    for (const [mode, name] of [["denied", "NotAllowedError"], ["missing", "NotFoundError"]] as const) {
      const md = { getUserMedia: async (...args: unknown[]) => (void args, "real") }
      vm.runInContext(cameraBlockScript(mode), vm.createContext({ navigator: { mediaDevices: md }, DOMException, Promise }))
      await expect(md.getUserMedia({ video: true })).rejects.toMatchObject({ name })
      await expect(md.getUserMedia({ audio: true })).resolves.toBe("real")
    }
  })
  it("the clock offset can be rewritten mid-game", () => {
    const ctx = vm.createContext({ globalThis: undefined as unknown })
    ;(ctx as { globalThis: unknown }).globalThis = ctx
    vm.runInContext(`${clockScript(-75)}; var a = Date.now(); globalThis.__e2eClockOffMs = 30000; var b = Date.now()`, ctx)
    const c = ctx as unknown as { a: number; b: number }
    expect(c.b - c.a).toBeGreaterThan(104_000)
    expect(c.b - c.a).toBeLessThan(106_000)
  })
  it("zone and locale go into the context options", () => {
    const o = contextOptionsFor(profileByName("locale-tokyo-jajp"))
    expect(o).toMatchObject({ locale: "ja-JP", timezoneId: "Asia/Tokyo" })
    expect(contextOptionsFor(profileByName("camera-denied")).permissions).toEqual([])
  })
  it("a clock-jump profile installs the clock script even from offset 0", () => {
    expect(initScriptsFor(profileByName("clock-wrong-then-corrected")).some((s) => s.includes("__e2eClockOffMs"))).toBe(true)
  })
})

describe("the freeze's page side", () => {
  it("installs the freeze script for a freeze role, and the clock script for a hidden step", () => {
    expect(initScriptsFor(profileByName("visible-freeze")).some((x) => x.includes("__e2eMaxGapMs"))).toBe(true)
    expect(initScriptsFor(profileByName("clock-step-while-hidden")).some((x) => x.includes("__e2eClockOffMs"))).toBe(true)
    expect(initScriptsFor(profileByName("reload-mid-game")).some((x) => x.includes("__e2eMaxGapMs") || x.includes("__e2eClockOffMs"))).toBe(false)
  })
  it("holds performance.now() back by the offset, never moving it backwards at the hold", () => {
    let t = 1000
    const ctx = vm.createContext({ globalThis: undefined as unknown, performance: { now: () => t }, setInterval: () => 0 })
    ctx.globalThis = ctx
    vm.runInContext(freezeScript(), ctx)
    const read = () => vm.runInContext("performance.now()", ctx) as number
    expect(read()).toBe(1000)
    t = 21_000 // 20 s frozen
    vm.runInContext("globalThis.__e2ePerfOffMs += 20000", ctx)
    expect(read()).toBe(1000)
    t = 22_000
    expect(read()).toBe(2000)
  })
  it("accepts T2 progress only while its storage fault is active", () => {
    expect(progressDuringActiveFault(100, 100, 200)).toBe(true)
    expect(progressDuringActiveFault(199, 100, 200)).toBe(true)
    expect(progressDuringActiveFault(200, 100, 200)).toBe(false)
    expect(progressDuringActiveFault(null, 100, 200)).toBe(false)
  })
  describe("T6 kill", () => {
    // Shapes captured from Chromium (a pagehide keepalive fetch and a
    // sendBeacon, both seen ONLY by a browser-level Fetch.enable: page.route
    // and context.route never saw them). The frameId of unload traffic is the
    // dying page's targetId.
    const PAGE = "AAF8EBDB8D9744D32E8974415D8FFEA5"
    const IFRAME = "6B1F0C2E9A1D4C7F8E3B2A1908D7C6B5"
    const OTHER_SLOT = "0D9C8B7A6F5E4D3C2B1A09F8E7D6C5B4"
    const OLD_SESSION = "3f2a9c1e-7b4d-4e8a-9c6f-1d2e3f4a5b6c"
    const FRESH_SESSION = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
    const SENTRY = "https://o4508.ingest.de.sentry.io/api/4508123456789/envelope/?sentry_version=7&sentry_key=0123abcd"
    const envelope = (session: string) =>
      `{"event_id":"c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6","sent_at":"2026-10-14T16:00:00.000Z","sdk":{"name":"sentry.javascript.nextjs"}}\n{"type":"transaction"}\n{"type":"transaction","transaction":"game.report","tags":{"product":"dim2","session.id":"${session}","host.kind":"desktop"}}`
    const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

    interface Fake {
      calls: string[]
      escaped: string[]
      crashed: Promise<{ pausedMs: number; killedAt: number; leaks: { at: number; url: string; by: string }[] }>
      emit(event: string, payload: unknown): void
      released: Map<string, "fail" | "continue">
    }

    /** A paused page whose pagehide flush fires the moment its target
     * session detaches while the renderer is still alive (the M4 hole). */
    function fakeKill(destroyAfterMs: number | null, onClose?: (fake: Fake) => void): Fake {
      const calls: string[] = []
      const escaped: string[] = []
      const released = new Map<string, "fail" | "continue">()
      const listeners = new Map<string, Set<(payload: never) => void>>()
      let rendererGone = false
      let fetchEnabled = false
      let paused = () => {}
      const fake = { calls, escaped, released } as Fake
      fake.emit = (event, payload) => { for (const listener of [...(listeners.get(event) ?? [])]) listener(payload as never) }
      const target = {
        once(event: string, callback: () => void) { expect(event).toBe("Debugger.paused"); paused = callback },
        async send(command: string, params?: unknown) {
          calls.push(`target.${command}${params === undefined ? "" : `:${JSON.stringify(params)}`}`)
          if (command === "Target.getTargetInfo") return { targetInfo: { targetId: PAGE, type: "page" } }
          if (command === "Page.getFrameTree") return { frameTree: { frame: { id: PAGE }, childFrames: [{ frame: { id: IFRAME } }] } }
          if (command === "Debugger.pause") paused()
          return {}
        },
        async detach() {
          calls.push("target.detach")
          if (rendererGone) return
          // pause released, emulation dropped: pagehide's keepalive leaves
          if (fetchEnabled) fake.emit("Fetch.requestPaused", { requestId: "unload-1", frameId: PAGE, resourceType: "Ping", request: { url: SENTRY, method: "POST", postData: envelope(OLD_SESSION) } })
          else escaped.push(SENTRY)
        },
      }
      const control = {
        on(event: string, listener: (payload: never) => void) { listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)) },
        off(event: string, listener: (payload: never) => void) { listeners.get(event)?.delete(listener) },
        async send(command: string, params?: { requestId?: string }) {
          calls.push(`browser.${command}${command.startsWith("Fetch.") && command !== "Fetch.enable" ? "" : `:${JSON.stringify(params)}`}`)
          if (command === "Fetch.enable") fetchEnabled = true
          if (command === "Fetch.disable") fetchEnabled = false
          if (command === "Fetch.failRequest") released.set(params!.requestId!, "fail")
          if (command === "Fetch.continueRequest") released.set(params!.requestId!, "continue")
          if (command === "Target.closeTarget") {
            onClose?.(fake)
            if (destroyAfterMs !== null) setTimeout(() => {
              rendererGone = true
              calls.push("event.Target.targetDestroyed")
              fake.emit("Target.targetDestroyed", { targetId: PAGE })
            }, destroyAfterMs)
          }
          return command === "Target.closeTarget" ? { success: true } : {}
        },
        async detach() { calls.push("browser.detach") },
      }
      const context = { async newCDPSession() { return target }, browser: () => ({ async newBrowserCDPSession() { return control } }) }
      fake.crashed = freezePageUntilCrash({ context: () => context } as never, 30_000, OLD_SESSION)
      return fake
    }

    it("holds the pause and the offline seal until targetDestroyed, however late it comes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        vi.setSystemTime(1_000)
        const fake = fakeKill(5_000)
        await vi.advanceTimersByTimeAsync(30_000)
        await vi.advanceTimersByTimeAsync(4_999)
        // the close was acknowledged at once; destruction is still pending
        expect(fake.calls).toContain(`browser.Target.closeTarget:{"targetId":"${PAGE}"}`)
        expect(fake.calls).not.toContain("target.detach")
        await vi.advanceTimersByTimeAsync(1)
        expect(fake.calls).toContain("target.detach")
        expect(fake.calls).not.toContain("browser.Fetch.disable")
        await vi.advanceTimersByTimeAsync(T6_LEAK_GRACE_MS)
        await expect(fake.crashed).resolves.toEqual({ pausedMs: 30_000, killedAt: 31_000, leaks: [] })
        expect(fake.calls).toEqual([
          "target.Debugger.enable",
          "target.Network.enable",
          "target.Target.getTargetInfo",
          "target.Page.getFrameTree",
          'browser.Target.setDiscoverTargets:{"discover":true}',
          "target.Debugger.pause",
          'target.Network.emulateNetworkConditions:{"offline":true,"latency":0,"downloadThroughput":0,"uploadThroughput":0}',
          'browser.Fetch.enable:{"patterns":[{"urlPattern":"*sentry*"},{"urlPattern":"*/api/*/envelope/*"}]}',
          `browser.Target.closeTarget:{"targetId":"${PAGE}"}`,
          "event.Target.targetDestroyed",
          "target.detach",
          "browser.Fetch.disable",
          "browser.detach",
        ])
        expect(fake.calls).not.toContain("target.Debugger.resume")
        expect(fake.escaped).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it("refuses to detach the target when destruction is never proven", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        const fake = fakeKill(null)
        const outcome = fake.crashed.catch((error: Error) => error.message)
        await vi.advanceTimersByTimeAsync(30_000 + 15_000)
        await expect(outcome).resolves.toBe("paused page renderer was not destroyed within 15 s")
        expect(fake.calls).not.toContain("target.detach")
        expect(fake.calls).not.toContain("target.Debugger.resume")
        expect(fake.calls.slice(-2)).toEqual(["browser.Fetch.disable", "browser.detach"])
        expect(fake.escaped).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it("fails and reports every old-document request the collector sees, by frame or by session", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        vi.setSystemTime(1_000)
        const fake = fakeKill(1_000, (f) => setTimeout(() => {
          // a sendBeacon from the page frame, base64 entries only
          f.emit("Fetch.requestPaused", { requestId: "beacon", frameId: PAGE, resourceType: "Ping", request: { url: SENTRY, method: "POST", postDataEntries: [{ bytes: b64(envelope(OLD_SESSION)) }] } })
          // a large envelope from a child frame: hasPostData but no body sent
          f.emit("Fetch.requestPaused", { requestId: "large", frameId: IFRAME, resourceType: "Fetch", request: { url: SENTRY, method: "POST", hasPostData: true } })
          // another slot's live document on the shared browser
          f.emit("Fetch.requestPaused", { requestId: "other", frameId: OTHER_SLOT, resourceType: "Fetch", request: { url: SENTRY, method: "POST", postData: envelope(FRESH_SESSION) } })
          // no frame, but the killed session's UUID in the body
          f.emit("Fetch.requestPaused", { requestId: "frameless", resourceType: "Other", request: { url: SENTRY, method: "POST", postData: envelope(OLD_SESSION) } })
        }, 100))
        await vi.advanceTimersByTimeAsync(30_000 + 1_000 + T6_LEAK_GRACE_MS)
        const { leaks, killedAt } = await fake.crashed
        expect(leaks).toEqual([
          { at: killedAt + 100, url: SENTRY, by: "frame" },
          { at: killedAt + 100, url: SENTRY, by: "frame" },
          { at: killedAt + 100, url: SENTRY, by: "session" },
        ])
        expect(Object.fromEntries(fake.released)).toEqual({ beacon: "fail", large: "fail", other: "continue", frameless: "fail" })
      } finally {
        vi.useRealTimers()
      }
    })

    it("catches the M4 hole itself: an unload flush released by detaching a live target", async () => {
      // Model the old bug inside the new shape: destruction is reported, yet
      // the renderer still runs pagehide when its session detaches. The
      // collector is still open then and must report it.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      try {
        const fake = fakeKill(1_000)
        await vi.advanceTimersByTimeAsync(30_000 + 999)
        // forge an early destroyed event while the renderer is alive
        fake.emit("Target.targetDestroyed", { targetId: PAGE })
        await vi.advanceTimersByTimeAsync(1 + T6_LEAK_GRACE_MS)
        const { leaks } = await fake.crashed
        expect(leaks.map((leak) => leak.by)).toEqual(["frame"])
        expect(fake.released.get("unload-1")).toBe("fail")
        expect(fake.escaped).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it("attributes only Sentry traffic, from the old frames or carrying the old session", () => {
      const frames = new Set([PAGE, IFRAME])
      const event = (frameId: string | undefined, url: string, body?: string) => ({ requestId: "r", ...(frameId ? { frameId } : {}), request: { url, ...(body ? { postData: body } : {}) } })
      expect(killedDocumentLeak(event(PAGE, SENTRY), frames, OLD_SESSION)).toBe("frame")
      expect(killedDocumentLeak(event(OTHER_SLOT, SENTRY, envelope(OLD_SESSION)), frames, OLD_SESSION)).toBe("session")
      expect(killedDocumentLeak(event(OTHER_SLOT, SENTRY, envelope(FRESH_SESSION)), frames, OLD_SESSION)).toBeNull()
      expect(killedDocumentLeak(event(PAGE, "http://localhost:3001/_next/static/chunks/app.js"), frames, OLD_SESSION)).toBeNull()
      expect(killedDocumentLeak(event(undefined, "http://localhost:8080/api/42/envelope/", envelope(OLD_SESSION)), frames, OLD_SESSION)).toBe("session")
    })
  })
})
