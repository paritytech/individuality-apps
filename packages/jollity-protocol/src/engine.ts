// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE GAME ENGINE SEAM — the one interface the app reads the Game pallet
 * through. @jollity/game-chain answers it (`createChainEngine(client)`, papi
 * over the People chain): the engine IS the pallet.
 *
 * The shapes below are the PALLET's, field for field, in the pallet's own
 * snake_case. They are plain data — no papi types, no bigint where a string
 * will travel — and the chain engine maps onto them with a one-line pick each.
 * game-source.ts consumes these and nothing else: no `client.api`, no stub.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import type { DispatchResult } from "@individuality/people-chain"
import type { SignUpChain } from "@individuality/sign-up"

/** The signer the host hands the app — product-sdk's product-account signer.
 *  The chain engine signs extrinsics with it. */
export type EngineSigner = CommonSignerTxCreator

// ── Game pallet storage ──────────────────────────────────────────────────────

/** `Game.Game.state` — the pallet's variants, by their real names. Only
 *  `Reporting` carries data the app reads; the others are opaque steps. */
export type PalletGameState =
  | { type: "Registration"; value?: unknown }
  | { type: "Shuffle"; value?: unknown }
  | { type: "Reporting"; value: { player_count: number } }
  | { type: "PlayerProcess"; value?: unknown }
  | { type: "Cancelling"; value?: unknown }

export type PalletGameStateType = PalletGameState["type"]

/** `Game.Game` — one row, present while a game exists. Unix seconds. */
export interface PalletGame {
  index: number
  state: PalletGameState
  /** `Game.Game.airdrops_scheduled`: authoritative count for this game. */
  airdrops_scheduled: number
  registration_ends: number
  shuffle_deadline: number
  game_date: number
  report_ends: number
  rounds: number
  max_group_size: number
}

/** `Game.StoredPhaseDurations` (or the `DefaultPhaseDurations` constant). */
export interface PalletPhaseDurations {
  registration: number
  shuffle: number
  post_shuffle_margin: number
  /** the report window after game_date, and the player-process phase after it — present on the runtime, optional here for older readers */
  reporting?: number
  player_process?: number
}

/** `Game.GameSchedules[n]` — a future game on the calendar. */
export interface PalletSchedule {
  game_play_time: number
  rounds: number
  max_group_size: number
}

/** `Game.Players(player)` — registration, and whether the player's report counted. */
export interface PalletPlayer {
  registered: boolean
  /** the pallet's `sent_report`: the player's report is in, and the pallet
   *  refuses a second one with `ReportAlreadySent`. Absent on the
   *  `watchPlayer` stream, which carries registration alone. */
  sent_report?: boolean
}

/** `Game.Players(player).early_attendance_enactment`: the attendance the pallet
 *  applied the moment the votes still to come could no longer change it. The
 *  pallet writes `Score.Participants` at the same moment, and clears this at
 *  the end of PlayerProcess. */
export interface PalletEarlyAttendance {
  attendance: boolean
  disposition: "Keep" | "ArchiveKickable" | "ArchiveUnkickable"
}

/** `Game.Players(player)` with the votes: everything the attendance rule reads
 *  (attendance.ts). The tallies and `expected_max_vote_weight` are WEIGHTED,
 *  with weights frozen at the shuffle. */
export interface PalletPlayerRow {
  registered: boolean
  sent_report: boolean
  /** the weight this player's own votes carry */
  vote_weight: number
  /** weighted `Person` votes received */
  yes_person: number
  /** weighted `NotPerson` votes received */
  no_not_person: number
  /** the most weight this player can receive: their co-players' vote weights
   *  over every round */
  expected_max_vote_weight: number
  early_attendance_enactment: PalletEarlyAttendance | null
}

/** What one block says about a player's report: the game row, the player's
 *  row and the player's last attended game, all read at the SAME block. The
 *  pallet leaves Reporting for PlayerProcess at report_ends (or once every
 *  attendance is decided), and step 1 then archives or resets the Players
 *  row, so a row read at one block and a game read at another can disagree. */
export interface PalletReportStanding {
  /** `Game.Game`, absent once the game is cleared */
  game: PalletGame | undefined
  /** `Game.Players(player)`, absent once archived */
  player: PalletPlayer | undefined
  /** `Score.Participants(player).last_attended_game` */
  lastAttendedGame: number | null
  /** when that block's game has left Reporting and step 1 has processed the
   *  player: the row at the LAST block still in Reporting, whose sent_report
   *  is final. Absent when no such block is still held (the chain engine
   *  looks only between the best block and the finalized one). */
  reportingRow?: PalletPlayer | null
}

