// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Choosing a name: the card at the top wearing the name as it is typed,
 *  one line saying what happens, the form, and a way back. Claiming is a
 *  deliberate second tap because it cannot be undone. When the claim
 *  lands, the screen names it, with a burst, and says the card will show
 *  it: the card is drawn from a later read, and in the Pocket by the
 *  worker, so it can still carry the old name at that moment. Once the
 *  card read carries the name, and on any later visit, the screen says it
 *  is on the card. A claim that never landed is named above the form and
 *  offered again. Reached from the home row, the promotion, a notification,
 *  or a direct URL. The card is drawn only when the debug panel's card
 *  toggle shows it, as on the home and the promotion.
 *
 *  The name being typed lives with the page, which checks it against the
 *  chain; this screen previews it and never keeps a copy of its own. */
import { useEffect, useRef } from "react";
import { animate } from "motion";

import { Ambient, Screen } from "@shared/components/chrome.tsx";
import { useReducedMotion } from "@shared/hooks/motion.ts";
import { animationScope, pelletBurst } from "@shared/motion/motion.ts";
import { backOut } from "@shared/motion/ease.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import {
  FULL_USERNAME,
  type UsernameAvailability,
} from "@features/card/hooks/use-username-availability.ts";
import { useDebugStore } from "@features/debug/debug-store.ts";
import { MemberCard } from "./MemberCard.tsx";
import {
  UsernameUpgradeBlock,
  type UsernameUpgradeAction,
} from "./UsernameUpgradeBlock.tsx";

interface UsernameClaimCardView {
  state: HumanityCardState;
  accountAddress: string;
  displayName?: string;
}

export interface UsernameClaimScreenProps {
  /** The card whose name is being chosen; absent while it is unresolved. */
  card?: UsernameClaimCardView;
  action?: UsernameUpgradeAction;
  /** What the field holds: the name being typed, or the default on offer. */
  name?: string;
  /** The card's bare name, once it has one: claimed on this visit or before. */
  claimedName?: string | null;
  /** The claim landed on this visit, so the moment gets its burst. */
  justClaimed?: boolean;
  /** The card read carries the claimed name; false while it is catching up. */
  nameOnCard?: boolean;
  /** What the chain says about the name being typed. */
  availability?: UsernameAvailability;
  /** The form reports its value so the page can check the name. */
  onNameChange?: (value: string) => void;
  /** Why there is no form, when there is none. */
  message?: string;
  onBack: () => void;
}

export function UsernameClaimScreen({
  card,
  name = "",
  claimedName = null,
  justClaimed = false,
  nameOnCard = false,
  action,
  availability,
  onNameChange,
  message,
  onBack,
}: UsernameClaimScreenProps) {
  const reduced = useReducedMotion();
  const cardHidden = useDebugStore((state) => state.cardHidden);
  const screenRef = useRef<HTMLDivElement>(null);
  const cardWrapRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const confirmed = claimedName != null;
  const waiting = action?.unknown === true;
  const pending = !confirmed && (action?.pending === true || waiting);
  const current = action?.currentUsername ?? card?.displayName;
  const failedUsername = confirmed || pending ? undefined : action?.failedUsername;

  // The card wears the name as it is typed: a valid name previews, anything
  // else shows the name the card carries today.
  const preview = FULL_USERNAME.test(name) ? name : current;
  const shownName = confirmed ? claimedName : preview;

  // The form that had focus is gone once the name is claimed: say so where
  // a screen reader will start.
  useEffect(() => {
    if (confirmed) titleRef.current?.focus({ preventScroll: true });
  }, [confirmed]);

  // The claim landed: the card settles on its new name with a burst. With
  // the card hidden the burst still happens, from the title that says so.
  useEffect(() => {
    const screen = screenRef.current;
    const wrap = cardWrapRef.current;
    const anchor = wrap ?? titleRef.current;
    if (!confirmed || !justClaimed || reduced || screen == null || anchor == null) return;
    const scope = animationScope();
    if (wrap != null) {
      scope.add(animate(wrap, { scale: [0.97, 1] }, { duration: 0.5, ease: backOut(2) }));
    }
    pelletBurst(screen, {
      y: anchor.offsetTop + anchor.offsetHeight / 2,
      count: 20,
      colors: ["var(--fg-primary)", "var(--action-primary)", "#c9cdf4"],
      scope,
    });
    return () => scope.stop();
  }, [confirmed, justClaimed, reduced, cardHidden]);

  const title = confirmed
    ? `Your name is ${claimedName}`
    : pending
      ? "Claiming your name"
      : "Choose your name";
  // Permanence is said once, on the form; the line up here says what the
  // name does. With no claim on offer, the message below says why.
  const sub = confirmed
    ? nameOnCard
      ? "It's on your card now."
      : "It's yours. Your card will show it shortly."
    : waiting
      ? "We sent your claim and are waiting for it to be confirmed. You can leave this screen, and your card will update."
      : pending
        ? "This takes a moment."
        : action == null
          ? null
          : current == null
            ? "It replaces the numbers on your card."
            : `It replaces ${current} on your card.`;

  return (
    <Screen>
      <div className="name-screen" ref={screenRef}>
        <Ambient color={confirmed ? "rgba(244,114,182,0.14)" : "rgba(195,200,207,0.12)"} />
        <main className="body-col username-claim-col">
          {card != null && !cardHidden && (
            <div className="card-wrap" ref={cardWrapRef}>
              <MemberCard
                state={card.state}
                accountAddress={card.accountAddress}
                displayName={shownName}
              />
            </div>
          )}

          <header className="under-card">
            <h1 className="under-card-title" ref={titleRef} tabIndex={-1}>
              {title}
            </h1>
            {sub != null && <p className="under-card-sub">{sub}</p>}
          </header>

          {failedUsername != null && (
            <section className="card-block username-claim-message" aria-live="polite">
              {`Your last claim for ${failedUsername} didn't go through. Try again.`}
            </section>
          )}

          {confirmed ? null : action == null ? (
            <section className="card-block username-claim-message" aria-live="polite">
              {message}
            </section>
          ) : (
            <UsernameUpgradeBlock
              key={action.identityKey}
              {...action}
              availability={availability}
              onChange={onNameChange}
            />
          )}

          <button type="button" className="cta-pill is-quiet" onClick={onBack}>
            {confirmed ? "Back to your card" : "Not now"}
          </button>
        </main>
      </div>
    </Screen>
  );
}
