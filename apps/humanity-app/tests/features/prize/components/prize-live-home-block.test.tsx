// @vitest-environment jsdom
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The promotion over the live home: "Choose your name" goes to the name
 *  screen, and "Not now" puts the moment away without putting the name
 *  away: the member home offers the claim, and the launch may open it. */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), dismissAction: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@shared/navigation/humanity-action-session.tsx", () => ({
  useHumanityActionSession: () => ({ dismiss: mocks.dismissAction, dismissed: [], refreshing: false }),
}));
vi.mock("@features/card/hooks/use-register-for-game.ts", () => ({
  useRegisterForGame: () => ({ register: () => undefined, registering: false, registeringLabel: null, error: null }),
}));
vi.mock("qrcode", () => ({ toDataURL: () => Promise.resolve("data:image/png;base64,QR") }));

import { PrizeLiveHomeBlock } from "@features/prize/components/PrizeLiveHomeBlock.tsx";
import { usernameClaimTarget } from "@humanity/shared/card/username-claim.ts";

const ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const member = { kind: "member", activeWeeks: 1, lastAttendedGame: 42, attendanceHistory: 1, window: 8 } as const;
const cardResult = {
  kind: "card",
  primaryUsername: "marlow.42",
  accountAddress: ACCOUNT,
  ownerAccount: ACCOUNT,
  participantKey: "account",
  state: member,
  playerIdentities: { accountAddress: "5Game" },
  snapshot: { isUpgradedIdentity: false, participant: { recognition: "NotRecognized" } },
} as never;

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.dismissAction.mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const dismiss = vi.fn();
  render(
    <PrizeLiveHomeBlock
      cardResult={cardResult}
      game={null}
      gamePending={false}
      gameUnavailable={false}
      dailyPrizeAvailable={false}
      openDaily={() => undefined}
      membershipNote={null}
      promotion={{
        promotion: {
          from: { kind: "candidate", score: 6, personhoodThreshold: 6, gamesRemaining: 0 },
          to: member,
        } as never,
        dismiss,
      }}
    />,
  );
  return dismiss;
}

describe("PrizeLiveHomeBlock promotion", () => {
  it("offers a fresh member with a numbered lite name the claim", () => {
    expect(usernameClaimTarget(cardResult)).toMatchObject({
      kind: "available",
      currentLiteUsername: "marlow.42",
    });
  });

  it("leaves the name on offer once the moment is put away", async () => {
    function Page() {
      const [latched, setLatched] = useState(true);
      return (
        <PrizeLiveHomeBlock
          cardResult={cardResult}
          game={null}
          gamePending={false}
          gameUnavailable={false}
          dailyPrizeAvailable={false}
          openDaily={() => undefined}
          membershipNote={null}
          promotion={{
            promotion: latched
              ? ({
                  from: { kind: "membership-ready", activeWeeks: 1, lastAttendedGame: 42, attendanceHistory: 1, window: 8 },
                  to: member,
                } as never)
              : null,
            dismiss: () => setLatched(false),
          }}
        />
      );
    }
    render(<Page />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    });
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    // Not dismissed for the visit: the launch action may still open the claim.
    expect(mocks.dismissAction).not.toHaveBeenCalled();
    expect(screen.getByText("Claim your member username")).toBeTruthy();
  });

  it("goes to the name screen from the moment", async () => {
    const dismiss = mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose your name" }));
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/claim-username" });
  });
});
