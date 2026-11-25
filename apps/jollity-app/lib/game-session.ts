// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

"use client"

/**
 * The game session — ALL of the game screen's brains, kept here so the page
 * is pure rendering. Owns: the real state machine ticking (game-chain's
 * calculateSnapshot on the game clock when a live game exists), and with it
 * the connect phase — the pre-connect window the chain leaves before turn 1,
 * never a timer — per-turn votes with cycle-end auto-rejection and the
 * confirm-stage prediction, the verdict gestures both ways over the mesh, the
 * auto-confirm engine, the mesh itself, and report submission through the
 * source. The page consumes the returned view only.
 *
 * Every per-player value is keyed by the player's id, never by the seat: the
 * chain re-shuffles the seats each round, so one seat holds two different
 * people in round 1 and round 2. Votes and bans live here, the photos in
 * `useSnapshots`. The confirm roster is the union of every round's group,
 * you excluded, so a player met in one round alone still gets a tile.
 *
 * A round holds `maxGroupSize` SEATS and as many turns — the game's own
 * group cap — and fewer sign-ups leave some of those chairs empty. The turns
 * wrap around the seats players hold (game-chain `hostSeat`), so a group of 4
 * plays A B C D A B and an empty chair hosts nothing, except in a group of
 * one. The grid draws one tile per held seat; a chair nobody holds gets no
 * tile (#1347). The session still mints `ghost:<round>:<seat>` ids, for the
 * empty chair that hosts a turn in a group of one and for a held seat not
 * read yet, so it keeps its slot. That id names a chair and never a person,
 * so it takes no vote, no report entry and no mesh link.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
// VALUES come from the PURE subpath — the barrel re-exports chain/client, so
// importing these through it would pull polkadot-api and the generated
// descriptors into the game screen's bundle for nine lines of arithmetic.
import { calculateSnapshot, hostSeat, roundDuration, roundStart, TILES_ENTER_SECONDS, turnsPerRound } from "@jollity/game-chain/game"
// TYPES stay on the barrel: `import type` is erased at compile, so this costs
// nothing at runtime and keeps one place to look for the shapes.
import type { GameSnapshot, GameTimingInfo, HostingStage } from "@jollity/game-chain"
import { meshRoundOfSnapshot } from "./mesh-round"
import {
  getGameSource,
  playerIdOf,
  type GameSource,
  type LiveGameView,
  type PlayerId,
} from "./game-source"
import {
  buildReport,
  coPlayers,
  countReport,
  summarizeVotes,
  filedVerdicts,
  type TurnVotes,
} from "./game-roster"
import { turnLayout } from "./grid-layout"
import { cameThroughWaitingRoom, readJoinedGameAt } from "./joined"
import { clearVotes, loadVotes, saveVotes, type StoredVotes } from "./game-votes"
import { reportMissed } from "./report-missed"
import { clearPendingReportFailure, recordPendingReportFailure } from "./report-failure-outbox"
import { UNSEEN_VERDICT } from "./late-join"
import { loadDraw } from "./draw/draw-load"
import { coinAmount, PRIZE_UNIT } from "./draw/prize-unit"
import { drawEntryPath, peekDrawSchedule } from "./draw/draw-schedule"
import { rememberPostGame } from "./post-game"
import { resolvePostGameHandoff } from "./post-game-handoff"
import { devLog } from "./debug/log-store"
import { acceptKey, fileGesture, newTapLedger, nextSentSeq, recordNewTaps, recordTapSent } from "./tap-receipt"
import { SESSION_TICK_MS } from "./game-clock"
import { chainNowMs } from "./chain-clock"
import { pageFroze, pageHidden, watchPageHidden } from "./page-lifecycle"
import { useMesh, type MeshView } from "./webrtc/useMesh"
import { observeLegacyDecision } from "./webrtc/legacy-decision-capture"
import { usePathMode } from "./webrtc/use-path-mode"
import { icePolicyFor } from "./webrtc/path-mode"
import { connectionStatus, type ConnectionStatus } from "./connection-status"
import { waitingPeers, type WaitingPeer } from "./waiting-room"
import { setTurnGameShape, setTurnPlayerAccount, warmIceServers } from "./webrtc/ice"
import type { SeatState } from "./webrtc/seat-state"
import { useCalibratedSignalling } from "./store-calibration"
import { cameraHandoverSummary, cameraState, requestCameraJoinCheck, useCamera, type CameraState } from "./camera"
import {
  beginJoin,
  cameraSettled,
  autoConfirmOff,
  reportWindowClosed as reportWindowClosedTrace,
  confirmOpened,
  isolated as traceIsolated,
  leftGame,
  noteGame,
  peerSeen,
  reportFailed,
  reportBuilt,
  drawShown,
  reportLanded,
  reportSubmitting,
  roundChanged,
} from "./journeys/game-trace"
import { getHealthSnapshot, subscribeHealth } from "./health/snapshot"
import { describeError } from "./host/error-detail"
import { useDebounced, useDebouncedFor } from "./use-debounced"
import { REPORT_RETRY_MS, submitReportAttempt } from "./report-retry"
import { useChainHealthCard } from "./use-chain-health-card"
import type { ChainHealthCardState } from "./chain-health"
import { RECOVERY_GRACE_MS, type SignalStats } from "@jollity/statement-core"
import { recordCount, recordDistribution } from "./telemetry"
import {
  markVideoRoleSeen,
  videoRoleSeen,
} from "./video-role-history"
import { seatTakesTap } from "./tile-tap"
import { voteForRound } from "./round-vote"
import { captureReplayObservation } from "./telemetry/replay-capture"
import { markSeen } from "./worker-bridge"
import { createReplayTurnObserver } from "./telemetry/replay-turns"
import {
  emptyTurnBooks,
  remountClockState,
  turnBooks,
  type TurnBooks,
  type TurnBooksStep,
  type TurnWorld,
} from "./turn-books"

import {
  AUTO_CONFIRM_AWAY_THRESHOLD_MS,
  AUTO_CONFIRM_BEAT_MS,
  AUTO_CONFIRM_MS,
  CONFIRM_REPORT_MARGIN_MS,
  emptyReportOutbox,
  reportOutbox,
  type OutboxClock,
  type OutboxInputs,
  type OutboxState,
} from "./report-outbox"
import {
  emptyEvidenceProjection,
  evidenceProjection,
  playerProjection,
  presentedFrameAdmitted,
  roleFor as projectedRoleFor,
  votable as projectedVotable,
  voteShown as projectedVoteShown,
  type ConfirmProjectionInput,
  type EvidenceProjectionState,
} from "./evidence-projection"

/** Existing isolation timer clock, named so React treats the effect as the
 * impure boundary it already is rather than analysing it as render work. */
const isolationClockNow = () => performance.now()

/** the books' fields a render reads: a change to one of them re-renders, a
 *  change to the others (the tick's own bookkeeping) does not, as when they
 *  were refs */
const RENDERED_BOOKS: readonly (keyof TurnBooks)[] = [
  "turnVotes",
  "banVotes",
  "firstOpenedTurn",
  "videoRoleHistory",
  "banned",
  "coldReconciled",
  "sealEpoch",
  "topUpEpoch",
]

/** THE REPORT WINDOW: the pallet takes a report only before `report_ends`. */
function reportWindowOpen(nowSeconds: number, reportEnds: number): boolean {
  return nowSeconds < reportEnds
}

/** The hidden-page away latch reads the wall clock (`Date.now`), not the
 * game clock, and passes it into the pure reducer. A wall step can move it;
 * that is a known clock gap, kept on purpose. */
function awayLatchNowMs(): number {
  return Date.now()
}

/** the round a late join lands in, for the progress line of the joining screen */
function joiningRound(
  nowSeconds: number,
  timing: GameTimingInfo,
): { round: number; elapsed: number; duration: number } | null {
  const snapshot = calculateSnapshot(nowSeconds, timing)
  if (snapshot.kind !== "round") return null
  return {
    round: snapshot.round,
    elapsed: Math.max(0, nowSeconds - timing.gameDate - roundStart(timing, snapshot.round)),
    duration: roundDuration(timing),
  }
}

/** the confirm button's one label; the page renders it as it is */
export function ctaLabel(
  s: Pick<GameSessionView, "reportWindowClosed" | "submitState" | "autoActive" | "autoCount" | "votesLoading">,
): string {
  if (s.reportWindowClosed) return "Voting has closed · Continue"
  if (s.votesLoading) return "Loading your votes…"
  if (s.submitState === "submitting") return "Submitting..."
  // a rejected report reads as a retry, never a silent jump to the collectables screen
  if (s.submitState === "error") return "Vote didn't send — tap to retry"
  if (!s.autoActive) return "Confirm votes"
  return s.autoCount > 0 ? `Confirming in ${s.autoCount}` : "Confirming..."
}

/** THE VOTE TRAIL: what the player tapped versus what the app filed for them,
 *  in the game log (tag "vote"). It only observes. */
function trail(message: string, data: Record<string, unknown>): void {
  devLog("vote", message, data)
}

/** how often the live view is re-read until it resolves */
const LIVE_POLL_MS = 2500
/** THE CONFIRM WINDOW, in seconds. A changed confirm verdict restarts this
 *  window, capped by the last-call margin before `report_ends`, so a player
 *  who is still reviewing is never filed mid-change and the report still has
 *  time to land. */
const AUTO_CONFIRM_SEC = AUTO_CONFIRM_MS / 1_000
/** Defensive, for a source that registers no game clock (`chainNowMs()` null;
 *  only test sources): `sourceTime` then reads `GameSource.nowSeconds()` in
 *  whole seconds. Give an accepted restart one monotonic second beyond that
 *  conservative step so it is shortened rather than effectively skipped. The
 *  three-second report margin still contains the full uncertainty. The
 *  shipped source registers its clock when it is created, so this slack is
 *  never used there. */
const CONFIRM_PRE_SYNC_SLACK_MS = 1000
/** how often the release checks the source clock against its deadline */
const CONFIRM_RELEASE_POLL_MS = 250
/** the gap's first second: the last group parks off the sides (the FLIP
 *  park is 520 ms, and the gap shows on a 500 ms tick) before the next one comes in */
const GAP_LEAVE_SECONDS = 1

/**
 * THE ROTATION COUNTDOWN over the gap between two rounds (`ROUND_GAP`). The
 * last group leaves, the next group moves in with its link badges, and the
 * line counts down to the next round.
 */
export type RoundChange = {
  /** whole seconds until the next round starts — the digit in the line */
  seconds: number
  /** when the next group starts to move in (device clock, unix seconds).
   *  Null while the last group leaves. */
  enterAt: number | null
}

export type Vote = "person" | "notperson"
export type TileVariant = "host" | "you" | "other"
export type TileRole = "host" | "you" | "empty" | "unseen" | "coplayer"
/** where the screen is: the connect grid, or the game. It follows the game
 *  clock through `calculateSnapshot` — `waiting-room` is the connect beat,
 *  everything from the first round on is `live` — and no timer moves it. */
export type SessionPhase = "connecting" | "live"
/** which screen /game shows. The game is ONE mounted route, so the camera,
 *  the transport and the mesh survive the walk final-waiting (the dial, the
 *  mesh forming behind it) → tiles-enter (the last TILES_ENTER_SECONDS, the
 *  tiles move in) → game. */
export type SessionScreen = "final-waiting" | "joining" | "tiles-enter" | "game"
export type PeerSignal = "connecting" | "connected" | "weak" | "disconnected"

/** the wall clock in seconds: the fallback when no game clock is registered */
function nowSeconds(): number {
  return Date.now() / 1000
}

/** The game clock in ms: the waiting-room dial and its screen switches read it.
 *  A correction makes it run slower or faster, never back. */
export function sessionNowMs(): number {
  return chainNowMs() ?? nowSeconds() * 1000
}

/** The source's smoothly advancing game time in ms (`chainNowMs`, which the
 *  shipped source registers when it is created). Defensive fallback, for a
 *  source that registers none (test sources): round the source's clock up and
 *  report its one-second uncertainty so a capped restart can retain a
 *  monotonic grace beat. */
function sourceTime(source: GameSource): { nowMs: number; capSlackMs: number } {
  const anchored = chainNowMs()
  if (anchored !== null) return { nowMs: anchored, capSlackMs: 0 }
  return {
    nowMs: Math.ceil(source.nowSeconds()) * 1000,
    capSlackMs: CONFIRM_PRE_SYNC_SLACK_MS,
  }
}

/** a change of the game clock's lead smaller than this is read noise, not a move */
const LEAD_HOLD_MS = 50

/** The game clock's lead on the device clock, in seconds, read in ms so it does
 *  not flip with the render instant. `holdMs` is how far a read may wander with
 *  no real move: the read noise, or a whole second on the whole-second
 *  fallback clock (`sourceTime`). */
function gameClockLead(source: GameSource): { lead: number; holdMs: number } {
  const { nowMs, capSlackMs } = sourceTime(source)
  return { lead: Math.round(nowMs - nowSeconds() * 1000) / 1000, holdMs: Math.max(LEAD_HOLD_MS, capSlackMs) }
}

// the joined marker has no change event: a render reads it again
const noSubscribe = () => () => {}
const noJoinedGameAt = () => null
const noUnexplainedJump = () => 0

/** the prefix that marks a chair's own id (a ghost id), never a player's */
const GHOST_PREFIX = "ghost:"
/** a chair's own id: the empty chair that hosts a turn in a group of one, or
 *  a held seat not read yet. Stable for the whole game, never a mesh peer. */
function ghostId(round: number, seat: number): PlayerId {
  return `${GHOST_PREFIX}${round}:${seat}`
}
function isGhostId(id: PlayerId): boolean {
  return id.startsWith(GHOST_PREFIX)
}

