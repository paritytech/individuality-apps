// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest"
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"
import { statePlayerCount } from "@jollity/protocol"
import { GAME_AIRDROP_EVENT_ID_BASE, withScoreParticipant } from "@parity/product-sdk-individuality"
import type { PeopleClient } from "./chain/client"
import { signUpFlowChain } from "@individuality/sign-up/chain"
import { createChainEngine } from "./engine"

// the sign-up is the shared package's: spied on, to see the engine hands it on
vi.mock("@individuality/sign-up/chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@individuality/sign-up/chain")>()
  return { ...actual, signUpFlowChain: vi.fn(actual.signUpFlowChain) }
})
vi.mock("@parity/product-sdk-individuality", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@parity/product-sdk-individuality")>()),
  withScoreParticipant: vi.fn((signer: CommonSignerTxCreator) => signer),
}))

/** A papi DispatchError as the chain returns it: Module → pallet → variant. */
const moduleError = (pallet: string, variant: string) => ({
  type: "Module",
  value: { type: pallet, value: { type: variant, value: undefined } },
})

function fakeClient(overrides: Record<string, unknown> = {}): PeopleClient {
  const api = {
    query: {
      Timestamp: {
        Now: {
          getValue: vi.fn().mockResolvedValue(1_700_000_000_500n),
          watchValue: () => watchEmitting({ value: 1_700_000_000_500n, block: { number: 4242 } }),
        },
      },
      Game: {
        Game: {
          getValue: vi.fn().mockResolvedValue({
            index: 7,
            registration_ends: 100,
            shuffle_deadline: 150,
            game_date: 200,
            report_ends: 900,
            state: { type: "Reporting", value: { player_count: 4 } },
            max_group_size: 6,
            rounds: 2,
            pending_attendance: 0,
            airdrops_scheduled: 1,
          }),
        },
        Players: { getValue: vi.fn().mockResolvedValue({ registered: true, extra: "ignored" }) },
        // nobody's free seat is pinned unless a test says so
        LiteInvites: { getValue: vi.fn().mockResolvedValue(undefined) },
      },
      // every draw is taking entries unless a test says otherwise
      Airdrop: { Events: { getValue: vi.fn().mockResolvedValue(REGISTERING) } },
      Score: {
        Participants: {
          getValue: vi.fn().mockResolvedValue({
            score: 6,
            streak: { type: "Attended", value: 3 },
            attendance_history: 0xff,
            credit: 0n,
            cashed_out: false,
            reached_personhood: false,
            has_ever_reached_personhood: false,
            recognition: { type: "Recognized", value: 3n },
            // Option::None on chain
            last_attended_game: undefined,
          }),
        },
        PersonhoodThreshold: { getValue: vi.fn().mockResolvedValue(21) },
      },
    },
    tx: {
      System: {
        remark: vi.fn().mockReturnValue({ create: vi.fn().mockResolvedValue(new Uint8Array([1])) }),
      },
      Game: {
        sign_up_with_account: vi.fn().mockReturnValue({
          createAndSubmit: vi
            .fn()
            .mockResolvedValue({ ok: false, dispatchError: moduleError("Game", "AlreadyRegistered") }),
          // register() watches the lifecycle: emit a finalized-failed event
          createSubmitAndWatch: vi.fn().mockReturnValue(
            watchEmitting({
              type: "finalized",
              ok: false,
              dispatchError: moduleError("Game", "AlreadyRegistered"),
            }),
          ),
        }),
      },
    },
    constants: { Game: { airdrop_event_id_base: vi.fn().mockResolvedValue(GAME_AIRDROP_EVENT_ID_BASE) } },
    ...overrides,
  }
  return { api, client: { destroy: vi.fn() } } as unknown as PeopleClient
}

/** `Airdrop.Events[id]` while it takes entries */
const REGISTERING = { status: { type: "Registering", value: { total_participants: 0 } } }

/** a fake papi tx observable that emits one lifecycle event on subscribe —
 *  register() subscribes to createSubmitAndWatch and resolves on `finalized`. */
function watchEmitting(event: unknown) {
  return {
    subscribe: (observer: { next: (e: unknown) => void }) => {
      observer.next(event)
      return { unsubscribe: vi.fn() }
    },
  }
}

const signer = Object.assign(vi.fn(), {
  publicKey: new Uint8Array(32).fill(1),
  signBytes: vi.fn(),
}) as unknown as CommonSignerTxCreator

