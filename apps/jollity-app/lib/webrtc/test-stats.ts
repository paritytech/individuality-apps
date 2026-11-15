// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * TEST FIXTURE: Chrome getStats() reports for one peer, shared by the
 * rtc-stats and Mesh.report tests. Imported by tests only.
 */

/** A getStats() result as Chrome 1xx returns it for one peer: a relayed
 *  pair, one inbound and one outbound video stream (field names and units as
 *  recorded; seconds for rtt/jitter/freezes, bits/s for the bitrate). */
export function chromeStats(over: { t: number; decoded: number; lost: number; received: number; bytesSent: number; freezes: number; cpu: number; bandwidth?: number; selected?: string }) {
  const entries: Record<string, Record<string, unknown>> = {
    T01: { type: "transport", id: "T01", timestamp: over.t, selectedCandidatePairId: over.selected ?? "CPa" },
    CPb: { type: "candidate-pair", id: "CPb", timestamp: over.t, nominated: true, state: "succeeded", localCandidateId: "Ihost", remoteCandidateId: "Rhost", currentRoundTripTime: 0.004 },
    CPa: {
      type: "candidate-pair",
      id: "CPa",
      timestamp: over.t,
      nominated: true,
      state: "succeeded",
      localCandidateId: "Irelay",
      remoteCandidateId: "Rsrflx",
      currentRoundTripTime: 0.182,
      availableOutgoingBitrate: 1_250_000,
      bytesSent: Math.round(over.bytesSent * 1.1),
      bytesReceived: 2_200_000,
      packetsSent: Math.round(over.bytesSent / 1_000),
      packetsReceived: 2_000,
      requestsSent: 14,
      responsesReceived: 13,
      consentRequestsSent: 9,
      lastPacketReceivedTimestamp: over.t - 12,
    },
    Ihost: { type: "local-candidate", id: "Ihost", candidateType: "host", protocol: "udp", networkType: "wifi" },
    Irelay: { type: "local-candidate", id: "Irelay", candidateType: "relay", protocol: "udp", relayProtocol: "tls", networkType: "cellular", url: "turn:user:secret@turn.example.org:3478?transport=tcp" },
    Rhost: { type: "remote-candidate", id: "Rhost", candidateType: "host" },
    Rsrflx: { type: "remote-candidate", id: "Rsrflx", candidateType: "srflx" },
    IT01A: { type: "inbound-rtp", id: "IT01A", kind: "audio", timestamp: over.t, packetsLost: 900, packetsReceived: 100, jitter: 0.5 },
    IT01V: {
      type: "inbound-rtp",
      id: "IT01V",
      kind: "video",
      timestamp: over.t,
      framesPerSecond: 22,
      frameWidth: 480,
      frameHeight: 640,
      framesDecoded: over.decoded,
      framesDropped: 3,
      freezeCount: 1,
      totalFreezesDuration: over.freezes,
      jitter: 0.012,
      packetsLost: over.lost,
      packetsReceived: over.received,
      nackCount: over.lost,
      pliCount: 1,
      // 50 ms of jitter buffer and 4 ms of decode per frame
      jitterBufferDelay: over.decoded * 0.05,
      jitterBufferEmittedCount: over.decoded,
      totalDecodeTime: over.decoded * 0.004,
      decoderImplementation: "libvpx",
      powerEfficientDecoder: false,
    },
    OT01V: {
      type: "outbound-rtp",
      id: "OT01V",
      kind: "video",
      timestamp: over.t,
      framesPerSecond: 24,
      frameWidth: 360,
      frameHeight: 480,
      framesEncoded: over.bytesSent / 1000,
      qualityLimitationReason: over.bandwidth ? "bandwidth" : "cpu",
      qualityLimitationDurations: { none: 10, cpu: over.cpu, bandwidth: over.bandwidth ?? 0, other: 0 },
      bytesSent: over.bytesSent,
      retransmittedPacketsSent: 4,
      packetsSent: 900,
      nackCount: over.bytesSent / 50_000,
      pliCount: 2,
      // 6 ms of encode per frame
      totalEncodeTime: (over.bytesSent / 1000) * 0.006,
      encoderImplementation: "OpenH264",
      powerEfficientEncoder: false,
    },
  }
  return new Map(Object.entries(entries))
}

export const first = chromeStats({ t: 10_000, decoded: 200, lost: 10, received: 990, bytesSent: 1_000_000, freezes: 0.2, cpu: 1 })
export const second = chromeStats({ t: 13_000, decoded: 266, lost: 22, received: 1_578, bytesSent: 1_150_000, freezes: 0.65, cpu: 2.5 })
