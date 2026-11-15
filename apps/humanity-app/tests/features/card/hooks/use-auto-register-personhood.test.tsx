// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The home sends `Score.register` by itself once the card clears the
 *  threshold — never twice at once: not on a re-render, a remount, or a
 *  reload mid-flight. A stop is retried by itself in the same launch once
 *  its backoff runs out, and the home never shows why it stopped. */
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  registerPersonhood: vi.fn(),
  resolveGameAccount: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@features/card/chain/register-personhood.ts", () => ({
  registerPersonhood: mocks.registerPersonhood,
}));
vi.mock("@humanity/shared/identity/game-account.ts", () => ({
  GAME_ACCOUNT_INDEX: 1,
  resolveGameAccount: mocks.resolveGameAccount,
}));
vi.mock("@humanity/shared/logging/logger.ts", () => ({
  loggerFor: () => ({ info: mocks.loggerInfo, error: vi.fn(), warning: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@humanity/shared/chain/client.ts", () => ({
  getPeopleClient: vi.fn(() => Promise.resolve({ api: {}, client: {}, network: {} })),
}));
vi.mock("@features/debug/debug-mutation-journal.ts", () => ({ recordMutation: vi.fn() }));

import {
  FINISHING_MEMBERSHIP_NOTE,
  WAITING_FOR_RING_NOTE,
  resetAutoRegisterPersonhoodForTests,
  useAutoRegisterPersonhood,
} from "@features/card/hooks/use-auto-register-personhood.ts";
import { SENT_SETTLE_MS, stopBackoffMs } from "@features/card/domain/personhood-registration.ts";
import {
  readPersonhoodRegistration,
  writePersonhoodRegistration,
} from "@features/card/storage/personhood-registration-store.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import {
  registrationDiagnostics,
  resetRegistrationDiagnosticsForTests,
} from "@features/card/chain/registration-diagnostics.ts";

const OWNER = "5Owner";
const CANDIDATE = "5Candidate";

function card(state: object): HumanityCardResult {
  return {
    kind: "card",
    accountAddress: OWNER,
    state,
    playerIdentities: { accountAddress: CANDIDATE },
  } as unknown as HumanityCardResult;
}
const ready = () =>
  card({ kind: "membership-ready", activeWeeks: 1, lastAttendedGame: 4, attendanceHistory: 1, window: 8 });
const candidate = (score: number) =>
  card({ kind: "candidate", score, personhoodThreshold: 6, gamesRemaining: 0 });

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client }, children);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  window.localStorage.clear();
  resetAutoRegisterPersonhoodForTests();
  mocks.registerPersonhood.mockReset();
  mocks.resolveGameAccount.mockReset();
  mocks.loggerInfo.mockReset();
  resetRegistrationDiagnosticsForTests();
  mocks.resolveGameAccount.mockResolvedValue({ address: CANDIDATE, signer: {} });
});

