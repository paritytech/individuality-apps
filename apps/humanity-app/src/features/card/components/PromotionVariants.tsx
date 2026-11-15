// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The promotion styles drawn for a short viewport, the sheet a host with a
 *  Pocket opens the app in, beneath its own card:
 *  - `SweepPromotion`: a compact card rises, turns silver, catches a light
 *    sweep and throws its burst from behind its edges; the words follow.
 *  - `CardlessPromotion`: the host's card is already on screen, so no card
 *    of its own; a silver medallion pops in with the burst instead.
 *  Both place every block before the first paint, so nothing flashes in
 *  settled, and reduced motion shows the final state with no burst. */
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { animate, stagger } from "motion";
import { Ambient } from "@shared/components/chrome.tsx";
import { placeAt, showSettled, useReducedMotion } from "@shared/hooks/motion.ts";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { useDebugStore } from "@features/debug/debug-store.ts";
import { animationScope, pelletBurst, type AnimationScope } from "@shared/motion/motion.ts";
import { backOut, power2In, power2InOut, power2Out, power3Out } from "@shared/motion/ease.ts";
import { SILVER_BASE_VARS } from "./card-materials.ts";
import { MemberCard } from "./MemberCard.tsx";
import {
  BURST_COLORS,
  centreIn,
  PromotionActions,
  PromotionSub,
  PromotionTitle,
  type PromotionScreenProps,
} from "./PromotionParts.tsx";

/** The words and the way on rise together, a step apart. */
const COPY_FROM = { opacity: 0, y: 14 };

function present<T>(value: T | null): value is T {
  return value != null;
}

function revealCopy(scope: AnimationScope, copy: HTMLElement[], startDelay = 0): void {
  scope.add(
    animate(
      copy,
      { opacity: [0, 1], y: [COPY_FROM.y, 0] },
      { duration: 0.5, ease: power3Out, delay: stagger(0.08, { startDelay }) },
    ),
  );
}

export function SweepPromotion({
  fromState,
  toState,
  accountAddress,
  displayName,
  onChooseName,
  onDismiss,
}: PromotionScreenProps) {
  const reduced = useReducedMotion();
  const cardHidden = useDebugStore((state) => state.cardHidden);
  const [shown, setShown] = useState<HumanityCardState>(reduced ? toState : fromState);
  // The page above re-derives the promoted state on every card read, a new
  // object each time; the timeline must not restart on each one, so it reads
  // the latest through a ref.
  const toStateRef = useRef(toState);
  toStateRef.current = toState;
  const heroRef = useRef<HTMLDivElement>(null);
  const cardWrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const hero = heroRef.current;
    if (hero == null) return;
    const wrapper = cardWrapRef.current;
    const copy = [titleRef.current, subRef.current, ctaRef.current].filter(present);
    if (reduced) {
      showSettled(wrapper == null ? copy : [wrapper, ...copy]);
      return;
    }
    const scope = animationScope();
    placeAt(copy, COPY_FROM);
    // Pellets live in the hero, under the card: they start at its centre
    // hidden behind the face and show as they clear its edges.
    const burst = (origin: HTMLElement) => {
      const at = centreIn(hero, origin);
      pelletBurst(hero, {
        x: at.x,
        y: at.y,
        count: 26,
        colors: BURST_COLORS,
        distMin: at.width * 0.42,
        distMax: at.width * 0.72,
        scope,
      });
    };

    const frame = frameRef.current;
    if (wrapper == null || frame == null) {
      // No card of its own: the host's changed, so a short beat, then the
      // burst where the title lands and the words.
      scope.later(() => {
        if (titleRef.current != null) burst(titleRef.current);
        revealCopy(scope, copy);
      }, 0.5);
      return () => scope.stop();
    }

    placeAt([wrapper], { opacity: 0, y: 28, scale: 0.94 });
    scope.add(
      animate(
        wrapper,
        { opacity: [0, 1], y: [28, 0], scale: [0.94, 1] },
        { duration: 0.55, ease: power3Out },
      ),
    );
    // Timed off the scope rather than chained on the turn's promise: the
    // rise and the turn both write the wrapper's transform.
    const TURN = 0.85;
    const EDGE_ON = TURN + 0.28;
    scope.add(animate(wrapper, { rotateY: [0, 90] }, { duration: 0.28, ease: power2In, delay: TURN }));
    // Edge-on, the face changes unseen and the turn back overshoots.
    scope.later(() => {
      setShown(toStateRef.current);
      scope.add(animate(wrapper, { rotateY: [90, 0] }, { duration: 0.55, ease: backOut(1.6) }));
    }, EDGE_ON);
    // As the face settles: the burst, the light across the new silver, then
    // the words.
    scope.later(() => {
      revealCopy(scope, copy, 0.2);
      burst(frame);
      const band = bandRef.current;
      if (band != null) {
        scope.add(animate(band, { x: ["-110%", "210%"] }, { duration: 0.85, ease: power2InOut }));
      }
    }, EDGE_ON + 0.28);
    return () => scope.stop();
  }, [reduced, cardHidden]);

  return (
    <div className="promotion-screen is-sweep">
      <Ambient color="rgba(195,200,207,0.14)" />
      <div className="hero-col promotion-hero" ref={heroRef}>
        {!cardHidden && (
          <div className="promotion-card-wrap" ref={cardWrapRef}>
            <div className="promotion-card-frame" ref={frameRef}>
              <MemberCard state={shown} accountAddress={accountAddress} displayName={displayName} />
              <div className="promotion-sweep" aria-hidden="true">
                <span className="promotion-sweep-band" ref={bandRef} />
              </div>
            </div>
          </div>
        )}
        <PromotionTitle ref={titleRef} />
        <PromotionSub ref={subRef} nameOnOffer={onChooseName != null} />
      </div>
      <PromotionActions ref={ctaRef} onChooseName={onChooseName} onDismiss={onDismiss} />
    </div>
  );
}

