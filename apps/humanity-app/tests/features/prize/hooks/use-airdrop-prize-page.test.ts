// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

/** Draw registration proves personhood against the `people` ring. The sweep
 *  must not run for a card whose key the ring does not hold yet: the proof
 *  fails as NotMember and the failure is logged on every standing refetch. */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RingPosition } from "@humanity/shared/chain/ring-membership.ts";

/** Jollity's record of a sign-up for `gameIndex`, fresh. */
const record = (
  gameIndex: number,
  phase: "registering" | "sent" | "registered" | "failed",
  surface: "chat" | "app" = "chat",
) => ({ gameIndex, phase, surface, at: Date.now(), attempt: 1 });

const mocks = vi.hoisted(() => ({
  membershipRing: null as RingPosition | null,
  autoRegisterEnabled: [] as boolean[],
  game: { data: undefined, isPending: false, error: null, dataUpdatedAt: 0, errorUpdatedAt: 0 } as Record<string, unknown>,
  registration: null as {
    gameIndex: number;
    phase: "registering" | "sent" | "registered" | "failed";
    surface: "chat" | "app";
    at: number;
    attempt: number;
  } | null,
  /** When Jollity's record was last read; ahead of any session by default. */
  registrationReadAt: Number.MAX_SAFE_INTEGER,
  gameSignUpInFlight: [] as boolean[],
}));

vi.mock("@features/card/hooks/use-humanity-card.ts", () => ({
  useHumanityCard: () => ({
    data: {
      kind: "card",
      primaryUsername: "marlow.12.paseo",
      accountAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      state: { kind: "member" },
      snapshot: { membershipRing: mocks.membershipRing },
    },
    error: null,
    isPending: false,
  }),
}));
vi.mock("@features/debug/use-debug-card-override.ts", () => ({
  useDebugCardOverride: <T,>(query: T) => query,
}));
vi.mock("@features/card/hooks/use-current-game.ts", () => ({
  useCurrentGame: (_card: unknown, _enabled: boolean, signUpInFlight: boolean) => {
    mocks.gameSignUpInFlight.push(signUpInFlight);
    return mocks.game;
  },
}));
vi.mock("@features/card/hooks/use-game-registration.ts", () => ({
  useGameRegistration: () => ({ data: mocks.registration, dataUpdatedAt: mocks.registrationReadAt, errorUpdatedAt: 0 }),
}));
vi.mock("@features/airdrops/hooks/use-airdrop-standing.ts", () => ({
  useAirdropStanding: () => ({ data: undefined, isPending: true, error: null }),
}));
vi.mock("@features/airdrops/hooks/use-auto-register-draws.ts", () => ({
  useAutoRegisterDraws: (_standing: unknown, enabled: boolean) => {
    mocks.autoRegisterEnabled.push(enabled);
    return { attempted: 0, registered: 0, failed: 0, lastError: null, inFlight: false };
  },
}));

import { useAirdropPrizePageData } from "@features/prize/hooks/use-airdrop-prize-page.ts";
import { getForegroundSession } from "@shared/session/foreground-session.ts";

afterEach(() => {
  mocks.game = { data: undefined, isPending: false, error: null, dataUpdatedAt: 0, errorUpdatedAt: 0 };
  mocks.autoRegisterEnabled.length = 0;
  mocks.membershipRing = null;
  mocks.registration = null;
  mocks.registrationReadAt = Number.MAX_SAFE_INTEGER;
  mocks.gameSignUpInFlight.length = 0;
});

describe("useAirdropPrizePageData, the draw sweep gate", () => {
  it("sweeps only a card whose key the people ring holds", () => {
    mocks.membershipRing = { kind: "included", ringIndex: 0, ringPage: 0 } as RingPosition;
    renderHook(() => useAirdropPrizePageData(true));
    expect(mocks.autoRegisterEnabled.at(-1)).toBe(true);
  });

  it.each<[string, RingPosition | null]>([
    ["an onboarding key, not in the ring yet", { kind: "onboarding", queuePage: 0, queuedAtSeconds: 0 } as RingPosition],
    ["a key the ring has no entry for", { kind: "absent" }],
    ["a lite-only card with no membership key", null],
  ])("never sweeps for %s", (_label, ring) => {
    mocks.membershipRing = ring;
    renderHook(() => useAirdropPrizePageData(true));
    expect(mocks.autoRegisterEnabled.at(-1)).toBe(false);
  });

  it("never sweeps a fixture page, whatever the ring says", () => {
    mocks.membershipRing = { kind: "included", ringIndex: 0, ringPage: 0 } as RingPosition;
    renderHook(() => useAirdropPrizePageData(false));
    expect(mocks.autoRegisterEnabled.at(-1)).toBe(false);
  });
});

