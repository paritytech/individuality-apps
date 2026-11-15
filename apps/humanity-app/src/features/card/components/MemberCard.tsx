// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The humanity identity card — the designed material/status families driven
 *  by chain-derived HumanityCardState. Rank is material only: nothing prints
 *  on the face but the name, the wordmark, the QR glyph, a candidate's
 *  stripe and a warning sash. No fake rank, name, or product data.
 *
 *  An interactive card turns over — the glyph, or a sideways drag — to a
 *  back that carries the person's code etched into the same material. The
 *  whole back is a button that turns it home, so a keyboard can go both
 *  ways, and focus follows the face that shows. The light
 *  (pointer/orientation) moves across both faces and honours reduced
 *  motion. */
import { useEffect, useRef, type CSSProperties } from "react";
import type { HumanityCardState } from "@humanity/shared/card/humanity-card-state.ts";
import { segmentFills } from "@humanity/shared/card/progress-stripe.ts";
import { cardStatusLabel } from "@features/card/domain/card-journey-hints.ts";
import { CARD_QR_NOTE, qrInkFor } from "@features/card/domain/card-qr.ts";
import { useCardFlip } from "@features/card/hooks/use-card-flip.ts";
import { useCardParallax } from "@features/card/hooks/use-card-parallax.ts";
import { Icon } from "@shared/components/icons.tsx";
import { PolkadotWordmark } from "./PolkadotWordmark.tsx";
import { resolveCardStyle } from "./card-state-resolve.ts";

export interface MemberCardProps {
  state: HumanityCardState;
  accountAddress: string;
  /** The resolved identity name, including the lite suffix until a claim
   *  finalizes. Omitted names fall back to the shortened owner address. */
  displayName?: string;
  /** The username's owner account, as read at the finalized block; null or
   *  omitted when the name has no owner on chain. Carried only as
   *  `data-account` for end-to-end readers (docs/test-ids.md). */
  ownerAccount?: string | null;
  /** Whether the card turns over. Off by default: the promotion overlay
   *  flips a card of its own and must not meet a drag. */
  interactive?: boolean;
  /** What the code on the back says; null draws the back with the name
   *  alone. Read only when `interactive`. */
  qrPayload?: string | null;
  /** Called once per completed turn. */
  onFlip?: () => void;
  /** Called whenever the face on show changes, with true for the back. */
  onFaceChange?: (back: boolean) => void;
}

/** Membership changes the card material, not ownership of its name.
 * The data layer supplies a different name only after a finalized claim. */
export function memberDisplayName(_state: HumanityCardState, displayName: string | undefined): string | undefined {
  return displayName?.trim();
}

/** The `data-*` hooks end-to-end readers check the card against the chain
 *  with (docs/test-ids.md). Each figure appears only in the states that
 *  carry it. */
function cardDataAttributes(state: HumanityCardState, ownerAccount: string | null | undefined) {
  return {
    "data-card-state": state.kind,
    ...(ownerAccount != null && ownerAccount !== "" ? { "data-account": ownerAccount } : {}),
    ...(state.kind === "candidate" ? { "data-score": state.score } : {}),
    ...(state.kind === "caution" ? { "data-misses": state.misses } : {}),
    ...(state.kind === "membership-ready" || state.kind === "member" || state.kind === "caution"
      ? { "data-streak": state.activeWeeks }
      : {}),
  };
}

/** The card's identity label and avatar initial: the host-provided DotNS
 *  username when there is one, otherwise the shortened owner address. The
 *  initial keeps the name's own case, as the Pocket card prints it. */
function identityLabels(accountAddress: string, displayName: string | undefined, state: HumanityCardState) {
  const name = memberDisplayName(state, displayName);
  return name != null && name !== ""
    ? { nameLabel: name, initial: name.charAt(0) }
    : {
        nameLabel: `${accountAddress.slice(0, 6)}…${accountAddress.slice(-4)}`,
        initial: accountAddress.charAt(2).toUpperCase() || "H",
      };
}

