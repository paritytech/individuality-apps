// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The explorer's controlled peer connection (the subset the slice-1 labels need).
 *
 * A `Controller` installed as `FakePC.controller` owns every asynchronous
 * operation of the `ControlledPC`s built under it:
 * - SRD, SLD, rollback and addIceCandidate wait in a per-PC queue; only the
 *   head is enabled, and it runs only when the explorer resolves or rejects it.
 *   Closing the PC rejects what is queued, and every later op, with
 *   InvalidStateError.
 * - Every description carries an identity the explorer wrote, not Mesh:
 *   `a=x-pc:<s>/<n>`, `a=x-role`, `a=x-offer:<s>/<n>#<k>` on an offer and
 *   `a=x-answers:<remote x-pc>/<remote ufrag>/<remote x-offer>` on an answer.
 * - Gathering ends, and negotiationneeded fires, only when the explorer says.
 *   The flag is set by a first data channel, by addTrack and by restartIce,
 *   which also moves the ufrag on.
 * - Channels are paired: `send` appends to a lane FIFO the explorer delivers,
 *   `close` closes both ends and drops what is in flight.
 * - The benign network connects a pair whose identities match (below), opens
 *   every channel either side created and hands the other side its end.
 * - Known limit: closing a PC does not change the far PC's connectionState.
 * - The outage scenario's env:ice fault (`setIceState`) moves one PC to
 *   disconnected or failed. While either PC of a pair reads disconnected or
 *   failed, the pair is down: no video frames on either side, no lane
 *   delivery and no channel opening. The benign network brings a down pair
 *   back only once an ICE restart has run, that is when a description's
 *   ufrag has moved on since the drop; a rebuild heals through new PC ids.
 * - A PC that holds a remote description from a peer PC that is closed, or
 *   that no longer pairs with it (crossed offers: one side rebuilt, the
 *   other rolled back), has candidates nobody answers, so Chrome's ICE ends
 *   in "failed" ICE_FAILED_MS after the PC settled that way. The explorer
 *   takes that as the `pc:<id>:ice-timeout-failed` label (not a fault, no
 *   budget): `staleSince` stamps when a PC in state "new" began to qualify,
 *   and `wake` asks the room for a timer at the deadline so the clock can get
 *   there. A matched pair never qualifies, and a connected PC is left to
 *   env:ice.
 * - getStats on a closed PC rejects with InvalidStateError.
 * - getStats is a controller deferred; the slice-1 policy `auto` settles it
 *   inside the step that asked (a microtask, so the step's drain sees it).
 *
 * A PC learns its side from `building(side, …)`, which the room wraps around
 * each Mesh's addPeer (the only place Mesh constructs a PC).
 */
import { FakeChannel, FakePC, sdp, type FakePCController } from "../../webrtc/test-pc"
import { chromeStats } from "../../webrtc/test-stats"
import type { Side } from "../core/labels"

type Op = "srd" | "sld" | "cand" | "rollback"
type RejectClass = "InvalidAccessError" | "InvalidStateError" | "OperationError"

export interface PendingOp { pc: string; op: Op; index: number }
export interface OpLogEntry {
  pc: string
  op: string
  outcome: "resolved" | "rejected"
  sdpRole?: "offer" | "answer"
  xPc?: string
  xOffer?: string
  errorClass?: string
  error?: string
  step: number
}

export type InputInjector = <T>(side: Side, kind: string, value: unknown, run: () => T) => T

interface Queued { op: Op; index: number; remoteOffer: boolean; apply: () => void; resolve: () => void; reject: (error: unknown) => void }
interface PcInfo {
  side: Side
  n: number
  id: string
  queue: Queued[]
  ops: number
  offers: number
  ufrag: number
  negotiationNeeded: boolean
  restartIce: boolean
  /** video m-sections of the remote description seen so far (one ontrack each) */
  remoteVideo: number
  receiving: boolean
  framesDecoded: number
  channels: number
}
interface ChannelInfo { pc: FakePC; peer: FakeChannel | null; ordinal: number; far: boolean }
interface LaneFrame { source: FakeChannel; target: FakeChannel; data: unknown }

const attr = (body: string | undefined, name: string): string | undefined =>
  new RegExp(`^a=${name}:(.*)$`, "m").exec(body ?? "")?.[1]?.trim()

/** the media kinds of an SDP's m-sections, in order */
const mlines = (body: string | undefined): string[] =>
  (body ?? "").split(/\r?\n/).filter((line) => line.startsWith("m=")).map((line) => line.slice(2).split(" ")[0])

/** the offer id an `x-answers` value names */
const answeredOffer = (xAnswers: string | undefined): string | undefined => /^[^/]+\/\d+\/[^/]+\/(.+)$/.exec(xAnswers ?? "")?.[1]

/** how long Chrome's ICE checks run unanswered before the PC reads "failed" (about 30 s) */
export const ICE_FAILED_MS = 30_000

const closedError = () => new DOMException("The RTCPeerConnection's signalingState is 'closed'.", "InvalidStateError")

/** A FakePC that registers with the installed Controller under the side
 *  being built. */
export class ControlledPC extends FakePC {
  constructor(config?: RTCConfiguration) {
    super(config)
    const controller = FakePC.controller
    if (!(controller instanceof Controller)) throw new Error("explorer: a ControlledPC needs a Controller installed as FakePC.controller")
    controller.register(this)
  }

  /** The codec guard's fresh offer (mesh.ts stripAndSetOffer 2210-2231): the
   *  description an implicit setLocalDescription would set, with nothing set.
   *  Settled at once, not queued: only the guard calls it. */
  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    const controller = FakePC.controller
    if (!(controller instanceof Controller)) throw new Error("explorer: a ControlledPC needs a Controller installed as FakePC.controller")
    if (this.signalingState === "closed") throw closedError()
    return { type: "offer", sdp: controller.sdpFor(this, "offer") }
  }
}

