// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Answers the `GameEngine` of @jollity/protocol from the Game and Score pallets,
 * through `@parity/product-sdk-individuality`. Each method maps an SDK read onto
 * the pallet shape the protocol carries, and nothing here decides anything.
 *
 * Where the SDK has no read in the shape a method needs, the method reads the
 * storage entry over papi: the clock, the game and its schedule and phases,
 * the player and participant records, the threshold, the free balance, and
 * the prize draws in `chain/airdrop.ts`.
 *
 * The game comes decoded by the SDK, so an unknown state variant throws where
 * the raw read passed it through.
 */
import { Enum } from "polkadot-api"
import type {
  EngineSigner,
  GameEngine,
  PalletDraw,
  PalletEligibility,
  PalletPrizeBalance,
  PalletGame,
  PalletGameState,
  PalletParticipant,
  PalletPhaseDurations,
  PalletPlayerRow,
  ReportVote,
} from "@jollity/protocol"
import {
  fromPapi,
  readCommunicationIdentifier,
  readGroupMembers,
  readPlayerIndices,
  reportTx,
  claimPrizeTx,
  toCurrentGame,
  watchCurrentGame,
  watchPlayer as watchPlayerRecord,
  withScoreParticipant,
  type CurrentGame,
  type PlayerKey,
} from "@parity/product-sdk-individuality"
import { abortError, submitToBestBlock } from "@individuality/people-chain"
import { signUpFlowChain } from "@individuality/sign-up/chain"
import { claimEligibility, fetchPrizeBalances } from "@individuality/prize/chain"
import type { PeopleApi, PeopleClient } from "./chain/client"
import { fetchAirdropDraws } from "./chain/airdrop"

// next-people-paseo defaults — the fallback when neither storage nor the
// constant can be read (a dev node mid-restart)
const FALLBACK_PHASES: PalletPhaseDurations = {
  registration: 300,
  shuffle: 60,
  post_shuffle_margin: 30,
}

const FRESH_FOLLOW_TIMEOUT_MS = 15_000

const accountKey = (address: string): PlayerKey => Enum("Account", address)

type RawPlayerRow = NonNullable<Awaited<ReturnType<PeopleApi["query"]["Game"]["Players"]["getValue"]>>>

/** `Game.Players` with the votes, as protocol carries it. The SDK's player
 *  read and watch keep `registered` alone, so this maps the storage row. */
function toPlayerRow(raw: RawPlayerRow): PalletPlayerRow {
  const enacted = raw.early_attendance_enactment
  return {
    registered: raw.registered,
    sent_report: raw.sent_report,
    vote_weight: raw.vote_weight,
    yes_person: raw.yes_person,
    no_not_person: raw.no_not_person,
    expected_max_vote_weight: raw.expected_max_vote_weight,
    early_attendance_enactment: enacted ? { attendance: enacted.attendance, disposition: enacted.disposition.type } : null,
  }
}

/**
 * Carries the roster player count as the only state payload.
 *
 * The SDK decodes the state to a phase and the player count of the roster, and
 * `statePlayerCount` reads nothing else from the payload.
 */
function toPalletState({ phase, playerCount }: CurrentGame): PalletGameState {
  if (playerCount !== null) return { type: phase, value: { player_count: playerCount } }
  if (phase === "Reporting") throw new Error("a Reporting game decoded without its player count")
  return { type: phase }
}

function toPalletGame(game: CurrentGame): PalletGame {
  return {
    index: game.index,
    state: toPalletState(game),
    airdrops_scheduled: game.airdropsScheduled,
    registration_ends: game.registrationEnds,
    shuffle_deadline: game.shuffleDeadline,
    game_date: game.gamePlayTime,
    report_ends: game.reportingEnds,
    rounds: game.rounds,
    max_group_size: game.maxGroupSize,
  }
}

/**
 * The engine over `client`. `tld` is the network's DotNS TLD (`"paseo"`): the
 * sign-up, the shared package's over the product SDK's `registerForGame`,
 * names the personhood product and the score context by it.
 */