export interface GameSessionView {
  phase: SessionPhase
  screen: SessionScreen
  /** Display-only progress from the device time while a late join waits for
   * a ready clock (defensive: the shipped source's clock is ready at once).
   * No turn, vote or seal may read this value. */
  joining?: { round: number; elapsed: number; duration: number }
  /** kickoff as the DEVICE clock reads it (stable across renders) */
  gameAt: number | undefined
  /** kickoff in the CHAIN frame: the key of the waiting room's open How to play step */
  gameDate: number | undefined
  /** whole seconds to kickoff, before the game starts (undefined after) */
  secondsToStart: number | undefined
  /** peers with live evidence on the statement store (presence, signals) */
  presentCount: number
  /** the connecting phase as the waiting room shows it (lib/connection-status.ts) */
  connection: ConnectionStatus
  /** the co-players still to play with, as the waiting room's dots show them */
  waitingPeers: WaitingPeer[]
  /** the tiles this round: one per seat a player holds (#1347) */
  seats: number
  /** the occupied seats this round — the accept target */
  players: number
  /** a chair's own id, not a player (see `ghostId`): static for the whole
   *  game. An empty chair hosts a turn only in a group of one; any larger
   *  group wraps its turns around its players. */
  ghost: (id: PlayerId) => boolean
  /** the signalling transport's counters — statement-store health */
  store: SignalStats | undefined
  /** grid order (player ids) — drives rendering AND the FLIP orderKey */
  display: PlayerId[]
  /** the grid's choreography pose */
  pose: "parked" | "intro" | "natural"
  /** who hosts the turn on screen. There is no turn outside a round, so this
   *  is null there, the confirm screen included. */
  hostId: PlayerId | null
  /** you. Null until the group on screen has resolved you. */
  youId: PlayerId | null
  confirming: boolean
  /** The host has failed the shared #726 liveness rule. Before kickoff this
   * takes the restart card; during play it is a non-blocking bar. */
  hostStuck: boolean
  /** Why the host is stuck, so concrete chain errors bypass reconnecting UI. */
  hostStuckReason: ChainHealthCardState["reason"]
  /** The loss followed a return from the background: the reconnecting
   * minute counts from that return (ChainHealthCardState.reconnectingSince). */
  hostReconnectingSince?: number
  /** The host has answered a transaction-build probe in this session. */
  hostAnswering: boolean
  /** Every expected peer has been attempted and none is reachable (or this
   * browser is offline). This broader predicate owns the isolation route and
   * grace; it is not specific enough on its own to choose notice copy. */
  isolated: boolean
  /** This browser is offline, or every expected peer is unreachable after at
   * least one peer supplied presence/endpoint evidence. Unlike the broader
   * isolation route predicate, this cannot mistake a host/signalling outage
   * before WebRTC negotiation for a player-network loss. */
  playerNetworkIsolated: boolean
  /** Local ICE gathering proves there is no public or relay path to any peer. */
  noUsablePath: boolean
  /** App opens in a row that found the host stuck, for the second-open copy. */
  hostStuckConsecutiveOpens: number
  /** player queries for the tiles */
  variantFor: (id: PlayerId) => TileVariant
  roleFor: (id: PlayerId) => TileRole
  videoSeen: (id: PlayerId) => boolean
  /** Confirm-stage card for a co-player who shared a turn with this player
   * but never produced a decoded frame. It starts NotPerson and remains
   * visible after the report locks so the screen keeps showing what filed. */
  noVideo: (id: PlayerId) => boolean
  /** Records a decoded frame and returns whether this peer is seen now. */
  markVideoArrived: (id: PlayerId) => boolean
  /** The page's re-arm token for a co-player's first-frame watcher. A frame
   *  counts only inside a shared open turn (#602) and the watcher fires once
   *  per arming, so this moves at every turn open while the co-player is
   *  unseen (a stream that decoded in the connect phase or the round change
   *  is read again inside the turn) and holds still once seen. */
  videoObservationEpoch: (id: PlayerId) => number
  /** One role/still evidence boundary shared with remote attachments. */
  evidenceGeneration: number
  evidenceFrozen: boolean
  votable: (id: PlayerId) => boolean
  /** whether a votable tile takes a tap: not while its seat shows only static
   *  (No signal, Can't connect), with nobody to judge. This gates the gesture,
   *  never the vote: an untapped tile still seals like any other. */
  tappable: (id: PlayerId) => boolean
  voteShown: (id: PlayerId) => Vote | undefined
  /** cast a verdict. The gesture decides which one — this never toggles. */
  voteFor: (id: PlayerId, verdict: Vote) => void
  /** the ban: the eye chip hides that player's feed AND rejects them, every
   *  turn they are votable, until the undo chip clears it */
  banned: (id: PlayerId) => boolean
  ban: (id: PlayerId) => void
  unban: (id: PlayerId) => void
  /** how many of this round's players have accepted YOU on this turn. The
   *  count, never the names: the screen celebrates a number of accepters. A
   *  co-player taps you once on each turn, so every turn opens at zero. */
  acceptedYou: number
  /** confirm stage */
  votesMissing: number
  confirmVotes: () => void
  /** the report's status: "submitting" while the end-of-game report is in
   *  flight, "error" if it never landed (a tap retries), "idle" otherwise.
   *  Only a resolved submit advances to the collectables screen. */
  submitState: "idle" | "submitting" | "error"
  autoActive: boolean
  /** the confirm stage stands but what it judges on (the stored votes and the
   *  settled clock) is not in yet: the CTA waits and nothing files (#565) */
  votesLoading: boolean
  /** the chain's report window has closed with no report filed: the CTA
   *  reads "Voting has closed", nothing is filed, and the session hands over
   *  by itself (the draw if the chain holds the report, else the collectables screen as a
   *  missed report, #303) */
  reportWindowClosed: boolean
  /** whole seconds still on the auto-confirm countdown, `autoConfirmSeconds`
   *  down to 0. Zero is the "Confirming..." beat, not a fired report. */
  autoCount: number
  autoConfirmSeconds: number
  /** the CTA's tap while the countdown runs: it collapses the count to zero
   *  instead of confirming, so an impatient player still sees the beat. */
  rushConfirm: () => void
  /** the pill bar: where the game is on the turn axis. `progress` is 0..1
   *  through the CURRENT turn — one pill fills per turn, and the bar holds
   *  the SUM of `turnsPerRound` of them: every round plays the game's group
   *  cap, one turn per seat, however many players hold the seats. The same
   *  shape as `TurnCue` in components/game/animations.
   *  The gap between rounds holds the last turn of the round before it, full,
   *  so the bar stays mounted and ducks with the grid. */
  turn: {
    /** turns per round, one entry per round, in game order */
    turnsPerRound: readonly number[]
    /** the current round, 0-based */
    round: number
    /** the current turn inside its round, 0-based */
    turn: number
    /** 0..1 through the current turn */
    progress: number
    /** the turn's whole length in seconds — the pill fills over it in one
     *  CSS run, so the whole-second clock cannot make the fill step */
    turnSec: number
  } | null
  /** the turn's stage, and its clock. The auto-reject swing warns over the
   *  LAST seconds of "gameplay", so it needs the time left, never a delay
   *  measured from the start: the app can enter a stage part-way through. */
  stage: HostingStage | null
  /** seconds the current stage lasts in this turn */
  stageDuration: number
  /** seconds left in the current stage */
  stageRemaining: number
  /** the round gap — non-null while the rotation countdown runs. See
   *  `RoundChange`. */
  roundChange: RoundChange | null
  /** connection health: your link to one player (undefined = no live mesh) */
  peerSignal: (id: PlayerId) => PeerSignal | undefined
  /** the player left (said so, or their link stayed down): the tile reads
   *  "Away" in place of a reconnect that is not coming. DISPLAY ONLY: it
   *  touches no vote, no seal and no report (#229). */
  peerAway?: (id: PlayerId) => boolean
  /** what a co-player's tile shows (lib/webrtc/seat-state.ts): Empty seat, No
   *  signal, Connecting…, Can't connect, Weak signal, Away, Camera off, or live.
   *  Undefined for your own tile, and with no live mesh. DISPLAY ONLY: no vote,
   *  seal or report reads it, only `tappable`'s gesture gate. */
  seat?: (id: PlayerId) => SeatState | undefined
  /** YOUR side of the mesh, as one signal: connected while any link to the
   *  group holds (undefined = no live mesh) */
  yourSignal: PeerSignal | undefined
  /** the SUBTLE in-game tier: most links struggling but not everyone gone —
   *  shown as a quiet notice, never an interruption */
  troubled: boolean
  /** THE NO-HOST TURN: the host's feed is not on screen —
   *  a chair nobody holds, a registered no-show, or a dropped link, and the
   *  tile cannot tell them apart. It is a CUE ONLY: the
   *  glowing pill replaces the tutorial pills. The turn still votes like any
   *  other — every co-player is votable and the seal rejects the untapped.
   *  Debounced, so a round-change flap never flashes it. */
  hostFeedMissing: boolean
  /** media */
  mesh: MeshView
  /** your own camera — the stream your tile shows and the mesh sends */
  camera: CameraState
}

/** how long one stored-votes read may take before another is started (#568) */
const VOTE_READ_ATTEMPT_MS = 3_000

