// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The game source — the app's ONLY doorway to chain state.
 *
 * Jollity is a host-environment app: outside a Polkadot host container it
 * refuses to run (getGameSource resolves null → the page shows the host-only
 * gate). Identity and signing go through `@parity/product-sdk-host` ONLY —
 * the host-derived product account and its signer; the app never holds keys.
 *
 * The pallet itself is read through a `GameEngine` (@jollity/protocol), built
 * in lib/engine.ts over the chain. This file reads views from it and never
 * holds a papi client.
 *
 * Dev override (explicit, env-driven — never the default):
 *  - `NEXT_PUBLIC_PEOPLE_WS` → READ-ONLY chain view over a WS endpoint
 *    (a local dev node or a test network, from a plain browser). No signer,
 *    no register — watching states only.
 *  - the same variable INSIDE a host that serves no chain (the `truapi-host`
 *    CLI, `npm run dev:host`) → chain reads over the WS endpoint, identity,
 *    signing and statements still the host's. The full loop on one machine.
 *
 * Status semantics (`deriveStatus`):
 *  - a game QUEUED behind the current one is "scheduled"; its sign-up is
 *    estimated to open at `game_date − (registration + shuffle +
 *    post_shuffle_margin)`, read from the CHAIN's phase durations
 *  - once the game exists, registration is open until the pallet's
 *    `registration_ends`, then the game is "starting"
 *  - a REGISTERED player may enter the waiting room from `JOIN_WINDOW_S`
 *    (300 s, T−5:00) before game time
 *  - from `game_date` the game is "live" until the end of its last turn
 */
import { AccountId } from "polkadot-api"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import type { ProductAccount, TruApi } from "@parity/product-sdk-host"
// Every Game pallet read and write goes through the GameEngine. The chest is the
// exception: lib/scarcity.ts reads the People + Asset Hub pair lib/engine.ts builds.
import { groupSeats } from "@parity/product-sdk-individuality"
import type { GameTimingInfo } from "@jollity/game-chain"
// a VALUE from the pure subpath (architecture rule 2): the barrel would pull
// the chain client into every screen that reads the status
import { gameDuration, TILES_ENTER_SECONDS } from "@jollity/game-chain/game"
import {
  network,
  productAccount,
  signupAccountIndex,
  statePlayerCount,
  type GameEngine,
  type PalletGame,
  type PalletPhaseDurations,
  type PalletPlayerRef,
  type ReportVote,
  type Unsubscribe,
} from "@jollity/protocol"
import { registrationRetryDelay, type GameRegistrationCapabilities, type Seat } from "@parity/product-sdk-individuality"
import { claimWithRetry } from "@individuality/prize"
import type { RegistrationPhase } from "@individuality/shared-records"
import { statementTransport, type CreateTransport, type ResolveStore } from "@jollity/statement-core"
import { resolveDevEngine, resolveHostEngine, resolveScarcityChain, withExtrinsicLogging } from "./engine"
import { readChestPinned, type ChestItem, type ChestView } from "./scarcity"
import type { DrawPhase, PrizeDrawView } from "./draw/prize-draw"
import { rememberDrawMiss } from "./draw/draw-miss"
import {
  attendanceInGame,
  attendanceWatch,
  readBeforeSettle,
  readUntilSettle,
  settleWait,
  type AttendanceRow,
  type AttendanceView,
  type GameSlot,
} from "@individuality/game-outcome"
import { playerStatementStore, signerOfPlayer } from "./host/statement-store"
import { isHostChannelInterruption, retrySafeHostRead, safeHostReadWhenConnected, type HostConnectionSource } from "./host/safe-call"
import { signalSubmit, statementsFirstPage, statementsInterrupted, statementsResubscribed, statementsSubscribed } from "./journeys/game-trace"
import { signUpCapabilities } from "./host/sign-up"
import { describeError } from "./host/error-detail"
import { knownDisplayName } from "./host/identity"
import { holdGameReminder, reminderForSignup } from "./host/game-reminder"
import { communicationIdentifier } from "./host/communication-key"
import { ownKeySecret } from "./own-key"
import { readGameRegistration, recordSignUp } from "./host/game-registration"
import { sweepClaimedPrizes } from "./prize-sweep"
import { devLog } from "./debug/log-store"
import { warnThrottled } from "./debug/warn-throttled"
import { readChainGapMs, setChainBlock, setChainGapMs, setChainNow, setChainOffset } from "./chain-clock"
import { storeClock, storeClockBase } from "./store-clock"
import { storeCalibrator, type Calibrate } from "./store-calibration"
import { deviceNowMs, sharedDeviceClock, type DeviceClock } from "./device-clock"
import { setClockSnapshot } from "./debug/clock"
import {
  advance,
  betterSample,
  confirmPeerMedian,
  createClockSync,
  median,
  PEER_CHECK_MS,
  peerVerdict,
  setTarget,
  type ClockEvent,
  type PeerCandidate,
  type PeerSample,
} from "./clock-sync"
import type { MeshClock } from "./webrtc/clock-frame"
import { setTelemetryAddress } from "./debug/telemetry"
import { chainHealthRecord, hostRetryRecord, recordCount, recordDistribution, reminderAskRecord, reportFailure, setGameIndex, setPlayer, signupBroadcast, startJourney, type HostRetryReason, type Journey, type Step } from "./telemetry"
import { reduceHostStuckEvidence, resetHostStuckEvidenceOnReturn, runChainHealthProbe, signupHostChainVerdict, type ChainHealthResult, type ChainHealthWhere } from "./chain-health"
import { retryBlockNotPinned, retryMetric } from "./chain-retry"
import { noteChainLostStreak } from "./chain-lost-streak"
import { captureReplayClock, createReplayClockAnchorCapture, replayClockReceipt } from "./telemetry/replay-clock"

/** what the caller knows that the probe's telemetry should carry */
interface ChainHealthContext {
  /** the player holds a seat in the upcoming game */
  registered?: boolean
}
import { maskSafe } from "./journeys/mask-text"
import {
  createSignUpFlow,
  joinAtMs,
  readSequence,
  type DrawSkipKind,
  type Funds,
  type RegistrationWindow,
  type ReminderBlock,
  type SignUpJourney,
  type SignupPhase,
} from "@individuality/sign-up"
import { createNameGate } from "@individuality/name-link"
import { withTimeout } from "./with-timeout"
import type { NameLinkResult, NameLinkTrigger } from "./draw/name-link"
import { isSigningDeclined } from "./permissions"
import { ClaimError, claimClosedReason } from "./draw/prize-claim"
import { READ_ATTEMPT_MS, ReadTimeoutError, readAbortReason, retryRead } from "./read-retry"
import { appOpenStep, noteAppOpenHost } from "./journeys/app-open"
import { noteHostChannelLost, noteHostChannelRestored } from "./telemetry/session-record"
import { requestSelfReload } from "./self-reload"
import { homeGameRead, homeReadFailed, homeReadTimedOut, homeScheduleRead, homeWatchFired } from "./journeys/home-first-status"
import { readHostInfoResult } from "./host/host-info"
import { gameSettledFor, signupDraws } from "./journeys/game-trace"
import { pageHidden, watchPageActivity } from "./page-lifecycle"
import { lastBackgroundReturnAtMs } from "./background-return"
import { reportStatusOf, type ReportStatus } from "./report-missed"
import { ReportWindowClosedError } from "./report-retry"
import { retryIceServersAfterHostReconnect, retryIceServersOnForegroundReturn } from "./webrtc/ice"

export type SourceKind = "host" | "ws"

/** The DotNS name this build is deployed under, as a LOG LABEL only: the
 *  sign-up route line and the container line carry it, so a log says which
 *  deployment it came from. The account the host signs with is
 *  `PRODUCT_ACCOUNT`, never this. Same default as lib/debug/flag.ts. */
const PRODUCT_DOTNS = process.env.NEXT_PUBLIC_PRODUCT_DOTNS ?? "dim2.testnet"

/** Whose account plays. */
const PRODUCT_ACCOUNT = productAccount()

const SIGNUP_ACCOUNT_INDEX = signupAccountIndex()

type PhaseDurations = PalletPhaseDurations

// fallback phase durations, used only when the chain read fails
const FALLBACK_PHASES: PhaseDurations = { registration: 300, shuffle: 60, post_shuffle_margin: 30 }

/** What the root page needs to know, derived from Game.Game + GameSchedules. */
export type GameStatus =
  | { kind: "loading" }
  | {
      kind: "none"
      /** the slot game's `game_date` while it is in its report window past its last turn */
      reportingGameAt?: number
    }
  /** a game is QUEUED behind the current one (`GameSchedules`, no `Game` yet):
   *  the chain holds one game at a time, so this one opens for sign-up only
   *  once it becomes the game. `registrationAt` is our estimate of that. */
  | {
      kind: "scheduled"
      gameAt: number
      registrationAt: number
      withinHour: boolean
      /** the slot game's `game_date` while it is in its report window past its last turn */
      reportingGameAt?: number
    }
  /** the game exists and the pallet accepts sign-ups — from the scheduling
   *  block until `registration_ends`. `offerRegister` = not registered yet. */
  | {
      kind: "registration"
      gameAt: number
      closesAt: number
      registered: boolean
      withinHour: boolean
      offerRegister: boolean
      /** how THIS player gets a seat, as packages/individuality-sign-up/src/seat.ts decides, and whether
       *  it is ready to press; absent until the chain has been read, and in
       *  read-only mode */
      seat?: Seat
      /** what the deposit route costs and what the account holds — with the
       *  seat, for the "deposit" and "unfunded" paths */
      funds?: Funds
      /** the sign-up the source is filing for this player, from the tap until
       *  it lands: what the Register button shows. Absent reads as "idle". */
      signup?: SignupPhase
    }
  /** registration closed; waiting room not open yet */
  | { kind: "starting"; gameAt: number; registered: boolean; withinHour: boolean }
  /** registered and within the join window — the waiting room is open. Its
   *  countdown runs to KICKOFF, and the handover fires at `handoverAt`
   *  (lib/joined.ts, T−1:04). */
  | { kind: "waiting"; gameAt: number }
  /** the game is on until `playEndsAt`, the end of its last turn. After that
   *  the home shows the queue, though on-chain Reporting runs to `endsAt`. A
   *  registered player may join at any turn until `playEndsAt` (lib/late-join, #699). */
  | {
      kind: "live"
      gameAt: number
      endsAt: number
      playEndsAt: number
      registered: boolean
      gameIndex: number
      rounds: number
      maxGroupSize: number
    }
  /** results are being processed / the game is being torn down */
  | { kind: "processing" }

/**
 * WHO A PLAYER IS, for the whole app. The chain reshuffles indices every
 * round, so a seat number names a chair, never a person — this string is the
 * only key the game may put a photo, a vote or a ban under.
 *
 * An `Account` player is their SS58 address, which is also their mesh peer id,
 * so `mesh.streams.get(id)` needs no translation. A `Person` player has an
 * alias instead of an address, and gets `person:` + the alias hex.
 */
export type PlayerId = string

export interface ChainClockState {
  /** the clock can time a turn. Always true for the shipped source, whose
   *  clock starts on the device clock; only test sources model a clock that
   *  is not ready yet */
  ready: boolean
  /** the game second at which this page's clock became ready, only inside the game */
  coldStartedAt?: number
}

/** The one place a chain player reference becomes a `PlayerId`. */
export function playerIdOf(ref: PalletPlayerRef): PlayerId {
  if (ref.type === "Account") return ref.value
  // papi decodes the 32-byte alias as a `0x…` hex string
  if (typeof ref.value !== "string")
    throw new Error("Game.IndexToPlayer: Person alias is not a hex string")
  return `person:${ref.value}`
}

/**
 * ONE SEAT of your group in one round. The group always has `maxGroupSize`
 * of them, because that is how many turns the round plays. A seat the shuffle
 * never reached holds nobody, and its turn goes to a player instead: the
 * turns wrap around the held seats (game-chain `hostSeat`).
 */
export interface LiveSeat {
  /** the player index this chair maps to */
  index: number
  /** the player who holds it, or null for a seat nobody holds */
  player: PalletPlayerRef | null
}

/** Everything the game screen needs about the LIVE on-chain game. */
export interface LiveGameView {
  gameIndex: number
  timing: GameTimingInfo
  /** your seat position per round */
  mySeat: number[]
  /** your group per round: exactly `timing.maxGroupSize` seats, in seat order */
  seats: LiveSeat[][]
  /** your report already counted on the chain (the pallet's `sent_report`).
   *  A session that finds it set has nothing to file: it goes on to the draw.
   *  Undefined when the row read failed: "not known", never "not sent" (#597).
   *  A miss is decided off `reportStatus`, never off this flag. */
  reportSent: boolean | undefined
}

/** what a chest read before the settle needs of the votes on the player */
interface ChestVotes {
  /** the votes in so far fail the player, whatever comes */
  failed: boolean
  votesToCome: number
  reported: boolean
  /** the verdict the settle applies if reporting closes on the votes in now */
  atClose: boolean
  recognised: boolean
}

