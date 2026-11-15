// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The host's own loading spinner, for a wait that has gone on long enough to
 * need one.
 *
 * Drawn to match what the Polkadot app shows while a card opens (Android's
 * `NovaCircularProgressIndicator`, a Material 3 indeterminate circle): 48px
 * across to the stroke's outer edge, a 4px round-capped arc in `--fg-primary` over a track in
 * `--fg-tertiary`. So the moment the host hands over to the page, the page
 * keeps what the person was already looking at, and nothing new appears.
 *
 * It waits `afterMs` before showing at all: a read that lands sooner goes
 * straight to the screen's own entrance, with no spinner flashing in between.
 */
import { useEffect, useState } from "react";

export function LoadSpinner({ afterMs }: { afterMs: number }) {
  const [shown, setShown] = useState(afterMs <= 0);
  useEffect(() => {
    if (afterMs <= 0) return;
    const timer = setTimeout(() => setShown(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  if (!shown) return null;
  return (
    <svg className="load-spinner" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">
      <circle className="load-spinner-track" cx="24" cy="24" r="22" />
      <circle className="load-spinner-arc" cx="24" cy="24" r="22" />
    </svg>
  );
}
