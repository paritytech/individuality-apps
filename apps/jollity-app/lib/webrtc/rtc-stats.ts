// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LINK QUALITY, read off the getStats the mesh's report already makes. Pure:
 * no imports at all, so lib/journeys/rtc-quality.ts (loaded on every route
 * through the game trace) reads these without pulling in the Mesh, its
 * statement-core codec or its module-top side effects. lib/webrtc/mesh.ts
 * calls readStats; rtc-quality calls rtcRates.
 *
 * Raw readings only: counters stay cumulative, and rtcRates turns two
 * consecutive samples of one link into rates over the window between them.
 * lib/journeys/rtc-quality.ts summarises them per round. Seconds become ms
 * here, once.
 */

/** inbound video, as received from the peer */
export interface InboundVideo {
  /** the stats id: counters of another stream are never subtracted */
  id: string
  fps?: number
  width?: number
  height?: number
  framesDecoded?: number
  framesDropped?: number
  freezeCount?: number
  /** seconds, cumulative */
  totalFreezesDuration?: number
  jitterMs?: number
  packetsLost?: number
  packetsReceived?: number
  /** NACKs and PLIs WE sent the peer, cumulative: the network lost its packets */
  nackCount?: number
  pliCount?: number
  /** seconds in the jitter buffer, over the frames that left it (cumulative) */
  jitterBufferDelay?: number
  jitterBufferEmittedCount?: number
  /** seconds spent decoding, cumulative */
  totalDecodeTime?: number
  /** which decoder: "libvpx", "VideoToolbox", "MediaCodec", … (text, as reported) */
  decoderImplementation?: string
  /** true: a hardware decoder that spares the battery (Chrome only) */
  powerEfficientDecoder?: boolean
  /** the negotiated codec, off the codec report codecId names: "H264", "VP8" */
  codec?: string
  /** its fmtp, trimmed to profile-level-id and packetization-mode */
  codecFmtp?: string
}

/** our outbound video to the peer */
interface OutboundVideo {
  id: string
  fps?: number
  width?: number
  height?: number
  framesEncoded?: number
  framesSent?: number
  /** browser track identifier; callers must make it opaque before logging */
  trackIdentifier?: string
  /** what limits the encoder now: none | cpu | bandwidth | other */
  qualityLimitationReason?: string
  /** Instantaneous encoder target in bit/s. This is optional in the stats
   * specification and is deliberately left absent on engines that omit it. */
  targetBitrate?: number
  /** seconds spent per reason, cumulative */
  qualityLimitationDurations?: Record<string, number>
  bytesSent?: number
  /** RTP header bytes, cumulative (when exposed by the browser) */
  headerBytesSent?: number
  retransmittedPacketsSent?: number
  packetsSent?: number
  /** seconds packets spent waiting for the socket, cumulative */
  totalPacketSendDelay?: number
  /** NACKs and PLIs the peer sent US, cumulative: it lost our packets */
  nackCount?: number
  pliCount?: number
  /** seconds spent encoding, cumulative */
  totalEncodeTime?: number
  encoderImplementation?: string
  powerEfficientEncoder?: boolean
  codec?: string
  codecFmtp?: string
}