export interface GameSource {
  /**
   * NO `client` HERE, DELIBERATELY. A papi `PeopleClient` on this interface
   * would put a chain type on the doorway's public surface and let any
   * consumer reach past it into the chain. Views are the contract; the client
   * stays inside.
   */
  kind: SourceKind
  /** the local player's address, when the source has an identity */
  player?: string
  /** the SAME account as its raw 32 bytes. The mesh's gesture body carries an
   *  account id, never an address, and decoding the SS58 form outside this
   *  module would put polkadot-api in the game screen's bundle. */
  playerAccountId?: Uint8Array
  /**
   * Register the player for the current game, signed BY THE HOST (the
   * product-sdk product-account signer). Absent in read-only ws mode.
   * Resolves when the sign-up landed; `registered` then flips via watchPlayer.
   */
  register?: () => Promise<void>
  /** stop a sign-up that is still retrying (the page left). One already on
   *  the wire stands. */
  cancelRegister?: () => void
  /**
   * The source's idea of "now" (Unix seconds): the step-free device clock,
   * corrected by the peers. Every time-gated derivation and countdown must
   * use THIS.
   */
  nowSeconds: () => number
  /** The sum, in ms, of the game-clock jumps that no forward device step explains. It never falls. */
  unexplainedJumpMs?: () => number
  /** The session files no turn before the clock is ready. The shipped source
   * is ready at once (`ready` is always true); absent on test sources, which
   * are ready by definition. */
  clockState?: () => ChainClockState
  /** the clock's side of the peer check on the mesh data channel */
  meshClock?: MeshClock
  /** subscribe to derived status; returns unsubscribe */
  watchStatus: (cb: (status: GameStatus) => void) => () => void
  /**
   * The live game as the GAME PALLET sees it — timing, your per-round seat,
   * and your per-round group. Null when there is no started game, no
   * identity, or you are not in the shuffle.
   */
  gameView: () => Promise<LiveGameView | null>
  /**
   * Authoritative prize-draw schedule for the current `Game.Game`. The waiting
   * room reads this early and retries failures. Null means the expected game
   * is not currently readable; it is never evidence that no draw exists.
   */
  drawSchedule: (expectedGameAt?: number) => Promise<{
    gameIndex: number
    gameAt: number
    scheduled: number
  } | null>
  /**
   * The player's report in game `gameIndex` (default: the game the chain
   * holds), in EVERY phase: gameView() is null once the game leaves
   * Reporting, which it can do before report_ends. Game, row and attendance
   * come from one best block. A failed read is `report: "unknown"`, never a
   * miss (lib/report-missed.ts).
   */
  reportStatus: (gameIndex?: number) => Promise<ReportStatus>
  /** WebRTC signalling over the statement store — host mode only */
  signalling?: CreateTransport
  /** learn the store clock's margin before the game (lib/store-calibration.ts):
   *  the waiting room calls it once signed up, the session before the mesh
   *  opens. Host mode with a player only. */
  calibrateSignalling?: Calibrate
  /** submit the vote report, host-signed + fee-free (ScoreAsParticipant).
   *  Resolves once the report counted, including when it had counted already
   *  (`ReportAlreadySent`). `signal` aborts the wait; the transaction may
   *  still land, so the caller re-reads `reportStatus()` before a retry.
   *  Rejects with `ReportWindowClosedError` when the pallet says NoReporting. */
  submitReport?: (fullReport: ReportVote[][], signal?: AbortSignal) => Promise<void>
  /** Build, but never submit, a harmless transaction through the report's
   *  host signer path. Absent for read-only sources. */
  probeChainHealth?: (where: ChainHealthWhere, context?: ChainHealthContext) => Promise<ChainHealthResult>
  /** claim a won prize draw of `gameIndex`, paid to the playing account —
   *  host-signed and fee-free (ScoreAsParticipant). Rejects with the
   *  pallet's error name when the chain refuses it. */
  claimPrize?: (gameIndex: number, airdropIndex: number) => Promise<void>
  /**
   * What the chest shows: the claims of the player for one game (default: their
   * last attended), resolved to collectables with loadable artwork. Null when
   * there is no player identity to read for. A game still in reporting answers
   * with the claims that have arrived, `settling`; `afterSettle` waits for the
   * settle and its credits instead.
   */
  chestView: (options?: {
    player?: string
    gameIndex?: number
    signal?: AbortSignal
    afterSettle?: boolean
    /** keep reading while votes are out, for the read that follows a `voting` answer */
    holdWhileVoting?: boolean
  }) => Promise<ChestView | null>
  /**
   * The claims that come into a chest opened before its game settled, as they
   * come: read again whenever the player's row moves (a vote for them landed)
   * until the game settles, and each claim not in `shown` handed to `onItems`
   * once. Resolves once the game has settled; rejects on `signal`.
   */
  watchChest?: (options: {
    player?: string
    gameIndex: number
    shown: readonly string[]
    onItems: (items: ChestItem[]) => void
    signal: AbortSignal
  }) => Promise<void>
  /**
   * The PRIZE DRAW of one game — pallet `airdrop`, read through game-chain's
   * `fetchAirdropDraws`. Mapped into the shape the prize-draw wheel consumes
   * (lib/draw/prize-draw.ts), so the ceremony renders real chain data:
   * our ticket, the winning tickets, the prize, and whether we won.
   *
   * Null when there is no identity to read for. An empty array means the game
   * scheduled no draws (or they are finalized and swept from storage).
   */
  prizeDrawView: (options?: {
    player?: string
    gameIndex?: number
  }) => Promise<PrizeDrawView[] | null>
  /** game `gameIndex` is over on chain: the chain has moved past it. Rejects
   *  when it has not settled within the doorway's settle deadline, or on
   *  `signal`. */
  gameSettled: (gameIndex: number, signal?: AbortSignal) => Promise<void>
  /**
   * The player's verdict in game `gameIndex` while the chain still holds it,
   * on every change: decided early, or which way the votes in so far lean
   * (#1096). Null once the row holds no verdict for that game (another game,
   * or PlayerProcess has reset or archived it).
   * Absent with no player identity.
   */
  watchAttendance?: (gameIndex: number, cb: (view: AttendanceView | null) => void) => Unsubscribe
  /** game `gameIndex` holds the player's attendance on chain: applied early
   *  (#1096) or at the settle, so `Score.Participants` already carries it, and
   *  with it the gates of a prize claim. Rejects as `gameSettled` does.
   *  Absent with no player identity. */
  attendanceApplied?: (gameIndex: number) => Promise<void>
}

/**
 * The pallet's lifecycle → the three states the ceremony branches on.
 * Anything before the winners exist is "waiting"; once they do the ceremony
 * can land on a real result; once it is swept there is nothing to show.
 */
function drawPhase(status: string): DrawPhase {
  if (status === "gone" || status === "Finalizing") return "over"
  if (status === "Claiming" || status.startsWith("Clearing")) return "drawn"
  return "waiting"
}

export type { ChestChoice, ChestItem, ChestView } from "./scarcity"

/** How early a registered player may enter the waiting room (T−5:00). A
 *  product choice, not a chain rule; the camera warm-up starts later
 *  (lib/camera-help.ts). */
const JOIN_WINDOW_S = 300
/** the band of the status's `withinHour` flag: the game is at most this far
 *  out. It gates nothing in this file */
const REGISTER_BAND_S = 3600

function registrationOffset(phases: PhaseDurations): number {
  return phases.registration + phases.shuffle + phases.post_shuffle_margin
}

/** A chain value `watchStatus` has not had an answer for yet. NOT READ IS NOT
 *  EMPTY (#289): an empty game slot and an empty schedule queue are both
 *  `undefined`, and a home that took "not read yet" for that said "No game
 *  scheduled" while a game was open, for about 2 s on every load. */
export const NOT_READ: unique symbol = Symbol("not read")
export type Read<T> = T | typeof NOT_READ

/**
 * Whether the status can be derived yet: the known inputs, or null for
 * "loading". The game slot must have been answered (by the watch or the read).
 * A slot that shows the queue (`showsQueue`) also needs the queue's answer,
 * since that decides "none" against "scheduled". Any other game does not need
 * the queue, but it needs the player's registration: every status about it
 * says whether the player is in it, and a "not read" taken for "no" showed a
 * registered player "You missed this one" before the read landed (#1108).
 */
export function statusGate(
  game: Read<PalletGame | undefined>,
  nextScheduleAt: Read<number | undefined>,
  registered: Read<boolean>,
  now: number,
): { game: PalletGame | undefined; nextScheduleAt: number | undefined; registered: boolean } | null {
  if (game === NOT_READ) return null
  const queue = showsQueue(game, now)
  if (queue && nextScheduleAt === NOT_READ) return null
  if (!queue && registered === NOT_READ) return null
  return {
    game,
    nextScheduleAt: nextScheduleAt === NOT_READ ? undefined : nextScheduleAt,
    registered: registered === true,
  }
}

/**
 * What the home keeps showing while `statusGate` waits. An answer about no
 * game stands: a game appearing over "none" or "scheduled" keeps that screen
 * until the player's own read lands, as a new Registration waits for finality
 * (#489). Anything about a game goes back to loading, since it may name the
 * wrong game or the wrong player state. So does a hold whose read failed or
 * timed out: "No game scheduled" with a game on chain is false, and loading
 * is what the launch stall turns into the restart card (#530).
 */
export function heldStatus(last: GameStatus, readFailed: boolean): GameStatus {
  if (readFailed) return { kind: "loading" }
  return last.kind === "none" || last.kind === "scheduled" ? last : { kind: "loading" }
}

/**
 * Whether a game READ may land, beside the watch. The read is at finalized, a
 * block or two behind the watch's best, so it never overrides the watch: it
 * lands only if the watch said nothing since the read began (`fresh`), and a
 * game only if it is newer than any already `seen` (a finalized read must not
 * bring back a game the watch has seen end). An empty answer that is fresh
 * lands: the slot reads empty, which is an answer too.
 */
export function acceptFallbackGame(value: PalletGame | undefined, fresh: boolean, seen: number | undefined): boolean {
  if (!fresh) return false
  return value === undefined || seen === undefined || value.index > seen
}

/** how long one game read may take before it counts as no answer. A hung RPC
 *  would otherwise hold the one read in flight, and every later block's
 *  re-read with it, for good. Under two blocks, so the next tick retries. */
const GAME_READ_TIMEOUT_MS = 10_000
/** the wall-clock retry of the home's first reads (#530): 3 s, 5 s, 8 s, then every 10 s */
const FIRST_READ_RETRY_MS = [3_000, 5_000, 8_000, 10_000]
/** A finalized registration read that timed out must not be replaced by one
 * request per best block while the same RPC is unhealthy. */
const REGISTRATION_READ_BACKOFF_MS = 10_000
/** Bound a best-block player reconciliation so a silent RPC cannot suppress
 * every later block/foreground retry. */
const PLAYER_READ_TIMEOUT_MS = 10_000

/** the end of the game's last turn: a round is one turn per seat of the group cap */
function playEndsAt(game: PalletGame): number {
  return (
    game.game_date +
    gameDuration({ gameDate: game.game_date, reportEnds: game.report_ends, rounds: game.rounds, maxGroupSize: game.max_group_size })
  )
}

/** the slot has nothing left for the player to join, so the home shows the queue */
function showsQueue(game: PalletGame | undefined, now: number): boolean {
  return !game || (game.state.type === "Reporting" && now >= playEndsAt(game))
}

function deriveStatus(options: {
  game: PalletGame | undefined
  nextScheduleAt: number | undefined
  phases: PhaseDurations
  registered: boolean
  now: number
}): GameStatus {
  const { game, nextScheduleAt, phases, registered, now } = options
  const offset = registrationOffset(phases)

  if (!game || showsQueue(game, now)) {
    // an empty slot, or a game past its last turn in its report window: the
    // next game is the queue's first, and it opens when the pallet promotes it
    const reporting = game ? { reportingGameAt: game.game_date } : {}
    if (nextScheduleAt === undefined) return { kind: "none", ...reporting }
    return {
      kind: "scheduled",
      gameAt: nextScheduleAt,
      registrationAt: nextScheduleAt - offset,
      withinHour: now >= nextScheduleAt - REGISTER_BAND_S,
      ...reporting,
    }
  }

  const gameAt = game.game_date
  const withinHour = now >= gameAt - REGISTER_BAND_S
  const waitingOpen = registered && now >= gameAt - JOIN_WINDOW_S
  const waiting = (): GameStatus => ({ kind: "waiting", gameAt })

  switch (game.state.type) {
    case "Registration": {
      // REGISTRATION IS OPEN FROM THE MOMENT THE GAME EXISTS until the pallet
      // closes it. `schedule_games` puts the game on chain in `Registration`
      // in the same block and `sign_up_inner` checks nothing but that state
      // and `now < registration_ends` (the Game pallet, pallets/game/src/lib.rs
      // in the individuality runtime). So the app sets no band of its own: an
      // opening at game − (registration + shuffle + margin), or a cutoff at
      // `gameAt - JOIN_WINDOW_S`, would tell a player the chain refuses them
      // when it accepts them. The `registration` phase duration is the
      // pallet's SCHEDULING constraint (how far out a game must be
      // scheduled), not a gate on sign-up.
      if (now < game.registration_ends)
        return {
          kind: "registration",
          gameAt,
          closesAt: game.registration_ends,
          registered,
          withinHour,
          offerRegister: !registered,
        }
      return waitingOpen ? waiting() : { kind: "starting", gameAt, registered, withinHour }
    }
    case "Shuffle":
      return waitingOpen ? waiting() : { kind: "starting", gameAt, registered, withinHour }
    case "Reporting":
      // shuffle can finish ahead of game time — it's still the waiting room
      if (now < gameAt)
        return waitingOpen ? waiting() : { kind: "starting", gameAt, registered, withinHour }
      return {
        kind: "live",
        gameAt,
        endsAt: game.report_ends,
        playEndsAt: playEndsAt(game),
        registered,
        gameIndex: game.index,
        rounds: game.rounds,
        maxGroupSize: game.max_group_size,
      }
    default:
      return { kind: "processing" }
  }
}

/**
 * Compares the name the host runs this build as against the name it signs as.
 *
 * Only the two names, because that is all the app can observe. Reads and
 * identity work whichever they are, so nothing else shows the difference.
 */
interface ForeignProduct {
  /** name the host is running this build as */
  servedAs: string
  /** product whose account we ask it to sign with */
  signsAs: string
}

async function readForeignProduct(truApi: TruApi): Promise<ForeignProduct | null> {
  try {
    const callerId = await truApi.system.getProductContext().match(
      (value: { productId: string }) => value.productId,
      () => undefined,
    )
    if (!callerId || callerId === PRODUCT_ACCOUNT) return null
    return { servedAs: callerId, signsAs: PRODUCT_ACCOUNT }
  } catch {
    /* an older host without getProductContext tells us nothing */
    return null
  }
}

async function warnOnForeignProduct(truApi: TruApi): Promise<void> {
  const mismatch = await readForeignProduct(truApi)
  if (!mismatch) return
  devLog("source", "product mismatch", mismatch, "error")
  console.warn(`[game-source] served as ${mismatch.servedAs}, signing as ${mismatch.signsAs}`)
}

/** the chest's look for one player and one game: the same on every device */
export function chestSeed(account: string, gameIndex: number | null): string {
  return `${account}:${gameIndex ?? "all"}`
}

/** A source over one engine. Exported for the orchestration tests alone
 *  (lib/game-source.test.ts); the app resolves its source with
 *  `getGameSource`. */
