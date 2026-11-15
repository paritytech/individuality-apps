// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { act } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  HumanityActionSessionProvider,
  useHumanityActionSession,
} from "@shared/navigation/humanity-action-session.tsx";

function Probe() {
  const { dismissed, refreshing, dismiss } = useHumanityActionSession();
  return (
    <>
      <output aria-label="dismissed actions">{dismissed.join(",")}</output>
      <output aria-label="refresh state">
        {refreshing ? "refreshing" : "settled"}
      </output>
      <button
        type="button"
        onClick={() => dismiss("claim-username")}
      >
        Dismiss claim
      </button>
    </>
  );
}

/** One chain read whose every fetch waits until the test settles it. */
interface ControlledRead {
  queryFn: (context: { signal: AbortSignal }) => Promise<number>;
  readonly calls: number;
  /** The signal of the latest fetch, read so the query aborts it on cancel. */
  readonly latestSignal: AbortSignal | undefined;
  settleAll: () => Promise<void>;
}

function controlledRead(name: string, log: string[]): ControlledRead {
  const pending: { resolve: (value: number) => void; signal: AbortSignal }[] = [];
  let calls = 0;
  return {
    queryFn: ({ signal }) =>
      new Promise<number>((resolve) => {
        calls += 1;
        log.push(name);
        pending.push({ resolve, signal });
      }),
    get calls() {
      return calls;
    },
    get latestSignal() {
      return pending.at(-1)?.signal;
    },
    async settleAll() {
      await act(async () => {
        for (const read of pending.splice(0)) read.resolve(calls);
      });
    },
  };
}

function ChainReads({
  card,
  game,
}: {
  card: ControlledRead;
  game: ControlledRead;
}) {
  useQuery({
    queryKey: ["chain", "humanity-card", "alice.42"],
    queryFn: card.queryFn,
    retry: false,
    staleTime: Infinity,
  });
  useQuery({
    queryKey: ["chain", "current-game", "alice"],
    queryFn: game.queryFn,
    retry: false,
    staleTime: Infinity,
  });
  return null;
}

function renderWithChainReads() {
  const log: string[] = [];
  const card = controlledRead("card", log);
  const game = controlledRead("game", log);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HumanityActionSessionProvider>
        <ChainReads card={card} game={game} />
        <Probe />
      </HumanityActionSessionProvider>
    </QueryClientProvider>,
  );
  return { log, card, game };
}

function refreshState() {
  return screen.getByLabelText("refresh state").textContent;
}

beforeAll(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

describe("HumanityActionSessionProvider", () => {
  it("clears dismissals and waits for chain refresh on foreground", async () => {
    let finishRefresh: (() => void) | undefined;
    const client = new QueryClient();
    const refetch = vi
      .spyOn(client, "refetchQueries")
      .mockReturnValue(
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
      );

    render(
      <QueryClientProvider client={client}>
        <HumanityActionSessionProvider>
          <Probe />
        </HumanityActionSessionProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss claim" }));
    expect(screen.getByLabelText("dismissed actions").textContent).toBe(
      "claim-username",
    );

    fireEvent(window, new Event("focus"));
    expect(screen.getByLabelText("dismissed actions").textContent).toBe("");
    expect(refreshState()).toBe("refreshing");
    expect(refetch).toHaveBeenCalledOnce();

    await act(async () => finishRefresh?.());
    expect(refreshState()).toBe("settled");
  });

  it("refetches the card before any other chain read on foreground", async () => {
    const { log, card, game } = renderWithChainReads();
    await card.settleAll();
    await game.settleAll();
    log.length = 0;

    fireEvent(document, new Event("visibilitychange"));
    expect(log).toEqual(["card"]);
    expect(refreshState()).toBe("refreshing");

    // The launch action is decided once the card lands; the rest follows.
    await card.settleAll();
    expect(refreshState()).toBe("settled");
    expect(log).toEqual(["card", "game"]);
    await game.settleAll();
    expect(refreshState()).toBe("settled");
  });

  it("settles on the latest return only, refreshing the rest once", async () => {
    const { log, card, game } = renderWithChainReads();
    await card.settleAll();
    await game.settleAll();
    log.length = 0;

    fireEvent(document, new Event("visibilitychange"));
    const firstCardRead = card.latestSignal;
    fireEvent(window, new Event("focus"));
    // A later return restarts the card read: the earlier one may have pinned
    // a block from before the score moved.
    expect(firstCardRead?.aborted).toBe(true);
    expect(log).toEqual(["card", "card"]);

    await card.settleAll();
    expect(refreshState()).toBe("settled");
    expect(log).toEqual(["card", "card", "game"]);
    await game.settleAll();
    expect(game.calls).toBe(2);
  });

  it("joins the first load's own reads instead of restarting them", async () => {
    const { log, card, game } = renderWithChainReads();
    expect(log).toEqual(["card", "game"]);
    const mountCardRead = card.latestSignal;

    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: false }));
    expect(refreshState()).toBe("refreshing");
    expect(mountCardRead?.aborted).toBe(false);
    expect(card.calls).toBe(1);

    await card.settleAll();
    expect(refreshState()).toBe("settled");
    expect(game.calls).toBe(1);
    await game.settleAll();
  });
});
