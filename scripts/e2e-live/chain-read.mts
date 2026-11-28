// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The live journey's chain READS, as a small CLI the Playwright spec shells
 * out to (so the test runner never loads polkadot-api), printing one JSON
 * document on stdout. Every assertion over what it returns is a pure function
 * in chain-checks.ts. STRICTLY READ-ONLY: storage queries and event watches.
 *
 *   npx tsx scripts/e2e-live/chain-read.mts state
 *   npx tsx scripts/e2e-live/chain-read.mts players <ss58>…            # Game.Players at finalized
 *   npx tsx scripts/e2e-live/chain-read.mts group-overlap --game <n> --accounts sender,viewer
 *   npx tsx scripts/e2e-live/chain-read.mts group-peers --game <n> --accounts player
 *   npx tsx scripts/e2e-live/chain-read.mts watch --game <n> --accounts a,b,c --deadline <chain s> [--margin <s>]
 *   npx tsx scripts/e2e-live/chain-read.mts results --game <n> --rounds <r> --accounts a,b,c
 *   npx tsx scripts/e2e-live/chain-read.mts votes --game <n> [--accounts a,b,c] [--blocks n1,n2]
 *
 * `watch` follows FINALIZED blocks for Game.ReportSubmitted and Game.GameEnded
 * and returns once every account reported and the game settled, or at the
 * deadline (chain seconds; report_ends plus a margin), whichever is first.
 * `results` is scripts/game-results.mts's logic against the chosen network: each
 * account's Score.Participants row and the collectables it was awarded in
 * this game.
 *
 * Env: E2E_NETWORK (previewnet default, or paseo-next-v2: the People RPC comes from host-slot.mjs NETWORKS), PEOPLE_WS overrides it.
 */
import { Enum } from "polkadot-api"
import { compact, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings"
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders"
import { creditHash, groupSeats } from "@parity/product-sdk-individuality"
import { getClaims } from "@parity/product-sdk-nfts"
import { createPeopleClient } from "@jollity/game-chain"
import { scriptClaimsChain } from "../lib/claims-chain.mts"
import { NETWORKS, networkFromEnv } from "../lib/host-slot.mjs"
import { retryRead } from "./read-retry"
import { chainReadChildTimeoutMs, medianObservedBlockMs, withChainReadTimeout } from "./chain-read-runtime"
import { checkReports, checkSettled, type ChainReader, type FiledReport, type PlayerRecord, type ReportEvent } from "./chain-checks"
import { gameGroupPeers, sharedGamePeers, sharedGroupRounds } from "./role-groups"
import { decodeReportCalls } from "../game-chain-report.mts"

const WS = process.env.PEOPLE_WS || NETWORKS[networkFromEnv() as keyof typeof NETWORKS].peopleWs
const people = createPeopleClient(WS)
const { client, api } = people
const accountKey = (address: string) => Enum("Account", address)
const json = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)

/** ChainReader over Game.Players at the finalized block. */
export const finalizedReader = (at: string): ChainReader => ({
  async player(account) {
    const rec = await api.query.Game.Players.getValue(accountKey(account), { at })
    return rec ? ({ first_game: rec.first_game, registered: rec.registered, sent_report: rec.sent_report } satisfies PlayerRecord) : undefined
  },
})