export interface RtcSample {
  /** which RTCPeerConnection: a rebuilt one restarts every counter */
  link: number
  /** the stats timestamp, ms */
  at?: number
  /** the selected pair's current round trip */
  rttMs?: number
  /** the selected pair's availableOutgoingBitrate, in kbit/s */
  outgoingKbps?: number
  /** Opaque selected candidate-pair id and its cumulative bytes. Keeping the
   * id prevents a pair switch from being mistaken for counter growth. */
  transportId?: string
  transportBytesSent?: number
  /** Cumulative conservative IP/UDP-or-TCP/TURN/TLS allowance for every
   * packet reported by every selected transport. */
  transportAllowanceBytesSent?: number
  localType?: string
  remoteType?: string
  /** the local candidate's protocol: udp or tcp */
  protocol?: string
  /** a local relay candidate's protocol to the TURN server: udp, tcp or tls
   *  (when the browser reports it) */
  relayProtocol?: string
  /** the same, as the relay candidate's TURN url names it (turns: is tls,
   *  ?transport=tcp is tcp, otherwise udp): WebKit leaves relayProtocol out
   *  but reports the url, so this is how an iPhone's relay is known */
  relayTransport?: "udp" | "tcp" | "tls"
  /** Selected-pair lifecycle evidence retained for relay diagnosis. */
  pairState?: string
  nominated?: boolean
  relayHost?: string
  /** Credential-free TURN endpoint (scheme, host, port, transport only). */
  relayEndpoint?: string
  transportBytesReceived?: number
  transportPacketsSent?: number
  transportPacketsReceived?: number
  requestsSent?: number
  responsesReceived?: number
  consentRequestsSent?: number
  lastPacketReceivedAt?: number
  /** the local candidate's network (Chrome only): wifi, cellular, … */
  networkType?: string
  inbound?: InboundVideo
  outbound?: OutboundVideo
}

/** what a getStats() report is to us: something to walk once */
export interface StatsLike {
  forEach(callback: (stat: unknown) => void): void
}

/** Fields whose change makes a selected relay path a new lifecycle row. The
 * connection generation is first: a rebuilt RTCPeerConnection may reuse the
 * browser's candidate-pair id, but its counters restarted and must not be
 * presented as a continuation. */
export function relayPairEvidenceSignature(sample: RtcSample): string {
  return [sample.link, sample.transportId, sample.pairState, sample.nominated, sample.protocol, sample.relayProtocol, sample.relayEndpoint].join("|")
}

/** "video/H264" -> "H264"; text without a subtype is not a codec name */
function codecName(mimeType: unknown): string | undefined {
  const name = str(mimeType)?.split("/")[1]?.trim()
  return name || undefined
}

/** The part of an fmtp line that names the variant: profile-level-id (which
 *  H.264 profile really runs, WebKit bugs 195124 and 259987) and
 *  packetization-mode. The rest (level-asymmetry, max-fs, ...) is noise. */
function trimFmtp(line: unknown): string | undefined {
  const text = str(line)
  if (!text) return undefined
  const kept: string[] = []
  for (const part of text.split(";")) {
    const [key, value] = part.split("=").map((piece) => piece.trim())
    if ((key === "profile-level-id" || key === "packetization-mode") && value) kept.push(`${key}=${value}`)
  }
  return kept.length ? kept.join(";") : undefined
}