export class Controller implements FakePCController {
  readonly statsPolicy = "auto" as const
  /** the explorer's step index, stamped on every op log entry; the room advances it */
  step = 0
  private current: Side | null = null
  private pcs = new Map<FakePC, PcInfo>()
  /** the PCs by side then n, kept in order as they register (it was a sort on
   *  every read, and the drain reads it several times a turn); replaced, never
   *  mutated, so a caller iterating it is not disturbed by a PC built meanwhile */
  private ordered: readonly [FakePC, PcInfo][] = []
  private byId = new Map<string, FakePC>()
  private count: Record<Side, number> = { a: 0, b: 0 }
  private log: OpLogEntry[] = []
  private channels = new Map<FakeChannel, ChannelInfo>()
  private lane: Record<"a>b" | "b>a", LaneFrame[]> = { "a>b": [], "b>a": [] }
  /** connected pairs, with the roles they connected in */
  private connected = new Map<string, { offerer: FakePC; answerer: FakePC }>()
  /** pairs an env:ice fault took down, with their ICE identity (both local ufrags) at the drop */
  private drops = new Map<string, string>()
  private stats: { id: string; settle: () => void }[] = []
  /** PCs whose remote peer PC is gone, with the fake time they began to qualify */
  private staleSince = new Map<FakePC, number>()
  /** the sides whose offers carry video RTX (opt-in, the codec guard's replay;
   *  ExploreRoomOptions.rtxOffers): an unsafe engine whose codec preferences
   *  did not keep RTX out, mesh.ts codecGuardNeeded 2187-2193 */
  rtxOffers: ReadonlySet<Side> = new Set()
  /** set by the room: make the clock reach `delayMs` from now (a timer that does nothing) */
  wake: (delayMs: number) => void = () => {}

  constructor(private readonly inject: InputInjector = (_side, _kind, _value, run) => run()) {}

  private enter<T>(side: Side, kind: string, value: unknown, run: () => T): T {
    return this.inject(side, kind, value, run)
  }

  // ── registration ──────────────────────────────────────────────────────────

  /** Run `build` with every ControlledPC it constructs registered to `side`. */
  building<T>(side: Side, build: () => T): T {
    const previous = this.current
    this.current = side
    try {
      return build()
    } finally {
      this.current = previous
    }
  }

  /** called by ControlledPC's constructor */
  register(pc: FakePC): void {
    const side = this.current
    if (!side) throw new Error("explorer: a ControlledPC built outside controller.building(side, …)")
    const n = ++this.count[side]
    const id = `${side}/${n}`
    const info: PcInfo = { side, n, id, queue: [], ops: 0, offers: 0, ufrag: 1, negotiationNeeded: false, restartIce: false, remoteVideo: 0, receiving: false, framesDecoded: 0, channels: 0 }
    this.pcs.set(pc, info)
    this.byId.set(id, pc)
    // n only rises within a side, so the new PC goes last among its side's
    const at = side === "a" ? this.ordered.findIndex(([, other]) => other.side !== "a") : -1
    this.ordered = at < 0 ? [...this.ordered, [pc, info]] : [...this.ordered.slice(0, at), [pc, info], ...this.ordered.slice(at)]
  }

