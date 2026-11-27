// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { UsernameClaimScreen } from "@features/card/components/UsernameClaimScreen.tsx";
import { useHumanityCard } from "@features/card/hooks/use-humanity-card.ts";
import { useUsernameUpgradeAction } from "@features/card/hooks/use-username-upgrade-action.ts";
import { useUsernameAvailability } from "@features/card/hooks/use-username-availability.ts";
import { useFullPersonhood } from "@features/card/hooks/use-full-personhood.ts";
import { membershipRootPending, usernameClaimTarget } from "@humanity/shared/card/username-claim.ts";
import { parseHumanityUserId } from "@humanity/shared/identity/humanity-user-id.ts";
import { blockingError } from "@shared/chain/query-state.ts";
import { useHumanityActionSession } from "@shared/navigation/humanity-action-session.tsx";

function unavailableMessage(
  pending: boolean,
  failed: boolean,
  target: ReturnType<typeof useUsernameUpgradeAction>["target"],
  preparing: boolean,
): string {
  if (pending) return "Checking your card.";
  // Ahead of `failed`: the full-personhood probe also fails while the ring
  // root does not cover the key yet, and that is a wait, not an error.
  if (target.kind === "upgrade-unavailable") return "Username upgrades aren't available here yet.";
  if (preparing) return "Preparing your membership. Your name will be ready in a moment.";
  if (failed) return "Couldn't check your card. Go back and try again.";
  if (target.kind === "already-claimed") return "Your name has no numbers to drop.";
  return "Your card isn't ready for a name yet. Membership comes first.";
}

export function UsernameClaimPage() {
  const search = useSearch({ strict: false }) as { demo?: string };
  if (import.meta.env.DEV && typeof search.demo === "string") {
    return <DemoClaimPage demo={search.demo} />;
  }
  return <LiveClaimPage />;
}

function LiveClaimPage() {
  const navigate = useNavigate();
  const { dismiss } = useHumanityActionSession();
  const cardQuery = useHumanityCard();
  const card = cardQuery.data;
  const checkRing =
    card?.kind === "card" && usernameClaimTarget(card).kind === "not-ready";
  const personhood = useFullPersonhood(
    card?.kind === "card" ? card.primaryUsername : undefined,
    checkRing,
  );
  const { target, action } = useUsernameUpgradeAction(
    card,
    true,
    checkRing && personhood.data === true,
  );
  // Being here is the launch's one chance to offer the name this visit: the
  // screen must not open again however the person leaves (the buttons, the
  // system back, a deep link away). Marked on arrival, not on the way out:
  // leaving mounts the home in the same commit, and its auto-open would run
  // before an unmount's update landed.
  useEffect(() => {
    dismiss("claim-username");
  }, [dismiss]);

  // What the field holds, for the identity it was typed for: a wallet
  // switch starts again from that wallet's own default.
  const identityKey = action?.identityKey ?? "";
  const [typed, setTyped] = useState<{ key: string; value: string } | null>(null);
  const name = typed?.key === identityKey ? typed.value : (action?.suggestedUsername ?? "");
  // What was sent, so the moment of success names it even before the card
  // read catches up.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const availability = useUsernameAvailability(
    name,
    action != null && !action.pending && !action.unknown && !action.confirmed,
    identityKey,
  );
  // The card has its bare name: claimed just now (the card read may still be
  // catching up) or on an earlier visit.
  const claimedName =
    target.kind === "already-claimed" && card?.kind === "card"
      ? (parseHumanityUserId(card.primaryUsername)?.username ?? card.primaryUsername)
      : action?.confirmed === true
        ? (submitted ?? name)
        : null;
  const failed =
    blockingError(cardQuery.error, card) != null ||
    (checkRing && personhood.error != null);
  const pending =
    (cardQuery.isPending && card == null) ||
    (checkRing && personhood.isPending);

  return (
    <UsernameClaimScreen
      card={
        card?.kind === "card"
          ? { state: card.state, accountAddress: card.accountAddress, displayName: card.primaryUsername }
          : undefined
      }
      name={name}
      claimedName={claimedName}
      justClaimed={submitted != null}
      action={
        pending || failed || action == null
          ? undefined
          : {
              ...action,
              currentUsername:
                target.kind === "available" ? target.currentLiteUsername : undefined,
              onSubmit: (fullUsername: string) => {
                setSubmitted(fullUsername);
                setTyped({ key: identityKey, value: fullUsername });
                action.onSubmit(fullUsername);
              },
            }
      }
      availability={availability}
      onNameChange={(value) => setTyped({ key: identityKey, value })}
      message={unavailableMessage(pending, failed, target, membershipRootPending(card))}
      onBack={() => {
        dismiss("claim-username");
        void navigate({ to: "/", search: { demo: undefined } });
      }}
    />
  );
}

/** DEV-only: the claim screen on a fixture member, no chain. `marlowe`
 *  reads as taken so the taken line can be seen; anything else valid reads
 *  as free. `?demo=failed` names a last claim that never landed. Any `demo`
 *  value opens it; the card shown is always a member. */
const DEMO_FIXTURE = {
  accountAddress: "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5",
  displayName: "marlow.42",
  state: {
    kind: "member",
    activeWeeks: 3,
    lastAttendedGame: 42,
    attendanceHistory: 0b1110_1111,
    window: 8,
  },
} as const;

function DemoClaimPage({ demo }: { demo: string }) {
  const navigate = useNavigate();
  const fixture = DEMO_FIXTURE;
  const [typed, setTyped] = useState("marlow");
  const [submitted, setSubmitted] = useState(false);
  const valid = /^[a-z]{6,32}$/.test(typed);
  const availability = !valid
    ? typed === ""
      ? ({ status: "idle" } as const)
      : ({ status: "invalid" } as const)
    : typed === "marlowe"
      ? ({ status: "taken", name: typed } as const)
      : ({ status: "available", name: typed } as const);
  return (
    <UsernameClaimScreen
      card={{ state: fixture.state, accountAddress: fixture.accountAddress, displayName: fixture.displayName }}
      name={typed}
      claimedName={submitted ? typed : null}
      justClaimed={submitted}
      action={{
        identityKey: "demo",
        currentUsername: fixture.displayName,
        suggestedUsername: "marlow",
        failedUsername: demo === "failed" ? "marlow" : undefined,
        pending: false,
        unknown: false,
        confirmed: submitted,
        onSubmit: () => setSubmitted(true),
      }}
      availability={availability}
      onNameChange={setTyped}
      onBack={() => void navigate({ to: "/", search: { demo } })}
    />
  );
}
