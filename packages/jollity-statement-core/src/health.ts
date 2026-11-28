// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Connection health as a LADDER: ten layers, evaluated in order, where the
 * first failing rung is the blame and everything under it is unevaluated
 * rather than innocent.
 *
 * The app feeds it from facts the layers already produce: the transport's
 * `SignalStats`, the ICE outcome of the TURN fetch, and the mesh's per-peer
 * rows (`Mesh.health()`, candidate pairs, decoded frames). `classifyLadder`
 * turns them into a verdict for the debug sheet and the health notice, and
 * `stallTransition` decides when a signalling stall starts and ends.
 *
 * The silence rule: a signer can queue frames and acknowledge nothing while
 * no call ever fails. So `classifySignalHealth` keys on the absence of both
 * success and error over a window, not on errors alone.
 *
 * A single store-vs-network verdict is deliberately not offered: it would
 * collapse rungs 3, 4 and 6 into one binary that can disagree with the
 * ladder. The guards such a verdict needs live in the rungs themselves — see
 * `RUNG 4` (quiet inbound) and `RUNG 6` (the two-peer rule).
 *
 * Pure: no DOM beyond WebRTC's own types, no React, no user-facing copy. The
 * words a player reads live in the app's health components; the `detail`
 * strings here are for the debug sheet and the exported log.
 */

import type { SignalStats } from "./transport"

// ── the signalling channel ────────────────────────────────────────────────

/** Grace before the signalling channel is judged at all — slot warm-up plus
 *  the first host round-trip. Measured from TRANSPORT CONSTRUCTION, never from
 *  room-open: the camera prompt and ICE fetch ahead of it can themselves
 *  outrun this window, and judging a device that has not begun trying reads a
 *  healthy slow start as a dead signer. */
export const SIGNAL_GRACE_MS = 9_000
/** "no successful submit for this long" is what makes a failure a STALL rather
 *  than a blip whose retry is still in flight. */
export const SUBMIT_STALL_MS = 15_000
/** Don't blame the local network until the mesh's own first retry window has
 *  passed — an unreachable peer inside it is still ambiguous. */
export const NET_GRACE_MS = 18_000
/** One continuous, established-link recovery episode may keep the ICE rung
 *  inconclusive for this long. Shared by the mesh's drop chase and the game
 *  session's last-resort isolation redirect: retries and peer-back churn must
 *  not create a third, renewable deadline. */
export const RECOVERY_GRACE_MS = 30_000

/**
 * Why our outbound signalling is (not) working.
 *
 * `signer-no-response` is the silent hang: frames queued, nothing
 * acknowledged, no call failed — the sign/submit never returned. It keys on
 * silence rather than on errors, so it still fires if a future variant of
 * that hang escapes every timeout.
 */
export type SignalReason =
  | "ok"
  | "warming"
  | "signer-no-response"
  | "store-unavailable"
  | "submit-rejected-allowance"
  | "submit-rejected-full"
  | "submit-rejected-other"
  | "inbound-dead"

export function classifySignalHealth(
  s: SignalStats | null,
  elapsedMs: number,
  nowMs: number,
): SignalReason {
  if (!s) return "warming"
  if (!s.storeLive) return "store-unavailable"
  if (elapsedMs < SIGNAL_GRACE_MS) return "warming"
  const staleOk = s.lastSubmitOkAt === 0 || nowMs - s.lastSubmitOkAt > SUBMIT_STALL_MS
  // Queued but never acknowledged — no success AND no failure to point at.
  if (s.framesSent >= 3 && s.submitsOk === 0 && s.submitsFailed === 0) return "signer-no-response"
  if (s.submitsFailed >= 2 && staleOk) {
    const e = s.lastError || ""
    // A sign timeout flows through the same per-attempt catch as any other
    // submit failure, so it also bumps submitsFailed — but it means "waiting
    // on the signer", not a rejection. Check it before the other patterns.
    if (/^sign-timeout/.test(e)) return "signer-no-response"
    if (/allowance|not authoris|not authoriz|permission/i.test(e)) return "submit-rejected-allowance"
    if (/accountfull|error 0/i.test(e)) return "submit-rejected-full"
    return "submit-rejected-other"
  }
  if (!s.subActive) return "inbound-dead"
  if (s.framesRecv === 0 && elapsedMs > SUBMIT_STALL_MS) return "inbound-dead"
  return "ok"
}

