// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Live-prize empty state — the one unavoidable new surface. Shown on
 *  Paseo Next V2 when there is no active daily dollar (no active game, no
 *  airdrops, or between draws). Same Humanity visual system (quiet zinc,
 *  pill button, hairline). Copy is supplied by the parent via `message`; no
 *  invented product feature. The CTA is optional: card failures self-heal on
 *  the card query's 12-second `refetchInterval`, so there is nowhere to return to. */
import { useRef } from "react";

import { Ambient, Screen } from "@shared/components/chrome.tsx";
import { Icon } from "@shared/components/icons.tsx";
import { useEnterStagger } from "@shared/hooks/motion.ts";

export interface LivePrizeEmptyStateProps {
  message: string;
  onBack?: () => void;
}

export function LivePrizeEmptyState({ message, onBack }: LivePrizeEmptyStateProps) {
  const iconRef = useRef<HTMLDivElement>(null);
  const msgRef = useRef<HTMLParagraphElement>(null);
  useEnterStagger([iconRef, msgRef], { y: 12 });

  return (
    <Screen>
      <Ambient color="rgba(220,224,232,0.1)" />
      <div className="hero-col">
        <div className="squircle" ref={iconRef} style={{ color: "var(--fg-secondary)" }}>
          <Icon name="dollar" size={42} />
        </div>
        <p
          ref={msgRef}
          style={{
            font: "400 15px/1.5 var(--font-body)",
            color: "var(--fg-secondary)",
            maxWidth: 280,
          }}
        >
          {message}
        </p>
        {onBack == null ? null : (
          <button
            type="button"
            className="cta-pill is-quiet"
            style={{ maxWidth: 240 }}
            onClick={onBack}
          >
            Back
          </button>
        )}
      </div>
    </Screen>
  );
}