type Stat = Record<string, unknown> & { type?: string; id?: string }

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)
function relayEndpoint(value: unknown): string | undefined {
  const match = /^(turns?):(?:[^@/?]+@)?(\[[^\]]+\]|[^:/?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(str(value) ?? "")
  if (!match) return undefined
  return `${match[1].toLowerCase()}:${match[2]}${match[3] ? `:${match[3]}` : ""}${match[4] ? `?transport=${match[4].toLowerCase()}` : ""}`
}
/** The transport a relayEndpoint names, the way a relay candidate's
 *  relayProtocol names it. It is turnTransport (./path-mode) for the already
 *  normalised endpoint; this file imports nothing, so rtc-stats.test.ts keeps
 *  the two in step instead. */
function endpointTransport(endpoint: string): "udp" | "tcp" | "tls" {
  if (endpoint.startsWith("turns:")) return "tls"
  return endpoint.endsWith("?transport=tcp") ? "tcp" : "udp"
}

/** A local relay's protocol to its TURN server, and which reading said it. */
export interface ResolvedRelay {
  protocol: string
  source: "stats" | "url" | "unsupported"
}

/** The browser's relayProtocol first, else the transport the relay
 *  candidate's TURN url names (all WebKit reports), else unsupported. */
export function resolvedRelay(q: Pick<RtcSample, "relayProtocol" | "relayTransport">): ResolvedRelay {
  if (q.relayProtocol) return { protocol: q.relayProtocol, source: "stats" }
  if (q.relayTransport) return { protocol: q.relayTransport, source: "url" }
  return { protocol: "unsupported", source: "unsupported" }
}
const ms = (seconds: unknown): number | undefined => {
  const value = num(seconds)
  return value === undefined ? undefined : value * 1000
}

function durations(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined
  const out: Record<string, number> = {}
  for (const [reason, seconds] of Object.entries(value)) if (num(seconds) !== undefined) out[reason] = seconds as number
  return out
}

/** When no transport names the selected pair (Safari), the pair read is the best
 *  of those that could be in use: a nominated one before one that merely
 *  succeeded, and the lower id between equals. The report's order never decides:
 *  two succeeded pairs listed in a different order each time would read as a
 *  path change. */
function fallbackPair(pairs: ReadonlyMap<string, Stat>): Stat | undefined {
  let best: Stat | undefined
  let bestRank = Infinity
  for (const pair of pairs.values()) {
    const rank = pair.nominated ? 0 : pair.state === "succeeded" ? 1 : Infinity
    if (rank < bestRank || (rank === bestRank && best && String(pair.id) < String(best.id))) {
      best = pair
      bestRank = rank
    }
  }
  return best
}

/** Key frames the encoder has produced on our outbound video, cumulative, summed
 *  over its streams; undefined when the browser reports no such counter. Pure. */
export function keyFramesEncoded(stats: StatsLike): number | undefined {
  let total: number | undefined
  stats.forEach((value) => {
    const stat = value as Stat
    if (stat.type === "outbound-rtp" && stat.kind === "video" && typeof stat.keyFramesEncoded === "number") total = (total ?? 0) + stat.keyFramesEncoded
  })
  return total
}

/** One walk over a getStats report: the pair string and frame count the
 *  report carries, and the quality sample. Both read the same pair: the one
 *  the transport selected, or the best nominated or succeeded one when the
 *  browser names none (Safari; fallbackPair). `pair` feeds the join's rtc.path. Pure. */
export function readStats(stats: StatsLike, link: number): { pair?: string; frames?: number; quality: RtcSample } {
  const candidates = new Map<string, Stat>()
  const pairs = new Map<string, Stat>()
  const selectedIds = new Set<string>()
  let inbound: Stat | undefined
  let outbound: Stat | undefined
  const codecs = new Map<string, Stat>()
  // frames decoded across EVERY inbound video stream of the link: a
  // renegotiation can leave an idle receiver beside the live one, and a stream
  // that replaced another starts its own count from 0
  let decoded: number | undefined
  stats.forEach((value) => {
    const stat = value as Stat
    switch (stat.type) {
      case "local-candidate":
      case "remote-candidate":
        if (stat.id) candidates.set(stat.id, stat)
        break
      case "candidate-pair":
        if (stat.id) pairs.set(stat.id, stat)
        break
      case "transport":
        {
          const selected = str(stat.selectedCandidatePairId)
          if (selected) selectedIds.add(selected)
        }
        break
      case "codec":
        if (stat.id) codecs.set(stat.id, stat)
        break
      case "inbound-rtp":
        if (stat.kind === "video") {
          inbound = stat
          decoded = (decoded ?? 0) + (num(stat.framesDecoded) ?? 0)
        }
        break
      case "outbound-rtp":
        if (stat.kind === "video") outbound = stat
        break
    }
  })
  const typeOf = (id: unknown) => str(candidates.get(str(id) ?? "")?.candidateType)
  const frames = decoded

  const quality: RtcSample = { link }
  const selectedPairs = [...selectedIds].sort().flatMap((id) => {
    const pair = pairs.get(id)
    return pair ? [pair] : []
  })
  if (!selectedPairs.length) {
    const fallback = fallbackPair(pairs)
    if (fallback) selectedPairs.push(fallback)
  }
  const chosen = selectedPairs[0]
  let pair: string | undefined
  const at = num(inbound?.timestamp) ?? num(outbound?.timestamp) ?? num(chosen?.timestamp)
  if (at !== undefined) quality.at = at
  if (chosen) {
    const transportIds = selectedPairs.flatMap((selected) => str(selected.id) ?? []).sort()
    if (transportIds.length) quality.transportId = transportIds.join("\u001f")
    const transportBytes = selectedPairs.map((selected) => num(selected.bytesSent))
    if (transportBytes.every((value): value is number => value !== undefined))
      quality.transportBytesSent = transportBytes.reduce((sum, value) => sum + value, 0)
    const transportAllowances = selectedPairs.map((selected) => {
      const local = candidates.get(str(selected.localCandidateId) ?? "")
      const relay = str(local?.candidateType) === "relay"
      const outer = str(local?.relayProtocol) ?? str(local?.protocol) ?? "udp"
      // IPv6 + UDP/TCP + TURN ChannelData + TLS record. TCP/TLS gets one
      // retransmission worth of headroom because getStats cannot expose it.
      const bytes = 40 + (outer === "udp" ? 8 : 20) + (relay ? 4 : 0) + (outer === "tls" ? 5 : 0)
      const packets = num(selected.packetsSent)
      return packets === undefined ? undefined : packets * (outer === "udp" ? bytes : bytes * 2)
    })
    if (transportAllowances.every((value): value is number => value !== undefined))
      quality.transportAllowanceBytesSent = transportAllowances.reduce((sum, value) => sum + value, 0)
    const rtt = ms(chosen.currentRoundTripTime)
    if (rtt !== undefined) quality.rttMs = rtt
    const bitrate = num(chosen.availableOutgoingBitrate)
    if (bitrate !== undefined) quality.outgoingKbps = bitrate / 1000
    const local = candidates.get(str(chosen.localCandidateId) ?? "")
    const localType = str(local?.candidateType)
    const remoteType = typeOf(chosen.remoteCandidateId)
    const networkType = str(local?.networkType)
    pair = `${localType ?? "?"}/${remoteType ?? "?"}`
    if (localType) quality.localType = localType
    if (remoteType) quality.remoteType = remoteType
    const protocol = str(local?.protocol)
    if (protocol) quality.protocol = protocol
    const relayProtocol = str(local?.relayProtocol)
    if (relayProtocol) quality.relayProtocol = relayProtocol
    const pairState = str(chosen.state)
    if (pairState) quality.pairState = pairState
    const nominated = bool(chosen.nominated)
    if (nominated !== undefined) quality.nominated = nominated
    const endpoint = relayEndpoint(local?.url)
    if (endpoint) {
      quality.relayEndpoint = endpoint
      quality.relayHost = /^(?:turns?):(\[[^\]]+\]|[^:/?]+)/i.exec(endpoint)?.[1]
      quality.relayTransport = endpointTransport(endpoint)
    }
    put(quality, "transportBytesReceived", num(chosen.bytesReceived))
    put(quality, "transportPacketsSent", num(chosen.packetsSent))
    put(quality, "transportPacketsReceived", num(chosen.packetsReceived))
    put(quality, "requestsSent", num(chosen.requestsSent))
    put(quality, "responsesReceived", num(chosen.responsesReceived))
    put(quality, "consentRequestsSent", num(chosen.consentRequestsSent))
    put(quality, "lastPacketReceivedAt", num(chosen.lastPacketReceivedTimestamp))
    if (networkType) quality.networkType = networkType
  }
  if (inbound) {
    const v: InboundVideo = { id: str(inbound.id) ?? "" }
    put(v, "fps", num(inbound.framesPerSecond))
    put(v, "width", num(inbound.frameWidth))
    put(v, "height", num(inbound.frameHeight))
    put(v, "framesDecoded", num(inbound.framesDecoded))
    put(v, "framesDropped", num(inbound.framesDropped))
    put(v, "freezeCount", num(inbound.freezeCount))
    put(v, "totalFreezesDuration", num(inbound.totalFreezesDuration))
    put(v, "jitterMs", ms(inbound.jitter))
    put(v, "packetsLost", num(inbound.packetsLost))
    put(v, "packetsReceived", num(inbound.packetsReceived))
    put(v, "nackCount", num(inbound.nackCount))
    put(v, "pliCount", num(inbound.pliCount))
    put(v, "jitterBufferDelay", num(inbound.jitterBufferDelay))
    put(v, "jitterBufferEmittedCount", num(inbound.jitterBufferEmittedCount))
    put(v, "totalDecodeTime", num(inbound.totalDecodeTime))
    put(v, "decoderImplementation", str(inbound.decoderImplementation))
    put(v, "powerEfficientDecoder", bool(inbound.powerEfficientDecoder))
    const codec = codecs.get(str(inbound.codecId) ?? "")
    put(v, "codec", codecName(codec?.mimeType))
    put(v, "codecFmtp", trimFmtp(codec?.sdpFmtpLine))
    quality.inbound = v
  }
  if (outbound) {
    const v: OutboundVideo = { id: str(outbound.id) ?? "" }
    put(v, "fps", num(outbound.framesPerSecond))
    put(v, "width", num(outbound.frameWidth))
    put(v, "height", num(outbound.frameHeight))
    put(v, "framesEncoded", num(outbound.framesEncoded))
    put(v, "framesSent", num(outbound.framesSent))
    put(v, "trackIdentifier", str(outbound.trackIdentifier))
    put(v, "qualityLimitationReason", str(outbound.qualityLimitationReason))
    put(v, "targetBitrate", num(outbound.targetBitrate))
    put(v, "qualityLimitationDurations", durations(outbound.qualityLimitationDurations))
    put(v, "bytesSent", num(outbound.bytesSent))
    put(v, "headerBytesSent", num(outbound.headerBytesSent))
    put(v, "retransmittedPacketsSent", num(outbound.retransmittedPacketsSent))
    put(v, "packetsSent", num(outbound.packetsSent))
    put(v, "totalPacketSendDelay", num(outbound.totalPacketSendDelay))
    put(v, "nackCount", num(outbound.nackCount))
    put(v, "pliCount", num(outbound.pliCount))
    put(v, "totalEncodeTime", num(outbound.totalEncodeTime))
    put(v, "encoderImplementation", str(outbound.encoderImplementation))
    put(v, "powerEfficientEncoder", bool(outbound.powerEfficientEncoder))
    const codec = codecs.get(str(outbound.codecId) ?? "")
    put(v, "codec", codecName(codec?.mimeType))
    put(v, "codecFmtp", trimFmtp(codec?.sdpFmtpLine))
    quality.outbound = v
  }
  return { pair, frames, quality }
}