/** Write-side reasons only. `inbound-dead` is rung 4's business, and
 *  `ok`/`warming` are not failures. Splitting the one classifier across the
 *  two rungs is what lets the ladder say "we can write but not read", which
 *  the single store verdict could never express. */
function isWriteFailure(reason: SignalReason): boolean {
  return (
    reason === "store-unavailable" ||
    reason === "signer-no-response" ||
    reason === "submit-rejected-allowance" ||
    reason === "submit-rejected-full" ||
    reason === "submit-rejected-other"
  )
}

// ── the ladder ────────────────────────────────────────────────────────────

export type Layer =
  | "internet"
  | "own-key"
  | "turn-credentials"
  | "store-write"
  | "store-read"
  | "signalling"
  | "ice"
  | "media"
  | "camera"
  | "device"

export type LayerStatus = "ok" | "warn" | "fail" | "unknown"

export interface LayerResult {
  layer: Layer
  status: LayerStatus
  /** technical line for the debug sheet and the export — never shown raw to a
   *  player (see `0b0e95d`: the screen gets a notice and a button). */
  detail: string
  /**
   * A rung that fails for a reason outside this app's control. It is still
   * reported red, but it takes blame ONLY when a later rung also fails, and
   * never raises the player-facing notice alone.
   *
   * Rung 2 carries it: a TURN credential failure alone leaves STUN, which
   * connects most pairs, so it would otherwise hold blame over games that play.
   * (Whether a real issuer error should raise the notice on its own is an open
   * follow-up from #2001.) With it the verdict stays honest both ways:
   * STUN-only genuinely IS the cause when rung 6 finds no relay candidate, and genuinely is NOT a
   * problem for a same-LAN demo whose game plays fine.
   */
  knownBlocker?: boolean
  /** why a rung passes trivially — e.g. nobody else is publishing yet. Keeps a
   *  vacuous green from reading as a proven one. */
  expected?: string
}

export interface LadderVerdict {
  rungs: LayerResult[]
  /** the rung to blame, or null when nothing actionable is failing. */
  blame: LayerResult | null
}

/** What `ice.ts` last managed to acquire. */
export interface IceOutcome {
  /** A client response was received, parsed and converted to RTCIceServer entries. */
  turnReceived: boolean
  issuerErrors: string[]
  at: number
}

/** Structural subset of `lib/webrtc/mesh.ts`'s `PeerReport`, so this package
 *  never imports `Mesh` and stays runnable under a plain node vitest. */
export interface PeerReportLike {
  id: string
  conn: RTCPeerConnectionState
  ice: RTCIceConnectionState
  gather: RTCIceGatheringState
  sig: RTCSignalingState
  /** "<local>/<remote>" candidate types: host/host = same LAN, srflx = STUN
   *  worked, relay = TURN in use, undefined = no pair was ever nominated. */
  pair?: string
  frames?: number
}

/** Structural subset of `Mesh.health()`'s per-peer row, for the same reason. */
export interface PeerHealthSnapshot {
  conn: RTCPeerConnectionState
  /** Current synchronous ICE transport state. Unlike the slower getStats
   *  report, this can prove that a path exists while the overall peer
   *  connection is still settling. */
  ice?: RTCIceConnectionState
  /** have we received an SDP/ICE endpoint from them on the store? */
  gaveEndpoint: boolean
  /** Diagnostic only: the existing mesh supervisor is actively chasing this
   *  previously-connected link. Gameplay must not consume this field. */
  recovering?: boolean
  /** Monotonic timestamp of the first drop in this continuous recovery
   *  episode. Stable through retries, rebuilds and peer-away/back churn. */
  recoveryStartedAt?: number
}

