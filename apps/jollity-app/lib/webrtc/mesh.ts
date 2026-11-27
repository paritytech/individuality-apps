// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Full-mesh WebRTC (one RTCPeerConnection per remote peer): camera video, plus
 * one ordered data channel per peer for in-band bytes. Uses "perfect
 * negotiation" so both sides can add tracks without glare; the polite/impolite
 * role is decided by a deterministic id compare. The mesh is transport-agnostic:
 * SDP/ICE travel as opaque `RtcPayload`s over an injected `signal` callback
 * (see transport.ts).
 *
 * TWO NEGOTIATIONS PER PEER, ON TWO PATHS — the wire shape of the native
 * Polkadot-app game clients ("the mobile apps" in these comments; now
 * discontinued, the shape is kept for compatibility), and what the statement
 * store can carry:
 *
 *  1. The FIRST negotiation is DATA-CHANNEL-ONLY and goes over the signalling
 *     transport. A mobile peer compresses an offer into a ~200-byte
 *     setup message and rebuilds the SDP from a fixed template whose only
 *     m-section is `m=application … webrtc-datachannel`, so an offer with media
 *     in it cannot be represented on that wire. No track is added before the
 *     channel is open.
 *  2. MEDIA is negotiated IN-BAND: once the channel opens both sides add their
 *     tracks, and the offerer alone sends a full-SDP offer down the channel's
 *     renegotiation lane (`USE_CASE_RENEGOTIATION`, a `DataChannelMessage`
 *     frame); the answer comes back the same way. Every later renegotiation
 *     — an ICE restart included — rides the lane too while the channel is
 *     open; a peer whose channel is gone is rebuilt from step 1.
 *
 * A PEER THAT COMES BACK AS A NEW CONNECTION is told apart two ways:
 *  - a RELOAD (a new page boot) by the signalling session: the transport
 *    carries a per-boot session id on every frame and raises
 *    `onPeerSession` when it changes (#214), and the actor's rebuild for it
 *    lands before the new session's first description arrives;
 *  - its own REBUILD inside one boot (a supervisor or negotiation-error
 *    rebuild on its side) keeps its session id, so that case is still told by
 *    the SDP: the o= session id and the DTLS fingerprint, which one
 *    RTCPeerConnection keeps for life (remoteSessionOf, #223). The
 *    InvalidAccessError net (the actor's offer-refused-rejoin) stays under both.
 *
 * Frames on the channel are `DataChannelMessage`s. The mesh consumes its own
 * frames (the renegotiation lane, link views, away/back); every other frame
 * (gestures, clock pings, media state) is handed to `onMessage` untouched, and
 * outbound bytes are queued in a per-peer outbox until that peer's channel
 * opens.
 */
import {
  decodeChannelMessage,
  decodePeerConnectionSignal,
  encodeChannelMessage,
  encodePeerConnectionSignal,
  USE_CASE_RENEGOTIATION,
  type PeerConnectionSignalValue,
  type RtcPayload,
} from "@jollity/statement-core"
import { decodeAway, encodeAway } from "./away-frame"
import { encodeKeyframeRequest, USE_CASE_KEYFRAME_REQUEST } from "./keyframe-frame"
import { VIEW, decodeView, decodeViewFrame, encodeView, encodeViewFrame, type ViewCode } from "./link-view"
import { SEAT_TIMES, type SeatFacts } from "./seat-state"
import { RETURN_GAP_MS, SUPERVISE_MS, SUPERVISOR_TIMING } from "./supervisor-timing"
import { devLog } from "../debug/log-store"
import { describeError } from "../host/error-detail"
import { pageHidden } from "../telemetry/util"
import { keyFramesEncoded, readStats, resolvedRelay, type RtcSample } from "./rtc-stats"
import { sdpVideoFeatures, type SdpVideo } from "./sdp-video"
import { HealTracker, type HealTrigger } from "./heal"
import { HealCohortTracker, linkFailKind, type HealCohortPath, type LinkFailure } from "./heal-cohort"
import { AwayPeriods, offererOfLocal, offererOfReceived, type AwayOfferer, type AwayReturn } from "./away-period"
import { isInitiator, type FunnelStage } from "./funnel"
import { GatherTracker, candidateType, gatheredAttr, iceErrorInfo, type GatherSnapshot } from "./gather"
import { iceConfigFor } from "./path-mode"
import { OfferClock } from "./offer-clock"
import { safely, type KeyframeMethod, type NegotiationErrorEvent, type ResumeEvent, type RtcEvent } from "./rtc-events"
import {
  FULL_VIDEO_RUNG,
  type SendRungIndex,
  type VideoRung,
  type VideoRungApplyResult,
  type VideoRungField,
  type VideoRungSenderResult,
} from "./send-adaptation-classifier"
import { takeReturnCandidateProbe } from "../resume-reload"
import { readRtcpClockEvidence, type RtcpClockEvidence } from "./rtcp-clock"
import { registerPagePeerConnection } from "../telemetry/resource-counters"
import { observeLegacyDecision } from "./legacy-decision-capture"
import { createPeerActorState, KICK_AFTER_HIDDEN_MS, UNSEEN_ICE_RESTARTS, type PeerActorCommand, type PeerActorEvent, type PeerCommandSite } from "../state-machines/peer-actor"
import { PeerActorSummary } from "../state-machines/peer-actor-summary"
import { PeerRoomRunner, type PeerCommandEffect, type PeerCommandResult } from "../state-machines/peer-runner"
import { iceServerCounts } from "./turn-diagnostics"
import { candidateForLog } from "./candidate-log"

/** Every mesh event goes to the console AND the debug sheet: a phone has no
 *  console anyone reads, and "the connection failed" is only diagnosable from
 *  an export that says which step — offer, answer, ICE, channel, track —
 *  never happened. */
function rtcLog(...parts: unknown[]): void {
  console.log(...parts)
  devLog("rtc", parts.map((part) => (typeof part === "string" ? part : String(part))).join(" "))
}

/** A keyframe by switching the encoder off and back on (#557). The encoder
 *  restarts on the first frame after `active` returns, and starts on a keyframe. */
async function toggleEncoder(sender: RTCRtpSender): Promise<void> {
  const set = async (active: boolean) => {
    const params = sender.getParameters()
    const encoding = params.encodings?.[0]
    if (!encoding) throw new Error("no encodings")
    encoding.active = active
    await sender.setParameters(params)
  }
  await set(false)
  try {
    await set(true)
  } catch (err) {
    await set(true).catch(() => {}) // never leave the sender switched off
    throw err
  }
}

/** THE MESH'S CLOCK for every duration: the device's monotonic clock, so a wall-clock step (NTP, a manual
 *  change, a phone 75 s fast being corrected) can never land in a timing (#319). Offset by 1 ms so a reading
 *  is never 0, which several fields here use for "unset". */
export const monoNow = () => performance.now() + 1
/** "never happened" for a monoNow() timestamp: `now - NEVER` is infinite, so no window ever holds it, however young the page */
const NEVER = -Infinity
const SENDER_WRITE_TIMEOUT_MS = 5_000

interface SenderMutation {
  cancelled: boolean
}

/** a link's path: relay when either end of the selected pair is a TURN relay */
export type LinkPath = "direct" | "relay" | "unknown"

/** What the waiting room's dots read of one link (Mesh.links). */
export interface MeshLink {
  conn: RTCPeerConnectionState
  path: LinkPath
  /** the peer put an SDP/ICE endpoint on the store, for this connection or
   *  one that was up before it was rebuilt */
  endpoint: boolean
}

function pathOf(quality: RtcSample): LinkPath {
  return quality.localType === "relay" || quality.remoteType === "relay" ? "relay" : "direct"
}

/** per-peer diagnostics row (Mesh.report) */
export interface PeerReport {
  id: string
  away: boolean
  conn: RTCPeerConnectionState
  ice: RTCIceConnectionState
  gather: RTCIceGatheringState
  sig: RTCSignalingState
  send: string[]
  recv: string[]
  /** selected candidate-pair summary, filled from getStats when available */
  pair?: string
  /** inbound framesDecoded, filled from getStats when available */
  frames?: number
  /** the link's quality counters, from the same getStats (rtc-stats.ts readStats) */
  quality?: RtcSample
  /** Stable physical-link identity for clock diagnostics, even when getStats throws. */
  statsLink?: number
  /** Passive sender-report clock samples from this same getStats snapshot. */
  rtcpClock?: RtcpClockEvidence
  /** the last funnel stage this peer reached (funnel.ts), absent before any */
  stage?: FunnelStage
  /** what this connection gathered so far (gather.ts): the candidates by type,
   *  the time once complete, the errors: what a pair that never connected had
   *  to offer */
  gathered?: GatherSnapshot
  /** the repair formats (RTX, RED, ULPFEC, FlexFEC) both current descriptions
   *  carry (sdp-video.ts), absent before both exist; for the rtc.link row */
  sdp?: SdpVideo
}

// The Polkadot host WebView exposes WebRTC only under the legacy prefixed name;
// the unprefixed global is frozen undefined there. Resolve the usable ctor.
const PC: typeof RTCPeerConnection =
  (globalThis as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection ??
  (globalThis as { webkitRTCPeerConnection?: typeof RTCPeerConnection }).webkitRTCPeerConnection!

// Diagnostic: which ctor did we get? (Readable in logcat via chromium CONSOLE.)
rtcLog(
  "[jollity-rtc] PC ctor:",
  typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection,
  "unprefixed /",
  typeof (globalThis as { webkitRTCPeerConnection?: unknown }).webkitRTCPeerConnection,
  "webkit → using:",
  typeof PC,
)

/** Extract the direction token (sendrecv|sendonly|recvonly|inactive) from the
 *  video m-section of an SDP — tells us whether a peer intends to SEND video.
 *  Diagnostic for the iOS "no outbound video" case: an iOS answer that comes
 *  back `recvonly` means iOS declined to send (negotiation bug), vs `sendrecv`
 *  meaning it is trying to. */
function videoDir(sdp: string | undefined): string {
  if (!sdp) return "?"
  const lines = sdp.split(/\r?\n/)
  let inVideo = false
  let dir = "sendrecv" // SDP default when no direction attr is present
  for (const line of lines) {
    if (line.startsWith("m=")) inVideo = line.startsWith("m=video")
    else if (inVideo && /^a=(sendrecv|sendonly|recvonly|inactive)/.test(line)) dir = line.slice(2)
  }
  return dir
}

/** WHICH REMOTE CONNECTION wrote this SDP (#223). The o= line's session id
 *  and the DTLS fingerprint are both fixed for the whole life of one
 *  RTCPeerConnection: a renegotiation and an ICE restart keep them (the ICE
 *  ufrag does NOT survive a restart, so it cannot be the key), while a peer
 *  that restarts its app or rebuilds its connection gets new ones. The pair is
 *  the key because a mobile stack may write `o=- 0 0` on every connection,
 *  and the fingerprint still tells two of those apart. Null when the SDP
 *  carries neither: then nothing can be told, and nothing is. */
export function remoteSessionOf(sdp: string | undefined): string | null {
  if (!sdp) return null
  const origin = /^o=\S+ (\S+) /m.exec(sdp)?.[1] ?? ""
  const fingerprint = /^a=fingerprint:(.+)$/m.exec(sdp)?.[1].trim().toUpperCase() ?? ""
  return origin || fingerprint ? `${origin}|${fingerprint}` : null
}

/** The label both stacks open the channel under. A mobile peer looks for this
 *  exact string, so it is wire, not a name we may pick freely. */
const DATA_CHANNEL_LABEL = "data"

/** Why a peer reads as away: it SAID so before it went, or its link has been
 *  down for AWAY_AFTER_MS and nothing answered. */
export type AwayReason = "said" | "timeout"

/** How long a link that was up may stay down before the peer reads as away.
 *  The supervisor lets a drop mend by itself for its disconnect grace and then
 *  tries a restart; 8 s covers that first try and the next backoff step, so a
 *  blip that ICE mends never flashes "Away", while a backgrounded phone (game
 *  160: gone for 100 s) shows within a few seconds of the link dropping. The
 *  supervisor sweeps every 3 s, so the mark lands between 8 and 11 s. */
export const AWAY_AFTER_MS = SUPERVISOR_TIMING.awayAfterMs

/** How many frames one peer's outbox holds while its channel is shut. A peer
 *  whose channel never opens must not grow without bound, and the oldest frame
 *  is the one to lose: a verdict is superseded by the next one on the same
 *  tile, so the newest bytes are the truest. */
const OUTBOX_MAX = 16

/** A channel message arrives as an ArrayBuffer, because `binaryType` is forced
 *  to "arraybuffer" on attach. A peer on another stack can still hand us a view
 *  over a buffer, so accept that too and give up on anything else (a string
 *  message is not ours). */
function asBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  return null
}

// ── the video we send ─────────────────────────────────────────────────────────
/**
 * The video codecs this side asks for, in order: H.264 first when this
 * browser can both send and receive it (hardware-decoded on phones, where VP8
 * is often software; packetization-mode=1 and constrained baseline 42e0… ahead,
 * the profile every hardware decoder takes), then every other codec. RTX stays
 * in only when `keepRtx` says this browser's engine is safe with it (#559,
 * rtxSafeEngine); otherwise every video/rtx entry is left out (#497).
 *
 * WHY NO RTX ON AN AFFECTED ENGINE: libwebrtc M111–M123 (webrtc:14795/14817,
 * fixed upstream in d440358, M124) answers an RTX packet that arrives before
 * any media packet by making a default receive stream for a dummy SSRC 14795
 * that claims the RTX SSRC. WebKit shipped those releases in iOS 17 (M115,
 * M120). The side that answers a lane offer starts sending the moment it sets
 * its answer, and its first packets are BWE probes on its RTX SSRC, while the
 * answer itself rides the data channel behind them. When the offerer then
 * applies the answer, the answer signals that RTX SSRC again and
 * setRemoteDescription fails with "Failed to add remote stream ssrc: <media
 * ssrc> to {mid: 1, media_type: video}": seen with an iOS 17.5 offerer, a link
 * dark for the whole round. Only the OFFERER is exposed, and an offer without
 * RTX cannot be answered with RTX, so an affected engine leaving RTX out of its
 * own list covers every link it is on, in either role.
 *
 * WHY RTX EVERYWHERE ELSE (#559): with RTX gone, NACK retransmissions and BWE
 * padding probes ride the media SSRC. In repeated test games on the same
 * simulated networks, links from a sender with 2 % loss went from about 46
 * NACKs and 0.6 s of freeze per link-round with RTX to 75–116 NACKs and
 * 3.8–7.1 s without it, and that sender's available outgoing bitrate fell by
 * about a third. Clean links never NACKed either way.
 */
export function videoCodecPreferences(recv: RTCRtpCodec[], send: RTCRtpCodec[] | null, keepRtx = false): RTCRtpCodec[] {
  const isH264 = (c: RTCRtpCodec) => c.mimeType.toLowerCase() === "video/h264"
  const sendable = new Set((send ?? []).filter(isH264).map((c) => `${c.clockRate}|${c.sdpFmtpLine ?? ""}`))
  const rank = (c: RTCRtpCodec) =>
    (/packetization-mode=1/.test(c.sdpFmtpLine ?? "") ? 0 : 1) + (/profile-level-id=42e0/.test(c.sdpFmtpLine ?? "") ? 0 : 2)
  const h264 = recv.filter((c) => isH264(c) && sendable.has(`${c.clockRate}|${c.sdpFmtpLine ?? ""}`)).sort((a, b) => rank(a) - rank(b))
  const rest = recv.filter((c) => !h264.includes(c))
  const ordered = [...h264, ...rest]
  return keepRtx ? ordered : ordered.filter((c) => c.mimeType.toLowerCase() !== "video/rtx")
}

/**
 * May this browser negotiate RTX (#559)? Only an engine KNOWN to carry
 * libwebrtc M124 or later: Chromium 124+ (Chrome, Android WebView), and
 * WebKit from iOS / Safari 18 (M126). Every iOS browser is WebKit, so the iOS
 * version decides before any Chrome token (CriOS). A WebKit engine
 * (navigator.vendor "Apple Computer, Inc.") is never judged by a Chrome token,
 * so a host that spoofs a desktop Chrome agent on an iPhone stays unsafe. iOS
 * and Safari 17 and older, Chromium 123 and older, and anything this cannot
 * read (Firefox, a macOS WKWebView with no Version token) keep the #497
 * behaviour and leave RTX out, which costs retransmission efficiency and
 * never a dark link.
 */
export function rtxSafeEngine(ua: string, vendor = ""): boolean {
  const ios = /\b(?:iPhone|iPad|iPod)\b[^)]*?\bOS (\d+)_/.exec(ua)
  if (ios) return Number(ios[1]) >= 18
  const webkit = vendor === "Apple Computer, Inc."
  const chromium = /\b(?:Chrome|Chromium)\/(\d+)\./.exec(ua)
  if (chromium && !webkit) return Number(chromium[1]) >= 124
  if (/\bMacintosh\b/.test(ua) && /\bSafari\//.test(ua)) {
    const safari = /\bVersion\/(\d+)\./.exec(ua)
    return safari !== null && Number(safari[1]) >= 18
  }
  return false
}

/** rtxSafeEngine for this page's own browser */
function thisEngineRtxSafe(): boolean {
  if (typeof navigator === "undefined") return false
  return rtxSafeEngine(navigator.userAgent ?? "", navigator.vendor ?? "")
}

/**
 * The SDP without its video RTX (#559): the guard for an engine whose codec
 * preferences did not hold. In each video section it drops the payload types
 * whose rtpmap is rtx (from the m= line and their rtpmap, fmtp and rtcp-fb
 * lines), every FID group, and the RTX SSRC each group named. Applied to a
 * fresh createOffer() before setLocalDescription, so the local description
 * and the one signalled are the same text.
 */
export function stripVideoRtx(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n"
  const lines = sdp.split(eol)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i]!.startsWith("m=")) {
      out.push(lines[i]!)
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && !lines[j]!.startsWith("m=")) j++
    const section = lines.slice(i, j)
    if (!section[0]!.startsWith("m=video ")) {
      out.push(...section)
      i = j
      continue
    }
    const rtx = new Set(section.flatMap((l) => /^a=rtpmap:(\d+) rtx\//i.exec(l)?.[1] ?? []))
    const rtxSsrcs = new Set(section.flatMap((l) => /^a=ssrc-group:FID \d+ (\d+)/.exec(l)?.[1] ?? []))
    for (const line of section) {
      if (line.startsWith("m=video ")) {
        const [m, port, proto, ...pts] = line.split(" ")
        out.push([m, port, proto, ...pts.filter((pt) => !rtx.has(pt))].join(" "))
        continue
      }
      const pt = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)[ ]/.exec(line)?.[1]
      if (pt && rtx.has(pt)) continue
      if (line.startsWith("a=ssrc-group:FID ")) continue
      const ssrc = /^a=ssrc:(\d+) /.exec(line)?.[1]
      if (ssrc && rtxSsrcs.has(ssrc)) continue
      out.push(line)
    }
    i = j
  }
  return out.join(eol)
}

/**
 * Does the far end's description send us video: a video section with a
 * non-zero port whose direction (the far end's own, sendrecv when absent) is
 * sendrecv or sendonly? Then a rollback of our own offer must not happen on
 * this connection. In libwebrtc (Chromium 153, WebKit 26.6)
 * rolling back a local offer on a connection with a negotiated video receiver
 * leaves that receiver decoding while no frame reaches its track: no new
 * `track` event, the same track live and unmuted, and neither a re-attach nor
 * a later renegotiation on that connection brings a frame back. A rollback
 * before any video is received (data channel only, a camera-less peer, a
 * recvonly answer) is harmless.
 */
export function receivesVideo(sdp: string | undefined): boolean {
  const sections = (sdp ?? "").split(/\r?\n(?=m=)/).filter((section) => section.startsWith("m=video "))
  return sections.some((section) => {
    if (section.split(" ")[1] === "0") return false
    const dir = /^a=(sendrecv|sendonly|recvonly|inactive)\s*$/m.exec(section)?.[1] ?? "sendrecv"
    return dir === "sendrecv" || dir === "sendonly"
  })
}

/** Does an SDP negotiate RTX? Logged beside each lane offer and answer, so a
 *  game log shows the #497 prevention live on the phone that wrote it. */
function rtxIn(sdp: string | undefined): "yes" | "no" {
  return sdp && /^a=rtpmap:\d+ rtx\//im.test(sdp) ? "yes" : "no"
}

/**
 * Set the video codecs (videoCodecPreferences: H.264 first, RTX only on a
 * safe engine). Says whether the preferences were set: "missing" (no
 * setCodecPreferences, or no capabilities to build them from) and "refused"
 * (it threw) leave the browser's defaults, RTX included.
 */
function setVideoCodecPreferences(pc: RTCPeerConnection, sender: RTCRtpSender): "set" | "missing" | "refused" {
  const transceiver = pc.getTransceivers().find((t) => t.sender === sender)
  const recv = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null
  const send = typeof RTCRtpSender !== "undefined" ? RTCRtpSender.getCapabilities?.("video") : null
  let prefs: "set" | "missing" | "refused" = "missing"
  if (transceiver && recv && typeof transceiver.setCodecPreferences === "function") {
    try {
      transceiver.setCodecPreferences(videoCodecPreferences(recv.codecs, send?.codecs ?? null, thisEngineRtxSafe()))
      prefs = "set"
    } catch (err) {
      prefs = "refused"
      rtcLog("[jollity-rtc] video codec preference refused", describeError(err))
    }
  } else {
    rtcLog(`[jollity-rtc] video codec preference not set (${!transceiver ? "no transceiver" : !recv ? "no capabilities" : "no setCodecPreferences"})`)
  }
  return prefs
}

/** Log all candidates + candidate-pairs of a failed PC (diagnostic), without
 *  their addresses. */
async function dumpStats(pc: RTCPeerConnection, peerId: string): Promise<void> {
  try {
    const stats = await pc.getStats()
    const cands = new Map<string, string>()
    stats.forEach((r) => {
      if (r.type === "local-candidate" || r.type === "remote-candidate") {
        // type and protocol only: the address and port are a co-player's IP
        // (or ours), which the debug log never holds (candidate-log.ts)
        const c = r as unknown as { id: string; candidateType?: string; protocol?: string }
        cands.set(c.id, `${r.type === "local-candidate" ? "L" : "R"}:${candidateForLog(c)}`)
        rtcLog("[jollity-rtc] stats cand", peerId, cands.get(r.id))
      }
    })
    stats.forEach((r) => {
      if (r.type === "candidate-pair") {
        const p = r as unknown as { state: string; nominated?: boolean; localCandidateId: string; remoteCandidateId: string; requestsSent?: number; responsesReceived?: number }
        rtcLog(
          "[jollity-rtc] stats pair", peerId, p.state, p.nominated ? "(nominated)" : "",
          cands.get(p.localCandidateId) ?? p.localCandidateId, "↔", cands.get(p.remoteCandidateId) ?? p.remoteCandidateId,
          `req ${p.requestsSent ?? 0}/resp ${p.responsesReceived ?? 0}`,
        )
      }
    })
  } catch (err) {
    rtcLog("[jollity-rtc] stats dump failed", peerId, describeError(err))
  }
}

// Non-trickle gather budget: how long to wait for ICE gathering to finish
// before sending the offer/answer. When it completes, every candidate is
// embedded in the SDP, so peers connect from ONE exchange instead of N
// individual candidate frames, which the signalling transport (the statement
// store) does not guarantee to deliver in order. Any stragglers gathered after
// this budget still trickle via `onicecandidate`.
const GATHER_TIMEOUT_MS = 750
// Relay only (path-mode.ts, a network that lets no UDP out) the wait is for
// the relay candidate instead, since one is all such a link can use. It goes
// RELAY_SETTLE_MS after the first relay is in, so its siblings ride the same
// description (on a relay-only test network four landed in ~130-170 ms, TCP
// pair then TLS pair, at most 40 ms apart) instead of a cand frame and one
// more submit, and
// waits up to RELAY_GATHER_TIMEOUT_MS for one: a TLS relay slower than 750 ms
// would otherwise trickle a statement-store hop behind its description.
const RELAY_GATHER_TIMEOUT_MS = 2_500
/** How long a peer's next description waits for its previous statement
 *  offer to be applied and answered (Mesh.onRtc): a
 *  setRemoteDescription or setLocalDescription that never settles holds the
 *  peer no longer than this. */
const ANSWER_SET_WAIT_MS = 2_500
const RELAY_SETTLE_MS = 50