  pcId(pc: FakePC): string {
    const info = this.pcs.get(pc)
    if (!info) throw new Error("explorer: a PC the controller never registered")
    return info.id
  }

  private entry(id: string): [FakePC, PcInfo] {
    const pc = this.byId.get(id)
    if (!pc) throw new Error(`explorer: no PC ${id}`)
    return [pc, this.pcs.get(pc)!]
  }

  private sorted(): readonly [FakePC, PcInfo][] {
    return this.ordered
  }

  // ── the op queue ──────────────────────────────────────────────────────────

  enqueue(pc: FakePC, op: Op, apply: () => void): Promise<void> {
    const info = this.pcs.get(pc)
    if (!info) return Promise.reject(new Error("explorer: an op on a PC the controller never registered"))
    const index = info.ops++
    if (pc.signalingState === "closed") {
      const error = closedError()
      this.record(info, op, "rejected", undefined, error)
      return new Promise<void>((_resolve, reject) => this.enter(info.side, "op:rejected", this.errorValue(info, op, error), () => reject(error)))
    }
    const remoteOffer = op === "srd" && pc.signalingState === "stable"
    return new Promise<void>((resolve, reject) => info.queue.push({ op, index, remoteOffer, apply, resolve, reject }))
  }

  /** the head of each PC's queue, by side then PC */
  pending(): PendingOp[] {
    const out: PendingOp[] = []
    for (const [, info] of this.sorted()) if (info.queue.length > 0) out.push({ pc: info.id, op: info.queue[0].op, index: info.queue[0].index })
    return out
  }

  private head(id: string, op: Op): [FakePC, PcInfo, Queued] {
    const [pc, info] = this.entry(id)
    const head = info.queue[0]
    if (!head || head.op !== op) throw new Error(`explorer: ${op} is not the head of ${id}'s queue (${head?.op ?? "empty"})`)
    info.queue.shift()
    return [pc, info, head]
  }

  /** Apply the head op's state change, then settle it. An apply that throws
   *  (FakePC's m-line rule, a candidate with no remote description) rejects. */
  resolve(id: string, op: Op): void {
    const [pc, info, head] = this.head(id, op)
    try {
      head.apply()
    } catch (error) {
      this.record(info, op, "rejected", undefined, error)
      this.enter(info.side, "op:rejected", this.errorValue(info, op, error), () => head.reject(error))
      return
    }
    if (op === "srd") this.tracks(pc, info)
    const desc = op === "sld" ? pc.localDescription : op === "srd" ? pc.remoteDescription : null
    if (desc?.type === "answer" && info.restartIce) {
      info.restartIce = false
      info.negotiationNeeded = false
    }
    this.record(info, op, "resolved", desc ?? undefined)
    this.enter(info.side, "op:resolved", { pc: info.id, op }, () => head.resolve())
  }

  reject(id: string, op: Op, cls: RejectClass): void {
    const [, info, head] = this.head(id, op)
    const error = new DOMException(`explorer: ${op} rejected`, cls)
    this.record(info, op, "rejected", undefined, error)
    this.enter(info.side, "op:rejected", this.errorValue(info, op, error), () => head.reject(error))
  }