afterEach(() => {
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useAutoRegisterPersonhood", () => {
  it("fires once when the card clears the threshold, whatever re-renders follow", async () => {
    mocks.registerPersonhood.mockResolvedValue({
      kind: "registered",
      confirmed: true,
      txHash: "0x1",
      candidate: CANDIDATE,
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { rerender, unmount } = renderHook(({ c }) => useAutoRegisterPersonhood(c, true), {
      wrapper,
      initialProps: { c: ready() },
    });
    await waitFor(() => expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1));
    rerender({ c: ready() });
    rerender({ c: ready() });
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["chain", "humanity-card"] }),
    );
    unmount();
    renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await Promise.resolve();
    expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1);
    expect(mocks.registerPersonhood.mock.calls[0]?.[0]).toMatchObject({
      candidate: { address: CANDIDATE },
    });
    expect(readPersonhoodRegistration(OWNER)).toMatchObject({ status: "sent", txHash: "0x1" });
  });

  it("fires for a candidate at the threshold, and never below it", async () => {
    mocks.registerPersonhood.mockResolvedValue({ kind: "not-ready", detail: "x" });
    const below = renderHook(() => useAutoRegisterPersonhood(candidate(5), true), { wrapper });
    await Promise.resolve();
    expect(mocks.registerPersonhood).not.toHaveBeenCalled();
    expect(below.result.current).toBeNull();
    below.unmount();
    renderHook(() => useAutoRegisterPersonhood(candidate(6), true), { wrapper });
    await waitFor(() => expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1));
  });

  it("says nothing once the chain answers there is nothing to send", async () => {
    mocks.registerPersonhood.mockResolvedValue({ kind: "not-ready", detail: "no participant" });
    const { result } = renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await waitFor(() => expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current).toBeNull());
    expect(readPersonhoodRegistration(OWNER)).toBeNull();
  });

  it("says the wait can take a while once the key is queued for the ring", async () => {
    // Recognised by the score, so the chain has nothing left to send, and
    // the ring is what the person is waiting on.
    mocks.registerPersonhood.mockResolvedValue({ kind: "not-ready", detail: "already recognised" });
    const queued = {
      ...ready(),
      membershipStanding: { position: { kind: "onboarding", queuePage: 0, queuedAtSeconds: 1 }, ring: null },
    } as unknown as HumanityCardResult;
    const { result } = renderHook(() => useAutoRegisterPersonhood(queued, true), { wrapper });
    await waitFor(() => expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(WAITING_FOR_RING_NOTE);
    expect(readPersonhoodRegistration(OWNER)).toBeNull();
  });

  it("never fires for a member", async () => {
    const { result } = renderHook(
      () => useAutoRegisterPersonhood(card({ kind: "member", activeWeeks: 1, lastAttendedGame: 4, attendanceHistory: 1, window: 8 }), true),
      { wrapper },
    );
    await Promise.resolve();
    expect(mocks.registerPersonhood).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("retries a stop by itself in the same launch, and only says it is finishing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.registerPersonhood
      .mockResolvedValueOnce({ kind: "failed", reason: "f", detail: "RPC error: subscription dropped" })
      .mockResolvedValueOnce({ kind: "registered", confirmed: true, txHash: "0x3", candidate: CANDIDATE });
    const { result } = renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await waitFor(() =>
      expect(readPersonhoodRegistration(OWNER)).toMatchObject({ status: "stopped", attempts: 1 }),
    );
    expect(result.current).toBe(FINISHING_MEMBERSHIP_NOTE);
    expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(stopBackoffMs(1)));
    await waitFor(() =>
      expect(readPersonhoodRegistration(OWNER)).toMatchObject({ status: "sent", txHash: "0x3" }),
    );
    expect(mocks.registerPersonhood).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(FINISHING_MEMBERSHIP_NOTE);
  });

  it("holds a stop for its backoff, then retries it without a relaunch", async () => {
    const at = 1_000_000;
    writePersonhoodRegistration(OWNER, {
      status: "stopped",
      candidate: CANDIDATE,
      at,
      kind: "refused",
      attempts: 1,
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(at + stopBackoffMs(1) - 1);
    const hook = renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await Promise.resolve();
    expect(mocks.registerPersonhood).not.toHaveBeenCalled();
    expect(hook.result.current).toBe(FINISHING_MEMBERSHIP_NOTE);

    now.mockReturnValue(at + stopBackoffMs(1));
    mocks.registerPersonhood.mockResolvedValue({ kind: "refused", reason: "r", detail: "d" });
    hook.rerender();
    await waitFor(() => expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(readPersonhoodRegistration(OWNER)).toMatchObject({ status: "stopped", attempts: 2 }),
    );
  });

  it("does not resend after a reload while a registration is on its way", async () => {
    const at = 5_000_000;
    writePersonhoodRegistration(OWNER, { status: "sending", candidate: CANDIDATE, at });
    vi.spyOn(Date, "now").mockReturnValue(at + SENT_SETTLE_MS - 1);
    const { result } = renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await Promise.resolve();
    expect(mocks.registerPersonhood).not.toHaveBeenCalled();
    expect(result.current).toBe(FINISHING_MEMBERSHIP_NOTE);
  });

  it("keeps a sent record when the chain says there is nothing left to send", async () => {
    const at = 5_000_000;
    writePersonhoodRegistration(OWNER, { status: "sent", candidate: CANDIDATE, at, txHash: "0x9" });
    vi.spyOn(Date, "now").mockReturnValue(at + SENT_SETTLE_MS);
    mocks.registerPersonhood.mockResolvedValue({ kind: "not-ready", detail: "recognised" });
    renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await waitFor(() => expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(readPersonhoodRegistration(OWNER)).toEqual({
        status: "sent",
        candidate: CANDIDATE,
        at,
        txHash: "0x9",
      }),
    );
  });

  it("shows the finishing line while the registration is in flight", async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    mocks.registerPersonhood.mockImplementationOnce(() => promise);
    const { result } = renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await waitFor(() => expect(result.current).toBe(FINISHING_MEMBERSHIP_NOTE));
    resolve({ kind: "registered", confirmed: false, txHash: "0x2", candidate: CANDIDATE });
    await waitFor(() =>
      expect(readPersonhoodRegistration(OWNER)).toMatchObject({ status: "sent" }),
    );
    expect(result.current).toBe(FINISHING_MEMBERSHIP_NOTE);
  });
  it("logs each gate decision once per change of inputs, not per render", async () => {
    const gateLines = () =>
      mocks.loggerInfo.mock.calls.filter(([message]) => String(message).startsWith("stage gate"));
    const { rerender } = renderHook(({ c, live }) => useAutoRegisterPersonhood(c, live), {
      wrapper,
      initialProps: { c: candidate(4), live: false },
    });
    rerender({ c: candidate(4), live: false });
    await Promise.resolve();
    expect(gateLines().map(([, props]) => (props as { kind: string }).kind)).toEqual(["not-live"]);
    rerender({ c: candidate(4), live: true });
    rerender({ c: candidate(4), live: true });
    await waitFor(() => expect(gateLines()).toHaveLength(2));
    const notReady = gateLines()[1]?.[1] as { kind: string; detail: string };
    expect(notReady.kind).toBe("not-ready");
    expect(notReady.detail).toContain("candidate, score 4/6");
    expect(notReady.detail).toContain(`card plays as ${CANDIDATE}`);
    expect(registrationDiagnostics().gate?.kind).toBe("not-ready");
    expect(mocks.registerPersonhood).not.toHaveBeenCalled();
  });

  it("records the run's stages and outcome for the panel, and logs the configured index", async () => {
    mocks.registerPersonhood.mockImplementationOnce(async ({ onStage }: { onStage: (s: string) => void }) => {
      onStage("sign: ringVrfSign");
      return { kind: "refused", reason: "r", detail: "PermissionDenied" };
    });
    renderHook(() => useAutoRegisterPersonhood(ready(), true), { wrapper });
    await waitFor(() => expect(registrationDiagnostics().run?.outcome).not.toBeNull());
    expect(registrationDiagnostics().run).toMatchObject({
      source: "auto",
      stages: ["sign: ringVrfSign"],
      outcome: { kind: "refused", detail: "PermissionDenied" },
    });
    const candidateLine = mocks.loggerInfo.mock.calls.find(([message]) =>
      String(message).startsWith("stage candidate"),
    );
    expect(candidateLine?.[1]).toMatchObject({ index: 1, candidate: CANDIDATE, relation: "same account" });
  });
  it("fires once when two mounted homes see the threshold in the same render", async () => {
    mocks.registerPersonhood.mockResolvedValue({ kind: "not-ready", detail: "x" });
    renderHook(
      () => {
        useAutoRegisterPersonhood(ready(), true);
        useAutoRegisterPersonhood(ready(), true);
      },
      { wrapper },
    );
    await waitFor(() => expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.registerPersonhood).toHaveBeenCalledTimes(1);
  });
});