/** When the medallion lands after the sheet opens. */
const POP = 0.3;

export function CardlessPromotion({ onChooseName, onDismiss }: PromotionScreenProps) {
  const reduced = useReducedMotion();
  const heroRef = useRef<HTMLDivElement>(null);
  const medalRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const sheenRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const subRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const hero = heroRef.current;
    const medal = medalRef.current;
    if (hero == null || medal == null) return;
    const copy = [titleRef.current, subRef.current, ctaRef.current].filter(present);
    if (reduced) {
      showSettled([medal, ...copy]);
      return;
    }
    const scope = animationScope();
    placeAt([medal], { opacity: 0, scale: 0.35 });
    placeAt(copy, COPY_FROM);
    scope.add(animate(medal, { opacity: [0, 1] }, { duration: 0.2, ease: power2Out, delay: POP }));
    scope.add(
      animate(
        medal,
        { scale: [0.35, 1], rotate: [-28, 0] },
        { duration: 0.7, ease: backOut(1.9), delay: POP },
      ),
    );
    // At the top of the overshoot: the burst from behind the medallion and a
    // ring off its rim.
    scope.later(() => {
      const at = centreIn(hero, medal);
      pelletBurst(hero, {
        x: at.x,
        y: at.y,
        count: 24,
        colors: BURST_COLORS,
        distMin: at.width * 0.6,
        distMax: at.width * 1.1,
        scope,
      });
      const ring = ringRef.current;
      if (ring != null) {
        scope.add(
          animate(ring, { opacity: [0.75, 0], scale: [1, 1.9] }, { duration: 0.8, ease: power2Out }),
        );
      }
    }, POP + 0.22);
    revealCopy(scope, copy, POP + 0.4);
    scope.later(() => {
      const sheen = sheenRef.current;
      if (sheen == null) return;
      scope.add(animate(sheen, { x: ["-120%", "220%"] }, { duration: 0.9, ease: power2InOut }));
    }, POP + 0.75);
    return () => scope.stop();
  }, [reduced]);

  return (
    <div className="promotion-screen is-cardless">
      <Ambient color="rgba(195,200,207,0.18)" />
      <div className="hero-col promotion-hero" ref={heroRef}>
        <div className="promotion-medal-wrap" ref={medalRef} aria-hidden="true">
          <span className="promotion-medal-ring" ref={ringRef} />
          <div className="promotion-medal" style={SILVER_BASE_VARS as CSSProperties}>
            <div className="promotion-medal-face">
              <svg className="promotion-medal-check" viewBox="0 0 24 24">
                <path d="M6.6 12.6l3.5 3.5 7.3-7.6" />
              </svg>
            </div>
            <span className="promotion-medal-sheen" ref={sheenRef} />
          </div>
        </div>
        <PromotionTitle ref={titleRef} />
        <PromotionSub ref={subRef} nameOnOffer={onChooseName != null} />
      </div>
      <PromotionActions ref={ctaRef} onChooseName={onChooseName} onDismiss={onDismiss} />
    </div>
  );
}
