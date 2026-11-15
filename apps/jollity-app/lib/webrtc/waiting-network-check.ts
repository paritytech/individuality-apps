// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A peerless waiting-room network check (#757).
 *
 * One throwaway RTCPeerConnection gathers against the same cached ICE server
 * list the game will use. It never signals and never opens a peer link. A
 * warning is conclusive only when the browser found local host candidates,
 * no public/relay candidate, AND reported the configured TURN server
 * unreachable across all configured TURN transports, or gathering finishes
 * host-only. The shared #760 dwell protects an in-progress good gather
 * from flashing after its ordinary first host candidate.
 */
import { countCandidate, emptyCounts, type GatherCounts } from "./gather"
import { HOST_ONLY_GATHER_DWELL_MS, NoUsableNetworkPathGate } from "./path-health"

export const WAITING_NETWORK_CHECK_TIMEOUT_MS = HOST_ONLY_GATHER_DWELL_MS + 2_000
export const ZERO_CALLBACK_OBSERVATION_MS = 5_000

export type WaitingNetworkCheckResult = "pass" | "blocked" | "runtime-stalled" | "inconclusive" | "unsupported" | "cancelled"

export const WEBRTC_RESTART_NOTICE = {
  eyebrow: "Connection problem",
  heading: "Restart the Polkadot App",
  body: "Your WebRTC connection isn’t working correctly. Please restart the Polkadot App.",
} as const

/** The restart notice belongs only to the twice-confirmed exact stall. */
export function waitingNetworkRestartNotice(result: WaitingNetworkCheckResult): typeof WEBRTC_RESTART_NOTICE | null {
  return result === "runtime-stalled" ? WEBRTC_RESTART_NOTICE : null
}

/** A confirmed engine stall stays authoritative for that game until restart. */
export function retainWaitingNetworkDecision<T extends { gameAt: number; result: WaitingNetworkCheckResult }>(
  current: T | undefined,
  next: T,
): T {
  return current?.gameAt === next.gameAt && current.result === "runtime-stalled" ? current : next
}

/** Late joiners need no waiting-room check; a confirmed stall always blocks. */
export function waitingNetworkAllowsHandover(options: {
  inWaiting: boolean
  done: boolean
  result: WaitingNetworkCheckResult
}): boolean {
  if (options.result === "runtime-stalled") return false
  return !options.inWaiting || options.done
}

export interface WaitingNetworkCheckEvidence {
  result: WaitingNetworkCheckResult
  counts: GatherCounts
  gatherMs: number
  relayUnreachable: boolean
  attempts: 1 | 2
  reason: "candidate" | "complete" | "dwell" | "timeout" | "zero-callback" | "no-turn" | "error" | "unsupported" | "cancelled"
}

interface PeerConnectionLike {
  iceGatheringState: RTCIceGatheringState
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null
  onicecandidateerror: ((event: RTCPeerConnectionIceErrorEvent) => void) | null
  onicegatheringstatechange: ((event: Event) => void) | null
  createDataChannel(label: string): unknown
  createOffer(): Promise<RTCSessionDescriptionInit>
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>
  close(): void
}

function serverUrls(server: RTCIceServer): string[] {
  return typeof server.urls === "string" ? [server.urls] : [...server.urls]
}

/** Keep transport/port distinct while removing credentials from comparison. */
function turnUrlKey(url: string | null | undefined): string | undefined {
  if (!url || !/^turns?:/i.test(url)) return undefined
  return url.replace(/^((?:turns?):)(?:[^@/?]*@)?/i, "$1").toLowerCase()
}