export function makeSource(
  kind: SourceKind,
  engine: GameEngine,
  options: {
    player?: string
    playerAccountId?: Uint8Array
    signer?: CommonSignerTxCreator
    /** what the host does for a sign-up (lib/host/sign-up.ts): the playing
     *  account and its signer, the submission, the prize-draw tickets and the
     *  personhood keys. Without it, no sign-up */
    capabilities?: GameRegistrationCapabilities
    signalling?: CreateTransport
    calibrateSignalling?: Calibrate
    /** Links the player's username to the account that holds their draw
     *  tickets (lib/draw/name-link.ts): the names on the prize-draw wheel
     *  (#456). Run in the background, and no sign-up goes without it; never
     *  part of the sign-up's transaction. One link at a time. */
    linkName?: (trigger: NameLinkTrigger, signal: AbortSignal) => Promise<NameLinkResult>
    /** the step-free device clock (lib/device-clock.ts); the page's own by default */
    deviceClock?: DeviceClock
    hostConnection?: HostConnectionSource
  } = {},
): GameSource {
  const { player, playerAccountId, signer, capabilities, signalling, calibrateSignalling, linkName, hostConnection } = options
  const device = options.deviceClock ?? sharedDeviceClock()
  let chainHealthDeclined = false
  setTelemetryAddress(player ?? null)
  setPlayer(player ?? null)
  // the name rides along from the moment the source exists
  // (knownDisplayName({ ask: true }): no stored consent needed, and a refusal
  // is remembered). Nothing on the source path waits for it
  if (player)
    void knownDisplayName({ ask: true })
      .then((name) => {
        if (name) setPlayer(player, name)
      })
      .catch(() => {})

  // THE GAME CLOCK. It starts on the step-free device clock (lib/device-clock.ts, #331) with
  // offset 0, and it is ready at once. lib/clock-sync.ts holds the rule, and this is its wiring.
  // The peer check over the mesh is the only correction. The chain time watch only measures
  // the gap between this device and the block time.
  const CLOCK_WATCH_RETRY_MIN_MS = 1_000
  const CLOCK_WATCH_RETRY_MAX_MS = 30_000
  const CLOCK_WATCH_STALE_MS = 30_000
  const clock = createClockSync()
  let peerApplied = false
  /** the device ms at which this page's clock became ready */
  const readyDeviceMs = device.nowMs()
  let readyLogged = false
  let chainChecked = false
  let lastAnchorChainSeconds = 0
  let lastAnchorDeviceMs = 0
  type PeerWindow = "pregame" | "late" | "resume" | "step"
  /** "held": an "ok" median out of the dead band that waits for its confirmation */
  type PeerResult = "few" | "split" | "held" | "dead-band" | "applied"
  /** the open window's samples: per peer, the reply with the shortest round trip */
  const peers = new Map<string, PeerSample>()
  /** the open peer check window (not `window`, which is the page's). `openedMs` and `quorumMs` are device ms */
  let peerWindow: { kind: PeerWindow; openedMs: number; untilMs: number; result: PeerResult; quorumMs?: number } | undefined
  let peerCandidate: PeerCandidate | undefined
  /** the game index of the last settled peer window */
  let peerSettledFor: number | undefined
  /** the current game's kickoff and end, chain seconds */
  let gameWindow: { index: number; from: number; until: number } | undefined
  let handoverLoggedFor: number | undefined
  let seenStepMs = device.stepMs()
  /** the forward device step that no jump has used yet, ms (#1033) */
  let stepCreditMs = 0
  let jumpWithoutStepMs = 0
  let publishedOffset: number | undefined
  const tilesEnterMs = () => (gameWindow ? (gameWindow.from - TILES_ENTER_SECONDS) * 1000 : undefined)
  const clockMethod = () => (peerApplied ? "peer" : "none")
  const replayState = () => ({
    shownMs: clock.shownMs,
    targetMs: clock.targetMs,
    correcting: clock.correcting,
    method: clockMethod(),
    peers: peers.size,
    window: peerWindow?.kind ?? null,
  })
  const captureClockAnchor = createReplayClockAnchorCapture()
  const snapshotClock = (patch: { chainSeconds?: number; anchoredAtMs?: number } = {}) =>
    setClockSnapshot({ engine: engine.kind, offsetMs: Math.round(clock.shownMs), method: clockMethod(), peers: peers.size, ...patch })
  // lib/chain-clock.ts publishes whole seconds against the WALL clock (its readers add it to
  // `Date.now()`), so a wall step publishes it again.
  const publishOffset = () => {
    const offset = Math.round((clock.shownMs - device.stepMs()) / 1000)
    if (offset === publishedOffset) return
    publishedOffset = offset
    setChainOffset(offset)
  }
  const onClockEvents = (events: ClockEvent[]) => {
    for (const event of events) {
      if (event.kind === "corrected") devLog("clock", "clock corrected", { offsetMs: Math.round(event.offsetMs) })
      else {
        const fromMs = Math.round(event.fromMs)
        const toMs = Math.round(event.toMs)
        if (event.kind === "correction") devLog("clock", "clock correction", { via: "peer", fromMs, toMs, speed: event.speed })
        else devLog("clock", "clock jumped", { reason: event.reason, fromMs, toMs })
      }
      if (event.kind === "jump") {
        const jumpMs = event.toMs - event.fromMs
        const usedMs = Math.min(jumpMs, stepCreditMs)
        stepCreditMs -= usedMs
        jumpWithoutStepMs += jumpMs - usedMs
      }
    }
    if (events.length > 0) snapshotClock()
  }
  /** the game time in ms. Each read moves the shown offset on first, so the time never falls. */
  const gameMs = () => {
    const deviceMs = device.nowMs()
    onClockEvents(advance(clock, deviceMs, tilesEnterMs()))
    publishOffset()
    return deviceMs + clock.shownMs
  }
  /** the game second at which this page's clock became ready, only inside the game */
  const coldStartedAt = (): number | undefined => {
    if (!gameWindow) return undefined
    const second = Math.floor((readyDeviceMs + clock.targetMs) / 1000)
    return second >= gameWindow.from && second < gameWindow.until ? second : undefined
  }
  const closePeerWindow = () => {
    const closed = peerWindow
    if (!closed) return
    peerWindow = undefined
    stepCreditMs = 0
    const method = clockMethod()
    const offsetMs = Math.round(clock.targetMs)
    const samples = [...peers.values()]
    const medianMs = samples.length > 0 ? Math.round(median(samples.map((sample) => sample.offsetMs))) : undefined
    const rttMs = samples.length > 0 ? Math.round(median(samples.map((sample) => sample.rttMs))) : undefined
    // device ms from the open to the first "ok" verdict
    const quorumMs = closed.quorumMs === undefined ? undefined : Math.round(closed.quorumMs - closed.openedMs)
    devLog("clock", "clock peer check done", {
      window: closed.kind,
      peers: peers.size,
      ...(medianMs === undefined ? {} : { medianMs, rttMs }),
      ...(quorumMs === undefined ? {} : { quorumMs }),
      result: closed.result,
      method,
      offsetMs,
    })
    const tags = { "clock.window": closed.kind, "clock.result": closed.result }
    recordDistribution("clock.peer_count", peers.size, "none", tags)
    if (medianMs !== undefined) recordDistribution("clock.peer_offset_ms", medianMs, "millisecond", tags)
    for (const sample of samples) recordDistribution("clock.peer_rtt_ms", sample.rttMs, "millisecond", { "clock.window": closed.kind })
    if (quorumMs !== undefined) recordDistribution("clock.peer_quorum_ms", quorumMs, "millisecond", { "clock.window": closed.kind })
    recordDistribution("clock.peer_window_ms", device.nowMs() - closed.openedMs, "millisecond", tags)
    recordDistribution("clock.offset_ms", offsetMs, "millisecond", { "clock.window": closed.kind, "clock.method": method })
  }
  const openPeerWindow = (kind: PeerWindow, untilMs: number) => {
    closePeerWindow()
    peers.clear()
    peerCandidate = undefined
    peerWindow = { kind, openedMs: device.nowMs(), untilMs, result: "few" }
    devLog("clock", "clock peer check", { window: kind })
    captureReplayClock("clock-decision", { engine: engine.kind, game: gameWindow?.index ?? null, reason: "peer-check", state: replayState() })
    snapshotClock()
  }
  const settled = (result: PeerResult) => result === "dead-band" || result === "applied"
  // a window that is not settled stays open after its end time, until the game ends
  const closeEndedPeerWindow = (nowMs: number) => {
    if (!peerWindow || !gameWindow) return
    if (nowMs >= gameWindow.until * 1000 || (nowMs >= peerWindow.untilMs && settled(peerWindow.result))) closePeerWindow()
  }
  /** the mesh may ping: the first ask of a game opens the pre-game window, or a late one after the tiles */
  const wantsPeers = (): boolean => {
    if (!gameWindow) return false
    const nowMs = gameMs()
    closeEndedPeerWindow(nowMs)
    if (!peerWindow && peerSettledFor !== gameWindow.index && nowMs < gameWindow.until * 1000) {
      const pregameEndMs = (gameWindow.from - TILES_ENTER_SECONDS) * 1000
      if (nowMs < pregameEndMs) openPeerWindow("pregame", pregameEndMs)
      else openPeerWindow("late", nowMs + PEER_CHECK_MS)
    }
    return peerWindow !== undefined
  }
  const onGameRoute = () => {
    if (typeof window === "undefined") return false
    try {
      return /(?:^|\/)game\/?$/.test(window.location.pathname)
    } catch {
      return false
    }
  }
  // the mesh runs only on /game
  const requestPeerCheck = (kind: "resume" | "step") => {
    if (!gameWindow || !onGameRoute()) return
    const nowMs = gameMs()
    if (nowMs >= gameWindow.until * 1000) return
    openPeerWindow(kind, nowMs + PEER_CHECK_MS)
  }
  // every reply runs the verdict again, also with no new sample: the hysteresis needs the later look
  const offerPeer = (peerId: string, offsetMs: number, rttMs: number) => {
    if (!wantsPeers() || !peerWindow || !gameWindow) return
    const known = peers.size
    const before = peerWindow.result
    peers.set(peerId, betterSample(peers.get(peerId), { offsetMs, rttMs }))
    const verdict = peerVerdict([...peers.values()].map((sample) => sample.offsetMs))
    let result: PeerResult
    if (verdict.result === "ok") {
      peerWindow.quorumMs ??= device.nowMs()
      const confirmed = confirmPeerMedian(peerCandidate, verdict.medianMs, clock.targetMs, device.nowMs())
      peerCandidate = confirmed.candidate
      if (confirmed.move) {
        const moveMs = verdict.medianMs - clock.targetMs
        peerApplied = true
        setTarget(clock, verdict.medianMs)
        recordDistribution("clock.correction_ms", moveMs, "millisecond", { "clock.via": "peer" })
        captureReplayClock("clock-decision", {
          engine: engine.kind,
          game: gameWindow?.index ?? null,
          reason: "peer",
          moveMs,
          state: replayState(),
        })
        result = "applied"
      } else result = peerCandidate ? "held" : "dead-band"
    } else result = verdict.result
    peerWindow.result = result
    if (settled(result)) peerSettledFor = gameWindow.index
    if (peers.size === known && result === before) return
    devLog("clock", "clock peers", {
      window: peerWindow.kind,
      peers: verdict.peers,
      ...(verdict.result === "few" ? {} : { medianMs: Math.round(verdict.medianMs), agree: verdict.agree }),
      result,
    })
    snapshotClock()
  }
  const meshClock: MeshClock = { reply: () => device.nowMs(), wants: wantsPeers, offer: offerPeer }
  // a page that comes back asks its peers again; the chain is not asked again
  watchPageActivity((hidden) => {
    if (!hidden) requestPeerCheck("resume")
  })
  /** a chain check only measures: device ms minus block ms. It moves nothing */
  const chainCheck = (check: "first-value" | "first-change", gapMs: number) => {
    devLog("clock", "clock chain check", { check, gapMs: Math.round(gapMs) })
    recordDistribution("clock.chain_gap_ms", gapMs, "millisecond", { "clock.check": check })
  }
  let clockGameReadRetry: ReturnType<typeof setTimeout> | undefined
  const setGameWindow = (game: PalletGame | undefined) => {
    // an empty value mid-game keeps the window: the window ends by time
    if (!game) return
    clearTimeout(clockGameReadRetry)
    clockGameReadRetry = undefined
    if (gameWindow && gameWindow.index !== game.index) {
      peers.clear()
      peerCandidate = undefined
      peerWindow = undefined
    }
    gameWindow = { index: game.index, from: game.game_date, until: game.report_ends }
    if (!readyLogged) {
      readyLogged = true
      devLog("clock", "clock ready", { late: coldStartedAt() !== undefined })
    }
  }
  /** a new best block: `watchStatus` re-reads the game on it while it has none */
  const chainTickListeners = new Set<() => void>()
  let watchGameRetry: ReturnType<typeof setTimeout> | undefined
  const watchClockGame = () => {
    engine.watchGame(
      setGameWindow,
      (error) => {
        devLog("clock", "game watch for the clock failed; resubscribing", { detail: describeError(error) }, "warn")
        clearTimeout(watchGameRetry)
        watchGameRetry = setTimeout(watchClockGame, 1_000)
      },
    )
  }
  watchClockGame()
  // the host watch can stay silent, so one read sets the window first
  let clockGameReadBackoffMs = 1_000
  const scheduleClockGameRead = () => {
    if (gameWindow || clockGameReadRetry) return
    const delay = clockGameReadBackoffMs
    clockGameReadBackoffMs = Math.min(clockGameReadBackoffMs * 2, 30_000)
    clockGameReadRetry = setTimeout(() => {
      clockGameReadRetry = undefined
      readClockGame()
    }, delay)
  }
  const readClockGame = () => {
    void engine
      .game()
      .then((game) => {
        if (game) setGameWindow(game)
        else scheduleClockGameRead()
      })
      .catch((error: unknown) => {
        devLog("clock", "game read for the clock failed; retrying", { detail: describeError(error) }, "warn")
        scheduleClockGameRead()
      })
  }
  readClockGame()
  /** `first`: the first value of this watch generation, which can be an old one */
  const onClockAnchor = (seconds: number, first: boolean, block?: number) => {
    if (seconds <= lastAnchorChainSeconds) return
    const previousChainSeconds = lastAnchorChainSeconds
    const previousDeviceMs = lastAnchorDeviceMs
    lastAnchorChainSeconds = seconds
    chainTickListeners.forEach((notify) => notify())
    // the block number places a journey on the chain (telemetry), it is not part of the clock
    if (block !== undefined) setChainBlock(block)
    const deviceMs = device.nowMs()
    lastAnchorDeviceMs = deviceMs
    gameMs()
    const beforeMs = clock.targetMs
    const gapMs = deviceMs - seconds * 1000
    // the TURN proof's stamp reads the gap (lib/webrtc/ice.ts): a first value can be an
    // old block, so it is kept only until a live one comes
    if (!first || readChainGapMs() === null) setChainGapMs(gapMs)
    let reason = "held"
    if (previousChainSeconds === 0) {
      reason = "chain-first-value"
      chainCheck("first-value", gapMs)
    } else if (!first && !chainChecked) {
      chainChecked = true
      reason = "chain-first-change"
      chainCheck("first-change", gapMs)
    }
    const inGame = gameWindow !== undefined && seconds >= gameWindow.from && seconds < gameWindow.until
    captureClockAnchor({
      engine: engine.kind,
      game: gameWindow?.index ?? null,
      window: gameWindow ? { ...gameWindow } : null,
      block: block ?? null,
      chainMs: seconds * 1000,
      previousChainMs: previousChainSeconds ? previousChainSeconds * 1000 : null,
      previousReceiptDeviceMs: previousDeviceMs || null,
      receipt: replayClockReceipt(deviceMs),
      first,
      gapMs,
      beforeOffsetMs: beforeMs,
      afterOffsetMs: clock.targetMs,
      decision: beforeMs === clock.targetMs ? "held" : "applied",
      reason,
      after: replayState(),
    }, deviceMs, inGame, { game: gameWindow?.index ?? null, method: clockMethod() })
    snapshotClock({ chainSeconds: seconds, anchoredAtMs: Date.now() })
  }
  let clockWatchRetry: ReturnType<typeof setTimeout> | undefined
  let staleClockRecoveryRetry: ReturnType<typeof setTimeout> | undefined
  let stopClockWatch: Unsubscribe = () => {}
  let clockWatchGeneration = 0
  let clockWatchStartedAtMs = device.nowMs()
  let clockWatchRetryMs = CLOCK_WATCH_RETRY_MIN_MS
  let staleClockRecoveryRetryMs = CLOCK_WATCH_RETRY_MIN_MS
  let clockWatchNeedsRecoveryAnchor = false
  const clearStaleClockRecoveryRetry = () => {
    clearTimeout(staleClockRecoveryRetry)
    staleClockRecoveryRetry = undefined
  }
  const subscribeClock = () => {
    clearTimeout(clockWatchRetry)
    clockWatchRetry = undefined
    stopClockWatch()
    stopClockWatch = () => {}
    const generation = ++clockWatchGeneration
    let active = true
    let heard = false
    clockWatchStartedAtMs = device.nowMs()
    const anchored = (seconds: number, block?: number) => {
      if (!active || generation !== clockWatchGeneration) return
      const first = !heard
      heard = true
      const previousChainSeconds = lastAnchorChainSeconds
      onClockAnchor(seconds, first, block)
      if (lastAnchorChainSeconds === previousChainSeconds) return
      clockWatchRetryMs = CLOCK_WATCH_RETRY_MIN_MS
      staleClockRecoveryRetryMs = CLOCK_WATCH_RETRY_MIN_MS
      clearStaleClockRecoveryRetry()
      if (!clockWatchNeedsRecoveryAnchor) return
      clockWatchNeedsRecoveryAnchor = false
      devLog("clock", "chain clock subscription recovered", { generation, chainSeconds: seconds })
    }
    const failed = (error: unknown) => {
      if (!active || generation !== clockWatchGeneration) return
      active = false
      clockWatchNeedsRecoveryAnchor = true
      const retryMs = clockWatchRetryMs
      clockWatchRetryMs = Math.min(clockWatchRetryMs * 2, CLOCK_WATCH_RETRY_MAX_MS)
      warnThrottled(
        "chain clock subscription failed",
        "clock",
        "chain clock subscription failed; resubscribing",
        error,
      )
      stopClockWatch()
      stopClockWatch = () => {}
      if (clockWatchRetry) return
      clockWatchRetry = setTimeout(subscribeClock, retryMs)
    }
    try {
      const stop = engine.watchNow(anchored, failed)
      if (active && generation === clockWatchGeneration) {
        stopClockWatch = stop
      } else stop()
    } catch (error) {
      failed(error)
    }
  }
  const restartClockWatch = () => {
    clearTimeout(clockWatchRetry)
    clockWatchRetry = undefined
    subscribeClock()
  }
  const clockWatchStaleSinceMs = () => Math.max(lastAnchorDeviceMs, clockWatchStartedAtMs)
  const clockWatchIsStale = () => device.nowMs() - clockWatchStaleSinceMs() > CLOCK_WATCH_STALE_MS
  subscribeClock()
  const nowSeconds = () => {
    // a wall step, or a visible freeze the device clock took out as one, asks the peers again
    const stepMs = device.stepMs()
    if (stepMs !== seenStepMs) {
      const forwardMs = stepMs - seenStepMs
      seenStepMs = stepMs
      requestPeerCheck("step")
      // after the check: its new window clears the credit of the last one
      if (forwardMs > 0) stepCreditMs += forwardMs
    }
    const nowMs = gameMs()
    closeEndedPeerWindow(nowMs)
    return Math.floor(nowMs / 1000)
  }
  let requestClockRecovery = () => {}
  let stopStaleClockRecovery = () => {}
  let clockRecoverySubscribers = 0
  let clockRecoveryGameConsumer = false
  let observedClockState: ChainClockState | undefined
  const noteClockState = (state: ChainClockState): ChainClockState => {
    if (
      !observedClockState ||
      state.ready !== observedClockState.ready ||
      state.coldStartedAt !== observedClockState.coldStartedAt
    ) {
      observedClockState = { ...state }
      captureReplayClock("clock-state", {
        engine: engine.kind,
        game: gameWindow?.index ?? null,
        state: { ...state },
        lastAnchorChainMs: lastAnchorChainSeconds * 1000,
        lastAnchorDeviceMs,
        clock: replayState(),
      })
    }
    return state
  }
  const clockState = (): ChainClockState => {
    clockRecoveryGameConsumer = onGameRoute()
    if (!clockRecoveryGameConsumer) stopStaleClockRecovery()
    else if (clockWatchIsStale()) requestClockRecovery()
    if (gameWindow && handoverLoggedFor !== gameWindow.index) {
      handoverLoggedFor = gameWindow.index
      devLog("clock", "handover offset", { game: gameWindow.index, offsetMs: Math.round(clock.targetMs), method: clockMethod() })
    }
    const startedAt = coldStartedAt()
    return noteClockState(startedAt === undefined ? { ready: true } : { ready: true, coldStartedAt: startedAt })
  }
  // the game time in ms for stamps other clocks judge (lib/chain-clock.ts)
  setChainNow(() => gameMs())

  // THE NAME LINK (#456), in the background like the bind: the player's
  // username linked to this account, so the prize draw's wheel can name their
  // tickets. A SIGN-UP NEVER GOES WITHOUT IT. Asked for wherever a seat is read
  // (a game open or scheduled), and again on the ladder after any link that
  // did not end linked; a Register tap that waits on it asks at once, past
  // the ladder. `named` is the link's own word, read at the best block
  // (`linked`, `already-linked`). Until then the seat is "Getting your seat
  // ready…" (`seatFor`'s `named`), and the sign-up loop waits, until
  // registration closes. The sign-up flow waits on it; the gate is the one
  // the chat runs too (@individuality/name-link, name-gate.ts).
  const nameGate = linkName
    ? createNameGate({
        link: linkName,
        retryDelay: registrationRetryDelay,
        onOutcome: (outcome, failures, retryInMs) => {
          if (retryInMs === null) devLog("names", `name ${outcome}: Register may go`)
          // failed, out of time, skipped (no username yet, no chain), unfunded
          // (no PGAS yet), not-signed: Register waits, and the link goes again
          else devLog("names", `name link ${outcome ?? "timed out"}, trying again in ${retryInMs / 1000}s`, { failures }, "warn")
        },
      })
    : null
  // A player sent to Humanity to set up a username nobody owned (#1115) comes
  // back to this page: check again at once, not when the gate's hold runs out.
  if (nameGate)
    watchPageActivity((hidden) => {
      if (!hidden && nameGate.unowned()) nameGate.recheck()
    })

  /** A read the screens poll, failing: one line per distinct reason a minute
   *  (warnThrottled), so a dead chain does not fill the log ring. */
  const PLAYER_ROW_READ_FAILED = "player row read failed"
  const warnRead = (message: string, error: unknown) => warnThrottled(message, "source", message, error)
  /** a failed read of a flag is "not known": warn and carry on without it */
  const unknownOnFailure = (message: string) => (error: unknown) => {
    warnRead(message, error)
    return undefined
  }

  const gameView = async (): Promise<LiveGameView | null> => {
    if (!player) return null
    try {
      const game = await engine.game()
      // groups exist once the shuffle finished — from on-chain state Shuffle
      // on (Step4AwaitSession carries player_count), so the waiting room can
      // pre-connect to round 0 BEFORE game_date, not only once Reporting begins
      if (!game || (game.state.type !== "Shuffle" && game.state.type !== "Reporting")) return null
      const playerCount = statePlayerCount(game.state)
      if (playerCount === undefined) return null
      const [ownIndices, playerRow] = await Promise.all([
        engine.playerIndices(player),
        // a failed read of the flag is "not known" (undefined), never "not sent"
        engine.player(player).catch(unknownOnFailure(PLAYER_ROW_READ_FAILED)),
      ])
      if (!ownIndices) return null
      const groups = await Promise.all(
        ownIndices.map((ownIndex, round) =>
          engine.groupMembers(round, ownIndex, playerCount, game.max_group_size),
        ),
      )
      // every round's chairs, the pallet's own iterator BEFORE its
      // `< player_count` filter, zipped with the members the engine read
      const seats: LiveSeat[][] = []
      const mySeat: number[] = []
      for (const [round, ownIndex] of ownIndices.entries()) {
        const chairs = groupSeats(ownIndex, playerCount, game.max_group_size)
        const byIndex = new Map(groups[round].map((member) => [member.index, member.player]))
        const row = chairs.map((chair) => ({
          index: chair.index,
          player: chair.occupied ? (byIndex.get(chair.index) ?? null) : null,
        }))
        const at = chairs.findIndex((chair) => chair.index === ownIndex)
        // an inconsistent read (a member the chairs do not hold, or a held
        // chair with no member) resolves as no view — the caller polls again
        const occupied = chairs.filter((chair) => chair.occupied).length
        if (at < 0 || groups[round].length !== occupied) return null
        if (row.some((seat, i) => chairs[i].occupied && seat.player === null)) return null
        seats.push(row)
        mySeat.push(at)
      }
      return {
        gameIndex: game.index,
        timing: {
          gameDate: game.game_date,
          reportEnds: game.report_ends,
          rounds: game.rounds,
          maxGroupSize: game.max_group_size,
        },
        mySeat,
        seats,
        reportSent: playerRow ? playerRow.sent_report === true : undefined,
      }
    } catch (error) {
      warnRead("game view read failed", error)
      return null
    }
  }

  const drawSchedule: GameSource["drawSchedule"] = async (expectedGameAt) => {
    const game = await engine.game()
    if (!game || (expectedGameAt !== undefined && game.game_date !== expectedGameAt)) return null
    return {
      gameIndex: game.index,
      gameAt: game.game_date,
      scheduled: game.airdrops_scheduled,
    }
  }

  const reportStatus = async (gameIndex?: number): Promise<ReportStatus> => {
    const unknown: ReportStatus = { gameIndex, closed: false, report: "unknown" }
    if (!player) return unknown
    try {
      return reportStatusOf(await engine.reportStanding(player), gameIndex)
    } catch (error) {
      warnRead("report status read failed", error)
      return unknown
    }
  }

  const submitReport =
    signer && player
      ? async (fullReport: ReportVote[][], signal?: AbortSignal) => {
          const result = await retryBlockNotPinned(engine, {
            operation: "report",
            signal,
            errorOf: (value) => value.ok ? null : value.error,
            run: () => engine.report(signer, player, fullReport, signal),
          })
          // the doorway may know pallet error names: a second report is
          // refused as ReportAlreadySent, which means the first one counted;
          // NoReporting means the window is shut, which no retry can change
          if (!result.ok && result.error === "NoReporting") throw new ReportWindowClosedError()
          if (!result.ok && result.error !== "ReportAlreadySent") {
            throw new Error(result.error)
          }
        }
      : undefined

  let hostStuckEvidence = { lastTimeoutAtMs: null as number | null }
  const probeChainHealthOnce =
    signer && engine.probeChainHealth
      ? async (where: ChainHealthWhere, context?: ChainHealthContext) => {
          if (chainHealthDeclined)
            return {
              outcome: "declined",
              latencyMs: 0,
              error: "signing declined earlier on this page",
            } satisfies ChainHealthResult
          let builds = 0
          // a timeout counts from when its probe started, so one begun
          // before a return from the background is never paired after it
          const startedAtMs = performance.now()
          const build = () => {
            builds += 1
            const run = engine.probeChainHealth!(signer)
            if (builds === 2)
              run.then(
                () => retryMetric("chain-health", true, "host-interrupted"),
                () => retryMetric("chain-health", false, "host-interrupted"),
              )
            return run
          }
          const built = await runChainHealthProbe(() =>
            hostConnection ? safeHostReadWhenConnected(hostConnection, build) : build(),
          )
          const probed: ChainHealthResult =
            builds > 1 && built.outcome === "unknown" && built.errorClass === "timeout"
              ? { ...built, errorClass: "host-interrupted", error: "the rebuild after a host link reset ran past the probe bound" }
              : built
          const promoted = reduceHostStuckEvidence(
            resetHostStuckEvidenceOnReturn(hostStuckEvidence, lastBackgroundReturnAtMs()),
            probed,
            startedAtMs,
          )
          hostStuckEvidence = promoted.state
          const result = promoted.result
          if (result.outcome === "declined") chainHealthDeclined = true
          // app opens in a row that found the chain lost: it is what tells a
          // restart that helped from one that did not. Counted HERE only, once
          // per probe, and bounded: host storage gets STREAK_READ_BOUND_MS
          // once per open and is written without waiting
          // (lib/chain-lost-streak). The card reads it off the result.
          const consecutiveLost = await noteChainLostStreak(result).catch(() => undefined)
          if (consecutiveLost !== undefined) result.consecutiveLost = consecutiveLost
          chainHealthRecord({
            where,
            outcome: result.outcome,
            latencyMs: result.latencyMs,
            ...(consecutiveLost !== undefined ? { consecutiveLost } : {}),
            ...(context?.registered !== undefined ? { registered: context.registered } : {}),
            ...(result.outcome === "healthy"
              ? {}
              : result.outcome === "declined"
                ? { error: result.error }
                : { errorClass: result.errorClass, error: result.error }),
          })
          recordDistribution("chain.health", result.latencyMs, "millisecond", {
            "chain.health.where": where,
            "chain.health.outcome": result.outcome,
            "chain.health.error_class":
              result.outcome === "healthy" || result.outcome === "declined"
                ? "none"
                : result.errorClass,
          })
          if (result.outcome === "healthy")
            devLog("chain", `health ${where}: ${result.outcome}`, { latencyMs: result.latencyMs })
          else if (result.outcome === "declined")
            warnThrottled("chain health declined", "chain", `health ${where}: declined`, result.error)
          else
            warnThrottled(
              `chain health ${result.errorClass}`,
              "chain",
              `health ${where}: ${result.outcome}`,
              result.error,
            )
          return result
        }
      : undefined
  /** One probe at a time across the screen's card, the sign-up and the
   *  handover: a caller during a running probe takes its answer. */
  let probeRunning: Promise<ChainHealthResult> | undefined
  const probeChainHealth = probeChainHealthOnce
    ? (where: ChainHealthWhere, context?: ChainHealthContext): Promise<ChainHealthResult> => {
        if (probeRunning) return probeRunning
        const pending = probeChainHealthOnce(where, context)
        probeRunning = pending
        const clear = () => {
          if (probeRunning === pending) probeRunning = undefined
        }
        pending.then(clear, clear)
        return pending
      }
    : undefined
  /** A foreground return can wake after mobile timers froze the retry that a
   * failed clock subscription armed, and a visible `/game` can remain mounted
   * while the watch silently stalls. Prove the host chain path itself is
   * healthy before replacing a watch that has delivered no anchor for one
   * health interval. An unhealthy probe retries with a bounded backoff so a
   * recovered host repairs the watch without another visibility transition. */
  let staleClockRecoveryRunning = false
  const clockRecoveryAllowed = () =>
    (clockRecoverySubscribers > 0 || clockRecoveryGameConsumer) &&
    !pageHidden() &&
    onGameRoute()
  stopStaleClockRecovery = () => {
    clearStaleClockRecoveryRetry()
    staleClockRecoveryRetryMs = CLOCK_WATCH_RETRY_MIN_MS
  }
  const scheduleStaleClockRecovery = () => {
    if (staleClockRecoveryRetry || !clockRecoveryAllowed() || !clockWatchIsStale()) return
    const retryMs = staleClockRecoveryRetryMs
    staleClockRecoveryRetryMs = Math.min(staleClockRecoveryRetryMs * 2, CLOCK_WATCH_RETRY_MAX_MS)
    staleClockRecoveryRetry = setTimeout(() => {
      staleClockRecoveryRetry = undefined
      void recoverStaleClock()
    }, retryMs)
  }
  const recoverStaleClock = async () => {
    if (!probeChainHealth || !clockRecoveryAllowed() || !clockWatchIsStale() || staleClockRecoveryRunning) return
    staleClockRecoveryRunning = true
    const observedAnchor = lastAnchorDeviceMs
    const observedGeneration = clockWatchGeneration
    let result: ChainHealthResult
    try {
      result = await probeChainHealth("recheck")
    } catch (error) {
      warnThrottled("stale clock recovery probe failed", "clock", "stale clock recovery probe failed; retrying", error)
      staleClockRecoveryRunning = false
      scheduleStaleClockRecovery()
      return
    }
    staleClockRecoveryRunning = false
    if (
      !clockRecoveryAllowed() ||
      observedAnchor !== lastAnchorDeviceMs ||
      observedGeneration !== clockWatchGeneration ||
      !clockWatchIsStale()
    )
      return
    if (result.outcome !== "healthy") {
      if (result.outcome !== "declined") scheduleStaleClockRecovery()
      return
    }
    clearStaleClockRecoveryRetry()
    staleClockRecoveryRetryMs = CLOCK_WATCH_RETRY_MIN_MS
    devLog(
      "clock",
      "stale clock watch; resubscribing",
      { staleMs: Math.round(device.nowMs() - clockWatchStaleSinceMs()) },
      "warn",
    )
    restartClockWatch()
  }
  requestClockRecovery = () => {
    if (!clockRecoveryAllowed()) {
      stopStaleClockRecovery()
      return
    }
    if (staleClockRecoveryRetry || staleClockRecoveryRunning || !clockWatchIsStale()) return
    void recoverStaleClock()
  }

  const claimPrize =
    signer && player
      ? async (gameIndex: number, airdropIndex: number) => {
          devLog("claim", `claiming draw ${airdropIndex} of game ${gameIndex}`, { player })
          const outcome = await claimWithRetry({
            status: async () => {
              const draws = await prizeDrawView({ gameIndex })
              if (!draws) return undefined
              const draw = draws.find((d) => d.airdropIndex === airdropIndex)
              if (!draw) return { closed: "UnknownEvent" }
              return draw.claimed ? "claimed" : draw.claimable ? "claimable" : { closed: claimClosedReason(draw) }
            },
            send: () => engine.claimPrize(signer, gameIndex, airdropIndex, player),
            // a closed signing sheet comes back on the same channel as a
            // refused dispatch (submitToBestBlock), told apart by its words
            declined: isSigningDeclined,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            onRetry: (attempt, detail) => {
              devLog("claim", `claim sent again, attempt ${attempt}`, { detail }, "warn")
              recordCount("claim.retries", 1, { "claim.retry_attempt": String(attempt) })
            },
          })
          if (outcome.kind === "claimed") {
            devLog("claim", `claimed draw ${airdropIndex} of game ${gameIndex}`)
            void sweepClaimedPrizes(player, (address) => engine.prizeBalances(address), { gameIndex, airdropIndex })
            return
          }
          devLog("claim", `claim ${outcome.kind}`, { detail: outcome.detail }, outcome.kind === "cancelled" ? "warn" : "error")
          reportFailure("claim-failed", { reason: outcome.kind, context: { error: outcome.detail, "game.index": String(gameIndex) } })
          throw new ClaimError(outcome.kind, outcome.detail)
        }
      : undefined

  /**
   * THE TICKET, CHECKED WHERE IT COUNTS. After a sign-up lands, read the
   * game's draws back and say plainly if this player holds no ticket in one:
   * a sign-up cannot enter a draw afterwards, so a miss is final, and it must
   * never again be found only by someone not seeing their name on the wheel.
   */
  const confirmDrawTickets = async (who: string, missKind: DrawSkipKind | null) => {
    try {
      const game = await engine.game()
      if (!game) return
      const draws = await engine.draws(who, game.index)
      const missing = draws.filter((draw) => !draw.ticket)
      if (draws.length > 0 && missing.length === 0)
        devLog("signup", `in the prize draw for game ${game.index}`, { draws: draws.length })
      else if (missing.length > 0) {
        // the draw screen tells them, while they watch the draw (lib/draw/draw-miss)
        rememberDrawMiss(game.index, missKind)
        // left out on purpose (#167): this game cannot make them a member
        const onPurpose = missKind === "not-member-yet"
        devLog(
          "signup",
          onPurpose
            ? `left out of the prize draw for game ${game.index}: this game cannot make the player a member`
            : `signed up WITHOUT a prize-draw ticket for game ${game.index}`,
          { missing: missing.map((draw) => draw.airdropIndex), why: missKind },
          onPurpose ? "info" : "error",
        )
      }
    } catch (error) {
      devLog("signup", "could not check the prize-draw ticket", { detail: describeError(error) }, "warn")
    }
  }

  const logReadRetry = (tag: string) => (error: unknown, retry: number, delayMs: number) =>
    hostRetryRecord({ operation: `chain-read.${tag}`, attempt: retry + 1, reason: readRetryReason(error), waitedMs: delayMs, error })

  function readRetryReason(error: unknown): HostRetryReason {
    if (error instanceof ReadTimeoutError) return "read-timeout"
    return isHostChannelInterruption(error) ? "host-interrupted" : "read-failed"
  }

  /** A minute ahead of kickoff on the device clock, which the host rings on and every countdown reads. */
  const reminderStartMs = joinAtMs

  const remindOfGame = async () => {
    try {
      const game = await engine.game()
      if (!game) return
      const outcome = await holdGameReminder(game.game_date, reminderStartMs(game.game_date), reminderAskRecord)
      if (outcome) {
        devLog("signup", `the host reminder of game ${game.index} answered ${outcome}`, undefined, outcome === "held" || outcome === "asking" || outcome === "unsupported" ? "info" : "warn")
      }
    } catch (error) {
      devLog("signup", "could not ask the host for the game reminder", { detail: describeError(error) }, "warn")
    }
  }

  /**
   * THE ALARM FIRST: a sign-up from the app goes out once the host holds the
   * game reminder, as one from the chat does. Null lets it go, else the phase
   * that says why it did not.
   *
   * A host that cannot remind answers unsupported, as an older app or a name
   * that is not the game product does, such as a preview. The sign-up then
   * goes without the reminder, as it does when no game in registration has
   * been read, the record cannot be, or the host says the reminder time has
   * passed. Failed and denied asks still wait for the player to fix them.
   */
  const reminderBlock = async (game: RegistrationWindow | undefined): Promise<ReminderBlock | null> => {
    if (!game) return null
    const outcome = await reminderForSignup(game.gamePlayTime, reminderStartMs(game.gamePlayTime), reminderAskRecord)
    // Once the reminder time has passed there is no useful alarm to hold, but
    // registration may still be open. Let the sign-up proceed; late join owns
    // the case where kickoff itself has already passed.
    if (outcome === null || outcome === "held" || outcome === "unsupported" || outcome === "unrecorded" || outcome === "starts-in-past") return null
    const [block, reason]: [ReminderBlock, string] =
      outcome === "denied" ? ["reminders-off", "reminders-denied"] : ["alarm-required", `ask-${outcome}`]
    recordCount("register.blocked", 1, { reason, surface: "app" })
    devLog("signup", `the sign-up waits for the game reminder, which the host answered ${outcome}`, undefined, "warn")
    return block
  }

  // THE SIGN-UP (@individuality/sign-up, sign-up-flow.ts):
  // one tap, seen through every gate until it lands or registration closes,
  // over this source's engine, the host's keys and this app's telemetry
  const flow = createSignUpFlow({
    chain: engine,
    player,
    capabilities,
    communicationIdentifier,
    nameGate,
    reminders: reminderBlock,
    nowSeconds,
    // a hung attempt returns no CannotGetCurrentBlock for classifyRetry to
    // see, so the host's chain is looked at once the sign-up is slow (#507)
    probeHostChain: probeChainHealth
      ? async () => signupHostChainVerdict(await probeChainHealth("signup", { registered: false }))
      : undefined,
    retry: (options) => retryBlockNotPinned(engine, options),
    page: { hidden: () => pageHidden(), watch: (onChange) => watchPageActivity(onChange) },
    // the record of this sign-up for the chat and the other products
    // (@individuality/shared-records, lib/host/game-registration.ts)
    registrationRecord: { surface: "app", write: (record) => recordSignUp(record, () => engine.game()) },
    confirmDrawTickets: (who, missKind) => void confirmDrawTickets(who, missKind),
    remindOfGame: () => void remindOfGame(),
    telemetry: {
      journey: (name, attrs, options) => startJourney(name, attrs, options) as unknown as SignUpJourney,
      failure: (kind, details, journey) => reportFailure(kind, details, journey as unknown as Journey | undefined),
      count: (name, value, attrs) => recordCount(name, value, attrs),
      distribution: (name, value, unit, attrs) => recordDistribution(name, value, unit, attrs),
      broadcast: (account, attempt, route, gameIndex) => signupBroadcast(account, attempt, route, gameIndex),
      draws: (entered, skipped) => signupDraws(entered, skipped),
      gameIndex: (index) => setGameIndex(index),
      mask: (text) => maskSafe(text),
    },
    log: (tag, message, data, level) => devLog(tag, message, data, level),
    warn: warnRead,
    describe: (error) => describeError(error),
    // the product and the index decide which account signs. The deployed name
    // is not always the product name (a release may serve a build under
    // another name than the one it was built for), so the log line says which
    // one this was
    logFacts: { product: PRODUCT_DOTNS, index: SIGNUP_ACCOUNT_INDEX },
  })

  // THE SETTLE (@individuality/game-outcome, settle.ts), over this
  // source's reads: `Game.Game` retried as every read here is, and one more
  // read for the watch's poll, which gives up after GAME_READ_TIMEOUT_MS (a
  // host request that never answers holds the watch's query for good,
  // lib/read-retry.ts)
  const settle = settleWait(
    {
      readGame: (signal) => retryRead(() => engine.game(), { onRetry: logReadRetry("settle"), signal }),
      readGameOnce: () => withTimeout(engine.game(), GAME_READ_TIMEOUT_MS),
      watchGame: (cb, onError) => engine.watchGame(cb, onError),
    },
    {
      onSettled: (gameIndex) => gameSettledFor(gameIndex),
      onWatchError: (error) => devLog("chest", "settle watch failed", { detail: describeError(error) }, "warn"),
      abortReason: readAbortReason,
    },
  )
  const gameSettledNow = settle.settledNow
  const whenGameSettles = settle.whenSettles
  const gameSettled = settle.settled

  /**
   * What wakes a chest read before the settle: the player's own row, which a
   * co-player's Person vote moves in the block that awards its credit
   * (pallet-game `report`). Its first row is the one the chest is read at.
   */
  const playerRowMoves =
    (who: string) =>
    (changed: () => void, failed: (error: unknown) => void): (() => void) => {
      let first = true
      return engine.watchPlayerRow(
        who,
        () => {
          if (first) first = false
          else changed()
        },
        failed,
      )
    }
  const logPlayerWatchError = (gameIndex: number) => (error: unknown) =>
    devLog("chest", "the player watch failed, reading every block", { gameIndex, detail: describeError(error) }, "warn")

  /**
   * The votes on `who` in game `gameIndex` while it is in reporting, on every
   * change: the rule of @individuality/game-outcome on their row, and the vote
   * weight co-players can still cast on them, 0 once every vote is in. Null
   * while the row holds no verdict for that game.
   */
  const watchChestVotes = (who: string, gameIndex: number, cb: (votes: ChestVotes | null) => void): (() => void) => {
    let game: GameSlot | undefined
    let row: AttendanceRow | undefined
    let gameRead = false
    let rowRead = false
    const count = () => {
      if (!gameRead || !rowRead) return
      const attendance = attendanceInGame(game, row, gameIndex)
      if (!attendance || !row) return cb(null)
      cb({
        failed: attendance.status === "notAttended",
        votesToCome: Math.max(row.expected_max_vote_weight - (row.yes_person + row.no_not_person), 0),
        reported: row.sent_report,
        atClose: attendance.atClose,
        recognised: row.yes_person > 0,
      })
    }
    const stopGame = engine.watchGame(
      (value) => {
        game = value
        gameRead = true
        count()
      },
      (error) => devLog("chest", "the votes game watch failed", { gameIndex, detail: describeError(error) }, "warn"),
    )
    try {
      const stopRow = engine.watchPlayerRow(
        who,
        (value) => {
          row = value
          rowRead = true
          count()
        },
        (error) => devLog("chest", "the votes row watch failed", { gameIndex, detail: describeError(error) }, "warn"),
      )
      return () => {
        stopGame()
        stopRow()
      }
    } catch (error) {
      stopGame()
      throw error
    }
  }

  /**
   * The chest of a game still in reporting, once anything has arrived in it
   * (@individuality/game-outcome, before-settle.ts), or once the votes on the
   * player say what an empty chest means: read as it stands, again until
   * then. Claims open it `settling`. With none, it opens `voting` while
   * co-players can still vote (unless `holdWhileVoting`), and with the
   * verdict once every vote is in and none recognised the player. `view` is
   * null once the game settles with nothing read, or with no Asset Hub to
   * read: the caller then reads it as a settled game, with `last`, the last
   * votes seen in reporting.
   */
  const chestBeforeSettle = async (
    who: string,
    gameIndex: number,
    settles: Promise<void>,
    signal?: AbortSignal,
    holdWhileVoting?: boolean,
  ): Promise<{ view: ChestView | null; last: ChestVotes | null }> => {
    const chain = await resolveScarcityChain()
    if (!chain) return { view: null, last: null }
    let votes: ChestVotes | null = null
    let last: ChestVotes | null = null
    let wake: (() => void) | null = null
    let stopVotes = () => {}
    try {
      stopVotes = watchChestVotes(who, gameIndex, (next) => {
        votes = next
        if (next) last = next
        wake?.()
      })
    } catch (error) {
      devLog("chest", "the votes watch failed", { gameIndex, detail: describeError(error) }, "warn")
    }
    type Read = Omit<ChestView, "seed">
    const decided: { value: { votes: ChestVotes; final: boolean } | null } = { value: null }
    const arrived = (view: Read) => {
      if (view.items.length > 0) return true
      if (!votes || view.pending !== 0 || view.partial === true) return false
      if (votes.failed && votes.votesToCome === 0 && !votes.recognised) decided.value = { votes, final: true }
      else if (!holdWhileVoting && votes.votesToCome > 0) decided.value = { votes, final: false }
      else return false
      return true
    }
    let found: { value: Read; attempt: number } | null
    try {
      found = await readBeforeSettle({
        // the newest game, so a claim whose award block has no root yet is its own
        read: () => withTimeout(readChestPinned(chain, who, gameIndex, { latestGame: true }), READ_ATTEMPT_MS),
        arrived,
        settles,
        watch: (changed, failed) => {
          wake = changed
          return playerRowMoves(who)(changed, failed)
        },
        onWatchError: logPlayerWatchError(gameIndex),
        signal,
        abortReason: readAbortReason,
        onReadError: (error, read) =>
          devLog("chest", "a chest read before the settle failed", { gameIndex, read, detail: describeError(error) }, "warn"),
      })
    } finally {
      stopVotes()
    }
    if (!found) return { view: null, last }
    const { value: view, attempt: read } = found
    const seed = chestSeed(who, gameIndex)
    const decision = decided.value
    if (view.items.length === 0 && decision) {
      const counted = decision.votes
      if (decision.final) {
        devLog("chest", `game ${gameIndex}'s chest is empty: every vote is in`, { read, votesToCome: counted.votesToCome })
        return { view: { ...view, seed, attended: false, reportSent: counted.reported, verdict: "failed" }, last }
      }
      devLog("chest", `game ${gameIndex}'s chest is empty while votes are out`, { read, votesToCome: counted.votesToCome })
      return { view: { ...view, seed, voting: true }, last }
    }
    devLog("chest", `opening game ${gameIndex}'s chest before it settles`, {
      read,
      items: view.items.length,
      pending: view.pending,
    })
    return { view: { ...view, seed, settling: true }, last }
  }

  /**
   * A chest opened before the settle, kept up to date until it (the source's
   * `watchChest`), each read woken by the player's row (playerRowMoves). A
   * claim already shown is not previewed again (readChest `except`), so a read
   * with nothing new is one claims query.
   */
  const watchChest = async (options: {
    player?: string
    gameIndex: number
    shown: readonly string[]
    onItems: (items: ChestItem[]) => void
    signal: AbortSignal
  }): Promise<void> => {
    const who = options.player ?? player
    if (!who) return
    const chain = await resolveScarcityChain()
    if (!chain) return
    const { gameIndex, signal } = options
    const shown = new Set(options.shown)
    // A settle can take the whole report window (an hour), and one wait for it
    // gives up after SETTLE_TIMEOUT_MS: the watch keeps on with a new one, for
    // as long as the page is there
    for (;;) {
      const settles = whenGameSettles(gameIndex, signal)
      const settled = settles.then(
        () => true,
        () => false,
      )
      await readUntilSettle({
        read: () =>
          withTimeout(readChestPinned(chain, who, gameIndex, { latestGame: true, except: shown }), READ_ATTEMPT_MS),
        watch: playerRowMoves(who),
        onWatchError: logPlayerWatchError(gameIndex),
        onRead: (view, read) => {
          const fresh = view.items.filter((item) => !shown.has(item.hash))
          if (fresh.length === 0) return
          for (const item of fresh) shown.add(item.hash)
          devLog("chest", `${fresh.length} more claims in game ${gameIndex}'s chest before it settles`, { read, shown: shown.size })
          options.onItems(fresh)
        },
        settles,
        signal,
        abortReason: readAbortReason,
        onReadError: (error, read) =>
          devLog("chest", "a chest read while it collects failed", { gameIndex, read, detail: describeError(error) }, "warn"),
      })
      if (await settled) return
      if (signal.aborted) throw readAbortReason(signal)
      devLog("chest", "the settle is taking longer than one wait, watching on", { gameIndex })
    }
  }

  const chestView = async (options?: {
    player?: string
    gameIndex?: number
    signal?: AbortSignal
    /** Read only once the game has settled, for the credits the settle adds. */
    afterSettle?: boolean
    holdWhileVoting?: boolean
  }): Promise<ChestView | null> => {
    const who = options?.player ?? player
    if (!who) return null
    const requested: number | null = options?.gameIndex ?? null
    let gameIndex = requested
    let lastVotes: ChestVotes | null = null
    try {
      // A game still in reporting opens on the claims that have arrived. With
      // none yet, the settle is waited for: the pallet writes
      // `last_attended_game` when it settles a game, so a read before that
      // still names the previous one.
      if (requested !== null && !(await gameSettledNow(requested, options?.signal))) {
        const watch = new AbortController()
        const forward = () => watch.abort(options?.signal?.reason)
        options?.signal?.addEventListener("abort", forward, { once: true })
        let settles = whenGameSettles(requested, watch.signal)
        // awaited below; this keeps a watch the early chest stops from surfacing as unhandled
        settles.catch(() => {})
        try {
          if (!options?.afterSettle) {
            // A settle can take the whole report window, and one wait for it gives
            // up after SETTLE_TIMEOUT_MS: a read held while voting waits on with a new one
            for (;;) {
              const settled = settles.then(
                () => true,
                () => false,
              )
              const early = await chestBeforeSettle(who, requested, settles, options?.signal, options?.holdWhileVoting)
              if (early.view) return early.view
              lastVotes = early.last ?? lastVotes
              if (!options?.holdWhileVoting || (await settled)) break
              if (options?.signal?.aborted) throw readAbortReason(options.signal)
              devLog("chest", "the settle is taking longer than one wait, holding on", { gameIndex: requested })
              settles = whenGameSettles(requested, watch.signal)
              settles.catch(() => {})
            }
          }
          await settles
        } finally {
          options?.signal?.removeEventListener("abort", forward)
          // stops the watch an early chest leaves running; a no-op once it settled
          watch.abort()
        }
      }
      return await retryRead(
        async () => {
          // Without this read the newest claims cannot be placed, and guessing an
          // older game would hide them behind a false "you earned nothing".
          const lastAttended = (await engine.participant(who))?.last_attended_game ?? null
          gameIndex = requested ?? lastAttended
          const seed = chestSeed(who, gameIndex)
          const chain = await resolveScarcityChain()
          if (!chain) {
            console.warn(`[chest] no Asset Hub to read game ${gameIndex} from`)
            return { gameIndex, seed, items: [], unprovable: 0, pending: 0, claimed: 0, failed: "no Asset Hub" }
          }
          const read = await readChestPinned(chain, who, gameIndex, {
            latestGame: gameIndex !== null && gameIndex === lastAttended,
          })
          const attended = gameIndex !== null && gameIndex === lastAttended
          // only an empty chest needs the fact of the report, and a failed read is "not known"
          const row =
            !attended && read.items.length === 0
              ? await engine.player(who).catch(unknownOnFailure(PLAYER_ROW_READ_FAILED))
              : undefined
          // the settle resets the row, so a chest open across it keeps the votes reporting closed on
          const empty = read.items.length === 0 && read.pending === 0 && read.claimed === 0 && read.unprovable === 0 && read.partial !== true
          if (empty && !attended && lastVotes?.reported === true && !lastVotes.atClose && !lastVotes.recognised)
            return { ...read, seed, attended, reportSent: true, verdict: "failed" as const }
          return { ...read, seed, attended, ...(row ? { reportSent: row.sent_report === true } : {}) }
        },
        { onRetry: logReadRetry("chest"), signal: options?.signal },
      )
    } catch (error) {
      if (options?.signal?.aborted) throw readAbortReason(options.signal)
      const failed = describeError(error)
      devLog("chest", "chest read failed", { gameIndex, detail: failed }, "warn")
      console.warn(`[chest] read failed for game ${gameIndex}: ${failed}`)
      return { gameIndex, seed: chestSeed(who, gameIndex), items: [], unprovable: 0, pending: 0, claimed: 0, failed }
    }
  }

  /**
   * Read the game's prize draws and map them onto the prize-draw wheel's
   * contract (lib/draw/prize-draw.ts).
   *
   * The chain gives whole-unit prize amounts as `assetAmount` scaled by the
   * PRIZE ASSET's own decimals (not the chain's token) — game-chain resolves
   * that metadata, so the conversion here is honest rather than assumed.
   */
  const prizeDrawView = async (options?: {
    player?: string
    gameIndex?: number
  }): Promise<PrizeDrawView[] | null> => {
    const who = options?.player ?? player
    if (!who) return null
    try {
      let gameIndex: number | null = options?.gameIndex ?? null
      if (gameIndex === null) {
        const participant = await engine.participant(who)
        gameIndex = participant?.last_attended_game ?? null
      }
      if (gameIndex === null) {
        devLog("draw", "no game to read a draw for", { player: who, explicit: options?.gameIndex ?? null }, "warn")
        return []
      }
      const startedAt = Date.now()
      const resolvedGame = gameIndex
      const draws = await engine.draws(who, gameIndex)
      const eligibility = await engine.eligibility(who, gameIndex)
      // what the chain read returned, draw by draw — the evidence for whatever
      // the draw screen then shows
      devLog("draw", `read game ${gameIndex}'s draws: ${draws.length}`, {
        game: gameIndex,
        from: options?.gameIndex !== undefined ? "the page" : "last attended",
        ms: Date.now() - startedAt,
        draws: draws.map((draw) => ({
          index: draw.airdropIndex,
          status: draw.status,
          listed: draw.tickets?.length ?? null,
          total: draw.totalEntries,
          ticket: draw.ticket ? draw.ticket.slice(0, 10) : null,
          won: draw.won,
          claimed: draw.claimed === true,
          target: Boolean(draw.target),
          winners: draw.winningTickets.length,
        })),
        eligible: eligibility.eligible,
        blocked: eligibility.reason,
      })
      return draws.map((draw): PrizeDrawView => {
        const decimals = draw.prize?.decimals ?? 0
        const whole =
          draw.prize === null
            ? 0
            : Number(draw.prize.assetAmount) / Math.pow(10, decimals)
        return {
          gameIndex: resolvedGame,
          airdropIndex: draw.airdropIndex,
          phase: drawPhase(draw.status),
          prizeUsd: whole,
          // no ticket means we never entered — the scene still plays, with
          // our slot simply absent from the ribbon
          userTicket: draw.ticket ?? "",
          winningTickets: draw.winningTickets,
          totalEntries: draw.totalEntries,
          listedEntries: draw.tickets?.length ?? 0,
          won: draw.won,
          // the wheel needs every entry and the cut; either missing, no wheel
          // (no ticket of ours still draws it: a player not in the draw watches)
          wheel:
            draw.tickets?.length && draw.target
              ? {
                  tickets: draw.tickets,
                  target: draw.target,
                  winners: draw.effectiveWinners ?? draw.winningTickets.length,
                  ...(draw.holders ? { holders: draw.holders } : {}),
                }
              : null,
          prizeSymbol: draw.prize?.symbol ?? null,
          claimed: draw.claimed === true,
          claimable: eligibility.eligible && draw.won && draw.claimed !== true && draw.status === "Claiming",
          claimBlockedReason: eligibility.reason,
        }
      })
    } catch (error) {
      // Empty is the authoritative "no draw" result. A failed read must stay
      // failed so the shared loader forgets it and a later route reads again.
      devLog("draw", "draw read failed", { gameIndex: options?.gameIndex ?? null, detail: describeError(error) }, "error")
      throw error
    }
  }

  /** the player's verdict in a game before it settles (#1096) */
  const attendance = attendanceWatch(engine, gameSettled, warnRead)

  return {
    kind,
    player,
    playerAccountId,
    register: flow.register,
    cancelRegister: flow.register ? flow.cancelRegister : undefined,
    nowSeconds,
    unexplainedJumpMs: () => jumpWithoutStepMs,
    clockState,
    meshClock,
    gameView,
    drawSchedule,
    reportStatus,
    signalling,
    calibrateSignalling,
    submitReport,
    probeChainHealth,
    claimPrize,
    chestView,
    watchChest,
    prizeDrawView,
    gameSettled,
    watchAttendance: player ? (gameIndex, cb) => attendance.watch(player, gameIndex, cb) : undefined,
    attendanceApplied: player ? (gameIndex) => attendance.applied(player, gameIndex) : undefined,
    watchStatus(cb) {
      // both NOT_READ until their first answer (statusGate)
      let game: Read<PalletGame | undefined> = NOT_READ
      let nextScheduleAt: Read<number | undefined> = NOT_READ
      /** A best-block Registration value, held until a finalized read sees the same
       * slot. The home shows it as scheduled; `game` only feeds the player and seat reads. */
      let pendingRegistration: { game: PalletGame; seenAtMonotonicMs: number } | undefined
      /** the game slot as far as anything but the gate cares: not read is empty */
      const slot = () => (game === NOT_READ ? undefined : game)
      let phases = FALLBACK_PHASES
      // NOT_READ until the chain answers for the slot (#1108); with no account
      // there is no one to be registered, and that is known at once
      let registered: Read<boolean> = player ? NOT_READ : false
      /** the slot's player read failed or timed out before any answer: the
       *  hold ends (heldStatus) while the retries go on */
      let playerReadFailed = false
      let seat: Seat | undefined
      let funds: Funds | undefined
      let stopped = false
      clockRecoverySubscribers += 1
      // the page starts on "loading" (lib/use-game-status), so that is where
      // the first transition is logged from
      let lastKind: GameStatus["kind"] = "loading"
      let lastStatus: GameStatus = { kind: "loading" }

      const fromChat = (phase: RegistrationPhase) => {
        const record = flow.registration()
        return record?.surface === "chat" && record.phase === phase && record.gameIndex === slot()?.index
      }
      // OR in the optimistic flag: a broadcast sign-up shows "you're in" until
      // the chain confirms it (watchPlayer) or rolls it back. A sign-up the
      // chat broadcast counts the same way, and either answers before the read.
      const registeredNow = (): Read<boolean> =>
        registered === true || flow.optimistic().registered || fromChat("sent") || fromChat("registered") ? true : registered

      const emit = () => {
        if (stopped) return
        // before the first answers the status is "loading", never "none"
        // the best block shows the older slot has ended, so a held game is next
        const held = pendingRegistration?.game
        const known = held
          ? { game: undefined, nextScheduleAt: held.game_date, registered: false }
          : statusGate(game, nextScheduleAt, registeredNow(), nowSeconds())
        const derived: GameStatus = known
          ? deriveStatus({ ...known, phases, now: nowSeconds() })
          : heldStatus(lastStatus, playerReadFailed)
        // the sign-up of the app says more than the one of the chat
        const signup: SignupPhase = flow.phase() === "idle" && fromChat("registering") ? "chat" : flow.phase()
        const status: GameStatus =
          derived.kind === "registration" && seat
            ? {
                ...derived,
                seat,
                signup,
                ...(seat.path === "deposit" || seat.path === "unfunded" ? { funds } : {}),
              }
            : derived.kind === "registration"
              ? { ...derived, signup }
              : derived
        lastStatus = status
        cb(status)
        setClockSnapshot({ engine: engine.kind, status: status.kind, gameAt: "gameAt" in status ? status.gameAt : null })
        if (status.kind !== lastKind) {
          const answer = registeredNow()
          devLog("status", `${lastKind} to ${status.kind}`, {
            now: nowSeconds(),
            gameAt: "gameAt" in status ? status.gameAt : undefined,
            seat: "seat" in status ? status.seat?.path : undefined,
            game: slot()?.index,
            registered: answer === NOT_READ ? "unread" : answer,
          })
          lastKind = status.kind
        }
      }

      void engine
        .phases()
        .then((value) => {
          phases = value
          emit()
        })
        .catch((error: unknown) => {
          devLog("source", "phase durations read failed", { detail: describeError(error) }, "warn")
        })

      // A host whose chain subscription is dead never ticks, so the first
      // reads also run on the wall clock (#530): while the game read or the
      // schedule read of a slot that shows the queue is still NOT_READ, ask again on a
      // backoff. The in-flight guards hold, and the timer stops by itself
      // once a value lands. The status can be unknown AGAIN later (the slot
      // empties while the queue was never read), so every path that leaves
      // it pending re-arms it from idle (#583): `rearmFirstReads`. The
      // player's read is one of them once a game is known (#1108).
      const playerPending = () => slot() !== undefined && registeredNow() === NOT_READ
      const firstReadsPending = () =>
        game === NOT_READ || (showsQueue(slot(), nowSeconds()) && nextScheduleAt === NOT_READ) || playerPending()
      let firstReadTimer: ReturnType<typeof setTimeout> | undefined
      let firstReadAttempt = 0
      let scheduleRetrying = false
      const armFirstReadRetry = () => {
        if (stopped || firstReadTimer !== undefined || !firstReadsPending()) return
        const delay = FIRST_READ_RETRY_MS[Math.min(firstReadAttempt, FIRST_READ_RETRY_MS.length - 1)]
        firstReadAttempt += 1
        firstReadTimer = setTimeout(retryFirstReads, delay)
      }
      /** pending again with no timer: start the backoff over (a no-op while one is armed) */
      const rearmFirstReads = () => {
        if (firstReadTimer !== undefined) return
        firstReadAttempt = 0
        armFirstReadRetry()
      }
      // one body for the timer and the block tick
      const rereadPending = () => {
        if (pendingRegistration) readFinalizedRegistration()
        else if (!slot()) readGame()
        // a game past its last turn holds the slot for its report window, and
        // an admin can add a game to the queue at any time in it
        const queueStale = slot() !== undefined && showsQueue(slot(), nowSeconds())
        if ((nextScheduleAt === NOT_READ || queueStale) && !scheduleRetrying) {
          scheduleRetrying = true
          void readSchedules().finally(() => {
            scheduleRetrying = false
          })
        }
        if (playerPending()) reconcilePlayer()
      }
      const retryFirstReads = () => {
        firstReadTimer = undefined
        if (stopped || !firstReadsPending()) return
        rereadPending()
        armFirstReadRetry()
      }

      const readSchedules = (): Promise<void> =>
        withTimeout(engine.schedules(), GAME_READ_TIMEOUT_MS)
          .then((schedules) => {
            if (stopped) return
            if (schedules === null) {
              homeReadTimedOut()
              devLog("status", "schedule read timed out", { ms: GAME_READ_TIMEOUT_MS }, "warn")
              rearmFirstReads()
              return
            }
            const before = nextScheduleAt
            nextScheduleAt = schedules[0]?.game_play_time
            homeScheduleRead()
            // a schedule appearing is what starts preparing a lite seat
            if (typeof before !== "number" && nextScheduleAt !== undefined) readSeatPath()
            emit()
          })
          .catch((error: unknown) => {
            homeReadFailed()
            devLog("status", "schedule read failed", { detail: describeError(error) }, "warn")
            rearmFirstReads()
          })

      // the seat is chain state too (player record, balance, lite gates, the
      // binding), so it is re-read when one of its inputs moves — never on
      // the tick. A zero comm key gives the same fee estimate as the real
      // one. Read while a game is open for sign-up AND while one is only
      // scheduled: a lite person's seat is prepared then, so it is ready the
      // block registration opens.
      // Reads overlap, and each captures `bound` as it starts: a result is
      // applied only while it is the newest, or a read begun before the bind
      // landed could put "preparing" back on a seat that is ready.
      const seatReads = readSequence()
      const readSeatPath = () => {
        if (!player || !signer) return
        const registration = slot()?.state.type === "Registration"
        if (!registration && typeof nextScheduleAt !== "number") return
        // the name link is prepared with the seat, so it is linked by the tap
        flow.requestName()
        const seq = seatReads.next()
        void flow
          .readSeat()
          .then((value) => {
            if (!seatReads.apply(seq)) return
            seat = value.seat
            funds = value.funds
            if (value.seat.path === "free" && !value.seat.ready) flow.requestBind()
            emit()
          })
          .catch((error: unknown) => {
            // a lite lookup that timed out lands here too: the seat stays as it was
            devLog("seat", "seat read failed", { detail: describeError(error) }, "warn")
          })
      }

      // a broadcast sign-up flips the optimistic flag on the flow; re-emit so
      // this subscriber's status reflects it (and its rollback)
      const stopFlowWatch = flow.onChange(emit)
      // the bind landing (or failing, and being due again) is a seat input,
      // and so is the name link
      const stopSeatInputs = flow.onSeatInput(readSeatPath)

      // THE WATCH IS NOT THE ONLY WAY IN (#289). A home that learned of the
      // game from the watch alone settled on "No game scheduled" whenever the
      // watch stayed silent: the schedule queue is already empty once the game
      // is promoted, so no game + no schedule reads as none, for good. So the
      // game is also READ, once at subscribe and again on every new block
      // while the slot reads empty, until a game shows. Whether a read lands
      // beside the watch is acceptFallbackGame's rule: the watch bumps
      // `gameAnswers`, so a read begun before a watch value is stale.
      const gameAnswers = readSequence()
      /** the newest game index applied, from the watch or a read */
      let seen: number | undefined
      /** Positive registration is monotonic only inside one explicit game
       *  slot. A new slot resets it and invalidates every older read/watch. */
      let playerGeneration = 0
      let playerReading = false
      let playerReadPending = false
      let stopPlayer: Unsubscribe | undefined
      const applyPlayer = (record: Awaited<ReturnType<GameEngine["player"]>>, fromWatch: boolean) => {
        const next = record?.registered === true
        // The watch carries no block identity. Once a best-block read or watch
        // proves true for this slot, an unversioned false cannot disprove it.
        if (registered === true && !next) return
        // A read of absence only confirms the state already rendered; unlike a
        // watch event it is not a moving seat input, so do not duplicate the
        // seat read on every reconciliation tick. The first one for the slot
        // is the answer the status waits on, though (#1108).
        if (!next && !fromWatch) {
          if (registered === NOT_READ) {
            registered = false
            emit()
          }
          return
        }
        registered = next
        if (next) flow.confirmRegistered()
        if (fromWatch) readSeatPath()
        emit()
      }
      const watchPlayerForSlot = () => {
        stopPlayer?.()
        stopPlayer = undefined
        if (!player || !slot()) return
        const generation = playerGeneration
        stopPlayer = engine.watchPlayer(player, (record) => {
          if (stopped || generation !== playerGeneration) return
          applyPlayer(record, true)
        })
      }
      const reconcilePlayer = () => {
        if (stopped || !player || !slot() || registered === true) return
        if (playerReading) {
          playerReadPending = true
          return
        }
        playerReading = true
        const generation = playerGeneration
        const gameIndex = slot()?.index
        // a read with no answer, while the status waits on one, ends the hold
        const unanswered = () => {
          if (stopped || generation !== playerGeneration || registered !== NOT_READ) return
          if (!playerReadFailed) {
            playerReadFailed = true
            emit()
          }
          rearmFirstReads()
        }
        void withTimeout(engine.player(player), PLAYER_READ_TIMEOUT_MS)
          .then((record) => {
            if (record === null) {
              devLog("status", "player read timed out", { ms: PLAYER_READ_TIMEOUT_MS }, "warn")
              unanswered()
              return
            }
            if (stopped || generation !== playerGeneration || gameIndex !== slot()?.index) return
            applyPlayer(record, false)
          })
          .catch((error: unknown) => {
            devLog("status", "player read failed", { detail: describeError(error) }, "warn")
            unanswered()
          })
          .finally(() => {
            playerReading = false
            if (playerReadPending) {
              playerReadPending = false
              reconcilePlayer()
            }
          })
      }
      // the one path for every answer about the slot, a watch value or a read
      const applyGame = (value: PalletGame | undefined) => {
        const newSlot = value?.index !== slot()?.index
        flow.setSlot(
          value?.index,
          value?.state.type === "Registration"
            ? { index: value.index, registrationEnds: value.registration_ends, gamePlayTime: value.game_date }
            : undefined,
        )
        // a NEW game slot voids any optimism carried from the previous one
        if (newSlot) {
          playerGeneration += 1
          registered = player ? NOT_READ : false
          playerReadFailed = false
          flow.newSlot(value?.index)
        }
        if (value && (seen === undefined || value.index > seen)) seen = value.index
        const first = game === NOT_READ
        game = value
        homeGameRead(value !== undefined)
        if (newSlot) watchPlayerForSlot()
        // the slot changing moves the queue (rereadPending also reads it while
        // the slot game is past its last turn)
        readSchedules()
        // a game reported again is a seat input moving; an empty slot read
        // again on the next block is not
        if (value || newSlot || first) readSeatPath()
        reconcilePlayer()
        emit()
        // an empty slot whose queue was never read is unknown again
        rearmFirstReads()
      }
      const confirmRegistration = (value: PalletGame | undefined): boolean => {
        const pending = pendingRegistration
        if (!pending || value?.index !== pending.game.index || value.state?.type !== "Registration") return false
        pendingRegistration = undefined
        const lagMs = Math.max(0, performance.now() - pending.seenAtMonotonicMs)
        devLog("status", `registration shown after finalized (+${lagMs} ms)`, { game: pending.game.index })
        recordDistribution("registration.finalized_lag_ms", lagMs, "millisecond", {})
        // The finalized read is only the display gate. The best value carries
        // the live deadline/countdown and remains the rendered source.
        applyGame(pending.game)
        return true
      }
      /** A finalized answer confirms the pending Registration value or, on a
       * fresh mount, applies the finalized slot for the player and seat reads. */
      const settleFinalizedRegistration = (value: PalletGame | undefined) => {
        if (!confirmRegistration(value) && game === NOT_READ) applyGame(value)
      }
      /** Hold a new best-block Registration value until the finalized snapshot
       * sees the same slot. Until then the home shows that game as scheduled. */
      const gateRegistration = (value: PalletGame | undefined): boolean => {
        if (
          value?.state?.type !== "Registration" ||
          (slot()?.index === value.index && slot()?.state?.type === "Registration")
        )
          return false
        if (seen === undefined || value.index > seen) seen = value.index
        pendingRegistration = {
          game: value,
          seenAtMonotonicMs:
            pendingRegistration?.game.index === value.index
              ? pendingRegistration.seenAtMonotonicMs
              : performance.now(),
        }
        return true
      }
      // one read in flight at a time; a hung one gives up after
      // GAME_READ_TIMEOUT_MS and the next block reads again
      let gameReading = false
      const readGame = () => {
        if (stopped) return
        if (gameReading) return
        gameReading = true
        const ticket = gameAnswers.next()
        withTimeout(engine.game(), GAME_READ_TIMEOUT_MS)
          .then((value) => {
            if (stopped) return
            if (value === null) {
              homeReadTimedOut()
              devLog("status", "game read timed out", { ms: GAME_READ_TIMEOUT_MS }, "warn")
              rearmFirstReads()
              return
            }
            // A best-block Registration can beat this mount's first finalized read and make its
            // ticket stale: a match shows Registration, else the held game stays scheduled.
            if (game === NOT_READ && pendingRegistration) {
              settleFinalizedRegistration(value)
              return
            }
            if (!acceptFallbackGame(value, gameAnswers.apply(ticket), seen)) return
            if (value) devLog("status", "game read where the watch was silent", { game: value.index })
            applyGame(value)
          })
          .catch((error: unknown) => {
            homeReadFailed()
            warnRead("game read failed", error)
            rearmFirstReads()
          })
          .finally(() => {
            gameReading = false
          })
      }
      let finalizedRegistrationReading = false
      let finalizedRegistrationRetryAtMonotonicMs = 0
      const readFinalizedRegistration = () => {
        if (stopped || !pendingRegistration || finalizedRegistrationReading) return
        if (performance.now() < finalizedRegistrationRetryAtMonotonicMs) return
        finalizedRegistrationReading = true
        withTimeout(engine.game(), GAME_READ_TIMEOUT_MS)
          .then((value) => {
            if (stopped) return
            if (value === null) {
              finalizedRegistrationRetryAtMonotonicMs = performance.now() + REGISTRATION_READ_BACKOFF_MS
              warnRead("finalized registration read timed out", new Error(`after ${GAME_READ_TIMEOUT_MS} ms`))
              return
            }
            settleFinalizedRegistration(value)
          })
          .catch((error: unknown) => {
            finalizedRegistrationRetryAtMonotonicMs = performance.now() + REGISTRATION_READ_BACKOFF_MS
            warnRead("finalized registration read failed", error)
          })
          .finally(() => {
            finalizedRegistrationReading = false
          })
      }
      const stopGame = engine.watchGame(
        (value) => {
          homeWatchFired()
          // a watch value makes every read begun before it stale
          gameAnswers.apply(gameAnswers.next())
          if (gateRegistration(value)) {
            emit()
            return
          }
          pendingRegistration = undefined
          applyGame(value)
        },
        (error) => devLog("status", "game watch failed", { detail: describeError(error) }, "warn"),
      )
      readGame()
      armFirstReadRetry()
      // Host storage has no change subscription, so the record of the chat is
      // read when the chain is: at subscribe, on every block and on every
      // return to the page, which is how a player comes over from the chat.
      let registrationReading = false
      const readRegistrationRecord = () => {
        if (registrationReading) return
        registrationReading = true
        void readGameRegistration()
          .then(flow.setRegistration)
          .finally(() => {
            registrationReading = false
          })
      }
      readRegistrationRecord()
      // `!slot()` is also true while the watch has never fired (NOT_READ).
      // A queue read that failed is retried here too, explicitly: on an empty
      // slot "none" waits for it, and nothing else is bound to ask again. Past
      // the slot game's last turn, the queue is read again on every tick.
      const onChainTick = () => {
        rereadPending()
        reconcilePlayer()
        readRegistrationRecord()
      }
      chainTickListeners.add(onChainTick)
      const stopActivity = watchPageActivity((hidden) => {
        if (hidden) {
          stopStaleClockRecovery()
          return
        }
        requestClockRecovery()
        reconcilePlayer()
        readRegistrationRecord()
      })
      // a top-up lands as a balance change: the unfunded screen flips to
      // Register within a block, no refresh
      let lastFree: string | undefined
      const stopBalance =
        player && signer
          ? engine.watchFreeBalance(player, (free) => {
              if (lastFree !== undefined && free !== lastFree) readSeatPath()
              lastFree = free
            })
          : undefined
      // no readSchedules here: every answer about the slot goes through
      // applyGame, which reads the queue, and the queue only matters once the
      // slot has been answered (statusGate)
      // re-derive every second: the status is time-gated, not only state-gated
      const timer = setInterval(emit, 1000)

      return () => {
        if (stopped) return
        stopped = true
        clockRecoverySubscribers = Math.max(0, clockRecoverySubscribers - 1)
        if (clockRecoverySubscribers === 0) stopStaleClockRecovery()
        stopFlowWatch()
        stopSeatInputs()
        chainTickListeners.delete(onChainTick)
        clearInterval(timer)
        clearTimeout(firstReadTimer)
        stopGame()
        stopPlayer?.()
        stopActivity?.()
        stopBalance?.()
      }
    },
  }
}

