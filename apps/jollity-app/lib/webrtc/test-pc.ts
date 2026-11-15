// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A fake RTCPeerConnection for driving the Mesh in unit tests. The Mesh
 * captures the constructor when its module loads, so a test stubs the global
 * first and imports the mesh after: `setupMesh` does both. Not shipped: only
 * the *.test.ts files import it.
 */
import { vi, type Mock } from "vitest"
import { chromeStats } from "./test-stats"
import type { Mesh } from "./mesh"
import { armDeadlines, type PeerActorCommand, type PeerActorEvent, type PeerActorState } from "../state-machines/peer-actor"

/** `vi.fn(impl)`, except under the explorer's controller, where it is the
 *  plain function: vitest's mock registry never lets a vi.fn go, so every
 *  spy made in an exploration would keep its schedule's whole Mesh alive
 *  (1.5 GB after 7k schedules, measured in T0). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spy<T extends (...args: any[]) => any>(impl?: T): Mock<T> {
  if (FakePC.controller) return (impl ?? (() => {})) as unknown as Mock<T>
  return impl ? vi.fn(impl) : (vi.fn() as unknown as Mock<T>)
}

export class FakeChannel {
  readyState = "connecting"
  binaryType = ""
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: unknown = null
  /** under the controller: the paired lane (T1); a spy either way */
  send = spy((data: unknown) => FakePC.controller?.send?.(this, data))
  close = spy(() => FakePC.controller?.closeChannel?.(this))
}

export class FakeVideoTrack {
  kind = "video"
  constructor(
    readonly id: string,
    private width = 720,
    private height = 1280,
  ) {}
  getSettings = () => ({ width: this.width, height: this.height })
}

export class FakeSender {
  parameters: RTCRtpSendParameters = { encodings: [{}] } as RTCRtpSendParameters
  /** Reject the first write containing each named field, then permit fallback. */
  rejectOnce = new Set<"maxFramerate" | "scaleResolutionDownBy" | "maxBitrate">()
  emptyBeforeStable = false
  writes: RTCRtpSendParameters[] = []
  replacements: Array<MediaStreamTrack | null> = []

  constructor(
    readonly id: string,
    public track: MediaStreamTrack | null,
    private readonly pc: FakePC,
  ) {}

  getParameters = (): RTCRtpSendParameters => {
    if (this.emptyBeforeStable && this.pc.signalingState !== "stable") return { encodings: [] } as unknown as RTCRtpSendParameters
    return structuredClone(this.parameters)
  }

  setParameters = spy(async (parameters: RTCRtpSendParameters) => {
    const encoding = parameters.encodings?.[0]
    for (const field of this.rejectOnce) {
      if (encoding?.[field] !== undefined) {
        this.rejectOnce.delete(field)
        throw new DOMException(`${field} unsupported`, "InvalidModificationError")
      }
    }
    this.parameters = structuredClone(parameters)
    this.writes.push(structuredClone(parameters))
  })

  replaceTrack = spy(async (track: MediaStreamTrack | null) => {
    this.track = track
    this.replacements.push(track)
  })
}

/** The state-machine explorer's hold on a FakePC (lib/explorer, design 2.2).
 *  With `FakePC.controller` set, every description and candidate op waits in
 *  the controller's queue until the explorer resolves it (`apply` changes the
 *  state, and throws for a rejection), a description's SDP carries the
 *  explorer's identity lines, a set local description starts gathering, and
 *  `close` closes. The optional hooks (T1) are called only when a controller
 *  is set and has them; with none, FakePC is as every Mesh test knows it. */
export interface FakePCController {
  enqueue(pc: FakePC, op: "srd" | "sld" | "cand" | "rollback", apply: () => void): Promise<void>
  sdpFor(pc: FakePC, type: "offer" | "answer"): string
  onClose(pc: FakePC): void
  /** a new ufrag, and negotiation needed */
  restartIce?(pc: FakePC): void
  /** pairing, and negotiation needed on a first channel */
  createDataChannel?(pc: FakePC, channel: FakeChannel): void
  /** negotiation needed */
  addTrack?(pc: FakePC): void
  /** a controller-owned deferred */
  getStats?(pc: FakePC): Promise<unknown>
  /** onto the far end's lane FIFO; throws InvalidStateError when not open */
  send?(channel: FakeChannel, data: unknown): void
  /** closes both ends */
  closeChannel?(channel: FakeChannel): void
}