export function MemberCard({
  state,
  accountAddress,
  displayName,
  ownerAccount,
  interactive = false,
  qrPayload = null,
  onFlip,
  onFaceChange,
}: MemberCardProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const glyphRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  useCardParallax(rootRef);
  const { flipped, qrMask, flip, rootProps } = useCardFlip(rootRef, bodyRef, {
    enabled: interactive,
    payload: qrPayload,
    onFlip,
  });
  const onFaceChangeRef = useRef(onFaceChange);
  onFaceChangeRef.current = onFaceChange;
  useEffect(() => {
    onFaceChangeRef.current?.(flipped);
    // The face that was focused is hidden now: carry focus to the control on
    // the face that shows, so a keyboard is never left on nothing.
    const focused = document.activeElement;
    if (flipped && focused === glyphRef.current) backRef.current?.focus({ preventScroll: true });
    if (!flipped && focused === backRef.current) glyphRef.current?.focus({ preventScroll: true });
  }, [flipped]);

  const { vars, hasPill, pillText, isSash, isFaded, isSuspended, stripe } =
    resolveCardStyle(state);
  const { nameLabel, initial } = identityLabels(accountAddress, displayName, state);
  const candidateScore =
    state.kind === "candidate"
      ? { score: state.score, threshold: state.personhoodThreshold }
      : state.kind === "devicehood" && state.personhoodThreshold != null
        ? { score: 0, threshold: state.personhoodThreshold }
        : null;
  const style = {
    ...vars,
    "--c-qr": qrInkFor(String(vars["--c-b1" as keyof typeof vars] ?? ""), String(vars["--c-b2" as keyof typeof vars] ?? "")),
    ...(qrMask == null ? {} : { "--qr-mask": `url("${qrMask}")` }),
  } as CSSProperties;

  const classes = ["idcard", stripe != null ? "has-stripe" : "", hasPill ? "has-pill" : "",
    isSash ? "is-sash" : "", isFaded ? "is-faded" : "",
    isSuspended ? "is-suspended" : "", interactive ? "is-interactive" : "",
    flipped ? "is-flipped" : ""].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      ref={rootRef}
      style={style}
      data-summon-ignore=""
      data-testid="membership-card"
      {...cardDataAttributes(state, ownerAccount)}
      {...(interactive ? rootProps : {})}
    >
      <div className="idcard-body" ref={bodyRef}>
        <div className="idcard-edge" aria-hidden="true" />
        <div className="idcard-inner">
          <div className="idcard-holo" />
          <div className="idcard-sheen" />
          <div className="idcard-grain" />
          <PolkadotWordmark className="idcard-wordmark" />

          {isSash && <div className="idcard-sash" aria-hidden="true" />}

          <div className="idcard-top">
            <div className="idcard-avatar">{initial}</div>
            <div className="idcard-idcol">
              <div className="idcard-name" data-testid="card-username">{nameLabel}</div>
              <span className="sr-only" data-testid="card-label">{cardStatusLabel(state)}</span>
            </div>
          </div>

          {interactive ? (
            <button
              type="button"
              className="idcard-qr"
              ref={glyphRef}
              aria-label="Flip the card"
              data-hint="card"
              onClick={flip}
            >
              <Icon name="qr" size={24} />
            </button>
          ) : (
            <span className="idcard-qr" aria-hidden="true" data-hint="card">
              <Icon name="qr" size={24} />
            </span>
          )}

          {stripe != null && candidateScore != null && (
            <CandidateStripe share={stripe} score={candidateScore} />
          )}

          {hasPill && (
            <div className="idcard-pill" role="status" data-testid="card-badge">{pillText}</div>
          )}

          {interactive && (
            <div className="idcard-back" aria-hidden={!flipped}>
              {qrPayload != null && (
                // The relief keeps its place while the code loads; its layers
                // wait for the mask, since unmasked they would paint a square.
                <div className="idcard-qr-relief" data-testid="card-qr" role="img" aria-label="Your code" aria-busy={qrMask == null}>
                  {qrMask != null && (
                    <>
                      <i className="qr-lo" />
                      <i className="qr-hi" />
                      <i className="qr-face" />
                    </>
                  )}
                </div>
              )}
              <div className="idcard-back-name">{nameLabel}</div>
              {qrPayload != null && <div className="idcard-back-note">{CARD_QR_NOTE}</div>}
              <button
                type="button"
                ref={backRef}
                className="idcard-back-turn"
                aria-label="Turn the card back"
                onClick={flip}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A fixed row of skewed segments filled by the share of the threshold
 *  covered, lit in the current heat rank's accent. Each segment passes on
 *  how full it is and how much fill lies before it; the stylesheet turns that
 *  into one left-to-right sweep on mount and a width transition after. */
function CandidateStripe({
  share,
  score,
}: {
  share: number;
  /** The chain figures the stripe stands for. */
  score: { score: number; threshold: number };
}) {
  const fills = segmentFills(share);
  let before = 0;
  return (
    <div
      className="idcard-stripe"
      data-hint="stripe"
      role="img"
      aria-label={`Progress to membership: ${score.score} of ${score.threshold}`}
    >
      {fills.map((fill, i) => {
        const style = { "--seg-fill": fill, "--seg-before": before } as CSSProperties;
        before += fill;
        return <i key={i} style={style} />;
      })}
    </div>
  );
}