/**
 * Writes an extrinsic the host built for the wire to the debug sheet.
 *
 * The host reassembles the transaction from the forwarded extensions, so the
 * bytes it returns are the only record of what went on the wire (decode
 * offline).
 */
export function logHostExtrinsic(hex: string, byteLength: number): void {
  devLog("signtx", `host built extrinsic (${byteLength}B)`, { hex })
}

/** how long a dead host channel may stay down before the page reloads: a
 *  transient disconnect recovers inside it */
const HOST_RELOAD_GRACE_MS = 2_000

/**
 * Measure the host connection and reload when its channel dies. The bridge is
 * one MessagePort injected at document start; once it closes, later host calls
 * hang or fail until a reload attaches a fresh port. The delay
 * (`HOST_RELOAD_GRACE_MS`) lets a transient disconnect recover, and the
 * rolling reload cap in lib/self-reload.ts prevents a bad host from looping.
 */
export function watchHostChannel(
  sdk: {
    subscribeConnectionStatus: (callback: (status: "connecting" | "connected" | "disconnected") => void) => () => void
  },
  // resolveSource opens it before the SDK is even imported, so the step spans
  // the wait for the host and not just the instant an attached one answers
  opened?: Step,
) {
  if (typeof window === "undefined") return
  const connecting = opened ?? appOpenStep("host.connect")
  // a resume can interrupt the proof call with no status change to retry on
  retryIceServersOnForegroundReturn()
  let wasConnected = false
  let wasDisconnected = false
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  sdk.subscribeConnectionStatus((status) => {
    devLog("host", `channel ${status}`, undefined, status === "disconnected" && wasConnected ? "error" : "info")
    if (status === "connected") {
      noteHostChannelRestored()
      connecting.end()
      wasConnected = true
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = undefined
      if (wasDisconnected) {
        wasDisconnected = false
        void retryIceServersAfterHostReconnect().catch((error) =>
          devLog(
            "rtc",
            "TURN retry after host reconnect failed",
            { detail: describeError(error) },
            "warn",
          ),
        )
      }
      return
    }
    if (status !== "disconnected" || !wasConnected || reloadTimer) return
    wasDisconnected = true
    noteHostChannelLost()
    reloadTimer = setTimeout(() => {
      requestSelfReload("host-channel")
    }, HOST_RELOAD_GRACE_MS)
  })
}

