// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";

import { toGamePhaseView } from "@humanity/shared/chain/game-phase.ts";
import { toCurrentGame } from "@humanity/shared/chain/individuality.ts";
import { useChainStatus } from "@features/status/hooks/use-chain-status.ts";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-fg2">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </>
  );
}

function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function ConnectionStatus() {
  const { data, isPending, isError } = useChainStatus();
  const [nowSeconds, setNowSeconds] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  if (isPending) {
    return <p className="text-fg2">Connecting…</p>;
  }

  if (isError) {
    return <p className="text-fg2">Connection status unavailable.</p>;
  }

  // Maps its own raw game: this page reads for liveness, not for the card.
  const game = data.game == null ? null : toCurrentGame(data.game);
  const phase =
    game == null
      ? null
      : toGamePhaseView(game.phase, game.nextDeadline, nowSeconds);

  return (
    <section className="max-w-xl rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg2">
        Chain connection
      </h2>
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
        <Row
          label="Host mode"
          value={data.inHost ? "host container" : "standalone (direct WS)"}
        />
        <Row label="Network" value={data.networkDisplayName} />
        <Row label="WS endpoint" value={data.wsUrl} />
        <Row label="Chain name" value={data.chainName} />
        <Row label="Genesis" value={`${data.genesisHash.slice(0, 10)}…`} />
        <Row label="Finalized block" value={String(data.finalizedNumber)} />
        <Row label="Game index" value={String(data.gameIndex)} />
        {phase == null ? (
          <Row label="Game" value="No active game" />
        ) : (
          <>
            <Row label="Phase" value={phase.label} />
            <Row
              label="Phase ends in"
              value={
                phase.secondsRemaining == null
                  ? "—"
                  : formatCountdown(phase.secondsRemaining)
              }
            />
          </>
        )}
      </dl>
    </section>
  );
}