// ── self-healing supervisor ──────────────────────────────────────────────────
// The mesh must be CONTINUOUS and ALWAYS TRYING: a peer that fails or drops must
// reconnect on its own, indefinitely. A periodic supervisor watches every peer
// and, for anyone not `connected`, escalates recovery — ICE restart for a
// recoverable `disconnected`, a full PC rebuild for `failed`/never-connected —
// with exponential backoff so it keeps trying without storming.
// The supervisor's thresholds live in supervisor-timing.ts, shared with the
// peer actor; each is documented there.
/** A hello or a signal this recent says the player is still here, so their
 *  link is worth healing. */
const PRESENCE_FRESH_MS = SUPERVISOR_TIMING.presenceFreshMs
/** An offer posted with a signal from the peer this recent was posted to a
 *  peer who was here (the signalling round trip's flag, #374). */
const PRESENT_WINDOW_MS = 30000
/** A link that dropped this recently is chased even before a hello says the
 *  player is still here. */
const DROP_CHASE_MS = SUPERVISOR_TIMING.dropChaseMs

// ── away (#229) ──────────────────────────────────────────────────────────────
// A peer is AWAY when it said so (a frame, away-frame.ts) or its link, once up,
// stayed down for AWAY_AFTER_MS. A peer that SAID so is not healed. One whose
// link timed out is healed for as long as it is still heard — a hello or a
// signal within PRESENCE_FRESH_MS — because a player whose hellos keep coming
// has not left: stopping there deadlocks both ends, each marking the other
// away and neither ever trying again (#245). Away clears on: the link reaching
// `connected`, a "back" frame, any incoming description, a player heard again
// after RETURN_GAP_MS, our page coming back (timeouts only), and the peer's
// removal. The UI reads it.

// ── media-flow watchdog ──────────────────────────────────────────────────────
// An established PC can read `connected` while inbound RTP silently stops — camera
// reclaimed by the OS, a NAT rebind blackholing the selected pair, or one media
// direction dying while STUN consent still passes. The self-heal supervisor only
// acts on NON-`connected` states, so without this a frozen-but-green tile ("we saw
// each other but no cameras") never recovers. We poll inbound `framesDecoded` on
// every `connected` peer and report each link's frames to its actor
// (stats-observed), which decides an ICE restart or a rebuild, bounded by a
// per-peer backoff so a genuinely-idle/backgrounded remote can't cause a storm.
const MEDIA_WATCH_MS = 4000 // media-flow sweep cadence
/** a link back up is looked at this soon for frames, outside the sweep */
const PROBE_AFTER_UP_MS = 1500
/** a link that never showed video: looked at on this many seat ticks in a row,
 *  then on every PROBE_SLOW_EVERY-th (probeStaleFrames) */
const PROBE_FAST_LOOKS = 5
const PROBE_SLOW_EVERY = 4
const FRAMES_STALL_SWEEPS = 2 // consecutive sweeps with no new frames ⇒ treat as blackhole
/** A PHONE BACK FROM THE BACKGROUND needs a keyframe before its video shows (iOS
 *  invalidates the VideoToolbox session, #557). Ours is forced on every video
 *  sender at the return; and for this long after our return, or after a peer's
 *  away flag clears, the media-stall heal may not escalate to an ICE restart:
 *  the keyframe is on its way, and a restart is heavy for a missing one. */
export const KEYFRAME_GRACE_MS = 2000
/** after forcing a keyframe, how long before outbound keyFramesEncoded is read */
const KEYFRAME_VERIFY_MS = 500
/** a return still without a new frame after this long is dropped, not timed (rtc.resume_ms) */
const RESUME_GIVE_UP_MS = 30_000
const MEDIA_HEAL_BACKOFF_MS = 12000 // min gap between media-stall ICE restarts per peer
/** ONE SIDE HEALS A STALL (otherwise both ends restart each other, every few
 *  seconds). The initiator goes first; the answerer waits this
 *  many sweeps instead, long enough for the initiator's restart to reach it as
 *  a lane offer, which starts its count over. A stall only the answerer sees
 *  (one direction dead) still gets healed, later. */
const ANSWERER_STALL_SWEEPS = 6
/** A fully open data link has had this long to negotiate and decode its first
 * video frame. Act one media sweep before the seat's reconnect budget, so the
 * rebuild starts without a boundary-dependent Can't connect flash. */
const CONNECTED_WITHOUT_VIDEO_MS = SEAT_TIMES.reconnectBudgetMs - MEDIA_WATCH_MS

// ── who sees whom (link-view.ts) ─────────────────────────────────────────────
// Each phone's view of the room goes to every peer each MEDIA_WATCH_MS: over
// the open data channels, and on the hello (useMesh → transport.setView). A
// peer's view saying it decodes none of our video, on a link we send video on,
// is the one-way failure our own inbound frames cannot show. Ordinarily the
// initiator restarts ICE for it once per unseen episode — the budget refills
// when the peer's view says it sees our video again (the actor's
// UNSEEN_ICE_RESTARTS); prior hard SDP refusal also authorizes one
// separately budgeted round-scoped escalation rebuild.
// A peer's word is weaker evidence than our own frames: iPhones have been seen
// saying it of links whose video flowed, and a rebuild each time, its budget
// starting over on every new link, cost every pair ~3 s each 40 s.
/** frames this recent on the current link: this phone sees the peer ('3') */
const VIEW_VIDEO_FRESH_MS = 10000
/** a peer's view older than this says nothing any more */
const VIEW_FRESH_MS = 12000
/** a peer must say it does not see us for this long before we act on it, and
 *  that it sees us again for this long before its unseen budget refills */
const VIEW_CONFIRM_MS = 8000
/** a link this young may not show video yet: its peer's view is not acted on */
const VIEW_LINK_GRACE_MS = 12000
/** One peer's latest view of the room. */
interface PeerView {
  row: string
  codes: Map<string, ViewCode>
  at: number
  /** since when its view says it does not decode our video; NEVER = it does */
  unseenSince: number
  /** since when its view says it decodes our video; NEVER = it does not */
  seenSince: number
}

/** Resolve once ICE gathering is `complete`, or after GATHER_TIMEOUT_MS —
 *  whichever comes first. Some networks / the host WebView never emit
 *  `complete`, so the timeout guarantees we still send the SDP with whatever
 *  we gathered. `relayOnly`: also RELAY_SETTLE_MS after the first relay
 *  candidate, the description's own included (a pooled one is gathered before
 *  it is made), and after RELAY_GATHER_TIMEOUT_MS at most. */
function waitIceGathering(pc: RTCPeerConnection, relayOnly: boolean): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    let settle: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(settle)
      pc.removeEventListener("icegatheringstatechange", onChange)
      pc.removeEventListener("icecandidate", onCandidate)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === "complete") finish()
    }
    const relayIn = () => {
      settle ??= setTimeout(finish, RELAY_SETTLE_MS)
    }
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate && candidateType(event.candidate) === "relay") relayIn()
    }
    const timer = setTimeout(finish, relayOnly ? RELAY_GATHER_TIMEOUT_MS : GATHER_TIMEOUT_MS)
    pc.addEventListener("icegatheringstatechange", onChange)
    if (!relayOnly) return
    pc.addEventListener("icecandidate", onCandidate)
    if (/ typ relay\b/.test(pc.localDescription?.sdp ?? "")) relayIn()
  })
}

interface Conn {
  pc: RTCPeerConnection
  /** Observer-only generation of this peer's physical connection. */
  decisionConnectionEpoch: number
  makingOffer: boolean
  ignoreOffer: boolean
  polite: boolean
  /** ICE candidates that arrived before the remote description (the
   *  signalling transport does not guarantee ordering) — flushed after SRD. */
  pendingCands: RTCIceCandidateInit[]
  /** the peer's data channel, or null until one is created or arrives. Held as
   *  the object, not a promise: `readyState` is the only readiness test, and a
   *  promise would outlive the PC it belongs to. */
  channel: RTCDataChannel | null
  /** frames waiting for a channel to open, oldest first. The channel arrives
   *  seconds after the peer does, and a verdict cast in that gap would
   *  otherwise be dropped. Carried across a rebuild — the peer is the same
   *  person — and dropped when the peer leaves. */
  outbox: Uint8Array<ArrayBuffer>[]
  // ── self-healing bookkeeping ──
  everConnected: boolean // has this peer ever reached `connected`?
  gaveEndpoint: boolean // have we received an SDP/ICE endpoint from them on the statement store?
  /** the selected pair's path while the link is up: read once it connects and
   *  again when the browser moves it to another pair (Mesh.readPath); unknown
   *  while it is down or the read has not landed */
  path: LinkPath
  /** the browser's pair-change event is watched for this connection */
  watchingPath: boolean
  lastSignalAt: number // monoNow() ms of the last inbound signal (liveness: is the peer here?)
  createdAt: number // monoNow() ms first added (carried across rebuilds)
  /** monoNow() ms the peer was first heard (a hello or a signal), carried across
   *  rebuilds: a link that never connected times out from here, not from
   *  createdAt, so a peer heard late is not counted late. NEVER = not yet. */
  firstHeardAt: number
  /** monoNow() ms the link went down after it had been up: the clock "away" reads.
   *  It is NOT disconnectedAt, which must restart whenever a restart flips the
   *  PC to `connecting` (that is the per-attempt grace). This one runs through
   *  those flips and through a rebuild, and clears only on `connected`.
   *  0 = up, or never up. */
  downAt: number
  /** the peer is not here (#229): it said so, or its link stayed down. While
   *  set, nothing heals the link; a "back", a fresh offer or a `connected`
   *  clears it. */
  away: AwayReason | null
  // ── media-flow watchdog (see MEDIA_WATCH_MS) ──
  framesSeen: number // last inbound framesDecoded observed (0 = none yet)
  framesStalls: number // consecutive media sweeps a `connected` peer delivered no new frames
  lastMediaHealAt: number // monoNow() ms of the last media-stall ICE restart (backoff)
  lastFrameAt: number // monoNow() ms inbound frames last advanced on this link (NEVER = not yet): our view's '3'
  upAt: number // monoNow() ms this link last reached `connected`; 0 = not connected now
  /** Diagnostics only (link_failed, issue #944); nothing heals or negotiates on them.
   *  iceDisconnectedAt: monoNow() ms this PC's ICE went `disconnected`, kept
   *  through a restart's `checking`, 0 once ICE connects again. lastUpAt: monoNow() ms this PC last
   *  reached `connected`, kept through the drop (upAt is not). lastPath: the
   *  last path read while up, kept through the drop (path is not).
   *  failReported: this outage's link_failed went out; cleared on `connected`. */
  iceDisconnectedAt: number
  lastUpAt: number
  lastPath: LinkPath
  failReported: boolean
  /** monoNow() ms the adopted data channel opened; the in-band media offer can
   * only start from here, so the no-video deadline is measured from it. */
  channelOpenAt: number
  /** a look at this link's frames outside the sweep is awaiting getStats (probeFrames) */
  probing?: boolean
  /** frame-count reads made on this link, and the latest one taken: a read that
   *  lands after a later one is dropped, since a lower count reads as a reset (readFrames) */
  framesReads: number
  framesTaken: number
  /** seat ticks in a row this link was due a look at its frames (probeStaleFrames) */
  staleLooks: number
  /** this connection's video receiver went to the SPS tap (#629): once per link */
  spsTapped?: boolean
  /** no media-stall heal before this monoNow() ms: a keyframe is on its way (KEYFRAME_GRACE_MS) */
  healHoldUntil: number
  /** #1917: inbound video packets received at the last media sweep (undefined:
   *  no reading, or the sweep before was held): whether the packets move */
  sweepPackets?: number
  /** #1917: monoNow() ms we last forced a keyframe on this link, for the
   *  peer's request or our own return: one per KEYFRAME_GRACE_MS */
  keyframeForcedAt?: number
  /** #1917: a peer-requested forceKeyframe is running on this link: a second
   *  must not overlap it on the same senders, however long it takes */
  keyframeServing?: boolean
  /** remote offers applied to this connection, statement and lane: an answer
   *  is dropped only when a newer offer landed while it gathered (sendStatementAnswer) */
  offersApplied: number
  /** the keyframe we forced at our last return, and whether it worked */
  keyframe?: Promise<NonNullable<ResumeEvent["keyframe"]>>
  /** a keyframe swap has taken the video track off the sender for a moment: addLocalTracks must not read it as free */
  swapping: boolean
  /** the sender our camera goes out on, once added. It may hold no track (a
   *  standby link, a keyframe swap), so it is what says our video is on */
  videoSender: RTCRtpSender | null
  /** a co-player of a LATER round, linked ahead (the game's session): our
   *  camera stays off `videoSender`, and their missing video is no stall */
  standby: boolean
  /** the return being timed on this link (rtc.resume_ms), read by the media sweep; null = none */
  resume: { side: ResumeEvent["side"]; startedAt: number; base: number } | null
  gather: GatherTracker // what this PC gathered
  /** private host addresses seen in this gathering; handed to useMesh only
   * when the gathering closes, so multiple interfaces do not look like
   * multiple network changes */
  localAddresses: Set<string>
  reportedLocalAddresses: string
  offer: OfferClock // the offer in flight, timed against its answer
  /** the candidate pool it was made with (path-mode.ts iceConfigFor): every
   *  later configuration repeats it, as a connection that has described
   *  itself refuses another (InvalidModificationError) and the rest with it */
  poolSize: number
  /** #1951: the configuration this connection was made with, which it
   *  gathered with, held a TURN server, and was relay only (credentials or a
   *  path mode that came later do not count) */
  turnConfigured: boolean
  relayOnly: boolean
}

/** Their video moved since we last looked: the decoded count grew, or went
 *  back to a new stream's own count with frames on it (a replaced stream starts
 *  from 0, and waiting for it to pass the old one's would read as frozen). */
function advanced(frames: number, seen: number): boolean {
  return frames > seen || (frames > 0 && frames < seen)
}

/** why a link that is not `connected` is being recovered */
function triggerOf(conn: Conn): HealTrigger {
  const st = conn.pc.connectionState
  return st === "failed" ? "failed" : st === "disconnected" ? "disconnected" : "never_connected"
}

const HARD_NEGOTIATION_ERRORS = new Set<NegotiationErrorEvent["name"]>([
  "InvalidAccessError",
  "InvalidStateError",
  "OperationError",
])

function hardNegotiationError(error: unknown): NegotiationErrorEvent["name"] | null {
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === "string" && HARD_NEGOTIATION_ERRORS.has(name as NegotiationErrorEvent["name"])
    ? (name as NegotiationErrorEvent["name"])
    : null
}

/** The actor's class of a rejected lane or statement SDP await. */
const sdpRejection = (error: unknown): "hard-sdp" | "other" => hardNegotiationError(error) ? "hard-sdp" : "other"

function negotiationReason(error: unknown): NegotiationErrorEvent["reason"] {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === "string" && /add remote stream ssrc/i.test(message) ? "ssrc-collision" : "other"
}

// The peer actor's commands carry no payload, so Mesh holds what each needs,
// per peer, from the fact that led to it.

/** The peer's latest remote description on the signalling wire, for the
 *  actor's set-remote-description. Once applied, `applied` is the offer's
 *  count on its connection (offersApplied), and the entry moves to the slot
 *  the send-answer reads, so a later frame cannot take its place. */
interface StatementInbound { desc: RTCSessionDescriptionInit; gen: string | undefined; applied?: number }
/** The same on the lane; `generation` is the round it arrived in. */
interface LaneInbound { type: "offer" | "answer"; sdp: string; generation: number }
/** A statement offer the old connection refused (InvalidAccessError): the
 *  actor's retry applies it to the connection rebuilt for it (`epoch` + 1). */
interface RefusedOffer { entry: StatementInbound; epoch: number }

/** A local SDP step's result, with the error of a refusal. */
type LocalStepResult = PeerCommandResult & { error?: unknown }

/** The codec guard of one lane offer: the actor's rollback runs the rollback,
 *  and its send-offer the stripped offer after it; `done` is whether the
 *  connection still holds that offer. */
interface CodecGuardWork {
  pc: RTCPeerConnection
  generation: number
  rollback?: Promise<PeerCommandResult>
  offered: boolean
  done: (current: boolean) => void
}

/** restart-ice's cause to the site it runs at (the actor's rejection rule reads it). */
const RESTART_SITES: Readonly<Record<string, PeerCommandSite>> = {
  "soft-disconnect": "supervisor-recovery",
  "media-stall": "media-stall",
  "peer-no-video": "peer-no-video",
  "network-change": "network-change",
}

export class Mesh {
  private conns = new Map<string, Conn>()
  // Per-peer state that must OUTLIVE a conn (survives removePeer + a fresh addPeer
  // on rejoin/rebuild): so a peer we've connected to before reads "reconnecting",
  // not "never connected", after a presence-TTL blip. The backoff is the
  // actor's (lib/state-machines/peer-actor.ts).
  private history = new Map<string, { everConnected: boolean; createdAt: number; firstHeardAt: number }>()
  /** First down transition in an established link's continuous recovery
   * episode. Unlike `downAt`, peer-back bookkeeping cannot renew this clock. */
  private recoveryStartedAt = new Map<string, number>()
  // Peers for which the ANSWERER (higher id) is allowed to offer. Normally only the
  // initiator (lower id) offers, but during recovery the answerer must be able to
  // drive a re-offer too — otherwise an asymmetric drop (initiator's PC still reads
  // "connected", so it won't re-offer) leaves the answerer's rebuilt PC inert until
  // the initiator's ICE consent finally times out (~30s). Survives rebuilds.
  private answererMayOffer = new Set<string>()
  /** the remote connections each peer has LEFT (remoteSessionOf), so a late
   *  description from one, which the store may still deliver after the new
   *  connection's, is dropped instead of tearing the fresh PC down again.
   *  A connection never comes back, so a peer's set is only ever trimmed. */
  private leftSessions = new Map<string, Set<string>>()
  private superviseTimer: ReturnType<typeof setInterval>
  private mediaTimer: ReturnType<typeof setInterval>
  private closed = false
  /** this phone is in the background: told to every peer, and to one whose
   *  channel opens later */
  private selfAway = false
  /** each peer's latest view of the room (link-view.ts), and ours as last shared */
  private views = new Map<string, PeerView>()
  /** when each peer's video last came through, on ANY link to them: a rebuild
   *  starts a new link with no frames, but the tile still shows their face, so
   *  what the seat says (seats()) must not start over with it */
  private videoAt = new Map<string, number>()
  /** who this mesh links to (setPeers): every co-player of the game's rounds
   *  still to play. null = whoever signals, as a room of one group always was */
  private roster: Set<string> | null = null
  /** the peers on standby (setPeers): the person's, so a rebuilt link keeps it */
  private standbyPeers = new Set<string>()
  /** Per-peer, per-round live proof markers. A rebuild cannot inflate counts. */
  private roundLinkProofs = new Set<string>()
  private round: number | null | undefined
  private roundGeneration = 0
  private decisionConnectionEpochs = new Map<string, number>()
  private ownRow = ""
  /** relay candidates already logged, "a|c" */
  private relayLogged = new Set<string>()
  /** when the mesh opened: the funnel's zero */
  private openedAt = monoNow()
  /** the funnel stages each peer has reached. Kept per mesh, not per conn, so a
   *  rebuilt peer does not stamp them again: the funnel is the FIRST time. */
  private reached = new Map<string, Set<FunnelStage>>()
  /** the self-heal attempts, per peer, across rebuilds (heal.ts) */
  private heal = new HealTracker(
    (peerId, event) => this.emit(peerId, { kind: "heal", ...event }),
    (peerId, event) => this.emit(peerId, { kind: "heal_episode", ...event }),
  )
  /** One diagnostic period per peer, deliberately outside Conn so rebuilds
   * carry it until the peer returns, leaves, or the room closes. */
  private awayPeriods = new AwayPeriods(
    (peerId, event) => this.emit(peerId, { kind: "away_period", ...event }),
    (peerId) => isInitiator(this.myId, peerId),
  )
  /** setAway(null) can hand its fact to the actor before mark-back executes;
   * retain the return cause and offerer across that command boundary. */
  private awayReturns = new Map<string, { cause: AwayReturn; offerer: AwayOfferer }>()
  /** Last selected relay path per peer, sampled by report(). Diagnostic only:
   *  it is never consulted by the supervisor or any negotiation path. */
  private latestRelayPath = new Map<string, HealCohortPath>()
  /** monoNow() ms of the last network change networkChanged() heard (browser
   *  or inferred); 0 = none yet. Diagnostic only: link_failed and heal_cohort. */
  private lastNetworkChangeAt = 0
  /** Correlates link failures that land within 250 ms. Its callbacks only log
   *  and emit telemetry; they cannot start, delay or suppress a heal. */
  private healCohort = new HealCohortTracker((peerId, event) => {
    devLog("rtc", "rtc.heal.cohort", {
      cohortSize: event.size,
      windowMs: event.windowMs,
      relayProtocol: event.relayProtocol,
      turnEndpointHost: event.turnEndpointHost,
      failKind: event.failKind,
      quietMs: event.quietMs,
      recoveryMs: event.recoveryMs,
      unrecovered: event.unrecovered,
      pageHidden: event.pageHidden,
      sinceNetChangeMs: event.sinceNetChangeMs,
    }, "warn")
    this.emit(peerId, { kind: "heal_cohort", ...event })
  })
  /** One serialization lane per sender. A keyframe toggle or track swap is one
   * transaction, so a rung write can never land in its vulnerable middle. */
  private senderWrites = new WeakMap<RTCRtpSender, Promise<void>>()
  private rungSettles = new Set<Promise<unknown>>()
  private currentVideoRung: VideoRung
  /** relay only: the transports the network check saw a relay answer on */
  private relayProtocols: readonly string[]
  private readonly actorGame: number
  /** The peer actors' runner. Every observed peer fact is dispatched to it
   *  and its commands are the only decisions Mesh acts on. */
  private readonly runner: PeerRoomRunner
  /** What the runner's actors did, written once at close. */
  private readonly actorSummary: PeerActorSummary
  /** what the actor's commands need and carry no payload for */
  private statementInbound = new Map<string, StatementInbound>()
  private laneInbound = new Map<string, LaneInbound>()
  private laneRemoteAnswerPending = new Set<Conn>()
  /** the applied offer each wire's send-answer answers */
  private statementAnswering = new Map<string, StatementInbound>()
  private laneAnswering = new Map<string, LaneInbound>()
  private refusedOffers = new Map<string, RefusedOffer>()
  /** the wire of the peer's latest description, for an ignore-offer's record */
  private lastWire = new Map<string, "statement" | "lane">()
  private codecGuards = new Map<string, CodecGuardWork>()
  /** each peer's awaited actor commands still running (settleActorWork) */
  private actorWork = new Map<string, Set<Promise<unknown>>>()
  /** each peer's statement offer being applied and answered, from its
   *  setRemoteDescription until its answer's setLocalDescription resolves
   *  (onRtc) */
  private answering = new Map<string, { conn: Conn; session: string | null; settle: () => void; settled: Promise<void> }>()
  /** each peer's statement answer being set: its connection and the remote
   *  session it is from, from its setRemoteDescription until that settles
   *  (#1615) */
  private answerSetting = new Map<string, { conn: Conn; session: string | null }>()
  /** connections the actor's close-connection closed as the room closed */
  private closedByActor = new WeakSet<Conn>()