/** A pallet player reference — an account, or a person (alias-only). */
export type PalletPlayerRef =
  | { type: "Account"; value: string }
  | { type: "Person"; value: unknown }

/** One seat of a round's group: the player index and who sits in it. */
export interface PalletGroupMember {
  index: number
  player: PalletPlayerRef
}

// ── Score pallet storage ─────────────────────────────────────────────────────

export type PalletRecognitionType =
  | "Recognized"
  | "ExternallyRecognized"
  | "NotRecognized"
  | "Suspended"

/** `Score.Participants(player)` — the fields the app decides membership on. */
export interface PalletParticipant {
  /** cumulative attendance score, capped at 21 */
  score: number
  /** the current run. `Attended(n)` means the next attendance adds `n + 1`. */
  streak: { type: "Attended" | "Absent"; count: number }
  /** the last 8 games as bits, newest lowest */
  attendance_history: number
  last_attended_game: number | null
  recognition: { type: PalletRecognitionType }
  reached_personhood: boolean
  has_ever_reached_personhood: boolean
}

// ── attestations + airdrops (post-game reads) ───────────────────────────────

/** One prize draw of a game, as the app's drum ceremony reads it. */
export interface PalletDraw {
  airdropIndex: number
  /** the airdrop event's status tag, or "gone" once swept */
  status: string
  /** null once finalized and removed. `assetAmount` is a base-unit integer
   *  as a string — it survives JSON and `Number()` reads it either way. */
  prize: { assetAmount: string; decimals: number; symbol?: string } | null
  drawTime: number | null
  ticket: string | null
  winningTickets: string[]
  totalEntries: number
  /** we won — including a win already claimed */
  won: boolean
  /** we won and have already claimed it: a claim cannot be made twice */
  claimed?: boolean
  /** every entry's ticket slot, ascending — what the wheel is drawn from.
   *  Absent where a source cannot list them, empty once the chain clears
   *  them after the claim window. */
  tickets?: string[]
  /** the draw's target (`Airdrop.EventEntropy`), null until it is captured */
  target?: string | null
  /** how many winners the draw picked, where the state carries it */
  effectiveWinners?: number | null
  /** who holds each ticket, where the registrant is an account: slot → SS58 */
  holders?: Record<string, string>
}

/** What an account holds in one asset the prize draws pay in. */
export interface PalletPrizeBalance {
  /** the asset location as JSON, with bigints written as strings */
  assetKey: string
  /** a base-unit integer as a string, as `PalletDraw.prize.assetAmount` */
  amount: string
}

export interface PalletEligibility {
  eligible: boolean
  reason: string | null
}

// ── writes ───────────────────────────────────────────────────────────────────

export type ReportVote = "Person" | "NotPerson"

// What an extrinsic comes back as, and the sign-up's seam: the shared
// packages' (@individuality/people-chain, @individuality/sign-up), which sit on
// the product SDK's game registration.
export type { DispatchResult } from "@individuality/people-chain"

export type Unsubscribe = () => void

/** The pallet's reads, writes and watches. The sign-up's calls are the shared
 *  sign-up's (`SignUpChain`: the seat, the lite key, the bind and the sign-up,
 *  over the product SDK's `registerForGame`), so the engine is the chain the
 *  sign-up flow runs over. */
export interface GameEngine extends SignUpChain {
  /** which engine answered — for logs, never for logic */
  kind: "chain"