async function readState() {
  const bestHash = await client._request<string, []>("chain_getBlockHash", [])
  const bestHeader = await client._request<{ parentHash: string }, [string]>("chain_getHeader", [bestHash])
  const [game, schedules, nowMs, timing, stored, defaults] = await Promise.all([
    api.query.Game.Game.getValue(),
    api.query.Game.GameSchedules.getValue(),
    api.query.Timestamp.Now.getValue(),
    readBestTiming(bestHash, bestHeader.parentHash),
    api.query.Game.StoredPhaseDurations.getValue(),
    api.constants.Game.DefaultPhaseDurations(),
  ])
  return {
    chainNow: Number(nowMs / 1000n),
    /** Timestamp.Now at the BEST block. polkadot-api defaults a storage query to the FINALIZED block, so chainNow lags the
     *  real chain clock by the finality delay (~44 s in game 287): a return time anchored on it fires that late. Only the
     *  late return (journey.pw.ts bestClockOf) reads this; chainNow stays as the other roles were tuned against it. */
    chainBestNow: timing?.chainBestNow ?? null,
    /** Measured from consecutive best blocks for latency assertions. */
    chainBlockMs: timing?.chainBlockMs ?? null,
    /** the reporting phase's length (StoredPhaseDurations, else the constant), for timing.ts reportEndsFor */
    reportingS: (stored ?? defaults).reporting,
    game: game
      ? {
          index: game.index,
          state: game.state.type,
          registrationEnds: game.registration_ends,
          gameAt: game.game_date,
          reportEnds: game.report_ends,
          rounds: game.rounds,
          maxGroupSize: game.max_group_size,
        }
      : null,
    schedules: schedules.map((s) => s.game_play_time),
  }
}

// ── votes: past blocks over the raw RPC ────────────────────────────────────
const rpc = <T,>(method: string, params: unknown[]) => client._request<T, unknown[]>(method, params)
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"))
type Dyn = ReturnType<typeof getDynamicBuilder>
const metas = new Map<number, { metadata: Uint8Array; dyn: Dyn }>()
/** v16 metadata at a block, cached per spec version. */
async function metaAt(hash: string) {
  const { specVersion } = await rpc<{ specVersion: number }>("state_getRuntimeVersion", [hash])
  let m = metas.get(specVersion)
  if (!m) {
    // Option<OpaqueMetadata>: a Some byte, a compact length, the metadata
    const raw = bytes(await rpc<string>("state_call", ["Metadata_metadata_at_version", "0x10000000", hash]))
    if (raw[0] !== 1) throw new Error(`no v16 metadata at ${hash}`)
    const len = compact.dec(raw.slice(1))
    const metadata = raw.slice(1 + compact.enc(len).length)
    m = { metadata, dyn: getDynamicBuilder(getLookupFn(unifyMetadata(decAnyMetadata(metadata)))) }
    metas.set(specVersion, m)
  }
  return m
}
async function storageAt<T>(dyn: Dyn, pallet: string, entry: string, hash: string, ...keys: unknown[]): Promise<T | undefined> {
  const s = dyn.buildStorage(pallet, entry)
  const raw = await rpc<string | null>("state_getStorage", [s.keys.enc(...keys), hash])
  return raw == null ? undefined : (s.value.dec(raw) as T)
}

async function readBestTiming(bestHash: string, parentHash: string): Promise<{ chainBestNow: number; chainBlockMs: number } | null> {
  const hashes = [bestHash, parentHash]
  while (hashes.length < 7) {
    const header = await rpc<{ parentHash: string }>("chain_getHeader", [hashes.at(-1)!]).catch(() => null)
    if (!header?.parentHash) break
    hashes.push(header.parentHash)
  }
  const observations = await Promise.all(hashes.map(async (hash) => {
    try {
      const { dyn } = await metaAt(hash)
      const value = await storageAt<bigint>(dyn, "Timestamp", "Now", hash)
      return value === undefined ? Number.NaN : Number(value)
    } catch {
      return Number.NaN
    }
  }))
  const chainBestNow = observations[0]
  const deltas = observations.slice(0, -1).map((value, index) => value - observations[index + 1])
  const chainBlockMs = medianObservedBlockMs(deltas)
  return Number.isFinite(chainBestNow) && chainBlockMs !== null ? { chainBestNow: chainBestNow / 1000, chainBlockMs } : null
}
interface RawEvent {
  phase: { type: string; value?: number }
  event: { type: string; value: { type: string; value: Record<string, unknown> } }
}
const blockHash = (n: number) => rpc<string>("chain_getBlockHash", [n])
const nowAt = async (n: number) => {
  const hash = await blockHash(n)
  return Number((await storageAt<bigint>((await metaAt(hash)).dyn, "Timestamp", "Now", hash)) ?? 0n) / 1000
}