describe("createChainEngine", () => {
  it("signs up through the shared sign-up's chain side, for the network's TLD", () => {
    const client = fakeClient()
    const engine = createChainEngine(client, { tld: "testnet" })
    expect(signUpFlowChain).toHaveBeenCalledWith(client, { tld: "testnet" })
    const shared = vi.mocked(signUpFlowChain).mock.results.at(-1)!.value as ReturnType<typeof signUpFlowChain>
    expect([engine.seat, engine.holdsLiteKey, engine.bind, engine.register]).toEqual([shared.seat, shared.holdsLiteKey, shared.bind, shared.register])
  })

  it("builds but never submits an empty remark through the report signer", async () => {
    const client = fakeClient()
    const engine = createChainEngine(client, { tld: "paseo" })
    await engine.probeChainHealth!(signer)

    expect(client.api.tx.System.remark).toHaveBeenCalledWith({ remark: new Uint8Array() })
    const tx = vi.mocked(client.api.tx.System.remark).mock.results[0]!.value
    expect(tx.create).toHaveBeenCalledWith(signer)
    expect(withScoreParticipant).toHaveBeenCalledWith(signer)
    expect(tx.createAndSubmit).toBeUndefined()
  })

  it("reads the clock in whole seconds", async () => {
    expect(await createChainEngine(fakeClient(), { tld: "paseo" }).now()).toBe(1_700_000_000)
  })

  it("waits for a fresh best-block follow and respects cancellation", async () => {
    const client = fakeClient()
    let current = { hash: "0xdropped", number: 42, parent: "0xparent" }
    let observer: { next: (blocks: typeof current[]) => void } | undefined
    const unsubscribe = vi.fn()
    const bestBlocks$ = {
      subscribe: vi.fn((next: typeof observer) => {
        observer = next
        next!.next([current]) // papi's synchronous replay
        return { unsubscribe }
      }),
    }
    ;(client.client as unknown as { bestBlocks$: typeof bestBlocks$ }).bestBlocks$ = bestBlocks$
    const engine = createChainEngine(client, { tld: "paseo" })
    let settled = false
    const waiting = engine.waitUntilFollowing?.("0xdropped")
    void waiting?.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    observer!.next([current])
    await Promise.resolve()
    expect(settled).toBe(false)
    current = { hash: "0xfresh", number: 43, parent: "0xdropped" }
    observer!.next([current])
    await expect(waiting).resolves.toBe(true)
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    const abort = new AbortController()
    const cancelled = engine.waitUntilFollowing?.("0xfresh", abort.signal)
    abort.abort(new Error("late"))
    await expect(cancelled).rejects.toThrow("late")
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it("bounds a replay-only fresh-follow wait", async () => {
    vi.useFakeTimers()
    try {
      const client = fakeClient()
      const unsubscribe = vi.fn()
      const bestBlocks$ = {
        subscribe: vi.fn((observer: { next: (blocks: unknown[]) => void }) => {
          observer.next([{ hash: "0xdropped", number: 42, parent: "0xparent" }])
          return { unsubscribe }
        }),
      }
      ;(client.client as unknown as { bestBlocks$: typeof bestBlocks$ }).bestBlocks$ = bestBlocks$
      const waiting = createChainEngine(client, { tld: "paseo" }).waitUntilFollowing?.("0xdropped")
      let settled = false
      void waiting?.then(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(14_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(waiting).resolves.toBe(false)
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("watches the best-block clock in whole seconds, with the block it came from", () => {
    const cb = vi.fn()
    createChainEngine(fakeClient(), { tld: "paseo" }).watchNow(cb)
    expect(cb).toHaveBeenCalledWith(1_700_000_000, 4242)
  })

  it("picks the GameInfo fields and keeps a Reporting state as the pallet has it", async () => {
    const client = fakeClient()
    const game = await createChainEngine(client, { tld: "paseo" }).game()
    expect(game).toEqual({
      index: 7,
      state: { type: "Reporting", value: { player_count: 4 } },
      airdrops_scheduled: 1,
      registration_ends: 100,
      shuffle_deadline: 150,
      game_date: 200,
      report_ends: 900,
      rounds: 2,
      max_group_size: 6,
    })
    expect(client.api.query.Game.Game.getValue).toHaveBeenCalledWith({ at: "finalized" })
  })

  it("narrows the player record to registration", async () => {
    const client = fakeClient()
    expect(await createChainEngine(client, { tld: "paseo" }).player("5F...")).toEqual({ registered: true })
    expect(client.api.query.Game.Players.getValue).toHaveBeenCalledWith(
      expect.objectContaining({ type: "Account", value: "5F..." }),
      { at: "best" },
    )
  })

  it("normalizes Score.Participants: Option::None → null, recognition to its tag, streak value → count", async () => {
    const client = fakeClient()
    expect(await createChainEngine(client, { tld: "paseo" }).participant("5F...")).toEqual({
      score: 6,
      streak: { type: "Attended", count: 3 },
      attendance_history: 0xff,
      last_attended_game: null,
      recognition: { type: "Recognized" },
      reached_personhood: false,
      has_ever_reached_personhood: false,
    })
    // at BEST, so the row matches the settled game that `watchGame` (also at best) reported
    expect(client.api.query.Score.Participants.getValue).toHaveBeenCalledWith(
      expect.objectContaining({ type: "Account", value: "5F..." }),
      { at: "best" },
    )
  })

  it("reads Score.PersonhoodThreshold at best block", async () => {
    const client = fakeClient()
    expect(await createChainEngine(client, { tld: "paseo" }).personhoodThreshold()).toBe(21)
    expect(client.api.query.Score.PersonhoodThreshold.getValue).toHaveBeenCalledWith({ at: "best" })
  })

})

describe("report", () => {
  /** a fake tx observable that replays a lifecycle, one event per subscribe tick */
  function watchReplaying(events: unknown[]) {
    return {
      subscribe: (observer: { next: (e: unknown) => void }) => {
        for (const event of events) observer.next(event)
        return { unsubscribe: vi.fn() }
      },
    }
  }
  const reportTx = (watch: unknown) => ({
    tx: { Game: { report: vi.fn().mockReturnValue({ createSubmitAndWatch: vi.fn().mockReturnValue(watch) }) } },
  })

  it("resolves ok at the best block, before finality", async () => {
    // a `finalized` event never comes: the promise must not wait for one
    const client = fakeClient(
      reportTx(watchReplaying([{ type: "broadcasted" }, { type: "inBestBlock", ok: true }])),
    )
    expect(await createChainEngine(client, { tld: "paseo" }).report(signer, "5Alice", [["Person"]])).toEqual({ ok: true })
  })

  it("ignores a best block that dropped the tx", async () => {
    const client = fakeClient(
      reportTx(
        watchReplaying([
          { type: "notInBestBlock" },
          { type: "inBestBlock", ok: true },
        ]),
      ),
    )
    expect(await createChainEngine(client, { tld: "paseo" }).report(signer, "5Alice", [["Person"]])).toEqual({ ok: true })
  })

  it("sends each vote as the pallet enum", async () => {
    // Given
    const report = vi.fn().mockReturnValue({
      createSubmitAndWatch: vi.fn().mockReturnValue(watchReplaying([{ type: "inBestBlock", ok: true }])),
    })
    const client = fakeClient({ tx: { Game: { report } } })

    // When
    await createChainEngine(client, { tld: "paseo" }).report(signer, "5Alice", [["Person", "NotPerson"]])

    // Then
    expect(report).toHaveBeenCalledWith({
      full_report: [[{ type: "Person", value: undefined }, { type: "NotPerson", value: undefined }]],
    })
  })

  it("names the dispatch error when the report fails in a best block", async () => {
    const client = fakeClient(
      reportTx(
        watchReplaying([
          { type: "inBestBlock", ok: false, dispatchError: moduleError("Game", "NoReporting") },
        ]),
      ),
    )
    expect(await createChainEngine(client, { tld: "paseo" }).report(signer, "5Alice", [["Person"]])).toEqual({
      ok: false,
      error: "NoReporting",
    })
  })
})

describe("report: the second report and the deadline", () => {
  it("rejects with the abort reason and drops the watch when the deadline aborts the wait", async () => {
    const unsubscribe = vi.fn()
    const never = { subscribe: () => ({ unsubscribe }) } // a watch that never emits
    const client = fakeClient({
      tx: { Game: { report: vi.fn().mockReturnValue({ createSubmitAndWatch: vi.fn().mockReturnValue(never) }) } },
    })
    const controller = new AbortController()
    const pending = createChainEngine(client, { tld: "paseo" }).report(signer, "5Alice", [["Person"]], controller.signal)
    controller.abort(new Error("deadline"))
    await expect(pending).rejects.toThrow("deadline")
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("rejects at once on a signal that is already aborted", async () => {
    const client = fakeClient({
      tx: { Game: { report: vi.fn().mockReturnValue({ createSubmitAndWatch: vi.fn().mockReturnValue({ subscribe: vi.fn() }) }) } },
    })
    await expect(
      createChainEngine(client, { tld: "paseo" }).report(signer, "5Alice", [["Person"]], AbortSignal.abort(new Error("late"))),
    ).rejects.toThrow("late")
  })

  it("reads sent_report off the player record", async () => {
    const client = fakeClient({
      query: { Game: { Players: { getValue: vi.fn().mockResolvedValue({ registered: true, sent_report: true }) } } },
    })
    expect(await createChainEngine(client, { tld: "paseo" }).player("5Alice")).toEqual({ registered: true, sent_report: true })
  })

  it("reads the report's standing (game, player row, attendance) at ONE best block", async () => {
    const client = fakeClient()
    type Read = { getValue: ReturnType<typeof vi.fn> }
    const query = (client.api as unknown as {
      query: { Game: { Game: Read; Players: Read }; Score: { Participants: Read } }
    }).query
    query.Game.Players.getValue.mockResolvedValue({ registered: true, sent_report: true })
    query.Score.Participants.getValue.mockResolvedValue({
      score: 6,
      streak: { type: "Attended", value: 3 },
      attendance_history: 0xff,
      recognition: { type: "Recognized", value: 3n },
      reached_personhood: false,
      has_ever_reached_personhood: false,
      last_attended_game: 7,
    })
    ;(client as unknown as { client: Record<string, unknown> }).client.getBestBlocks = vi
      .fn()
      .mockResolvedValue([{ hash: "0xbe57", number: 12, parent: "0x0b" }])
    const standing = await createChainEngine(client, { tld: "paseo" }).reportStanding("5Alice")
    expect(standing.game?.index).toBe(7)
    expect(standing.game?.state.type).toBe("Reporting")
    expect(standing.player).toEqual({ registered: true, sent_report: true })
    expect(standing.lastAttendedGame).toBe(7)
    expect(query.Game.Game.getValue).toHaveBeenCalledWith({ at: "0xbe57" })
    expect(query.Game.Players.getValue).toHaveBeenCalledWith(expect.anything(), { at: "0xbe57" })
    expect(query.Score.Participants.getValue).toHaveBeenCalledWith(expect.anything(), { at: "0xbe57" })
  })
})

describe("the report's standing past Reporting (#596)", () => {
  type Read = { getValue: ReturnType<typeof vi.fn> }
  const game = (type: string) => ({
    index: 7,
    registration_ends: 100,
    shuffle_deadline: 150,
    game_date: 200,
    report_ends: 900,
    state: type === "Reporting" ? { type, value: { player_count: 4 } } : { type, value: { type: "Step1ProcessPlayers", value: { player_count: 4 } } },
    max_group_size: 6,
    rounds: 2,
    pending_attendance: 0,
    airdrops_scheduled: 0,
  })
  function processed(states: Record<string, string>, rows: Record<string, unknown>) {
    const client = fakeClient()
    const query = (client.api as unknown as {
      query: { Game: { Game: Read; Players: Read } }
    }).query
    query.Game.Game.getValue.mockImplementation(async ({ at }: { at: string }) => game(states[at]!))
    query.Game.Players.getValue.mockImplementation(async (_key: unknown, { at }: { at: string }) => rows[at])
    ;(client as unknown as { client: Record<string, unknown> }).client.getBestBlocks = vi.fn().mockResolvedValue([
      { hash: "0x3", number: 3, parent: "0x2" },
      { hash: "0x2", number: 2, parent: "0x1" },
      { hash: "0x1", number: 1, parent: "0x0" },
    ])
    return { engine: createChainEngine(client, { tld: "paseo" }), query }
  }

  it("reads the row at the last block still in Reporting once step 1 has archived it", async () => {
    const { engine } = processed(
      { "0x3": "PlayerProcess", "0x2": "PlayerProcess", "0x1": "Reporting" },
      { "0x1": { registered: true, sent_report: true } },
    )
    const standing = await engine.reportStanding("5Alice")
    expect(standing.player).toBeUndefined()
    expect(standing.reportingRow).toEqual({ registered: true, sent_report: true })
  })

  it("falls back to the best block's standing when an older block refuses the read", async () => {
    const { engine, query } = processed(
      { "0x3": "PlayerProcess", "0x2": "PlayerProcess", "0x1": "Reporting" },
      { "0x1": { registered: true, sent_report: true } },
    )
    const read = query.Game.Game.getValue.getMockImplementation() as (at: { at: string }) => Promise<unknown>
    query.Game.Game.getValue.mockImplementation(async (at: { at: string }) => {
      if (at.at !== "0x3") throw new Error("block not pinned")
      return read(at)
    })
    const standing = await engine.reportStanding("5Alice")
    expect(standing.game?.state.type).toBe("PlayerProcess")
    expect(standing.reportingRow).toBeUndefined()
  })

  it("leaves it out when no held block is still in Reporting", async () => {
    const { engine } = processed({ "0x3": "PlayerProcess", "0x2": "PlayerProcess", "0x1": "PlayerProcess" }, {})
    expect((await engine.reportStanding("5Alice")).reportingRow).toBeUndefined()
  })

  it("does not look back while the row still holds sent_report", async () => {
    const { engine, query } = processed(
      { "0x3": "PlayerProcess", "0x2": "Reporting", "0x1": "Reporting" },
      { "0x3": { registered: true, sent_report: false } },
    )
    const standing = await engine.reportStanding("5Alice")
    expect(standing.reportingRow).toBeUndefined()
    expect(query.Game.Game.getValue).toHaveBeenCalledTimes(1)
  })
})

describe("reading through the SDK works", () => {
  const BEST = { hash: "0xbe57", number: 12, parent: "0x0b" }
  const FINALIZED = { hash: "0xf1", number: 10 }

  /** Builds a client whose raw half answers the block pins the SDK asks for. */
  function sdkClient(
    api: Record<string, unknown>,
    properties: Record<string, unknown> = { tokenDecimals: 10, tokenSymbol: "PAS" },
  ): PeopleClient {
    const client = {
      destroy: vi.fn(),
      getFinalizedBlock: vi.fn().mockResolvedValue(FINALIZED),
      getBestBlocks: vi.fn().mockResolvedValue([BEST, FINALIZED]),
      getChainSpecData: vi.fn().mockResolvedValue({ properties }),
    }
    return { api, client } as unknown as PeopleClient
  }

  const replaying = (values: unknown[]) => ({
    subscribe: (observer: { next: (emission: unknown) => void }) => {
      for (const value of values) observer.next({ block: BEST, value })
      return { unsubscribe: vi.fn() }
    },
  })

  const rawGame = (state: unknown) => ({
    index: 7,
    registration_ends: 100,
    shuffle_deadline: 150,
    game_date: 200,
    report_ends: 900,
    state,
    max_group_size: 6,
    rounds: 2,
    pending_attendance: 0,
    airdrops_scheduled: 0,
  })

  it.each([
    [{ type: "Registration", value: { next_player_index: 3 } }, { type: "Registration" }, undefined],
    [
      { type: "Shuffle", value: { step: { type: "Step4AwaitSession", value: { player_count: 5 } } } },
      { type: "Shuffle", value: { player_count: 5 } },
      5,
    ],
    [
      { type: "PlayerProcess", value: { step: { type: "Step2ClearIndices", value: undefined } } },
      { type: "PlayerProcess" },
      undefined,
    ],
  ])("carries the roster count as the only state payload: %j", async (raw, state, count) => {
    // Given
    const client = sdkClient({
      query: { Game: { Game: { getValue: vi.fn().mockResolvedValue(rawGame(raw)) } } },
    })

    // When
    const game = await createChainEngine(client, { tld: "paseo" }).game()

    // Then
    expect(game?.state).toEqual(state)
    expect(game && statePlayerCount(game.state)).toBe(count)
  })

  it("watches the game in the same shape, and between games as undefined", () => {
    // Given
    const emissions = [rawGame({ type: "Reporting", value: { player_count: 4 } }), undefined]
    const watchValue = vi.fn(() => replaying(emissions))
    const client = sdkClient({ query: { Game: { Game: { watchValue } } } })
    const seen: unknown[] = []

    // When
    createChainEngine(client, { tld: "paseo" }).watchGame((game) => seen.push(game))

    // Then
    expect(seen).toEqual([
      expect.objectContaining({ index: 7, state: { type: "Reporting", value: { player_count: 4 } } }),
      undefined,
    ])
    expect(watchValue).toHaveBeenCalledWith({ at: "best" })
  })

  it("reads the indices under the Account key, a player with no seat as undefined", async () => {
    // Given
    const PlayerToIndex = { getValue: vi.fn().mockResolvedValue(undefined) }
    const engine = createChainEngine(sdkClient({ query: { Game: { PlayerToIndex } } }), { tld: "paseo" })

    // When
    const indices = await engine.playerIndices("5F...")

    // Then
    expect(indices).toBeUndefined()
    expect(PlayerToIndex.getValue).toHaveBeenCalledWith(
      { type: "Account", value: "5F..." },
      expect.objectContaining({ at: FINALIZED.hash }),
    )
  })

  // Two players under a cap of six make one group with the first two seats held.
  it("reads the members of a group by round and seat", async () => {
    // Given
    const IndexToPlayer = {
      getValues: vi.fn().mockResolvedValue([
        { type: "Account", value: "5A..." },
        { type: "Account", value: "5B..." },
      ]),
    }
    const engine = createChainEngine(sdkClient({ query: { Game: { IndexToPlayer } } }), { tld: "paseo" })

    // When
    const members = await engine.groupMembers(1, 0, 2, 6)

    // Then
    expect(members).toEqual([
      { index: 0, player: { type: "Account", value: "5A..." } },
      { index: 1, player: { type: "Account", value: "5B..." } },
    ])
    expect(IndexToPlayer.getValues).toHaveBeenCalledWith([[[1, 0]], [[1, 1]]], expect.anything())
  })

  it("watches the registration under the Account key, no record as undefined", () => {
    // Given
    const watchValue = vi.fn(() => replaying([{ registered: true, extra: "ignored" }, undefined]))
    const engine = createChainEngine(sdkClient({ query: { Game: { Players: { watchValue } } } }), { tld: "paseo" })
    const seen: unknown[] = []

    // When
    engine.watchPlayer("5F...", (player) => seen.push(player))

    // Then
    expect(seen).toEqual([{ registered: true }, undefined])
    expect(watchValue).toHaveBeenCalledWith({ type: "Account", value: "5F..." }, { at: "best" })
  })

  const rawRow = (patch: Record<string, unknown> = {}) => ({
    first_game: 3,
    registered: true,
    sent_report: true,
    early_attendance_enactment: undefined,
    yes_person: 2,
    no_not_person: 1,
    expected_max_vote_weight: 6,
    vote_weight: 2,
    credibility: { type: "Invited", value: undefined },
    ...patch,
  })
  const row = {
    registered: true,
    sent_report: true,
    vote_weight: 2,
    yes_person: 2,
    no_not_person: 1,
    expected_max_vote_weight: 6,
    early_attendance_enactment: null,
  }

  it("reads the player row with the votes and the enactment, at the best block", async () => {
    // Given
    const enacted = { attendance: true, disposition: { type: "ArchiveKickable", value: undefined } }
    const getValue = vi.fn().mockResolvedValueOnce(rawRow({ early_attendance_enactment: enacted })).mockResolvedValueOnce(undefined)
    const engine = createChainEngine(sdkClient({ query: { Game: { Players: { getValue } } } }), { tld: "paseo" })

    // When / Then
    expect(await engine.playerRow("5F...")).toEqual({
      ...row,
      early_attendance_enactment: { attendance: true, disposition: "ArchiveKickable" },
    })
    expect(await engine.playerRow("5F...")).toBeUndefined()
    expect(getValue).toHaveBeenCalledWith({ type: "Account", value: "5F..." }, { at: "best" })
  })

  it("watches the player row, delivering a row only when it moved", () => {
    // Given: the same bytes on a second block, then a vote, then the archive
    const watchValue = vi.fn(() =>
      replaying([rawRow(), rawRow(), rawRow({ yes_person: 4 }), undefined]),
    )
    const engine = createChainEngine(sdkClient({ query: { Game: { Players: { watchValue } } } }), { tld: "paseo" })
    const seen: unknown[] = []

    // When
    engine.watchPlayerRow("5F...", (player) => seen.push(player))

    // Then
    expect(seen).toEqual([row, { ...row, yes_person: 4 }, undefined])
    expect(watchValue).toHaveBeenCalledWith({ type: "Account", value: "5F..." }, { at: "best" })
  })

  it("watches the free balance at the best block, in planck", () => {
    // Given
    const watchValue = vi.fn(() => replaying([{ data: { free: 7n, reserved: 3n } }]))
    const engine = createChainEngine(sdkClient({ query: { System: { Account: { watchValue } } } }), { tld: "paseo" })
    const seen: string[] = []

    // When
    engine.watchFreeBalance("5F...", (free) => seen.push(free))

    // Then
    expect(seen).toEqual(["7"])
    expect(watchValue).toHaveBeenCalledWith("5F...", { at: "best" })
  })

})