  constructor(
    private myId: string,
    private local: MediaStream,
    private rtcConfig: RTCConfiguration,
    private signal: (to: string, data: RtcPayload) => void,
    private onStream: (peerId: string, stream: MediaStream) => void,
    private onState: (peerId: string, state: RTCPeerConnectionState) => void,
    private onMessage: (peerId: string, bytes: Uint8Array) => void,
    private opts: {
      /** a peer became away (with why) or came back (null) */
      onAway?: (peerId: string, away: AwayReason | null) => void
      /** the room's members, this phone included: the order the view rows
       *  (link-view.ts) are written in. Absent = no view is shared or read. */
      members?: string[]
      /** our view of the room, each MEDIA_WATCH_MS: the caller puts it on
       *  the hello (transport.setView), which arrives with the link down */
      onOwnView?: (row: string) => void
      /** everything the telemetry hears of a link, as one stream (rtc-events.ts) */
      onRtcEvent?: (peerId: string, event: RtcEvent) => void
      /** a link's first video receiver, synchronously in ontrack, before its
       *  first frame: the SPS tap's moment to attach (sps-tap.ts, #629) */
      tapVideo?: (peerId: string, receiver: RTCRtpReceiver) => void
      /** The page-owned rung inherited by new/rebuilt senders. */
      initialVideoRung?: VideoRung
      /** Every application result, including stable-signaling retries. */
      onVideoRungResult?: (result: VideoRungApplyResult) => void
      /** Roster growth can change aggregate capacity before the next stats tick. */
      onActiveVideoSendersChanged?: (count: number) => void
      /** a link's reading (Mesh.links) may have moved: added, their endpoint
       *  first heard, its state, its path, or gone. The waiting room's dots
       *  follow this, never a stats poll. */
      onLinkChange?: (peerId: string) => void
      /** A completed gathering's private/local address set. The caller owns
       * comparing it with the prior connection and deciding whether to rebuild. */
      onLocalAddresses?: (peerId: string, addresses: readonly string[]) => void
      /** relay only: the transports a relay answered on in the network
       *  check (PathProbe.relayProtocols), the TURN servers the links keep */
      relayProtocols?: readonly string[]
      /** Stable room identity: the actors' game, and the roster capture. */
      decisionRoom?: string
      /** useMesh lifecycle generation for this room instance. */
      decisionRoomEpoch?: number
    } = {},
  ) {
    this.currentVideoRung = opts.initialVideoRung ?? FULL_VIDEO_RUNG
    this.relayProtocols = opts.relayProtocols ?? []
    const game = /^g(\d+)$/.exec(opts.decisionRoom ?? "")
    this.actorGame = game ? Number(game[1]) : 0
    const summary = (this.actorSummary = new PeerActorSummary())
    this.runner = new PeerRoomRunner((peerId, command) => {
      summary.command(command.kind)
      return this.track(peerId, this.executePeerCommand(peerId, command))
    }, {
      // a completion's clock, which the actor times what it moves by, and
      // the attempt its commands carry (a rejected restart's or lane error's rebuild)
      clock: monoNow,
      onAccepted: (_peerId, event) => summary.accepted(event),
      onCompletion: (_peerId, completion) => summary.completion(completion),
      onIgnored: (_peerId, reason) => summary.ignored(reason),
      onError: (peerId, error) => {
        summary.error(error)
        rtcLog("[jollity-rtc] peer actor effect failed", peerId, describeError(error))
      },
    })
    if (this.relayOnly()) this.logIcePolicy()
    // self-healing: keep every present peer connected, indefinitely.
    this.superviseTimer = setInterval(() => this.supervise(), SUPERVISE_MS)
    // media watchdog: catch a `connected` peer whose video has silently stopped.
    this.mediaTimer = setInterval(() => void this.watchMedia(), MEDIA_WATCH_MS)
  }

  /** Stamp a raw peer fact and step the actor with it: its commands run
   *  (executePeerCommand) before this returns, or after the current program
   *  when an effect dispatched it. `_event` names the fact at its call site. */
  private observePeerInput(
    peerId: string,
    _event: string,
    conn: Conn,
    actorEvent: (roomEpoch: number, connectionEpoch: number) => PeerActorEvent,
  ): void {
    // Mesh's clock on every fact (a sweep, a network change and an ICE
    // policy change carry their own, one instant for every peer); the
    // commands carry it to their effects as the attempt's time
    const stamped = actorEvent(this.opts.decisionRoomEpoch ?? 0, conn.decisionConnectionEpoch)
    stamped.now ??= monoNow()
    this.runner.dispatch(peerId, stamped)
  }

  /** initiateStrandedPeer's guard: the connection is still this peer's and
   *  never took a description or made a channel. */
  private strandedEligible(peerId: string, conn: Conn): boolean {
    return this.conns.get(peerId) === conn && !conn.channel && !conn.pc.localDescription && !conn.pc.remoteDescription
  }

  /** Stamp a funnel stage for a peer, the first time only. An observer that
   *  throws must not break the mesh. */
  private markStage(peerId: string, stage: FunnelStage) {
    let seen = this.reached.get(peerId)
    if (!seen) this.reached.set(peerId, (seen = new Set()))
    if (seen.has(stage)) return
    seen.add(stage)
    const ms = monoNow() - this.openedAt
    if (stage === "first_frame") rtcLog(`[jollity-rtc] first video after ${Math.round(ms)}ms`, peerId)
    this.emit(peerId, { kind: "stage", stage, ms })
  }

  private markRoundLink(peerId: string, stage: "channel-open" | "first-video") {
    const key = `${this.roundGeneration}:${peerId}:${stage}`
    if (this.roundLinkProofs.has(key)) return
    this.roundLinkProofs.add(key)
    const round = this.round === null || this.round === undefined ? "none" : String(this.round + 1)
    rtcLog(`[jollity-rtc] round-link stage=${stage} round=${round} peer=${peerId}`)
  }

  /** Tell the observer; one that throws must not break the mesh. */
  private emit(peerId: string, event: RtcEvent) {
    safely(() => this.opts.onRtcEvent?.(peerId, event))
  }

  private reportLocalAddresses(peerId: string, conn: Conn): void {
    const addresses = [...conn.localAddresses].sort()
    const fingerprint = addresses.join("|")
    if (!fingerprint || fingerprint === conn.reportedLocalAddresses) return
    conn.reportedLocalAddresses = fingerprint
    safely(() => this.opts.onLocalAddresses?.(peerId, addresses))
  }

