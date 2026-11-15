// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** What every promotion style shares: its props, its words and its way on.
 *  The copy never changes between styles, only how the moment is staged. */
import type { Ref } from "react";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";

export interface PromotionScreenProps {
  fromState: HumanityCardState;
  toState: HumanityCardState;
  accountAddress: string;
  displayName: string;
  /** Opens the name flow, when a name is on offer to this card. */
  onChooseName?: () => void;
  onDismiss: () => void;
}

/** How long the old card is shown before it turns. */
export const BEAT = 1.0;

export const BURST_COLORS = ["var(--fg-primary)", "var(--action-primary)", "#c9cdf4"];

/** Where `el`'s centre sits in `host`'s own coordinates, and how big it is:
 *  a burst is placed relative to the element it is appended to. */
export function centreIn(
  host: HTMLElement,
  el: HTMLElement,
): { x: number; y: number; width: number; height: number } {
  const hostRect = host.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left - hostRect.left + rect.width / 2,
    y: rect.top - hostRect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
  };
}

export function PromotionTitle({ ref }: { ref?: Ref<HTMLHeadingElement> }) {
  return (
    <h2 className="promotion-title" ref={ref}>
      You&apos;re a member
    </h2>
  );
}

export function PromotionSub({
  nameOnOffer,
  ref,
}: {
  nameOnOffer: boolean;
  ref?: Ref<HTMLParagraphElement>;
}) {
  return (
    <p className="promotion-sub" ref={ref}>
      {nameOnOffer
        ? "Your card is silver. Members can claim a username without the number."
        : "Your card is silver. Members get a daily chance to win a dollar."}
    </p>
  );
}

export function PromotionActions({
  onChooseName,
  onDismiss,
  ref,
}: Pick<PromotionScreenProps, "onChooseName" | "onDismiss"> & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div className="cta-col" ref={ref}>
      {onChooseName == null ? (
        <button type="button" className="cta-pill" onClick={onDismiss}>
          Back to your card
        </button>
      ) : (
        <>
          <button type="button" className="cta-pill" onClick={onChooseName}>
            Choose your name
          </button>
          <button type="button" className="cta-ghost" onClick={onDismiss}>
            Not now
          </button>
        </>
      )}
    </div>
  );
}