export function useGameSession(): GameSessionView {
  const router = useRouter()
  // the chain: identity, signalling, and the game as the pallet sees it —
  // present in a host with a started game
  const [source, setSource] = useState<GameSource>()
  const [liveView, setLiveView] = useState<LiveGameView | null>(null)
  const [submitted, setSubmitted] = useState(false)
  // the report counted: the payoff normally opens on the DRAW, whose winners
  // are drawn before play ends while the collectables waits for THIS game to settle.
  // When the waiting-room game-row read already proved that no draw was
  // scheduled, there is no ceremony to show and the payoff begins at the
  // collectables screen instead. Unknown stays on the draw route for a fresh read.
  // Name the game for every screen after. From here to the collectables screen every step
  // REPLACES the page, never pushes one (#427): the end screens share one
  // history entry, so Android's Back cannot walk back into the game or the
  // draw, and on the collectables screen it finds no history and the host collapses us.
  const finishReport = (gameIndex: number) => {
    setSubmitted(true)
    reportLanded(gameIndex)
    void markSeen(gameIndex, "report")
    const scheduled = peekDrawSchedule(gameIndex)
    if (scheduled === 0) drawShown({ kind: "none" }, null, gameIndex)
    router.replace(`${drawEntryPath(scheduled)}?game=${gameIndex}`)
  }
  // the kickoff stored at the waiting-room handover (chain seconds), so the
  // countdown stands the instant /game mounts, before the live view resolves.
  // The prerender has no storage, so hydration reads null and storage after it.
  const seededGameDate = useSyncExternalStore(noSubscribe, readJoinedGameAt, noJoinedGameAt)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    void getGameSource().then((resolved) => {
      if (!resolved || cancelled) return
      setSource(resolved)
      // THE LIVE VIEW IS POLLED UNTIL IT RESOLVES. It exists from the shuffle
      // on, but one read can still land early (a boundary tick, a slow store),
      // and a single null must never leave the session with no game.
      const attempt = async () => {
        const view = await resolved.gameView()
        if (cancelled) return
        if (!view) {
          // A RELAUNCH PAST REPORTING. gameView() resolves in Shuffle and
          // Reporting alone, and the chain can have left Reporting already
          // (#596): when the game this device joined has, its report status
          // says where the player goes, as the handover below would.
          const handoff = await resolvePostGameHandoff(resolved)
          if (cancelled) return
          if (handoff) {
            if (handoff.report === "sent") return finishReport(handoff.gameIndex)
            trail(handoff.report === "not-sent" ? "report missed" : "report unknown after the game", { gameIndex: handoff.gameIndex })
            router.replace(handoff.href)
            return
          }
          timer = setTimeout(() => void attempt(), LIVE_POLL_MS)
          return
        }
        // the screens after the game ask for it, not only the URL (lib/post-game)
        rememberPostGame(view.gameIndex)
        setLiveView(view)
        // A REJOIN FINDS THE REPORT IN. The submit of a session that was
        // reloaded mid-flight still lands, and the rejoined session starts
        // from nothing: when the chain says our report counted, go on to the
        // draw instead of filing a second one the pallet would refuse.
        if (view.reportSent) {
          finishReport(view.gameIndex)
        }
      }
      void attempt()
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  // finishReport only calls state setters and the router: stable for this effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])
  // THE GAME CLOCK. The chain's own timing when a live game exists — read
  // off `liveView`, so a `gameView()` that resolves late is picked up the
  // moment it lands. Without one there is no game and nothing ticks.
  const timing = useMemo<GameTimingInfo | undefined>(() => {
    if (liveView) return liveView.timing
    return undefined
  }, [liveView])
  /** THE TURN KEY'S STRIDE. Votes live under `round * stride + hostPosition`,
   *  so the stride must hold for the whole game — never the round's own group
   *  size. `maxGroupSize` is the chain's constant for the game and the seat
   *  count of every round, and `hostPosition < maxGroupSize`, so no two turns
   *  collide. Zero is read only while `timing` is unset, when there is no
   *  round and no key. A ref carries the value into the tick, whose interval
   *  outlives the render; `turnKey` below reads the same `stride`, and this
   *  effect is declared before the tick's, so it lands first on every
   *  commit. */
  const stride = timing?.maxGroupSize ?? 0
  const strideRef = useRef(stride)
  useEffect(() => {
    strideRef.current = stride
  }, [stride])
  // the game the mesh's TURN credentials must outlive, as the chain scheduled
  // it (#1348). Declared before the mesh, so it lands before the mesh opens.
  const gameRounds = liveView?.timing.rounds
  const gameGroupCap = liveView?.timing.maxGroupSize
  useEffect(() => {
    setTurnGameShape(gameRounds !== undefined && gameGroupCap !== undefined ? { rounds: gameRounds, maxGroupSize: gameGroupCap } : undefined)
  }, [gameRounds, gameGroupCap])
  const [tickedSnapshot, setSnapshot] = useState<GameSnapshot>()
  // THE TURN BOOKS (lib/turn-books): every game-scoped value the turn
  // bookkeeping reads or writes — the votes (PER TURN, the cards reset each
  // turn, all of them stored: the confirm stage prefills its verdicts from
  // the majority), the seals, the first-opened turn, the decoded-video
  // history, the bans and the confirm overrides. The ref is the authority:
  // the tick, the restore and the gestures read and write it synchronously.
  // The state mirrors it for the render, and is set only when a field the
  // render reads changed, so a quiet tick re-renders nothing.
  const [books, setBooks] = useState<TurnBooks>(emptyTurnBooks)
  const booksRef = useRef(books)
  const commitBooks = (next: TurnBooks) => {
    const before = booksRef.current
    booksRef.current = next
    if (RENDERED_BOOKS.some((field) => !Object.is(before[field], next[field]))) setBooks(next)
  }
  const {
    turnVotes,
    banVotes,
    firstOpenedTurn,
    videoRoleHistory,
    banned: bannedKeys,
    coldReconciled,
    sealEpoch,
    topUpEpoch,
  } = books
  // THE VOTE TRAIL's books. The tick's seal reads the votes as last rendered,
  // so its log line is written once, outside any state updater (which React
  // may run twice).
  const turnVotesRef = useRef<TurnVotes>({})
  useEffect(() => {
    turnVotesRef.current = turnVotes
  })
  const recapRecordedRef = useRef(false)
  const tapsRef = useRef(0)
  const tapSentSeqRef = useRef(new Map<string, number>())
  /** how the report is being filed: the engine sets it, a CTA tap leaves it */
  const filedByRef = useRef<"auto-confirm" | "tap">("tap")
  /** One game-scoped authority for the confirm evidence boundary, restored
   * choices and #871 provenance. React mirrors it for render consumers; the
   * ref closes same-tick restore/frame/confirm gaps. */
  const [renderedEvidence, setRenderedEvidence] = useState<EvidenceProjectionState>(emptyEvidenceProjection)
  const evidenceRef = useRef(renderedEvidence)
  const commitEvidence = (next: EvidenceProjectionState) => {
    evidenceRef.current = next
    setRenderedEvidence(next)
  }
  // the roster the tick's books read, AS LAST RENDERED: the ban's reach into
  // a turn the tick opens and who a turn's SEAL can reject are resolved
  // through THAT turn's round — at a round change the tick runs before the
  // render that draws the new group, so the seat must be read in the turn's
  // own round, never the one on screen — and they are the LIVE group's. A
  // ref, because the tick's interval outlives the render that built the
  // resolver.
  const rosterRef = useRef<Omit<TurnWorld, "stride" | "renderedVotes">>({
    candidates: () => [],
    host: () => "none",
    banned: new Set(),
  })
  const turnWorld = (): TurnWorld => ({
    ...rosterRef.current,
    stride: strideRef.current,
    renderedVotes: turnVotesRef.current,
  })
  /** the trail a books step returns, replayed in order: rows to the vote
   *  trail, the away latch and the counts where they fall between them */
  const replayTrail = (steps: readonly TurnBooksStep[]) => {
    for (const step of steps) {
      if (step.kind === "row") trail(step.message, step.data)
      else if (step.kind === "away") markAwayRef.current()
      else recordCount(step.metric, step.value, {})
    }
  }
  // the report's own status. We celebrate (navigate to the collectables screen) ONLY on a
  // resolved submit: a rejected report must not look like a counted vote.
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "error">("idle")
  /** Pure report decisions. React remains the command interpreter until the
   *  session itself becomes the step-3 orchestrator. */
  const outboxRef = useRef<OutboxState>(emptyReportOutbox())
  const reportRetryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reportRetryCountRef = useRef(0)
  const reportGenerationRef = useRef(0)
  const reportFailureRecordedRef = useRef(false)
  const reportTerminalFailureRef = useRef<{ detail: string; reason: "refused" | "timeout" } | null>(null)
  const mountedRef = useRef(true)
  // the auto-confirm: an AUTO_CONFIRM_SEC window once every verdict is in.
  // A changed confirm verdict restarts it, bounded by report_ends' last call;
  // once filing begins the verdicts stay locked through automatic retries.
  const [autoCancelled, setAutoCancelled] = useState(false)
  const [autoCount, setAutoCount] = useState(AUTO_CONFIRM_SEC)
  // A ref keeps taps from re-arming the effect itself. The running interval
  // owns the one deadline and consumes each changed choice in order.
  const autoRestartRef = useRef({ sequence: 0, hardStopAt: -Infinity, capSlackMs: 0 })
  // a tap on the CTA, waiting to be read by the running countdown. A ref, not
  // state: the tap moves the ONE deadline the engine already owns, and a
  // second clock would let the label and the fire drift apart.
  const autoRushRef = useRef(false)
  // A failed handover probe accelerates only a later report retry. It must not
  // impersonate a CTA tap or skip the player's confirm review window.
  const reportRetryRushRef = useRef(false)
  // THE BACKGROUND (#201). Set ONCE, on the transition, when the page was
  // hidden or frozen at any time between the join and the confirm stage: the
  // auto-confirm then never runs and the player confirms by hand. The ref
  // keeps the transition single, the state is what the view reads.
  const awayRef = useRef(false)
  const [awayDuringGame, setAwayDuringGame] = useState(false)
  const [awayPending, setAwayPending] = useState(false)
  const markAway = () => {
    if (awayRef.current) return
    outboxRef.current = reportOutbox(outboxRef.current, { kind: "stored-away" }).state
    awayRef.current = true
    setAwayDuringGame(true)
    // why no auto-confirm will run: on the vote trail and the game journey
    trail("auto-confirm off", { reason: "off-after-background" })
    autoConfirmOff()
  }
  const markAwayRef = useRef(markAway)
  const awayHiddenAtRef = useRef<number | undefined>(undefined)
  const awayThresholdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    markAwayRef.current = markAway
  })
  // set at the top of confirmVotes, before the report is built, so a tap in
  // the same tick still finds the tiles locked; a failed submit clears it
  const reportLockedRef = useRef(false)
  /** the chain shut the report window before report_ends: the game left
   *  Reporting early, once every attendance was decided (#596) */
  const [chainClosed, setChainClosed] = useState(false)

  // THE VOTES SURVIVE A RESTART (lib/game-votes). Once the live view names the
  // game, the votes, bans and confirm overrides stored for it come back, and
  // only then does saving start, so an empty session never writes over the
  // stored ones. A slow host read releases the missed-turn reconcile after
  // three seconds, but saving remains off until that read finishes and merges.
  const voteGame = liveView?.gameIndex
  const voteAccount = source?.player
  const [voteRestoreReleased, setVoteRestoreReleased] = useState(false)
  const [votesRestored, setVotesRestored] = useState(false)
  /** the stored read or the clock never settled and the report window is
   *  nearly shut: confirm opens its whole gate and files what the session has
   *  rather than miss the report (#565) */
  const [confirmReleased, setConfirmReleased] = useState(false)
  useEffect(() => {
    if ((voteGame === undefined) || !voteAccount) return
    let cancelled = false
    let released = false
    /** the first read that answers wins; a later answer merges nothing */
    let settled = false
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
    }
    const timer = setTimeout(() => {
      if (cancelled) return
      released = true
      devLog("vote", "stored votes read timed out", { gameIndex: voteGame }, "warn")
      setVoteRestoreReleased(true)
    }, 3_000)
    // EACH ATTEMPT IS BOUNDED (#568). A host read that never answers would
    // otherwise keep saving off for the whole session, and a later relaunch
    // would seal the turns this one tapped from the older stored entry. An
    // attempt that outlives VOTE_READ_ATTEMPT_MS is retried with the backoff
    // of a failed one, but stays alive: a slow read that answers still wins.
    const read = (backoffMs = 1_000) => {
      let given = false
      const giveUp = () => {
        if (given || cancelled || settled) return false
        given = true
        later(() => read(Math.min(backoffMs * 2, 8_000)), backoffMs)
        return true
      }
      later(() => {
        if (giveUp()) devLog("vote", "stored votes read attempt timed out; retrying", { gameIndex: voteGame }, "warn")
      }, VOTE_READ_ATTEMPT_MS)
      void loadVotes(voteGame, voteAccount).then((result) => {
        if (cancelled || settled) return
        if (!result.ok) {
          giveUp()
          return
        }
        settled = true
        restore(result.value)
      })
    }
    const restore = (stored: StoredVotes | null) => {
      clearTimeout(timer)
      // the page before this one was away during the game: so is this one (#599)
      if (stored?.away) markAwayRef.current()
      if (stored) {
        commitEvidence(
          evidenceProjection(evidenceRef.current, {
            kind: "restore-choices",
            overrides: stored.overrides,
            unseenFlipped: stored.unseenFlipped,
          }),
        )
      }
      // the merge, the #570 re-run and the #567 top-up are the books'
      // (lib/turn-books restoreBooks)
      const restored = turnBooks(booksRef.current, { kind: "restore", stored, released }, turnWorld())
      commitBooks(restored.books)
      replayTrail(restored.trail)
      setVotesRestored(true)
      setVoteRestoreReleased(true)
    }
    read()
    return () => {
      cancelled = true
      clearTimeout(timer)
      timers.forEach(clearTimeout)
    }
  }, [voteGame, voteAccount])
  useEffect(() => {
    if (!votesRestored || submitted || voteGame === undefined || !voteAccount) return
    const entry: StoredVotes = {
      gameIndex: voteGame,
      account: voteAccount,
      turnVotes,
      banned: [...bannedKeys],
      overrides: renderedEvidence.finalOverrides,
      unseenFlipped: [...renderedEvidence.unseenFlipped],
      autoSeals: booksRef.current.autoSeals,
      banVotes: booksRef.current.banVotes,
      firstOpenedTurn,
      videoRoleHistory: booksRef.current.videoRoleHistory,
      ...(awayDuringGame ? { away: true as const } : {}),
    }
    const reduced = reportOutbox(outboxRef.current, { kind: "save-votes", entry })
    outboxRef.current = reduced.state
    const save = reduced.commands.find((command) => command.kind === "save-votes")
    if (save?.kind === "save-votes") void saveVotes(save.entry)
  }, [votesRestored, submitted, voteGame, voteAccount, turnVotes, banVotes, bannedKeys, renderedEvidence, firstOpenedTurn, videoRoleHistory, awayDuringGame, sealEpoch])
  // the report landed: nothing is left to restore
  useEffect(() => {
    if (!submitted) return
    void clearVotes()
  }, [submitted])

  // tick the real state machine twice a second once there is a game to tick;
  // the turn bookkeeping it drives is the books' (lib/turn-books turnBooks)
  // the game's clock: the SOURCE's when a live game exists (the step-free
  // device clock, corrected by the peers), else the wall clock
  const clock = liveView && source ? source.nowSeconds : nowSeconds
  const unexplainedJumpMs = liveView && source?.unexplainedJumpMs ? source.unexplainedJumpMs : noUnexplainedJump
  const firstMidGameTickAtRef = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    if (!timing) return
    // a frozen page fires no event: the GAME clock jumping between two ticks
    // is the only sign. Not watched once the confirm stage is open. The game
    // clock, not the wall: a phone clock stepped +30 s is no freeze, and the
    // source's clock takes the step out (lib/device-clock.ts, #331), while a
    // real freeze moves it — the wall across a hidden page, or the peer check
    // after a visible freeze. A peer jump with no step is no freeze (#1033).
    let lastTickAt = clock() * 1000
    let lastJumpMs = unexplainedJumpMs()
    let confirmOpen = false
    const tick = () => {
      const nowSecond = clock()
      const now = nowSecond * 1000
      const jumpMs = unexplainedJumpMs()
      const freezeGapMs = now - lastTickAt - (jumpMs - lastJumpMs)
      lastTickAt = now
      lastJumpMs = jumpMs
      // a `waiting-room` snapshot is the connect beat, not an error: the
      // handover lands `CONNECTION_STAGE_DURATION` (64 s) before T-0
      // (lib/joined.ts `handoverAt`), and the loop simply has no turn to open
      // until the clock reaches round 0
      const snap = calculateSnapshot(nowSecond, timing)
      const remountClock = remountClockState(
        firstMidGameTickAtRef.current,
        source?.clockState?.(),
        snap,
        nowSecond,
        booksRef.current.restoredFirstOpenedTurn,
        cameThroughWaitingRoom(timing.gameDate),
      )
      firstMidGameTickAtRef.current = remountClock.boundarySecond
      const ticked = turnBooks(
        booksRef.current,
        {
          kind: "tick",
          snapshot: snap,
          clock: {
            timing,
            state: remountClock.state,
            restorePending: Boolean(voteAccount) && !voteRestoreReleased,
            frozeAway:
              !confirmOpen &&
              pageFroze(0, freezeGapMs, SESSION_TICK_MS) &&
              freezeGapMs >= AUTO_CONFIRM_AWAY_THRESHOLD_MS,
            chainSeen: () => chainNowMs() !== null,
            viaDoor: () => cameThroughWaitingRoom(timing.gameDate),
          },
        },
        turnWorld(),
      )
      commitBooks(ticked.books)
      // a clock that is not ready yet keeps the last trustworthy screen
      if (ticked.stage !== "cold") setSnapshot(snap)
      replayTrail(ticked.trail)
      if (ticked.stage === "ran") confirmOpen = snap.kind === "reporting" || snap.kind === "finished"
    }
    tick()
    const timer = setInterval(tick, SESSION_TICK_MS)
    return () => clearInterval(timer)
    // firstOpenedTurn re-arms the tick: a change re-runs it at once, with a
    // fresh freeze baseline
  }, [timing, clock, unexplainedJumpMs, source, voteAccount, voteRestoreReleased, firstOpenedTurn])

  // THE SNAPSHOT this render draws from. The tick's own once it has run; until
  // then the same arithmetic over the same clock, so the render that first
  // sees the game already stands on its real phase — a rejoin mid-game draws
  // the live grid on its first frame, never one frame of connect chrome.
  // A fresh cold mount (a clock that is not ready) is the exception: it shows
  // only the joining or the waiting screen. The shipped source is ready at
  // once (lib/game-source.ts `clockState`), so this branch is defensive and
  // only test sources reach it. A session that turns cold later retains its
  // last trusted ticked snapshot above.
  const renderClockState = source?.clockState?.()
  const freshCold = tickedSnapshot === undefined && renderClockState !== undefined && !renderClockState.ready
  const snapshot = tickedSnapshot ?? (timing && !freshCold ? calculateSnapshot(clock(), timing) : undefined)
  const coldNow = freshCold && timing ? clock() : undefined
  const joining = coldNow !== undefined && timing ? joiningRound(coldNow, timing) : null
  const coldAfterKickoff = coldNow !== undefined && timing !== undefined && coldNow >= timing.gameDate
  const observedSourceNowSeconds = source ? source.nowSeconds() : undefined

  // THE PAGE LEAVING (#201, #729): a short shade/app-switcher blip keeps
  // auto-confirm armed. Ten seconds hidden cancels it, either while still
  // away (the timer) or on return (wall time catches a frozen timer). Silent
  // freezes are handled by the tick above with the same threshold.
  const confirmOpen = snapshot?.kind === "reporting" || snapshot?.kind === "finished"
  useEffect(() => {
    const clearThreshold = () => {
      clearTimeout(awayThresholdTimerRef.current)
      awayThresholdTimerRef.current = undefined
    }
    if (!timing) {
      awayHiddenAtRef.current = undefined
      outboxRef.current = reportOutbox(outboxRef.current, { kind: "away-reset" }).state
      clearThreshold()
      const reset = setTimeout(() => setAwayPending(false), 0)
      return () => clearTimeout(reset)
    }
    const armThreshold = () => {
      clearThreshold()
      const hiddenAt = awayHiddenAtRef.current
      if (hiddenAt === undefined) return
      const remaining = AUTO_CONFIRM_AWAY_THRESHOLD_MS - (awayLatchNowMs() - hiddenAt)
      if (remaining <= 0) markAwayRef.current()
      else awayThresholdTimerRef.current = setTimeout(() => {
        const reduced = reportOutbox(outboxRef.current, { kind: "away-threshold" })
        outboxRef.current = reduced.state
        if (reduced.commands.some((command) => command.kind === "auto-confirm-off")) markAwayRef.current()
      }, remaining)
    }
    const hidden = () => {
      // A new absence after confirm opens is irrelevant. One that began in
      // the game remains live across that render transition, below.
      if (confirmOpen || awayHiddenAtRef.current !== undefined) return
      awayHiddenAtRef.current = awayLatchNowMs()
      outboxRef.current = reportOutbox(outboxRef.current, {
        kind: "hidden",
        clock: { monotonicMs: performance.now(), gameMs: clock() * 1000, latchMs: awayHiddenAtRef.current, chainAnchored: chainNowMs() !== null },
      }).state
      setAwayPending(true)
      armThreshold()
    }
    const shown = () => {
      const hiddenAt = awayHiddenAtRef.current
      if (hiddenAt !== undefined) {
        const reduced = reportOutbox(outboxRef.current, {
          kind: "shown",
          clock: { monotonicMs: performance.now(), gameMs: clock() * 1000, latchMs: awayLatchNowMs(), chainAnchored: chainNowMs() !== null },
        })
        outboxRef.current = reduced.state
        if (reduced.commands.some((command) => command.kind === "auto-confirm-off")) markAwayRef.current()
      }
      awayHiddenAtRef.current = undefined
      setAwayPending(false)
      clearThreshold()
    }
    if (pageHidden()) {
      if (awayHiddenAtRef.current === undefined) hidden()
      else armThreshold()
    } else if (awayHiddenAtRef.current !== undefined) shown()
    if (confirmOpen && awayHiddenAtRef.current === undefined) return
    const unwatch = watchPageHidden(hidden, shown)
    return () => {
      // Keep the timestamp: this cleanup may only mean the confirm stage
      // opened while the page was still hidden (#729).
      clearThreshold()
      unwatch()
    }
  // The clock doorway is selected by source/liveView; those dependencies
  // already re-arm this watcher without changing the latch's lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timing, confirmOpen])
  // THE PHASE follows the snapshot and nothing else: the chain leaves a
  // pre-connect window before round 0 and that window IS the connect beat.
  // `idle` cannot be reached from the waiting room's door, but if it were it
  // is still "before the game". Everything from round 0 on — the rounds, the
  // report window, the end — is the game, and the confirm stage reads the
  // non-round kinds from `snapshot` itself.
  const phase: SessionPhase =
    snapshot !== undefined && snapshot.kind !== "idle" && snapshot.kind !== "waiting-room"
      ? "live"
      : "connecting"
  const hostHealthPhase = phase === "connecting" ? "pre-game" : snapshot?.kind === "round" ? "round" : "post-game"
  const {
    card: hostHealth,
    consecutiveLost: hostStuckConsecutiveOpens,
    probe: probeHostHealth,
    noteHealthy: noteHostHealthy,
  } = useChainHealthCard({
    source,
    waiting: false,
    phase: hostHealthPhase,
    registered: true,
    probeOnOpen: false,
    turnWhere: phase === "connecting" ? "handover" : "recheck",
  })
  const hostStuck = hostHealth.lost
  const hostStuckRef = useRef(hostStuck)
  useEffect(() => {
    hostStuckRef.current = hostStuck
  }, [hostStuck])
  const previousHostStuckRef = useRef(false)
  useEffect(() => {
    const previous = previousHostStuckRef.current
    previousHostStuckRef.current = hostStuck
    if (hostStuck && !previous)
      devLog("chain", "host stuck during game", { phase }, "warn")
    else if (!hostStuck && previous)
      devLog("chain", "host answering during game after stuck transition", { phase })
  }, [hostStuck, phase])

  // A live statement proves the host-backed store recovered without asking
  // the signing bridge to build another transaction on its old resumed path.
  // The mesh publishes a snapshot every second; compare successful activity,
  // never the absolute counters, so evidence from before the bar appeared
  // cannot clear it. TURN proof success is handled by useChainHealthCard's
  // outcome observer through the same ordered `noteHealthy` path.
  useEffect(() => {
    let previous = getHealthSnapshot()?.stats ?? null
    const freshStoreEvidence = () => {
      const current = getHealthSnapshot()?.stats ?? null
      const fresh =
        previous !== null &&
        current !== null &&
        (current.submitsOk > previous.submitsOk ||
          current.framesRecv > previous.framesRecv ||
          current.lastSubmitOkAt > previous.lastSubmitOkAt ||
          current.lastInboundAt > previous.lastInboundAt)
      previous = current
      if (fresh && hostStuckRef.current && hostHealthPhase === "round")
        void noteHostHealthy("recheck")
    }
    return subscribeHealth(freshStoreEvidence)
  }, [source, liveView?.gameIndex, hostHealthPhase, noteHostHealthy])

  // /game mounting is the one handover checkpoint. It is diagnostic only and
  // never holds the camera/mesh handover. A known loss collapses the confirm
  // countdown later; the report attempt itself then owns all retries.
  const handoverHealthRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if ((phase !== "connecting") || !liveView) return
    if (handoverHealthRef.current === liveView.gameIndex) return
    handoverHealthRef.current = liveView.gameIndex
    void probeHostHealth("handover").then((result) => {
      if (result?.outcome === "host-chain-lost") {
        reportRetryRushRef.current = true
        outboxRef.current = reportOutbox(outboxRef.current, { kind: "host-chain-lost" }).state
      }
    })
  }, [phase, liveView, probeHostHealth])

  // During active play: the first probe 10 s in, then every 10 s, and every
  // 30 s after two healthy samples in a row. A timeout retries immediately
  // after its own five-second bound so a real stall gets the required second
  // sample without six healthy probes/minute.
  // Confirm/report never probe merely because /game is still mounted.
  useEffect(() => {
    if ((phase !== "live") || snapshot?.kind !== "round" || !source?.probeChainHealth || !liveView) return
    let stopped = false
    let healthySamples = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (delayMs: number) => {
      timer = setTimeout(() => void probe(), delayMs)
    }
    const probe = async () => {
      const result = await probeHostHealth("recheck")
      if (!result) return
      if (stopped) return
      const timedOut = result.outcome === "unknown" && result.errorClass === "timeout"
      healthySamples = result.outcome === "healthy" ? healthySamples + 1 : 0
      schedule(timedOut ? 0 : hostStuckRef.current ? 10_000 : healthySamples >= 2 ? 30_000 : 10_000)
    }
    schedule(10_000)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [source, liveView, phase, snapshot?.kind, probeHostHealth])

  /** turns per round for the pill bar, from the game's group cap. The engine
   *  owns the arithmetic, so the bar and the state machine agree on every
   *  round's turn count. */
  const turnsEachRound = useMemo(() => (timing ? turnsPerRound(timing) : []), [timing])

  // YOUR OWN CAMERA, the one the mesh sends (lib/camera): held for as long as
  // the game is on screen, so your tile shows you before the first room forms
  // and across every round change.
  const camera = useCamera(true, "join")

  // THE JOIN (lib/journeys/game-trace): /game mounting IS the handover (or a
  // rejoin). Declared after useCamera, so a waiting-room camera already
  // reads live here and the step records it as warm.
  useEffect(() => {
    beginJoin({ cameraWarm: cameraState().kind === "live" })
    requestCameraJoinCheck()
    return () => leftGame()
  }, [])
  const joinedGame = liveView?.gameIndex
  const joinedGameEnds = liveView?.timing.reportEnds
  useEffect(() => {
    if (joinedGame === undefined || joinedGameEnds === undefined || !source) return
    noteGame(joinedGame, gameClockLead(source).lead, joinedGameEnds)
    cameraHandoverSummary(joinedGame)
  }, [joinedGame, joinedGameEnds, source])
  // A late join did not pass through the waiting room's TURN warm-up. Begin
  // the proof and credential request at /game handover while the clock is not
  // ready yet (`freshCold`, defensive: the shipped source's clock is ready at
  // once); room-open then joins this request or its cache.
  const turnAccount = source?.playerAccountId
  const turnAccountKey = turnAccount
    ? Array.from(turnAccount, (byte) => byte.toString(16).padStart(2, "0")).join("")
    : ""
  const stableTurnAccount = useMemo(
    () => turnAccount,
    // The account getter may return fresh bytes on each render. Its content
    // key owns this memo so TURN receives the original array without causing
    // repeated warm-ups or a hex-to-bytes reconstruction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turnAccountKey],
  )
  useEffect(() => {
    if (!freshCold || !stableTurnAccount) return
    setTurnPlayerAccount(stableTurnAccount)
    const abort = new AbortController()
    void warmIceServers(abort.signal)
    return () => abort.abort()
  }, [freshCold, stableTurnAccount])
  useEffect(() => {
    if (camera.kind === "live") cameraSettled({ kind: "live" })
    else if (camera.kind === "unavailable") cameraSettled({ kind: "unavailable", reason: camera.reason })
  }, [camera])

  const inRound = snapshot?.kind === "round" ? snapshot : undefined
  // THE GAME (lib/journeys/game-trace): the round on the game clock
  const liveRound = inRound ? inRound.round : null
  // the rotation countdown keeps the round's smoothness scene running
  const betweenRounds = snapshot?.kind === "between-rounds"
  const diagnosticTurn = inRound ? inRound.round * stride + inRound.hostPosition : undefined
  useEffect(() => {
    roundChanged(liveRound, betweenRounds, diagnosticTurn)
  }, [liveRound, betweenRounds, diagnosticTurn])
  // the game clock's lead on the device clock, in seconds. It is read each
  // render but held while it moves less than its hold, so the kickoff stays put.
  const lead = source ? gameClockLead(source) : { lead: 0, holdMs: 0 }
  const [heldLead, setHeldLead] = useState(lead)
  if (Math.abs(lead.lead - heldLead.lead) * 1000 > Math.min(lead.holdMs, heldLead.holdMs)) setHeldLead(lead)
  const clockOffset = heldLead.lead
  // the gap between two rounds: the game clock counts it, no timer does.
  // The next group moves in GAP_LEAVE_SECONDS into it, on the device clock.
  const enterAt =
    snapshot?.kind === "between-rounds" && timing
      ? timing.gameDate -
        clockOffset +
        roundStart(timing, snapshot.nextRound) -
        snapshot.gapDuration +
        GAP_LEAVE_SECONDS
      : null
  const lastGroupLeaving = enterAt !== null && nowSeconds() < enterAt
  const roundChange: RoundChange | null =
    snapshot?.kind === "between-rounds"
      ? {
          seconds: Math.ceil(snapshot.secondsToNextRound),
          enterAt: lastGroupLeaving ? null : enterAt,
        }
      : null

  // ── the live group: the round's seats, and who sits in them
  /** the round whose group the grid draws: the running round, round 0
   *  before kickoff, and over the gap the last round while it leaves, then
   *  the next round. The confirm screen has no round — it reads every
   *  round's group. */
  const gridRound = inRound
    ? inRound.round
    : snapshot?.kind === "waiting-room"
      ? 0
      : snapshot?.kind === "between-rounds"
        ? lastGroupLeaving
          ? snapshot.nextRound - 1
          : snapshot.preconnectRound
        : null
  const liveSeats = gridRound !== null ? liveView?.seats[gridRound] : undefined
  /** who sits in a seat of one round's group. A chair the shuffle never
   *  reached gets the chair's own id (`ghostId`), so a group of one can still
   *  name the empty chair that hosts its turn. */
  const idIn = (round: number, slot: number): PlayerId | undefined => {
    if (liveView) {
      const seat = liveView.seats[round]?.[slot]
      if (!seat) return undefined
      return seat.player ? playerIdOf(seat.player) : ghostId(round, slot)
    }
    return undefined
  }
  /** who sits in a seat of the group on screen */
  const idAt = (slot: number): PlayerId | undefined =>
    liveView && gridRound === null ? undefined : idIn(gridRound ?? 0, slot)
  /** how many players hold a seat of one round's group. The held seats are
   *  always 0..n-1, so this is all `hostSeat` needs to name a turn's host. */
  const groupSizeIn = (round: number): number =>
    liveView
      ? (liveView.seats[round]?.filter((seat) => seat.player !== null).length ?? 0)
      : 0
  /** the turns a round has: the game's group cap, the same in every round. A
   *  group smaller than it wraps its hosts around its own seats (`hostSeat`).
   *  Without a live game there is no group, and nothing to draw. */
  const turns = liveView ? liveView.timing.maxGroupSize : 0
  /** every chair of a round, held or not, ascending */
  const chairs = Array.from({ length: turns }, (_, i) => i)
  /** the seats of the group on screen a player holds, one tile each: a chair
   *  nobody holds gets no tile (#1347). The held seats are always 0..n-1. */
  const members = Array.from({ length: groupSizeIn(gridRound ?? 0) }, (_, i) => i)
  /** the seats of this round a registered player holds */
  const players = liveView
    ? (liveSeats?.filter((seat) => seat.player !== null).length ?? 0)
    : 0
  const youSlot = liveView
    ? (gridRound !== null ? (liveView.mySeat[gridRound] ?? -1) : -1)
    : -1
  /** YOU, for the whole game: the doorway's own player in a live game. It
   *  outlives the round, because the confirm screen stands outside every
   *  group. */
  const youId: PlayerId | null = liveView
    ? (source?.player ?? null)
    : null

  // ── the roster on screen ───────────────────────────────────────────────
  // stage 3: the rounds are over — confirm your votes (same grid, seamless)
  const confirming =
    (snapshot?.kind === "reporting" || snapshot?.kind === "finished") && !submitted
  // Confirm is forward-only (#441), so the derived value itself is the
  // synchronous evidence boundary; no effect-sized acceptance window exists.
  const clockReady =
    renderClockState === undefined ||
    (renderClockState.ready && (renderClockState.coldStartedAt === undefined || coldReconciled))
  // CONFIRM STANDS ON THE STORED BOOKS (#565): after a relaunch the local
  // decoded-video history is empty until the stored read lands, and a freeze
  // or an auto-confirm before that reads every co-player as unseen and files
  // NotPerson against the player's own taps. So the
  // evidence freezes, and the auto-confirm and the CTA arm, only once the read
  // has finished (or there is nothing to read) AND the clock has settled. The
  // release near report_ends opens the whole gate whatever is still missing.
  // Once open the gate stays open (a late read re-running the cold reconcile
  // must not blink it and restart the countdown). Frames are not recorded from
  // confirm open (markVideoArrived), so the frozen evidence is the live history
  // as of confirm open plus whatever the stored read merged before the freeze.
  const restoreDone =
    (voteGame === undefined) || !voteAccount || votesRestored || confirmReleased
  // RENDER-TIME REF READS. Confirm is the synchronous evidence boundary: the
  // evidence projection and the vote books are read from their refs during
  // render, and the evidence ref is written back in the same render, so the
  // values a render shows are the values a confirm in that render files.
  // Each such line below carries its own react-hooks/refs suppression; the
  // rule stays on for the rest of the hook.
  // eslint-disable-next-line react-hooks/refs -- confirm is the synchronous evidence boundary
  let evidence = evidenceRef.current
  if (confirming) evidence = evidenceProjection(evidence, { kind: "enter-confirm" })
  // eslint-disable-next-line react-hooks/refs -- confirm is the synchronous evidence boundary
  evidence = evidenceProjection(evidence, {
    kind: "open-confirm-gate",
    ready: confirming && (confirmReleased || (restoreDone && clockReady)),
    // eslint-disable-next-line react-hooks/refs -- confirm is the synchronous evidence boundary
    videoRoleHistory: booksRef.current.videoRoleHistory,
  })
  // eslint-disable-next-line react-hooks/refs -- confirm is the synchronous evidence boundary
  evidenceRef.current = evidence
  const evidenceGeneration = evidence.evidenceEpoch
  const evidenceFrozen = evidence.intakeClosed
  const confirmReady = evidence.confirmGateOpen
  // eslint-disable-next-line react-hooks/refs -- confirm is the synchronous evidence boundary
  const votesLoading = confirming && !confirmReady
  const evidenceVideoRoleHistory = evidence.frozenVideoRoleHistory ?? videoRoleHistory
  useEffect(() => {
    if (confirming) confirmOpened()
  }, [confirming])
  // a stored read that never answers must not cost the report: release a
  // little before the last-call margin (source clock) and file what we have.
  // The source clock is read on every beat, not once: a page that froze just
  // before confirm can read behind until the peer check corrects its clock
  // (lib/game-source.ts), and a delay computed at arming would then release
  // past report_ends (#598; the auto-confirm's lastCallAt does the same, #331)
  const confirmReportEnds = liveView?.timing.reportEnds ?? null
  useEffect(() => {
    if ((!confirming || confirmReady) || confirmReportEnds === null || !source) return
    const release = () => {
      outboxRef.current = reportOutbox(outboxRef.current, {
        kind: "sync",
        inputs: {
          gameIndex: voteGame,
          reportEndsMs: confirmReportEnds * 1000,
          confirming,
          confirmReady,
          votesMissing: 0,
          hasSubmitPath: Boolean(source.submitReport),
        },
        clock: { monotonicMs: performance.now(), gameMs: source.nowSeconds() * 1000, latchMs: awayLatchNowMs(), chainAnchored: chainNowMs() !== null },
      }).state
      const reduced = reportOutbox(outboxRef.current, {
        kind: "release-tick",
        clock: { monotonicMs: performance.now(), gameMs: source.nowSeconds() * 1000, latchMs: awayLatchNowMs(), chainAnchored: chainNowMs() !== null },
      })
      outboxRef.current = reduced.state
      if (!reduced.commands.some((command) => command.kind === "confirm-release")) return false
      trail("confirm released without the stored votes", { gameIndex: voteGame, degraded: true })
      setConfirmReleased(true)
      return true
    }
    if (release()) return
    const timer = setInterval(() => {
      if (release()) clearInterval(timer)
    }, CONFIRM_RELEASE_POLL_MS)
    return () => clearInterval(timer)
  }, [confirming, confirmReady, confirmReportEnds, source, voteGame])
  // THE DRAW, LOADED AHEAD. The confirm screen is the last few seconds before
  // the report lands and the player is sent to /prize-draw: load that game's
  // draw now (lib/draw/draw-load, shared with the page), warm the wheel's
  // code and the route, so the draw opens on the wheel with nothing to wait
  // for. The draw's winners are picked about a minute into play, so by the
  // confirm screen they are there to read.
  const preloadGame = confirming ? liveView?.gameIndex : undefined
  useEffect(() => {
    if (preloadGame === undefined || !source) return
    devLog("draw", `preloading game ${preloadGame}'s draw on the confirm screen`)
    const draw = loadDraw(source, preloadGame)
    void import("@/lib/draw/wheel/mount").catch(() => {})
    // …and, once the draw has been read, the coins baked ahead of time, so the
    // draw does not wait on their files: the one the player drags into the
    // slit, and a winner's prize coin for its amount. A spectator (the draw
    // read, and no ticket of theirs in it) has no coin to drag; a draw that
    // could not be read is not reason enough to go without
    const coins = import("@/lib/draw/wheel/baked-coin")
    coins.catch(() => {}) // fetched now, awaited after the read: a failure is not unhandled meanwhile
    void draw.promise
      .then(
        (result) => (result?.kind === "ready" ? result.draw : null),
        () => null,
      )
      .then(async (read) => {
        if (read && !read.userTicket) return
        const { loadBakedCoins, loadPrizeCoin } = await coins
        await Promise.all([loadBakedCoins(), read?.won ? loadPrizeCoin(coinAmount(read.prizeUsd), PRIZE_UNIT) : undefined])
      })
      .catch(() => {})
    router.prefetch(`/prize-draw?game=${preloadGame}`)
    // the draw page holds the load from here (lib/draw/draw-load: HELD, NOT LEAKED)
    return () => draw.release()
  }, [preloadGame, source, router])
  /** the group on screen, in the turn's layout (lib/grid-layout turnLayout):
   *  the host top-left, you top-right, and a turn change moves only the tiles
   *  trading places (#546). While CONNECTING, and while the next group moves
   *  in, the grid takes the round's first turn; while the last group leaves it
   *  keeps that round's last. A seat not read yet keeps its slot under its
   *  chair's own id, so filling it in later moves nobody. Until the group has
   *  resolved YOU there is nothing to draw: an empty grid, never one phantom
   *  tile. */
  const layoutTurn = inRound ? inRound.hostPosition : lastGroupLeaving ? turns - 1 : 0
  const rankedIds: PlayerId[] = turnLayout(members.length, youSlot, layoutTurn, turns).map(
    (member) => idAt(member) ?? ghostId(gridRound ?? 0, member),
  )
  // THE CONFIRM GRID reviews THE PEOPLE YOU ATTESTED, so it drops your own
  // tile — a verdict is never about yourself. It also reaches past the round:
  // the chain reshuffles every round, so the last group is not everyone you
  // met, and the roster is the union over all of them, once each.
  const display: PlayerId[] = !confirming
    ? rankedIds
    : liveView
      ? coPlayers(liveView.seats, liveView.mySeat)
      : rankedIds.filter((id) => id !== youId)
  const gameRoster = new Set(
    liveView ? coPlayers(liveView.seats, liveView.mySeat) : rankedIds.filter((id) => id !== youId),
  )
  /** who hosts the turn on screen: the turn wrapped around the group's held
   *  seats (`hostSeat`). The confirm screen has no turn, so no host. */
  const hostId: PlayerId | null = inRound
    ? (idAt(hostSeat(inRound.hostPosition, groupSizeIn(inRound.round))) ?? null)
    : null

  // THE MESH OPENS BEFORE THE FIRST TURN. Round 0's room forms for the
  // whole pre-connect window (`preconnectRound`) behind the dial, so the
  // links are up at kickoff. The gap connects the next round's group the same
  // way from its first second, while the last group is still leaving. A cold
  // page has no snapshot, so its room opens once the clock is ready.
  const meshRound: number | null = meshRoundOfSnapshot(snapshot)
  // the mesh: peers of a round's group. It is address-keyed, so an alias
  // player carries a stable id but no link, and a chair nobody holds has no
  // account at all.
  const accountPeersOf = (round: number): PlayerId[] =>
    (liveView?.seats[round] ?? [])
      .flatMap((seat) => (seat.player?.type === "Account" ? [playerIdOf(seat.player)] : []))
      .filter((id) => id !== youId)
  const meshPeers = meshRound !== null ? accountPeersOf(meshRound) : []
  // THE GAME'S SESSION. The shuffle fixed every round's groups before the
  // pre-game countdown, so the phone links during the countdown to everyone it will play with in
  // ANY round still to come: the mesh round's group with video both ways, a
  // later round's on standby with video held back until their round (useMesh).
  // A player in two rounds keeps one connection; one with no round left is
  // closed at the round change.
  const standbyPeers = (() => {
    if (!liveView || meshRound === null) return [] as PlayerId[]
    const later = new Set<PlayerId>()
    for (let round = meshRound + 1; round < liveView.seats.length; round++)
      for (const id of accountPeersOf(round)) if (!meshPeers.includes(id)) later.add(id)
    return [...later].sort()
  })()
  // ONE ROOM FOR THE GAME: the room never changes at a round, its roster does.
  // The room names the game's labels; what a phone hears is its roster's
  // statements alone (meshPeers + standbyPeers, useMesh; #1959).
  const roomKey = liveView && meshRound !== null && meshPeers.length + standbyPeers.length > 0 ? `g${liveView.gameIndex}` : ""
  // Observe the screen React actually committed, independently of sealThrough's
  // synthetic vote catch-up. A skipped turn is never emitted as a visited turn.
  const replayTurnsRef = useRef<ReturnType<typeof createReplayTurnObserver> | null>(null)
  useEffect(() => {
    if (!liveView || !source) return
    const observer = createReplayTurnObserver(captureReplayObservation)
    replayTurnsRef.current = observer
    const unwatch = watchPageHidden(() => {}, () => observer.resume())
    return () => {
      unwatch()
      observer.stop()
      if (replayTurnsRef.current === observer) replayTurnsRef.current = null
    }
  // A timing/config refresh within this game is itself observed, not a new session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveView?.gameIndex, timing?.gameDate, source?.player])
  useEffect(() => {
    if (!liveView || !source || !timing) return
    try {
      replayTurnsRef.current?.observe({
        gameIndex: liveView.gameIndex,
        timing,
        roomKey,
        meshRound,
        hostId,
        clockReady,
        sourceClockReady: renderClockState?.ready ?? true,
        snapshot: snapshot ?? null,
        sourceNowSeconds: observedSourceNowSeconds ?? null,
        // inside an effect, not a render read: the purity rule only trips here once meshRound is a call result
        // eslint-disable-next-line react-hooks/purity
        commitMonotonicMs: typeof performance === "undefined" ? null : performance.now(),
      })
    } catch { /* Observation failures must never interrupt game effects. */ }
  })
  // the mesh's first statement goes out on the store clock's learned margin:
  // the waiting room calibrated it already, and a late join (no waiting
  // room) calibrates here, before the mesh opens (lib/store-calibration.ts)
  const signalling = useCalibratedSignalling(source?.signalling, source?.calibrateSignalling)
  // the path the links take (lib/webrtc/path-mode.ts): relay only when this
  // phone's network lets no UDP out, decided before the links form
  const path = usePathMode(Boolean(roomKey))
  const meshTurn = inRound ? inRound.round * stride + inRound.hostPosition : null
  const mesh = useMesh({
    roomKey,
    selfId: source?.player ?? "",
    peers: meshPeers,
    standby: standbyPeers,
    createTransport: signalling,
    selfAccountId: source?.playerAccountId,
    round: meshRound,
    gameIndex: liveView?.gameIndex ?? null,
    gameTurn: meshTurn,
    clock: source?.meshClock,
    icePolicy: icePolicyFor(path.probe),
    relayProtocols: path.probe?.relayProtocols,
  })

  // A gesture cast in another round celebrates nothing. A co-player taps you
  // once on each turn, so each turn reads a bucket of its own.
  const acceptedByTurn = useMemo(() => {
    const byTurn = new Map<string, Set<string>>()
    for (const gesture of mesh.gestures) fileGesture(byTurn, acceptKey(gesture.round, gesture.turn, stride), gesture)
    return byTurn
  }, [mesh.gestures, stride])
  const acceptedYou = inRound ? (acceptedByTurn.get(acceptKey(inRound.round, meshTurn, stride))?.size ?? 0) : 0
  const tapLedgerRef = useRef(newTapLedger())
  const tapReceiver = {
    gameIndex: liveView?.gameIndex ?? null,
    self: youId,
    receiverRound: inRound ? inRound.round : null,
    turn: inRound ? inRound.hostPosition : null,
    stride,
    hidden: pageHidden(),
  }
  const tapReceiverRef = useRef(tapReceiver)
  // eslint-disable-next-line react-hooks/refs -- the latest receiver for the gestures effect below
  tapReceiverRef.current = tapReceiver
  useEffect(() => recordNewTaps(tapLedgerRef.current, mesh.gestures, tapReceiverRef.current), [mesh.gestures])

  // ── connection health ──────────────────────────────────────────────────
  // Per-peer: your RTCPeerConnection state to that person, as a signal level.
  const meshActive = meshPeers.length > 0 && Boolean(source?.signalling)
  const signalOf = (state: RTCPeerConnectionState | undefined): PeerSignal => {
    switch (state) {
      case "connected":
        return "connected"
      case "disconnected":
        return "weak" // was here, dropped — the supervisor is healing it
      case "failed":
      case "closed":
        return "disconnected"
      default:
        return "connecting" // new / connecting / never attempted yet
    }
  }
  const peerSignal = (id: PlayerId): PeerSignal | undefined => {
    if (!meshActive || id === youId || !meshPeers.includes(id)) return undefined
    return signalOf(mesh.states.get(id))
  }

  const peerAway = (id: PlayerId): boolean => id !== youId && mesh.away.has(id)

  // what each co-player's tile shows: a chair nobody holds is an empty seat; a
  // player with no account has no link, so we hear nothing from them; everyone
  // else as the mesh settled it (Connecting… until the room opens)
  const seat = (id: PlayerId): SeatState | undefined => {
    if (!meshActive || id === youId) return undefined
    if (isGhostId(id)) return "empty"
    if (!meshPeers.includes(id)) return "no-signal"
    return mesh.seats.get(id) ?? "connecting"
  }

  // The verdict: every peer expected to be here was attempted AND nobody
  // connected (or you are offline) sustained past the grace → it's you →
  // the help page explains. A peer that explicitly said it is away is not
  // evidence that this browser is isolated. When it returns, its still-dead
  // link becomes expected again and starts a fresh ordinary grace.
  const expectedPeers = meshPeers.filter((peer) => !mesh.saidAway.has(peer))
  const attemptedAll = meshActive && expectedPeers.length > 0 && expectedPeers.every((peer) => mesh.states.has(peer))
  const anyConnected = expectedPeers.some((peer) => mesh.states.get(peer) === "connected")
  const offline = typeof navigator !== "undefined" && !navigator.onLine
  const peerHealth = mesh.health()
  const hasPeerPathEvidence = expectedPeers.some((peer) => {
    const health = peerHealth.get(peer)
    return mesh.present.has(peer) || health?.gaveEndpoint === true
  })
  // Your own badge: connected once any link of the group holds, even a weak
  // one (a later round's standby links are not the group). It is a badge
  // only — your tile always shows your own camera.
  const yourSignal: PeerSignal | undefined = !meshActive
    ? undefined
    : offline
      ? "disconnected"
      : meshPeers.some((peer) => {
            const state = signalOf(mesh.states.get(peer))
            return state === "connected" || state === "weak"
          })
        ? "connected"
        : "connecting"
  // Only once a round is RUNNING: never in the pre-connect window, where a
  // mesh still forming bounced players to connection-help before the game
  // began, and never in the confirm window, where a dead mesh judges nothing.
  const isolated = inRound !== undefined && ((attemptedAll && !anyConnected) || (meshActive && offline))
  const playerNetworkIsolated = inRound !== undefined && (offline || (attemptedAll && !anyConnected && hasPeerPathEvidence))
  const peerReturnEpoch = mesh.peerReturnEpoch
  const isolationEpisode = useRef<{
    round: number
    deadline: number
    returnEpoch: number
    extended: boolean
  } | null>(null)
  const isolationRound = inRound ? inRound.round : null
  useEffect(() => {
    // An episode belongs to the round it started in. Across the round change
    // nothing is isolated, so a stale deadline would otherwise fire the
    // moment the next round's peers are attempted and before their links had
    // any chance.
    if (isolationRound === null) {
      isolationEpisode.current = null
    } else if (isolationEpisode.current && isolationEpisode.current.round !== isolationRound) {
      isolationEpisode.current = null
    }
    if (!isolated) {
      // A render where nobody is expected (every peer said away at once) is
      // not a recovery: no link connected, so the sustained failure is the
      // same one. Hold the episode so the churn cannot buy a second grace;
      // only a connected link or the round's end clears it.
      if (!anyConnected) return
      isolationEpisode.current = null
      return
    }
    if (isolationRound === null) return
    const now = isolationClockNow()
    // RECOVERY_GRACE_MS (statement-core, shared with the mesh drop chase and
    // the health ladder): how long "connected to nobody" must persist before
    // we call it. Links flap in correlated bursts during round transitions,
    // and the statement-store handshake alone routinely takes over 10 s. A
    // last resort, so generous.
    const episode = isolationEpisode.current ?? {
      round: isolationRound,
      deadline: now + RECOVERY_GRACE_MS,
      returnEpoch: peerReturnEpoch,
      extended: false,
    }
    // A peer coming back just before the deadline is a new recovery attempt,
    // not the same sustained failure. Give that attempt one full grace, once;
    // further away/back churn cannot postpone a real isolation indefinitely.
    if (!episode.extended && episode.returnEpoch !== peerReturnEpoch) {
      episode.deadline = now + RECOVERY_GRACE_MS
      episode.extended = true
    }
    episode.returnEpoch = peerReturnEpoch
    isolationEpisode.current = episode
    const timer = setTimeout(() => {
      observeLegacyDecision({
        kind: "isolation-commit",
        at: isolationClockNow(),
        event: "isolation-deadline",
        scope: { round: isolationRound },
        decision: "navigate-connection-help",
        landingState: "committed",
        budget: {
          anyConnected,
          extended: episode.extended,
        },
      })
      traceIsolated(getHealthSnapshot()?.verdict?.blame?.layer ?? null)
      router.replace("/connection-help")
    }, Math.max(0, episode.deadline - now))
    return () => clearTimeout(timer)
  }, [isolated, isolationRound, anyConnected, peerReturnEpoch, router])

  // the subtle tier: a MAJORITY of links struggling (but someone still
  // connected — full loss is the isolation verdict above). Debounced so a
  // normal round-transition flap never flashes the notice.
  const struggling = [...mesh.states.values()].filter((state) => state !== "connected").length
  const connectedNow = mesh.states.size - struggling
  const troubledNow =
    phase === "live" && meshActive && connectedNow > 0 && struggling >= connectedNow
  const troubled = useDebounced(troubledNow, 4000, 1000)

  // ── the no-host turn ───────────────────────────────────────────────────
  // The host's feed is not here: a chair nobody holds, a registered no-show,
  // or a link that dropped. A chair's own id is in no stream map, so it
  // reads here with no test of its own.
  // This reads the same two facts the tile draws grain from — no stream from
  // that account, or a link the mesh has closed (a closed link keeps its
  // last stream in the map, so the stream alone would miss the drop).
  const hostFeedMissingNow =
    inRound !== undefined &&
    liveView !== null &&
    hostId !== youId &&
    (hostId === null || !mesh.streams.has(hostId) || peerSignal(hostId) === "disconnected")
  // debounced 1 s both ways, so a flap never flashes the cue, but for ONE
  // turn's host: a reading belongs to the host it was taken for. Shared across
  // the turn change, the last host's missing feed would put near-black static
  // on the next host's live face for a second. Each host starts from its
  // own live reading, as the intro latch below does.
  const hostTurn = inRound ? `${inRound.round}|${inRound.hostPosition}` : null
  const hostFeedMissing = useDebouncedFor(hostTurn, hostFeedMissingNow, 1000)
  const isIntro = inRound?.stage === "introduction"
  // NO HOST, NO SPOTLIGHT. A host whose feed is not here as their intro
  // begins is not zoomed to centre stage — their tile is static, there is no
  // gesture to show — so the grid stays put and the no-host pill tells the
  // players to copy each other instead. Decided ONCE, as the intro begins, on
  // the live reading, and kept for the whole intro: a link that lands or drops
  // midway never zooms the tile in late or out early.
  const introKey = isIntro && phase === "live" && inRound ? hostTurn : null
  const [introLatch, setIntroLatch] = useState<{ key: string; noHost: boolean } | null>(null)
  if (introKey !== (introLatch?.key ?? null)) setIntroLatch(introKey ? { key: introKey, noHost: hostFeedMissingNow } : null)
  const noHostIntro = introKey !== null && (introLatch?.key === introKey ? introLatch.noHost : hostFeedMissingNow)

  // THE SPOTLIGHT is gated on the INTRO STAGE (the "intro" pose, which
  // components/game/animations.ts plays as a FLIP). So EVERY intro gets it,
  // the game's first one included, unless the host's feed was missing as it
  // began (NO HOST, NO SPOTLIGHT, above).
  //
  // The grid MOUNTS IN PLACE: there is no parked fly-in, so there is no
  // entry fade. The opening beat is the first host intro.
  //
  // THE GAP between two rounds: the last group slides out (the driver's
  // parked pose — off the nearest edge, fading), and the next group stands in
  // the grid until its first intro.
  const pose: "parked" | "intro" | "natural" =
    roundChange !== null
      ? roundChange.enterAt === null
        ? "parked"
        : "natural"
      : phase === "live" && isIntro && !noHostIntro
        ? "intro"
        : "natural"

  // progress through the CURRENT TURN — one pill fills per turn. The engine
  // owns the turn arithmetic: it already split the round into the own group's
  // turns, so the session divides and never recomputes the slot.
  const turnProgress =
    inRound && inRound.turnDuration > 0 ? inRound.turnElapsed / inRound.turnDuration : 0

  // the host keeps its role light whether or not its feed is here: the tile
  // is colored by role alone
  const variantFor = (id: PlayerId): TileVariant => {
    if (inRound && id === hostId) return "host"
    if (id === youId) return "you"
    return "other"
  }

  // the global turn index — votes live under it and reset when it moves
  const turnKey = inRound ? inRound.round * stride + inRound.hostPosition : -1
  const reportLocked = submitState === "submitting" || submitted
  const confirmProjection: ConfirmProjectionInput = {
    // eslint-disable-next-line react-hooks/refs -- confirm is the synchronous evidence boundary
    books: booksRef.current,
    evidence,
    policy: {
      youId,
      hostId,
      ghost: isGhostId,
      roster: gameRoster,
      confirming,
      clockReady,
      reportLocked,
      openTurn: inRound ? { key: turnKey, stage: inRound.stage } : undefined,
      live: liveView
        ? {
            seats: liveView.seats,
            mySeat: liveView.mySeat,
            stride,
            startedAtFirstTurn: cameThroughWaitingRoom(liveView.timing.gameDate),
          }
        : undefined,
      unseenVerdict: UNSEEN_VERDICT,
    },
  }
  const roleFor = (id: PlayerId): TileRole => projectedRoleFor(confirmProjection, id)
  const seenVideo = (id: PlayerId): boolean => playerProjection(confirmProjection, id).seen
  const neverShared = (id: PlayerId): boolean => playerProjection(confirmProjection, id).neverShared
  const recordVideoArrived = (id: PlayerId): boolean => {
    const boundary = clockReady && inRound ? turnKey : null
    const marked = markVideoRoleSeen(booksRef.current.videoRoleHistory, id, boundary)
    if (!marked.changed) return videoRoleSeen(marked.history, id)
    commitBooks({ ...booksRef.current, videoRoleHistory: marked.history })
    peerSeen(id) // the link's rtc.link rows say seen from here on (#603)
    // the tile presented this co-player's first frame; decoded video alone never reaches here
    devLog("role", "presented first frame", { peer: id, round: inRound ? inRound.round : null, turn: inRound ? inRound.hostPosition : null })
    if (timing && source) {
      recordDistribution(
        "game.unseen_to_coplayer_ms",
        Math.max(0, (source.nowSeconds() - timing.gameDate) * 1000),
        "millisecond",
        {
          round: inRound ? String(inRound.round) : "none",
          turn: inRound ? String(inRound.hostPosition) : "none",
        },
      )
    }
    return true
  }
  // A frame counts toward "seen" only while the co-player sits in an OPEN
  // turn of the viewer's current round: the same snapshot the sealing opens a
  // turn on (any stage of a round, the ending included). A frame in the
  // connect phase, the round change or after the last shared turn proves
  // nothing about a turn the viewer judged, so it is handled like no frame at
  // all (#602, #562). A co-player seen later is bound to
  // the turn the frame arrived in, never back-dated.
  const inSharedOpenTurn = (id: PlayerId): boolean =>
    clockReady && inRound !== undefined && chairs.some((slot) => idIn(inRound.round, slot) === id)
  const videoObservationEpoch = (id: PlayerId): number => {
    // the clock settling opens the gate too, so it re-arms a frame refused cold
    const ready = clockReady ? 1_000_000 : 0
    const entry = evidenceVideoRoleHistory[id]
    // seen: the turn it was bound to, which is the value it had unseen then
    if (entry) return ready + (entry.fromTurn ?? -1) + 1
    if (inRound) return ready + turnKey + 1
    // never moves backwards: the gap after a turn keeps that turn's value
    return ready + (snapshot?.kind === "between-rounds" ? snapshot.nextRound * stride : 0)
  }
  const markVideoArrived = (id: PlayerId): boolean => {
    if (!presentedFrameAdmitted({
      presented: true,
      sharedOpenTurn: inSharedOpenTurn(id),
      inRoster: gameRoster.has(id),
      self: id === youId,
      ghost: isGhostId(id),
      intakeClosed: evidence.intakeClosed,
    }))
      return seenVideo(id)
    return recordVideoArrived(id)
  }
  const noVideo = (id: PlayerId): boolean => playerProjection(confirmProjection, id).noVideo
  /** who a verdict can be about right now: not you, not the host, and never
   *  a chair nobody holds. This gates the gesture, the rotation, the swing,
   *  the ban and the seal. */
  const votable = (id: PlayerId): boolean =>
    projectedVotable(confirmProjection, id) && (confirming || !evidenceFrozen)
  const tappable = (id: PlayerId): boolean => votable(id) && seatTakesTap(seat(id))

  /** what a tile shows: this turn's vote in-round (with the cycle-end
   *  auto-rejection flash), the game-wide majority plus your overrides on the
   *  confirm screen. The report files exactly this value (`confirmVotes`
   *  hands `buildReport` this function), so the color and the vote agree. */
  const voteShown = (id: PlayerId): Vote | undefined => projectedVoteShown(confirmProjection, id)

  const votesMissing = display.filter(
    // eslint-disable-next-line react-hooks/refs -- voteShown reads the confirm projection's books
    (id) => id !== youId && !isGhostId(id) && voteShown(id) === undefined,
  ).length
  useEffect(() => {
    if (!confirming || recapRecordedRef.current) return
    recapRecordedRef.current = true
    const occupied = display.filter((id) => id !== youId && !isGhostId(id))
    const coplayer = occupied.filter((id) => videoRoleSeen(evidenceVideoRoleHistory, id)).length
    recordCount("game.recap_coplayer", coplayer, {})
    recordCount("game.recap_unseen", occupied.length - coplayer, {})
  }, [confirming, display, youId, evidenceVideoRoleHistory])

  // The gesture carries the verdict: the tile turns a tap into the other
  // verdict. So this stores what it is given and never toggles by itself — a
  // second reject on a rejected tile is a no-op, not a flip to approve.
  const voteFor = (id: PlayerId, verdict: Vote, voteSource: "player" | "ban" = "player") => {
    if (phase !== "live" || !projectedVotable(confirmProjection, id)) return
    // the ref closes the gap votable's state leaves: a tap in the same tick as
    // confirmVotes, before the render that shows "submitting"
    if (confirming && reportLockedRef.current) return
    if (confirming) {
      // The last call is a hard input boundary too: after it, neither a
      // restart nor a new override can claim to be included in the report.
      const sourceTimeNow = source ? sourceTime(source) : null
      const millisecondsToLastCall = liveView && sourceTimeNow
        ? liveView.timing.reportEnds * 1000 - sourceTimeNow.nowMs - CONFIRM_REPORT_MARGIN_MS
        : Infinity
      if (millisecondsToLastCall <= 0) return
      const changesChoice = voteShown(id) !== verdict
      // The window keeps running: a no-video choice change is filed with the
      // report when it closes, while the auto-confirm countdown restarts.
      commitEvidence(
        evidenceProjection(evidenceRef.current, {
          kind: "override",
          id,
          verdict,
          changed: changesChoice,
          noVideo: noVideo(id),
        }),
      )
      trail("override", { target: id, verdict })
      if (!changesChoice) return
      const changedAt = performance.now()
      autoRestartRef.current = {
        sequence: autoRestartRef.current.sequence + 1,
        hardStopAt:
          changedAt +
          Math.min(
            AUTO_CONFIRM_SEC * 1000,
            millisecondsToLastCall + (sourceTimeNow?.capSlackMs ?? 0),
          ),
        capSlackMs: sourceTimeNow?.capSlackMs ?? 0,
      }
      outboxRef.current = reportOutbox(outboxRef.current, {
        kind: "verdict-changed",
        clock: {
          monotonicMs: changedAt,
          gameMs: sourceTimeNow?.nowMs ?? changedAt,
          latchMs: awayLatchNowMs(),
          chainAnchored: chainNowMs() !== null,
        },
        capSlackMs: sourceTimeNow?.capSlackMs ?? 0,
      }).state
      const millisecondsToConfirming = Math.min(
        AUTO_CONFIRM_SEC * 1000,
        millisecondsToLastCall + (sourceTimeNow?.capSlackMs ?? 0),
      ) - AUTO_CONFIRM_BEAT_MS
      setAutoCount(Math.ceil(Math.max(0, millisecondsToConfirming) / 1000))
      return
    }
    const voted = voteForRound(
      booksRef.current,
      evidenceFrozen,
      { turn: turnKey, round: inRound?.round ?? -1, id, verdict, source: voteSource },
      turnWorld(),
    )
    if (!voted.accepted) return
    tapsRef.current++
    commitBooks(voted.books)
    replayTrail(voted.trail)
    // ...and tell that player: an accept puts you in their accepter set for
    // this turn, an unaccept takes you back out. A player with no mesh peer
    // behind them has nobody to tell.
    if (inRound && meshPeers.includes(id))
      mesh.sendGesture(id, verdict === "person" ? "Accept" : "Unaccept", inRound.round)
    if (inRound && !isGhostId(id))
      recordTapSent({
        gameIndex: liveView?.gameIndex ?? null,
        self: youId,
        peerId: id,
        tag: verdict === "person" ? "Accept" : "Unaccept",
        round: inRound.round,
        turn: inRound.hostPosition,
        handed: meshPeers.includes(id),
        link: mesh.states.get(id) ?? "none",
        seq: nextSentSeq(tapSentSeqRef.current, id, inRound.round),
      })
  }

  // ── the ban ────────────────────────────────────────────────────────────
  // THE BAN: the eye chip does two things at once. It hides
  // the feed locally, and it casts a reject — this turn and every later turn
  // that player is votable in. Only the undo chip takes it back.
  const isBanned = (id: PlayerId): boolean => bannedKeys.has(id)
  /** who turn `turn` of `round` could judge: everyone who was there to
   *  judge and is neither you nor that turn's host, the seat `hostSeat`
   *  names. A chair nobody holds judges nothing, so it is left out. The
   *  books keep those whose video made them eligible (lib/turn-books). */
  const turnCandidates = (round: number, turn: number): PlayerId[] =>
    chairs
      .filter((seat) => seat !== hostSeat(turn, groupSizeIn(round)))
      .map((seat) => idIn(round, seat))
      .filter((id): id is PlayerId => id !== undefined && id !== youId && !isGhostId(id))
  useEffect(() => {
    rosterRef.current = {
      candidates: turnCandidates,
      host: (round, turn) => {
        const id = idIn(round, hostSeat(turn, groupSizeIn(round)))
        return id === undefined || isGhostId(id) ? "none" : id
      },
      banned: bannedKeys,
    }
  })
  // THE LATE RESTORE'S TOP-UP (#567, lib/turn-books topUpBooks). Declared
  // after the roster above refreshes, so it reads the merged history, bans
  // and votes.
  useEffect(() => {
    const toppedUp = turnBooks(booksRef.current, { kind: "top-up" }, turnWorld())
    if (toppedUp.books === booksRef.current) return
    // once per late host read: the seal needs the merged books' render,
    // which only an effect after the roster refresh sees
    commitBooks(toppedUp.books)
    replayTrail(toppedUp.trail)
  }, [topUpEpoch])

  const ban = (id: PlayerId) => {
    if (phase !== "live" || evidenceFrozen || !votable(id)) return
    commitBooks(turnBooks(booksRef.current, { kind: "ban", id }, turnWorld()).books)
    voteFor(id, "notperson", "ban")
  }
  /** the undo chip. It clears the ban AND takes back the reject the ban cast
   *  this turn — a banned tile takes no gesture, so that reject can only have
   *  come from the ban itself. */
  const unban = (id: PlayerId) => {
    if (evidenceFrozen) return
    const open = inRound ? { turn: turnKey, round: inRound.round, roundTurn: inRound.hostPosition } : undefined
    const unbanned = turnBooks(booksRef.current, { kind: "unban", id, open }, turnWorld())
    commitBooks(unbanned.books)
    replayTrail(unbanned.trail)
  }

  const confirmVotes = () => {
    if (reportLockedRef.current || submitted) return
    clearTimeout(reportRetryTimerRef.current)
    reportRetryTimerRef.current = undefined
    let generation = ++reportGenerationRef.current
    reportLockedRef.current = true
    // a real game with no submit path (no signer, no live view) cannot file a
    // report. Never fake a win: leave the countdown and surface it for a retry.
    if (!liveView || !source?.submitReport) {
      reportLockedRef.current = false
      setAutoCancelled(true)
      setSubmitState("error")
      return
    }
    // the pallet takes a report only before `report_ends`: after that it
    // can only refuse (NoReporting), so send nothing. The handover effect
    // below sends the player on (#303). No `submitted`, no "sent" state:
    // nothing was filed.
    const confirmNowSeconds = source.nowSeconds()
    if (chainClosed || !reportWindowOpen(confirmNowSeconds, liveView.timing.reportEnds)) {
      reportLockedRef.current = false
      trail("window closed", { gameIndex: liveView.gameIndex })
      reportWindowClosedTrace()
      return
    }
    // one verdict per PLAYER, written into every round the chain
    // placed them in — fee-free via the host signer. It mirrors the pallet's
    // `report`: ONE end-of-game call with an entry per round, gated by
    // `report_ends`, so we celebrate only once it resolves. `voteShown` is
    // the same answer the tile draws, so the grid cannot say one thing and
    // the report file another.
    const fullReport = buildReport(liveView.seats, liveView.mySeat, voteShown)
    outboxRef.current = reportOutbox(outboxRef.current, {
      kind: "sync",
      inputs: outboxInputs,
      clock: outboxClock(),
    }).state
    const accepted = reportOutbox(outboxRef.current, {
      kind: "confirm",
      // confirmVotes gates the transaction with source.nowSeconds(), not
      // sourceTime(): that last-second authority stays distinct from the
      // countdown's smoother source clock.
      clock: outboxClock(confirmNowSeconds * 1000),
      report: fullReport,
      filedBy: filedByRef.current,
    })
    const submitCommand = accepted.commands.find((command) => command.kind === "submit")
    if (submitCommand?.kind !== "submit") {
      reportLockedRef.current = false
      return
    }
    outboxRef.current = accepted.state
    generation = submitCommand.generation
    reportGenerationRef.current = generation
    // THE VOTE TRAIL: how each co-player's verdict came to be, before it is filed
    const filedBy = filedByRef.current
    filedByRef.current = "tap"
    const filedVerdict = filedVerdicts(liveView.seats, liveView.mySeat, fullReport)
    const players = Object.fromEntries(
      coPlayers(liveView.seats, liveView.mySeat).map((id) => [
        id,
        // the verdict logged is the one in the report just built (#520)
        summarizeVotes(turnVotes, booksRef.current.autoSeals, id, evidence.finalOverrides[id], UNSEEN_VERDICT, {
          verdict: filedVerdict[id] ?? "notperson",
          seen: seenVideo(id),
          shared: !neverShared(id),
        }, evidence.unseenFlipped.has(id)),
      ]),
    )
    trail("report built", { filedBy, players })
    const summaries = Object.values(players)
    reportBuilt({
      taps: tapsRef.current,
      auto: Object.values(booksRef.current.autoSeals).reduce((sum, ids) => sum + ids.length, 0),
      turns: booksRef.current.turnsSealed,
      ...countReport(summaries),
      unseenChoices: summaries.flatMap((summary) =>
        summary.unseenChoice
          ? [{ choice: summary.unseenChoice, everFlipped: summary.unseenEverFlipped === true }]
          : [],
      ),
      filedBy,
    })
    reportSubmitting()
    setSubmitState("submitting")
    const gameIndex = liveView.gameIndex
    const terminalFailure = (error: unknown, reason: "refused" | "timeout") => {
      if (!mountedRef.current || reportGenerationRef.current !== generation) return
      reportTerminalFailureRef.current ??= { detail: describeError(error), reason }
      // a page gone before the chain confirms the miss sends it on the next open (#600)
      if (source.player) void recordPendingReportFailure({ gameIndex, account: source.player, ...reportTerminalFailureRef.current })
      reportLockedRef.current = true
      setAutoCancelled(true)
      setSubmitState("error")
    }
    const failed = (error: unknown, reason: "refused" | "timeout", attemptStartedAt: number) => {
      if (!mountedRef.current || reportGenerationRef.current !== generation) return
      console.warn("report submission failed:", error)
      if (reportWindowOpen(source.nowSeconds(), liveView.timing.reportEnds)) {
        const rushed = reportRetryRushRef.current
        reportRetryRushRef.current = false
        if (rushed) outboxRef.current = reportOutbox(outboxRef.current, { kind: "host-chain-lost" }).state
        const reduced = reportOutbox(outboxRef.current, {
          kind: "attempt-result",
          generation,
          clock: outboxClock(),
          result: reason === "timeout" ? "closed" : "refused",
          detail: describeError(error),
        })
        outboxRef.current = reduced.state
        const schedule = reduced.commands.find((command) => command.kind === "schedule-retry")
        const reducerDelay = schedule?.kind === "schedule-retry"
          ? schedule.delayMs
          : rushed ? 0 : Math.max(0, REPORT_RETRY_MS - (performance.now() - attemptStartedAt))
        const delay = Math.min(
          reducerDelay,
          Math.max(0, (liveView.timing.reportEnds - source.nowSeconds()) * 1000),
        )
        reportRetryTimerRef.current = setTimeout(() => {
          reportRetryTimerRef.current = undefined
          if (!mountedRef.current || reportGenerationRef.current !== generation) return
          if (!reportWindowOpen(source.nowSeconds(), liveView.timing.reportEnds)) {
            terminalFailure(error, reason)
            return
          }
          const attempt = ++reportRetryCountRef.current
          const retried = reportOutbox(outboxRef.current, { kind: "retry-fired", generation, clock: outboxClock() })
          outboxRef.current = retried.state
          trail("report retry", { gameIndex, attempt })
          recordCount("report.retries", 1, { "report.retry_attempt": String(attempt) })
          reportLockedRef.current = true
          setSubmitState("submitting")
          void submit()
        }, delay)
      } else terminalFailure(error, reason)
    }
    const submit = async () => {
      const attemptStartedAt = performance.now()
      outboxRef.current = reportOutbox(outboxRef.current, {
        kind: "attempt-started",
        generation,
        monotonicMs: attemptStartedAt,
      }).state
      try {
        const result = await submitReportAttempt(
          {
            nowSeconds: source.nowSeconds,
            reportStatus: source.reportStatus,
            submitReport: source.submitReport!,
          },
          fullReport,
          gameIndex,
          liveView.timing.reportEnds,
        )
        if (!mountedRef.current || reportGenerationRef.current !== generation) {
          if (result === "sent") void markSeen(gameIndex, "report")
          return
        }
        if (result === "sent") {
          outboxRef.current = reportOutbox(outboxRef.current, {
            kind: "attempt-result", generation, clock: outboxClock(), result: "sent",
          }).state
          // A signed report is stronger host-answering evidence than another
          // synthetic probe. Clear stale in-game restart advice before leaving
          // the game route, even if the last scheduled probe was inside a cut.
          if (hostStuckRef.current) await noteHostHealthy("recheck")
          finishReport(gameIndex)
        }
        else if (typeof result === "object" && result.kind === "chain-closed") {
          outboxRef.current = reportOutbox(outboxRef.current, {
            kind: "attempt-result", generation, clock: outboxClock(), result: "chain-closed",
          }).state
          // no retry can land now: stop, and let the handover read where to go
          trail("report chain closed", { gameIndex, at: result.at })
          setChainClosed(true)
          terminalFailure(new Error("the chain closed the report window before the report landed"), "refused")
        } else failed(
          new Error("the report window closed before the report landed"),
          "timeout",
          attemptStartedAt,
        )
      } catch (error) {
        if (!mountedRef.current || reportGenerationRef.current !== generation) return
        trail("report attempt failed", { gameIndex, detail: describeError(error) })
        failed(error, "refused", attemptStartedAt)
      }
    }
    void submit()
  }

  // the auto-confirm engine: arm on entering a fully-voted confirm stage
  // only inside the report window, (#201) never after a background.
  // The window is read at render from the game clock: PRESENTATIONAL (it
  // flips on the next tick); `confirmVotes` re-reads it at call time and is
  // the authority.
  const windowOpen = !liveView || reportWindowOpen(clock(), liveView.timing.reportEnds)
  const reportWindowClosed = confirming && (!windowOpen || chainClosed)
  // THE WINDOW HAS CLOSED, so the chain says where the player goes (#303): a
  // report it holds opens the draw (a submit that failed here but landed is
  // not a miss), none at all is a MISSED report — no retry, no draw, the collectables screen
  // starts on "preparing your collectables" and says why. "Missed" is read off
  // the chain (`reportSent`) at the source's clock, never off the local error.
  // It needs no tap: a player who never touches the CTA must not sit on /game
  // for good. A submit still in flight settles first (it times out at the
  // window's end). A read that fails, or a chain still in Reporting (the page
  // clock trails block time, and a report in the last block may still be on
  // its way, #597), is tried again with a growing pause.
  // The chain is read through reportStatus, not gameView(): the pallet leaves
  // Reporting at report_ends (or earlier, once every attendance is decided)
  // and gameView() then reads null for good (#596). A status the chain no
  // longer holds ("gone": processed, not attended) still leaves /game, for the
  // collectables screen, which reads attendance itself, and claims no failure.
  const handOverClosed = reportWindowClosed && submitState !== "submitting" && !submitted
  const gameIndex = liveView?.gameIndex
  useEffect(() => {
    if (!handOverClosed || gameIndex === undefined || !source) return
    outboxRef.current = reportOutbox(outboxRef.current, { kind: "handover-started" }).state
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pause = LIVE_POLL_MS
    const attempt = async () => {
      const status = await source.reportStatus(gameIndex).catch(() => null)
      if (cancelled) return
      if (status?.report === "sent") {
        outboxRef.current = reportOutbox(outboxRef.current, { kind: "handover-result", result: "sent" }).state
        return finishReport(gameIndex)
      }
      if (status && reportMissed(status)) {
        const failure = reportTerminalFailureRef.current
        if (failure && !reportFailureRecordedRef.current) {
          reportFailureRecordedRef.current = true
          // sent here only once the record is confirmed gone, so the next open cannot send it again
          if (await clearPendingReportFailure(gameIndex, source.player)) reportFailed(failure.detail, failure.reason)
          if (cancelled) return
        }
        trail("report missed", { gameIndex })
        outboxRef.current = reportOutbox(outboxRef.current, { kind: "handover-result", result: "missed" }).state
        router.replace(`/collectables?game=${gameIndex}`)
        return
      }
      if (status?.closed && status.report === "gone") {
        trail("report unknown after the game", { gameIndex })
        outboxRef.current = reportOutbox(outboxRef.current, { kind: "handover-result", result: "gone" }).state
        router.replace(`/collectables?game=${gameIndex}`)
        return
      }
      const reduced = reportOutbox(outboxRef.current, { kind: "handover-result", result: "pending" })
      outboxRef.current = reduced.state
      const poll = reduced.commands.find((command) => command.kind === "poll-handover")
      const delay = poll?.kind === "poll-handover" ? poll.delayMs : pause
      timer = setTimeout(() => void attempt(), delay)
      pause = Math.min(delay * 2, 10_000)
    }
    void attempt()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  // finishReport only calls state setters and the router: stable for this effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handOverClosed, gameIndex, source, router])
  const autoActive =
    confirming && confirmReady && windowOpen && votesMissing === 0 && !autoCancelled && !awayDuringGame && !awayPending
  const outboxInputs: OutboxInputs = {
    gameIndex,
    reportEndsMs: liveView ? liveView.timing.reportEnds * 1000 : undefined,
    confirming,
    confirmReady,
    votesMissing,
    hasSubmitPath: Boolean(liveView && source?.submitReport),
  }
  const outboxClock = (gameMs = source ? sourceTime(source).nowMs : clock() * 1000): OutboxClock => ({
    monotonicMs: performance.now(),
    gameMs,
    latchMs: awayLatchNowMs(),
    chainAnchored: chainNowMs() !== null,
  })
  /** the CTA's own tap. It pulls the deadline to now, so the count collapses
   *  and the SAME beat fires the report — the tap never submits by itself. */
  const rushConfirm = () => {
    if (autoActive) {
      autoRushRef.current = true
      outboxRef.current = reportOutbox(outboxRef.current, { kind: "rush-confirm", clock: outboxClock() }).state
    }
  }
  // the engine fires the LATEST confirm: the window outlives the render that
  // armed it, and a verdict changed inside it must be in the report it files
  const confirmRef = useRef(confirmVotes)
  useEffect(() => {
    confirmRef.current = confirmVotes
  })
  useEffect(
    () => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
        reportGenerationRef.current += 1
        clearTimeout(reportRetryTimerRef.current)
      }
    },
    [],
  )
  // the chain's `report_ends` (chain seconds): stable, so it re-arms nothing
  const reportEnds = liveView ? liveView.timing.reportEnds : null
  useEffect(() => {
    if (!autoActive) return
    outboxRef.current = reportOutbox(outboxRef.current, {
      kind: "countdown-started",
      inputs: outboxInputs,
      clock: outboxClock(),
    }).state
    if (autoRushRef.current)
      outboxRef.current = reportOutbox(outboxRef.current, { kind: "rush-confirm", clock: outboxClock() }).state
    autoRushRef.current = false
    const timer = setInterval(() => {
      const reduced = reportOutbox(outboxRef.current, { kind: "tick", clock: outboxClock() })
      outboxRef.current = reduced.state
      if (reduced.commands.some((command) => command.kind === "rush-consumed")) autoRushRef.current = false
      setAutoCount(reduced.state.autoCount)
      const fire = reduced.commands.find((command) => command.kind === "confirm")
      if (fire?.kind === "confirm") {
        clearInterval(timer)
        filedByRef.current = fire.filedBy
        confirmRef.current()
      }
    }, 100)
    return () => {
      clearInterval(timer)
      setAutoCount(AUTO_CONFIRM_SEC)
    }
  // The reducer ref receives verdict/rush events synchronously; adding the
  // freshly-created input/clock adapters would restart this one countdown on
  // every render and change its timing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoActive, reportEnds, source])

  // kickoff on the DEVICE clock: the live view's gameDate once resolved, else
  // the seeded handover value, so the countdown is right from the first frame
  const gameAt =
    liveView ? liveView.timing.gameDate - clockOffset : seededGameDate !== null ? seededGameDate - clockOffset : undefined
  // the kickoff on the game clock, the one clock of the dial and the switches below
  const gameDate = liveView ? liveView.timing.gameDate : (seededGameDate ?? undefined)
  // final-waiting until the last TILES_ENTER_SECONDS, then tiles-enter,
  // then the game — the mesh is forming across all of it. "game" the moment
  // the game clock leaves the waiting room (a round, the report window, the
  // finish), so a finished game shows the confirm screen, never the dial.
  const toStart = gameDate !== undefined ? gameDate - sessionNowMs() / 1000 : undefined
  const screen: SessionScreen = freshCold
      ? coldAfterKickoff
        ? "joining"
        : "final-waiting"
    : phase === "live" || (toStart !== undefined && toStart <= 0)
      ? "game"
      : toStart !== undefined && toStart <= TILES_ENTER_SECONDS
        ? "tiles-enter"
        : "final-waiting"
  // the screen changes ON the second: a timer wakes the render at each
  // boundary, so the change does not wait for the next tick
  const [boundary, setBoundary] = useState(0)
  useEffect(() => {
    if (gameDate === undefined) return
    const left = gameDate - sessionNowMs() / 1000
    if (left <= 0) return
    const next = left > TILES_ENTER_SECONDS ? left - TILES_ENTER_SECONDS : left
    const timer = setTimeout(() => setBoundary((n) => n + 1), next * 1000)
    return () => clearTimeout(timer)
  }, [gameDate, boundary])
  // the next group comes in ON its second too, not on the next tick
  useEffect(() => {
    if (!lastGroupLeaving || enterAt === null) return
    const timer = setTimeout(() => setBoundary((n) => n + 1), (enterAt - nowSeconds()) * 1000)
    return () => clearTimeout(timer)
  }, [lastGroupLeaving, enterAt])

  // the co-players of each round still to play, from the mesh round on
  const roundsLeft =
    liveView && meshRound !== null
      ? Array.from({ length: Math.max(0, liveView.seats.length - meshRound) }, (_, index) => accountPeersOf(meshRound + index))
      : []

  const view: GameSessionView = {
    phase,
    screen,
    joining: joining
      ? { round: joining.round + 1, elapsed: Math.floor(joining.elapsed), duration: joining.duration }
      : undefined,
    gameAt,
    gameDate,
    secondsToStart: toStart !== undefined && toStart > 0 ? Math.ceil(toStart) : undefined,
    presentCount: mesh.present.size,
    connection: connectionStatus({
      probe: path.probe,
      checking: path.checking,
      links: mesh.links,
      rounds: roundsLeft,
    }),
    waitingPeers: waitingPeers({ rounds: roundsLeft, links: mesh.links }),
    seats: members.length,
    players,
    ghost: isGhostId,
    store: mesh.stats(),
    display,
    pose,
    hostId,
    youId,
    confirming,
    hostStuck,
    hostStuckReason: hostHealth.reason,
    hostReconnectingSince: hostHealth.reconnectingSince,
    hostAnswering: hostHealth.answering === true,
    isolated,
    playerNetworkIsolated,
    noUsablePath: mesh.noUsablePath,
    hostStuckConsecutiveOpens,
    variantFor,
    roleFor,
    videoSeen: seenVideo,
    noVideo,
    markVideoArrived,
    videoObservationEpoch,
    evidenceGeneration,
    evidenceFrozen,
    votable,
    tappable,
    voteShown,
    voteFor,
    banned: isBanned,
    ban,
    unban,
    acceptedYou,
    votesMissing,
    confirmVotes,
    submitState,
    autoActive,
    // eslint-disable-next-line react-hooks/refs -- derived from the confirm gate latch above
    votesLoading,
    reportWindowClosed,
    autoCount,
    autoConfirmSeconds: AUTO_CONFIRM_SEC,
    rushConfirm,
    turn: inRound
      ? {
          turnsPerRound: turnsEachRound,
          round: inRound.round,
          turn: inRound.hostPosition,
          progress: turnProgress,
          turnSec: inRound.turnDuration,
        }
      : snapshot?.kind === "between-rounds"
        ? {
            turnsPerRound: turnsEachRound,
            round: snapshot.nextRound - 1,
            turn: Math.max(0, (turnsEachRound[snapshot.nextRound - 1] ?? 1) - 1),
            progress: 1,
            turnSec: 0,
          }
        : null,
    stage: inRound?.stage ?? null,
    stageDuration: inRound?.stageDuration ?? 0,
    stageRemaining: inRound?.stageRemaining ?? 0,
    roundChange,
    peerSignal,
    peerAway,
    seat,
    yourSignal,
    troubled,
    // the intro that skipped the spotlight says so at once, not a second later
    hostFeedMissing: hostFeedMissing || noHostIntro,
    mesh,
    camera,
  }

  return view
}