export interface LadderInput {
  online: boolean
  ice: IceOutcome | null
  stats: SignalStats | null
  /** ms since the signalling TRANSPORT was constructed — 0 before it exists.
   *  Deliberately not the room clock; see SIGNAL_GRACE_MS. */
  signalElapsedMs: number
  peers: PeerReportLike[]
  health: PeerHealthSnapshot[]
  /** local camera liveness, when sampled. Absent = rung 8 is unevaluated. */
  selfLive?: boolean
  /** this phone cannot keep up with the video: every link carrying video
   *  weak at once, or the encoder held back by the CPU (the app's
   *  `phoneStruggles`, debounced). Absent = rung 9 is unevaluated. */
  struggling?: boolean
  /** `performance.now()`-clock reading for `recoveryStartedAt`. */
  connectionNowMs: number
  nowMs: number
}

export interface IceRecoveryEpisode {
  startedAt: number
  ageMs: number
  peersRecovering: number
  held: boolean
}

/** The only link-set shape that can defer rung 6: every published peer is
 *  unreachable, previously connected, and actively under the mesh
 *  supervisor. A mixed or never-connected set remains today's real failure. */
export function iceRecoveryEpisode(
  health: readonly PeerHealthSnapshot[],
  connectionNowMs: number,
): IceRecoveryEpisode | null {
  const published = health.filter((row) => row.gaveEndpoint)
  if (published.length < 2 || published.some((row) => row.conn === "connected")) return null
  if (
    published.some(
      (row) => row.recovering !== true || !Number.isFinite(row.recoveryStartedAt),
    )
  )
    return null
  const startedAt = Math.min(...published.map((row) => row.recoveryStartedAt as number))
  const ageMs = Math.max(0, connectionNowMs - startedAt)
  return {
    startedAt,
    ageMs,
    peersRecovering: published.length,
    held: ageMs < RECOVERY_GRACE_MS,
  }
}

const ok = (layer: Layer, detail: string, expected?: string): LayerResult =>
  expected ? { layer, status: "ok", detail, expected } : { layer, status: "ok", detail }
const fail = (layer: Layer, detail: string): LayerResult => ({ layer, status: "fail", detail })
const unknown = (layer: Layer, detail: string): LayerResult => ({ layer, status: "unknown", detail })