  // reads — the pallet's storage
  /** `Timestamp.Now`, Unix seconds. THE clock every time-gated read anchors to. */
  now(): Promise<number>
  /** Finalized `Game.Game`. Best-block changes arrive through `watchGame`. */
  game(): Promise<PalletGame | undefined>
  schedules(): Promise<PalletSchedule[]>
  phases(): Promise<PalletPhaseDurations>
  player(address: string): Promise<PalletPlayer | undefined>
  /** `Game.Players(address)` with the votes, at the best block; absent for a
   *  player who never signed up or was archived */
  playerRow(address: string): Promise<PalletPlayerRow | undefined>
  /** `Game.PlayerToIndex(player)` — your index per round, once shuffled */
  playerIndices(address: string): Promise<number[] | undefined>
  /** `Game.IndexToPlayer` over one group's indices for one round */
  groupMembers(round: number, ownIndex: number, playerCount: number, maxGroupSize: number): Promise<PalletGroupMember[]>
  participant(address: string): Promise<PalletParticipant | undefined>
  /** `Game.CommunicationIdentifiers(address)` at the FINALIZED block (the
   *  SDK's `readCommunicationIdentifier` pins it, unlike the best-block reads
   *  around it): the 65-byte P-256 key the player registered for the game,
   *  which co-players seal their signalling to; null when it has none (an
   *  alias never does, and a sign-up not finalized yet reads none: the
   *  transport asks again after its retry window) */
  communicationIdentifier(address: string): Promise<Uint8Array | null>
  /** the game, `Game.Players(address)` and the player's last attended game,
   *  read at ONE best block (see `PalletReportStanding`) */
  reportStanding(address: string): Promise<PalletReportStanding>
  /** `Score.PersonhoodThreshold` — the score that makes a participant a person */
  personhoodThreshold(): Promise<number>
  draws(address: string, gameIndex: number): Promise<PalletDraw[]>
  /** the positive balances of `address` in every asset the prize draws may pay in, at the best block */
  prizeBalances(address: string): Promise<PalletPrizeBalance[]>
  eligibility(address: string, gameIndex: number): Promise<PalletEligibility>
  /** Build and sign, but never submit, an empty System.remark through the
   *  report's signer path: the host-health probe. Absent on an engine with
   *  no host chain client. */
  probeChainHealth?(signer: EngineSigner): Promise<void>

  /** Resolves true once the chain client has a fresh best-block follow after
   *  its previous pinned blocks were dropped, or false at its bounded wait.
   *  The app's one-shot BlockNotPinned recovery. */
  waitUntilFollowing?(failedBlockHash?: string, signal?: AbortSignal): Promise<boolean>

  // writes — the pallet's extrinsics, signed by the host; the sign-up's are `SignUpChain`'s
  /** `Game.report` as a participant (fee-free `ScoreAsParticipant`).
   *  `signal` bounds the submit: an abort drops the watch and rejects with the
   *  signal's reason. The transaction may still land, so the caller re-reads
   *  `player(...).sent_report` before submitting again. */
  report(signer: EngineSigner, player: string, fullReport: ReportVote[][], signal?: AbortSignal): Promise<DispatchResult>
  /** `Game.claim_airdrop` as a participant (fee-free `ScoreAsParticipant`):
   *  pays draw `airdropIndex` of game `gameIndex` to `beneficiary` */
  claimPrize(signer: EngineSigner, gameIndex: number, airdropIndex: number, beneficiary: string): Promise<DispatchResult>

  // subscriptions — `watchValue({ at: "best" })`
  watchGame(cb: (game: PalletGame | undefined) => void, onError?: (error: unknown) => void): Unsubscribe
  /** `Timestamp.Now` of the current best block, then of every new best block,
   *  Unix seconds. Fires the moment the block arrives: the instant to anchor
   *  a clock to. `block` is that best block's number, so a log line can be
   *  placed on the chain. */
  watchNow(cb: (seconds: number, block?: number) => void, onError?: (error: unknown) => void): Unsubscribe
  watchPlayer(
    address: string,
    cb: (player: PalletPlayer | undefined) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe
  /** `playerRow` on every change. It fires on every vote the player receives,
   *  so the registration watch stays `watchPlayer`. */
  watchPlayerRow(
    address: string,
    cb: (row: PalletPlayerRow | undefined) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe
  /** the account's spendable balance (planck string), on every change — a
   *  top-up flips the unfunded screen within a block. */
  watchFreeBalance(
    address: string,
    cb: (free: string) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe

  destroy(): void
}

/** The player count a game state carries. `Reporting` holds it directly;
 *  `Shuffle` holds it on its later steps (`Step3ComputeWeights`,
 *  `Step4AwaitSession` — the roster is frozen by then), `PlayerProcess` on
 *  `Step1ProcessPlayers`. Undefined while the pallet has not counted yet. */
export function statePlayerCount(state: PalletGameState): number | undefined {
  const value = state.value as { player_count?: unknown; step?: { value?: unknown } } | undefined
  if (typeof value?.player_count === "number") return value.player_count
  const step = value?.step?.value as { player_count?: unknown } | undefined
  return typeof step?.player_count === "number" ? step.player_count : undefined
}