/** set a field only when there is a value: a snapshot stays small and its
 *  objects keep their shape (no `delete` on a 3 s per-peer path) */
function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value
}

/** One window of a link: the instant readings of the later sample, and the
 *  rates between the two. Windowed fields are absent without an earlier
 *  sample of the SAME connection and stream, and for a counter that went
 *  backwards. */
export interface RtcRates {
  /** trusted same-link, same-stream interval; absent for a baseline-only sample */
  windowMs?: number
  rttMs?: number
  jitterMs?: number
  /** lost / (lost + received) in the window, percent */
  lossPct?: number
  inFps?: number
  outFps?: number
  inHeight?: number
  outHeight?: number
  /** our video bitrate to the peer, kbit/s */
  outKbps?: number
  /** instantaneous encoder target, kbit/s */
  targetKbps?: number
  /** inbound freeze time in the window */
  freezeMs?: number
  /** the window's seconds when the peer's video was PAUSED (see rtcRates):
   *  inFps and inHeight are left out then */
  pausedS?: number
  /** frames the decoder or renderer dropped in the window */
  framesDropped?: number
  /** NACKs and PLIs in the window: `In` is what we asked of the peer (the
   *  network lost its packets), `Out` what the peer asked of us */
  nackIn?: number
  pliIn?: number
  nackOut?: number
  pliOut?: number
  /** ms a frame waited in the jitter buffer, decoded, or encoded: the
   *  window's average per frame. A device that cannot keep up reads high here
   *  while loss and rtt are healthy. */
  bufferMs?: number
  decodeMs?: number
  encodeMs?: number
  /** seconds spent encoding in the window */
  encodeSeconds?: number
  /** packets sent in the window */
  packetsSent?: number
  /** frames encoded/sent in the window */
  framesEncoded?: number
  framesSent?: number
  /** average time each sent packet waited for the socket */
  queueMsPerPacket?: number
  /** payload and RTP-header byte growth in the window */
  bytesSent?: number
  headerBytesSent?: number
  /** selected ICE candidate-pair byte growth in the window. This includes
   * WebRTC transport traffic beyond outbound video payload. */
  transportBytesSent?: number
  /** Conservative IP/UDP-or-TCP/TURN/TLS and control-traffic allowance for
   * the selected transport set in this window. */
  transportAllowanceBytesSent?: number
  /** the pair's availableOutgoingBitrate, kbit/s: what the network would carry */
  availKbps?: number
  /** seconds the encoder spent limited, per reason ("none" left out) */
  limited: Record<string, number>
  /** reset-safe seconds for every reported limitation reason, including none */
  reasonDurations?: Record<string, number>
}