export function classifyLadder(input: LadderInput): LadderVerdict {
  const { online, ice, stats, signalElapsedMs, peers, health, selfLive, struggling, connectionNowMs, nowMs } = input
  const rungs: LayerResult[] = []

  // ── RUNG 1 — internet ───────────────────────────────────────────────────
  rungs.push(online ? ok("internet", "navigator.onLine") : fail("internet", "navigator.onLine is false"))

  // ── RUNG 1b — this player's own key ─────────────────────────────────────
  // Every offer and candidate is sealed with this player's registered key
  // (statementTransport `keys`). Without it no co-player gets a frame, the
  // relay and every rung under it fail as consequences, and the blame must
  // not go to the network. Above rung 2 and not a known blocker, so it takes
  // the blame ahead of a missing relay.
  const sealed = stats?.sealed
  if (!stats) rungs.push(unknown("own-key", "signalling transport not constructed yet"))
  else if (!sealed) rungs.push(ok("own-key", "no own key needed", "this wire seals nothing"))
  else if (sealed.ownKeyFound) rungs.push(ok("own-key", "this player's registered key was found"))
  else if (sealed.ownKeyMissing > 0)
    rungs.push(fail("own-key", `no registered key found for this player after ${sealed.ownKeyMissing} lookup(s): no co-player gets a frame`))
  // a lookup that gave no answer says nothing yet: a slow host read must not
  // tell a player whose key is fine that their video can't start
  else if (sealed.ownKeyHung > 0)
    rungs.push(unknown("own-key", `${sealed.ownKeyHung} lookup(s) of this player's registered key gave no answer`))
  else rungs.push(unknown("own-key", "this player's registered key not looked up yet"))

  // ── RUNG 2 — TURN credentials ───────────────────────────────────────────
  if (!ice) {
    rungs.push(unknown("turn-credentials", "ICE servers not fetched yet"))
  } else if (ice.turnReceived) {
    rungs.push(ok("turn-credentials", "TURN relay credentials received and parsed on this handset"))
  } else {
    // in the order the issuers were tried: the primary issuer's error leads
    const errs = ice.issuerErrors.length > 0 ? ice.issuerErrors.join(" | ") : "No TURN issuer error was recorded."
    rungs.push({
      layer: "turn-credentials",
      status: "fail",
      knownBlocker: true,
      detail: `STUN-only, no TURN relay. ${errs}`,
    })
  }

  // ── RUNG 3 — can we write to the statement store? ───────────────────────
  const reason = classifySignalHealth(stats, signalElapsedMs, nowMs)
  const numbers = stats
    ? `sent=${stats.framesSent} ok=${stats.submitsOk} failed=${stats.submitsFailed} inflight=${stats.inflight} recv=${stats.framesRecv}`
    : "no transport"
  if (!stats) rungs.push(unknown("store-write", "signalling transport not constructed yet"))
  else if (reason === "warming") rungs.push(unknown("store-write", `still warming (${numbers})`))
  else if (isWriteFailure(reason)) rungs.push(fail("store-write", `${reason}: ${numbers}; lastError=${stats.lastError || "none"}`))
  else rungs.push(ok("store-write", numbers))

  // ── RUNG 4 — is anything coming back? ───────────────────────────────────
  // Suppressing this case entirely would spare a solo/padded group a banner,
  // but it loses the fact; this reports the rung as OK and says
  // WHY it is vacuous, which a debug surface can act on and a notice will not
  // fire on.
  const nobodyPublishing = health.length === 0 || health.every((h) => !h.gaveEndpoint)
  if (!stats) rungs.push(unknown("store-read", "signalling transport not constructed yet"))
  else if (reason === "warming") rungs.push(unknown("store-read", `still warming (recv=${stats.framesRecv})`))
  else if (reason === "inbound-dead") {
    rungs.push(
      stats.subActive && stats.framesRecv === 0 && nobodyPublishing
        ? ok("store-read", `recv=0, subscription active`, "no peer is publishing to us yet")
        : fail("store-read", `inbound-dead: recv=${stats.framesRecv} subActive=${stats.subActive} lastInboundAt=${stats.lastInboundAt || "never"}`),
    )
  } else rungs.push(ok("store-read", `recv=${stats.framesRecv}`))

  // ── RUNG 5 — did peers exchange endpoints at all? ───────────────────────
  const published = health.filter((h) => h.gaveEndpoint)
  if (health.length === 0) rungs.push(unknown("signalling", "no peers in this room"))
  else if (signalElapsedMs < SIGNAL_GRACE_MS) rungs.push(unknown("signalling", "within the signalling grace window"))
  else if (published.length === 0)
    rungs.push(fail("signalling", `no peer published an SDP/ICE endpoint (${health.length} expected)`))
  else rungs.push(ok("signalling", `${published.length}/${health.length} peers published an endpoint`))

  // ── RUNG 6 — did ICE find a path? ───────────────────────────────────────
  // The two-peer rule: blame OUR side only when at least
  // TWO peers that DID publish still cannot be reached. One unreachable peer
  // is ambiguous — it could be them — and belongs on that peer's own row.
  const anyConnected = health.some((h) => h.conn === "connected")
  const anyIceConnected = health.some(
    (h) =>
      h.conn !== "failed" &&
      h.conn !== "closed" &&
      (h.ice === "connected" || h.ice === "completed"),
  )
  const recovery = iceRecoveryEpisode(health, connectionNowMs)
  const pairs = peers.filter((p) => p.pair).map((p) => `${p.id.slice(0, 6)}=${p.pair}`)
  const gathering = peers.filter((p) => p.gather !== "complete").map((p) => `${p.id.slice(0, 6)}:${p.gather}`)
  if (anyConnected || anyIceConnected)
    rungs.push(
      ok(
        "ice",
        pairs.length > 0
          ? `paths: ${pairs.join(" ")}`
          : anyConnected
            ? "connected"
            : "ICE transport connected; peer connection settling",
      ),
    )
  else if (published.length < 2 || signalElapsedMs < NET_GRACE_MS)
    rungs.push(unknown("ice", `not yet conclusive (${published.length} published, ${signalElapsedMs}ms elapsed)`))
  else if (recovery?.held)
    rungs.push(
      unknown(
        "ice",
        `self-heal in progress (${recovery.peersRecovering} peers, ${Math.round(recovery.ageMs)}ms episode age)`,
      ),
    )
  else
    rungs.push(
      fail(
        "ice",
        `${published.length} peers published but none connected; no candidate pair nominated${gathering.length > 0 ? `; gathering: ${gathering.join(" ")}` : ""}`,
      ),
    )

  // ── RUNG 7 — is media actually arriving? ────────────────────────────────
  // `conn === "connected"` says the LINK is up; it says nothing about frames.
  // A peer connection pushing a dead track looks perfectly healthy without this.
  const connectedPeers = peers.filter((p) => p.conn === "connected")
  const silent = connectedPeers.filter((p) => !p.frames)
  if (connectedPeers.length === 0) rungs.push(unknown("media", "no connected peers"))
  else if (silent.length === connectedPeers.length)
    rungs.push(fail("media", `${silent.length} connected peer(s), none decoding frames`))
  else if (silent.length > 0)
    rungs.push({
      layer: "media",
      status: "warn",
      detail: `${silent.length}/${connectedPeers.length} connected peers decoding no frames`,
    })
  else rungs.push(ok("media", `${connectedPeers.length} peer(s) decoding frames`))

  // ── RUNG 8 — our own camera ─────────────────────────────────────────────
  if (selfLive === undefined) rungs.push(unknown("camera", "liveness not sampled"))
  else rungs.push(selfLive ? ok("camera", "local video is live") : fail("camera", "local tile is blank — camera track may be dead"))

  // ── RUNG 9 — can this phone keep up? ────────────────────────────────────
  // Last: every rung above is a reason the video might not be there at all,
  // this one says it is there and this phone is the bottleneck. One notice
  // here replaces "Weak signal" on every tile.
  if (struggling === undefined) rungs.push(unknown("device", "no video window measured yet"))
  else rungs.push(struggling ? fail("device", "every video link weak at once, or the encoder CPU-limited") : ok("device", "keeping up"))

  // blame is picked from the HONEST statuses, before anything is blanked —
  // `pickBlame` needs to see a later failure to decide whether rung 2's known
  // blocker is the cause or merely noise.
  const blame = pickBlame(rungs)
  return { rungs: blankBelowBlame(rungs, blame), blame }
}