describe("useAirdropPrizePageData, never a stale Register", () => {
  const notRegistered = { kind: "game", registered: false };

  it("holds a 'not registered' answer read before this foreground session", () => {
    const session = getForegroundSession();
    mocks.game = { data: notRegistered, isPending: false, error: null, dataUpdatedAt: session.startedAt - 1, errorUpdatedAt: 0 };
    const { result } = renderHook(() => useAirdropPrizePageData(true));
    expect(result.current.gameQuery).toMatchObject({ data: undefined, isPending: true });
  });

  it("shows it once this foreground session has read it", () => {
    const session = getForegroundSession();
    mocks.game = { data: notRegistered, isPending: false, error: null, dataUpdatedAt: session.startedAt, errorUpdatedAt: 0 };
    const { result } = renderHook(() => useAirdropPrizePageData(true));
    expect(result.current.gameQuery).toMatchObject({ data: notRegistered, isPending: false });
  });

  it("holds a fresh 'not registered' until Jollity's record is read again this session", () => {
    // Back from tapping Register in Jollity: the game read lands first, and
    // the record, read before the tap, still says nothing is on its way.
    const session = getForegroundSession();
    mocks.game = { data: notRegistered, isPending: false, error: null, dataUpdatedAt: session.startedAt, errorUpdatedAt: 0 };
    mocks.registrationReadAt = session.startedAt - 1;
    const held = renderHook(() => useAirdropPrizePageData(true)).result.current.gameQuery;
    expect(held).toMatchObject({ data: undefined, isPending: true });
    mocks.registrationReadAt = session.startedAt;
    const shown = renderHook(() => useAirdropPrizePageData(true)).result.current.gameQuery;
    expect(shown).toMatchObject({ data: notRegistered, isPending: false });
  });

  it("never holds a registration back", () => {
    const registered = { kind: "game", registered: true };
    mocks.game = { data: registered, isPending: false, error: null, dataUpdatedAt: 0, errorUpdatedAt: 0 };
    const { result } = renderHook(() => useAirdropPrizePageData(true));
    expect(result.current.gameQuery).toMatchObject({ data: registered, isPending: false });
  });
});

describe("useAirdropPrizePageData, a sign-up from Jollity", () => {
  const running = (gameIndex: number, registered: boolean | null) => ({
    kind: "game",
    gameIndex,
    registered,
    phase: { label: "registration" },
  });
  /** A read this foreground session has made, so the freshness hold lets it through. */
  const fresh = (data: unknown) => {
    mocks.game = { data, isPending: false, error: null, dataUpdatedAt: Date.now() + 60_000, errorUpdatedAt: 0 };
  };

  const signingUp = () => renderHook(() => useAirdropPrizePageData(true)).result.current.signUpUnderWay;

  it.each([
    ["registering from the chat", record(1304, "registering")],
    ["sent from the app", record(1304, "sent", "app")],
    ["registered for the chat", record(1304, "registered")],
  ])("holds the game on screen as signing up while Jollity's sign-up is %s, until the chain reads it registered", (_label, registration) => {
    mocks.registration = registration;
    fresh(running(1304, false));
    expect(signingUp()).toBe(true);
    // The chain caught up: the chain is the answer again.
    fresh(running(1304, true));
    expect(signingUp()).toBe(false);
  });

  it("offers Register again once Jollity's sign-up failed", () => {
    mocks.registration = record(1304, "failed");
    fresh(running(1304, false));
    expect(signingUp()).toBe(false);
  });

  it("re-reads the game quickly while Jollity's sign-up is on its way or landed, not after it failed", () => {
    mocks.registration = record(1304, "sent");
    renderHook(() => useAirdropPrizePageData(true));
    expect(mocks.gameSignUpInFlight.at(-1)).toBe(true);
    mocks.registration = record(1304, "registered");
    renderHook(() => useAirdropPrizePageData(true));
    expect(mocks.gameSignUpInFlight.at(-1)).toBe(true);
    mocks.registration = record(1304, "failed");
    renderHook(() => useAirdropPrizePageData(true));
    expect(mocks.gameSignUpInFlight.at(-1)).toBe(false);
    mocks.registration = null;
    renderHook(() => useAirdropPrizePageData(true));
    expect(mocks.gameSignUpInFlight.at(-1)).toBe(false);
  });

  it.each([
    ["another game", running(1305, false)],
    ["an unknown registration", running(1304, null)],
    ["no game", { kind: "no-game", gameIndex: 1303 }],
  ])("ignores Jollity's sign-up for %s", (_label, game) => {
    mocks.registration = record(1304, "registering");
    fresh(game);
    expect(signingUp()).toBe(false);
  });
});
