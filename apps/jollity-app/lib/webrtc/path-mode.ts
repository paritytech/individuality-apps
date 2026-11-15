// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHICH PATH THIS PHONE CAN TAKE to its co-players, known before it links:
 * one throwaway RTCPeerConnection gathers against the game's STUN and TURN
 * servers and never signals (like the waiting-room check, #757, but it waits
 * for the whole gathering, so it can tell more than "blocked or not").
 *
 *  - direct   UDP gets out: STUN gave a public address. ICE tries direct
 *             first and keeps a relay as the fallback.
 *  - relay    no public address, but a TURN relay answered over TCP or TLS:
 *             a hotel network, for example. Every link goes relay only
 *             (`iceTransportPolicy: "relay"`), so no check is spent on
 *             direct paths that can never work, and gathers against the
 *             relays that answered alone (iceConfigFor).
 *  - blocked  local addresses only and no relay: nothing gets out. The
 *             waiting room says so before kickoff instead of the player
 *             seeing static.
 *  - unknown  no TURN to ask, no RTCPeerConnection, or the probe failed.
 *
 * And the NAT, from the same gathering: a public port that differs by the
 * server asking (two STUN servers, or STUN against the TURN server's own
 * view of us, a relay candidate's related address) means a SYMMETRIC NAT,
 * where a direct link only works with a peer that is open. Unknown when the
 * browser hides those addresses.
 *
 * The last result is kept for the page (a client-side route keeps the module),
 * so the waiting room finds it and the game reads it when the mesh opens.
 */

type PathMode = "direct" | "relay" | "blocked" | "unknown"
type NatKind = "cone" | "symmetric" | "unknown"

export interface PathProbe {
  mode: PathMode
  nat: NatKind
  /** a public address came back from STUN, so UDP leaves this network */
  udp: boolean
  /** how the relays answered: udp, tcp, tls, or unknown when the browser does not say */
  relayProtocols: string[]
  candidates: { host: number; srflx: number; relay: number }
  gatherMs: number
  /** when it was taken, ms since the epoch */
  at: number
}

/** a gathered candidate, as much of it as the probe reads */
export interface ProbeCandidate {
  type: string
  address?: string
  port?: number
  relatedAddress?: string
  relatedPort?: number
  relayProtocol?: string
}

const CANDIDATE_RE = /candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)(?: raddr (\S+) rport (\d+))?/i

/** Read a candidate's type and addresses from the object, else from its line. */
export function parseCandidate(candidate: {
  type?: string | null
  candidate?: string
  address?: string | null
  port?: number | null
  relatedAddress?: string | null
  relatedPort?: number | null
  relayProtocol?: string | null
}): ProbeCandidate | null {
  const m = candidate.candidate ? CANDIDATE_RE.exec(candidate.candidate) : null
  const type = candidate.type ?? m?.[4]
  if (!type) return null
  return {
    type,
    address: candidate.address ?? m?.[2],
    port: candidate.port ?? (m?.[3] ? Number(m[3]) : undefined),
    relatedAddress: candidate.relatedAddress ?? m?.[5],
    relatedPort: candidate.relatedPort ?? (m?.[6] ? Number(m[6]) : undefined),
    relayProtocol: candidate.relayProtocol ?? undefined,
  }
}

/** What a finished (or timed-out) gathering says about this phone's paths. */
export function classifyPath(candidates: readonly ProbeCandidate[], options: { turnConfigured: boolean; gatherMs: number; at: number }): PathProbe {
  const host = candidates.filter((c) => c.type === "host")
  const srflx = candidates.filter((c) => c.type === "srflx")
  const relay = candidates.filter((c) => c.type === "relay")
  const udp = srflx.length > 0
  const relayProtocols = [...new Set(relay.map((c) => c.relayProtocol ?? "unknown"))].sort()

  // the NAT: the public ports the servers saw for one local socket
  const mapped = new Map<string, Set<number>>() // local base → public ports
  const see = (base: string | undefined, port: number | undefined) => {
    if (!base || port === undefined) return
    const ports = mapped.get(base) ?? new Set<number>()
    ports.add(port)
    mapped.set(base, ports)
  }
  for (const c of srflx) see(c.relatedAddress && c.relatedPort !== undefined ? `${c.relatedAddress}:${c.relatedPort}` : undefined, c.port)
  // a UDP relay's related address is the TURN server's view of us: the same
  // socket STUN used, when its public address matches a STUN one
  const publicIps = new Set(srflx.map((c) => c.address))
  const srflxBase = srflx.find((c) => c.relatedAddress && c.relatedPort !== undefined)
  for (const c of relay) {
    if ((c.relayProtocol ?? "udp") !== "udp" || !c.relatedAddress || !publicIps.has(c.relatedAddress) || !srflxBase) continue
    see(`${srflxBase.relatedAddress}:${srflxBase.relatedPort}`, c.relatedPort)
  }
  const seen = [...mapped.values()]
  const nat: NatKind = seen.some((ports) => ports.size > 1) ? "symmetric" : seen.some((ports) => ports.size === 1) && (srflx.length > 1 || relay.length > 0) ? "cone" : "unknown"

  const mode: PathMode = udp ? "direct" : relay.length > 0 ? "relay" : options.turnConfigured && host.length > 0 ? "blocked" : "unknown"
  return {
    mode,
    nat: udp ? nat : "unknown",
    udp,
    relayProtocols,
    candidates: { host: host.length, srflx: srflx.length, relay: relay.length },
    gatherMs: options.gatherMs,
    at: options.at,
  }
}

