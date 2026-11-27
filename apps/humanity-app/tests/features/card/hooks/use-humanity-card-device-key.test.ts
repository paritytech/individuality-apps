// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The pre-flight device-key check, on the card's own pinned block.
 *
 * Two things matter here, and neither is the comparison itself — that is
 * `toDeviceKeyCheck`'s own exhaustive coverage in `humanity-card-data.test.ts`.
 * This file is about the hook's obligations around it: reuse the block and
 * the `PeopleLite.LitePeople` record the card read already has (no second
 * `getFinalizedBlock`, no second `LitePeople` read), issue no host call at
 * all when there is no record to check, and never let a host fault escape
 * the query as a rejected read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const OWNER = "5UsernameOwner";
const HOST_KEY = "0x936d177b3a002d37c890b0e95fce4de2362d38a7ae36ecff3b9c2f0467b46de0";
const CHAIN_KEY = "0x8cad933a3e1ff2614e9572c9eab78eccb983aa524fa68d53dc00395c35f0b5ee";

type CardQuery = {
  enabled: boolean;
  queryKey: readonly unknown[];
  queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
};

const mocks = vi.hoisted(() => {
  const queries: CardQuery[] = [];
  return {
    getPeopleClient: vi.fn(),
    identityQuery: {
      data: {
        primaryUsername: "alice.42.dot",
        username: "alice.42",
        isUpgraded: false,
      } as
        | { primaryUsername: string; username: string; isUpgraded: boolean }
        | undefined,
      error: null,
      isFetching: false,
      isPending: false,
    },
    gameAccountQuery: {
      data: "5CandidateAccount" as string | null | undefined,
      isPending: false,
    },
    queries,
    readPersonhoodRingKey: vi.fn(),
    readDeclaredRingKey: vi.fn(),
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
    return { data: undefined, error: null, isPending: false };
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
vi.mock("@shared/chain/query-state.ts", () => ({ blockingError: () => null }));
vi.mock("@shared/chain/query-view.ts", () => ({ mockQueryView: vi.fn() }));
vi.mock("@humanity/shared/chain/client.ts", () => ({ getPeopleClient: mocks.getPeopleClient }));
vi.mock("@humanity/shared/chain/username-signing-context.ts", () => ({ usernameSigningContext: async () => null }));
vi.mock("@humanity/shared/identity/personhood-ring-key.ts", () => ({
  readPersonhoodRingKey: mocks.readPersonhoodRingKey,
  readDeclaredRingKey: mocks.readDeclaredRingKey,
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
  loggerFor: () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

import { useHumanityCard } from "@features/card/hooks/use-humanity-card.ts";

function latestCardQuery(): CardQuery {
  const query = mocks.queries.at(-1);
  if (query == null) throw new Error("card query was not created");
  return query;
}

function renderCard(): CardQuery {
  mocks.queries.length = 0;
  useHumanityCard(true);
  return latestCardQuery();
}

/** A minimal chain double: `Members.Members` answers "no entry" for every
 *  key asked, so neither ring read pulls in the coverage reads. */
function chainApi(litePerson: { ring_vrf_key: string; method: { type: string } } | null) {
  const litePeople = { getValue: vi.fn().mockResolvedValue(litePerson) };
  const members = { getValue: vi.fn().mockResolvedValue(undefined) };
  return {
    client: {
      getFinalizedBlock: vi.fn().mockResolvedValue({ hash: "0xblock89396" }),
    },
    api: {
      constants: {
        Score: { score_context: vi.fn().mockResolvedValue(`0x${"00".repeat(32)}`) },
      },
      query: {
        Resources: {
          UsernameOwnerOf: { getValue: vi.fn().mockResolvedValue(OWNER) },
          Consumers: { getValue: vi.fn().mockResolvedValue(undefined) },
        },
        Score: {
          Participants: { getValue: vi.fn().mockResolvedValue(null) },
          PersonhoodThreshold: { getValue: vi.fn().mockResolvedValue(7) },
          AbsenceGraceRatio: { getValue: vi.fn().mockResolvedValue("0x0506") },
        },
        People: {
          AccountToAlias: { getValue: vi.fn().mockResolvedValue(undefined) },
          AccountToPersonalId: { getValue: vi.fn().mockResolvedValue(undefined) },
          People: { getValue: vi.fn().mockResolvedValue(undefined) },
        },
        Members: { Members: members },
        PeopleLite: { LitePeople: litePeople },
      },
    },
    litePeople,
    members,
  };
}

afterEach(() => {
  mocks.getPeopleClient.mockReset();
  mocks.readPersonhoodRingKey.mockReset();
  mocks.readDeclaredRingKey.mockReset();
  mocks.queries.length = 0;
});

describe("useHumanityCard device key check", () => {
  it("reuses the card's own pinned block and LitePeople read, with no extra host call when there is no record", async () => {
    const chain = chainApi(null);
    mocks.getPeopleClient.mockResolvedValue(chain);
    // Fixed so the Membership-ring read takes the by-key path, not the
    // account walk — irrelevant to this test, kept simple.
    mocks.readPersonhoodRingKey.mockResolvedValue(HOST_KEY);

    const result = (await renderCard().queryFn({
      signal: new AbortController().signal,
    })) as { deviceKeyCheck: unknown };

    expect(result.deviceKeyCheck).toBeNull();
    expect(chain.client.getFinalizedBlock).toHaveBeenCalledTimes(1);
    expect(chain.litePeople.getValue).toHaveBeenCalledTimes(1);
    expect(mocks.readDeclaredRingKey).not.toHaveBeenCalled();
  });

  it("checks the host's declared lite key against the record already read, off the same pinned block", async () => {
    const litePerson = { ring_vrf_key: CHAIN_KEY, method: { type: "Fee" } };
    const chain = chainApi(litePerson);
    mocks.getPeopleClient.mockResolvedValue(chain);
    mocks.readPersonhoodRingKey.mockResolvedValue(HOST_KEY);
    mocks.readDeclaredRingKey.mockResolvedValue({ kind: "found", key: HOST_KEY });

    const result = (await renderCard().queryFn({
      signal: new AbortController().signal,
    })) as { deviceKeyCheck: unknown };

    expect(result.deviceKeyCheck).toEqual({
      kind: "mismatch",
      hostKey: HOST_KEY,
      chainKey: CHAIN_KEY,
    });
    // One `getFinalizedBlock`/one `LitePeople` read for the whole card,
    // reused for the device-key check rather than pinning a second block.
    expect(chain.client.getFinalizedBlock).toHaveBeenCalledTimes(1);
    expect(chain.litePeople.getValue).toHaveBeenCalledTimes(1);
    expect(mocks.readDeclaredRingKey).toHaveBeenCalledWith(
      expect.anything(),
      "people-lite",
    );
  });

  it("turns a throwing lookup into unknown rather than failing the card read", async () => {
    const litePerson = { ring_vrf_key: CHAIN_KEY, method: { type: "Fee" } };
    const chain = chainApi(litePerson);
    mocks.getPeopleClient.mockResolvedValue(chain);
    mocks.readPersonhoodRingKey.mockResolvedValue(HOST_KEY);
    mocks.readDeclaredRingKey.mockRejectedValue(new Error("host refused"));

    const result = (await renderCard().queryFn({
      signal: new AbortController().signal,
    })) as { kind: string; deviceKeyCheck: unknown };

    expect(result.kind).toBe("card");
    expect(result.deviceKeyCheck).toEqual({
      kind: "unknown",
      reason: expect.stringContaining("host refused"),
    });
  });
});
