// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CardData from "@humanity/shared/card/humanity-card-data.ts";
import type { ResolvedHumanityCard } from "@humanity/shared/card/humanity-card-data.ts";

const STORED_CARD = {
  kind: "card",
  primaryUsername: "alice.42.paseo",
  accountAddress: "5Alice",
  participant: null,
  devicehood: null,
  membershipStanding: null,
  devicehoodRing: null,
  state: { kind: "member", activeWeeks: 3, lastAttendedGame: 7, attendanceHistory: 0, window: 8 },
  playerIdentities: { accountAddress: "5AliceGame" },
  snapshot: {
    isLitePerson: false,
    isUpgradedIdentity: false,
    participant: null,
    personhoodThreshold: 7,
    policy: { allowedMisses: 1, window: 2 },
    membershipRing: null,
    devicehoodRing: null,
  },
} as const satisfies ResolvedHumanityCard;

const LIVE_CARD = {
  ...STORED_CARD,
  primaryUsername: "alice.full.paseo",
  state: { kind: "member", activeWeeks: 4, lastAttendedGame: 8, attendanceHistory: 0, window: 8 },
} as const satisfies ResolvedHumanityCard;

type CardQuery = {
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
};

const mocks = vi.hoisted(() => {
  const queries: CardQuery[] = [];
  return {
    cardQuery: { data: undefined as unknown, error: null as Error | null, isPending: false },
    getPeopleClient: vi.fn(),
    identityQuery: {
      data: undefined as
        | { primaryUsername: string; username: string; isUpgraded: boolean }
        | undefined,
      error: null as Error | null,
      isFetching: false,
      isPending: false,
    },
    gameAccountQuery: { data: "5AliceGame" as string | null, isPending: false },
    queries,
    toHumanityCardResult: vi.fn(),
  };
});

// Hands the Pocket card its face; covered by its own test.
vi.mock("@features/card/hooks/use-pocket-face-hint.ts", () => ({ usePocketFaceHint: () => undefined }));
vi.mock("@features/card/hooks/use-candidate-overlay.ts", () => ({
  useCandidateOverlay: (card: unknown) => card,
}));

vi.mock("react", () => ({
  useMemo: <T,>(factory: () => T) => factory(),
  useEffect: (effect: () => void) => effect(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: CardQuery) => {
    mocks.queries.push(query);
    return mocks.cardQuery;
  },
}));
vi.mock("polkadot-api", () => ({
  Binary: { fromText: (value: string) => value },
  Enum: (kind: string, value: string) => [kind, value],
}));
vi.mock("@humanity/shared/chain/bounded-read.ts", () => ({
  runBoundedChainRead: (
    _signal: AbortSignal,
    read: (signal: AbortSignal & { throwIfAborted: () => void }) => Promise<unknown>,
  ) => read(Object.assign(new AbortController().signal, { throwIfAborted: () => undefined })),
}));
vi.mock("@humanity/shared/chain/client.ts", () => ({ getPeopleClient: mocks.getPeopleClient }));
vi.mock("@humanity/shared/chain/username-signing-context.ts", () => ({ usernameSigningContext: async () => null }));
vi.mock("@shared/chain/query-state.ts", () => ({
  blockingError: (error: Error | null, data: unknown) =>
    data === undefined ? error : null,
}));
vi.mock("@humanity/shared/card/humanity-card-data.ts", async (importActual) => ({
  furtherAlongParticipant: (await importActual<typeof CardData>()).furtherAlongParticipant,
  probeDevicehoodRing: vi.fn(() => Promise.resolve({ kind: "no-record" })),
  toHumanityCardResult: mocks.toHumanityCardResult,
}));
vi.mock("@features/card/hooks/use-humanity-user-id.ts", () => ({
  useHumanityUserId: () => mocks.identityQuery,
}));
vi.mock("@features/card/hooks/use-game-account.ts", () => ({
  useGameAccount: () => mocks.gameAccountQuery,
}));
vi.mock("@features/card/hooks/use-username-upgrade-marker.ts", () => ({
  useUsernameUpgradeOverlay: (card: unknown) => card,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ debug: vi.fn(), info: vi.fn() }),
}));

import { useHumanityCard } from "@features/card/hooks/use-humanity-card.ts";
import {
  readLastCard,
  resetLastCardStore,
  writeLastCard,
} from "@features/card/storage/last-card-store.ts";

const entries = new Map<string, string>();

function renderCard() {
  mocks.queries.length = 0;
  return useHumanityCard(true);
}

function latestCardQuery(): CardQuery {
  const query = mocks.queries.at(-1);
  if (query == null) throw new Error("card query was not created");
  return query;
}

function chainApi() {
  return {
    client: { getFinalizedBlock: vi.fn().mockResolvedValue({ hash: "0xblock" }) },
    api: {
      query: {
        Resources: {
          UsernameOwnerOf: { getValue: vi.fn().mockResolvedValue("5Alice") },
          Consumers: { getValue: vi.fn().mockResolvedValue(undefined) },
        },
        Score: {
          Participants: { getValue: vi.fn().mockResolvedValue(null) },
          PersonhoodThreshold: { getValue: vi.fn().mockResolvedValue(7) },
          AbsenceGraceRatio: { getValue: vi.fn().mockResolvedValue("0x0506") },
        },
        PeopleLite: { LitePeople: { getValue: vi.fn().mockResolvedValue(null) } },
        // Neither account has a personal id or an alias bound, so the
        // Membership-ring read stops at the first lookup and the participant
        // key never leaves the account road — the common case.
        People: {
          AccountToAlias: { getValue: vi.fn().mockResolvedValue(undefined) },
          AccountToPersonalId: { getValue: vi.fn().mockResolvedValue(undefined) },
          People: { getValue: vi.fn().mockResolvedValue(undefined) },
        },
        Members: { Members: { getValue: vi.fn().mockResolvedValue(undefined) } },
      },
      constants: {
        Score: { score_context: vi.fn().mockResolvedValue(`0x${"5c".repeat(32)}`) },
      },
    },
  };
}

