// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The card resolves two accounts, and only the RFC-0022 candidate has a
 * `Game.Players` record, so a read keyed by the username owner answers a
 * different question. Nothing else pins that.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const OWNER = "5UsernameOwner";
const CANDIDATE = "5CandidateAccount";

type GameQuery = {
  enabled: boolean;
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
};

/** Both reads must share one pinned block, so the mocks name that shape. */
type BlockSource = { getFinalizedBlock: () => Promise<unknown> };

const mocks = vi.hoisted(() => ({
  queries: [] as GameQuery[],
  getPeopleClient: vi.fn(),
  readCurrentGame: vi.fn(),
  fromPapi: vi.fn((client: BlockSource, api: unknown) => ({ client, api })),
  readLiteSignUpVerdict: vi.fn(
    async (_args: {
      client: BlockSource;
      seatAccount: string;
      liteMemberKey?: Uint8Array;
    }) => null,
  ),
  toCurrentGameResult: vi.fn(() => ({ kind: "game" })),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: GameQuery) => {
    mocks.queries.push(query);
    return { data: undefined, error: null, isPending: false };
  },
}));
vi.mock("@humanity/shared/chain/bounded-read.ts", () => ({
  runBoundedChainRead: (
    _signal: AbortSignal,
    read: (signal: AbortSignal & { throwIfAborted: () => void }) => Promise<unknown>,
  ) =>
    read(
      Object.assign(new AbortController().signal, {
        throwIfAborted: () => undefined,
      }),
    ),
}));
vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: mocks.getPeopleClient,
}));
// The decoders stay real: the card assembly below runs through them.
vi.mock("@humanity/shared/chain/individuality.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readCurrentGame: mocks.readCurrentGame,
  fromPapi: mocks.fromPapi,
}));
vi.mock("@features/card/chain/lite-signup-read.ts", () => ({
  readLiteSignUpVerdict: mocks.readLiteSignUpVerdict,
}));
vi.mock("@features/card/chain/current-game-data.ts", () => ({
  toCurrentGameResult: mocks.toCurrentGameResult,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { useCurrentGame } from "@features/card/hooks/use-current-game.ts";
import { toHumanityCardResult } from "@humanity/shared/card/humanity-card-data.ts";
import { resolveWeeklyGameView } from "@features/card/domain/weekly-game-view.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import type * as CurrentGameData from "@features/card/chain/current-game-data.ts";

const { toCurrentGameResult: translateGame } = await vi.importActual<
  typeof CurrentGameData
>("@features/card/chain/current-game-data.ts");

const PINNED = { hash: "0xpinned", number: 42 };
const PEOPLE = {
  client: { id: "client", getFinalizedBlock: async () => PINNED },
  api: { id: "api" },
  network: { dotnsSuffix: "testnet" },
};

/** The Devicehood key of the session whose bind failed inside the host, and
 *  its bytes written out independently — decoding it with the same helper the
 *  hook uses would assert nothing about the decode. */
const DEVICEHOOD_KEY_HEX =
  "0x8cad933a3e1ff2614e9572c9eab78eccb983aa524fa68d53dc00395c35f0b5ee";
const DEVICEHOOD_KEY_BYTES = [
  0x8c, 0xad, 0x93, 0x3a, 0x3e, 0x1f, 0xf2, 0x61, 0x4e, 0x95, 0x72, 0xc9, 0xea,
  0xb7, 0x8e, 0xcc, 0xb9, 0x83, 0xaa, 0x52, 0x4f, 0xa6, 0x8d, 0x53, 0xdc, 0x00,
  0x39, 0x5c, 0x35, 0xf0, 0xb5, 0xee,
];

function betweenGames() {
  return {
    ok: true as const,
    value: {
      tag: "BetweenGames" as const,
      at: { blockHash: "0xblock", blockNumber: 42 },
      lastGameIndex: 3,
      upcoming: [],
      durations: {
        registration: 300,
        shuffle: 210,
        postShuffleMargin: 90,
        reporting: 360,
        playerProcess: 60,
      },
    },
  };
}

function latestQuery(): GameQuery {
  const query = mocks.queries.at(-1);
  if (query == null) throw new Error("current game query was not created");
  return query;
}

/** `devicehood` is what the card read decodes from `PeopleLite.LitePeople`;
 *  a person the chain holds no record for has none. */
function mount(ringVrfKey: string | null): void {
  useCurrentGame({
    kind: "card",
    playerIdentities: { accountAddress: CANDIDATE },
    ownerAccount: OWNER,
    devicehood:
      ringVrfKey == null ? null : { ringVrfKey, method: { kind: "fee" } },
  } as never);
}

async function runRead(ringVrfKey: string | null = null): Promise<unknown> {
  mount(ringVrfKey);
  return latestQuery().queryFn({ signal: new AbortController().signal });
}

/** The options the seat read was actually called with. Which properties are
 *  present is the assertion, so this must not be an optional-chained view:
 *  `toEqual` treats an explicit `undefined` as an absent property. */
function seatReadOptions(): { liteMemberKey?: Uint8Array } {
  const call = mocks.readLiteSignUpVerdict.mock.calls[0];
  if (call == null) throw new Error("the seat read was not called");
  return call[0];
}

afterEach(() => {
  mocks.queries.length = 0;
  vi.clearAllMocks();
  mocks.fromPapi.mockImplementation((client: BlockSource, api: unknown) => ({
    client,
    api,
  }));
  mocks.toCurrentGameResult.mockReturnValue({ kind: "game" });
});

describe("useCurrentGame chain read", () => {
  it("asks about the candidate account that plays the game", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockResolvedValue(betweenGames());

    await runRead();

    expect(mocks.readCurrentGame).toHaveBeenCalledTimes(1);
    expect(mocks.readCurrentGame.mock.calls[0]?.[1]).toMatchObject({
      players: [{ tag: "Account", accountAddress: CANDIDATE }],
    });
  });

  it("never keys the read by the username owner", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockResolvedValue(betweenGames());

    await runRead();

    expect(mocks.readCurrentGame).toHaveBeenCalled();
    expect(JSON.stringify(mocks.readCurrentGame.mock.calls)).not.toContain(
      OWNER,
    );
  });

  it("pins one finalized block and gives it to both reads", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockResolvedValue(betweenGames());

    await runRead();

    const [source, papiApi] = mocks.fromPapi.mock.calls[0] ?? [];
    expect(papiApi).toBe(PEOPLE.api);
    await expect(source?.getFinalizedBlock()).resolves.toBe(PINNED);

    const seatRead = mocks.readLiteSignUpVerdict.mock.calls[0]?.[0];
    expect(seatRead?.seatAccount).toBe(CANDIDATE);
    expect(seatRead?.client).toBe(source);
  });

  it("surfaces a failed read as a rejection, not a silent no-game", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    const error = new Error("node unreachable");
    mocks.readCurrentGame.mockResolvedValue({ ok: false, error });

    await expect(runRead()).rejects.toBe(error);
    expect(mocks.toCurrentGameResult).not.toHaveBeenCalled();
  });

  it("hands the seat read the Devicehood key already on the card, as bytes", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockResolvedValue(betweenGames());

    await runRead(DEVICEHOOD_KEY_HEX);

    const liteMemberKey = seatReadOptions().liteMemberKey;
    expect(liteMemberKey).toBeInstanceOf(Uint8Array);
    expect(Array.from(liteMemberKey ?? [])).toEqual(DEVICEHOOD_KEY_BYTES);
  });

  it("takes the key from card state, adding no read of its own", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockResolvedValue(betweenGames());

    await runRead(DEVICEHOOD_KEY_HEX);

    // One pinned block and the two reads that already existed: a host or chain
    // round trip for the key would show up as another `getPeopleClient`.
    expect(mocks.getPeopleClient).toHaveBeenCalledTimes(1);
    expect(mocks.readLiteSignUpVerdict).toHaveBeenCalledTimes(1);
  });

  it("omits the membership option when the chain holds no Devicehood record", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockResolvedValue(betweenGames());

    await runRead();

    expect(Object.hasOwn(seatReadOptions(), "liteMemberKey")).toBe(false);
  });

  it("re-asks the seat verdict once a Devicehood record lands", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);

    mount(null);
    const withoutKey = latestQuery().queryKey;
    mount(DEVICEHOOD_KEY_HEX);

    // Without the key in the query key, a verdict read from before the record
    // existed stays cached and keeps answering with the gate switched off.
    expect(latestQuery().queryKey).not.toEqual(withoutKey);
  });
});

