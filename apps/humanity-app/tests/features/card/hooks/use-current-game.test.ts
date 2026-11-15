// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";

type CurrentGameQuery = {
  refetchInterval: number;
  refetchIntervalInBackground: boolean;
};

const mocks = vi.hoisted(() => ({
  queries: [] as CurrentGameQuery[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: CurrentGameQuery) => {
    mocks.queries.push(query);
    return { data: undefined, error: null, isPending: false };
  },
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ debug: vi.fn() }),
}));

import { useCurrentGame } from "@features/card/hooks/use-current-game.ts";

function latestGameQuery(): CurrentGameQuery {
  const query = mocks.queries.at(-1);
  if (query == null) throw new Error("current game query was not created");
  return query;
}

afterEach(() => {
  mocks.queries.length = 0;
});

describe("useCurrentGame polling", () => {
  it("refreshes the game state every 30 seconds, including in the background", () => {
    useCurrentGame({
      kind: "card",
      playerIdentities: { accountAddress: "5Candidate" },
    } as never);

    expect(latestGameQuery()).toMatchObject({
      refetchInterval: 30_000,
      refetchIntervalInBackground: true,
    });
  });
});
