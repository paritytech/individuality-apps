// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Signalling seam for a WebRTC mesh. The mesh exchanges SDP/ICE as opaque
 * `RtcPayload`s and knows nothing about HOW they travel — a `SignalTransport`
 * delivers roster + peer signals to `SignalHandlers` and sends outbound
 * signals. To port a mesh to a different signalling channel you implement a
 * new `CreateTransport` factory; nothing mesh-side changes.
 *
 * Types only. The implementation this package ships is `statementTransport`
 * — the People-chain statement store.
 */

/** SDP/ICE envelope relayed between peers (opaque to the transport).
 *  `gen` is the signalling generation of an offer: a transport that labels
 *  its frames hands it to the mesh with the offer, and the mesh echoes it on
 *  its answer, so the answer is labelled with the offer it answers (F7,
 *  #214). Absent on a wire without generations. */
export interface RtcPayload {
  rtc: { desc?: RTCSessionDescriptionInit; cand?: RTCIceCandidateInit; gen?: string }
}
export function isRtcPayload(data: unknown): data is RtcPayload {
  return !!data && typeof data === "object" && "rtc" in (data as object)
}

/** Callbacks a transport invokes as room membership + peer signals arrive. */
export interface SignalHandlers {
  onOpen?: () => void
  /** A peer is in the room. `seen` = we have live evidence it's actually
   *  present right now (a heartbeat), vs an optimistic roster announce. */
  onPeerJoined: (id: string, name: string, seen?: boolean) => void
  onPeerLeft: (id: string) => void
  onSignal: (from: string, data: unknown) => void
  /** A peer's view of the room rode its presence frame: what it sees of each
   *  member (the app reads it, lib/webrtc/link-view.ts). Optional: a wire
   *  with no presence frame never calls it. */
  onView?: (from: string, view: string) => void
  /** A peer's signalling session changed: it reloaded, so the connection we
   *  negotiated with its previous boot is dead. Raised before the new
   *  session's first frame is delivered, and never for the first session
   *  heard from a peer. Optional: a wire without sessions never calls it. */
  onPeerSession?: (id: string, sid: string) => void
}

/**
 * Health of the signalling channel, for observability — a stuck mesh must be
 * attributable to the RIGHT layer:
 *   - submitsFailed climbing / lastError set  → signalling can't write (allowance?)
 *   - submitsOk climbing but framesRecv flat  → we write, nothing comes back
 *   - storeLive false                         → no transport at all
 */
export interface SignalStats {
  kind: string // "statement" | "inert" | …
  storeLive: boolean // the concrete store constructed (vs the inert fallback)
  subActive: boolean // subscription established
  submitsOk: number
  submitsFailed: number
  framesSent: number
  framesRecv: number
  lastSubmitOkAt: number // epoch ms, 0 = never
  lastInboundAt: number // epoch ms, 0 = never
  lastError: string // last submit error, "" = none
  /** submits currently occupying a semaphore slot — >0 with submitsOk flat
   *  means the sign/submit call has not returned. */
  inflight: number
  /** epoch ms of the FIRST submit attempt, 0 = never tried. */
  firstSendAt: number
  /** sign-step (createProof) timeouts, counted separately from submit failures. */
  signTimeouts: number
  /** Why sealed signalling went dark, on a wire with end-to-end keys
   *  (statementTransport `keys`); absent without them. A player with no key
   *  reads as "nobody links", so these tell that loss apart from ICE. */
  sealed?: SealedSignalStats
}

/** Counters of the sealed wire's drops, each since the room opened. */
export interface SealedSignalStats {
  /** lookups of this player's own registered key that found none (or hung) */
  ownKeyMissing: number
  /** peers whose lookup found no communication identifier on chain */
  peerIdMissing: number
  /** sealed frames that failed to open (wrong key, tampered, bad header) */
  openFailed: number
  /** directed frames that came in the clear and were dropped */
  plaintextDropped: number
  /** sealed frames dropped because the inbound lookups were at their cap */
  droppedAtLookupCap: number
  /** sealed frames dropped because their peer's key missed recently */
  droppedInBackoff: number
}

/**
 * Health of one peer link on a wire with per-peer sessions, in the spirit of
 * `SignalStats` — a stuck link must be attributable to the right layer:
 *   - `sent` climbing, `acked` flat        → the peer isn't reading/ACKing
 *   - `submitsFailed` / `lastError` set    → we can't write (allowance?)
 *   - `submitsOk` climbing, `received` flat → we write, nothing comes back
 *   - `priorityRejects` climbing           → our expiry is behind the store's
 */
export interface SessionStats {
  kind: "session"
  /** subscription established (i.e. `start()` ran and the store took it) */
  subActive: boolean
  /** Request statements submitted (merges count separately) */
  sent: number
  /** payloads handed to `onMessage` */
  received: number
  /** Responses that cleared an in-flight request */
  acked: number
  /** ACKs we submitted for peer requests */
  acksSent: number
  submitsOk: number
  submitsFailed: number
  /** non-fatal `channelPriorityTooLow` rejections */
  priorityRejects: number
  /** statements dropped by the data-hash or request-id dedup sets */
  duplicates: number
  /** payloads waiting for the next merge */
  queued: number
  /** un-ACKed messages dropped to keep a merged request under the cap */
  evicted: number
  /** epoch ms of the last accepted submit, 0 = never */
  lastSubmitOkAt: number
  /** epoch ms of the last incoming statement, 0 = never */
  lastInboundAt: number
  /** last error, "" = none */
  lastError: string
}

/** A live signalling channel for one room. */
export interface SignalTransport {
  /** send a signal to a specific peer id, or "*" to broadcast to the room. */
  send(to: string, data: unknown): void
  /** leave the room + stop receiving. */
  close(): void
  /** current signalling-health snapshot. */
  stats?(): SignalStats
  /** Per-peer counters, where the wire has per-peer sessions — the aggregate
   *  in `stats()` cannot show that ONE link is starved while the rest are
   *  fine, which is the difference between "our store is broken" and "that
   *  peer is". Absent on wires with a single shared subscription, which
   *  includes `statementTransport`. */
  sessionStats?(): Map<string, SessionStats>
  /** What this side sees of the room, carried by its presence frame from the
   *  next heartbeat on, so a peer whose link to us is down still reads it.
   *  Opaque to the transport. Absent on wires with no presence frame. */
  setView?(view: string): void
  /** Whether our link to this peer is connected, in the mesh's own word. A
   *  linked peer holds both descriptions already, so a wire with a heartbeat
   *  stops re-announcing ours to it, slows its hello once every link is up,
   *  and never forgets a linked peer for hello silence. Absent on wires with
   *  no heartbeat. */
  setLinked?(peerId: string, linked: boolean): void
  /** The room's other members now (`TransportConfig.peers`), on a wire that
   *  opened with them. A wire that listens by roster hears a new member from
   *  here on; a gone one is the caller's to ignore. Absent on wires with no
   *  roster. */
  setPeers?(peers: string[]): void
}

export interface TransportConfig {
  base: string
  room: string
  id: string
  name: string
  handlers: SignalHandlers
  /** the on-chain game the room belongs to — the native apps' envelope
   *  carries it, so a transport on that wire needs it; others ignore it */
  gameIndex?: number
  /** the room's other members, when the caller knows them up front (a wire
   *  without a roster opens one session per peer from this list). The
   *  statement wire then listens to these alone: each side's presence goes
   *  under its own topic, and it subscribes to its members' (#1959) */
  peers?: string[]
}

/** Factory that opens a transport for a room. Swap this to change signalling. */
export type CreateTransport = (cfg: TransportConfig) => SignalTransport
