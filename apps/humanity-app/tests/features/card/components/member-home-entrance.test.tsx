// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The home's arrival: every block fades into place, including one that
 *  only exists once a later read lands. The daily-dollar tile waits on the
 *  standing and scratch reads, so it usually mounts after the column has
 *  already come in; it must not simply appear. */
import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Motion reads the frame clock when it loads, so the fake one goes in first.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
});

import { MemberHomeScreen } from "@features/card/components/MemberHomeScreen.tsx";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import { useDebugStore } from "@features/debug/debug-store.ts";

vi.mock("@features/card/hooks/use-register-for-game.ts", () => ({
  useRegisterForGame: () => ({ register: () => undefined, registering: false, registeringLabel: null, error: null }),
}));
vi.mock("qrcode", () => ({ toDataURL: () => Promise.resolve("data:image/png;base64,QR") }));

const MEMBER: HumanityCardState = {
  kind: "member",
  activeWeeks: 4,
  lastAttendedGame: 42,
  attendanceHistory: 0xff,
  window: 8,
};

beforeEach(() => {
  useDebugStore.setState({ cardHidden: true });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Math.floor(Date.now() / 1000);
const GAME: CurrentGameResult = {
  kind: "game",
  gameIndex: 7,
  gameDateSeconds: NOW + 7 * 86_400,
  registrationEndsSeconds: NOW + 3 * 3_600,
  playEndsSeconds: NOW + 3 * 3_600 + 300,
  airdropsScheduled: 1,
  phase: { label: "registration", nextDeadlineSeconds: NOW + 3 * 3_600, secondsRemaining: 3 * 3_600 },
  registered: true,
  liteSignUp: null,
};

function home(dailyPrizeAvailable: boolean, game: CurrentGameResult | null = null) {
  return (
    <MemberHomeScreen
      state={MEMBER}
      accountAddress="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"
      game={game}
      gamePending={game == null}
      gameUnavailable={false}
      onOpenPrize={() => undefined}
      dailyPrizeAvailable={dailyPrizeAvailable}
    />
  );
}

/** Long enough for any entrance on the screen to land. */
const arrive = () =>
  act(async () => {
    vi.advanceTimersByTime(3000);
  });

/** Whether an entrance is holding the tile at its start, not yet risen. */
const waiting = (tile: HTMLElement) => tile.style.opacity === "0";

const tileOf = (view: RenderResult) =>
  view.getByRole("button", { name: /Win a dollar today/ });

describe("MemberHomeScreen entrance", () => {
  it("fades the daily-dollar tile in when it mounts after the column has arrived", async () => {
    const view = render(home(false));
    await arrive();
    expect(view.queryByRole("button", { name: /Win a dollar today/ })).toBeNull();

    view.rerender(home(true));
    const tile = tileOf(view);

    expect(waiting(tile)).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    const midway = Number(tile.style.opacity);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1);
    await arrive();
    expect(tile.style.opacity).toBe("1");
  });

  it("draws nothing for the next game until it is read, then fades the block in", async () => {
    const view = render(home(false));
    await arrive();
    expect(view.queryByRole("region", { name: "Next game" })).toBeNull();

    view.rerender(home(false, GAME));
    const block = view.getByRole("region", { name: "Next game" });
    expect(waiting(block)).toBe(true);
    await arrive();
    expect(block.style.opacity).toBe("1");
  });

  it("lets the column's own stagger carry a tile that is there from the start", async () => {
    const view = render(home(true));
    const tile = tileOf(view);

    expect(waiting(tile)).toBe(true);
    await arrive();
    expect(tile.style.opacity).toBe("1");
  });

  it("shows a late tile at once under reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const view = render(home(false));
    view.rerender(home(true));
    const tile = tileOf(view);

    expect(waiting(tile)).toBe(false);
  });
});