  private mutateSender<T>(sender: RTCRtpSender, write: (mutation: SenderMutation) => Promise<T>): Promise<T> {
    const prior = this.senderWrites.get(sender) ?? Promise.resolve()
    const mutation: SenderMutation = { cancelled: false }
    const deadline = monoNow() + SENDER_WRITE_TIMEOUT_MS
    const queued = prior.catch(() => undefined).then(() => {
      if (mutation.cancelled || monoNow() >= deadline) {
        mutation.cancelled = true
        throw new Error("sender write cancelled")
      }
      return write(mutation)
    })
    const next = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        mutation.cancelled = true
        reject(new Error(`sender write timed out after ${SENDER_WRITE_TIMEOUT_MS} ms`))
      }, SENDER_WRITE_TIMEOUT_MS)
      void queued.then(resolve, reject).finally(() => clearTimeout(timer))
    })
    this.senderWrites.set(
      sender,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  private settle<T>(promise: Promise<T>): Promise<T> {
    this.rungSettles.add(promise)
    void promise.finally(() => this.rungSettles.delete(promise)).catch(() => {})
    return promise
  }

  videoRung(): SendRungIndex {
    return this.currentVideoRung.index
  }

  hasLiveConnections(): boolean {
    for (const conn of this.conns.values()) if (conn.pc.connectionState === "connected") return true
    return false
  }

  async whenVideoRungSettled(): Promise<void> {
    while (this.rungSettles.size) await Promise.allSettled([...this.rungSettles])
  }

  async applyVideoRung(rung: VideoRung): Promise<VideoRungApplyResult> {
    this.currentVideoRung = rung
    const jobs: Promise<VideoRungSenderResult>[] = []
    for (const [peerId, conn] of this.conns) {
      for (const [index, sender] of conn.pc.getSenders().entries()) {
        if (sender.track?.kind !== "video") continue
        jobs.push(this.mutateSender(sender, (mutation) => this.applyCurrentVideoRung(`${peerId}:${index}`, sender, rung, mutation)))
      }
    }
    const pending = Promise.all(jobs).then((senders) => ({
      requested: rung.index,
      senders,
      uniform: senders.length > 0 && senders.every((sender) => sender.status === "applied"),
    }))
    const result = await this.settle(pending)
    safely(() => this.opts.onVideoRungResult?.(result))
    return result
  }

  private async applyCurrentVideoRung(id: string, sender: RTCRtpSender, rung: VideoRung, mutation: SenderMutation = { cancelled: false }): Promise<VideoRungSenderResult> {
    const settings = sender.track?.getSettings?.()
    const width = settings?.width
    const height = settings?.height
    const scale =
      Number.isFinite(width) && Number.isFinite(height)
        ? Math.max(1, Math.min(width as number, height as number) / rung.targetShortSide)
        : undefined
    const requested: VideoRungField[] = ["maxBitrate", ...(scale === undefined ? [] : (["scaleResolutionDownBy"] as const)), "maxFramerate"]
    const refused = new Set<VideoRungField>()

    const write = async (fields: readonly VideoRungField[]) => {
      if (mutation.cancelled) throw new Error("sender write cancelled")
      const params = sender.getParameters()
      const encoding = params.encodings?.[0]
      if (!encoding) return false
      const alreadyMatches = fields.every((field) => {
        if (field === "maxBitrate") return encoding.maxBitrate === rung.maxBitrate
        if (field === "maxFramerate") return encoding.maxFramerate === rung.maxFramerate
        return encoding.scaleResolutionDownBy === scale
      })
      if (alreadyMatches) return true
      if (fields.includes("maxBitrate")) encoding.maxBitrate = rung.maxBitrate
      if (fields.includes("scaleResolutionDownBy") && scale !== undefined) encoding.scaleResolutionDownBy = scale
      if (fields.includes("maxFramerate")) encoding.maxFramerate = rung.maxFramerate
      if (mutation.cancelled) throw new Error("sender write cancelled")
      await sender.setParameters(params)
      if (mutation.cancelled) {
        // This is a late repair, not a new requested transition. Bypass the
        // cancellable mutation lane: if that lane is blocked, queueing the
        // repair can leave this sender permanently on the stale rung.
        void this.applyCurrentVideoRung(`${id}:timeout-reconcile`, sender, this.currentVideoRung).catch(() => {})
        throw new Error("sender write cancelled")
      }
      return true
    }

    const attempts: readonly VideoRungField[][] = [requested, requested.filter((field) => field !== "maxFramerate"), ["maxBitrate"]]
    let wrote = false
    for (const [index, fields] of attempts.entries()) {
      try {
        if (!(await write(fields))) return { id, status: "pending", appliedFields: [], refusedFields: [...refused] }
        wrote = true
        break
      } catch {
        if (mutation.cancelled) throw new Error("sender write cancelled")
        if (index === 0) refused.add("maxFramerate")
        if (index === 1 && scale !== undefined) refused.add("scaleResolutionDownBy")
        if (index === attempts.length - 1) refused.add("maxBitrate")
      }
    }
    if (!wrote) return { id, status: "refused", appliedFields: [], refusedFields: [...refused] }

    const read = sender.getParameters().encodings?.[0]
    if (!read) return { id, status: "pending", appliedFields: [], refusedFields: [...refused] }
    const appliedFields = requested.filter((field) => {
      if (field === "maxBitrate") return read.maxBitrate === rung.maxBitrate
      if (field === "maxFramerate") return read.maxFramerate === rung.maxFramerate
      return read.scaleResolutionDownBy === scale
    })
    for (const field of requested) if (!appliedFields.includes(field)) refused.add(field)
    const status = appliedFields.length === requested.length ? "applied" : appliedFields.includes("maxBitrate") ? "partial" : "refused"
    return {
      id,
      status,
      appliedFields,
      refusedFields: [...refused],
      readBack: {
        maxBitrate: read.maxBitrate,
        scaleResolutionDownBy: read.scaleResolutionDownBy,
        maxFramerate: read.maxFramerate,
      },
    }
  }

  /** A video sender's codecs (setVideoCodecPreferences) and the current rung
   *  of the upload ladder (bitrate, frame rate, size). The rung waits for
   *  negotiation to settle: Safari has no encodings to set before. */
  private tuneVideoSender(peerId: string, pc: RTCPeerConnection, sender: RTCRtpSender): "set" | "missing" | "refused" {
    const prefs = setVideoCodecPreferences(pc, sender)
    const apply = () => {
      if (pc.signalingState !== "stable") return
      const pending = this.mutateSender(sender, (mutation) => this.applyCurrentVideoRung(peerId, sender, this.currentVideoRung, mutation)).then((one) => {
        const result: VideoRungApplyResult = { requested: this.currentVideoRung.index, senders: [one], uniform: one.status === "applied" }
        safely(() => this.opts.onVideoRungResult?.(result))
        return one
      })
      this.settle(pending).catch((err) => rtcLog("[jollity-rtc] video rung refused", describeError(err)))
    }
    pc.addEventListener("signalingstatechange", apply)
    apply()
    return prefs
  }

  /** an answer was applied: the offer's round trip, once */
  private answered(peerId: string, conn: Conn) {
    const rtt = conn.offer.answered(monoNow())
    if (rtt) this.emit(peerId, { kind: "signal_rtt", ...rtt })
  }

  /** Is this side allowed to offer to `peerId`? Normally the lower id alone
   *  offers (glare-free); a peer under recovery grants the answerer the same
   *  right. The data channel and `onnegotiationneeded` must read the SAME answer:
   *  an offer with no channel on it leaves the peer without one. */
  private mayOffer(peerId: string): boolean {
    return isInitiator(this.myId, peerId) || this.answererMayOffer.has(peerId)
  }

  /** Publish a statement-wire offer. Recovery calls this directly after it
   * creates a replacement channel: once an answer has established the SCTP
   * application section, browsers do not emit negotiationneeded for another
   * in-band channel. Initial negotiation and ICE restarts enter through the
   * event handler installed by addPeer. */
  private async offerOnStatement(peerId: string, conn: Conn): Promise<void> {
    const { pc } = conn
    // Only the lower id offers initially; recovery can grant the answerer the
    // same right. Ignore duplicate browser events while a direct recovery offer
    // is already being made, or while perfect negotiation is not stable.
    if (!this.mayOffer(peerId) || conn.makingOffer || pc.signalingState !== "stable") return
    const lane = this.laneOpen(conn)
    this.observePeerInput(peerId, lane ? "lane-offer-requested" : "statement-offer-requested", conn, (roomEpoch, connectionEpoch) => ({
      type: "local-offer-requested",
      lane,
      roomEpoch,
      connectionEpoch,
    }))
    // the actor's send-offer makes the offer (executePeerCommand)
    return this.settleActorWork(peerId)
  }

  /** Our offer on the signalling wire: set, gathered, then sent if the
   *  connection still holds it. The actor's send-offer. */
  private async makeStatementOffer(peerId: string, conn: Conn): Promise<PeerCommandResult> {
    const { pc } = conn
    try {
      conn.makingOffer = true
      await pc.setLocalDescription()
      await waitIceGathering(pc, this.relayOnly()) // non-trickle: bundle candidates into the offer
      // A colliding remote offer may have been rolled in during the gather
      // wait (glare). Also bail if a concurrent self-heal replaced this PC.
      const current = this.conns.get(peerId)
      if (current?.pc !== pc || current.pc.signalingState !== "have-local-offer") {
        return { outcome: "stale" }
      }
      rtcLog("[jollity-rtc] → offer to", peerId)
      this.signal(peerId, { rtc: { desc: pc.localDescription! } })
      const sentAt = monoNow()
      conn.offer.sent("statement", sentAt, sentAt - conn.lastSignalAt < PRESENT_WINDOW_MS)
      this.markStage(peerId, "offer")
      return { outcome: "resolved", offer: "sent-statement" }
    } catch (err) {
      rtcLog("[jollity-rtc] negotiation failed", peerId, describeError(err))
      return { outcome: "rejected", site: "statement-offer-sent", reason: sdpRejection(err) }
    } finally {
      conn.makingOffer = false
    }
  }

  /** The same roster can keep one Mesh across rounds. Recovery budgets are
   *  round-scoped even when its RTCPeerConnections are not. */
  setRound(round: number | null): void {
    if (this.round === round) return
    this.round = round
    this.roundGeneration++
    for (const [peerId, conn] of this.conns) {
      this.observePeerInput(peerId, "round-changed", conn, (roomEpoch, connectionEpoch) => ({ type: "round-changed", roundGeneration: this.roundGeneration, roomEpoch, connectionEpoch }))
    }
    this.roundLinkProofs.clear()
    for (const [peerId, conn] of this.conns) if (this.laneOpen(conn)) this.markRoundLink(peerId, "channel-open")
  }

  addPeer(peerId: string, initiate = true, replacedExternally = false) {
    if (this.conns.has(peerId)) return
    if (this.roster && !this.roster.has(peerId)) return // no round of the game left with them
    let pc: RTCPeerConnection
    const config = this.pcConfig()
    const serverCounts = iceServerCounts(config)
    rtcLog(
      "[jollity-rtc] PC constructor configuration",
      `ice_servers=${serverCounts.total}`,
      `turn_servers=${serverCounts.turn}`,
    )
    try {
      pc = new PC(config)
      registerPagePeerConnection(pc)
    } catch (err) {
      rtcLog("[jollity-rtc] PC construct FAILED for", peerId, describeError(err))
      this.onState(peerId, "failed")
      return
    }
    rtcLog("[jollity-rtc] addPeer", peerId, isInitiator(this.myId, peerId) ? "(initiator)" : "(answerer)")
    const returnCandidateProbe = takeReturnCandidateProbe(peerId)
    const now = monoNow()
    const hist = this.history.get(peerId) // restore across-conn state on rejoin/rebuild
    const conn: Conn = {
      decisionConnectionEpoch: (this.decisionConnectionEpochs.get(peerId) ?? 0) + 1,
      // The ANSWERER (higher id) is polite → it yields to the initiator's offers.
      // The INITIATOR (lower id) is impolite → it keeps its own offer and, when it
      // isn't offering, accepts the answerer's recovery offer. The other way round,
      // the answerer would ignore the initiator's re-offers and the link deadlocks.
      pc, makingOffer: false, ignoreOffer: false, polite: this.myId > peerId, pendingCands: [],
      channel: null,
      outbox: [],
      everConnected: hist?.everConnected ?? false,
      gaveEndpoint: false, // endpoint is per-session — a fresh PC needs a fresh SDP/ICE
      path: "unknown", watchingPath: false,
      lastSignalAt: NEVER,
      createdAt: hist?.createdAt ?? now,
      firstHeardAt: hist?.firstHeardAt ?? NEVER,
      downAt: 0,
      away: null,
      framesSeen: 0, framesStalls: 0, lastMediaHealAt: NEVER, lastFrameAt: NEVER, framesReads: 0, framesTaken: 0, staleLooks: 0, upAt: 0, channelOpenAt: 0, healHoldUntil: 0, offersApplied: 0, swapping: false, resume: null,
      iceDisconnectedAt: 0, lastUpAt: 0, lastPath: "unknown", failReported: false,
      videoSender: null, standby: this.standbyPeers.has(peerId),
      gather: new GatherTracker(), localAddresses: new Set(), reportedLocalAddresses: "", offer: new OfferClock(),
      poolSize: config.iceCandidatePoolSize ?? 0,
      turnConfigured: serverCounts.turn > 0,
      relayOnly: config.iceTransportPolicy === "relay",
    }
    this.decisionConnectionEpochs.set(peerId, conn.decisionConnectionEpoch)
    this.conns.set(peerId, conn)
    this.opts.onLinkChange?.(peerId)
    // A connection Mesh replaced itself (rebuildPeer's `external`): the actor
    // adopts it, before anything is stamped on the fresh connection.
    if (replacedExternally) this.tellReplacedExternally(peerId, conn)
    this.startActor(peerId, conn)
    // A peer first met while this page is in the background: its actor starts hidden too.
    if (!hist && this.selfAway) {
      this.observePeerInput(peerId, "visibility-changed", conn, (roomEpoch, connectionEpoch) => ({ type: "visibility-changed", hidden: true, roomEpoch, connectionEpoch }))
    }
    this.notifyActiveVideoSendersChanged()

    // The channel must exist BEFORE anything can offer, so the offer carries the
    // application m-line — the ONLY m-line the signalling wire can carry, and the
    // one a mobile peer expects to find. Only the side that offers creates one: a
    // channel opened on the answering side is negotiated as well, as a SECOND
    // channel, and then the two peers hold a different one each. `ondatachannel`
    // below adopts the offerer's, which is the one both sides then read.
    // NO TRACKS YET: media is added when the channel opens (see attachChannel).
    if (initiate) this.createOfferChannel(peerId, conn)

    pc.onnegotiationneeded = () => this.offerOnStatement(peerId, conn)
    // #1951: the actor's gathering-stall clock starts with both descriptions
    // in. Ours is told on every signalling change that has one; the actor
    // keeps the first, so one it dropped (an older connection) is told again
    pc.onsignalingstatechange = () => {
      if (!pc.localDescription || pc.signalingState === "closed") return
      this.observePeerInput(peerId, "local-description-set", conn, (roomEpoch, connectionEpoch) => ({ type: "local-description-set", roomEpoch, connectionEpoch }))
    }
    pc.onicecandidate = ({ candidate }) => {
      // `type` is host | srflx (STUN worked) | relay (TURN worked); null = end of gathering.
      // No relay candidates here ⇒ the TURN server is unreachable/dead.
      rtcLog("[jollity-rtc] local cand →", peerId, candidateForLog(candidate))
      if (!candidate) {
        this.reportLocalAddresses(peerId, conn)
        return
      }
      returnCandidateProbe?.candidate()
      conn.gather.startIfIdle(monoNow()) // a browser that sends no `gathering` state first
      conn.gather.add(candidate)
      if (candidateType(candidate) === "host") {
        const address = candidate.address ?? /\bcandidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ host\b/i.exec(candidate.candidate)?.[1]
        // Safari and Chromium may expose randomized mDNS names and temporary
        // IPv6 privacy addresses. Neither is stable network-transition
        // evidence, so only numeric IPv4 participates in the fingerprint.
        if (address && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address))
          conn.localAddresses.add(address)
      }
      // a straggler of the first negotiation goes where the offer went; a
      // candidate of an in-band ICE restart follows its offer down the lane
      if (this.laneOpen(conn)) {
        this.sendLane(peerId, conn, {
          tag: "IceCandidates",
          value: [{ sdp: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex ?? 0, sdpMid: candidate.sdpMid ?? undefined }],
        })
      } else this.signal(peerId, { rtc: { cand: candidate.toJSON() } })
    }
    pc.onicegatheringstatechange = () => {
      rtcLog("[jollity-rtc] gathering", peerId, pc.iceGatheringState)
      if (pc.iceGatheringState === "gathering") {
        conn.gather.restart(monoNow()) // the first, or an ICE restart's: counts afresh
        conn.localAddresses.clear()
      }
      else if (pc.iceGatheringState === "complete") {
        const gathered = conn.gather.complete(monoNow())
        if (gathered) this.emit(peerId, { kind: "gather", ...gathered })
        this.reportLocalAddresses(peerId, conn)
      }
    }
    // 701 = the TURN server could not be reached. The url goes no further than its host.
    pc.onicecandidateerror = (event) => {
      const error = iceErrorInfo(event as { errorCode?: number; url?: string })
      rtcLog("[jollity-rtc] ice candidate error", peerId, error.code, error.host)
      conn.gather.addError(error)
      this.emit(peerId, { kind: "ice_error", ...error })
    }
    pc.oniceconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === "connected" || state === "disconnected" || state === "failed") {
        this.observePeerInput(peerId, "ice-state-observed", conn, (roomEpoch, connectionEpoch) => ({
          type: "connection-observed", state, roomEpoch, connectionEpoch,
        }))
      }
      rtcLog("[jollity-rtc] ice", peerId, pc.iceConnectionState)
      if (pc.iceConnectionState === "checking") this.markStage(peerId, "ice_checking")
      // when ICE went quiet: link_failed tells a torn-down transport from a timeout
      // by it. It runs on through an ICE restart's `checking`, so a restart that
      // then fails still counts from the drop, and clears only once ICE is back.
      if (pc.iceConnectionState === "disconnected") conn.iceDisconnectedAt ||= monoNow()
      else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") conn.iceDisconnectedAt = 0
    }
    pc.ondatachannel = ({ channel }) => {
      if (this.conns.get(peerId) !== conn) return // this PC was rebuilt while the channel arrived
      // Both sides can offer during recovery, so both can arrive holding a
      // channel of their own. The LOWER id's channel is the one both peers keep:
      // if each side simply took the other's, the two would end up on different
      // channels and neither would be read. So the higher id yields its own —
      // and the lower id keeps its own only while it still has one to keep.
      const held = conn.channel
      if (this.myId < peerId && held && held.readyState !== "closed") {
        channel.close()
        return
      }
      this.attachChannel(peerId, conn, channel)
    }
    pc.ontrack = ({ track, streams, receiver }) => {
      rtcLog("[jollity-rtc] ← track from", peerId, "streams:", streams.length)
      const tapVideo = this.opts.tapVideo
      if (tapVideo && track.kind === "video" && receiver && !conn.spsTapped) {
        conn.spsTapped = true
        safely(() => tapVideo(peerId, receiver))
      }
      // a new track unmutes on its first packets: their video is back now,
      // not at the next frame sweep up to MEDIA_WATCH_MS later
      if (track.kind === "video") {
        track.addEventListener("unmute", () => {
          if (!this.closed && this.conns.get(peerId) === conn) this.videoAt.set(peerId, monoNow())
        })
      }
      if (streams[0]) this.onStream(peerId, streams[0])
    }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st !== "closed") {
        this.observePeerInput(peerId, "connection-observed", conn, (roomEpoch, connectionEpoch) => ({
          type: "connection-observed",
          state: st,
          roomEpoch,
          connectionEpoch,
        }))
      }
      rtcLog("[jollity-rtc] pc", peerId, st)
      if (st !== "connected") {
        conn.upAt = 0
        conn.channelOpenAt = 0
        conn.path = "unknown"
      } else if (!conn.upAt) {
        const now = monoNow()
        conn.upAt = now
        conn.lastUpAt = now
        // An ICE restart keeps an open data channel, whose `open` event does
        // not fire again. Start a fresh media grace window from this recovery.
        if (this.laneOpen(conn)) conn.channelOpenAt = now
      }
      if (st === "connected") {
        const now = monoNow()
        this.markStage(peerId, "connected")
        this.heal.connected(peerId, now)
        this.healCohort.recovered(peerId, now)
        conn.everConnected = true
        conn.failReported = false
        conn.downAt = 0
        this.recoveryStartedAt.delete(peerId)
        this.setAway(peerId, conn, null, "link_connected", offererOfLocal(pc.currentLocalDescription?.type)) // the ONE place a returning link clears away
        conn.framesStalls = 0
        // Healthy again → drop the recovery-only permission so we return to the
        // glare-free initiator-only model. Left set, every future renegotiation
        // would fire offers on BOTH sides → a needless glare cycle each time.
        this.answererMayOffer.delete(peerId)
        // a link back up: look for their frames shortly, so a face that is
        // back sheds its grain at once rather than at the next frame sweep
        setTimeout(() => void this.probeFrames(peerId, conn), PROBE_AFTER_UP_MS)
        void this.readPath(peerId, conn)
        this.watchPath(peerId, conn)
      } else if (st === "disconnected") {
        const now = monoNow()
        if (!conn.downAt && conn.everConnected) conn.downAt = now
        if (conn.everConnected && !this.recoveryStartedAt.has(peerId)) this.recoveryStartedAt.set(peerId, now)
      } else if (st === "failed") {
        const now = monoNow()
        if (!conn.downAt && conn.everConnected) conn.downAt = now
        if (conn.everConnected && !this.recoveryStartedAt.has(peerId)) this.recoveryStartedAt.set(peerId, now)
        if (conn.everConnected) {
          const failure = this.linkFailure(peerId, conn, now)
          this.healCohort.failed(peerId, now, failure)
          // once per outage, and only for a connection that was up: a rebuilt
          // PC that never connected is a failed reconnect, not a link that died
          if (conn.lastUpAt && !conn.failReported) {
            conn.failReported = true
            this.emit(peerId, { kind: "link_failed", ...failure })
          }
        }
        // On failure, dump every candidate + pair so the log shows WHY no pair
        // connected; the supervisor will then rebuild this peer.
        void dumpStats(pc, peerId)
      }
      this.opts.onLinkChange?.(peerId)
      this.onState(peerId, st)
      this.notifyActiveVideoSendersChanged()
    }
  }

  /** The selected pair's path, read once (one getStats) while the link is up.
   *  A read that fails or finds no pair reads direct, as the report does. */
  private async readPath(peerId: string, conn: Conn) {
    let path: LinkPath = "direct"
    try {
      const quality = readStats(await conn.pc.getStats(), this.linkOf(conn.pc)).quality
      if (quality) path = pathOf(quality)
    } catch {
      /* getStats unavailable */
    }
    this.takePath(peerId, conn, path)
  }

  /** a path read for a link still up, said only when it moved */
  private takePath(peerId: string, conn: Conn, path: LinkPath) {
    if (this.closed || this.conns.get(peerId) !== conn || conn.pc.connectionState !== "connected" || conn.path === path) return
    conn.path = path
    if (path !== "unknown") conn.lastPath = path
    this.opts.onLinkChange?.(peerId)
  }

  /** What is known of an established link at its `failed` (diagnostic only). */
  private linkFailure(peerId: string, conn: Conn, now: number): LinkFailure {
    const quietMs = conn.iceDisconnectedAt ? Math.max(0, now - conn.iceDisconnectedAt) : 0
    const relay = this.latestRelayPath.get(peerId)
    return {
      failKind: linkFailKind(quietMs),
      quietMs,
      upMs: conn.lastUpAt ? Math.max(0, now - conn.lastUpAt) : 0,
      path: relay ? "relay" : conn.lastPath,
      ...relay,
      pageHidden: pageHidden(),
      ...(this.lastNetworkChangeAt ? { sinceNetChangeMs: Math.max(0, now - this.lastNetworkChangeAt) } : {}),
    }
  }

  /** The browser's word that the link moved to another candidate pair, where
   *  it gives one (not every engine does; Mesh.report catches the rest). */
  private watchPath(peerId: string, conn: Conn) {
    if (conn.watchingPath) return
    let ice: RTCIceTransport | undefined
    try {
      ice = conn.pc.sctp?.transport.iceTransport ?? conn.pc.getSenders().find((sender) => sender.transport)?.transport?.iceTransport
    } catch {
      /* no transport to watch */
    }
    if (!ice || !("onselectedcandidatepairchange" in ice)) return
    conn.watchingPath = true
    ice.addEventListener("selectedcandidatepairchange", () => void this.readPath(peerId, conn))
  }

  // ── the data channel ────────────────────────────────────────────────────────
  /** Hold `channel` as the peer's channel, releasing any earlier one. */
  private attachChannel(peerId: string, conn: Conn, channel: RTCDataChannel) {
    const previous = conn.channel
    conn.channel = channel
    // The one we let go never carried a frame the caller saw, so retire it
    // silently — its handlers would otherwise log a close beside the new open.
    if (previous && previous !== channel) {
      previous.onopen = previous.onclose = previous.onmessage = null
      previous.close()
    }
    // Without this a browser that defaults to "blob" hands the message handler
    // something it cannot read synchronously.
    channel.binaryType = "arraybuffer"
    const announce = () => {
      if (!this.closed && this.conns.get(peerId) === conn && conn.channel === channel) {
        this.observePeerInput(peerId, "channel-observed", conn, (roomEpoch, connectionEpoch) => ({
          type: "channel-observed",
          state: "open",
          roomEpoch,
          connectionEpoch,
        }))
      }
      if (conn.channel !== channel) return // yielded to a newer channel while opening
      rtcLog("[jollity-rtc] channel open", peerId)
      conn.channelOpenAt = monoNow()
      this.markRoundLink(peerId, "channel-open")
      // This is the ONE place a channel becomes usable, so it is the one place
      // the waiting frames can leave.
      this.flushOutbox(peerId, conn, channel)
      // and the one place media starts: both sides add their tracks now, and
      // the offerer's onnegotiationneeded carries them down the lane. The
      // answerer's addTrack fires onnegotiationneeded too, gated off by
      // mayOffer; its tracks ride its answer instead. `open` is dispatched
      // before any `message`, so the answerer's transceivers exist before the
      // offerer's lane offer is read.
      this.addLocalTracks(conn)
      // a channel that opens while we are in the background still hears it
      if (this.selfAway) this.write(peerId, channel, encodeAway(true))
      // and what we see of the room, without waiting for the next sweep
      if (this.ownRow) this.write(peerId, channel, encodeViewFrame(this.ownRow))
    }
    if (channel.readyState === "open") announce()
    else channel.onopen = announce
    channel.onclose = () => {
      if (!this.closed && this.conns.get(peerId) === conn && conn.channel === channel) {
        this.observePeerInput(peerId, "channel-observed", conn, (roomEpoch, connectionEpoch) => ({
          type: "channel-observed",
          state: "closed",
          roomEpoch,
          connectionEpoch,
        }))
      }
      rtcLog("[jollity-rtc] channel close", peerId)
    }
    channel.onmessage = ({ data }) => {
      const bytes = asBytes(data)
      if (!bytes) return
      // the renegotiation lane is the mesh's own; everything else is the caller's
      let frame: { id: string; data: Uint8Array } | undefined
      try {
        frame = decodeChannelMessage(bytes)
      } catch {
        /* not a mux frame — the caller decides what it is */
      }
      if (frame?.id === USE_CASE_RENEGOTIATION) {
        void this.onLane(peerId, conn, frame.data)
        return
      }
      if (frame?.id === USE_CASE_KEYFRAME_REQUEST) {
        this.onKeyframeRequest(peerId, conn)
        return
      }
      const view = decodeViewFrame(bytes)
      if (view !== null) {
        this.onPeerView(peerId, view)
        return
      }
      const away = decodeAway(bytes)
      if (away !== null) {
        if (away) this.setAway(peerId, conn, "said")
        else this.setAway(peerId, conn, null, "said_back")
        return
      }
      this.onMessage(peerId, bytes)
    }
  }

  // ── away ────────────────────────────────────────────────────────────────────
  /** Mark the peer away (with why) or back (null). Idempotent: the caller hears
   *  only a change. Coming back lets the supervisor act on the very next sweep
   *  with a fresh budget, since the failures it counted were against a phone
   *  that was not there. */
  private setAway(peerId: string, conn: Conn, away: AwayReason): void
  private setAway(peerId: string, conn: Conn, away: null, cause: AwayReturn, offerer?: AwayOfferer): void
  private setAway(peerId: string, conn: Conn, away: AwayReason | null, cause?: AwayReturn, offerer: AwayOfferer = "none") {
    if (conn.away === away) return
    const ending = away === null ? { cause: cause ?? "said_back", offerer } : null
    if (ending) this.awayReturns.set(peerId, ending)
    this.observePeerInput(peerId, "peer-away", conn, (roomEpoch, connectionEpoch) => ({
      type: "peer-away",
      away: away ?? "back",
      roomEpoch,
      connectionEpoch,
    }))
    if (away === null) {
      // the actor's mark-back clears the mark (executePeerCommand); a fact
      // the actor did not take (it is on another connection) leaves it, so
      // Mesh clears it itself: a peer is never left shown away
      if (conn.away !== null) this.markBack(peerId, conn, ending!.cause, ending!.offerer)
      return
    }
    conn.away = away
    rtcLog("[jollity-rtc] peer away", peerId, away)
    conn.resume = null // an away peer shows no frames: stop timing the last return
    this.awayPeriods.mark(peerId, away, monoNow())
    this.opts.onAway?.(peerId, away)
  }

  /** setAway(null)'s effect: the peer is shown back. A removal, a rebuild
   *  and a sweep run it themselves, as part of their own command. */
  private markBack(peerId: string, conn: Conn, cause: AwayReturn, offerer: AwayOfferer = "none") {
    const was = conn.away
    if (was === null) return
    conn.away = null
    this.awayReturns.delete(peerId)
    this.awayPeriods.end(peerId, cause, offerer, monoNow())
    rtcLog("[jollity-rtc] peer back", peerId)
    if (was === "said") {
      // their encoder restarts on its own return; give its keyframe a moment before a heal, and time it
      const now = monoNow()
      conn.healHoldUntil = now + KEYFRAME_GRACE_MS
      this.startResume(conn, "peer", now)
    }
    if (conn.downAt) conn.downAt = monoNow() // a link still down gets a fresh budget before it reads away again
    this.opts.onAway?.(peerId, null)
  }

  /** This phone went to the background or came back: tell every peer whose
   *  channel is open. A channel that is not open hears it when it opens.
   *  `hiddenForMs`, on coming back, is how long the page was hidden: after
   *  more than KICK_AFTER_HIDDEN_MS every link is swept at once (kick). */
  setSelfAway(away: boolean, hiddenForMs?: number) {
    const kick = !away && hiddenForMs !== undefined && hiddenForMs > KICK_AFTER_HIDDEN_MS
    if (this.selfAway === away) {
      // A mesh never told it was away still sweeps after a long absence and
      // tells the actor: no keyframe, the same sweep
      if (kick) {
        for (const [peerId, conn] of this.conns) {
          this.observePeerInput(peerId, "visibility-changed", conn, (roomEpoch, connectionEpoch) => ({
            type: "visibility-changed", hidden: false, hiddenForMs, keyframe: false, roomEpoch, connectionEpoch,
          }))
        }
        this.sweepAfterKick()
      }
      return
    }
    this.selfAway = away
    for (const [peerId, conn] of this.conns) {
      this.observePeerInput(peerId, "visibility-changed", conn, (roomEpoch, connectionEpoch) => ({
        type: "visibility-changed", hidden: away, ...(hiddenForMs === undefined ? {} : { hiddenForMs }), roomEpoch, connectionEpoch,
      }))
      const channel = conn.channel
      if (channel && channel.readyState === "open") this.write(peerId, channel, encodeAway(away))
      if (away) conn.resume = null
    }
    if (away) return
    // each actor's request-keyframe and, after a long absence, its sweep
    // ran (executePeerCommand): the links are then swept once, together
    if (kick) this.sweepAfterKick()
  }

  /** Back after a long absence, the actors' sweep commands run: every link
   *  is supervised once. */
  private sweepAfterKick() {
    if (this.closed) return
    rtcLog("[jollity-rtc] back in front: sweeping every link")
    this.supervise()
  }

  // ── back from the background: a keyframe, and the time to first frame (#557) ──
  /** This phone is back in front: the actor's request-keyframe on one link.
   *  Before any heal can fire, ask its video senders for a keyframe, hold the
   *  media-stall heal for KEYFRAME_GRACE_MS, and time the link to its next
   *  decoded frame. */
  private requestKeyframe(conn: Conn, now: number) {
    conn.healHoldUntil = now + KEYFRAME_GRACE_MS
    conn.keyframeForcedAt = now
    conn.keyframe = this.forceKeyframe(conn)
    this.startResume(conn, "self", now)
  }

  // ── frozen video on a live link (#1917) ──────────────────────────────────────
  /** The actor's ask-keyframe: our inbound packets still rise but no frame
   *  decodes, so ask the peer for a keyframe over the data channel and hold
   *  the media heals for KEYFRAME_GRACE_MS. The actor rebuilds if the next
   *  sweep past the grace still reads flat. */
  private askKeyframe(peerId: string, conn: Conn, now: number) {
    conn.healHoldUntil = now + KEYFRAME_GRACE_MS
    const channel = conn.channel
    const sent = channel?.readyState === "open" && this.write(peerId, channel, encodeKeyframeRequest())
    if (!sent) {
      // nothing went out: no heal record and no seat mark; the actor's rebuild opens both
      rtcLog(`[jollity-rtc] media frozen: packets rising (${conn.sweepPackets ?? "?"} received), frames flat at ${conn.framesSeen} → keyframe ask not sent (no open channel): the rebuild follows`, peerId)
      return
    }
    rtcLog(`[jollity-rtc] media frozen: packets rising (${conn.sweepPackets ?? "?"} received), frames flat at ${conn.framesSeen} → keyframe ask`, peerId)
    this.heal.begin(peerId, "media_frozen", "keyframe_ask", now)
  }

  /** The peer asks us for a keyframe (its video of us froze): force one on
   *  this link's video senders, at most once per KEYFRAME_GRACE_MS, and never
   *  from the background or on a standby link, whose camera is held back. */
  private onKeyframeRequest(peerId: string, conn: Conn) {
    const now = monoNow()
    const ignored = pageHidden() || this.selfAway ? "page hidden" : conn.standby ? "standby" : conn.keyframeServing ? "in flight" : now - (conn.keyframeForcedAt ?? NEVER) < KEYFRAME_GRACE_MS ? "rate-limited" : null
    if (ignored) {
      rtcLog(`[jollity-rtc] keyframe request ignored (${ignored})`, peerId)
      return
    }
    conn.keyframeForcedAt = now
    conn.keyframeServing = true
    void this.forceKeyframe(conn)
      .then((keyframe) => rtcLog(`[jollity-rtc] keyframe request served method=${keyframe.method} verified=${keyframe.verified}`, peerId))
      .catch((err) => rtcLog("[jollity-rtc] keyframe request failed", peerId, describeError(err)))
      .finally(() => (conn.keyframeServing = false))
  }

  /** The seat's heal mark: a frozen-link heal is open for this peer. It
   *  clears when frames flow (the heal record ends healed), another heal
   *  begins, the rebuilt link fails, or reconnectBudgetMs passes from the
   *  heal's latest step: Can't connect is delayed, never suppressed. */
  private frozenHealing(peerId: string, conn: Conn, now: number): boolean {
    const since = this.heal.openSince(peerId)
    return this.heal.openTrigger(peerId) === "media_frozen" && since !== undefined && conn.pc.connectionState !== "failed" && now - since < SEAT_TIMES.reconnectBudgetMs
  }

  /** Force a keyframe on every video sender of one PC: switch the encoder off
   *  and on (setParameters), else swap the track out and in (replaceTrack).
   *  A method counts when outbound keyFramesEncoded rose on the next read;
   *  a browser without that counter is trusted when the call did not throw. */
  private async forceKeyframe(conn: Conn): Promise<NonNullable<ResumeEvent["keyframe"]>> {
    const pc = conn.pc
    const senders = pc.getSenders().filter((sender) => sender.track?.kind === "video")
    if (senders.length === 0) return { method: "none", verified: "unsupported" }
    const read = async () => {
      try {
        return keyFramesEncoded(await pc.getStats())
      } catch {
        return undefined
      }
    }
    const before = await read()
    const attempts: [KeyframeMethod, (sender: RTCRtpSender) => Promise<void>][] = [
      ["active-toggle", (sender) => this.mutateSender(sender, () => toggleEncoder(sender))],
      ["replace-track", (sender) => this.swapTrack(conn, sender)],
    ]
    for (const [method, run] of attempts) {
      try {
        await Promise.all(senders.map(run))
      } catch (err) {
        rtcLog(`[jollity-rtc] keyframe by ${method} failed`, describeError(err))
        continue
      }
      await new Promise((resolve) => setTimeout(resolve, KEYFRAME_VERIFY_MS))
      const after = await read()
      if (before === undefined || after === undefined) return { method, verified: "unsupported" }
      if (after > before) return { method, verified: "true" }
      rtcLog(`[jollity-rtc] keyframe by ${method} left keyFramesEncoded at`, after)
    }
    return { method: "none", verified: "false" }
  }

  /** A keyframe by taking the track off the sender and putting one back. What
   *  goes back is the mesh's CURRENT camera track, not the one the sender held:
   *  a camera reopened meanwhile (setLocalStream) must not be written over by
   *  the old, likely ended, track. While the sender is bare, `swapping` keeps
   *  addLocalTracks from reading it as free and adding a second video sender. */
  private async swapTrack(conn: Conn, sender: RTCRtpSender): Promise<void> {
    conn.swapping = true
    try {
      await this.mutateSender(sender, async (mutation) => {
        if (mutation.cancelled) throw new Error("sender write cancelled")
        await sender.replaceTrack(null)
        if (mutation.cancelled) {
          // A timed-out removal may land after the ordinary mutation queue has
          // moved on. Restore the current camera directly and idempotently so
          // another blocked write cannot leave this sender bare.
          void sender.replaceTrack(this.outboundVideo(conn)).catch(() => {})
          throw new Error("sender write cancelled")
        }
        const putBack = () => sender.replaceTrack(this.outboundVideo(conn))
        try {
          await putBack()
        } catch (err) {
          await putBack().catch(() => {}) // never leave the sender without its track
          throw err
        }
        if (mutation.cancelled) throw new Error("sender write cancelled")
        await this.applyCurrentVideoRung("swap", sender, this.currentVideoRung, mutation)
      })
    } finally {
      conn.swapping = false
    }
  }

  /** Start timing a link from a return to its next increase in framesDecoded.
   *  The media sweep reads the frames anyway and settles it (settleResume), so
   *  the point's resolution is the sweep's, MEDIA_WATCH_MS. One timing per link. */
  private startResume(conn: Conn, side: ResumeEvent["side"], startedAt: number) {
    conn.resume = { side, startedAt, base: conn.framesSeen }
  }

  /** The sweep read this link's frames: send the resume event if they rose
   *  since the return, drop the timing if it ran past RESUME_GIVE_UP_MS. */
  private settleResume(peerId: string, conn: Conn, frames: number, now: number) {
    const resume = conn.resume
    if (!resume) return
    if (frames > resume.base) {
      conn.resume = null
      const { side } = resume
      const ms = Math.round(now - resume.startedAt)
      void Promise.resolve(side === "self" ? conn.keyframe : undefined).then((keyframe) => {
        if (!this.closed) this.emit(peerId, { kind: "resume", side, ms, ...(keyframe ? { keyframe } : {}) })
      })
    } else if (now - resume.startedAt > RESUME_GIVE_UP_MS) conn.resume = null
  }

  // ── media over the lane ─────────────────────────────────────────────────────
  private laneOpen(conn: Conn): boolean {
    return conn.channel?.readyState === "open"
  }

  /** Put our tracks on this PC, once per kind: a rebuild adds them to its
   *  fresh PC when its own channel opens. A kind counts as on only when a
   *  sender HOLDS a track of it (#544): a remote lane offer applied first
   *  leaves a video transceiver whose sender has none, and addTrack reuses
   *  that transceiver (it has never sent), so our video still rides the
   *  answer, and tuneVideoSender sets its codec preferences (H.264 first; RTX
   *  only on a safe engine, #559) before the answer is written. */
  private addLocalTracks(conn: Conn) {
    const held = new Set(conn.pc.getSenders().flatMap((s) => (s.track ? [s.track.kind] : [])))
    // ours is on, maybe held back for a moment (a keyframe swap) or until the
    // peer's round (standby)
    if (conn.swapping || conn.videoSender) held.add("video")
    for (const track of this.local.getTracks()) {
      if (held.has(track.kind)) continue
      const sender = conn.pc.addTrack(track, this.local)
      if (track.kind !== "video") continue
      conn.videoSender = sender
      // the m-section and its SSRC are negotiated now, so the camera goes on
      // at the peer's round with no renegotiation; until then none is sent
      if (conn.standby)
        void this.mutateSender(sender, async () => sender.replaceTrack(null)).catch((err) =>
          rtcLog("[jollity-rtc] standby replaceTrack failed", describeError(err)),
        )
      // the offer guard (offerOnLane) still strips RTX; this says why it will have to
      const peerId = [...this.conns].find(([, c]) => c === conn)?.[0]
      const prefs = this.tuneVideoSender(peerId ?? "video", conn.pc, sender)
      if (prefs !== "set" && peerId && !thisEngineRtxSafe()) this.emit(peerId, { kind: "codec_guard", reason: prefs === "missing" ? "prefs-missing" : "prefs-refused" })
    }
    this.notifyActiveVideoSendersChanged()
  }

  /** True when the frame went out; false when the channel was not open or the write failed. */
  private sendLane(peerId: string, conn: Conn, signal: PeerConnectionSignalValue): boolean {
    const channel = conn.channel
    if (!channel || channel.readyState !== "open") return false
    const frame = encodeChannelMessage({ id: USE_CASE_RENEGOTIATION, data: encodePeerConnectionSignal(signal) })
    return this.write(peerId, channel, new Uint8Array(frame))
  }

  /** The guard's first check: this engine must not send RTX, and the offer
   *  just set carries it. Says so (codec_guard offer-rtx). */
  private codecGuardNeeded(peerId: string, pc: RTCPeerConnection): boolean {
    if (thisEngineRtxSafe() || rtxIn(pc.localDescription?.sdp) === "no") return false
    this.emit(peerId, { kind: "codec_guard", reason: "offer-rtx" })
    rtcLog(`[jollity-rtc] lane offer to ${peerId} carried RTX on an engine that must not: stripping it`)
    return true
  }

  /** Our local offer rolled back: the codec guard's, or one the round or the
   *  connection moved past. A refusal comes back with its error. The actor's
   *  rollback. */
  private async rollbackLocal(pc: RTCPeerConnection, generation: number): Promise<LocalStepResult> {
    try {
      await pc.setLocalDescription({ type: "rollback" })
    } catch (error) {
      return { outcome: "rejected", site: "lane", reason: sdpRejection(error), roundGeneration: generation, error }
    }
    return { outcome: "resolved" }
  }

  /** The codec guard after its rollback: a fresh offer with the video RTX
   *  stripped, set while the connection is still stable; resolved while the
   *  connection still holds it. Re-read after every await: a remote offer or
   *  a rebuild may land in between. The actor's send-offer. */
  private async stripAndSetOffer(peerId: string, pc: RTCPeerConnection, generation: number): Promise<LocalStepResult> {
    const still = (state: RTCSignalingState) => this.conns.get(peerId)?.pc === pc && pc.signalingState === state
    const rejected = (error: unknown): LocalStepResult =>
      ({ outcome: "rejected", site: "lane", reason: sdpRejection(error), roundGeneration: generation, error })
    if (!still("stable")) {
      return { outcome: "stale", site: "lane" }
    }
    let offer: RTCSessionDescriptionInit
    try {
      offer = await pc.createOffer()
    } catch (error) {
      return rejected(error)
    }
    if (!still("stable")) {
      return { outcome: "stale", site: "lane" }
    }
    try {
      await pc.setLocalDescription({ type: "offer", sdp: stripVideoRtx(offer.sdp ?? "") })
    } catch (error) {
      return rejected(error)
    }
    if (still("have-local-offer")) return { outcome: "resolved" }
    return { outcome: "stale", site: "lane" }
  }

  /** A full-SDP offer down the lane: media, or an ICE restart with the channel
   *  still up. No gathering wait — ICE is already established, and a restart
   *  trickles its candidates down the same lane. */
  private async offerOnLane(peerId: string, conn: Conn): Promise<PeerCommandResult> {
    const { pc } = conn
    const generation = this.roundGeneration
    // the offer set: the actor ends its statement answer wait on the completion too
    let set = false
    const done = (result: PeerCommandResult): PeerCommandResult => (set ? { ...result, offer: "set-lane" } : result)
    try {
      conn.makingOffer = true
      await pc.setLocalDescription()
      set = true
      if (this.conns.get(peerId)?.pc !== pc || pc.signalingState !== "have-local-offer") {
        return done({ outcome: "stale", site: "lane" })
      }
      // the codec guard: the actor's rollback and send-offer run it
      if (!(await this.guardOfferRtxByActor(peerId, conn, generation))) {
        return done({ outcome: "stale", site: "lane" })
      }
      rtcLog(`[jollity-rtc] → lane offer to ${peerId} (video-dir ${videoDir(pc.localDescription?.sdp)}, rtx ${rtxIn(pc.localDescription?.sdp)})`)
      this.sendLane(peerId, conn, { tag: "Offer", value: pc.localDescription!.sdp })
      conn.offer.sent("channel", monoNow())
      this.markStage(peerId, "offer")
      return done({ outcome: "resolved" })
    } catch (err) {
      this.laneNegotiationFailed(peerId, conn, err, "offer", "set-local", generation)
      return done({ outcome: "rejected", site: "lane", reason: sdpRejection(err), roundGeneration: generation })
    } finally {
      conn.makingOffer = false
    }
  }

  /** Hold `token` for the actor's commands while `dispatch` runs them, then
   *  let it go unless an effect already took it. */
  private withStash<Token>(map: Map<string, Token>, peerId: string, token: Token, dispatch: () => unknown): void {
    map.set(peerId, token)
    try {
      dispatch()
    } finally {
      if (map.get(peerId) === token) map.delete(peerId)
    }
  }

  /** The peer's lane frame: an offer to answer, an answer to apply, or restart
   *  candidates. Same perfect-negotiation rule as the signalling wire. */
  private async onLane(peerId: string, conn: Conn, payload: Uint8Array) {
    let signal: PeerConnectionSignalValue
    try {
      signal = decodePeerConnectionSignal(payload)
    } catch (err) {
      rtcLog("[jollity-rtc] lane frame undecodable", peerId, describeError(err))
      return
    }
    const { pc } = conn
    const generation = this.roundGeneration
    if ((signal.tag === "Offer" || signal.tag === "Answer") && this.conns.get(peerId) === conn) {
      // the description the actor's set-remote-description applies; a frame
      // from a replaced connection's channel is one the actor drops (stale)
      this.laneInbound.set(peerId, { type: signal.tag === "Offer" ? "offer" : "answer", sdp: signal.value, generation })
      this.lastWire.set(peerId, "lane")
    }
    if (signal.tag === "Offer") {
      // The other side is renegotiating, a stall heal of the initiator's
      // among them: this side's stall count starts over (ANSWERER_STALL_SWEEPS).
      // Whether this offer is ignored is the actor's (ignore-offer); it reads
      // neither field.
      conn.framesStalls = 0
      conn.ignoreOffer = false
      const actorCollision = conn.makingOffer || (pc.signalingState === "have-local-offer" && !this.laneRemoteAnswerPending.has(conn))
      this.observePeerInput(peerId, actorCollision ? "lane-glare" : "lane-offer-received", conn, (roomEpoch, connectionEpoch) =>
        actorCollision
          ? { type: "glare-observed", remoteCarriesVideo: receivesVideo(pc.remoteDescription?.sdp), polite: conn.polite, lane: true, roomEpoch, connectionEpoch }
          : { type: "description-observed", lane: true, description: "offer", roomEpoch, connectionEpoch },
      )
    } else if (signal.tag === "Answer") {
      this.laneRemoteAnswerPending.add(conn)
      this.observePeerInput(peerId, "lane-answer-received", conn, (roomEpoch, connectionEpoch) => ({
        type: "description-observed", lane: true, description: "answer", roomEpoch, connectionEpoch,
      }))
    }
    // the actor's commands apply, answer, ignore or rebuild (executePeerCommand)
    if (signal.tag === "Offer" || signal.tag === "Answer") {
      const settled = this.settleActorWork(peerId)
      return signal.tag === "Answer" ? settled.finally(() => this.laneRemoteAnswerPending.delete(conn)) : settled
    }
    try {
      for (const candidate of signal.value) {
        try {
          await pc.addIceCandidate({ candidate: candidate.sdp, sdpMLineIndex: candidate.sdpMLineIndex, sdpMid: candidate.sdpMid })
        } catch (err) {
          if (!conn.ignoreOffer) throw err
        }
      }
    } catch (err) {
      rtcLog("[jollity-rtc] onLane error from", peerId, describeError(err))
    }
  }

  /** The peer's lane offer, applied. The actor's set-remote-description. */
  private async applyLaneOffer(peerId: string, conn: Conn, sdp: string, generation: number): Promise<PeerCommandResult> {
    const { pc } = conn
    try {
      await pc.setRemoteDescription({ type: "offer", sdp })
      conn.offersApplied++
      return { outcome: "resolved" }
    } catch (err) {
      this.laneNegotiationFailed(peerId, conn, err, "offer", "set-remote", generation)
      return { outcome: "rejected", site: "lane", reason: sdpRejection(err), roundGeneration: generation }
    }
  }

  /** Our answer to the applied lane offer, down the lane. The actor's send-answer. */
  private async answerLane(peerId: string, conn: Conn, generation: number): Promise<PeerCommandResult> {
    const { pc } = conn
    try {
      this.markStage(peerId, "offer")
      this.addLocalTracks(conn) // a rebuilt peer's first lane offer may land before our own tracks are on
      await pc.setLocalDescription()
      const made = pc.localDescription // what this run's setLocalDescription made
      // a stale connection, or a description that is not an answer (an offer sent as one is glare to the peer)
      if (this.conns.get(peerId)?.pc !== pc || pc.localDescription?.type !== "answer") {
        if (this.conns.get(peerId)?.pc === pc) await this.rollbackUnsentOffer(peerId, conn, made)
        return { outcome: "stale", site: "lane" }
      }
      rtcLog(`[jollity-rtc] → lane answer to ${peerId} (video-dir ${videoDir(pc.localDescription?.sdp)}, rtx ${rtxIn(pc.localDescription?.sdp)})`)
      // a throw: the catch below hands it to laneNegotiationFailed, and the actor's lane rule
      const sent = this.sendLane(peerId, conn, { tag: "Answer", value: pc.localDescription!.sdp })
      // a closed channel or a failed write sends nothing, and completes as a stale answer
      this.markStage(peerId, "answer")
      return sent ? { outcome: "resolved" } : { outcome: "stale", site: "lane" }
    } catch (err) {
      this.laneNegotiationFailed(peerId, conn, err, "answer", "set-local", generation)
      return { outcome: "rejected", site: "lane", reason: sdpRejection(err), roundGeneration: generation }
    }
  }

  /** The peer's lane answer to our offer, applied. The actor's set-remote-description. */
  private async applyLaneAnswer(peerId: string, conn: Conn, sdp: string, generation: number): Promise<PeerCommandResult> {
    const { pc } = conn
    this.laneRemoteAnswerPending.add(conn)
    try {
      await pc.setRemoteDescription({ type: "answer", sdp })
      this.answered(peerId, conn)
      this.markStage(peerId, "answer")
      rtcLog(`[jollity-rtc] lane answer from ${peerId} (video-dir ${videoDir(sdp)}, rtx ${rtxIn(sdp)})`)
      return { outcome: "resolved" }
    } catch (err) {
      this.laneNegotiationFailed(peerId, conn, err, "answer", "set-remote", generation)
      return { outcome: "rejected", site: "lane", reason: sdpRejection(err), roundGeneration: generation }
    } finally {
      this.laneRemoteAnswerPending.delete(conn)
    }
  }

  /** A lane SDP operation failed: logged, and a hard negotiation error is
   *  reported (negotiation_error). The actor decides any rebuild from the
   *  command's rejection. The generation and current-conn checks keep an old
   *  async rejection out of a later round's telemetry. */
  private laneNegotiationFailed(
    peerId: string,
    conn: Conn,
    error: unknown,
    stage: NegotiationErrorEvent["stage"],
    operation: NegotiationErrorEvent["operation"],
    generation: number,
  ): void {
    rtcLog("[jollity-rtc] lane negotiation error from", peerId, stage, operation, describeError(error))
    const name = hardNegotiationError(error)
    if (!name || this.closed || generation !== this.roundGeneration || this.conns.get(peerId) !== conn) return
    // The actor decides the rebuild from the command's stamped rejection
    // (its lane rule); this is the error's telemetry alone.
    this.emit(peerId, { kind: "negotiation_error", name, stage, operation, reason: negotiationReason(error) })
  }

  /** Release the peer's channel. Closing the PC would take it down anyway, but
   *  an explicit close tells the far end now, instead of leaving it to notice
   *  the SCTP association go away. */
  private closeChannel(conn: Conn) {
    const channel = conn.channel
    if (!channel) return
    conn.channel = null
    channel.onopen = channel.onmessage = null
    channel.close()
  }

  /** Put one frame on an open channel. False = the write threw, so a caller
   *  walking a queue stops instead of spinning on the same failure. */
  private write(peerId: string, channel: RTCDataChannel, bytes: Uint8Array<ArrayBuffer>): boolean {
    try {
      channel.send(bytes)
      return true
    } catch (err) {
      rtcLog("[jollity-rtc] channel send failed", peerId, describeError(err))
      return false
    }
  }

  /** Empty the peer's outbox onto its channel, oldest first — the order the
   *  frames were handed to `send`. A channel that shuts mid-flush leaves the
   *  rest queued for the next open. */
  private flushOutbox(peerId: string, conn: Conn, channel: RTCDataChannel) {
    while (conn.outbox.length > 0 && channel.readyState === "open") {
      const bytes = conn.outbox.shift()!
      if (!this.write(peerId, channel, bytes)) break
    }
  }

  /** Send bytes to one peer over its channel, or queue them until it opens.
   *  The buffer must be a plain ArrayBuffer, which is all
   *  `RTCDataChannel.send` takes — an encoder's output goes through
   *  `new Uint8Array(...)` to get there. */
  send(peerId: string, bytes: Uint8Array<ArrayBuffer>) {
    const conn = this.conns.get(peerId)
    if (!conn) return // nobody in the mesh by that name
    const channel = conn.channel
    if (channel && channel.readyState === "open") {
      this.write(peerId, channel, bytes)
      return
    }
    conn.outbox.push(bytes)
    while (conn.outbox.length > OUTBOX_MAX) conn.outbox.shift()
  }

  async onRtc(from: string, payload: RtcPayload) {
    if (this.closed) return
    if (this.roster && !this.roster.has(from)) return // the game's room carries every group's signals
    // A description waits for the peer's offer being answered: a rejoining
    // player gets each peer's stored offer and its fresh rejoin offer at once. Taken together, the second was checked for
    // a new session before the first was applied, both went onto one
    // connection, and the second run's setLocalDescription on the then-stable
    // connection made an offer that went out as the answer. Waiting, it sees
    // the first one's session and takes the rebuild below. Candidates do not
    // wait: one before its remote description is held (pendingCands). The
    // check is made again after each wait, in the same step that goes on to
    // apply: descriptions woken together by one answer take turns (a third
    // waits for the second), and an entry waited out to its bound is not
    // waited for again.
    if (payload.rtc.desc) {
      let waited: unknown
      for (let entry = this.answeringOn(from); entry && entry !== waited; entry = this.answeringOn(from)) {
        waited = entry
        await this.answerSet(entry)
        if (this.closed) return
      }
    }
    rtcLog("[jollity-rtc] ← signal from", from, payload.rtc.desc ? payload.rtc.desc.type : "ice")
    // Tolerate signal arriving before roster. An OFFER already owns this
    // negotiation, so first contact must be responder-only for the same reason
    // as a new-session rebuild: creating our channel here can emit a competing
    // offer and select the opposite DTLS role before we answer.
    this.addPeer(from, payload.rtc.desc?.type !== "offer")
    const conn = this.conns.get(from)
    if (!conn) return // PC construction failed (logged above)
    conn.lastSignalAt = monoNow() // peer is here — the supervisor may keep retrying it
    // the actor's last signal is this one too (markSeen's came before it, or
    // found no connection for a peer first met here)
    this.observeHeard(from, conn, conn.lastSignalAt)
    conn.offer.seen(conn.lastSignalAt)
    if (!Number.isFinite(conn.firstHeardAt)) conn.firstHeardAt = conn.lastSignalAt
    if (!conn.gaveEndpoint) {
      conn.gaveEndpoint = true // they published an SDP/ICE endpoint on the statement store
      this.opts.onLinkChange?.(from)
    }
    const { desc, cand } = payload.rtc
    // A description from ANOTHER remote connection than the one this PC
    // negotiated with: the peer restarted its app or rebuilt its link, and
    // this PC still holds the old one's m-lines and DTLS. Applying an offer to
    // it fails on the m-line order (#223); an answer to it
    // is the fresh connection answering an offer of ours it inherited from
    // the store, which this PC is past. Either way the old PC is done:
    // rebuild, and carry on with the fresh one. The fresh PC takes the offer
    // here and now; an answer is not applied to it, since it answers an offer
    // the fresh PC never made, and the fresh PC offers anew instead. No await
    // between the rebuild and the offer going onto the fresh PC.
    const session = desc ? remoteSessionOf(desc.sdp) : null
    const departedSession = Boolean(session && this.leftSessions.get(from)?.has(session))
    const held = departedSession ? null : this.newSessionOver(from, conn, session)
    const byActor = desc !== undefined && !departedSession
    if (byActor) {
      // A description is a phone that is back. The actor's commands then
      // rebuild for a new session, ignore the offer or apply the description,
      // and answer it (executePeerCommand); this is what they apply.
      if (held) this.leaveSession(from, held)
      // A held session closes through beginRejoin (the actor's rebuild), which
      // records the more precise session_rejoin return.
      if (!held) this.setAway(from, conn, null, "statement_description", offererOfReceived(desc!.type))
      conn.ignoreOffer = false
      this.statementInbound.set(from, { desc: desc!, gen: payload.rtc.gen })
      this.lastWire.set(from, "statement")
    }
    if (desc) {
      // the actor's stamp of a new remote session
      const newRemoteSession = held ? { newRemoteSession: { at: monoNow() } } : {}
      // A new session's offer lands on the fresh connection, which is stable: no collision.
      const offerCollision = !held && desc.type === "offer" && (conn.makingOffer || conn.pc.signalingState !== "stable")
      if (offerCollision && !conn.polite && !departedSession) {
        this.observePeerInput(from, "statement-glare", conn, (roomEpoch, connectionEpoch) => ({
          type: "glare-observed", remoteCarriesVideo: false, polite: false, lane: false, roomEpoch, connectionEpoch,
        }))
      } else {
        this.observePeerInput(from, desc.type === "offer" ? "statement-offer-received" : "statement-answer-received", conn, (roomEpoch, connectionEpoch) => ({
          type: "description-observed", departedSession, lane: false, description: desc.type === "offer" ? "offer" : "answer", ...newRemoteSession, roomEpoch, connectionEpoch,
        }))
      }
    }
    if (byActor) return this.settleActorWork(from)
    if (departedSession) {
      rtcLog("[jollity-rtc] late", desc?.type, "from a connection", from, "already left: dropped")
      // If this late offer was first contact, addPeer deliberately created a
      // responder-only PC. Dropping the unusable offer must not leave that PC
      // channel-less until the supervisor's long recovery timer.
      await this.initiateStrandedPeer(from, conn, "departed-session offer", "departed-session-offer")
      return
    }
    if (!cand) return
    const { pc } = conn
    try {
      rtcLog("[jollity-rtc] remote cand ←", from, candidateForLog(cand))
      if (!pc.remoteDescription) {
        conn.pendingCands.push(cand) // too early — hold until SRD
        return
      }
      try {
        await pc.addIceCandidate(cand)
      } catch (err) {
        if (!conn.ignoreOffer) throw err
      }
    } catch (err) {
      rtcLog("[jollity-rtc] onRtc error from", from, describeError(err))
    }
  }

  /** The peer's signalling session changed (statementTransport's
   *  `onPeerSession`): it reloaded, so the connection we negotiated with its
   *  previous boot is dead, and the transport has already forgotten that
   *  negotiation (an answer to our old offer will not come through). Rebuild
   *  now, before the new session's first description is delivered: an
   *  initiator offers anew from the fresh PC, an answerer waits for the
   *  reloaded peer's offer unless its own offer was the one outstanding. A PC that has negotiated nothing yet holds nothing
   *  of the old session and is left alone. */
  onPeerSession(peerId: string) {
    const conn = this.conns.get(peerId)
    if (this.closed || !conn) return
    const { localDescription, remoteDescription } = conn.pc
    const negotiated = Boolean(localDescription || remoteDescription)
    // the actor's replace-connection rebuilds (signalling-session-rejoin); no
    // leaveSession: the transport already drops the old boot's frames
    this.observePeerInput(peerId, "peer-session-changed", conn, (roomEpoch, connectionEpoch) => ({
      type: "peer-session-changed", at: monoNow(), localOffer: localDescription?.type === "offer",
      negotiated, roomEpoch, connectionEpoch,
    }))
  }

  /** A statement offer of `peerId`'s is being applied to `conn` and answered. */
  private beginAnswering(peerId: string, conn: Conn, session: string | null) {
    this.awayPeriods.attempt(peerId, "answer")
    this.endAnswering(peerId)
    let settle!: () => void
    const settled = new Promise<void>((resolve) => (settle = resolve))
    const entry = { conn, session, settle, settled }
    this.answering.set(peerId, entry)
    return entry
  }

  /** The offer `entry` (by default the peer's current one) is answered, or never will be. */
  private endAnswering(peerId: string, entry = this.answering.get(peerId)) {
    if (!entry || this.answering.get(peerId) !== entry) return
    this.answering.delete(peerId)
    entry.settle()
  }

  /** The peer's offer being answered on its current connection, if any. */
  private answeringOn(peerId: string) {
    const entry = this.answering.get(peerId)
    return entry && entry.conn === this.conns.get(peerId) ? entry : undefined
  }

  /** Until `entry`'s answer is set, ANSWER_SET_WAIT_MS at most. */
  private answerSet(entry: { settled: Promise<void> }): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, ANSWER_SET_WAIT_MS)))
    return Promise.race([entry.settled, bound]).then(() => clearTimeout(timer))
  }

  /** An offer this answer run's setLocalDescription made (`made`) where an
   *  answer was meant (the connection was stable when it ran): rolled back,
   *  never sent, so the connection is stable for the peer's next offer. An
   *  offer set since, ours and maybe sent, is left alone. */
  private async rollbackUnsentOffer(peerId: string, conn: Conn, made: RTCSessionDescriptionInit | null) {
    const { pc } = conn
    const now = pc.localDescription
    if (made?.type !== "offer" || now?.type !== "offer" || now.sdp !== made.sdp || pc.signalingState !== "have-local-offer") return
    rtcLog("[jollity-rtc] an offer where the answer to", peerId, "was meant: rolled back, not sent")
    try {
      await pc.setLocalDescription({ type: "rollback" })
    } catch (err) {
      rtcLog("[jollity-rtc] rollback of the unsent offer to", peerId, "failed", describeError(err))
    }
  }

  /** The remote session this PC holds, when `session` is another one; null
   *  otherwise. The PC's own remote description is the record of what it
   *  ACCEPTED (a refused one leaves it as it was). While the first offer is
   *  still being applied, its answering entry is the record instead, and
   *  while an answer is being set, the session it came from (#1615: a
   *  rebuilt peer's offer read then went onto the same PC, behind its old
   *  connection's answer). */
  private newSessionOver(peerId: string, conn: Conn, session: string | null): string | null {
    const held = remoteSessionOf(conn.pc.remoteDescription?.sdp) ?? this.answeringOn(peerId)?.session ?? null
    const setting = this.answerSetting.get(peerId)
    const holds = held ?? (setting?.conn === conn ? setting.session : null)
    return session !== null && holds !== null && session !== holds ? holds : null
  }

  /** remember that `peerId` left the remote connection `session` */
  private leaveSession(peerId: string, session: string) {
    let left = this.leftSessions.get(peerId)
    if (!left) this.leftSessions.set(peerId, (left = new Set()))
    left.add(session)
    if (left.size > 8) left.delete(left.values().next().value!) // the oldest: long gone from the store
  }

  /** A first-contact offer made us create a responder-only PC, but no remote
   * description was accepted. Replace that uncertain PC and explicitly offer;
   * the peer's unusable offer cannot be allowed to suppress roster initiation. */
  private async initiateStrandedPeer(
    peerId: string,
    conn: Conn,
    reason: string,
    cause: "departed-session-offer" | "offer-refused" | "yield-unanswered" = "offer-refused",
  ): Promise<boolean> {
    if (!this.strandedEligible(peerId, conn)) return false
    this.beginStrandedInitiate(peerId, reason)
    // A departed session's offer is no fact the actor decides on (it ignores
    // it): Mesh's re-initiate is its own replace. The other causes are the
    // actor's (reinitiate).
    this.rebuildPeer(peerId, false, cause === "departed-session-offer")
    const fresh = this.conns.get(peerId)
    if (!fresh) return false
    this.heardOnFresh(peerId, fresh)
    this.createOfferChannel(peerId, fresh)
    await this.offerOnStatement(peerId, fresh)
    return true
  }

  /** Our answer to the statement offer applied as the `applied`-th: set,
   *  gathered and sent on the signalling wire with the offer's `gen`. The
   *  actor's send-answer. "sent", or why not: "stale" (the PC moved on, or a
   *  newer offer's own run answers it) or "displaced" (our own offer took the
   *  answer's place). A failed step throws. */
  private async sendStatementAnswer(from: string, conn: Conn, applied: number, gen: string | undefined): Promise<"sent" | "stale" | "displaced"> {
    const { pc } = conn
    const answering = this.answering.get(from)
    try {
      await pc.setLocalDescription()
    } finally {
      // the answer is set (or failed): the peer's next description may be applied
      if (answering?.conn === conn) this.endAnswering(from, answering)
    }
    const made = pc.localDescription // what this run's setLocalDescription made
    await waitIceGathering(pc, this.relayOnly()) // non-trickle: bundle candidates into the answer
    // Bail if a concurrent self-heal rebuilt/removed this PC during the
    // gather wait — a stale answer off a closed PC collides with the fresh offer.
    if (this.conns.get(from)?.pc !== pc) {
      return "stale"
    }
    // A newer offer from the same connection was applied during the gather:
    // the local answer now answers that one, and its own run sends it with its
    // own gen. Sent from here it would carry this run's (older) gen. Counted,
    // not compared by SDP: the peer's candidates added during the gather
    // change the remote SDP too, and that answer is still this offer's (game
    // 1120: a bundled offer's candidates land within the gather, and the
    // dropped answer left the link down until the 30 s rebuild).
    // And only an answer is sent as one: a setLocalDescription that ran on a
    // stable connection made an offer, which the peer would take for glare.
    if (conn.offersApplied !== applied || pc.localDescription?.type !== "answer") {
      if (pc.localDescription?.type !== "answer") await this.rollbackUnsentOffer(from, conn, made)
      return conn.offersApplied === applied ? "displaced" : "stale"
    }
    rtcLog("[jollity-rtc] → answer to", from)
    rtcLog(`[jollity-rtc] local answer video-dir ${from}: ${videoDir(pc.localDescription?.sdp)}`)
    // a throw goes to the caller, which logs it; nothing after the send runs
    this.signal(from, { rtc: gen === undefined ? { desc: pc.localDescription! } : { desc: pc.localDescription!, gen } })
    this.markStage(from, "answer")
    return "sent"
  }

  /** Create the locally-owned channel that makes this PC the next offerer. */
  private createOfferChannel(peerId: string, conn: Conn): void {
    if (conn.channel || !this.mayOffer(peerId)) return
    try {
      this.attachChannel(peerId, conn, conn.pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true }))
    } catch (err) {
      rtcLog("[jollity-rtc] channel create failed", peerId, describeError(err))
    }
  }

  /** The signalling transport does not guarantee order, so candidates can
   *  arrive BEFORE the description — flush the ones we buffered. */
  private async flushPendingCands(from: string, conn: Conn): Promise<void> {
    if (!conn.pendingCands.length) return
    rtcLog("[jollity-rtc] flushing", conn.pendingCands.length, "buffered candidates from", from)
    const cands = conn.pendingCands
    conn.pendingCands = []
    for (const c of cands) {
      try {
        await conn.pc.addIceCandidate(c)
      } catch (err) {
        rtcLog("[jollity-rtc] buffered candidate failed", describeError(err))
      }
    }
  }

  // ── self-healing ────────────────────────────────────────────────────────────
  /** Periodic sweep: give every peer's actor a clock fact; the actor decides
   *  any recovery (reconnecting a present peer that isn't `connected`). */
  private supervise() {
    if (this.closed) return
    // in the background nothing is attempted, and so nothing is counted: a
    // phone that cannot run its timers would only burn the backoff budget
    if (pageHidden()) return
    this.superviseByActor(monoNow())
  }

  /** supervise() with the actor deciding: the sweep's facts go to each peer's
   *  actor, whose commands recover, yield, re-initiate or mark it away. A
   *  snapshot, since a rebuild re-inserts the peer it replaces. */
  private superviseByActor(now: number) {
    for (const [peerId, conn] of [...this.conns]) {
      if (this.closed) return
      if (this.conns.get(peerId) !== conn) continue
      this.observeSupervisorTick(peerId, conn, now)
    }
  }

  /** One supervisor sweep over a peer, for its actor: a clock fact, with what
   *  the sweep reads of the browser. Every time it decides from is the
   *  actor's own. */
  private observeSupervisorTick(peerId: string, conn: Conn, now: number): void {
    this.observePeerInput(peerId, "clock", conn, (roomEpoch, connectionEpoch) => ({
      type: "clock",
      now,
      snapshot: {
        browserConnectionState: conn.pc.connectionState,
        haveLocalOffer: conn.pc.signalingState === "have-local-offer",
        localDescription: Boolean(conn.pc.localDescription),
        remoteDescription: Boolean(conn.pc.remoteDescription),
        hasChannel: Boolean(conn.channel),
        laneOpen: this.laneOpen(conn),
        away: conn.away,
        framesSeen: conn.framesSeen,
        sawVideoThisRound: this.roundLinkProofs.has(`${this.roundGeneration}:${peerId}:first-video`),
        canRestartIce: typeof conn.pc.restartIce === "function",
        ...this.gatherFacts(conn),
      },
      roomEpoch,
      connectionEpoch,
    }))
  }

  /** #1951: the candidate and ICE facts of a connection the actor's
   *  gathering-stall rule reads. Every candidate it ever gathered counts
   *  (GatherTracker.seen), a relay over TCP or TLS among them. */
  private gatherFacts(conn: Conn) {
    const { srflx, relay } = conn.gather.seen()
    return {
      srflxOrRelaySeen: srflx > 0 || relay > 0,
      gatheringComplete: conn.pc.iceGatheringState === "complete",
      turnConfigured: conn.turnConfigured,
      relayOnly: conn.relayOnly,
    }
  }

  /** Tear the peer's PC down and recreate it from scratch. Recovery rebuilds
   *  re-offer; a rebuild already holding a remote offer stays responder-only.
   *  `external`: Mesh replaces the connection outside any actor command
   *  (rebuildAll, the departed-session initiate). It is no decision then: the
   *  actor is told with connection-replaced-externally. */
  private rebuildPeer(peerId: string, initiate = true, external = false) {
    this.endAnswering(peerId) // nothing waits on the connection this replaces
    const old = this.conns.get(peerId)
    const lastSignal = old ? old.lastSignalAt : NEVER
    // The queued frames belong to the PERSON, not to the connection carrying
    // them, so a rebuild hands them to the fresh conn. `closeChannel` below
    // releases the channel alone.
    const outbox = old ? old.outbox : []
    const downAt = old ? old.downAt : 0
    const away = old ? old.away : null
    if (old) {
      this.saveHistory(peerId) // persist everConnected/createdAt/firstHeardAt for the fresh conn
      this.closeChannel(old) // the fresh PC brings a fresh channel
      try {
        old.pc.close()
      } catch {
        /* ignore */
      }
      this.conns.delete(peerId)
    }
    this.addPeer(peerId, initiate, external) // fresh PC; recovery normally re-offers, an incoming new-session offer answers instead
    const fresh = this.conns.get(peerId)
    if (fresh) {
      fresh.lastSignalAt = lastSignal // keep presence so the supervisor keeps chasing
      fresh.outbox = outbox
      fresh.downAt = downAt // the clock for "away" is the link's, not the PC's
      fresh.away = away
    }
  }

  /** Rebuild every link that is not `connected` through the SAME path the
   *  self-heal supervisor uses (`rebuildPeer` — tear down + recreate +
   *  re-offer, carrying history forward), rather than waiting on its own
   *  backoff/timeout; for example after the ICE policy changes (useMesh), when
   *  the links that are down should try again on the new policy at once.
   *
   *  Connected links are left alone: tearing down a working connection
   *  mid-round blacks out its tile for seconds for nothing.
   *
   *  Counts no failure: the actor adopts each fresh connection as an
   *  attempt (connection-replaced-externally) and leaves its failures as
   *  they are, since this rebuild is not a failure. */
  rebuildAll() {
    if (this.closed) return
    for (const [peerId, conn] of [...this.conns]) {
      if (conn.pc.connectionState === "connected") continue
      this.rebuildPeer(peerId, true, true)
    }
  }

  /** Snapshot a peer's across-conn state before its conn is torn down, so a fresh
   *  conn (rejoin/rebuild) restores everConnected/createdAt/firstHeardAt. */
  private saveHistory(peerId: string) {
    const c = this.conns.get(peerId)
    if (c) this.history.set(peerId, { everConnected: c.everConnected, createdAt: c.createdAt, firstHeardAt: c.firstHeardAt })
  }

  /** Media-flow watchdog (see MEDIA_WATCH_MS). Poll inbound video frames on every
   *  `connected` peer and report each link's frames to its actor
   *  (stats-observed): frames that stop advancing on a link that reads
   *  `connected` mean the RTP is blackholed, and the actor restarts ICE or
   *  rebuilds. Our OWN dead camera is not its job: lib/camera's recovery
   *  reopens it → setLocalStream(). */
  private async watchMedia() {
    if (this.closed) return
    // IN THE BACKGROUND THE PHONE ITSELF PAUSES VIDEO — capture on both
    // platforms, and decoding in the WebView — so no inbound frames is
    // expected, and an ICE restart cannot help. It only froze our own feed for
    // everyone else. Start the count over once the page is back in front.
    if (pageHidden()) {
      for (const conn of this.conns.values()) conn.framesStalls = 0
      return
    }
    const localVideoLive = this.local.getVideoTracks().some((t) => t.readyState === "live")
    for (const [peerId, conn] of [...this.conns]) {
      // a close during an earlier peer's getStats ends the sweep
      if (this.closed) return
      // an away phone sends no video, and a restart cannot help; nor does a
      // standby peer, who holds theirs back from us until their round
      // The state this check saw: the actor is told that one, not a drop during the stats await below.
      const stateSeen = conn.pc.connectionState
      if (stateSeen !== "connected" || conn.away || conn.standby) {
        conn.framesStalls = 0
        conn.sweepPackets = undefined
        // The actor restarts its own stall count on a held sweep: tell it of
        // the sweeps that read no frames.
        this.observePeerInput(peerId, "stats-observed", conn, (roomEpoch, connectionEpoch) => ({
          type: "stats-observed",
          readSequence: conn.framesTaken,
          framesDecoded: conn.framesSeen,
          browserConnectionState: stateSeen,
          roomEpoch,
          connectionEpoch,
        }))
        continue
      }
      // getStats unavailable (can't assess this peer), or a later read already landed
      const read = await this.readFrames(conn)
      if (read === undefined) continue
      const { frames, packets } = read
      // getStats awaited: bail if this peer was rebuilt/removed or we tore down meanwhile.
      if (this.closed || this.conns.get(peerId) !== conn) continue
      const now = monoNow()
      // The initial media offer/answer rides the data channel. A missing frame
      // statistic (or an inbound stream that stays at zero) one media sweep
      // before the seat's reconnect budget (CONNECTED_WITHOUT_VIDEO_MS) means
      // that negotiation never produced video.
      // ICE is already connected and an unanswered lane offer can prevent an
      // ICE restart from creating a new offer, so tear down this SDP generation.
      const remoteCameraOff = this.views.get(peerId)?.codes.get(peerId) === VIEW.selfCameraOff
      const connectedWithoutVideo =
        conn.framesSeen === 0 &&
        frames <= 0 &&
        this.laneOpen(conn) &&
        conn.channelOpenAt > 0 &&
        now - conn.channelOpenAt >= CONNECTED_WITHOUT_VIDEO_MS &&
        !remoteCameraOff
      const unseen = isInitiator(this.myId, peerId) && localVideoLive && this.peerCannotSeeUs(peerId, conn, now)
      // #1523 per-episode unseen budget: the peer's fresh view has said for
      // VIEW_CONFIRM_MS that it decodes our video again, which refills the
      // actor's unseen heal. A stale view (received over VIEW_FRESH_MS ago)
      // does not, nor does one "sees us" row between "cannot see" rows (a
      // flapping iPhone would otherwise get a restart every episode).
      const peerView = this.views.get(peerId)
      const peerSeesUs =
        peerView !== undefined &&
        now - peerView.at <= VIEW_FRESH_MS &&
        Number.isFinite(peerView.seenSince) &&
        now - peerView.seenSince >= VIEW_CONFIRM_MS
      const sweeps = isInitiator(this.myId, peerId) ? FRAMES_STALL_SWEEPS : ANSWERER_STALL_SWEEPS
      // the media heals' window: no keyframe on its way, and the last heal backed off
      const healDue = now >= conn.healHoldUntil && now - conn.lastMediaHealAt >= MEDIA_HEAL_BACKOFF_MS
      const recoveryDue = localVideoLive && healDue
      // #1917: the inbound packets rose since the last sweep (the same getStats read as the frames)
      const packetsMoving = packets !== undefined && conn.sweepPackets !== undefined && packets > conn.sweepPackets
      conn.sweepPackets = packets
      this.observePeerInput(peerId, "stats-observed", conn, (roomEpoch, connectionEpoch) => ({
        type: "stats-observed",
        readSequence: conn.framesTaken,
        framesDecoded: frames,
        browserConnectionState: stateSeen,
        // The no-video rebuild does not wait for our own camera (recoveryDue does)
        noVideoDeadline: connectedWithoutVideo && healDue,
        stallAfter: sweeps,
        recoveryDue,
        peerCannotSeeUs: unseen && recoveryDue,
        peerSeesUs,
        // our camera as this sweep reads it: it may have come up after the actor started
        cameraLive: localVideoLive,
        haveLocalOffer: conn.pc.signalingState === "have-local-offer",
        // the frozen-link heal (#1917): packets moving, and the heal window without the camera gate
        packetsMoving,
        // no frozen heal for a peer whose own view says its camera is off, as for the no-video rebuild
        healDue: healDue && !remoteCameraOff,
        // either side asks for a keyframe after the initiator's sweeps: an ask cannot cause the mutual restarts ANSWERER_STALL_SWEEPS prevents
        frozenAskAfter: FRAMES_STALL_SWEEPS,
        roomEpoch,
        connectionEpoch,
      }))
      // The actor's commands did any heal. What is left is the sweep's own
      // record of the frames, on a link the actor did not replace.
      if (this.closed || this.conns.get(peerId) !== conn || frames < 0) continue
      this.settleResume(peerId, conn, frames, now)
      if (advanced(frames, conn.framesSeen)) this.sawFrames(peerId, conn, frames, now)
    }
    this.shareView(monoNow())
  }

  // ── who sees whom (link-view.ts) ──────────────────────────────────────────
  /** What this phone sees of one member, right now. */
  private viewCode(member: string, now: number): ViewCode {
    // our camera is on while a video track is live, enabled, and not muted by
    // the OS (another app took the camera, the system suspended it)
    if (member === this.myId) return this.local.getVideoTracks().some((t) => t.readyState === "live" && t.enabled !== false && !t.muted) ? VIEW.self : VIEW.selfCameraOff
    const conn = this.conns.get(member)
    if (!conn) return VIEW.unheard
    if (conn.pc.connectionState === "connected") return now - conn.lastFrameAt < VIEW_VIDEO_FRESH_MS ? VIEW.video : VIEW.linked
    return now - conn.lastSignalAt < PRESENCE_FRESH_MS ? VIEW.heard : VIEW.unheard
  }

  /** Our view of the room to every open channel and to the caller (the
   *  hello); a change is logged, so any one phone's log holds the room's
   *  matrix. Then the relay candidates the views show. */
  private shareView(now: number) {
    const members = this.opts.members
    if (!members) return
    const row = encodeView(members, (member) => this.viewCode(member, now))
    if (row !== this.ownRow) rtcLog("[jollity-rtc] view mine:", row)
    this.ownRow = row
    this.opts.onOwnView?.(row)
    const frame = encodeViewFrame(row)
    for (const [peerId, conn] of this.conns) {
      const channel = conn.channel
      if (channel && channel.readyState === "open") this.write(peerId, channel, frame)
    }
    this.logRelayCandidates(members, now)
  }

  /** A peer's view of the room arrived, on its channel or its hello. */
  onPeerView(peerId: string, row: string) {
    const members = this.opts.members
    if (!members || !members.includes(peerId)) return
    const codes = decodeView(row, members)
    if (!codes) return // another roster: not this room's row
    const now = monoNow()
    const previous = this.views.get(peerId)
    if (previous?.row !== row) rtcLog("[jollity-rtc] view from", peerId + ":", row)
    const seesUs = codes.get(this.myId) === VIEW.video
    this.views.set(peerId, {
      row,
      codes,
      at: now,
      unseenSince: seesUs ? NEVER : previous && Number.isFinite(previous.unseenSince) ? previous.unseenSince : now,
      seenSince: !seesUs ? NEVER : previous && Number.isFinite(previous.seenSince) ? previous.seenSince : now,
    })
    if (seesUs) this.heal.peerSees(peerId, now)
  }

  /** What the waiting room's dots read of each link, right now; onLinkChange
   *  says when it moved. */
  links(): Map<string, MeshLink> {
    const out = new Map<string, MeshLink>()
    for (const [peerId, conn] of this.conns) {
      out.set(peerId, { conn: conn.pc.connectionState, path: conn.path, endpoint: conn.gaveEndpoint || conn.everConnected })
    }
    return out
  }

  /** What the seat states (seat-state.ts) read of each peer, right now. */
  seats(): Map<string, SeatFacts> {
    const out = new Map<string, SeatFacts>()
    const now = monoNow()
    for (const [peerId, conn] of this.conns) {
      out.set(peerId, {
        conn: conn.pc.connectionState,
        signalingState: conn.pc.signalingState,
        everConnected: conn.everConnected,
        firstHeardAt: conn.firstHeardAt,
        lastSignalAt: conn.lastSignalAt,
        lastFrameAt: this.seatFrameAt(peerId, conn),
        upAt: conn.upAt,
        channelOpenAt: conn.channelOpenAt,
        downAt: conn.downAt,
        away: conn.away,
        cameraOff: this.views.get(peerId)?.codes.get(peerId) === VIEW.selfCameraOff,
        healing: this.frozenHealing(peerId, conn, now),
      })
    }
    return out
  }

  /** Has the peer said, for VIEW_CONFIRM_MS and lately, that it decodes none
   *  of our video, on a link that has been up long enough to show it? */
  private peerCannotSeeUs(peerId: string, conn: Conn, now: number): boolean {
    const view = this.views.get(peerId)
    if (!view || now - view.at > VIEW_FRESH_MS) return false
    if (!Number.isFinite(view.unseenSince) || now - view.unseenSince < VIEW_CONFIRM_MS) return false
    return conn.upAt > 0 && now - conn.upAt > VIEW_LINK_GRACE_MS
  }

  /** Two members who both send us video but, by their own views, reach each
   *  other at most on the store: a pair our phone could relay between. Logged
   *  once a pair, to find out how often a relay would help before building it. */
  private logRelayCandidates(members: readonly string[], now: number) {
    const others = members.filter((member) => member !== this.myId && this.viewCode(member, now) === VIEW.video)
    for (const [i, a] of others.entries()) {
      for (const c of others.slice(i + 1)) {
        const key = [a, c].sort().join("|")
        if (this.relayLogged.has(key)) continue
        const va = this.views.get(a)
        const vc = this.views.get(c)
        if (!va || !vc || now - va.at > VIEW_FRESH_MS || now - vc.at > VIEW_FRESH_MS) continue
        const apart = (code: ViewCode | undefined) => code === VIEW.unheard || code === VIEW.heard
        if (!apart(va.codes.get(c)) || !apart(vc.codes.get(a))) continue
        this.relayLogged.add(key)
        rtcLog("[jollity-rtc] relay candidate:", a, "and", c, "both send us video, but have no link to each other")
      }
    }
  }

  /** the track our camera sends on this link: none while the peer is on standby */
  private outboundVideo(conn: Conn): MediaStreamTrack | null {
    return conn.standby ? null : (this.local.getVideoTracks()[0] ?? null)
  }

  /** A co-player of a LATER round is on standby (the game's session): their
   *  link is made during the pre-game countdown, so it is up when their round opens, but our
   *  camera stays off it (replaceTrack, no renegotiation) and their silence is
   *  no stall, since they hold theirs back the same way. Ending standby puts
   *  the CURRENT camera on at the current video rung, and starts the link's
   *  no-video and stall clocks over, with a moment for their keyframe. It
   *  belongs to the person: a link rebuilt meanwhile keeps it. */
  setStandby(peerId: string, standby: boolean) {
    if (standby === this.standbyPeers.has(peerId)) return
    if (standby) this.standbyPeers.add(peerId)
    else this.standbyPeers.delete(peerId)
    const conn = this.conns.get(peerId)
    if (!conn) return
    // the roster first: the actor's replace-video-track sends what it says (outboundVideo)
    conn.standby = standby
    this.observePeerInput(peerId, "standby-changed", conn, (roomEpoch, connectionEpoch) => ({
      type: "standby-changed", standby, roomEpoch, connectionEpoch,
    }))
  }

  /** setStandby's effect on a link: our camera held back or put on. The
   *  actor's replace-video-track. */
  private applyStandby(peerId: string, conn: Conn, standby: boolean) {
    rtcLog("[jollity-rtc]", standby ? "standby (camera held back):" : "standby over (camera on):", peerId)
    if (!standby) {
      const now = monoNow()
      conn.healHoldUntil = now + KEYFRAME_GRACE_MS
      conn.framesStalls = 0
      // video starts now, so the connected-without-video deadline counts from here
      if (this.laneOpen(conn)) conn.channelOpenAt = now
      this.views.delete(peerId) // what they said while we sent nothing is not what they see now
    }
    const sender = conn.videoSender
    if (!sender) return
    void this.mutateSender(sender, async (mutation) => {
      if (mutation.cancelled) return
      await sender.replaceTrack(this.outboundVideo(conn))
      if (!standby && !mutation.cancelled) await this.applyCurrentVideoRung("standby-over", sender, this.currentVideoRung, mutation)
    })
      .then(() => this.notifyActiveVideoSendersChanged())
      .catch((err) => rtcLog("[jollity-rtc] standby replaceTrack failed", describeError(err)))
  }

  /** THE ROSTER (the game's session): `active` is the group of the round being
   *  played (or about to be), `standby` everyone else we share a later round
   *  with. The room is the game's, so the roster is what changes at a round:
   *  a player in both rounds keeps the very same connection, a later round's
   *  is made ahead with our camera held back, and one with no round left with
   *  us is closed. A signal from anyone else opens nothing. Link views are
   *  read against the active group. Returns the peers it closed. */
  setPeers(active: readonly string[], standby: readonly string[]): string[] {
    const wanted = new Set([...active, ...standby])
    wanted.delete(this.myId)
    this.roster = wanted
    this.opts.members = [...active.filter((id) => id !== this.myId), this.myId]
    const removed = [...this.conns.keys()].filter((id) => !wanted.has(id))
    for (const id of removed) {
      rtcLog("[jollity-rtc] no round left with:", id)
      this.removePeer(id)
      this.views.delete(id)
    }
    for (const id of [...this.standbyPeers]) if (!wanted.has(id)) this.standbyPeers.delete(id)
    for (const id of wanted) this.setStandby(id, !active.includes(id))
    for (const id of wanted) this.addPeer(id)
    observeLegacyDecision({
      kind: "roster",
      at: monoNow(),
      event: "roster-applied",
      scope: {
        ...(this.opts.decisionRoom ? { room: this.opts.decisionRoom } : {}),
        round: this.round ?? null,
        generation: this.roundGeneration,
      },
      decision: "apply-roster",
      landingState: "roster-applied",
      roster: { active, standby, removed },
    })
    return removed
  }

  /** the peers on standby now */
  standing(): string[] {
    return [...this.standbyPeers]
  }

  /** the members link views are written against: the active group, us last */
  members(): readonly string[] {
    return this.opts.members ?? []
  }

  /** Adopt a freshly re-acquired local stream after the camera track died mid-game:
   *  swap the outbound video track on every peer via replaceTrack — no renegotiation
   *  (same m-line), so peers keep their tiles and just get live frames again. Also
   *  adopts the stream for future addPeer/rebuild. Called when lib/camera reopens
   *  the camera (its track ended, or stayed muted). */
  async setLocalStream(stream: MediaStream) {
    if (stream === this.local) return
    rtcLog("[jollity-rtc] adopting a reopened camera")
    this.local = stream
    await Promise.all(
      [...this.conns.values()].map(async (conn) => {
        const sender = conn.videoSender ?? conn.pc.getSenders().find((s) => !s.track || s.track.kind === "video")
        if (!sender) return
        try {
          const result = await this.mutateSender(sender, async (mutation) => {
            if (mutation.cancelled) throw new Error("sender write cancelled")
            await sender.replaceTrack(this.outboundVideo(conn))
            if (mutation.cancelled) throw new Error("sender write cancelled")
            return this.applyCurrentVideoRung("camera-reopen", sender, this.currentVideoRung, mutation)
          })
          safely(() => this.opts.onVideoRungResult?.({ requested: this.currentVideoRung.index, senders: [result], uniform: result.status === "applied" }))
        } catch (err) {
          rtcLog("[jollity-rtc] replaceTrack failed", describeError(err))
        }
      }),
    )
  }

  /** The peer was heard: a hello, or a signal. Their link is healed while
   *  they keep being heard, and a peer heard again after RETURN_GAP_MS of
   *  silence is back — whatever marked them away is stale, and the next sweep
   *  tries at once. */
  markSeen(peerId: string) {
    const conn = this.conns.get(peerId)
    if (!conn) return
    const now = monoNow()
    this.observeHeard(peerId, conn, now)
    if (conn.away && Number.isFinite(conn.lastSignalAt) && now - conn.lastSignalAt > RETURN_GAP_MS) {
      rtcLog("[jollity-rtc] heard again after", Math.round((now - conn.lastSignalAt) / 1000), "s:", peerId)
      this.setAway(peerId, conn, null, "heard_again")
    }
    conn.lastSignalAt = now
    conn.offer.seen(conn.lastSignalAt)
    if (!Number.isFinite(conn.firstHeardAt)) conn.firstHeardAt = now
  }

  /** Tell the actor the peer was heard. useMesh calls markSeen for every
   *  hello and every inbound signal, so this is every fact the return gap
   *  reads. */
  private observeHeard(peerId: string, conn: Conn, at: number) {
    this.observePeerInput(peerId, "peer-heard", conn, (roomEpoch, connectionEpoch) => ({ type: "peer-heard", at, roomEpoch, connectionEpoch }))
  }

  /** THE PHONE'S NETWORK CHANGED (#1020): every link is repaired in place,
   *  never the room. One whose data channel is open restarts ICE over it, so
   *  the association and its channel can survive the new path; one whose
   *  channel is down gets a fresh connection, and this side offers on it
   *  whatever its role, so the link never waits on the far end's recovery
   *  budget. The transport stays open across this: it still knows the offers
   *  it already delivered, so a replayed old offer cannot bind a fresh one.
   *  `addresses`: the change was inferred from a link's gathering finding
   *  this new local-address fingerprint (onLocalAddresses), not announced by
   *  the OS; each link's fact says whether its own gathering already holds
   *  it, and how its connection stands, for the actor to decide (#1608). */
  networkChanged(addresses?: string) {
    if (this.closed) return
    // one attempt instant for every peer's fact
    const now = monoNow()
    this.lastNetworkChangeAt = now
    const facts = { onNew: 0, connected: 0, other: 0 }
    for (const [peerId, conn] of [...this.conns]) {
      // a peer an earlier peer's command replaced is swept as the fresh one
      if (this.conns.get(peerId) !== conn) continue
      const inferred = addresses !== undefined
        ? { inferred: true, onNewNetwork: [...conn.localAddresses].sort().join("|") === addresses, browserConnectionState: conn.pc.connectionState }
        : {}
      if (inferred.onNewNetwork) facts.onNew++
      else if (inferred.browserConnectionState === "connected") facts.connected++
      else facts.other++
      // the actor's restart-ice or replace-connection repairs the link (executePeerCommand)
      this.observePeerInput(peerId, "network-change", conn, (roomEpoch, connectionEpoch) => ({
        type: "network-changed", now, ...inferred, roomEpoch, connectionEpoch,
      }))
    }
    // what the actors decided from: the links an inferred change leaves alone (#1608)
    if (addresses !== undefined) rtcLog(`[jollity-rtc] inferred network change: links on the new address=${facts.onNew} connected=${facts.connected} others=${facts.other}`)
  }

  /** Relay only, or every path (the network check, path-mode.ts): from the
   *  next gathering on, which a restart or a rebuild starts. Relay only, the
   *  links keep the TURN servers over `relayProtocols`, the transports a relay
   *  answered on in the check (path-mode.ts iceConfigFor). */
  setIcePolicy(policy: RTCIceTransportPolicy, relayProtocols: readonly string[] = []) {
    if ((this.rtcConfig.iceTransportPolicy ?? "all") === policy && this.relayProtocols.join() === relayProtocols.join()) return
    // the new policy first: each actor's configure-ice applies it to its connection
    this.rtcConfig = { ...this.rtcConfig, iceTransportPolicy: policy }
    this.relayProtocols = relayProtocols
    const now = monoNow()
    for (const [peerId, conn] of [...this.conns]) {
      this.observePeerInput(peerId, "ice-policy-changed", conn, (roomEpoch, connectionEpoch) => ({
        type: "ice-policy-changed", now, roomEpoch, connectionEpoch,
      }))
    }
    this.logIcePolicy()
  }

  private logIcePolicy() {
    const policy = this.rtcConfig.iceTransportPolicy ?? "all"
    const relays = policy === "relay" ? ` over ${this.relayProtocols.join(",") || "every transport"}, ${this.pcConfig().iceServers?.length ?? 0} servers` : ""
    rtcLog(`[jollity-rtc] ICE policy: ${policy}${relays}`)
  }

  /** TURN that arrived after the mesh opened on STUN only (ice.ts
   *  lateIceServers, after the 8 s first start, #270): every connection made
   *  from now on uses it, rebuilds included. Every existing PC takes the
   *  configuration without restarting: an unconnected link can use it now,
   *  while a connected but media-stalled link has TURN available for its next
   *  ICE restart. `refreshed`: fresh credentials after a network change, not
   *  late TURN. */
  setIceServers(iceServers: RTCIceServer[], refreshed = false) {
    this.rtcConfig = { ...this.rtcConfig, iceServers }
    if (refreshed) rtcLog("[jollity-rtc] relay credentials refreshed after the network change:", iceServers.length - 1, "relays for the links from now on")
    else rtcLog("[jollity-rtc] TURN arrived after the mesh opened:", iceServers.length - 1, "relays for the links from now on")
    this.configureAll()
  }

  /** what a connection is made with: the servers and policy, trimmed to the path (path-mode.ts iceConfigFor) */
  private pcConfig(): RTCConfiguration {
    return iceConfigFor(this.rtcConfig, this.relayProtocols)
  }

  /** every existing connection takes the configuration now, at its own pool size */
  private configureAll() {
    const config = this.pcConfig()
    for (const [peerId, conn] of this.conns) {
      try {
        conn.pc.setConfiguration({ ...config, iceCandidatePoolSize: conn.poolSize })
      } catch (err) {
        rtcLog("[jollity-rtc] setConfiguration refused", peerId, describeError(err))
      }
    }
  }

  /** relay only: a description waits for its relay candidate (waitIceGathering) */
  private relayOnly(): boolean {
    return this.rtcConfig.iceTransportPolicy === "relay"
  }

  /** Their frames advanced on this link: the video is flowing, and with it any
   *  recovery succeeded. A media-stall restartIce can keep the PC `connected`
   *  throughout, so the `connected` state-change may never re-fire: the
   *  recovery-only offer permission clears here too, on the ground truth
   *  (frames), back to the glare-free initiator-only model. */
  private sawFrames(peerId: string, conn: Conn, frames: number, now: number) {
    conn.framesSeen = frames
    conn.lastFrameAt = now
    conn.framesStalls = 0
    this.videoAt.set(peerId, now)
    this.markRoundLink(peerId, "first-video")
    this.answererMayOffer.delete(peerId)
    this.heal.mediaFlowing(peerId, now)
  }

  /** When their video last came through, as the seat reads it: this link's
   *  frames, or any earlier link's, or a track's unmute. */
  private seatFrameAt(peerId: string, conn: Conn): number {
    return Math.max(conn.lastFrameAt, this.videoAt.get(peerId) ?? NEVER)
  }

  /** A LOOK AT EVERY LINK WHOSE SEAT IS NOT LIVE, for the caller's seat tick
   *  (#672). Video that comes back on a link that stayed connected fires no
   *  unmute and no `connected`: only the frame count says so, and the sweep
   *  reads it every MEDIA_WATCH_MS, while the seat held Can't connect and the
   *  tile took no tap. A link whose seat still reads live by its frames is not
   *  looked at, so a healthy link stays on the sweep's cadence; nor is one
   *  that is not connected (no video to find) or away, or any while the page
   *  is hidden (the phone pauses decoding). Inbound frames only: our own video
   *  never counts. A link that has never decoded a frame (a camera off with no
   *  away frame) is looked at every tick for PROBE_FAST_LOOKS, then every
   *  PROBE_SLOW_EVERY-th: a phone with several such peers would otherwise read
   *  stats for each every second all game. A link that had video is not backed
   *  off: its return is the case this is for. True when one showed new frames. */
  async probeStaleFrames(): Promise<boolean> {
    if (this.closed || pageHidden()) return false
    const now = monoNow()
    const looks: Promise<boolean>[] = []
    for (const [peerId, conn] of this.conns) {
      if (conn.pc.connectionState !== "connected" || conn.away || conn.standby || now - this.seatFrameAt(peerId, conn) < SEAT_TIMES.mediaFreshMs) {
        conn.staleLooks = 0
        continue
      }
      const due = ++conn.staleLooks
      if (conn.framesSeen === 0 && due > PROBE_FAST_LOOKS && due % PROBE_SLOW_EVERY !== 0) continue
      looks.push(this.probeFrames(peerId, conn))
    }
    return (await Promise.all(looks)).some(Boolean)
  }

  /** This link's inbound frames decoded (-1 = no inbound video stat yet), or
   *  undefined when getStats failed or a read made after this one already
   *  landed: the sweep and a probe can resolve out of order, and an older,
   *  lower count would read as a counter reset (`advanced`), so a fake advance. */
  private async readFrames(conn: Conn): Promise<{ frames: number; packets: number | undefined } | undefined> {
    const read = ++conn.framesReads
    let frames: number
    let packets: number | undefined
    try {
      const stats = readStats(await conn.pc.getStats(), this.linkOf(conn.pc))
      frames = stats.frames ?? -1
      packets = stats.packets
    } catch {
      return undefined
    }
    if (read < conn.framesTaken) return undefined
    conn.framesTaken = read
    return { frames, packets }
  }

  /** One look at a link's frames outside the sweep: a link just back up, or
   *  one whose seat is not live. One at a time per link; a look the link's
   *  rebuild or the mesh's close overtook marks nothing. True when it saw new frames. */
  private async probeFrames(peerId: string, conn: Conn): Promise<boolean> {
    const stateSeen = conn.pc.connectionState // what the gate saw, not a drop during the await
    if (this.closed || this.conns.get(peerId) !== conn || stateSeen !== "connected" || conn.probing) return false
    conn.probing = true
    const read = await this.readFrames(conn).finally(() => (conn.probing = false))
    const frames = read?.frames
    // a link with no sweep reading yet takes its packet baseline from this look (#1917); a later one is the sweep's alone
    if (read && conn.sweepPackets === undefined && this.conns.get(peerId) === conn) conn.sweepPackets = read.packets
    if (frames === undefined || this.closed || this.conns.get(peerId) !== conn || !advanced(frames, conn.framesSeen)) return false
    this.observePeerInput(peerId, "stats-observed", conn, (roomEpoch, connectionEpoch) => ({
      type: "stats-observed",
      readSequence: conn.framesTaken,
      framesDecoded: frames,
      browserConnectionState: stateSeen,
      roomEpoch,
      connectionEpoch,
    }))
    this.sawFrames(peerId, conn, frames, monoNow())
    return true
  }

  /** Synchronous per-peer connection health for the UI (no getStats await). The
   *  connection-status layer (red X = never connected, etc.) is derived from this.
   *  `failCount` is the actor's: the recovery attempts since the link was last
   *  up or the peer last came back. Only Mesh's tests read it. */
  health(): Map<string, { conn: RTCPeerConnectionState; ice: RTCIceConnectionState; everConnected: boolean; gaveEndpoint: boolean; createdAt: number; failCount: number; recovering: boolean; recoveryStartedAt?: number }> {
    const out = new Map<string, { conn: RTCPeerConnectionState; ice: RTCIceConnectionState; everConnected: boolean; gaveEndpoint: boolean; createdAt: number; failCount: number; recovering: boolean; recoveryStartedAt?: number }>()
    const now = monoNow()
    for (const [id, c] of this.conns) {
      const justDropped = c.downAt > 0 && now - c.downAt < DROP_CHASE_MS
      const fresh = now - c.lastSignalAt < PRESENCE_FRESH_MS
      const startedAt = this.recoveryStartedAt.get(id)
      const recovering =
        c.everConnected &&
        c.pc.connectionState !== "connected" &&
        c.away !== "said" &&
        (fresh || justDropped) &&
        (justDropped || this.heal.isOpen(id)) &&
        startedAt !== undefined
      out.set(id, {
        conn: c.pc.connectionState,
        ice: c.pc.iceConnectionState,
        everConnected: c.everConnected,
        gaveEndpoint: c.gaveEndpoint,
        createdAt: c.createdAt,
        failCount: this.runner.state(id)?.budgets.failCount ?? 0,
        recovering,
        ...(startedAt !== undefined ? { recoveryStartedAt: startedAt } : {}),
      })
    }
    return out
  }

  removePeer(peerId: string) {
    this.recoveryStartedAt.delete(peerId)
    const conn = this.conns.get(peerId)
    if (!conn) return
    this.observePeerInput(peerId, "peer-removed", conn, (roomEpoch, connectionEpoch) => ({
      type: "peer-removed", roomEpoch, connectionEpoch,
    }))
    // The actor's close-connection removed it; one it could not take is
    // removed all the same. Its closed actor stays: a rejoin this round keeps
    // the round's spent budgets (startActor).
    if (this.conns.get(peerId) !== conn) return
    this.dropPeer(peerId, conn)
  }

  /** removePeer's effect: the peer left the room, and its connection closes. */
  private dropPeer(peerId: string, conn: Conn) {
    // what the actor's commands would have taken for this peer
    for (const held of [this.statementInbound, this.laneInbound, this.statementAnswering, this.laneAnswering, this.refusedOffers, this.lastWire]) held.delete(peerId)
    this.endAnswering(peerId)
    this.codecGuards.delete(peerId)
    // remember state so a rejoin reads "reconnecting", not "never connected";
    // the actor forgets the peer's failures with it (peer-removed)
    this.saveHistory(peerId)
    this.answererMayOffer.delete(peerId) // a genuine leave → back to initiator-only on rejoin
    this.videoAt.delete(peerId) // a player who left takes their face with them
    this.latestRelayPath.delete(peerId)
    this.markBack(peerId, conn, "peer_left") // a peer that left the mesh is no longer "away"
    conn.outbox.length = 0 // the frames were for a player who left; a rejoin is a new session
    this.closeChannel(conn)
    conn.pc.close()
    this.conns.delete(peerId)
    this.opts.onLinkChange?.(peerId)
    this.notifyActiveVideoSendersChanged()
    this.heal.leave(peerId, monoNow())
    this.healCohort.left(peerId)
  }

  private notifyActiveVideoSendersChanged(): void {
    let count = 0
    for (const { pc } of this.conns.values()) {
      if (pc.connectionState !== "connected") continue
      if (pc.getSenders().some((sender) => sender.track?.kind === "video")) count++
    }
    safely(() => this.opts.onActiveVideoSendersChanged?.(count))
  }

  /** a number per RTCPeerConnection, so a rebuilt one's restarted counters
   *  are never read as a delta of the old one's */
  private statsLinks = new WeakMap<RTCPeerConnection, number>()
  /** the last read of each connection's repair formats, by its descriptions (sdpOf) */
  private sdpMemo = new WeakMap<RTCPeerConnection, { local?: string; remote?: string; sdp?: SdpVideo }>()
  private nextLink = 1
  private linkOf(pc: RTCPeerConnection): number {
    let link = this.statsLinks.get(pc)
    if (link === undefined) {
      link = this.nextLink++
      this.statsLinks.set(pc, link)
    }
    return link
  }

  /** The repair formats a connection negotiated, read once per pair of
   *  current descriptions: the report runs every 3 s and a description only
   *  changes on a (re)negotiation. Read-only: nothing here touches the SDP. */
  private sdpOf(pc: RTCPeerConnection): SdpVideo | undefined {
    try {
      const local = pc.currentLocalDescription?.sdp
      const remote = pc.currentRemoteDescription?.sdp
      const memo = this.sdpMemo.get(pc)
      if (memo && memo.local === local && memo.remote === remote) return memo.sdp
      const sdp = sdpVideoFeatures(local, remote)
      this.sdpMemo.set(pc, { local, remote, sdp })
      return sdp
    } catch {
      return undefined
    }
  }

  /** Live per-peer state for the debug inspector — connection/ICE states, track
   *  kinds, the selected candidate pair, and inbound video frame count. */
  async report(): Promise<PeerReport[]> {
    const out: PeerReport[] = []
    // Snapshot entries first: getStats() awaits, and the supervisor's interval
    // can rebuild/delete conns mid-iteration.
    for (const [id, { pc, gather }] of [...this.conns]) {
      const statsLink = this.linkOf(pc)
      const r: PeerReport = {
        id,
        away: Boolean(this.conns.get(id)?.away),
        conn: pc.connectionState,
        ice: pc.iceConnectionState,
        gather: pc.iceGatheringState,
        sig: pc.signalingState,
        send: pc.getSenders().map((s) => s.track?.kind ?? "∅"),
        recv: pc.getReceivers().map((s) => s.track?.kind ?? "∅"),
        gathered: gather.snapshot(),
        statsLink,
        rtcpClock: { samples: [], unavailableReason: "stats-threw" },
      }
      try {
        // the ONE getStats of this report: the pair, the frames and the
        // quality sample all come from this walk
        const stats = await pc.getStats()
        const read = readStats(stats, statsLink)
        if (read.pair !== undefined) r.pair = read.pair
        if (read.frames !== undefined) r.frames = read.frames
        if (read.frames !== undefined && read.frames > 0) {
          if (!this.reached.get(id)?.has("first_frame")) this.markStage(id, "first_frame")
          this.markRoundLink(id, "first-video")
        }
        r.quality = read.quality
        // a pair that moved with no event for it (an engine without one)
        const conn = this.conns.get(id)
        if (read.quality && conn?.pc === pc) this.takePath(id, conn, pathOf(read.quality))
        if (read.quality?.localType === "relay") {
          // the browser's relayProtocol, else the TURN url's transport (an iPhone's)
          const relay = resolvedRelay(read.quality)
          this.latestRelayPath.set(id, {
            relayProtocol: relay.source === "unsupported" ? undefined : relay.protocol,
            relayProtocolSource: relay.source,
            turnEndpointHost: read.quality.relayHost,
          })
        } else if (read.quality) this.latestRelayPath.delete(id)
        r.rtcpClock = readRtcpClockEvidence(stats)
      } catch {
        /* getStats unavailable — leave pair/frames/quality undefined */
      }
      const sdp = this.sdpOf(pc)
      if (sdp) r.sdp = sdp
      const stage = [...(this.reached.get(id) ?? [])].pop() // the furthest this peer got, for a join that ends with it pending
      if (stage) r.stage = stage
      out.push(r)
    }
    return out
  }


  // ── the steps the actor's effects share ──────────────────────────────────
  // Each is the bookkeeping one restart or rebuild does around it, named by
  // the actor command (restart-ice, replace-connection, yield-responder) and
  // cause it serves.

  /** The round as players count it, for the logs, or none. */
  private roundLabel(): string {
    return this.round === null || this.round === undefined ? "none" : String(this.round + 1)
  }

  /** restart-ice, cause soft-disconnect: the answerer may offer (the actor
   *  counted the attempt). */
  private letAnswererRecover(peerId: string) {
    // Let the answerer drive its own recovery: with this set, its onnegotiationneeded
    // is allowed to offer, so an asymmetric drop heals without waiting on the
    // initiator (whose PC may still read "connected"). Perfect negotiation resolves
    // any glare if both sides re-offer.
    if (this.myId >= peerId) this.answererMayOffer.add(peerId)
  }

  /** restart-ice, cause soft-disconnect, before restartIce. */
  private beginRecoveryRestart(peerId: string, attempt: number) {
    this.awayPeriods.attempt(peerId, "ice_restart")
    rtcLog("[jollity-rtc] self-heal: ICE restart", peerId, `(attempt ${attempt})`)
  }

  /** replace-connection for a link that is down (failed, soft-disconnect,
   *  connect-by-deadline, and the stall causes), before rebuildPeer: the heal
   *  record. `afterRestart`: the ICE restart threw first
   *  (supervisor-recovery-restart-failed). */
  private beginRecoveryRebuild(peerId: string, trigger: HealTrigger, afterRestart: boolean, attempt: number, at: number) {
    if (afterRestart) this.awayPeriods.fallback(peerId, "rebuild")
    else this.awayPeriods.attempt(peerId, "rebuild")
    if (!afterRestart) rtcLog("[jollity-rtc] self-heal: rebuild", peerId, `(attempt ${attempt})`)
    this.heal.begin(peerId, trigger, "rebuild", at)
  }

  /** replace-connection, cause channel-never-opened: connected, and the
   *  channel never opened (beginRecoveryRebuild follows). */
  private beginChannelStallRebuild(peerId: string, conn: Conn) {
    rtcLog(`[jollity-rtc] channel-stall: never-open peer=${peerId} signalingState=${conn.pc.signalingState} round=${this.roundLabel()} → rebuild`)
  }

  /** replace-connection, cause connected-no-video: the channel is open and no
   *  video came (beginRecoveryRebuild follows). */
  private beginNoVideoRebuild(peerId: string, conn: Conn, now: number) {
    conn.lastMediaHealAt = now
    rtcLog(`[jollity-rtc] media-stall: no-video-rebuild peer=${peerId} signalingState=${conn.pc.signalingState} round=${this.roundLabel()} connected channel open but no inbound video → rebuild`)
  }

  /** The media-stall heal: restart-ice, or (`rebuild`) replace-connection,
   *  with cause media-stall; `heal` is the actor's count of this stall's
   *  heals, this one included. */
  private beginStallHeal(peerId: string, conn: Conn, now: number, rebuild: boolean, heal: number) {
    conn.lastMediaHealAt = now
    conn.framesStalls = 0
    const what = "media-stall: connected but no inbound video"
    // The answerer's onnegotiationneeded is gated, so restartIce alone wouldn't emit
    // an offer for a higher-id peer — grant the recovery permission (cleared on `connected`).
    if (!isInitiator(this.myId, peerId)) this.answererMayOffer.add(peerId)
    if (rebuild) {
      rtcLog(`[jollity-rtc] ${what} → rebuild (heal ${heal})`, peerId)
      return
    }
    rtcLog(`[jollity-rtc] ${what} → ICE restart (heal ${heal})`, peerId)
  }

  /** restart-ice, cause peer-no-video, before restartIce. The actor caps this
   *  at UNSEEN_ICE_RESTARTS per unseen episode (the budget refills once the
   *  peer sees our video again); `heal` is the actor's count of unseen heals,
   *  this one included, so the last one of the episode says so. */
  private beginUnseenRestart(peerId: string, conn: Conn, now: number, heal: number) {
    conn.lastMediaHealAt = now
    conn.framesStalls = 0
    const last = heal >= UNSEEN_ICE_RESTARTS ? ", the last until the peer sees us again" : ` (heal ${heal})`
    rtcLog(`[jollity-rtc] unseen: signalingState=${conn.pc.signalingState} the peer says it decodes none of our video → ICE restart${last}`, peerId)
  }

  /** networkChanged, on each link: the answerer may offer (the actor timed the attempt). */
  private beginNetworkRepair(peerId: string) {
    if (this.myId >= peerId) this.answererMayOffer.add(peerId)
  }

  /** networkChanged: the ICE restart went out. */
  private networkRestarted(peerId: string, now: number) {
    rtcLog("[jollity-rtc] network changed: ICE restart", peerId)
    this.heal.begin(peerId, "network_change", "ice_restart", now)
  }

  /** networkChanged's rebuild, before rebuildPeer. */
  private beginNetworkRebuild(peerId: string, now: number) {
    this.awayPeriods.attempt(peerId, "rebuild")
    rtcLog("[jollity-rtc] network changed: rebuild", peerId)
    this.heal.begin(peerId, "network_change", "rebuild", now)
  }

  /** yield-responder, before its responder-only rebuild (replace-connection,
   *  cause answer-timeout-yield), at the attempt's time. */
  private beginYield(peerId: string, attempt: number, at: number) {
    this.awayPeriods.attempt(peerId, "yield")
    rtcLog("[jollity-rtc] self-heal: rebuild responder-only", peerId, `(attempt ${attempt})`)
    this.heal.begin(peerId, "answer_timeout", "rebuild", at)
  }

  /** replace-connection for a hard SDP refusal (hard-sdp-immediate,
   *  hard-sdp-unseen, peer-no-video-hard-sdp), whose round budget the actor
   *  claimed. */
  private beginNegotiationRebuild(peerId: string, step: "immediate" | "unseen") {
    this.awayPeriods.attempt(peerId, "rebuild")
    if (!isInitiator(this.myId, peerId)) this.answererMayOffer.add(peerId)
    const now = monoNow()
    this.heal.begin(peerId, "negotiation_error", "rebuild", now, step === "unseen" ? "unseen" : undefined)
    rtcLog(`[jollity-rtc] hard lane negotiation error → ${step} rebuild`, peerId)
  }

  /** replace-connection, cause lane-glare-video (a rebuild instead of a
   *  rollback, once video is negotiated), before rebuildPeer: one per peer per
   *  round, and an attempt the actor counted toward its backoff, at the
   *  attempt's time. */
  private beginGlareRebuild(peerId: string, now: number) {
    this.awayPeriods.attempt(peerId, "rebuild")
    rtcLog("[jollity-rtc] glare on lane with video negotiated: rebuild instead of rolling back", peerId)
    if (!isInitiator(this.myId, peerId)) this.answererMayOffer.add(peerId)
    this.heal.begin(peerId, this.heal.openTrigger(peerId) ?? "glare_rebuild", "rebuild", now)
  }

  /** replace-connection for a rejoin (description-session-rejoin,
   *  signalling-session-rejoin, offer-refused-rejoin), before rebuildPeer: a
   *  rejoin healed by a rebuild, and the peer back. */
  private beginRejoin(
    peerId: string,
    cause: "session_rejoin" | "offer_refused_rejoin" = "session_rejoin",
    offerer: AwayOfferer = "none",
  ) {
    this.heal.begin(peerId, "rejoin_offer", "rebuild", monoNow())
    const old = this.conns.get(peerId)
    if (old) this.markBack(peerId, old, cause, offerer) // it is back: the rebuild carries this over
  }

  /** A connection made for a peer just heard from (a rejoin, a stranded initiate). */
  private heardOnFresh(peerId: string, fresh: Conn) {
    fresh.lastSignalAt = monoNow()
    fresh.gaveEndpoint = true
    this.opts.onLinkChange?.(peerId)
  }

  /** initiateStrandedPeer, before its rebuild: this side offers on the fresh connection. */
  private beginStrandedInitiate(peerId: string, reason: string) {
    this.awayPeriods.attempt(peerId, "stranded_offer")
    rtcLog("[jollity-rtc] first-contact offer not applied → initiate", peerId, reason)
    this.answererMayOffer.add(peerId)
  }

  // ── the peer actor's authority ───────────────────────────────────────────
  // Every peer fact above goes to the runner, and the actor's commands are
  // the only decisions Mesh acts on. Each effect runs the decision with the
  // bookkeeping around it (the answerer's leave to offer, the heal record,
  // the away periods). The counts and the attempt's time are the actor's,
  // which the command carries: the rtcLog "self-heal" and "(heal n)" lines
  // print them. An
  // effect on a connection the command was not issued for has no effect and
  // completes stale.

  /** The connection Mesh holds, for an actor that does not hold it: the
   *  fresh one Mesh made itself (rebuildPeer's `external`), or one the actor
   *  fell behind or ahead of. The actor adopts it as an attempt, timed by
   *  the fact's clock. */
  private tellReplacedExternally(peerId: string, conn: Conn) {
    this.observePeerInput(peerId, "connection-replaced-externally", conn, (roomEpoch, connectionEpoch) => ({
      type: "connection-replaced-externally", roomEpoch, connectionEpoch,
    }))
  }

  /** Start the peer's actor at this connection, when it has none or its last
   *  one closed (a first meeting, or a return after removePeer). An open
   *  actor at another connection (one that missed a fact, a peer-removed it
   *  could not take) moves to this one by connection-replaced-externally. */
  private startActor(peerId: string, conn: Conn) {
    const runner = this.runner
    const current = runner.state(peerId)
    if (current && current.link !== "closed") {
      if (current.connectionEpoch !== conn.decisionConnectionEpoch) this.tellReplacedExternally(peerId, conn)
      return
    }
    const state = createPeerActorState(
      { game: this.actorGame, roomEpoch: this.opts.decisionRoomEpoch ?? 0, peer: peerId },
      {
        initiator: isInitiator(this.myId, peerId),
        standby: conn.standby,
        cameraLive: this.local.getVideoTracks().some((track) => track.readyState === "live"),
        connectionEpoch: conn.decisionConnectionEpoch,
        // what Mesh's history keeps of a peer that left and rejoins
        everConnected: conn.everConnected,
        firstHeardAt: Number.isFinite(conn.firstHeardAt) ? conn.firstHeardAt : null,
        connectingSince: monoNow(),
      },
    )
    state.roundGeneration = this.roundGeneration
    state.hidden = this.selfAway
    if (current && current.roundGeneration === this.roundGeneration) {
      // A peer that left and rejoins this round: the round's budgets stay
      // spent, as Mesh's per-round maps keep them across removePeer.
      const { noVideoRebuilds, negotiationImmediate, negotiationUnseen, glareRebuilds } = current.budgets
      state.budgets = { ...state.budgets, noVideoRebuilds, negotiationImmediate, negotiationUnseen, glareRebuilds }
    }
    runner.add(peerId, state)
    this.actorSummary.started()
  }

  /** Keep an awaited command's promise until it settles (settleActorWork). */
  private track<Effect>(peerId: string, effect: Effect): Effect {
    if (typeof (effect as Promise<unknown> | undefined)?.then !== "function") return effect
    const promise = effect as Promise<unknown>
    let work = this.actorWork.get(peerId)
    if (!work) this.actorWork.set(peerId, (work = new Set()))
    work.add(promise)
    const done = () => {
      work.delete(promise)
      if (work.size === 0 && this.actorWork.get(peerId) === work) this.actorWork.delete(peerId)
    }
    promise.then(done, done)
    return effect
  }

  /** Wait out the peer's awaited commands, those they lead to included (an
   *  applied offer's answer): a fact's handler returns when its work is
   *  done. */
  private async settleActorWork(peerId: string): Promise<void> {
    for (let work = this.actorWork.get(peerId); work && work.size > 0; work = this.actorWork.get(peerId)) {
      await Promise.allSettled([...work])
    }
  }

  /** The runner's effect: one actor command, run against the browser. */
  private executePeerCommand(peerId: string, command: PeerActorCommand): ReturnType<PeerCommandEffect> {
    const conn = this.conns.get(peerId)
    if (command.kind === "replace-connection") return this.replaceForActor(peerId, conn, command, command.answererMayOffer === true)
    if (!conn || conn.decisionConnectionEpoch !== command.connectionEpoch) return { outcome: "stale" }
    switch (command.kind) {
      case "restart-ice":
        return this.restartForActor(peerId, conn, command)
      case "yield-responder":
        // before its rebuild (the replace-connection that follows)
        this.beginYield(peerId, command.attempt ?? 0, command.at ?? monoNow())
        return
      case "set-remote-description":
        return this.applyRemoteForActor(peerId, conn, command.lane)
      case "send-answer":
        return this.answerForActor(peerId, conn, command.lane)
      case "send-offer":
        return this.offerForActor(peerId, conn, command.lane)
      case "rollback":
        return this.rollbackForActor(peerId, conn, command.cause)
      case "ignore-offer": {
        const lane = this.lastWire.get(peerId) === "lane"
        conn.ignoreOffer = true
        rtcLog(lane ? "[jollity-rtc] glare on lane: ignoring offer from" : "[jollity-rtc] glare: ignoring offer from", peerId)
        return
      }
      case "create-channel":
        // initiateStrandedPeer's and a refused offer's own channel, and the
        // offer on it: an established SCTP section fires no negotiationneeded
        this.answererMayOffer.add(peerId)
        this.createOfferChannel(peerId, conn)
        void this.offerOnStatement(peerId, conn)
        return
      case "replace-video-track":
        this.applyStandby(peerId, conn, command.track === null)
        return
      case "request-keyframe":
        this.requestKeyframe(conn, monoNow())
        return
      case "ask-keyframe":
        this.askKeyframe(peerId, conn, command.at ?? monoNow())
        return
      case "sweep":
        // a sweep of this link after a long absence; setSelfAway then supervises once
        // (the actor forgave the failures itself)
        if (conn.away === "timeout") this.markBack(peerId, conn, "own_absence_sweep")
        return
      case "configure-ice":
        try {
          conn.pc.setConfiguration({ ...this.pcConfig(), iceCandidatePoolSize: conn.poolSize })
        } catch (err) {
          rtcLog("[jollity-rtc] setConfiguration refused", peerId, describeError(err))
        }
        return
      case "close-connection":
        if (this.closed) {
          // the room closed: close() releases the rest
          this.closedByActor.add(conn)
          this.closeChannel(conn)
          try {
            conn.pc.close()
          } catch {
            /* ignore */
          }
        } else this.dropPeer(peerId, conn)
        return
      case "mark-away":
        // supervise's away-timeout: the link stayed down
        this.setAway(peerId, conn, "timeout")
        return
      case "mark-back":
        // setAway(null): the peer is back
        {
          const ending = this.awayReturns.get(peerId) ?? { cause: "said_back" as const, offerer: "none" as const }
          this.markBack(peerId, conn, ending.cause, ending.offerer)
        }
        return
    }
  }

  /** restart-ice at the site its cause names, with that site's own steps
   *  (the shared begin* helpers). A throw completes it rejected at the site:
   *  the actor then rebuilds for the supervisor's and the network change's
   *  restarts. */
  private restartForActor(peerId: string, conn: Conn, command: Extract<PeerActorCommand, { kind: "restart-ice" }>): PeerCommandResult {
    const cause = command.cause
    // the attempt time Mesh stamped on the fact the actor decided on
    const now = command.at ?? monoNow()
    const site = RESTART_SITES[cause]
    let trigger: HealTrigger
    // The steps before restartIce is looked at: the supervisor's restart
    // counts the attempt and a network change grants the answerer's offer,
    // then both rebuild without one (a rejection at their site: the actor rebuilds).
    // The media heals do nothing without it.
    if (cause === "soft-disconnect") this.letAnswererRecover(peerId)
    if (cause === "network-change") this.beginNetworkRepair(peerId)
    if (typeof conn.pc.restartIce !== "function") return { outcome: "rejected", ...(site ? { site } : {}) }
    switch (cause) {
      case "soft-disconnect":
        trigger = triggerOf(conn)
        this.beginRecoveryRestart(peerId, command.attempt ?? 0)
        break
      case "media-stall":
        trigger = "media_stall"
        this.beginStallHeal(peerId, conn, now, false, command.heal ?? 0)
        break
      case "peer-no-video":
        trigger = "peer_no_video"
        this.beginUnseenRestart(peerId, conn, now, command.heal ?? 0)
        break
      case "network-change":
        trigger = "network_change"
        break
      default:
        trigger = triggerOf(conn)
    }
    try {
      conn.pc.restartIce() // → onnegotiationneeded → a fresh-ICE offer over the lane
    } catch (err) {
      rtcLog("[jollity-rtc] restartIce failed", peerId, cause, describeError(err))
      return { outcome: "rejected", ...(site ? { site } : {}) }
    }
    if (cause === "network-change") this.networkRestarted(peerId, now)
    else this.heal.begin(peerId, trigger, "ice_restart", now)
    return { outcome: "resolved", ...(site ? { site } : {}) }
  }

  /** replace-connection: the steps for its cause (the shared begin*
   *  helpers), then rebuildPeer. `old` is the
   *  connection replaced, when it is the one the actor's command was issued after. */
  private replaceForActor(peerId: string, current: Conn | undefined, command: Extract<PeerActorCommand, { kind: "replace-connection" }>, grant = false): PeerCommandResult | void {
    const { cause, initiate, connectionEpoch: epoch } = command
    if (!current || current.decisionConnectionEpoch !== epoch - 1) {
      // Not the connection the command was issued after (or none: the peer
      // left): no effect. The actor moves to the one Mesh holds, behind or
      // ahead of it, timing the move as an attempt now.
      if (current) this.tellReplacedExternally(peerId, current)
      return { outcome: "stale" }
    }
    const old: Conn | undefined = current
    // the attempt time Mesh stamped on the fact the actor decided on
    const now = command.at ?? monoNow()
    const attempt = command.attempt ?? 0
    let rejoin = false
    let stranded = false
    /** the down link's rebuild, as the supervisor or the media sweep reaches it */
    const recoverRebuild = (trigger: HealTrigger) => {
      this.letAnswererRecover(peerId)
      this.beginRecoveryRebuild(peerId, trigger, false, attempt, now)
    }
    switch (cause) {
      case "failed":
      case "soft-disconnect":
        if (old) recoverRebuild(triggerOf(old))
        break
      case "connect-by-deadline":
        rtcLog("[jollity-rtc] connect-by deadline expired → rebuild", peerId)
        if (old) recoverRebuild(triggerOf(old))
        break
      case "gathering-stalled":
        if (old) {
          rtcLog("[jollity-rtc] gathering stalled → rebuild", peerId, "gathered", gatheredAttr(old.gather.seen()), "(host/srflx/relay)")
          recoverRebuild("gathering_stalled")
        }
        break
      case "channel-never-opened":
        if (old) {
          this.beginChannelStallRebuild(peerId, old)
          recoverRebuild(triggerOf(old))
        }
        break
      case "connected-no-video":
        if (old) {
          this.beginNoVideoRebuild(peerId, old, now)
          recoverRebuild("media_stall")
        }
        break
      case "media-stall":
        if (old) {
          this.beginStallHeal(peerId, old, now, true, command.heal ?? 0)
          recoverRebuild("media_stall")
        }
        break
      case "media-frozen":
        // #1917: still flat after the keyframe ask: a fresh connection, no ICE restart
        if (old) {
          old.lastMediaHealAt = now
          rtcLog("[jollity-rtc] media frozen: still no frame after the keyframe ask → rebuild", peerId)
          recoverRebuild("media_frozen")
        }
        break
      case "supervisor-recovery-restart-failed":
        // the soft-disconnect ICE restart threw, after its attempt was counted
        if (old) this.beginRecoveryRebuild(peerId, triggerOf(old), true, attempt, now)
        break
      case "answer-timeout-yield":
        // the responder-only rebuild, after the yield-responder command
        break
      case "stranded-yield-unanswered":
      case "stranded-offer-refused":
        // initiateStrandedPeer: a fresh connection this side offers on (create-channel follows)
        this.beginStrandedInitiate(peerId, cause)
        stranded = true
        break
      case "description-session-rejoin":
        // onRtc: a description from a new remote session. An answer to our
        // offer leaves the next offer to the answerer of the pair too.
        rejoin = true
        if (initiate && !isInitiator(this.myId, peerId)) this.answererMayOffer.add(peerId)
        rtcLog("[jollity-rtc] new remote session from", peerId, "→ rebuild")
        break
      case "signalling-session-rejoin":
        // onPeerSession: our recovery offer went to the old session, so the
        // answerer of the pair may offer on the fresh connection. The actor
        // decided that leave from the fact alone and carries it on the
        // command; it rebuilds as an offerer on either side, and mayOffer
        // decides the channel.
        rejoin = true
        if (grant) this.answererMayOffer.add(peerId)
        rtcLog("[jollity-rtc] new signalling session from", peerId, "→ rebuild")
        break
      case "offer-refused-rejoin":
        // the connection refused the peer's offer; the fresh one takes it
        rejoin = true
        rtcLog("[jollity-rtc] offer refused by the connection →", peerId, "rebuild")
        break
      case "answer-refused":
        // #1605: the peer's answer refused while our offer held the connection
        rtcLog("[jollity-rtc] answer refused by the connection →", peerId, "rebuild as offerer")
        break
      case "answer-displaced-rejoin":
        // #1606: our own offer took our answer's place; the fresh responder answers the peer's offer
        rtcLog("[jollity-rtc] answer displaced by our own offer →", peerId, "rebuild as responder")
        break
      case "hard-sdp-immediate":
      case "hard-sdp-unseen":
      case "peer-no-video-hard-sdp": {
        // a hard SDP refusal: the round's budget is the actor's
        this.beginNegotiationRebuild(peerId, cause === "hard-sdp-immediate" ? "immediate" : "unseen")
        break
      }
      case "lane-glare-video":
        // glare on a lane with video: rebuild instead of rolling back
        if (old) this.beginGlareRebuild(peerId, now)
        break
      case "network-change":
        // networkChanged: the channel is down, so a fresh connection
        if (old) {
          this.beginNetworkRepair(peerId)
          this.beginNetworkRebuild(peerId, now)
        }
        break
      case "network-change-restart-failed":
        this.beginNetworkRebuild(peerId, now)
        break
    }
    if (rejoin) this.beginRejoin(peerId, cause === "offer-refused-rejoin" ? "offer_refused_rejoin" : "session_rejoin")
    this.rebuildPeer(peerId, initiate)
    const fresh = this.conns.get(peerId)
    if (fresh && (rejoin || stranded)) this.heardOnFresh(peerId, fresh)
  }

  /** set-remote-description: the description held for it on its wire,
   *  applied to the connection the command was issued for. */
  private applyRemoteForActor(peerId: string, conn: Conn, lane: boolean): ReturnType<PeerCommandEffect> {
    if (lane) {
      const entry = this.laneInbound.get(peerId)
      if (!entry) return { outcome: "stale", site: "lane" }
      if (entry.type === "answer") return this.applyLaneAnswer(peerId, conn, entry.sdp, entry.generation)
      return this.applyLaneOffer(peerId, conn, entry.sdp, entry.generation).then((result) => {
        if (result.outcome === "resolved") this.laneAnswering.set(peerId, entry)
        return result
      })
    }
    const refused = this.refusedOffers.get(peerId)
    this.refusedOffers.delete(peerId)
    if (refused && refused.epoch + 1 === conn.decisionConnectionEpoch) return this.applyStatementOffer(peerId, conn, refused.entry, true)
    const entry = this.statementInbound.get(peerId)
    if (!entry) return { outcome: "stale" }
    if (entry.desc.type === "answer") return this.applyStatementAnswer(peerId, conn, entry.desc)
    return this.applyStatementOffer(peerId, conn, entry, false)
  }

  /** set-remote-description for a statement offer: the peer's offer applied. A refusal
   *  completes with its class (the actor re-initiates a connection that took
   *  nothing, or rebuilds for InvalidAccessError and retries on the fresh one). */
  private async applyStatementOffer(from: string, conn: Conn, entry: StatementInbound, retry: boolean): Promise<PeerCommandResult> {
    const { desc } = entry
    if (!retry) {
      if (conn.everConnected && conn.pc.connectionState !== "connected" && !this.heal.isOpen(from))
        this.heal.begin(from, "rejoin_offer", "answer", monoNow())
    }
    const answering = this.beginAnswering(from, conn, remoteSessionOf(desc.sdp)) // ended once its answer is set (sendStatementAnswer)
    try {
      await conn.pc.setRemoteDescription(desc)
    } catch (err) {
      this.endAnswering(from, answering)
      rtcLog("[jollity-rtc] onRtc error from", from, describeError(err))
      if (retry) return { outcome: "rejected", site: "statement-offer-retried", reason: sdpRejection(err) }
      const invalidAccess = hardNegotiationError(err) === "InvalidAccessError"
      const reason = !conn.pc.remoteDescription
        ? (this.strandedEligible(from, conn) ? "virgin-pc" : "other")
        : invalidAccess ? "invalid-access" : "other"
      if (reason === "invalid-access") this.refusedOffers.set(from, { entry, epoch: conn.decisionConnectionEpoch })
      return { outcome: "rejected", site: "statement-offer-received", reason, at: monoNow() }
    }
    if (this.conns.get(from) !== conn) return { outcome: "stale" }
    this.statementAnswering.set(from, { ...entry, applied: ++conn.offersApplied })
    this.markStage(from, "offer")
    rtcLog(`[jollity-rtc] remote offer video-dir ${from}: ${videoDir(desc.sdp)}`)
    return { outcome: "resolved" }
  }

  /** onRtc's answer: the peer's statement answer to our offer, applied. */
  private async applyStatementAnswer(from: string, conn: Conn, desc: RTCSessionDescriptionInit): Promise<PeerCommandResult> {
    const { pc } = conn
    const setting = { conn, session: remoteSessionOf(desc.sdp) }
    this.answerSetting.set(from, setting)
    try {
      await pc.setRemoteDescription(desc)
    } catch (err) {
      rtcLog("[jollity-rtc] onRtc error from", from, describeError(err))
      return { outcome: "rejected", site: "statement-answer", reason: sdpRejection(err), haveLocalOffer: pc.signalingState === "have-local-offer" }
    } finally {
      if (this.answerSetting.get(from) === setting) this.answerSetting.delete(from)
    }
    if (this.conns.get(from) !== conn) return { outcome: "stale" }
    this.answered(from, conn)
    this.markStage(from, "answer")
    rtcLog(`[jollity-rtc] remote answer video-dir ${from}: ${videoDir(desc.sdp)}`)
    await this.flushPendingCands(from, conn)
    return { outcome: "resolved" }
  }

  /** send-answer: our answer to the offer the actor applied. */
  private answerForActor(peerId: string, conn: Conn, lane: boolean): ReturnType<PeerCommandEffect> {
    if (lane) {
      const entry = this.laneAnswering.get(peerId)
      this.laneAnswering.delete(peerId)
      if (!entry) return { outcome: "stale", site: "lane" }
      return this.answerLane(peerId, conn, entry.generation)
    }
    const entry = this.statementAnswering.get(peerId)
    this.statementAnswering.delete(peerId)
    if (entry?.applied === undefined) return { outcome: "stale", site: "statement-answer" }
    const { applied, gen } = entry
    return (async (): Promise<PeerCommandResult> => {
      let sent: "sent" | "stale" | "displaced"
      try {
        sent = await this.sendStatementAnswer(peerId, conn, applied, gen)
      } catch (err) {
        rtcLog("[jollity-rtc] onRtc error from", peerId, describeError(err))
        return { outcome: "rejected", site: "statement-answer", reason: sdpRejection(err) }
      }
      if (sent === "displaced") return { outcome: "stale", site: "statement-answer", displaced: true }
      if (sent === "stale") return { outcome: "stale", site: "statement-answer" }
      // Diagnostic: are WE actually set up to send a video track to this peer?
      rtcLog(`[jollity-rtc] our senders → ${peerId}: [${conn.pc.getSenders().map((s) => (s.track ? s.track.kind : "∅")).join(",")}]`)
      await this.flushPendingCands(peerId, conn)
      return { outcome: "resolved" }
    })()
  }

  /** send-offer: ours on the signalling wire or the lane, or the codec
   *  guard's stripped replacement when the guard's rollback is under way. */
  private offerForActor(peerId: string, conn: Conn, lane: boolean): ReturnType<PeerCommandEffect> {
    if (!lane) return this.makeStatementOffer(peerId, conn)
    const guard = this.codecGuards.get(peerId)
    if (guard?.rollback && !guard.offered && guard.pc === conn.pc) {
      guard.offered = true
      return this.guardOfferForActor(peerId, conn, guard)
    }
    return this.offerOnLane(peerId, conn)
  }

  /** rollback: implicit in applying the peer's offer (glare), the codec
   *  guard's, or a superseded lane offer's. */
  private rollbackForActor(peerId: string, conn: Conn, cause: "glare" | "codec-guard" | "superseded"): ReturnType<PeerCommandEffect> {
    if (cause === "glare") {
      // perfect negotiation: applying the offer rolls ours back (set-remote-description follows)
      return { outcome: "resolved" }
    }
    if (cause === "codec-guard") {
      const guard = this.codecGuards.get(peerId)
      if (!guard || guard.pc !== conn.pc || guard.rollback) return { outcome: "stale", site: "lane" }
      guard.rollback = this.rollbackLocal(guard.pc, guard.generation)
        .then((rolled) => this.laneStepFailed(peerId, conn, rolled, guard.generation))
      return guard.rollback
    }
    // "superseded" answers local-offer-superseded, a fact this Mesh never
    // reports: there is no offer of ours to roll back
    return { outcome: "stale", site: "lane" }
  }

  /** A lane step's refusal is the error's telemetry (laneNegotiationFailed);
   *  the actor decides any rebuild from the result. */
  private laneStepFailed(peerId: string, conn: Conn, result: LocalStepResult, generation: number): LocalStepResult {
    if (result.outcome === "rejected") this.laneNegotiationFailed(peerId, conn, result.error, "offer", "set-local", generation)
    return result
  }

  /**
   * THE EXPOSED SIDE'S SECOND LAYER (#559). Only an offerer on an engine with
   * the M111–M123 RTX bug can go dark, and its own codec
   * preferences are what keep RTX out of its offer. If they did not hold and
   * the offer just set still carries RTX, roll it back and set a fresh offer
   * with the video RTX stripped, so the local description and the one sent
   * are the same text; and say so (codec_guard offer-rtx). A safe engine, or
   * an offer without RTX, passes untouched. The actor is told
   * (codec-guard-rtx), and its rollback and send-offer run the guard. True
   * while the connection still holds the stripped offer; false: the PC moved
   * on (a remote offer, a rebuild) and nothing may be sent.
   */
  private async guardOfferRtxByActor(peerId: string, conn: Conn, generation: number): Promise<boolean> {
    const { pc } = conn
    if (!this.codecGuardNeeded(peerId, pc)) return true
    let done!: (current: boolean) => void
    const finished = new Promise<boolean>((resolve) => { done = resolve })
    const guard: CodecGuardWork = { pc, generation, offered: false, done }
    this.withStash(this.codecGuards, peerId, guard, () => this.observePeerInput(peerId, "codec-guard-rollback", conn, (roomEpoch, connectionEpoch) => ({
      type: "codec-guard-rtx", roomEpoch, connectionEpoch,
    })))
    // the actor did not take it (its connection moved on): nothing may be sent
    if (!guard.offered) return false
    return finished
  }

  /** The codec guard's send-offer: after its rollback, a fresh offer with the
   *  video RTX stripped, set while the connection is still stable. */
  private async guardOfferForActor(peerId: string, conn: Conn, guard: CodecGuardWork): Promise<PeerCommandResult> {
    let current = false
    try {
      if ((await guard.rollback!).outcome !== "resolved") return { outcome: "stale", site: "lane" }
      const offered = this.laneStepFailed(peerId, conn, await this.stripAndSetOffer(peerId, guard.pc, guard.generation), guard.generation)
      current = offered.outcome === "resolved"
      return offered
    } finally {
      guard.done(current)
    }
  }

  close() {
    this.closed = true
    for (const peerId of [...this.answering.keys()]) this.endAnswering(peerId)
    this.actorSummary.close()
    for (const [peerId, conn] of [...this.conns]) {
      this.observePeerInput(peerId, "room-closed", conn, (roomEpoch, connectionEpoch) => ({ type: "room-closed", roomEpoch, connectionEpoch }))
      this.runner.remove(peerId)
    }
    try {
      let inFlight = 0
      for (const work of this.actorWork.values()) inFlight += work.size
      this.actorSummary.write(inFlight)
    } catch { /* telemetry cannot abort teardown */ }
    this.heal.closeAll(monoNow(), (peerId) => this.conns.get(peerId)?.pc.connectionState === "connected")
    this.awayPeriods.closeAll(monoNow())
    this.awayReturns.clear()
    this.healCohort.close()
    clearInterval(this.superviseTimer)
    clearInterval(this.mediaTimer)
    this.videoAt.clear()
    this.recoveryStartedAt.clear()
    this.latestRelayPath.clear()
    for (const conn of this.conns.values()) {
      if (this.closedByActor.has(conn)) continue
      this.closeChannel(conn)
      try {
        conn.pc.close()
      } catch {
        /* ignore */
      }
    }
    this.conns.clear()
  }
}
