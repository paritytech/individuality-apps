// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * ICE candidates as the debug log may show them. The log is exported by the
 * player and, with a Sentry DSN, sent as breadcrumbs and game logs, so a
 * candidate's address and port (a co-player's IP address, or our own) never
 * enter it: only the candidate type, the transport protocol, the component and,
 * for TCP, the TCP type.
 *
 *   candidate:842163049 1 udp 1677729535 203.0.113.7 61234 typ srflx raddr …
 *   → "srflx/udp rtp"
 */

/** the fields of an RTCIceCandidate, an RTCIceCandidateInit or a stats
 *  candidate this reads; anything else on the object is ignored */
export interface LoggableCandidate {
  candidate?: string | null
  type?: string | null
  candidateType?: string | null
  protocol?: string | null
  component?: string | null
  tcpType?: string | null
}

/** `candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …` */
const CANDIDATE_LINE = /^(?:a=)?candidate:\S+ (\d+) (\S+) \d+ \S+ \d+ typ (\S+)/i

const COMPONENTS: Record<string, string> = { "1": "rtp", "2": "rtcp" }

/** One candidate for a log line, with no address or port; "(end of
 *  candidates)" for the null or empty candidate that ends a gathering. */
export function candidateForLog(candidate: LoggableCandidate | null | undefined): string {
  const line = candidate?.candidate?.trim() ?? ""
  const parsed = CANDIDATE_LINE.exec(line)
  const type = candidate?.type ?? candidate?.candidateType ?? parsed?.[3]
  if (!candidate || (!line && !type)) return "(end of candidates)"
  const protocol = candidate.protocol ?? parsed?.[2]?.toLowerCase()
  const component = candidate.component ?? (parsed ? (COMPONENTS[parsed[1]] ?? parsed[1]) : undefined)
  const tcpType = candidate.tcpType ?? /\btcptype (\S+)/i.exec(line)?.[1]
  return `${type ?? "?"}/${protocol ?? "?"}${component ? ` ${component}` : ""}${tcpType ? ` tcptype ${tcpType}` : ""}`
}
