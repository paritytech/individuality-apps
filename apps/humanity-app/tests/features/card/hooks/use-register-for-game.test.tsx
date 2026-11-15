// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Register runs Jollity's sign-up flow from the home: the flow is told which
 *  game is open and whether the account is in it, the seat is prepared in the
 *  background, a tap goes through the flow, and what this product cannot
 *  carry (no host sign-up, a name it cannot link) is handed to Jollity. */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SeatUnfundedError } from "@individuality/sign-up";

const mocks = vi.hoisted(() => ({
  createGameSignUp: vi.fn(),
  recordMutation: vi.fn(),
  readGameRegistration: vi.fn(),
}));

vi.mock("@features/card/chain/game-registration-read.ts", () => ({
  readGameRegistration: mocks.readGameRegistration,
}));

vi.mock("@features/card/chain/game-sign-up.ts", () => ({
  createGameSignUp: mocks.createGameSignUp,
}));
vi.mock("@features/debug/debug-mutation-journal.ts", () => ({ recordMutation: mocks.recordMutation }));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn(), debug: vi.fn() }),
}));

import { useRegisterForGame } from "@features/card/hooks/use-register-for-game.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";

const SEAT = "5DIM2Seat";

function openGame(registered = false): CurrentGameResult {
  return {
    kind: "game",
    gameIndex: 7,
    gameDateSeconds: 2_000,
    registrationEndsSeconds: 1_500,
    playEndsSeconds: 2_600,
    airdropsScheduled: 0,
    phase: { label: "registration", nextDeadlineSeconds: 1_500, secondsRemaining: 300 },
    registered,
    liteSignUp: null,
  };
}

/** A sign-up flow that records what the hook asks of it. */
function fakeFlow() {
  const changes = new Set<() => void>();
  const seatInputs = new Set<() => void>();
  const state = {
    phase: "idle" as string,
    waitingOn: null as "name" | "bind" | null,
    signingUp: false,
    registered: false,
  };
  const flow = {
    register: vi.fn(() => Promise.resolve()),
    cancelRegister: vi.fn(),
    readSeat: vi.fn(() => Promise.resolve({ seat: { path: "free", ready: false }, funds: {}, bindReady: false })),
    requestBind: vi.fn(),
    requestName: vi.fn(),
    phase: () => state.phase,
    waitingOn: () => state.waitingOn,
    signingUp: () => state.signingUp,
    optimistic: () => ({ registered: state.registered, game: 7 }),
    registration: () => null,
    setRegistration: vi.fn(),
    setSlot: vi.fn(),
    newSlot: vi.fn(),
    confirmRegistered: vi.fn(),
    onChange: (listener: () => void) => {
      changes.add(listener);
      return () => changes.delete(listener);
    },
    onSeatInput: (listener: () => void) => {
      seatInputs.add(listener);
      return () => seatInputs.delete(listener);
    },
  };
  return {
    flow,
    state,
    changed: () => changes.forEach((listener) => listener()),
    seatInput: () => seatInputs.forEach((listener) => listener()),
  };
}

function setup(options: { name?: string | null; signUp?: "none" } = {}) {
  const fake = fakeFlow();
  let name = options.name ?? null;
  mocks.createGameSignUp.mockResolvedValue(
    options.signUp === "none" ? null : { flow: fake.flow, nameOutcome: () => name },
  );
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const handOff = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    ({ game }: { game: CurrentGameResult }) => useRegisterForGame(SEAT, game, handOff),
    { wrapper, initialProps: { game: openGame() } },
  );
  return { ...fake, hook, handOff, invalidate, setName: (next: string | null) => (name = next) };
}

describe("useRegisterForGame", () => {
  beforeEach(() => {
    mocks.createGameSignUp.mockReset();
    mocks.recordMutation.mockReset();
    mocks.readGameRegistration.mockReset().mockResolvedValue(null);
  });

  it("hands the flow the sign-up record read from both products' storage", async () => {
    const record = { gameIndex: 7, phase: "registering", surface: "app", at: 1, attempt: 1 };
    mocks.readGameRegistration.mockResolvedValue(record);
    const { flow } = setup();
    await waitFor(() => expect(flow.setRegistration).toHaveBeenLastCalledWith(record));
  });

  it("starts one flow for the game account and tells it the open game", async () => {
    const { flow } = setup();
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    expect(mocks.createGameSignUp).toHaveBeenCalledWith(SEAT);
    expect(flow.setSlot).toHaveBeenLastCalledWith(7, { index: 7, registrationEnds: 1_500, gamePlayTime: 2_000 });
    expect(flow.newSlot).toHaveBeenCalledWith(7);
  });

  it("prepares the seat while registration is open: the name link, and the bind of an unbound free seat", async () => {
    const { flow } = setup();
    await waitFor(() => expect(flow.requestBind).toHaveBeenCalled());
    expect(flow.requestName).toHaveBeenCalled();
  });

  it("tells the flow once the chain holds the account", async () => {
    const { flow, hook } = setup();
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    hook.rerender({ game: openGame(true) });
    expect(flow.confirmRegistered).toHaveBeenCalled();
  });

  it("signs up through the flow on a tap", async () => {
    const { flow, hook, handOff } = setup();
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    act(() => hook.result.current.register());
    expect(flow.register).toHaveBeenCalledTimes(1);
    expect(handOff).not.toHaveBeenCalled();
    expect(mocks.recordMutation).toHaveBeenCalledWith("Game.sign_up_with_account_lite_invite", "submitted", SEAT);
  });

  it("refreshes the game read once the sign-up is on the wire", async () => {
    const { flow, state, changed, invalidate } = setup();
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    state.registered = true;
    act(() => changed());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chain", "current-game"] });
  });

  it("says the seat is getting ready while the flow waits on it", async () => {
    const { flow, state, changed, hook } = setup();
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    state.phase = "waiting-seat";
    state.signingUp = true;
    act(() => changed());
    expect(hook.result.current.registering).toBe(true);
    expect(hook.result.current.registeringLabel).toBe("Getting your seat ready…");
  });

  it("hands a tap to Jollity when this product cannot link the name", async () => {
    const { flow, hook, handOff } = setup({ name: "unfunded" });
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    act(() => hook.result.current.register());
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(flow.register).not.toHaveBeenCalled();
  });

  it("hands a waiting tap to Jollity once the name turns out unlinkable from here", async () => {
    const { flow, state, seatInput, hook, handOff, setName } = setup();
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    act(() => hook.result.current.register());
    state.signingUp = true;
    state.phase = "waiting-seat";
    state.waitingOn = "name";
    setName("unfunded");
    act(() => seatInput());
    expect(flow.cancelRegister).toHaveBeenCalled();
    expect(handOff).toHaveBeenCalledTimes(1);
  });

  it("hands the tap to Jollity when this host cannot sign the game account up", async () => {
    const { hook, handOff } = setup({ signUp: "none" });
    await waitFor(() => expect(mocks.createGameSignUp).toHaveBeenCalled());
    await act(async () => {});
    act(() => hook.result.current.register());
    expect(handOff).toHaveBeenCalledTimes(1);
  });

  it("words a tap the flow refuses", async () => {
    const { flow, hook } = setup();
    flow.register.mockRejectedValueOnce(new SeatUnfundedError(10n, 1n));
    await waitFor(() => expect(flow.setSlot).toHaveBeenCalled());
    await act(async () => hook.result.current.register());
    expect(hook.result.current.error).toBe("Your game account can't cover this sign-up right now.");
  });
});