beforeEach(() => {
  entries.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    },
  });
  resetLastCardStore();
  mocks.cardQuery = { data: undefined, error: null, isPending: false };
  mocks.identityQuery.data = undefined;
  mocks.identityQuery.error = null;
  mocks.identityQuery.isFetching = false;
  mocks.identityQuery.isPending = false;
  mocks.gameAccountQuery.data = "5AliceGame";
  mocks.gameAccountQuery.isPending = false;
  mocks.getPeopleClient.mockReset();
  mocks.toHumanityCardResult.mockReset();
});

afterEach(() => {
  resetLastCardStore();
  vi.unstubAllGlobals();
});

describe("useHumanityCard durable fallback", () => {
  it("ignores a hydrated card whose state this build cannot render", () => {
    // The persisted query cache is busted per network and schema version,
    // so a card written by a build that still had the `lite` state can be
    // hydrated straight into the query. It must not reach the face; and
    // since the query counts it as success, its replacement is a background
    // refetch — so the card reads as loading until that lands, not absent.
    // With a stored card, that one covers the wait.
    mocks.identityQuery.data = {
      primaryUsername: "alice.42.paseo",
      username: "alice.42",
      isUpgraded: false,
    };
    mocks.cardQuery.data = { ...STORED_CARD, state: { kind: "lite" } };

    expect(renderCard()).toEqual({ data: undefined, error: null, isPending: true });

    mocks.cardQuery.error = new Error("refetch failed");
    expect(renderCard()).toEqual({
      data: undefined,
      error: mocks.cardQuery.error,
      isPending: false,
    });
    mocks.cardQuery.error = null;

    writeLastCard("alice.42", STORED_CARD);
    expect(renderCard()).toEqual({ data: STORED_CARD, error: null, isPending: false });
  });

  it("replaces a failed card read with the stored card", () => {
    writeLastCard("alice.42", STORED_CARD);
    mocks.identityQuery.data = {
      primaryUsername: "alice.42.paseo",
      username: "alice.42",
      isUpgraded: false,
    };
    mocks.cardQuery.error = new Error("read failed");

    expect(renderCard()).toEqual({ data: STORED_CARD, error: null, isPending: false });
  });

  it("replaces a pending first read with the stored card", () => {
    writeLastCard("alice.42", STORED_CARD);
    mocks.identityQuery.isPending = true;

    expect(renderCard()).toEqual({ data: STORED_CARD, error: null, isPending: false });
  });
  it("hands back the same no-account result on every render", () => {
    // A fresh object per render loops `useCardPromotion`, which tracks the
    // card during render, whenever a debug scenario rebuilds the card from it.
    const first = renderCard();
    expect(first.data).toEqual({ kind: "account-unavailable" });
    expect(renderCard().data).toBe(first.data);
  });

  it("keeps the live query pending while the game account is unresolved", () => {
    const unavailable = { kind: "account-unavailable" } as const;
    mocks.identityQuery.data = {
      primaryUsername: "alice.42.paseo",
      username: "alice.42",
      isUpgraded: false,
    };
    mocks.gameAccountQuery.data = undefined;
    mocks.gameAccountQuery.isPending = true;
    mocks.cardQuery.data = unavailable;

    expect(renderCard()).toEqual({ data: unavailable, error: null, isPending: true });
  });


  it("keeps a stored card visible while the game account is unresolved", () => {
    writeLastCard("alice.42", STORED_CARD);
    mocks.identityQuery.data = {
      primaryUsername: "alice.42.paseo",
      username: "alice.42",
      isUpgraded: false,
    };
    mocks.gameAccountQuery.data = undefined;
    mocks.gameAccountQuery.isPending = true;
    mocks.cardQuery.data = { kind: "account-unavailable" };

    expect(renderCard()).toEqual({ data: STORED_CARD, error: null, isPending: false });
  });

  it("never serves a snapshot to a resolved different username", () => {
    writeLastCard("alice.42", STORED_CARD);
    mocks.identityQuery.data = {
      primaryUsername: "bob.42.paseo",
      username: "bob.42",
      isUpgraded: false,
    };
    mocks.cardQuery.error = new Error("read failed");

    expect(renderCard()).toEqual({
      data: undefined,
      error: expect.any(Error),
      isPending: false,
    });
  });

  it("prefers and durably replaces the snapshot with a successful live card", async () => {
    writeLastCard("alice.42", STORED_CARD);
    mocks.identityQuery.data = {
      primaryUsername: "alice.full.paseo",
      username: "alice.full",
      isUpgraded: false,
    };
    mocks.cardQuery.data = LIVE_CARD;
    mocks.getPeopleClient.mockResolvedValue(chainApi());
    mocks.toHumanityCardResult.mockReturnValue(LIVE_CARD);

    expect(renderCard()).toEqual({ data: LIVE_CARD, error: null, isPending: false });
    await latestCardQuery().queryFn({ signal: new AbortController().signal });

    resetLastCardStore();
    const restored = readLastCard();
    expect(restored).toMatchObject({ username: "alice.full", card: LIVE_CARD });
    expect(readLastCard()).toBe(restored);
  });
});
