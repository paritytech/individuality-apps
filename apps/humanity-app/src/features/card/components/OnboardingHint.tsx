// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** One anchored tip: a small card under (or above) the thing it explains,
 *  a title and one line, an arrow on the target's centre line. Tapping it
 *  anywhere, the cross, or Escape puts it away. It is measured against the
 *  column it lives in, so it lands right whatever the card has shrunk to,
 *  and re-measured whenever the column or any block in it changes size or
 *  comes and goes (a game read landing late, the dollar tile arriving). The
 *  home mounts it only once the entrance has settled, so the first
 *  measurement is the real one; reduced motion shows it at rest.
 *
 *  The target is described by the tip (`aria-describedby`) while it is up,
 *  and the tip is a polite live region, so a screen reader hears it both
 *  when it appears and when the target is focused. */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { Icon } from "@shared/components/icons.tsx";
import type { OnboardingHintId } from "@features/card/storage/onboarding-hints-store.ts";

const ONBOARDING_HINT_ID = "onboarding-hint";

/** The tip's geometry, in the column's coordinates. */
interface Placement {
  left: number;
  top: number;
  /** Where the arrow sits along the tip, from its left edge. */
  arrow: number;
  side: "below" | "above";
}

const GAP = 10;
const EDGE = 12;
const ARROW_INSET = 18;
/** A tap this soon after a tip appears was aimed at the one before it. */
const TAP_GUARD_MS = 450;

/** Put a target's own description back as it was. */
function restore({ target, before }: { target: HTMLElement; before: string | null }): void {
  if (before == null) target.removeAttribute("aria-describedby");
  else target.setAttribute("aria-describedby", before);
}

/** Place a tip of `width`×`height` against `target` inside `column`, on the
 *  preferred side when there is room for it there, the other side when not. */
export function placeHint(
  target: { left: number; top: number; width: number; height: number },
  column: { left: number; top: number; width: number; height: number },
  tip: { width: number; height: number },
  prefer: "below" | "above" = "below",
): Placement {
  const centre = target.left + target.width / 2 - column.left;
  const left = Math.min(
    Math.max(EDGE, centre - tip.width / 2),
    Math.max(EDGE, column.width - EDGE - tip.width),
  );
  const arrow = Math.min(Math.max(ARROW_INSET, centre - left), tip.width - ARROW_INSET);
  const below = target.top + target.height - column.top + GAP;
  const above = target.top - column.top - GAP - tip.height;
  const belowFits = below + tip.height <= column.height - EDGE;
  const aboveFits = above >= 0;
  const side = prefer === "above" ? (aboveFits ? "above" : "below") : belowFits ? "below" : "above";
  return side === "below" ? { left, top: below, arrow, side } : { left, top: above, arrow, side };
}

export interface OnboardingHintProps {
  id: OnboardingHintId;
  title: string;
  body: string;
  /** The column the tip is positioned in; targets carry `data-hint`. */
  columnRef: RefObject<HTMLElement | null>;
  /** Which side of the target to sit on when both fit. */
  prefer?: "below" | "above";
  onDismiss: () => void;
}

export function OnboardingHint({ id, title, body, columnRef, prefer = "below", onDismiss }: OnboardingHintProps) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [tipRef, setTipRef] = useState<HTMLDivElement | null>(null);
  const mountedAt = useRef(0);

  useLayoutEffect(() => {
    const column = columnRef.current;
    if (column == null || tipRef == null) return;
    let described: { target: HTMLElement; before: string | null } | null = null;
    const describe = (target: HTMLElement | null) => {
      if (described?.target === target) return;
      if (described != null) restore(described);
      described = null;
      if (target == null) return;
      described = { target, before: target.getAttribute("aria-describedby") };
      target.setAttribute(
        "aria-describedby",
        [described.before, ONBOARDING_HINT_ID].filter(Boolean).join(" "),
      );
    };
    const measure = () => {
      const target = column.querySelector<HTMLElement>(`[data-hint="${id}"]`);
      describe(target);
      if (target == null) {
        setPlacement(null);
        return;
      }
      setPlacement(
        placeHint(target.getBoundingClientRect(), column.getBoundingClientRect(), tipRef.getBoundingClientRect(), prefer),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    // Blocks resize, and blocks arrive: watch every child of the column, and
    // start watching new ones as they mount.
    const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const watchChildren = () => {
      if (sizes == null) return;
      sizes.disconnect();
      sizes.observe(column);
      for (const child of Array.from(column.children)) {
        if (child !== tipRef) sizes.observe(child);
      }
    };
    watchChildren();
    const arrivals =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            watchChildren();
            measure();
          });
    arrivals?.observe(column, { childList: true });
    return () => {
      window.removeEventListener("resize", measure);
      sizes?.disconnect();
      arrivals?.disconnect();
      if (described != null) restore(described);
    };
  }, [columnRef, id, prefer, tipRef]);

  useEffect(() => {
    mountedAt.current = Date.now();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  const dismissByTap = () => {
    if (Date.now() - mountedAt.current < TAP_GUARD_MS) return;
    onDismiss();
  };

  const style =
    placement == null
      ? { visibility: "hidden" as const }
      : ({
          left: `${placement.left}px`,
          top: `${placement.top}px`,
          "--hint-arrow": `${placement.arrow}px`,
        } as React.CSSProperties);

  return (
    <div
      className={`hint-tip is-${placement?.side ?? "below"}`}
      id={ONBOARDING_HINT_ID}
      role="tooltip"
      aria-live="polite"
      data-hint-for={id}
      ref={setTipRef}
      style={style}
      onClick={dismissByTap}
    >
      <div className="hint-tip-title">{title}</div>
      <div className="hint-tip-body">{body}</div>
      <button
        type="button"
        className="hint-tip-dismiss"
        onClick={(event) => {
          event.stopPropagation();
          dismissByTap();
        }}
        aria-label="Dismiss this tip"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