  private errorValue(info: PcInfo, op: Op, error: unknown) {
    return {
      pc: info.id,
      op,
      errorClass: error instanceof Error ? error.name : typeof error,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  private record(info: PcInfo, op: Op, outcome: OpLogEntry["outcome"], desc?: { type: string; sdp?: string }, error?: unknown) {
    const entry: OpLogEntry = { pc: info.id, op, outcome, step: this.step }
    if (desc && (desc.type === "offer" || desc.type === "answer")) {
      entry.sdpRole = desc.type
      const xPc = attr(desc.sdp, "x-pc")
      const xOffer = desc.type === "offer" ? attr(desc.sdp, "x-offer") : answeredOffer(attr(desc.sdp, "x-answers"))
      if (xPc) entry.xPc = xPc
      if (xOffer) entry.xOffer = xOffer
    }
    if (error !== undefined) Object.assign(entry, this.errorValue(info, op, error))
    this.log.push(entry)
  }

  opLog(): OpLogEntry[] { return [...this.log] }

  /** Chrome fires ontrack inside SRD for each new remote video section. */
  private tracks(pc: FakePC, info: PcInfo) {
    const video = mlines(pc.remoteDescription?.sdp).filter((kind) => kind === "video").length
    for (; info.remoteVideo < video; info.remoteVideo++) {
      info.receiving = true
      const track = { kind: "video", id: `${info.id}-remote-${info.remoteVideo}`, readyState: "live", enabled: true, muted: false, addEventListener() {}, removeEventListener() {} }
      const stream = { id: `${info.id}-stream`, getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
      const event = { track, streams: [stream] }
      if (pc.ontrack) this.enter(info.side, "pc:ontrack", event, () => pc.ontrack?.(event))
    }
  }

  // ── SDP ───────────────────────────────────────────────────────────────────

  sdpFor(pc: FakePC, type: "offer" | "answer"): string {
    const info = this.pcs.get(pc)!
    const lines = [`a=x-pc:${info.id}`, `a=x-role:${type}`]
    let media: string[]
    if (type === "offer") {
      lines.push(`a=x-offer:${info.id}#${++info.offers}`)
      // a later offer keeps every negotiated section in order, then adds the new senders'
      const local = mlines(pc.localDescription?.sdp)
      const remote = mlines(pc.remoteDescription?.sdp)
      media = (local.length >= remote.length ? local : remote).filter((kind) => kind !== "application")
      for (const sender of pc.senders) {
        const kind = (sender.track as { kind?: string } | null)?.kind ?? "video"
        const wanted = pc.senders.filter((s) => ((s.track as { kind?: string } | null)?.kind ?? "video") === kind).length
        if (media.filter((k) => k === kind).length < wanted) media.push(kind)
      }
    } else {
      const remote = pc.remoteDescription?.sdp
      lines.push(`a=x-answers:${attr(remote, "x-pc") ?? "?"}/${attr(remote, "ice-ufrag") ?? "?"}/${attr(remote, "x-offer") ?? "?"}`)
      media = mlines(remote).filter((kind) => kind !== "application") // an answer mirrors the offer
    }
    let body = sdp(`${info.side}${info.n}`, { ufrag: `u${info.ufrag}`, media })
    // RTX beside each video codec, as a browser offers it (stripVideoRtx takes all three back out)
    if (type === "offer" && this.rtxOffers.has(info.side)) body = body.replace(/^m=video 9 UDP\/TLS\/RTP\/SAVPF 96$/gm, "m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96")
    return `${body}${lines.join("\r\n")}\r\n`
  }

  // ── close ─────────────────────────────────────────────────────────────────

  onClose(pc: FakePC): void {
    const info = this.pcs.get(pc)
    if (!info) return
    info.negotiationNeeded = false
    for (const item of info.queue.splice(0)) {
      const error = closedError()
      this.record(info, item.op, "rejected", undefined, error)
      this.enter(info.side, "op:rejected", this.errorValue(info, item.op, error), () => item.reject(error))
    }
    for (const [channel, held] of this.channels) if (held.pc === pc) this.closeChannel(channel)
  }

  // ── gathering and negotiationneeded ───────────────────────────────────────

  gathering(): string[] {
    return this.sorted().filter(([pc]) => pc.iceGatheringState === "gathering" && pc.signalingState !== "closed").map(([, info]) => info.id)
  }

  gather(id: string): void {
    if (!this.gathering().includes(id)) throw new Error(`explorer: ${id} is not gathering`)
    const [pc] = this.entry(id)
    const info = this.pcs.get(pc)!
    pc.iceGatheringState = "complete"
    const candidate = { candidate: null }
    if (pc.onicecandidate) this.enter(info.side, "pc:onicecandidate", candidate, () => pc.onicecandidate?.(candidate))
    this.enter(info.side, "pc:dispatch:icecandidate", candidate, () => pc.dispatch("icecandidate", candidate))
    if (pc.onicegatheringstatechange) this.enter(info.side, "pc:onicegatheringstatechange", {}, () => pc.onicegatheringstatechange?.())
    this.enter(info.side, "pc:dispatch:icegatheringstatechange", {}, () => pc.dispatch("icegatheringstatechange"))
  }

  restartIce(pc: FakePC): void {
    const info = this.pcs.get(pc)
    if (!info || pc.signalingState === "closed") return
    info.ufrag++
    info.restartIce = true
    info.negotiationNeeded = true
  }

  addTrack(pc: FakePC): void {
    const info = this.pcs.get(pc)
    if (info && pc.signalingState !== "closed") info.negotiationNeeded = true
  }

  createDataChannel(pc: FakePC, channel: FakeChannel): void {
    const info = this.pcs.get(pc)
    const ordinal = info ? ++info.channels : 0
    this.channels.set(channel, { pc, peer: null, ordinal, far: false })
    if (!info || pc.signalingState === "closed") return
    // only while no application section exists yet, in either description
    const negotiated = [pc.localDescription?.sdp, pc.remoteDescription?.sdp].some((body) => mlines(body).includes("application"))
    if (!negotiated) info.negotiationNeeded = true
  }

  /** PCs whose flag is set while `stable` */
  negotiationNeeded(): string[] {
    return this.sorted().filter(([pc, info]) =>
      info.negotiationNeeded && pc.signalingState === "stable" && !info.queue.some((item) => item.remoteOffer),
    ).map(([, info]) => info.id)
  }

  fireNegotiationNeeded(id: string): void {
    if (!this.negotiationNeeded().includes(id)) throw new Error(`explorer: ${id} needs no negotiation`)
    const [pc, info] = this.entry(id)
    info.negotiationNeeded = false
    if (pc.onnegotiationneeded) void this.enter(info.side, "pc:onnegotiationneeded", {}, () => pc.onnegotiationneeded?.())
  }

  // ── stats ─────────────────────────────────────────────────────────────────

  getStats(pc: FakePC): Promise<unknown> {
    const info = this.pcs.get(pc)
    if (!info) return Promise.resolve(pc.stats)
    if (pc.signalingState === "closed") return Promise.reject(closedError())
    return new Promise((resolve) => {
      const held = {
        id: info.id,
        settle: () => {
          this.stats = this.stats.filter((other) => other !== held)
          if (info.receiving && !this.pairDown(pc)) info.framesDecoded += 30
          resolve(chromeStats({ t: Date.now(), decoded: info.framesDecoded, lost: 0, received: info.framesDecoded, bytesSent: 0, freezes: 0, cpu: 0 }))
        },
      }
      this.stats.push(held)
      // policy "auto": settled inside the step that asked ("choice" is the other policy)
      queueMicrotask(() => this.enter(info.side, "pc:getStats:settle", { pc: info.id }, held.settle))
    })
  }

  /** the PCs with a getStats deferred not yet settled */
  pendingStats(): string[] { return this.stats.map((held) => held.id) }

  // ── channels and lanes ────────────────────────────────────────────────────

  private sideOf(channel: FakeChannel): Side {
    return this.pcs.get(this.channels.get(channel)!.pc)!.side
  }

  send(channel: FakeChannel, data: unknown): void {
    const peer = this.channels.get(channel)?.peer
    const from = this.sideOf(channel)
    const refused = channel.readyState !== "open" || !peer
    const value = refused
      ? { fate: "refused", errorClass: "InvalidStateError", error: "RTCDataChannel.readyState is not 'open'", data }
      : { fate: "sent", data }
    this.enter(from, "lane:send", value, () => {
      if (refused || !peer) throw new DOMException("RTCDataChannel.readyState is not 'open'", "InvalidStateError")
      const to = this.sideOf(peer)
      this.lane[`${from}>${to}` as "a>b"].push({ source: channel, target: peer, data })
    })
  }

  closeChannel(channel: FakeChannel): void {
    if (channel.readyState === "closed") return
    const peer = this.channels.get(channel)?.peer ?? null
    const ends = peer && peer.readyState !== "closed" ? [channel, peer] : [channel]
    for (const end of ends) end.readyState = "closed"
    for (const key of ["a>b", "b>a"] as const) {
      this.lane[key] = this.lane[key].filter((frame) => !ends.includes(frame.source) && !ends.includes(frame.target))
    }
    // Chrome queues the close event; the step's drain still runs it
    for (const end of ends) {
      const side = this.sideOf(end)
      queueMicrotask(() => {
        if (end.onclose) this.enter(side, "channel:onclose", { channel: this.channelId(end) }, () => end.onclose?.())
      })
    }
  }

  lanes(): { from: Side; to: Side; size: number }[] {
    const out: { from: Side; to: Side; size: number }[] = []
    for (const [from, to] of [["a", "b"], ["b", "a"]] as const) {
      const queue = this.lane[`${from}>${to}` as "a>b"]
      const head = queue[0]
      // a down pair holds its frames (SCTP retransmits once the link is back)
      if (head && !this.pairDown(this.channels.get(head.source)!.pc) && !this.pairDown(this.channels.get(head.target)!.pc)) out.push({ from, to, size: queue.length })
    }
    return out
  }

  deliverLane(from: Side, to: Side): void {
    if (!this.lanes().some((lane) => lane.from === from && lane.to === to)) throw new Error(`explorer: lane ${from}>${to} is empty or down`)
    const frame = this.lane[`${from}>${to}` as "a>b"].shift()!
    const event = { data: frame.data }
    const handler = frame.target.onmessage as ((event: { data: unknown }) => void) | null
    if (handler) this.enter(to, "channel:onmessage", event, () => handler(event))
  }

  // ── the benign network ────────────────────────────────────────────────────

  /** Connect every pair whose identities match: both stable and
   *  gathered, each the other's remote x-pc, the answer's x-answers naming
   *  the offerer's current offer (x-pc, ufrag, x-offer). Once per pair, and
   *  again for a pair an env:ice fault took down once its ICE identity has
   *  moved on (an ICE restart). On every call, channels either PC has created
   *  since open too, while neither PC is closed and the pair is up. */
  applyBenignNetwork(): void {
    const all = this.sorted()
    for (const [a, ai] of all) {
      if (ai.side !== "a") continue
      for (const [b, bi] of all) {
        if (bi.side !== "b") continue
        const roles = this.roles(a, ai, b, bi)
        if (!roles) continue
        const key = `${ai.id}|${bi.id}`
        if (!this.connected.has(key)) {
          this.connected.set(key, roles)
          this.setState([a, b], "connected")
        } else if (this.drops.has(key) && this.iceIdentity(a, b) !== this.drops.get(key)) {
          // an ICE restart ran on a down pair: it heals; only a PC whose state changes hears it
          this.drops.delete(key)
          this.connected.set(key, roles)
          this.setState([a, b].filter((pc) => pc.connectionState !== "connected"), "connected")
        }
      }
    }
    for (const { offerer, answerer } of this.connected.values()) {
      if (offerer.signalingState !== "closed" && answerer.signalingState !== "closed" && !this.pairDown(offerer)) this.openChannels(offerer, answerer)
    }
    this.refreshStale()
  }

  /** the PC settled holding a remote description its peer PC cannot answer */
  private isStale(pc: FakePC, info: PcInfo): boolean {
    if (pc.signalingState !== "stable" || pc.iceGatheringState !== "complete" || pc.connectionState !== "new" || pc.iceConnectionState !== "new") return false
    if (!pc.localDescription || !pc.remoteDescription) return false
    const far = this.byId.get(attr(pc.remoteDescription.sdp, "x-pc") ?? "")
    if (!far || far === pc) return false
    if (far.signalingState === "closed") return true
    if (far.signalingState !== "stable" || far.iceGatheringState !== "complete") return false
    const [a, b] = info.side === "a" ? [pc, far] : [far, pc]
    return this.roles(a, this.pcs.get(a)!, b, this.pcs.get(b)!) === null
  }

  private refreshStale(): void {
    for (const [pc, info] of this.pcs) {
      if (!this.isStale(pc, info)) this.staleSince.delete(pc)
      else if (!this.staleSince.has(pc)) {
        this.staleSince.set(pc, Date.now())
        this.wake(ICE_FAILED_MS)
      }
    }
  }

  /** the PCs whose ICE has timed out by now (the `ice-timeout-failed` labels) */
  iceTimedOut(): string[] {
    const now = Date.now()
    return this.sorted().filter(([pc]) => (this.staleSince.get(pc) ?? Number.POSITIVE_INFINITY) + ICE_FAILED_MS <= now).map(([, info]) => info.id)
  }

  /** the ICE timeout: the PC moves to failed and hears both events; no pair is down by it, none is connected */
  failIce(id: string): void {
    const [pc] = this.entry(id)
    if (!this.iceTimedOut().includes(id)) throw new Error(`explorer: ${id} has no ICE timeout due`)
    this.staleSince.delete(pc)
    this.setState([pc], "failed")
  }

  /** set each PC's connection and ICE state, then fire both events on each (Chrome's order) */
  private setState(pcs: FakePC[], state: RTCPeerConnectionState & RTCIceConnectionState) {
    for (const pc of pcs) {
      pc.connectionState = state
      pc.iceConnectionState = state
    }
    for (const pc of pcs) {
      const info = this.pcs.get(pc)!
      if (pc.onconnectionstatechange) this.enter(info.side, "pc:onconnectionstatechange", {}, () => pc.onconnectionstatechange?.())
      this.enter(info.side, "pc:dispatch:connectionstatechange", {}, () => pc.dispatch("connectionstatechange"))
      if (pc.oniceconnectionstatechange) this.enter(info.side, "pc:oniceconnectionstatechange", {}, () => pc.oniceconnectionstatechange?.())
      this.enter(info.side, "pc:dispatch:iceconnectionstatechange", {}, () => pc.dispatch("iceconnectionstatechange"))
    }
  }

  /** a pair's ICE identity: both PCs' local ufrags (an ICE restart moves the offerer's) */
  private iceIdentity(a: FakePC, b: FakePC): string {
    return `${attr(a.localDescription?.sdp, "ice-ufrag")}|${attr(b.localDescription?.sdp, "ice-ufrag")}`
  }

  /** the PC reads disconnected or failed, or a PC it connected with does */
  private pairDown(pc: FakePC): boolean {
    const down = (other: FakePC) => other.connectionState === "disconnected" || other.connectionState === "failed"
    if (down(pc)) return true
    for (const { offerer, answerer } of this.connected.values()) {
      if (offerer === pc && down(answerer)) return true
      if (answerer === pc && down(offerer)) return true
    }
    return false
  }

  /** The outage scenario's env:ice fault: the PC moves to `state` and hears
   *  both events; every pair it is connected in is down until an ICE restart
   *  (or a rebuild) brings it back. */
  setIceState(id: string, state: "disconnected" | "failed"): void {
    const [pc] = this.entry(id)
    if (pc.connectionState !== "connected") throw new Error(`explorer: ${id} is not connected (${pc.connectionState})`)
    for (const [key, { offerer, answerer }] of this.connected) {
      if (offerer !== pc && answerer !== pc) continue
      const [a, b] = this.pcs.get(offerer)!.side === "a" ? [offerer, answerer] : [answerer, offerer]
      if (!this.drops.has(key)) this.drops.set(key, this.iceIdentity(a, b))
    }
    this.setState([pc], state)
  }

  private roles(a: FakePC, ai: PcInfo, b: FakePC, bi: PcInfo): { offerer: FakePC; answerer: FakePC } | null {
    for (const pc of [a, b]) {
      if (pc.signalingState !== "stable" || pc.iceGatheringState !== "complete") return null
      if (!pc.localDescription || !pc.remoteDescription) return null
    }
    if (attr(a.remoteDescription!.sdp, "x-pc") !== bi.id || attr(b.remoteDescription!.sdp, "x-pc") !== ai.id) return null
    const offerer = a.localDescription!.type === "offer" ? a : b.localDescription!.type === "offer" ? b : null
    if (!offerer) return null
    const answerer = offerer === a ? b : a
    if (answerer.localDescription!.type !== "answer" || offerer.remoteDescription!.type !== "answer" || answerer.remoteDescription!.type !== "offer") return null
    const offer = offerer.localDescription!.sdp
    const expected = `${this.pcs.get(offerer)!.id}/${attr(offer, "ice-ufrag")}/${attr(offer, "x-offer")}`
    if (attr(answerer.localDescription!.sdp, "x-answers") !== expected) return null
    if (attr(offerer.remoteDescription!.sdp, "x-answers") !== expected) return null
    if (attr(answerer.remoteDescription!.sdp, "x-offer") !== attr(offer, "x-offer")) return null
    return { offerer, answerer }
  }

  /** Every unpaired connecting channel of either PC opens, as in Chrome once
   *  SCTP is up, and the other PC gets its far end, open, through
   *  ondatachannel (Mesh's lower-id rule then picks one, mesh.ts:1750-1762). */
  private openChannels(offerer: FakePC, answerer: FakePC) {
    const pending = [...this.channels]
      .filter(([channel, held]) =>
        !held.far &&
        (held.pc === offerer || held.pc === answerer) &&
        !held.peer &&
        channel.readyState === "connecting",
      )
      .sort(([, left], [, right]) => {
        const leftOwner = this.pcs.get(left.pc)!
        const rightOwner = this.pcs.get(right.pc)!
        const owner = leftOwner.side === rightOwner.side
          ? leftOwner.n - rightOwner.n
          : leftOwner.side < rightOwner.side ? -1 : 1
        return owner === 0 ? left.ordinal - right.ordinal : owner
      })
    for (const [channel, held] of pending) {
      const other = held.pc === offerer ? answerer : offerer
      const far = new FakeChannel()
      far.readyState = "open"
      this.channels.set(far, { pc: other, peer: channel, ordinal: held.ordinal, far: true })
      held.peer = far
      channel.readyState = "open"
      const owner = this.pcs.get(held.pc)!.side
      if (channel.onopen) this.enter(owner, "channel:onopen", { channel: this.channelId(channel) }, () => channel.onopen?.())
      const receiver = this.pcs.get(other)!.side
      const event = { channel: far }
      const handler = other.ondatachannel as ((event: { channel: FakeChannel }) => void) | null
      if (handler) this.enter(receiver, "pc:ondatachannel", event, () => handler(event))
    }
  }

  channelId(channel: FakeChannel): string {
    const held = this.channels.get(channel)
    if (!held) throw new Error("explorer: a channel the controller never registered")
    const owner = held.far ? this.channels.get(held.peer!)!.pc : held.pc
    return `${this.pcId(owner)}/channel-${held.ordinal}${held.far ? "/far" : ""}`
  }

  /** State owned by the controlled browser surface, with no callbacks or promise identities. */
  fingerprintState(): unknown {
    const pcs = this.sorted().map(([pc, info]) => ({
      id: info.id,
      state: {
        connection: pc.connectionState,
        iceConnection: pc.iceConnectionState,
        iceGathering: pc.iceGatheringState,
        signaling: pc.signalingState,
      },
      localDescription: pc.localDescription,
      remoteDescription: pc.remoteDescription,
      identity: { offers: info.offers, ufrag: info.ufrag },
      // only while a timeout runs, so every other state keeps its fingerprint
      ...(this.staleSince.has(pc) ? { staleSince: this.staleSince.get(pc) } : {}),
      queuedOps: info.queue.map(({ op, index }) => ({ op, index })),
      negotiationNeeded: info.negotiationNeeded,
      media: { remoteVideo: info.remoteVideo, receiving: info.receiving, framesDecoded: info.framesDecoded },
      pcData: {
        config: pc.config,
        channelCreations: pc.channelCreations,
        listeners: [...((pc as unknown as { listeners: Map<string, unknown[]> }).listeners ?? new Map())]
          .map(([event, registered]) => ({ event, count: registered.length }))
          .sort((left, right) => left.event.localeCompare(right.event)),
        senders: pc.senders.map((sender) => ({
          id: sender.id,
          parameters: sender.parameters,
          writes: sender.writes,
          replacements: sender.replacements.map((track) => track === null ? null : { kind: track.kind, id: track.id }),
          track: sender.track === null ? null : { kind: sender.track.kind, id: sender.track.id },
          rejectOnce: [...sender.rejectOnce].sort(),
          emptyBeforeStable: sender.emptyBeforeStable,
        })),
      },
      channels: [...this.channels]
        .filter(([, held]) => held.pc === pc)
        .map(([channel, held]) => ({ id: this.channelId(channel), state: channel.readyState, peer: held.peer ? this.channelId(held.peer) : null }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    }))
    const lanes = (["a>b", "b>a"] as const).flatMap((direction) =>
      this.lane[direction].map((frame) => ({
        direction,
        source: this.channelId(frame.source),
        target: this.channelId(frame.target),
        data: frame.data,
      })),
    )
    const connected = [...this.connected.entries()].map(([pair, { offerer, answerer }]) => ({
      pair,
      offerer: this.pcId(offerer),
      answerer: this.pcId(answerer),
    })).sort((left, right) => left.pair.localeCompare(right.pair))
    const drops = [...this.drops].map(([pair, ice]) => ({ pair, ice })).sort((left, right) => left.pair.localeCompare(right.pair))
    return { pcs, lanes, connected, drops, stats: this.stats.map(({ id }) => id).sort() }
  }

  // ── reset ─────────────────────────────────────────────────────────────────

  reset(): void {
    this.step = 0
    this.current = null
    this.pcs.clear()
    this.ordered = []
    this.byId.clear()
    this.count = { a: 0, b: 0 }
    this.log = []
    this.channels.clear()
    this.lane = { "a>b": [], "b>a": [] }
    this.connected.clear()
    this.drops.clear()
    this.staleSince.clear()
    this.stats = []
  }
}