/**
 * First failing rung, skipping a `knownBlocker` unless something later also
 * failed — in which case the blocker IS the cause and takes the blame.
 */
function pickBlame(rungs: LayerResult[]): LayerResult | null {
  const failures = rungs.filter((r) => r.status === "fail")
  const first = failures[0]
  if (!first) return null
  const firstReal = failures.find((r) => !r.knownBlocker)
  if (!firstReal) return null // only known blockers failed — nothing to raise
  // A known blocker sitting above a genuine failure is the explanation for it.
  return first.knownBlocker ? first : firstReal
}

/**
 * A rung below the blame cannot be assessed: if the store cannot be written,
 * no peer will publish an endpoint and every rung under it fails as a
 * consequence. Reporting four reds for one cause reads as four problems, so
 * everything after the blame is marked unevaluated — the raw inputs are still
 * in the debug sheet for anyone who wants to look past the verdict.
 */
function blankBelowBlame(rungs: LayerResult[], blame: LayerResult | null): LayerResult[] {
  if (!blame) return rungs
  const at = rungs.indexOf(blame)
  return rungs.map((r, i) =>
    i > at ? { layer: r.layer, status: "unknown" as const, detail: `not evaluated — ${blame.layer} failed first` } : r,
  )
}

// ── stall transitions ─────────────────────────────────────────────────────
// Extracted as a pure decision because the hook it runs inside has no test
// harness, so an inline decision in a 1s poll
// loop drifts from what is actually verified — which is the shape of the bug
// this whole layer exists to prevent.

/** Carried across ticks by the caller. `since` is the epoch ms the CURRENT
 *  stall began (0 = not stalled); `layer` is the blame it began with, kept so
 *  the recovery event can carry the same value and join to its entry. */