export class FakePC {
  static last: FakePC[] = []
  /** The explorer's controller (above); null, the default, is FakePC as every
   *  Mesh test knows it. */
  static controller: FakePCController | null = null
  /** Opt in to Chrome's operations chain: each setRemoteDescription and
   *  setLocalDescription runs after the one before it settles, and changes
   *  the connection's state only then (a description being set is not the
   *  remote description yet). Off by default; a test that sets it resets it. */
  static operationsChain = false
  private operations: Promise<unknown> = Promise.resolve()
  private chained<T>(operation: () => T): Promise<T> {
    const run = this.operations.then(operation)
    this.operations = run.catch(() => {})
    return run
  }
  connectionState: RTCPeerConnectionState = "new"
  iceConnectionState: RTCIceConnectionState = "new"
  iceGatheringState: RTCIceGatheringState = "complete"
  signalingState: RTCSignalingState = "stable"
  localDescription: { type: string; sdp: string } | null = null
  remoteDescription: { type: string; sdp?: string } | null = null
  onnegotiationneeded: (() => Promise<void>) | null = null
  oniceconnectionstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null
  onicecandidateerror: ((event: unknown) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  ondatachannel: unknown = null
  ontrack: ((event: { track: { kind: string; addEventListener: (name: string, listener: () => void) => void }; streams: MediaStream[]; receiver?: RTCRtpReceiver }) => void) | null = null
  channels: FakeChannel[] = []
  channelCreations: Array<{ label: string; options?: RTCDataChannelInit }> = []
  senders: FakeSender[] = []
  private listeners = new Map<string, Array<(event?: unknown) => void>>()
  restartIce = spy(() => FakePC.controller?.restartIce?.(this))
  stats = chromeStats({ t: 1000, decoded: 0, lost: 0, received: 0, bytesSent: 0, freezes: 0, cpu: 0 })
  /** the RTCConfiguration it was made with, and any set on it since */
  config: RTCConfiguration | undefined
  setConfiguration = spy((config: RTCConfiguration) => {
    this.config = config
  })
  constructor(config?: RTCConfiguration) {
    this.config = config
    FakePC.last.push(this)
  }
  createDataChannel(label: string, options?: RTCDataChannelInit) {
    this.channelCreations.push({ label, ...(options ? { options } : {}) })
    const channel = new FakeChannel()
    this.channels.push(channel)
    FakePC.controller?.createDataChannel?.(this, channel)
    return channel
  }
  /** A newly-created in-band channel only needs negotiation while the SCTP
   *  application section does not exist yet. Browsers do not fire
   *  negotiationneeded for another channel after an offer/answer established
   *  that section. */
  async fireDataChannelNegotiationNeeded(): Promise<boolean> {
    const hasApplicationSection = [this.localDescription?.sdp, this.remoteDescription?.sdp]
      .some((body) => mlines(body).includes("application"))
    if (hasApplicationSection || !this.onnegotiationneeded) return false
    await this.onnegotiationneeded()
    return true
  }
  async setLocalDescription(desc?: { type: string; sdp?: string }) {
    const controller = FakePC.controller
    if (controller) return controller.enqueue(this, desc?.type === "rollback" ? "rollback" : "sld", () => this.applyLocal(desc))
    if (FakePC.operationsChain) return this.chained(() => this.applyLocal(desc))
    this.applyLocal(desc)
  }
  private applyLocal(desc?: { type: string; sdp?: string }) {
    if (desc?.type === "rollback") {
      this.localDescription = null
      this.signalingState = "stable"
      return
    }
    const answering = this.signalingState === "have-remote-offer"
    const type = answering ? "answer" : "offer"
    const controller = FakePC.controller
    this.localDescription = desc
      ? { type: desc.type, sdp: desc.sdp ?? "" }
      : { type, sdp: controller ? controller.sdpFor(this, type) : "v=0" }
    this.signalingState = answering ? "stable" : "have-local-offer"
    if (controller) this.iceGatheringState = "gathering"
  }
  async setRemoteDescription(desc: { type: string; sdp?: string }) {
    const controller = FakePC.controller
    if (controller) return controller.enqueue(this, "srd", () => this.applyRemote(desc))
    if (FakePC.operationsChain) return this.chained(() => this.applyRemote(desc))
    this.applyRemote(desc)
  }
  private applyRemote(desc: { type: string; sdp?: string }) {
    // libwebrtc's rule: a later offer keeps every m-section the connection has
    // negotiated, in the same order (it may only add). A restarted peer's first
    // offer carries the data channel alone, so on a connection that has added
    // media it fails exactly as it does in Chrome.
    const held = mlines(this.remoteDescription?.sdp)
    const next = mlines(desc.sdp)
    if (desc.type === "offer" && (next.length < held.length || held.some((kind, i) => next[i] !== kind)))
      throw new DOMException(
        "Failed to set remote offer sdp: The order of m-lines in subsequent offer doesn't match order from previous offer/answer.",
        "InvalidAccessError",
      )
    this.remoteDescription = desc
    this.signalingState = desc.type === "offer" ? "have-remote-offer" : "stable"
  }
  /** as in Chrome, an added candidate shows in the remote description's SDP */
  addIceCandidate = spy(async (candidate?: { candidate?: string } | null) => {
    const controller = FakePC.controller
    if (controller) return controller.enqueue(this, "cand", () => this.applyCandidate(candidate))
    this.applyCandidate(candidate)
  })
  private applyCandidate(candidate?: { candidate?: string } | null) {
    if (!this.remoteDescription) throw new DOMException("The remote description was null", "InvalidStateError")
    if (candidate?.candidate) this.remoteDescription = { ...this.remoteDescription, sdp: `${this.remoteDescription.sdp ?? ""}a=${candidate.candidate}\r\n` }
  }
  addTrack = (track: MediaStreamTrack) => {
    const sender = new FakeSender(`sender-${this.senders.length}`, track, this)
    this.senders.push(sender)
    FakePC.controller?.addTrack?.(this)
    return sender as unknown as RTCRtpSender
  }
  getSenders = () => this.senders as unknown as RTCRtpSender[]
  getReceivers = () => []
  getTransceivers = () => this.senders.map((sender) => ({ sender, setCodecPreferences: spy() })) as unknown as RTCRtpTransceiver[]
  addEventListener(name: string, listener: (event?: unknown) => void) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }
  removeEventListener(name: string, listener: (event?: unknown) => void) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((candidate) => candidate !== listener))
  }
  dispatch(name: string, event?: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(event)
  }
  /** a gathered candidate (null = the end of them), handed out as a browser
   *  does: to `onicecandidate` and to every `icecandidate` listener */
  emitCandidate(candidate: unknown) {
    const event = { candidate }
    this.onicecandidate?.(event)
    this.dispatch("icecandidate", event)
  }
  getStats = async () => {
    const controller = FakePC.controller
    if (controller?.getStats) return (await controller.getStats(this)) as RTCStatsReport
    return this.stats as unknown as RTCStatsReport
  }
  /** a spy; under the explorer's controller it also closes the connection,
   *  whose queued ops the controller then rejects */
  close = spy(() => {
    const controller = FakePC.controller
    if (!controller) return
    this.signalingState = "closed"
    this.connectionState = "closed"
    this.iceConnectionState = "closed"
    controller.onClose(this)
  })
}

