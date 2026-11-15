// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useNavigate } from "@tanstack/react-router";

import { MemberHomeScreen } from "@features/card/components/MemberHomeScreen.tsx";
import { cardQrPayload } from "@features/card/domain/card-qr.ts";
import { PromotionScreen } from "@features/card/components/PromotionScreen.tsx";
import type { CurrentGameResult } from "@features/card/domain/current-game.ts";
import type { CardPromotionResult } from "@features/card/hooks/use-card-promotion.ts";
import type { HumanityCardResult } from "@humanity/shared/card/read-humanity-card.ts";
import { usernameClaimTarget } from "@humanity/shared/card/username-claim.ts";
import { suspensionRecovery } from "@features/card/domain/suspension-recovery.ts";

interface PrizeLiveHomeBlockProps {
  cardResult: Extract<HumanityCardResult, { kind: "card" }>;
  game: CurrentGameResult | null;
  gamePending: boolean;
  gameUnavailable: boolean;
  dailyPrizeAvailable: boolean;
  openDaily: () => void;
  /** The candidate → member moment, tracked by the page above this block. */
  promotion: CardPromotionResult;
  /** The automatic registration's quiet line, from the page above. */
  membershipNote: string | null;
  /** A sign-up of this account for the game on screen, Jollity's or this home's, is on its way or has landed. */
  signUpUnderWay: boolean;
}

export function PrizeLiveHomeBlock({
  cardResult,
  game,
  gamePending,
  gameUnavailable,
  dailyPrizeAvailable,
  openDaily,
  promotion: { promotion, dismiss },
  membershipNote,
  signUpUnderWay,
}: PrizeLiveHomeBlockProps) {
  const { accountAddress, primaryUsername } = cardResult;
  const navigate = useNavigate();
  // Score.register(None) resumes only an account Score itself suspended, so
  // the recovery line is only as specific as the participant key allows.
  const recovery =
    cardResult.participantKey === "account" ? suspensionRecovery(cardResult.snapshot) : "unknown";
  const target = usernameClaimTarget(cardResult);
  const openNameFlow = () => void navigate({ to: "/claim-username" });
  const usernameClaim =
    target.kind === "available"
      ? {
          currentUsername: target.currentLiteUsername,
          onOpen: openNameFlow,
        }
      : undefined;

  return (
    <>
      <MemberHomeScreen
        state={cardResult.state}
        accountAddress={cardResult.accountAddress}
        displayName={cardResult.primaryUsername}
        ownerAccount={cardResult.ownerAccount}
        game={game}
        gamePending={gamePending}
        gameUnavailable={gameUnavailable}
        seatAccount={cardResult.playerIdentities.accountAddress}
        onOpenPrize={openDaily}
        dailyPrizeAvailable={dailyPrizeAvailable}
        usernameClaim={usernameClaim}
        qrPayload={cardQrPayload(cardResult)}
        hints={{ enabled: promotion == null }}
        cautionSheet={{ enabled: promotion == null }}
        suspendedRecovery={recovery}
        membershipNote={membershipNote}
        signUpUnderWay={signUpUnderWay}
      />
      {promotion !== null && (
        <PromotionScreen
          fromState={promotion.from}
          toState={promotion.to}
          accountAddress={accountAddress}
          displayName={primaryUsername}
          // Putting the moment away leads straight on to the name: the
          // launch action, held back while the promotion showed, opens the
          // claim screen, and the home keeps offering it after that.
          onDismiss={dismiss}
          onChooseName={
            target.kind === "available"
              ? () => {
                  dismiss();
                  openNameFlow();
                }
              : undefined
          }
        />
      )}
    </>
  );
}