/** a counter's growth, or undefined when it cannot be trusted */
function grew(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined || after < before) return undefined
  return after - before
}

/** ms per frame over a window, from a cumulative seconds counter and its
 *  cumulative frame counter; none when no frame passed in it */
function perFrame(secondsBefore: number | undefined, secondsAfter: number | undefined, framesBefore: number | undefined, framesAfter: number | undefined): number | undefined {
  const seconds = grew(secondsBefore, secondsAfter)
  const frames = grew(framesBefore, framesAfter)
  return seconds === undefined || !frames ? undefined : (seconds * 1000) / frames
}

/** Below this many video packets a second, with no frame decoded, the peer
 *  is not sending: a locked phone pauses its camera. */
const PAUSED_MAX_PACKETS_PER_S = 1

/** Rates between two consecutive samples of one peer. Pure.
 *
 *  A PAUSED peer (its phone locked or the app backgrounded) sends no frames:
 *  framesPerSecond goes absent and the decoded-frames fallback reads 0, so
 *  its inbound fps and height would read as a broken link while rtt and loss
 *  are healthy. A window where no frame was decoded AND the video packets
 *  barely grew is paused: it carries `pausedS` instead of inFps and inHeight.
 *  Packets still arriving with no frame decoded is a real decoder stall, and
 *  counts. Without a frame counter nothing is called paused. */
