// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Full-screen celebration shown when a humanity card becomes a member:
 *  the candidate card flips into silver, then a pellet burst fires. It ends
 *  by offering the member's next step, choosing a name, and never claims
 *  one on its own: the link is public and permanent, so the person picks.
 *
 *  How the moment is staged is a `PromotionStyle`: the debug panel picks
 *  one to compare them in a host's short Pocket sheet, and every other
 *  build stages the default. */
import { useEffect, useRef, useState } from "react";
import { animate } from "motion";
import { Ambient } from "@shared/components/chrome.tsx";
import { useEnterStagger, useReducedMotion } from "@shared/hooks/motion.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";
import { MemberCard } from "./MemberCard.tsx";
import { useDebugStore } from "@features/debug/debug-store.ts";
import { DEFAULT_PROMOTION_STYLE } from "@features/card/domain/promotion-style.ts";
import { animationScope, pelletBurst } from "@shared/motion/motion.ts";
import { backOut, power2In } from "@shared/motion/ease.ts";
import {
  BEAT,
  BURST_COLORS,
  centreIn,
  PromotionActions,
  PromotionSub,
  PromotionTitle,
  type PromotionScreenProps,
} from "./PromotionParts.tsx";
import { CardlessPromotion, SweepPromotion } from "./PromotionVariants.tsx";
import "../styles/promotion.css";

export function PromotionScreen(props: PromotionScreenProps) {
  const picked = useDebugStore((state) => state.promotionStyle);
  const style = DEBUG_PANEL ? picked : DEFAULT_PROMOTION_STYLE;
  // Keyed: a style picked mid-celebration starts its own from the top
  // rather than inheriting another style's half-run animation.
  switch (style) {
    case "current":
      return <CardFlipPromotion key={style} {...props} fit={false} />;
    case "fit":
      return <CardFlipPromotion key={style} {...props} fit />;
    case "sweep":
      return <SweepPromotion key={style} {...props} />;
    case "card-less":
      return <CardlessPromotion key={style} {...props} />;
  }
}

/** The first design (`current`) and its height-aware cut (`fit`): the same
 *  flip, but `fit` sizes the card from the viewport, pins the actions to
 *  the bottom and bursts from the card's centre instead of a fixed height. */
function CardFlipPromotion({
  fromState,
  toState,
  accountAddress,
  displayName,
  onChooseName,
  onDismiss,
  fit,
}: PromotionScreenProps & { fit: boolean }) {
  const reduced = useReducedMotion();
  const cardHidden = useDebugStore((state) => state.cardHidden);
  const [shown, setShown] = useState<HumanityCardState>(
    reduced ? toState : fromState,
  );
  // The page above re-derives the promoted state on every card read, a new
  // object each time; the flip must not replay on each one, so it reads the
  // latest through a ref.
  const toStateRef = useRef(toState);
  toStateRef.current = toState;
  const overlayRef = useRef<HTMLDivElement>(null);
  const cardWrapRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  useEnterStagger([cardWrapRef, titleRef, subRef, ctaRef]);

  useEffect(() => {
    if (reduced) return;
    const overlay = overlayRef.current;
    if (overlay == null) return;
    // With the card hidden there is nothing to flip: the beat and the burst
    // still happen, since the host's own card is what changed.
    const wrapper = cardWrapRef.current;
    const scope = animationScope();
    const burst = () => {
      // `fit` aims at the card it just turned (or the title standing in for
      // it) and scales the spread to it; `current` keeps its fixed height.
      const origin = fit ? (wrapper ?? titleRef.current) : null;
      const at = origin == null ? null : centreIn(overlay, origin);
      const span = wrapper == null || at == null ? null : at.height;
      pelletBurst(overlay, {
        ...(at == null ? { y: overlay.clientHeight * 0.32 } : { x: at.x, y: at.y }),
        ...(span == null ? {} : { distMin: span * 0.55, distMax: span * 1.05 }),
        count: 20,
        colors: BURST_COLORS,
        scope,
      });
    };
    if (wrapper == null) {
      scope.later(burst, BEAT);
    } else {
      // Edge-on, the face changes unseen; the turn back overshoots, and the
      // burst fires as it is about to settle.
      void scope
        .add(animate(wrapper, { rotateY: [0, 90] }, { duration: 0.32, ease: power2In, delay: BEAT }))
        .then(() => {
          if (scope.stopped) return;
          setShown(toStateRef.current);
          scope.add(animate(wrapper, { rotateY: [90, 0] }, { duration: 0.6, ease: backOut(1.9) }));
          scope.later(burst, 0.3);
        });
    }
    return () => scope.stop();
  }, [reduced, cardHidden, fit]);

  return (
    <div className={fit ? "promotion-screen is-fit" : "promotion-screen"} ref={overlayRef}>
      <Ambient color="rgba(195,200,207,0.14)" />
      <div className="hero-col promotion-hero">
        {!cardHidden && (
          <div className="promotion-card-wrap" ref={cardWrapRef}>
            <MemberCard
              state={shown}
              accountAddress={accountAddress}
              displayName={displayName}
            />
          </div>
        )}
        <PromotionTitle ref={titleRef} />
        <PromotionSub ref={subRef} nameOnOffer={onChooseName != null} />
      </div>
      <PromotionActions ref={ctaRef} onChooseName={onChooseName} onDismiss={onDismiss} />
    </div>
  );
}