/** Every ReportSubmitted of this game: by --blocks, else by a scan from the
 *  game's start (Game.GameHistory) to its GameEnded. */
async function reportBlocks(gameIndex: number, hint: number[]): Promise<{ block: number; who: { type: string; value: string }; extrinsic: number }[]> {
  const found: { block: number; who: { type: string; value: string }; extrinsic: number }[] = []
  const scan = async (n: number) => {
    const hash = await blockHash(n)
    const { dyn } = await metaAt(hash)
    const events = (await storageAt<RawEvent[]>(dyn, "System", "Events", hash)) ?? []
    let ended = false
    for (const e of events) {
      if (e.event.type !== "Game") continue
      const p = e.event.value.value
      if (e.event.value.type === "ReportSubmitted" && p.game_index === gameIndex && e.phase.type === "ApplyExtrinsic") {
        const who = p.who as { type: string; value: unknown }
        found.push({ block: n, who: { type: who.type, value: String(who.value) }, extrinsic: e.phase.value as number })
      }
      if (e.event.value.type === "GameEnded" && p.index === gameIndex) ended = true
    }
    return ended
  }
  if (hint.length) {
    for (const n of [...new Set(hint)]) await scan(n)
    return found
  }
  const head = (await client.getFinalizedBlock()).number
  const startS = await storageAt<number>((await metaAt(await blockHash(head))).dyn, "Game", "GameHistory", await blockHash(head), gameIndex)
  if (startS === undefined) throw new Error(`Game.GameHistory has no game ${gameIndex}`)
  // the last block before the game started, by binary search on Timestamp.Now
  let lo = 1
  let hi = head
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    if ((await nowAt(mid)) <= startS) lo = mid
    else hi = mid - 1
  }
  process.stderr.write(`game ${gameIndex} started at ${startS}, block #${lo}; scanning for its reports\n`)
  for (let n = lo; n <= Math.min(head, lo + 600); n++) if (await scan(n)) return found
  throw new Error(`no GameEnded for game ${gameIndex} within 600 blocks of #${lo} (found ${found.length} report(s))`)
}