/** the media kinds of an SDP's m-sections, in order */
function mlines(sdp: string | undefined): string[] {
  return (sdp ?? "").split(/\r?\n/).filter((line) => line.startsWith("m=")).map((line) => line.slice(2).split(" ")[0])
}

/** An SDP as one RTCPeerConnection writes it: `session` is its o= session id
 *  (the same for the connection's whole life), `ufrag` changes on an ICE
 *  restart, and `media` lists the m-sections after the data channel's. */
export function sdp(session: string, { ufrag = "u1", media = [] as string[] } = {}): string {
  return [
    "v=0",
    `o=- ${session} 2 IN IP4 127.0.0.1`,
    "s=-",
    "t=0 0",
    `a=ice-ufrag:${ufrag}`,
    `a=fingerprint:sha-256 ${session.padStart(2, "0").slice(0, 2)}:00`,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    ...media.map((kind) => `m=${kind} 9 UDP/TLS/RTP/SAVPF 96`),
    "",
  ].join("\r\n")
}

/** a Mesh for `myId` with one peer added, driven by the peer actor as every
 *  Mesh is; `opts` are the Mesh's observers, `local` its camera */
export async function setupMesh(
  myId: string,
  peerId: string,
  opts: ConstructorParameters<typeof Mesh>[7] = {},
  local: unknown = { getVideoTracks: () => [], getTracks: () => [] },
  onStream: (peerId: string, stream: MediaStream) => void = () => {},
) {
  vi.resetModules()
  FakePC.last = []
  vi.stubGlobal("RTCPeerConnection", FakePC)
  const { Mesh: MeshClass } = await import("./mesh")
  const signals: unknown[] = []
  const mesh = new MeshClass(
    myId,
    local as MediaStream,
    {},
    (_to, data) => signals.push(data),
    onStream,
    () => {},
    () => {},
    { ...opts },
  )
  mesh.addPeer(peerId)
  return { mesh, pc: FakePC.last[0], signals }
}

