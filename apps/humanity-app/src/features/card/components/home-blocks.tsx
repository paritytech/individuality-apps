// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Reusable home-screen layout blocks — chain-truthful, no fake data. */
import type { Ref } from "react";

import { Icon } from "@shared/components/icons.tsx";

/** `title`/`sub` are nullable: some states say nothing under the card, and
 *  an empty header would still take vertical rhythm. */
export interface UnderCardProps { title: string | null; sub: string | null; }
export function UnderCard({ title, sub }: UnderCardProps) {
  if (title == null && sub == null) return null;
  return (
    <header className="under-card" data-testid="home-notice">
      {title == null ? null : <h1 className="under-card-title">{title}</h1>}
      {sub == null ? null : <p className="under-card-sub">{sub}</p>}
    </header>
  );
}

/** The daily-dollar entry: one bordered row, on the home only while a ticket
 *  is open. The chat line and the push are what bring a person to it; this
 *  is where they land. Nothing about winnings lives here — the scratch
 *  screen keeps its own tally. */
export function DailyDollarTile({ onOpen, ref }: { onOpen: () => void; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button type="button" className="route-card is-dollar" onClick={onOpen} ref={ref}>
      <div className="route-tile is-dollar">$1</div>
      <div className="route-text">
        <div className="route-title">Win a dollar today</div>
        <div className="route-sub">One try a day</div>
      </div>
      <Icon name="chevron-right" size={18} className="route-arrow" />
    </button>
  );
}

export interface NameClaimRowProps {
  /** The numbered name the card carries today. */
  currentUsername: string;
  onOpen: () => void;
}

/** A member's next step once the card is silver: the member username.
 *  Rendered only while the claim is on offer; the flow itself lives at
 *  `/claim-username`. */
export function NameClaimRow({ currentUsername, onOpen }: NameClaimRowProps) {
  return (
    <button type="button" className="route-card" onClick={onOpen}>
      <div className="route-tile"><Icon name="at" size={20} /></div>
      <div className="route-text">
        <div className="route-title">Claim your member username</div>
        {/* Not "becomes marlow": the bare name can be taken, and any name will do. */}
        <div className="route-sub">Choose a name to replace {currentUsername}</div>
      </div>
      <Icon name="chevron-right" size={18} className="route-arrow" />
    </button>
  );
}