async function readVotes(gameIndex: number, only: string[], hint: number[]) {
  const events = (await reportBlocks(gameIndex, hint)).filter((e) => !only.length || only.includes(e.who.value))
  const reports: FiledReport[] = []
  const errors: { who: string; block: number; error: string }[] = []
  for (const ev of events) {
    try {
      const hash = await blockHash(ev.block)
      const { metadata, dyn } = await metaAt(hash)
      const body = (await rpc<{ block: { extrinsics: string[] } }>("chain_getBlock", [hash])).block.extrinsics.map(bytes)
      const fullReport = (await decodeReportCalls(body, metadata, [ev.extrinsic])).get(ev.extrinsic)
      if (typeof fullReport !== "object") throw new Error(fullReport ?? `extrinsic ${ev.extrinsic} is not in block #${ev.block}`)
      // the roster as it stood before the report (a report never changes it)
      const parent = (await rpc<{ parentHash: string }>("chain_getHeader", [hash])).parentHash
      const game = await storageAt<{ index: number; max_group_size: number; rounds: number; state: { value?: { player_count?: number; step?: { value?: { player_count?: number } } } } }>(dyn, "Game", "Game", parent)
      const playerCount = game?.state.value?.player_count ?? game?.state.value?.step?.value?.player_count
      if (!game || game.index !== gameIndex || playerCount === undefined) throw new Error(`Game.Game at the parent of #${ev.block} is not game ${gameIndex} with a roster`)
      const who = { type: ev.who.type, value: ev.who.value }
      const indices = (await storageAt<number[]>(dyn, "Game", "PlayerToIndex", parent, who)) ?? []
      const rounds = []
      for (const [round, ownIndex] of indices.slice(0, game.rounds).entries()) {
        const seats = groupSeats(ownIndex, playerCount, game.max_group_size).filter((s) => s.occupied)
        const members = []
        for (const { index } of seats) {
          const p = await storageAt<{ type: string; value: unknown }>(dyn, "Game", "IndexToPlayer", parent, [round, index])
          if (!p) throw new Error(`Game.IndexToPlayer has no player at round ${round} index ${index}`)
          members.push({ index, player: String(p.value) })
        }
        rounds.push({ ownIndex, members })
      }
      reports.push({ who: ev.who.value, block: ev.block, extrinsic: ev.extrinsic, maxGroupSize: game.max_group_size, rounds, fullReport })
    } catch (error) {
      errors.push({ who: ev.who.value, block: ev.block, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { gameIndex, reports, errors }
}

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const accountsFlag = () => (flag("--accounts") ?? "").split(",").filter(Boolean)

async function main(): Promise<unknown> {
  if (cmd === "loader-smoke") {
    return { sharedRounds: sharedGroupRounds([1, 1], [3, 2], 7, 6, 2, groupSeats) }
  }
  if (cmd === "state") return readState()

  if (cmd === "players") {
    const finalized = await client.getFinalizedBlock()
    const reader = finalizedReader(finalized.hash)
    const list = args.slice(1)
    const players: Record<string, PlayerRecord | null> = {}
    for (const a of list) players[a] = (await reader.player(a)) ?? null
    return { finalized: finalized.number, players }
  }

  if (cmd === "group-overlap") {
    const gameIndex = Number(flag("--game"))
    const accounts = accountsFlag()
    if (!Number.isInteger(gameIndex) || gameIndex < 0 || accounts.length !== 2 || accounts[0] === accounts[1])
      throw new Error("group-overlap needs --game <non-negative index> and --accounts <sender,viewer>")
    const finalized = await client.getFinalizedBlock()
    const game = await api.query.Game.Game.getValue({ at: finalized.hash })
    const state = game?.state as unknown as { value?: { player_count?: number; step?: { value?: { player_count?: number } } } } | undefined
    const playerCount = state?.value?.player_count ?? state?.value?.step?.value?.player_count
    if (!game || game.index !== gameIndex || playerCount === undefined) throw new Error(`finalized Game.Game is not game ${gameIndex} with a roster`)
    const indices = await Promise.all(accounts.map((account) => api.query.Game.PlayerToIndex.getValue(accountKey(account), { at: finalized.hash })))
    if (indices.some((entry) => !entry)) throw new Error(`one of ${accounts.join(",")} has no finalized Game.PlayerToIndex`)
    const own = indices[0] as number[]
    const peer = indices[1] as number[]
    return {
      gameIndex,
      finalized: finalized.number,
      playerCount,
      maxGroupSize: game.max_group_size,
      rounds: game.rounds,
      accounts,
      indices,
      sharedRounds: sharedGroupRounds(own, peer, playerCount, game.max_group_size, game.rounds, groupSeats),
    }
  }

  if (cmd === "group-peers") {
    const gameIndex = Number(flag("--game"))
    const accounts = accountsFlag()
    if (!Number.isInteger(gameIndex) || gameIndex < 0 || accounts.length !== 1)
      throw new Error("group-peers needs --game <non-negative index> and --accounts <player>")
    // This command runs at the handover boundary. Read BEST so the roster
    // created when Registration closed is available without another finality
    // delay; the group is already fixed before the app opens its mesh.
    const at = await client._request<string, []>("chain_getBlockHash", [])
    const game = await api.query.Game.Game.getValue({ at })
    const state = game?.state as unknown as { value?: { player_count?: number; step?: { value?: { player_count?: number } } } } | undefined
    const playerCount = state?.value?.player_count ?? state?.value?.step?.value?.player_count
    if (!game || game.index !== gameIndex || playerCount === undefined) throw new Error(`best Game.Game is not game ${gameIndex} with a roster`)
    const indices = await api.query.Game.PlayerToIndex.getValue(accountKey(accounts[0]), { at })
    if (!indices || indices.length < game.rounds) throw new Error(`${accounts[0]} has no complete Game.PlayerToIndex at best`)
    const rounds: string[][] = []
    for (const [round, ownIndex] of indices.slice(0, game.rounds).entries()) {
      const seats = groupSeats(ownIndex, playerCount, game.max_group_size).filter((seat) => seat.occupied)
      const players = await api.query.Game.IndexToPlayer.getValues(
        seats.map(({ index }) => [[round, index]]),
        { at },
      )
      if (players.some((player) => !player)) throw new Error(`Game.IndexToPlayer has an empty occupied seat in round ${round}`)
      rounds.push(players.map((player) => String(player!.value)))
    }
    return {
      gameIndex,
      at,
      playerCount,
      maxGroupSize: game.max_group_size,
      rounds,
      roundPeers: rounds.map((round) => gameGroupPeers(round, accounts[0])),
      peers: sharedGamePeers(rounds, accounts[0]),
    }
  }

  if (cmd === "watch") {
    const gameIndex = Number(flag("--game"))
    let deadline = Number(flag("--deadline"))
    // --margin: also follow the live report_ends (+ margin), never shrinking
    const margin = flag("--margin") !== undefined ? Number(flag("--margin")) : null
    const accounts = accountsFlag()
    if (!Number.isFinite(gameIndex) || !Number.isFinite(deadline)) throw new Error("watch needs --game and --deadline")
    const reports: ReportEvent[] = []
    const ended: number[] = []
    const clockSamples: { readStartMs: number; readEndMs: number; chainBestNow: number | null }[] = []
    let endedAt: Promise<{ block: number; atS: number | null; reportEnds: number | null }> | null = null
    const subs = [
      api.event.Game.ReportSubmitted.watch().subscribe(({ block, events }) => {
        for (const e of events) {
          const r = { who: { type: e.payload.who.type, value: String(e.payload.who.value) }, game_index: e.payload.game_index, block: block.number }
          reports.push(r)
          process.stderr.write(`EVENT ReportSubmitted #${block.number} ${JSON.stringify(r)}\n`)
        }
      }),
      api.event.Game.GameEnded.watch().subscribe(({ block, events }) => {
        for (const e of events) {
          ended.push(e.payload.index)
          process.stderr.write(`EVENT GameEnded #${block.number} index ${e.payload.index}\n`)
          // WHEN it ended, on the chain's own clock, against the report_ends the game held in the block before: an end
          // before it is the pallet's early close (early-close.ts). The parent's value, not the one read at the start,
          // because testnet_force_end_reporting rewrites report_ends to its own block's time
          if (e.payload.index === gameIndex) {
            const read = <T,>(q: () => Promise<T>) => retryRead(q, { tries: 5, waitMs: 3000 }).catch(() => null)
            endedAt = Promise.all([read(() => api.query.Timestamp.Now.getValue({ at: block.hash })), read(() => api.query.Game.Game.getValue({ at: block.parent }))]).then(([ms, before]) => ({
              block: block.number,
              atS: ms === null ? null : Math.floor(Number(ms) / 1000),
              reportEnds: before?.index === gameIndex ? before.report_ends : null,
            }))
          }
        }
      }),
    ]
    try {
      for (;;) {
        // rides through a brief outage of the chain endpoint (the chain-outage profile): 12 tries, 6 s apart, before giving up
        let readStartMs = 0
        let readEndMs = 0
        const state = await retryRead(
          async () => {
            const attemptStartMs = Date.now()
            const value = await readState()
            readStartMs = attemptStartMs
            readEndMs = Date.now()
            return value
          },
          { tries: 12, waitMs: 6000, onRetry: (e, n) => process.stderr.write(`watch: chain read failed (${String(e).slice(0, 120)}), retry ${n}\n`) },
        )
        const sample = { readStartMs, readEndMs, chainBestNow: state.chainBestNow }
        clockSamples.push(sample)
        process.stderr.write(`CLOCK ${JSON.stringify(sample)}\n`)
        if (margin !== null && state.game?.index === gameIndex) deadline = Math.max(deadline, state.game.reportEnds + margin)
        const reportChecks = checkReports(reports, gameIndex, accounts)
        const settled = checkSettled(state.game ?? undefined, gameIndex, ended)
        // a GameEnded for this game shuts the window for good (it can come before report_ends, early-close.ts): no report can
        // land after it, so the watch is over even with a report missing
        const done = (reportChecks.every((c) => c.status === "pass") || ended.includes(gameIndex)) && settled.status === "pass"
        if (done || state.chainNow >= deadline) {
          // a report filed before the watch started still shows as sent_report
          const finalized = await client.getFinalizedBlock()
          const reader = finalizedReader(finalized.hash)
          const records: Record<string, PlayerRecord | null> = {}
          for (const a of accounts) records[a] = (await reader.player(a)) ?? null
          return { gameIndex, timedOut: !done, chainNow: state.chainNow, deadline, reports, ended, endedAt: await endedAt, reportChecks, settled, records, clockSamples }
        }
        await new Promise((r) => setTimeout(r, 6000))
      }
    } finally {
      for (const s of subs) s.unsubscribe()
    }
  }

  if (cmd === "results") {
    const gameIndex = Number(flag("--game"))
    const rounds = Number(flag("--rounds") ?? 2)
    const accounts = accountsFlag()
    const { chain, close } = scriptClaimsChain(people, WS)
    try {
      const out = []
      for (const address of accounts) {
        const key = accountKey(address)
        const participant = await api.query.Score.Participants.getValue(key)
        const read = await getClaims(chain, { claimant: { tag: "Account", address } })
        if (!read.ok) throw read.error
        // our own co-players as attesters, for an award whose game index is gone
        const candidates = new Set<string>()
        for (let round = 0; round < rounds; round++)
          for (const other of accounts)
            if (other !== address) candidates.add(creditHash({ gameIndex, round, attester: accountKey(other), attestee: key }))
        const won = read.value.claims.filter((c) => c.gameIndex === gameIndex || (c.hash !== null && candidates.has(c.hash)))
        out.push({
          address,
          score: participant?.score ?? null,
          streak: participant ? `${participant.streak.type}(${participant.streak.value})` : null,
          lastGame: participant?.last_attended_game ?? null,
          collectables: won.map((c) => ({ hash: c.hash, state: c.state })),
        })
      }
      return { gameIndex, players: out }
    } finally {
      close()
    }
  }

  if (cmd === "votes") {
    const gameIndex = Number(flag("--game"))
    if (!Number.isFinite(gameIndex)) throw new Error("votes needs --game")
    const only = accountsFlag()
    const blocks = (flag("--blocks") ?? "").split(",").filter(Boolean).map(Number)
    return readVotes(gameIndex, only, blocks)
  }

  throw new Error(`unknown command "${cmd ?? ""}": loader-smoke | state | players | group-overlap | group-peers | watch | results | votes`)
}

const childTimeoutMs = chainReadChildTimeoutMs(cmd ?? "unknown")
const work = main()
const guarded = childTimeoutMs === null ? work : withChainReadTimeout(work, { command: cmd ?? "unknown", endpoint: WS, timeoutMs: childTimeoutMs })

guarded.then(
  (value) => {
    console.log(json(value))
    client.destroy()
    process.exit(0)
  },
  (err) => {
    console.error(`chain-read failed: ${err instanceof Error ? err.message : String(err)}`)
    client.destroy()
    process.exit(1)
  },
)