/** Every event a Mesh's peer actors step on from now (each fact Mesh
 *  dispatches and each command's completion), with its peer, in order. It
 *  spies the runner's reduce, where both arrive. */
export function actorEvents(mesh: object): { peer: string; event: PeerActorEvent }[] {
  const runner = (mesh as { runner: { reduce(peer: string, event: PeerActorEvent, run?: number): void } | null }).runner
  if (!runner) throw new Error("actorEvents: the Mesh has no peer actor runner")
  const events: { peer: string; event: PeerActorEvent }[] = []
  const reduce = runner.reduce.bind(runner)
  vi.spyOn(runner, "reduce").mockImplementation((peer, event, run) => {
    events.push({ peer, event })
    return reduce(peer, event, run)
  })
  return events
}

/** The commands a Mesh's peer actors issue from now, with their peer, in
 *  order. A command whose kind is in `hold` is recorded and not run (for a
 *  test whose fake connection cannot be rebuilt, say). */
export function actorCommands(mesh: object, hold: readonly PeerActorCommand["kind"][] = []): { peer: string; command: PeerActorCommand }[] {
  const internals = mesh as { executePeerCommand(peer: string, command: PeerActorCommand): unknown }
  const commands: { peer: string; command: PeerActorCommand }[] = []
  const execute = internals.executePeerCommand.bind(internals)
  vi.spyOn(internals, "executePeerCommand").mockImplementation((peer, command) => {
    commands.push({ peer, command })
    return hold.includes(command.kind) ? undefined : execute(peer, command)
  })
  return commands
}

/** Let tests that back-date recovery clocks write the actor-owned times.
 *  The four connection times deleted from Mesh are accessors, not copies;
 *  retained Mesh clocks are projected only by this test adapter before a
 *  hand-driven sweep. */
export function actorTakesMeshTimes(mesh: object): void {
  const internals = mesh as unknown as {
    conns: Map<string, Record<string, unknown>>
    runner: { state(peer: string): PeerActorState | undefined }
    supervise: () => void
  }
  const supervise = internals.supervise.bind(mesh)
  const nullable = (at: unknown) => (typeof at === "number" && Number.isFinite(at) ? at : null)
  const actorOwned = ["disconnectedAt", "lastRecvDescAt", "offerSentAt", "yieldedAt"] as const
  const actorTime = (field: (typeof actorOwned)[number], at: unknown) =>
    field === "disconnectedAt" && at === 0 ? null : nullable(at)
  const bindActorOwnedTimes = (peer: string, conn: Record<string, unknown>) => {
    const state = internals.runner.state(peer)
    if (!state) return
    for (const field of actorOwned) {
      const descriptor = Object.getOwnPropertyDescriptor(conn, field)
      if (descriptor?.get) continue
      if (descriptor && "value" in descriptor) state[field] = actorTime(field, descriptor.value)
      Object.defineProperty(conn, field, {
        configurable: true,
        get: () => internals.runner.state(peer)?.[field] ?? null,
        set: (value: unknown) => {
          const current = internals.runner.state(peer)
          if (current) current[field] = actorTime(field, value)
        },
      })
    }
  }
  for (const [peer, conn] of internals.conns) bindActorOwnedTimes(peer, conn)
  internals.supervise = () => {
    for (const [peer, conn] of internals.conns) {
      bindActorOwnedTimes(peer, conn)
      const state = internals.runner.state(peer)
      if (!state) continue
      state.lastSignalAt = nullable(conn.lastSignalAt)
      state.upAt = conn.upAt === 0 ? null : nullable(conn.upAt)
      state.downAt = conn.downAt === 0 ? null : nullable(conn.downAt)
      state.everConnected = Boolean(conn.everConnected)
      state.firstHeardAt = nullable(conn.firstHeardAt)
      state.deadlines = armDeadlines(state)
    }
    supervise()
  }
}