export function rtcRates(prev: RtcSample | undefined, cur: RtcSample): RtcRates {
  const rates: RtcRates = { limited: {} }
  if (cur.rttMs !== undefined) rates.rttMs = cur.rttMs
  if (cur.outgoingKbps !== undefined) rates.availKbps = cur.outgoingKbps
  const inbound = cur.inbound
  const outbound = cur.outbound
  if (outbound?.targetBitrate !== undefined) rates.targetKbps = outbound.targetBitrate / 1_000
  const windowMs = prev && prev.link === cur.link && prev.at !== undefined && cur.at !== undefined ? cur.at - prev.at : 0
  const windowed = windowMs > 0 && windowMs <= 6_000
  const seconds = windowed ? windowMs / 1000 : 0
  const sameIn = windowed && inbound && prev!.inbound?.id === inbound.id ? prev!.inbound : undefined
  const sameOut = windowed && outbound && prev!.outbound?.id === outbound.id ? prev!.outbound : undefined
  const decoded = sameIn ? grew(sameIn.framesDecoded, inbound!.framesDecoded) : undefined
  const received = sameIn ? grew(sameIn.packetsReceived, inbound!.packetsReceived) : undefined
  const paused = decoded === 0 && received !== undefined && received < PAUSED_MAX_PACKETS_PER_S * seconds

  if (inbound?.jitterMs !== undefined) rates.jitterMs = inbound.jitterMs
  if (inbound?.height !== undefined && !paused) rates.inHeight = inbound.height
  if (outbound?.height !== undefined) rates.outHeight = outbound.height
  if (inbound?.fps !== undefined && !paused) rates.inFps = inbound.fps
  if (outbound?.fps !== undefined) rates.outFps = outbound.fps
  if (paused) rates.pausedS = seconds

  if (!windowed) return rates
  if (prev?.transportId && prev.transportId === cur.transportId)
    put(rates, "transportBytesSent", grew(prev.transportBytesSent, cur.transportBytesSent))
  if (prev?.transportId && prev.transportId === cur.transportId)
    put(rates, "transportAllowanceBytesSent", grew(prev.transportAllowanceBytesSent, cur.transportAllowanceBytesSent))
  if (inbound && sameIn) {
    const lost = grew(sameIn.packetsLost, inbound.packetsLost)
    if (lost !== undefined && received !== undefined && lost + received > 0) rates.lossPct = (lost / (lost + received)) * 100
    put(rates, "framesDropped", grew(sameIn.framesDropped, inbound.framesDropped))
    put(rates, "nackIn", grew(sameIn.nackCount, inbound.nackCount))
    put(rates, "pliIn", grew(sameIn.pliCount, inbound.pliCount))
    put(rates, "bufferMs", perFrame(sameIn.jitterBufferDelay, inbound.jitterBufferDelay, sameIn.jitterBufferEmittedCount, inbound.jitterBufferEmittedCount))
    put(rates, "decodeMs", perFrame(sameIn.totalDecodeTime, inbound.totalDecodeTime, sameIn.framesDecoded, inbound.framesDecoded))
    const frozen = grew(sameIn.totalFreezesDuration, inbound.totalFreezesDuration)
    if (frozen !== undefined) rates.freezeMs = frozen * 1000
    if (rates.inFps === undefined && !paused && decoded !== undefined) rates.inFps = decoded / seconds
  }
  if (outbound && sameOut) {
    rates.windowMs = windowMs
    const bytes = grew(sameOut.bytesSent, outbound.bytesSent)
    if (bytes !== undefined) {
      rates.bytesSent = bytes
      rates.outKbps = (bytes * 8) / 1000 / seconds
    }
    put(rates, "headerBytesSent", grew(sameOut.headerBytesSent, outbound.headerBytesSent))
    const packets = grew(sameOut.packetsSent, outbound.packetsSent)
    put(rates, "packetsSent", packets)
    const sendDelay = grew(sameOut.totalPacketSendDelay, outbound.totalPacketSendDelay)
    if (packets && sendDelay !== undefined) rates.queueMsPerPacket = (sendDelay * 1_000) / packets
    const encoded = grew(sameOut.framesEncoded, outbound.framesEncoded)
    put(rates, "framesEncoded", encoded)
    put(rates, "framesSent", grew(sameOut.framesSent, outbound.framesSent))
    if (rates.outFps === undefined) {
      if (encoded !== undefined) rates.outFps = encoded / seconds
    }
    put(rates, "nackOut", grew(sameOut.nackCount, outbound.nackCount))
    put(rates, "pliOut", grew(sameOut.pliCount, outbound.pliCount))
    put(rates, "encodeMs", perFrame(sameOut.totalEncodeTime, outbound.totalEncodeTime, sameOut.framesEncoded, outbound.framesEncoded))
    put(rates, "encodeSeconds", grew(sameOut.totalEncodeTime, outbound.totalEncodeTime))
    const was = sameOut.qualityLimitationDurations ?? {}
    const reasonDurations: Record<string, number> = {}
    for (const [reason, total] of Object.entries(outbound.qualityLimitationDurations ?? {})) {
      const spent = grew(was[reason], total)
      if (spent !== undefined && spent > 0) {
        reasonDurations[reason] = spent
        if (reason !== "none") rates.limited[reason] = spent
      }
    }
    if (Object.keys(reasonDurations).length) rates.reasonDurations = reasonDurations
  }
  return rates
}