describe("useCurrentGame on the assembled card's game account", () => {
  /** The card exactly as the card read assembles it, so this pins which
   *  account the assembly hands the game read — not a hand-written shape. */
  function assembledCard() {
    return toHumanityCardResult({
      primaryUsername: "alice.dot",
      ownerAccount: OWNER,
      gameAccount: CANDIDATE,
      rawParticipant: null,
      litePerson: null,
      isUpgradedIdentity: false,
      personhoodThreshold: 6,
      absenceGraceRatio: "0x0506",
      membershipStanding: null,
      devicehoodRing: null,
      deviceKeyCheck: null,
    });
  }

  /** A game still taking registrations, in which only the game account
   *  holds a `Game.Players` record. */
  function registeredOnGameAccountOnly(nowSeconds: number) {
    return ({ players }: { players: Array<{ accountAddress: string }> }) => ({
      ok: true as const,
      value: {
        tag: "Running" as const,
        at: { blockHash: "0xblock", blockNumber: 42 },
        game: {
          index: 7,
          phase: "Registration",
          nextDeadline: nowSeconds + 3_600,
          registrationEnds: nowSeconds + 3_600,
          shuffleDeadline: nowSeconds + 7_200,
          gamePlayTime: nowSeconds + 10_800,
          reportingEnds: nowSeconds + 86_400,
          maxGroupSize: 5,
          rounds: 3,
          playerCount: null,
          pendingAttendance: 0,
          airdropsScheduled: 1,
        },
        registration: {
          tag: players[0]?.accountAddress === CANDIDATE ? "Registered" : "NotRegistered",
        },
        upcoming: [],
        durations: {
          registration: 300,
          shuffle: 210,
          postShuffleMargin: 90,
          reporting: 360,
          playerProcess: 60,
        },
      },
    });
  }

  async function read(): Promise<CurrentGameResult> {
    useCurrentGame(assembledCard());
    return (await latestQuery().queryFn({
      signal: new AbortController().signal,
    })) as CurrentGameResult;
  }

  it("reads registration and the seat verdict on the game account, never the owner", async () => {
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockResolvedValue(betweenGames());

    await read();

    expect(mocks.readCurrentGame.mock.calls[0]?.[1]).toMatchObject({
      players: [{ tag: "Account", accountAddress: CANDIDATE }],
    });
    expect(mocks.readLiteSignUpVerdict.mock.calls[0]?.[0].seatAccount).toBe(CANDIDATE);
    expect(latestQuery().queryKey).toContain(CANDIDATE);
  });

  it("shows a sign-up on the game account as Registered, not Register", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    mocks.getPeopleClient.mockResolvedValue(PEOPLE);
    mocks.readCurrentGame.mockImplementation((_chain, options) =>
      Promise.resolve(registeredOnGameAccountOnly(nowSeconds)(options)),
    );
    mocks.toCurrentGameResult.mockImplementation(translateGame as never);

    const game = await read();

    expect(game).toMatchObject({ kind: "game", registered: true });
    expect(resolveWeeklyGameView(game, false, false, nowSeconds).mode).toBe("confirmed");
  });

  // DIM2 confirms at the best block and the finalized read trails it: a
  // person back from registering must not be offered Register again.
  it("counts a sign-up the best block holds before the finalized read does", async () => {
    const players = vi.fn(async () => ({ registered: true }));
    mocks.getPeopleClient.mockResolvedValue({
      ...PEOPLE,
      api: { query: { Game: { Players: { getValue: players } } } },
    });
    const running = { tag: "Running" as const, at: { blockHash: "0xblock", blockNumber: 42 }, registration: { tag: "NotRegistered" as const } };
    mocks.readCurrentGame.mockResolvedValue({ ok: true, value: running });

    await runRead();

    expect(players).toHaveBeenCalledWith(expect.anything(), { at: "best" });
    expect((mocks.toCurrentGameResult.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
      registration: { tag: "Registered" },
    });
  });

  it("keeps the finalized answer when the best-block read fails", async () => {
    mocks.getPeopleClient.mockResolvedValue({
      ...PEOPLE,
      api: { query: { Game: { Players: { getValue: vi.fn(async () => { throw new Error("gone"); }) } } } },
    });
    const running = { tag: "Running" as const, at: { blockHash: "0xblock", blockNumber: 42 }, registration: { tag: "NotRegistered" as const } };
    mocks.readCurrentGame.mockResolvedValue({ ok: true, value: running });

    await runRead();

    expect((mocks.toCurrentGameResult.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({
      registration: { tag: "NotRegistered" },
    });
  });
});