export interface StallState {
  since: number
  layer: string
}

export const NOT_STALLED: StallState = { since: 0, layer: "" }

export interface StallEvent {
  kind: "connection_stalled" | "connection_recovered"
  layer: string
  gameId?: string
  groupId?: string
  round?: number
  detail: Record<string, unknown>
}

export interface StallTransitionInput {
  blame: LayerResult | null
  now: number
  prev: StallState
  /** epoch ms the last manual reconnect COMPLETED, 0 = never. */
  lastReconnectAt: number
  stats: SignalStats | null
  context?: { gameId?: string; groupId?: string; round?: number }
}

export interface StallTransitionResult {
  next: StallState
  /** the event to log, or null on a persisting stall / persisting-healthy tick
   *  — a 1s loop must not write a line every second. */
  event: StallEvent | null
}

/**
 * Fires ONLY on the transition into or out of a stall.
 *
 * `recovered_via` says "reconnect-tapped", never "reconnect-fixed-it":
 * `lastReconnectAt` is stamped whenever a reconnect COMPLETES, success or
 * failure alike, so a tap during this stall is a correlation the log can show,
 * never proof it caused the recovery. Comparing against `prev.since` — this
 * stall's own start — is what rules out crediting a tap left over from an
 * earlier, unrelated stall.
 */
export function stallTransition(input: StallTransitionInput): StallTransitionResult {
  const { blame, now, prev, lastReconnectAt, stats, context } = input
  const wasStalled = prev.since !== 0
  const isStalled = blame !== null
  if (isStalled === wasStalled) return { next: prev, event: null }

  if (isStalled && blame) {
    return {
      next: { since: now, layer: blame.layer },
      event: {
        kind: "connection_stalled",
        layer: blame.layer,
        ...context,
        detail: {
          reason: blame.detail,
          knownBlocker: blame.knownBlocker ?? false,
          framesSent: stats?.framesSent,
          submitsOk: stats?.submitsOk,
          submitsFailed: stats?.submitsFailed,
          framesRecv: stats?.framesRecv,
          storeLive: stats?.storeLive,
          subActive: stats?.subActive,
          lastError: stats?.lastError,
          // why the sealed wire dropped frames, so a dark link with no key
          // is not read as an ICE failure
          ...stats?.sealed,
        },
      },
    }
  }

  const ms = now - prev.since
  return {
    next: NOT_STALLED,
    event: {
      kind: "connection_recovered",
      // the layer the stall ENTERED with — joins this event to its counterpart
      // and keeps the dedupe key varying across back-to-back cycles.
      layer: prev.layer,
      ...context,
      detail: {
        stallMs: ms,
        recoveredVia: lastReconnectAt > prev.since ? "reconnect-tapped" : "self-heal",
        submitsOk: stats?.submitsOk,
      },
    },
  }
}

// ── correlation + dedupe ──────────────────────────────────────────────────

/**
 * Deterministic, order-independent key every real member of a group computes
 * identically — so two players' exported logs can be joined on it.
 */
export function deriveGroupId(memberIds: string[]): string {
  const real = memberIds.filter((id) => !id.startsWith("pad:"))
  const key = [...real].sort().join(",")
  let h = 5381
  for (let i = 0; i < key.length; i++) h = (h * 33) ^ key.charCodeAt(i)
  return (h >>> 0).toString(36)
}

export const DEDUPE_WINDOW_MS = 30_000

/** Exported for tests: several call sites depend on this key VARYING
 *  (round-to-round stalls, per-layer causes), and a key that silently
 *  collapses them is invisible in production — the line just never appears. */
export function dedupeKey(e: Pick<StallEvent, "kind" | "layer" | "groupId" | "round">): string {
  return [e.kind, e.layer, e.groupId ?? "", e.round ?? ""].join("|")
}

/** Per-tab safety valve against a 1s loop flooding an IndexedDB-backed log.
 *  Mutates `seen`; the caller owns it. */
export function shouldEmit(seen: Map<string, number>, key: string, now: number): boolean {
  const last = seen.get(key)
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false
  seen.set(key, now)
  return true
}