/** Where a device-side stat lives and which fields carry it. One category can
 *  span both streams (nack_pli): it is present only when each stream in the
 *  sample has its fields. A stream absent from the sample is not asked. */
const COVERAGE: ReadonlyArray<readonly [category: string, side: "sample" | "inbound" | "outbound", fields: readonly string[]]> = [
  ["available_bitrate", "sample", ["outgoingKbps"]],
  ["target_bitrate", "outbound", ["targetBitrate"]],
  ["coverage", "inbound", ["framesDecoded"]],
  ["frames_dropped", "inbound", ["framesDropped"]],
  ["jitter_buffer", "inbound", ["jitterBufferDelay", "jitterBufferEmittedCount"]],
  ["decode_time", "inbound", ["totalDecodeTime"]],
  ["decoder", "inbound", ["decoderImplementation"]],
  ["codec", "inbound", ["codec"]],
  ["codec", "outbound", ["codec"]],
  ["encode_time", "outbound", ["totalEncodeTime"]],
  ["encoder", "outbound", ["encoderImplementation"]],
  ["nack_pli", "inbound", ["nackCount", "pliCount"]],
  ["nack_pli", "outbound", ["nackCount", "pliCount"]],
  ["power_efficient", "inbound", ["powerEfficientDecoder"]],
  ["power_efficient", "outbound", ["powerEfficientEncoder"]],
]