interface WaitingNetworkCheckOptions {
  iceServers: RTCIceServer[]
  signal?: AbortSignal
  createPeerConnection?: (configuration: RTCConfiguration) => PeerConnectionLike
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

type AttemptResult = WaitingNetworkCheckResult | "exact-stall"
type AttemptEvidence = Omit<WaitingNetworkCheckEvidence, "result" | "attempts"> & { result: AttemptResult }

async function runWaitingNetworkCheckAttempt(options: WaitingNetworkCheckOptions): Promise<AttemptEvidence> {
  const counts = emptyCounts()
  const now = options.now ?? (() => performance.now())
  let startedAt = now()
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  const turnUrls = new Set(options.iceServers.flatMap(serverUrls).map(turnUrlKey).filter((url): url is string => url !== undefined))
  const evidence = (
    result: AttemptResult,
    reason: WaitingNetworkCheckEvidence["reason"],
    relayUnreachable: boolean,
  ): AttemptEvidence => ({
    result,
    counts: { ...counts },
    gatherMs: Math.max(0, now() - startedAt),
    relayUnreachable,
    reason,
  })
  if (turnUrls.size === 0) return evidence("inconclusive", "no-turn", false)
  const make = options.createPeerConnection ?? ((configuration) => new RTCPeerConnection(configuration))
  if (!options.createPeerConnection && typeof RTCPeerConnection === "undefined")
    return evidence("unsupported", "unsupported", false)
  if (options.signal?.aborted) return evidence("cancelled", "cancelled", false)

  let pc: PeerConnectionLike
  try {
    pc = make({ iceServers: options.iceServers })
  } catch {
    return evidence("unsupported", "unsupported", false)
  }

  return new Promise((resolve) => {
    const gate = new NoUsableNetworkPathGate()
    const failedTurnUrls = new Set<string>()
    let gatherComplete = false
    let settled = false
    let dwellTimer: ReturnType<typeof setTimeout> | undefined
    let setupTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let zeroCallbackTimer: ReturnType<typeof setTimeout> | undefined
    let sawGatherCallback = false
    let enteredGathering = pc.iceGatheringState === "gathering"
    let observationStarted = false

    const finish = (result: AttemptResult, reason: WaitingNetworkCheckEvidence["reason"]) => {
      if (settled) return
      settled = true
      if (dwellTimer !== undefined) clearTimer(dwellTimer)
      if (setupTimer !== undefined) clearTimer(setupTimer)
      if (timeoutTimer !== undefined) clearTimer(timeoutTimer)
      if (zeroCallbackTimer !== undefined) clearTimer(zeroCallbackTimer)
      options.signal?.removeEventListener("abort", abort)
      pc.onicecandidate = null
      pc.onicecandidateerror = null
      pc.onicegatheringstatechange = null
      try { pc.close() } catch { /* best-effort teardown */ }
      resolve(evidence(result, reason, result === "blocked"))
    }
    const hostOnly = () => counts.host > 0 && counts.srflx === 0 && counts.relay === 0 && counts.other === 0
    const classify = (complete: boolean, reason: "candidate" | "complete" | "dwell") => {
      gatherComplete ||= complete
      if (counts.srflx > 0 || counts.relay > 0 || counts.other > 0) return finish("pass", reason)
      const blocked = gate.updateObservation(hostOnly(), gatherComplete, now())
      if (blocked && (gatherComplete || failedTurnUrls.size === turnUrls.size)) finish("blocked", reason)
      // Chromium may deliver the TURN 701 immediately after the final null
      // candidate. Keep the short-lived check alive until that proof arrives
      // or the overall timeout expires instead of settling one event early.
      else if (gatherComplete) return
      else if (hostOnly() && dwellTimer === undefined) {
        dwellTimer = setTimer(() => {
          dwellTimer = undefined
          classify(false, "dwell")
        }, HOST_ONLY_GATHER_DWELL_MS)
      }
    }
    const abort = () => finish("cancelled", "cancelled")
    options.signal?.addEventListener("abort", abort, { once: true })
    pc.onicecandidate = (event) => {
      sawGatherCallback = true
      if (!event.candidate) return classify(true, "complete")
      countCandidate(counts, event.candidate)
      classify(false, "candidate")
    }
    pc.onicecandidateerror = (event) => {
      sawGatherCallback = true
      const failedUrl = event.errorCode === 701 ? turnUrlKey(event.url) : undefined
      if (failedUrl && turnUrls.has(failedUrl)) {
        failedTurnUrls.add(failedUrl)
        classify(gatherComplete, gatherComplete ? "complete" : "candidate")
      }
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "gathering") enteredGathering = true
      if (pc.iceGatheringState === "complete") {
        sawGatherCallback = true
        classify(true, "complete")
      }
    }
    const startObservation = () => {
      if (settled || observationStarted) return
      observationStarted = true
      if (setupTimer !== undefined) {
        clearTimer(setupTimer)
        setupTimer = undefined
      }
      startedAt = now()
      enteredGathering ||= pc.iceGatheringState === "gathering"
      zeroCallbackTimer = setTimer(() => {
        zeroCallbackTimer = undefined
        if (!sawGatherCallback && enteredGathering) finish("exact-stall", "zero-callback")
      }, ZERO_CALLBACK_OBSERVATION_MS)
      timeoutTimer = setTimer(
        () => finish(hostOnly() ? "blocked" : "inconclusive", "timeout"),
        WAITING_NETWORK_CHECK_TIMEOUT_MS,
      )
    }
    // Keep offer/local-description setup bounded without treating its timeout
    // as gathering evidence. The five-second zero-callback observation above
    // still starts only after setLocalDescription resolves successfully.
    setupTimer = setTimer(() => finish("inconclusive", "error"), WAITING_NETWORK_CHECK_TIMEOUT_MS)
    try {
      pc.createDataChannel("jollity-network-check")
      void pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(startObservation)
        .catch(() => finish("inconclusive", "error"))
    } catch {
      finish("inconclusive", "error")
    }
  })
}

/**
 * Confirm the exact post-local-description zero-callback stall on a second,
 * fresh peer connection. A single bad attempt is not enough to stop a player.
 */
export async function runWaitingNetworkCheck(options: WaitingNetworkCheckOptions): Promise<WaitingNetworkCheckEvidence> {
  const first = await runWaitingNetworkCheckAttempt(options)
  if (first.result !== "exact-stall") return { ...first, result: first.result, attempts: 1 }
  if (options.signal?.aborted) return { ...first, result: "cancelled", reason: "cancelled", attempts: 1 }

  const second = await runWaitingNetworkCheckAttempt(options)
  if (second.result === "exact-stall") return { ...second, result: "runtime-stalled", attempts: 2 }
  return { ...second, result: second.result, attempts: 2 }
}