export function createChainEngine(client: PeopleClient, options: { tld: string }): GameEngine {
  const api = client.api
  const chain = fromPapi(client.client, api)
  // the sign-up's calls: @individuality/sign-up's chain side, which sits on the SDK
  const signUp = signUpFlowChain(client, { tld: options.tld })

  /** `Score.Participants(address)` at the best block, in the protocol's shape */
  const readParticipant = async (address: string): Promise<PalletParticipant | undefined> => {
    const participant = await api.query.Score.Participants.getValue(accountKey(address), { at: "best" })
    if (participant === undefined) return undefined
    return {
      score: participant.score,
      streak: { type: participant.streak.type, count: participant.streak.value },
      attendance_history: participant.attendance_history,
      last_attended_game: participant.last_attended_game ?? null,
      recognition: { type: participant.recognition.type },
      reached_personhood: participant.reached_personhood,
      has_ever_reached_personhood: participant.has_ever_reached_personhood,
    }
  }
  return {
    kind: "chain",

    async now() {
      // the BEST block's timestamp: finalized lags it by two or three blocks
      // (~40 s on a 12 s chain), and that lag is exactly what every countdown
      // in the app would show as "the game starts later than it does". The
      // pallet gates on block time either way; best is simply the freshest
      // reading of the same clock.
      const ms = await api.query.Timestamp.Now.getValue({ at: "best" })
      return Number(ms / 1000n)
    },

    async game() {
      const raw = await api.query.Game.Game.getValue({ at: "finalized" })
      return raw === undefined ? undefined : toPalletGame(toCurrentGame(raw))
    },

    async schedules() {
      const schedules = await api.query.Game.GameSchedules.getValue()
      return schedules.map(({ game_play_time, rounds, max_group_size }) => ({
        game_play_time,
        rounds,
        max_group_size,
      }))
    },

    async phases() {
      // the runtime may carry the durations as storage (set by governance) or
      // fall back to the pallet constant — read in that order, like the app did
      try {
        const game = api.query.Game as unknown as {
          StoredPhaseDurations: { getValue: () => Promise<PalletPhaseDurations | undefined> }
        }
        const stored = await game.StoredPhaseDurations.getValue()
        if (stored) return stored
        const constants = api.constants.Game as unknown as {
          DefaultPhaseDurations: () => Promise<PalletPhaseDurations>
        }
        return await constants.DefaultPhaseDurations()
      } catch {
        return FALLBACK_PHASES
      }
    },

    async player(address) {
      const record = await api.query.Game.Players.getValue(accountKey(address), { at: "best" })
      return record === undefined ? undefined : { registered: record.registered, sent_report: record.sent_report }
    },

    async playerRow(address) {
      const raw = await api.query.Game.Players.getValue(accountKey(address), { at: "best" })
      return raw === undefined ? undefined : toPlayerRow(raw)
    },

    async playerIndices(address) {
      const result = await readPlayerIndices(chain, { player: accountKey(address) })
      if (!result.ok) throw result.error
      return result.value.indices ?? undefined
    },

    async groupMembers(round, ownIndex, playerCount, maxGroupSize) {
      const result = await readGroupMembers(chain, { round, ownIndex, playerCount, maxGroupSize })
      if (!result.ok) throw result.error
      return result.value.members
    },

    async communicationIdentifier(address) {
      const result = await readCommunicationIdentifier(chain, { account: address })
      if (!result.ok) throw result.error
      return result.value.identifier
    },

    participant(address): Promise<PalletParticipant | undefined> {
      // Read at BEST: callers run this right after `watchGame` (also at best)
      // reports a settled game, and the finalized row can still hold the previous result.
      return readParticipant(address)
    },

    async reportStanding(address) {
      // ONE block for the three reads. `game()` reads at finalized and the row
      // at best, and across the transition to PlayerProcess the two disagree:
      // finalized still says Reporting while step 1 has already archived or
      // reset the best block's row (found by a model check, #596).
      const blocks = await client.client.getBestBlocks()
      const best = blocks[0]
      if (!best) throw new Error("no best block to read the report's standing at")
      const key = accountKey(address)
      const row = (record: { registered: boolean; sent_report: boolean } | undefined) =>
        record === undefined ? undefined : { registered: record.registered, sent_report: record.sent_report }
      const [raw, record, participant] = await Promise.all([
        api.query.Game.Game.getValue({ at: best.hash }),
        api.query.Game.Players.getValue(key, { at: best.hash }),
        api.query.Score.Participants.getValue(key, { at: best.hash }),
      ])
      const game = raw === undefined ? undefined : toPalletGame(toCurrentGame(raw))
      const standing = { game, player: row(record), lastAttendedGame: participant?.last_attended_game ?? null }
      // Step 1 took sent_report with the row. The last block still in
      // Reporting holds it final; the best chain down to the finalized block
      // is pinned, so look there, newest first, and nowhere older. A read an
      // older block refuses leaves the standing without it: attendance is the
      // fallback, and the best block's reads above still stand.
      if (game?.state.type !== "PlayerProcess" || record?.registered === true) return standing
      try {
        for (const block of blocks.slice(1)) {
          const earlier = await api.query.Game.Game.getValue({ at: block.hash })
          if (earlier === undefined || earlier.index !== game.index) break
          const phase = toPalletGame(toCurrentGame(earlier)).state.type
          if (phase === "PlayerProcess") continue
          if (phase !== "Reporting") break
          return { ...standing, reportingRow: row(await api.query.Game.Players.getValue(key, { at: block.hash })) ?? null }
        }
      } catch {
        // an older block no longer served: no final row, attendance decides
      }
      return standing
    },

    personhoodThreshold(): Promise<number> {
      return api.query.Score.PersonhoodThreshold.getValue({ at: "best" })
    },

    async draws(address, gameIndex): Promise<PalletDraw[]> {
      const draws = await fetchAirdropDraws(client, { gameIndex, player: address })
      return draws.map((draw) => ({
        airdropIndex: draw.airdropIndex,
        status: draw.status,
        prize:
          draw.prize === null
            ? null
            : {
                assetAmount: draw.prize.assetAmount.toString(),
                decimals: draw.prize.asset?.decimals ?? 0,
                ...(draw.prize.asset ? { symbol: draw.prize.asset.symbol } : {}),
              },
        drawTime: draw.drawTime,
        ticket: draw.ticket,
        winningTickets: draw.winningTickets,
        totalEntries: draw.totalEntries,
        won: draw.won,
        claimed: draw.claimed,
        tickets: draw.tickets,
        target: draw.target,
        holders: draw.holders,
        effectiveWinners: draw.effectiveWinners,
      }))
    },

    async prizeBalances(address): Promise<PalletPrizeBalance[]> {
      const balances = await fetchPrizeBalances(client, address)
      return balances.map(({ assetKey, amount }) => ({ assetKey, amount: amount.toString() }))
    },

    async eligibility(address, gameIndex): Promise<PalletEligibility> {
      const result = await claimEligibility(api, { gameIndex, player: address })
      return { eligible: result.eligible, reason: result.reason }
    },

    seat: signUp.seat,
    holdsLiteKey: signUp.holdsLiteKey,
    bind: signUp.bind,
    register: signUp.register,

    async probeChainHealth(signer: EngineSigner) {
      // `create` builds the transaction and invokes the signer, but does not
      // submit it. The report uses this same ScoreAsParticipant-wrapped
      // product signer, whose host implementation calls
      // truApi.signing.createTransaction and therefore at_current_block().
      // Product-account transaction builds are silent (the sign-up and report
      // already use this path without a confirmation prompt).
      await api.tx.System.remark({ remark: new Uint8Array() }).create(
        withScoreParticipant(signer),
      )
    },

    async waitUntilFollowing(failedBlockHash, signal) {
      if (signal?.aborted) throw abortError(signal)
      return new Promise<boolean>((resolve, reject) => {
        const subscriptionRef: { unsubscribe?: () => void } = {}
        let settled = false
        let baseline = failedBlockHash
        const timeout = setTimeout(() => finish(false), FRESH_FOLLOW_TIMEOUT_MS)
        const finish = (fresh: boolean, error?: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          signal?.removeEventListener("abort", onAbort)
          subscriptionRef.unsubscribe?.()
          if (error !== undefined) reject(error)
          else resolve(fresh)
        }
        const onAbort = () => finish(false, abortError(signal!))
        signal?.addEventListener("abort", onAbort, { once: true })
        const subscription = client.client.bestBlocks$.subscribe({
          next: (blocks) => {
            const hash = blocks[0]?.hash
            if (!hash) return
            // papi's stateful stream synchronously replays its last block.
            // That is the dropped pin (or our baseline when an older error did
            // not name it), so only a later best block releases the retry.
            if (baseline === undefined) {
              baseline = hash
              return
            }
            if (hash !== baseline) finish(true)
          },
          error: (error) => finish(false, error),
        })
        subscriptionRef.unsubscribe = () => subscription.unsubscribe()
        if (settled) subscriptionRef.unsubscribe()
      })
    },

    async report(signer: EngineSigner, _player: string, fullReport: ReportVote[][], signal?: AbortSignal) {
      // `withScoreParticipant` rides the ScoreAsParticipant extension (fee-free
      // for a signed-up player) and sets RestrictOrigins; it leaves the host to
      // fill the account signature. No forced VerifyMultiSignature.
      //
      // RESOLVE AT THE BEST BLOCK, NOT AT FINALITY. The player sits on
      // "Submitting..." until this resolves, and finality on the People chain
      // trails the best block by ~20 s. Every read the collectables then makes
      // (`watchGame`, the credits, the score row) is at the best block too,
      // so waiting for finality bought nothing but the pause.
      return submitToBestBlock(reportTx(chain, { fullReport }).createSubmitAndWatch(withScoreParticipant(signer)), signal)
    },

    async claimPrize(signer: EngineSigner, gameIndex: number, airdropIndex: number, beneficiary: string) {
      // the same origin as the report: the pallet takes a participant
      // (`ensure_signed_or_participant_or_person`), so the claim rides
      // ScoreAsParticipant and costs a free-signed-up account nothing. A
      // REFUSED claim would pay a fee, which is why the recap only offers the
      // button once every gate it can read is open.
      return submitToBestBlock(
        claimPrizeTx(chain, { gameIndex, airdropIndex, beneficiary }).createSubmitAndWatch(withScoreParticipant(signer)),
      )
    },

    watchGame(cb, onError) {
      return watchCurrentGame(
        chain,
        (game) => cb(game === null ? undefined : toPalletGame(game)),
        (error) => onError?.(error),
      )
    },

    // best, not finalized, for the same reason as `now()`: finalized trails
    // by two or three blocks, and every countdown would show that lag
    watchNow(cb, onError) {
      const subscription = api.query.Timestamp.Now.watchValue({ at: "best" }).subscribe({
        next: ({ value, block }) => cb(Number(value / 1000n), block.number),
        error: (error) => onError?.(error),
      })
      return () => subscription.unsubscribe()
    },

    watchPlayer(address, cb, onError) {
      return watchPlayerRecord(
        chain,
        { player: accountKey(address) },
        (record) => cb(record ?? undefined),
        (error) => onError?.(error),
      )
    },

    // PAPI emits once per best block whether or not the row moved, so a row
    // goes out only when it differs from the last one
    watchPlayerRow(address, cb, onError) {
      let last: string | undefined
      const subscription = api.query.Game.Players.watchValue(accountKey(address), { at: "best" }).subscribe({
        next: ({ value }) => {
          let row: PalletPlayerRow | undefined
          try {
            row = value === undefined ? undefined : toPlayerRow(value)
          } catch (error) {
            onError?.(error)
            return
          }
          const seen = JSON.stringify(row ?? null)
          if (seen === last) return
          last = seen
          cb(row)
        },
        error: (error) => onError?.(error),
      })
      return () => subscription.unsubscribe()
    },

    /** `System.Account` is not individuality, so the SDK has no watch for it. */
    watchFreeBalance(address, cb, onError) {
      const subscription = api.query.System.Account.watchValue(address, { at: "best" }).subscribe({
        next: ({ value }) => cb(value.data.free.toString()),
        error: (error) => onError?.(error),
      })
      return () => subscription.unsubscribe()
    },

    destroy() {
      client.client.destroy()
    },
  }
}