let sourcePromise: Promise<GameSource | null> | undefined

/**
 * Resolve the source once per page load. `null` means "not a host environment
 * and no dev override" — the page shows the host-only gate.
 */
export function getGameSource(): Promise<GameSource | null> {
  sourcePromise ??= resolveSource()
  return sourcePromise
}

async function resolveSource(): Promise<GameSource | null> {
  // 1. host container — pallet reads through the engine lib/engine.ts picks
  // (the chain over the host's People provider, or the same chain over
  // NEXT_PUBLIC_PEOPLE_WS when the host serves none).
  // Identity, signing and statements stay the product-sdk's either way.
  // host.connect runs from here: the SDK import and the channel coming up are
  // the wait it measures (started later, it would read 0 ms on a host that is
  // already attached)
  const connecting = typeof window === "undefined" ? undefined : appOpenStep("host.connect")
  try {
    const sdk = await import("@parity/product-sdk-host")
    const inside = sdk.isInsideContainerSync()
    if (!inside) connecting?.end({ "host.inside": "false" })
    devLog("source", `container detection: ${inside ? "inside" : "outside"}`, { product: PRODUCT_DOTNS })
    if (inside) {
      watchHostChannel(sdk, connecting)
      // Host build metadata is diagnostic and must not add its one-second
      // timeout to the product open path.
      void readHostInfoResult().then(({ info, failed }) => noteAppOpenHost(info, failed))
      const engine = await resolveHostEngine(sdk)
      if (!engine) {
        // inside a host that serves no People chain and no dev override —
        // the page shows the host-only gate; say so in the debug sheet, or
        // this is indistinguishable from "not in a host" on a phone.
        devLog("source", "host serves no People chain — no engine (gate)", undefined, "error")
      }
      if (engine) {
        // identity: the host-derived product account; its signer is the only one
        let player: string | undefined
        let playerAccountId: Uint8Array | undefined
        let signer: CommonSignerTxCreator | undefined
        let capabilities: GameRegistrationCapabilities | undefined
        // the playing account — also the key that proves game statements
        let hostAccount: ProductAccount | undefined
        // the host's answers for the account and the bridge: the rest of the
        // wait the open spends before the home screen knows who plays
        const identity = appOpenStep("host.identity")
        try {
          const accounts = await retrySafeHostRead(sdk, () => sdk.getAccountsProvider(), { operation: "sdk.accounts" })
          const account = accounts
            ? // Surface WHY the product account fails to resolve instead of
              // swallowing it: a silent undefined here leaves identity "none"
              // and looks like "not in a host". An app/host wire-codec skew
              // (Malformed protocol error payload) shows up here first.
              // index 1 on this network, not the host default (signupAccountIndex, #85)
              (await retrySafeHostRead(
                sdk,
                () => accounts.getProductAccount(PRODUCT_ACCOUNT, SIGNUP_ACCOUNT_INDEX),
                { errorOf: (result) => result.match(() => null, (error) => error) },
              )).match(
                (value) => value,
                (error) => {
                  const detail = describeError(error)
                  devLog("source", `getProductAccount(${PRODUCT_ACCOUNT}) failed`, { detail }, "error")
                  console.warn(`[game-source] getProductAccount failed: ${detail}`)
                  return undefined
                },
              )
            : undefined
          hostAccount = account
          const truApi = await retrySafeHostRead(sdk, () => sdk.getTruApi(), { operation: "sdk.truapi" })
          if (truApi) void warnOnForeignProduct(truApi)
          if (accounts && account && truApi) {
            player = AccountId().dec(account.publicKey)
            playerAccountId = account.publicKey
            // The SDK's stock signer: the host builds the whole transaction
            // from the extensions the SDK forwards (truApi.signing
            // .createTransaction, txExtVersion 0 = the runtime's extension
            // version) and fills the VerifyMultiSignature slot with its own
            // signature. Requires truapi-host 0.23.0 or later; older hosts
            // assembled a v4 transaction one slot short.
            signer = withExtrinsicLogging(accounts.getProductAccountSigner(account), logHostExtrinsic)
            // the sign-up's: the same account and signer, its prize-draw
            // tickets, and Humanity's (`peopl.<tld>`) keys for the free seat and a recognized
            // person's draw entries (lib/host/sign-up.ts). Without them the
            // source still reads, and offers no sign-up
            capabilities = await signUpCapabilities(accounts, signer, {
              tld: network().dotnsTLD,
              accountIndex: SIGNUP_ACCOUNT_INDEX,
            }).catch((error: unknown) => {
              devLog("source", "the host gave no sign-up capabilities", { detail: describeError(error) }, "warn")
              return undefined
            })
          }
        } catch (error) {
          devLog("source", "host identity unavailable", { detail: describeError(error) }, "warn")
        } finally {
          identity.end({ "host.identity": player ? "found" : "none" })
        }
        if (process.env.NODE_ENV !== "production") {
          console.info(`[game-source] host identity ${player ?? "none"} (product ${PRODUCT_ACCOUNT})`)
        }
        // WebRTC signalling rides the People statement store, proved AS THE
        // PLAYER (lib/host/statement-store.ts): the pallet grants the statement
        // allowance to the account that signed up, so the proof must carry that
        // key — the SDK store's `createProofAuthorized` signs with the product's
        // allowance account instead, which the node refuses (`noAllowance`) and
        // the CLI host cannot even sign (`UnableToSign`). No identity → no
        // store → the mesh stays dark, by design.
        const account = hostAccount
        const resolveStore: ResolveStore = () =>
          account
            ? playerStatementStore(sdk, account, {
                onSubscribed: statementsSubscribed,
                onFirstPage: statementsFirstPage,
                onInterrupted: statementsInterrupted,
                onResubscribed: statementsResubscribed,
              })
            : Promise.resolve(null)
        const signalling = statementTransport({
          resolveStore,
          // the peer TTL and the stats on the step-free device clock; the
          // expiry deadline the node judges on the page's store clock, game
          // time plus a margin learned from the node's acceptances, re-stamped
          // once on a time rejection (lib/store-clock.ts): a wall clock
          // stepped back 75 s would mint only expired statements (#331)
          now: deviceNowMs,
          storeClock: storeClock(),
          // the page's session id is ordered by the game clock, which no wall
          // step moves (lib/store-clock.ts `storeClockBase`); a wrong one
          // only delays a reload, the transport fails open (#214)
          sessionNow: () => storeClockBase().ms,
          namespace: PRODUCT_ACCOUNT,
          // WHO SIGNED IT (#2014): a player's id is the account that proves its
          // statements, so a statement counts only when its signer is the
          // account its `from` names. Anyone with an allowance can post under a
          // co-player's topic; without this a forged hello or bye cut that
          // co-player off from the room
          signerOf: signerOfPlayer(AccountId().enc),
          // ONE STATEMENT PER PHONE in a room for the whole game (statement-core,
          // rule 7): each phone links to every co-player of every round during
          // the pre-game countdown. Each phone's statement goes under its own topic, and a phone
          // listens to its co-players' alone (rule 8, #1959: one topic for the
          // whole game sent every phone every statement, which a 300-player
          // game could not carry). A new label, so a v4 build, which posts and
          // listens on the game's one topic, never meets this one
          labelPrefix: "jollity:rtc-v5",
          bundle: true,
          // a bundle with offers in it goes deflated (~45% smaller for 10
          // co-players); a hello alone stays plain. v5 builds read both
          deflateBundles: true,
          // END TO END (statement-core, header): every offer and candidate is
          // sealed to the co-player's identifier on chain with this player's
          // registered secret, and nothing directed goes in the clear (since
          // v4: a v3 build sent them in the clear)
          keys: {
            // this player's own key, and what each lookup tells the trace (lib/own-key.ts)
            secret: ownKeySecret(player, engine),
            peerIdentifier: (peer) => engine.communicationIdentifier(peer),
          },
          // a submit that backed off, waited for a slot or failed, to the trace per pair
          onSubmit: signalSubmit,
          // into the debug sheet as well: a phone export must show whether the
          // store was live and whether submits landed, not just the console
          log: (message) => {
            console.warn(message)
            const routine = /store live|subscribed/.test(message)
            devLog("statement", message, undefined, routine ? "info" : "warn")
          },
        })
        // the store clock's margin, learned in the waiting room on the
        // player's own channel, so in-game signalling never pays a rejection
        const calibrateSignalling =
          account && player
            ? storeCalibrator({ resolveStore, namespace: PRODUCT_ACCOUNT, id: player, labelPrefix: "jollity:rtc-v2" })
            : undefined
        // names on the prize-draw wheel (#456): this player's username linked
        // to their jollity account, in the background before Register
        const linkName =
          account
            ? (trigger: NameLinkTrigger, signal: AbortSignal) =>
                import("./draw/name-link").then(({ linkPlayerName }) => linkPlayerName(account, trigger, signal))
            : undefined
        return makeSource("host", engine, {
          player,
          playerAccountId,
          signer,
          capabilities,
          signalling,
          calibrateSignalling,
          linkName,
          hostConnection: sdk,
        })
      }
    }
  } catch (error) {
    connecting?.end({ "host.inside": "failed" })
    // not in a host — fall through. Inside one, this is a crash on the host
    // path (a chunk that failed to load, a bridge call that threw) wearing
    // the gate's clothes: record it.
    devLog("source", "host path failed — falling through", { detail: describeError(error) }, "error")
  }

  // 2. development outside a host: a READ-ONLY chain view over
  // NEXT_PUBLIC_PEOPLE_WS — no signer, watching states only
  const dev = resolveDevEngine()
  if (dev) return makeSource("ws", dev)

  // host-only: nothing to run against
  return null
}
