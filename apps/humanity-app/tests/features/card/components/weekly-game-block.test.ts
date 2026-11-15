// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** DIM2 owns the signed game step. When the seat's bind is the only thing
 * missing, the block's one "Register" binds it in-app (the home hands off to
 * DIM2 once it lands), and it hands off directly when DIM2 can complete it. */
import { describe, expect, it, vi, beforeEach } from "vitest";

import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WeeklyGameBlock } from "@features/card/components/WeeklyGameBlock.tsx";
import { navigateTo } from "@humanity/shared/chain/host-api.ts";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { dim2Url, resolveNetwork } from "@humanity/shared/chain/networks.ts";

vi.mock("@humanity/shared/chain/host-api.ts", () => ({
  navigateTo: vi.fn(() => Promise.resolve({ ok: true, value: undefined })),
}));
const navigate = vi.mocked(navigateTo);

/** The handoff target is the configured network's game deploy, never a literal
 *  URL: previewnet and paseo-next-v2 carry different TLDs. */
const DIM2_URL = dim2Url(resolveNetwork(envConfig.chain.network));

/** Depth-first search for the first `<button>` in a rendered element tree. */
function findButton(node: ReactNode): {
  disabled?: boolean;
  onClick?: () => void;
} | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  };
  if (node.type === "button") return props;
  return findButton(props.children ?? null);
}

const now = 1_800_000_000;
const DAY = 86_400;
const HOUR = 3_600;

/** A registration-phase game a week out with registration closing in 3h. */
function game(overrides: Partial<CurrentGameResult> = {}): CurrentGameResult {
  return {
    kind: "game",
    gameIndex: 7,
    gameDateSeconds: now + 7 * DAY,
    registrationEndsSeconds: now + 3 * HOUR,
    playEndsSeconds: now + 3 * HOUR + 300,
    airdropsScheduled: 1,
    phase: {
      label: "registration",
      nextDeadlineSeconds: now + 3 * HOUR,
      secondsRemaining: 3 * HOUR,
    },
    registered: false,
    liteSignUp: null,
    ...overrides,
  } as CurrentGameResult;
}

function render(
  result: CurrentGameResult,
  firstGame = false,
  registering = false,
  registerError: string | null = null,
): string {
  return renderToStaticMarkup(
    createElement(WeeklyGameBlock, {
      game: result,
      pending: false,
      unavailable: false,
      nowSeconds: now,
      firstGame,
      registering,
      registerError,
    }),
  );
}

function clickFirstButton(
  result: CurrentGameResult,
  nowSeconds = now,
  firstGame = false,
  onRegister?: () => void,
  registering = false,
): void {
  const button = findButton(
    WeeklyGameBlock({
      game: result,
      pending: false,
      unavailable: false,
      nowSeconds,
      firstGame,
      onRegister,
      registering,
    }),
  );
  button?.onClick?.();
}

beforeEach(() => {
  navigate.mockClear();
  navigate.mockResolvedValue({ ok: true, value: undefined } as never);
});

describe("WeeklyGameBlock registration-open", () => {
  it("offers an enabled button rather than an inert pill", () => {
    const html = render(game());
    expect(html).toContain("<button");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("is-unavailable");
  });

  it("says nothing below the call to action", () => {
    const html = render(game());
    expect(html).toContain("Register");
    expect(html).not.toContain("block-note");
  });

  it("greets a first-time player with first-game copy", () => {
    const html = render(game(), true);
    expect(html).toContain("Your first game");
    expect(html).toContain("Register");
    expect(html).not.toContain('card-label">Next game');
  });

  it("keeps the returning-player header and action", () => {
    const html = render(game());
    expect(html).toContain("Next game");
    expect(html).not.toContain("Your first game");
  });

  it("signs a returning player up here rather than handing off", () => {
    const register = vi.fn();
    clickFirstButton(game(), now, false, register);
    expect(register).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("signs the first game up here too", () => {
    const register = vi.fn();
    clickFirstButton(game(), now, true, register);
    expect(register).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("holds Register while the sign-up is in flight", () => {
    const html = render(game(), false, true);
    expect(html).toContain("Registering…");
    expect(html).toContain("disabled");
  });

  it("shows a failed sign-up under the button, which stays available", () => {
    const html = render(game(), false, false, "You cancelled the approval.");
    expect(html).toContain("You cancelled the approval.");
    expect(html).toContain("Register");
    expect(html).not.toContain("disabled");
  });
});

describe("WeeklyGameBlock confirmed seat", () => {
  it("keeps the confirmation tappable and opens the game", () => {
    const registered = game({ registered: true });
    const html = render(registered);
    expect(html).toContain("Registered");
    expect(html).toContain("cta-confirmed");
    expect(html).toContain("<button");

    clickFirstButton(registered);
    expect(navigate).toHaveBeenCalledWith(DIM2_URL);
  });
});

describe("WeeklyGameBlock unavailable and unknown states", () => {
  it("omits the block when the game read is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(WeeklyGameBlock, {
        game: null,
        pending: false,
        unavailable: true,
        nowSeconds: now,
      }),
    );

    expect(html).toBe("");
    expect(html).not.toContain("couldn");
  });

  it("keeps the known game header, date, and countdown without a seat note", () => {
    const html = render(game({ registered: null }));

    expect(html).toContain("Next game");
    expect(html).toMatch(/class="card-value">[^<]+</);
    expect(html).toContain("in 7 days");
    expect(html).not.toContain("block-note");
    expect(html).not.toContain("couldn");
  });
});

describe("WeeklyGameBlock closed and live phases", () => {
  it("keeps a closed game noninteractive", () => {
    const html = render(
      game({
        phase: { label: "reporting", nextDeadlineSeconds: null, secondsRemaining: null },
      }),
    );
    expect(html).not.toContain("<button");
  });

  it("shows a disabled 'Game results pending' once the player's game is over, in place of Play now", () => {
    const over = game({
      registered: true,
      registrationEndsSeconds: now - HOUR,
      playEndsSeconds: now - 1,
      phase: { label: "reporting", nextDeadlineSeconds: null, secondsRemaining: null },
    });
    const html = render(over);
    expect(html).toContain("Game results pending");
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).not.toContain("Play now");
    expect(html).toContain("results pending");
    expect(html).toContain("It may take a little while to process.");
    clickFirstButton(over);
    expect(navigate).not.toHaveBeenCalled();
    // one second earlier the game is still on, and Play now hands off
    const playing = game({ ...over, playEndsSeconds: now + 1 } as Partial<CurrentGameResult>);
    expect(render(playing)).toContain("Play now");
  });

  it("keeps Play Now on the same game deploy", () => {
    clickFirstButton(
      game({
        registered: true,
        phase: {
          label: "shuffle",
          nextDeadlineSeconds: null,
          secondsRemaining: null,
        },
      }),
      now + 4 * HOUR,
    );
    expect(navigate).toHaveBeenCalledWith(DIM2_URL);
  });
});
