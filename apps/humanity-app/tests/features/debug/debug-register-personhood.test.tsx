// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The panel's manual `Score.register` runs the shared attempt at once, on
 *  the configured game account, never beside another registration in
 *  flight, and can clear the record the automatic gate reads. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attempt: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("@features/card/hooks/use-auto-register-personhood.ts", () => ({
  REGISTER_PERSONHOOD_MUTATION_KEY: ["card", "register-personhood"],
  attemptPersonhoodRegistration: mocks.attempt,
}));
vi.mock("@features/debug/debug-registration.ts", () => ({
  probeGameAccount: mocks.probe,
}));
vi.mock("@humanity/shared/identity/game-account.ts", () => ({
  GAME_ACCOUNT_INDEX: 1,
}));

import { DebugRegisterPersonhood } from "@features/debug/DebugRegisterPersonhood.tsx";
import {
  readPersonhoodRegistration,
  writePersonhoodRegistration,
} from "@features/card/storage/personhood-registration-store.ts";

const OWNER = "5Owner";
const GAME = "5GameAccount";

let client: QueryClient;

function mount(playAccount = GAME) {
  const card = {
    kind: "card",
    accountAddress: OWNER,
    playerIdentities: { accountAddress: playAccount },
  } as never;
  render(
    <QueryClientProvider client={client}>
      <DebugRegisterPersonhood card={card} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  window.localStorage.clear();
  mocks.attempt.mockReset();
  mocks.probe.mockResolvedValue({ address: GAME, participant: "score 3/3", readyToRegister: true });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe("DebugRegisterPersonhood", () => {
  it("shows the configured game account index, its address and Score standing", async () => {
    mount();
    await screen.findByText(/game account index 1 \(config\): 5GameAccount — score 3\/3 · READY/);
    expect(screen.queryByText(/DIFFERENT/)).toBeNull();
  });

  it("flags a card read on another account", async () => {
    mount("5Elsewhere");
    await screen.findByText(/card plays as 5Elsewhere · DIFFERENT from the game account/);
  });

  it("runs the shared attempt at once, and only once while in flight", async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    mocks.attempt.mockReturnValueOnce(promise);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Register now (index 1)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Registering…" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Registering…" }));
    expect(mocks.attempt).toHaveBeenCalledTimes(1);
    expect(mocks.attempt).toHaveBeenCalledWith(OWNER, { source: "manual", playAccount: GAME });
    await act(async () => resolve({ kind: "refused", detail: "PermissionDenied" }));
  });

  it("clears the record the automatic gate reads", () => {
    writePersonhoodRegistration(OWNER, {
      status: "stopped",
      candidate: GAME,
      at: 1,
      kind: "failed",
      attempts: 3,
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Clear record" }));
    expect(readPersonhoodRegistration(OWNER)).toBeNull();
    expect(screen.getByText("record: none")).toBeTruthy();
  });
});