interface ProbePeerConnection {
  iceGatheringState: RTCIceGatheringState
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null
  createDataChannel(label: string): unknown
  createOffer(): Promise<RTCSessionDescriptionInit>
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>
  close(): void
}

/** how long a probe gathers at most: a TLS relay can take a few seconds */
const PATH_PROBE_TIMEOUT_MS = 5_000

let last: PathProbe | null = null
const listeners = new Set<(probe: PathProbe) => void>()

/** the last probe this page took, or null */
export function lastPathProbe(): PathProbe | null {
  return last
}

/** told each time a probe finishes */
export function observePathProbe(listener: (probe: PathProbe) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Gather once against `iceServers` and classify (above). Never throws. */
export async function probePath(options: {
  iceServers: RTCIceServer[]
  signal?: AbortSignal
  timeoutMs?: number
  createPeerConnection?: (configuration: RTCConfiguration) => ProbePeerConnection
  now?: () => number
}): Promise<PathProbe> {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const turnConfigured = options.iceServers.some((server) => (typeof server.urls === "string" ? [server.urls] : server.urls).some((url) => /^turns?:/i.test(url)))
  const done = (candidates: ProbeCandidate[]): PathProbe => {
    const probe = classifyPath(candidates, { turnConfigured, gatherMs: Math.max(0, now() - startedAt), at: now() })
    last = probe
    for (const listener of listeners) {
      try {
        listener(probe)
      } catch {
        /* a listener never breaks the probe */
      }
    }
    return probe
  }
  const make = options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration) as unknown as ProbePeerConnection)
  if ((!options.createPeerConnection && typeof RTCPeerConnection === "undefined") || options.signal?.aborted) return done([])
  let pc: ProbePeerConnection
  try {
    pc = make({ iceServers: options.iceServers })
  } catch {
    return done([])
  }
  const candidates: ProbeCandidate[] = []
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", finish)
      pc.onicecandidate = null
      try {
        pc.close()
      } catch {
        /* best effort */
      }
      resolve(done(candidates))
    }
    const timer = setTimeout(finish, options.timeoutMs ?? PATH_PROBE_TIMEOUT_MS)
    options.signal?.addEventListener("abort", finish, { once: true })
    pc.onicecandidate = (event) => {
      if (!event.candidate) return finish()
      const parsed = parseCandidate(event.candidate as unknown as Parameters<typeof parseCandidate>[0])
      if (parsed) candidates.push(parsed)
    }
    try {
      pc.createDataChannel("jollity-path-probe")
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(finish)
    } catch {
      finish()
    }
  })
}

/** The ICE policy a probe calls for: relay only when UDP is blocked and a relay answered. */
export function icePolicyFor(probe: PathProbe | null): RTCIceTransportPolicy {
  return probe?.mode === "relay" ? "relay" : "all"
}

/** A TURN url's transport, named the way a relay candidate's `relayProtocol`
 *  names it: `turns:` is TLS, `turn:` is TCP with `transport=tcp` and UDP
 *  otherwise. Null for anything that is not TURN (STUN). */
export function turnTransport(url: string): "udp" | "tcp" | "tls" | null {
  const m = /^(turns?):[^?]*(?:\?(.*))?$/i.exec(url.trim())
  if (!m) return null
  if (m[1].toLowerCase() === "turns") return "tls"
  return /(?:^|&)transport=tcp(?:&|$)/i.test(m[2] ?? "") ? "tcp" : "udp"
}

/** the urls of `servers` that `keep` passes, each server left with only those, and the servers left with none dropped */
function keepUrls(servers: readonly RTCIceServer[], keep: (url: string) => boolean): RTCIceServer[] {
  return servers.flatMap((server) => {
    if (typeof server.urls === "string") return keep(server.urls) ? [server] : []
    const urls = server.urls.filter(keep)
    return urls.length > 0 ? [{ ...server, urls }] : []
  })
}

/** candidates pooled ahead of the first description on relay only (iceConfigFor) */
const RELAY_CANDIDATE_POOL = 1

/**
 * The configuration a link is made with on its path. Every path but relay
 * only: `base`, untouched. Relay only: the TURN servers over the
 * transports a relay answered on in the probe (`relayProtocols`, TCP and TLS
 * there), and no STUN or UDP TURN. Those never answer on a network that lets
 * no UDP out, and the gathering waited out their timeouts: on a relay-only
 * test network, a 701 from stun.cloudflare.com, stun.l.google.com and
 * turn.cloudflare.com on every link, and `complete` at p50 1.2 s for a relay in at 0.13 s. Every
 * relay is kept, still without STUN, when the probe could not tell which
 * transport answered, or when none of the servers in hand is over one it saw.
 *
 * And one candidate is pooled, so the relay is allocated when the connection
 * is made rather than when it first describes itself. An answerer's is made
 * at mesh open and waits a store hop for the offer, so its answer finds the
 * relay ready. The allocation is the one the link goes on to use: every
 * roster link negotiates at once, standby ones too.
 */
export function iceConfigFor(base: RTCConfiguration, relayProtocols: readonly string[]): RTCConfiguration {
  if (base.iceTransportPolicy !== "relay") return base
  const servers = base.iceServers ?? []
  const relays = keepUrls(servers, (url) => turnTransport(url) !== null)
  if (relays.length === 0) return base // STUN only: nothing gathers relay only either way
  const known = relayProtocols.length > 0 && !relayProtocols.includes("unknown")
  const answered = known ? keepUrls(relays, (url) => relayProtocols.includes(turnTransport(url)!)) : []
  return { ...base, iceServers: answered.length > 0 ? answered : relays, iceCandidatePoolSize: RELAY_CANDIDATE_POOL }
}