/** Which categories of stats this sample carries (true) or lacks (false); a
 *  category whose stream is not in the sample is left out. Chrome reports
 *  them all, iOS WebKit fewer: a category no reading of a round ever carried
 *  is said `unsupported`, not left out. Pure. */
export function statsCoverage(sample: RtcSample): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const [category, side, fields] of COVERAGE) {
    const stat: object | undefined = side === "sample" ? sample : sample[side]
    if (!stat) continue
    const has = fields.every((field) => (stat as Record<string, unknown>)[field] !== undefined)
    out.set(category, (out.get(category) ?? true) && has)
  }
  return out
}

/** What this device decodes at one sampling tick, summed over every peer's
 *  inbound video (#265): the streams whose decoder produced frames in the
 *  window, and the pixels per second they carry. */
export interface DecodeLoad {
  /** streams whose framesDecoded grew since the last tick */
  streams: number
  /** Σ width × height × fps over those streams; absent when a decoding stream
   *  lacks its size or its rate (a partial sum would read as a light load) */
  pixelsPerS?: number
}

/** One tick's decode load from each peer's previous and current sample. A
 *  stream with no earlier sample of the same connection and stream, no clock
 *  or no frame counter cannot be judged and is left out; undefined when none
 *  could be (the browser reports no framesDecoded, or every link is new). The
 *  rate is the frames decoded over the window (what the decoder really did),
 *  not the stat's framesPerSecond.
 *  Pure. */
export function decodeLoad(windows: ReadonlyArray<{ prev?: RtcSample; cur: RtcSample }>): DecodeLoad | undefined {
  let measured = 0
  let streams = 0
  let pixels: number | undefined = 0
  for (const { prev, cur } of windows) {
    const was = prev?.inbound
    const now = cur.inbound
    if (!prev || !was || !now || prev.link !== cur.link || was.id !== now.id) continue
    if (prev.at === undefined || cur.at === undefined || cur.at <= prev.at) continue
    const frames = grew(was.framesDecoded, now.framesDecoded)
    if (frames === undefined) continue
    measured += 1
    if (frames === 0) continue
    streams += 1
    const fps = frames / ((cur.at - prev.at) / 1000)
    if (pixels !== undefined) pixels = now.width !== undefined && now.height !== undefined ? pixels + now.width * now.height * fps : undefined
  }
  if (measured === 0) return undefined
  return pixels === undefined ? { streams } : { streams, pixelsPerS: pixels }
}
