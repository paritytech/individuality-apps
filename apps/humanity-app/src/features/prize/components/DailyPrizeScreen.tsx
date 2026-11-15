// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Daily-dollar scratch screen: the scratch card and nothing else. It sits
 *  as large as the screen comfortably allows; the card itself says what it
 *  is and, once scratched, what happened. There is no close control: the
 *  screen is left through the button the reveal brings (or by the host
 *  closing the card), so a scratch cannot be abandoned halfway.
 *
 *  Reveal timing is owned here, not in the scratch card: a win shows its button after 1200ms, a miss after
 *  600ms. Reduced motion keeps the delay but skips the fade. `onDone` fires
 *  from that button, which is how the screen is closed after a reveal.
 *
 *  Nothing of the result exists before the scratch: the button is mounted
 *  by the reveal itself, so nothing invisible can take focus, be read out by
 *  assistive tech, or reserve layout while the foil is still intact.
 *
 *  The optional `claim` prop wires the live win path. Scratching the foil open
 *  IS the claim intent, so the reveal submits it — the button never waits on
 *  it: it dismisses the card, and only offers "Claim $1" again when the
 *  attempt failed and nothing else is in flight. Dev fixtures omit the prop.
 *
 *  Under an open Pocket card the screen asks the host to move the card's face
 *  away for as long as it is up, so the scratch card gets the whole screen;
 *  the face comes back when the screen closes. */
import { useEffect, useRef, useState } from "react";
import { animate } from "motion";

import { Ambient, Screen } from "@shared/components/chrome.tsx";
import { placeAt, useReducedMotion } from "@shared/hooks/motion.ts";
import { power3Out } from "@shared/motion/ease.ts";
import { ScratchCard, type ScratchOutcome } from "./ScratchCard.tsx";

export interface DailyPrizeTicketDisplay {
  outcome: ScratchOutcome;
  amountLabel: string;
  dateLabel: string;
  oddsLabel: string;
}

/** Live win-only claim flow. Omitted for dev fixtures. The claim is already
 *  in flight when this screen opens and keeps running after the user leaves,
 *  so the button never waits on it: it dismisses the card, and only offers
 *  "Claim $1" again when the attempt failed and nothing else is in flight. */
export interface DailyPrizeClaimState {
  pending: boolean;
  claimed: boolean;
  unknown: boolean;
  failed: boolean;
  onClaim: () => void;
}

export interface DailyPrizeScreenProps {
  ticket: DailyPrizeTicketDisplay;
  onDone: () => void;
  /** When supplied on a win, the button claims the live dollar. */
  claim?: DailyPrizeClaimState;
  /** Fires once, when the surface is scratched open. A miss settles here —
   *  there is nothing to claim — so the same card is not offered again. */
  onRevealed?: (outcome: ScratchOutcome) => void;
  /** The user already scratched this card open, so the result is shown
   *  exposed and the foil is never offered again. A win the claim has
   *  already banked is not "revealed": the scratch is still owed. */
  revealed?: boolean;
}

/** Button lifecycle. `hidden`: unscratched, nothing rendered. `enter`:
 *  mounted for the fade/slide. `shown`: settled, React owns opacity again. */
type AfterPhase = "hidden" | "enter" | "shown";

export function DailyPrizeScreen({
  ticket,
  onDone,
  claim,
  onRevealed,
  revealed = false,
}: DailyPrizeScreenProps) {
  const reduced = useReducedMotion();
  const afterRef = useRef<HTMLDivElement>(null);
  const armed = useRef(revealed);
  const revealTimerRef = useRef<number | null>(null);
  const [afterPhase, setAfterPhase] = useState<AfterPhase>(revealed ? "shown" : "hidden");

  useEffect(
    () => () => {
      if (revealTimerRef.current != null) {
        window.clearTimeout(revealTimerRef.current);
      }
    },
    [],
  );

  const handleReveal = (outcome: ScratchOutcome) => {
    if (armed.current) return;
    armed.current = true;
    onRevealed?.(outcome);
    const delay = outcome === "win" ? 1200 : 600;
    revealTimerRef.current = window.setTimeout(() => {
      revealTimerRef.current = null;
      setAfterPhase(reduced ? "shown" : "enter");
    }, delay);
  };

  useEffect(() => {
    if (afterPhase !== "enter") return;
    const el = afterRef.current;
    if (el == null) return;
    placeAt([el], { opacity: 0, y: 14 });
    const rise = animate(el, { opacity: [0, 1], y: [14, 0] }, { duration: 0.45, ease: power3Out });
    let live = true;
    void rise.then(() => {
      if (live) setAfterPhase("shown");
    });
    return () => {
      live = false;
      rise.stop();
    };
  }, [afterPhase]);

  const isWin = ticket.outcome === "win";
  const liveClaim = isWin ? claim : undefined;
  const retry =
    liveClaim != null &&
    liveClaim.failed &&
    !liveClaim.claimed &&
    !liveClaim.pending &&
    !liveClaim.unknown;
  const ctaLabel = retry ? "Claim $1" : isWin ? "Nice" : "See you tomorrow";
  const handleCta = retry ? liveClaim.onClaim : onDone;

  return (
    <Screen className="scratch-screen" hideCardFace>
      <Ambient color="rgba(220,224,232,0.1)" />
      <div className="hero-col scratch-stage">
        <ScratchCard
          outcome={ticket.outcome}
          amountLabel={ticket.amountLabel}
          dateLabel={ticket.dateLabel}
          oddsLabel={ticket.oddsLabel}
          onReveal={handleReveal}
          revealed={revealed}
        />
      </div>
      <div className="cta-col scratch-after">
        {afterPhase === "hidden" ? null : (
          <div
            ref={afterRef}
            className="scratch-after-inner"
            style={{ opacity: afterPhase === "shown" ? 1 : 0 }}
          >
            <button
              type="button"
              className={"cta-pill" + (isWin ? "" : " is-quiet")}
              onClick={handleCta}
            >
              {ctaLabel}
            </button>
            {/* With no close control, a failed claim must not be the only
                way on: the dollar stays owed and is offered again next time. */}
            {retry ? (
              <button type="button" className="cta-ghost" onClick={onDone}>
                Not now
              </button>
            ) : null}
          </div>
        )}
      </div>
    </Screen>
  );
}
