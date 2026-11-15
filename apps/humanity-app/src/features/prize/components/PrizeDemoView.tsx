// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useNavigate } from "@tanstack/react-router";

import { MemberHomeScreen } from "@features/card/components/index.ts";
import { PromotionScreen } from "@features/card/components/PromotionScreen.tsx";
import type { OnboardingHintId } from "@features/card/storage/onboarding-hints-store.ts";
import {
  devCardFixture,
  devGameFixture,
  devTicketOpen,
  devUsernameClaimFixture,
  type PrizeDemoState,
} from "@features/prize/domain/prize-demo.ts";
import { formatDateLabel } from "@features/prize/domain/live-prize-surface.ts";
import type { PrizePageRouting } from "@features/prize/hooks/use-prize-page-routing.ts";
import {
  DailyPrizeScreen,
  type DailyPrizeTicketDisplay,
} from "./DailyPrizeScreen.tsx";

interface PrizeDemoViewProps {
  demoState: Exclude<PrizeDemoState, "live">;
  screen: PrizePageRouting["screen"];
  openDaily: () => void;
  closeDaily: () => void;
  /** Show an onboarding hint on the fixture, never remembered: `true` for
   *  the one the rules would pick, or a hint by name. */
  hint?: boolean | OnboardingHintId;
}

const DEV_TICKET: Omit<DailyPrizeTicketDisplay, "dateLabel"> = {
  amountLabel: "$1",
  oddsLabel: "",
  outcome: "win",
};

export function PrizeDemoView({
  demoState,
  screen,
  openDaily,
  closeDaily,
  hint = false,
}: PrizeDemoViewProps) {
  const navigate = useNavigate();
  if (demoState === "promotion") {
    const fixture = devCardFixture("promotion");
    return (
      <PromotionScreen
        fromState={fixture.state}
        // Fresh silver: the first week of membership, whatever the streak.
        toState={{ kind: "member", activeWeeks: 1, lastAttendedGame: 42, attendanceHistory: 0b0011_1111, window: 8 }}
        accountAddress={fixture.accountAddress}
        displayName={fixture.displayName}
        onChooseName={() => void navigate({ to: "/claim-username", search: { demo: "member-new" } })}
        onDismiss={() => void navigate({ to: "/", search: { demo: "member-new" } })}
      />
    );
  }
  if (screen === "daily") {
    return (
      <DailyPrizeScreen
        ticket={{
          ...DEV_TICKET,
          dateLabel: formatDateLabel(new Date()),
          outcome: demoState === "miss" ? "miss" : "win",
        }}
        onDone={closeDaily}
      />
    );
  }

  const fixture = devCardFixture(demoState);
  return (
    <MemberHomeScreen
      state={fixture.state}
      accountAddress={fixture.accountAddress}
      onOpenPrize={openDaily}
      game={devGameFixture(demoState)}
      gamePending={false}
      gameUnavailable={false}
      dailyPrizeAvailable={devTicketOpen(demoState)}
      displayName={fixture.displayName}
      usernameClaim={devUsernameClaimFixture(demoState)}
      qrPayload={fixture.accountAddress}
      hints={{ enabled: hint !== false, persist: false, only: typeof hint === "string" ? hint : undefined }}
      cautionSheet={{ enabled: true, persist: false }}
    />
  );
}
