// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Telemetry, exercised by hand: whether this build reports at all, and one
 * button per path a real failure can take to Sentry, so "did the event
 * arrive?" is answered on the device rather than by waiting for a bug.
 *
 *  - Log an error: `logger.error`, the sink path every flow failure uses.
 *  - Throw uncaught: a throw nobody catches, the global handlers' path.
 *  - Run a flow: a `debug.probe` transaction with two stages, the flow path;
 *    subject to the sample rate like every flow, so it may not go out.
 *
 * The ingest's answer is read off the client's own `afterSendEvent`, which
 * fires with the HTTP status once the envelope is acknowledged.
 */
import { useEffect, useState } from "react";
import { getClient, lastEventId } from "@sentry/browser";

import { envConfig } from "@humanity/shared/config/env.ts";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { runFlow } from "@humanity/shared/telemetry/flow.ts";
import { telemetrySurface } from "@humanity/shared/telemetry/sentry.ts";

const logger = loggerFor("debug", "sentry");

function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

interface Sent {
  id: string;
  type: string;
  status: number | undefined;
  at: number;
}

export function DebugSentry() {
  const surface = telemetrySurface();
  const [sent, setSent] = useState<Sent[]>([]);
  const [probe, setProbe] = useState<string | null>(null);

  useEffect(() => {
    const client = getClient();
    if (client == null) return;
    return client.on("afterSendEvent", (event, response) => {
      setSent((list) =>
        [
          { id: event.event_id ?? "?", type: event.type ?? "error", status: response.statusCode, at: Date.now() },
          ...list,
        ].slice(0, 6),
      );
    });
  }, []);

  const stamp = (): string => new Date().toISOString();

  const logError = (): void => {
    logger.error("debug panel test error at {at}", { at: stamp(), error: new Error(`debug panel test error at ${stamp()}`) });
    setProbe(`logged; event ${lastEventId() ?? "pending"}`);
  };

  const throwUncaught = (): void => {
    setProbe("thrown; the global handler files it");
    setTimeout(() => {
      throw new Error(`debug panel uncaught error at ${stamp()}`);
    }, 0);
  };

  const runProbeFlow = (): void => {
    setProbe("flow running…");
    void runFlow(
      "debug.probe",
      async (flow) => {
        flow.stage("first");
        await pause(120);
        flow.stage("second");
        await pause(80);
      },
      { attributes: { source: "debug-panel" } },
    ).then(() => setProbe(`flow ended; sent with probability ${envConfig.telemetry.tracesSampleRate}`));
  };

  return (
    <section className="debug-section">
      <h2 className="debug-title">sentry</h2>
      <dl className="debug-rows">
        <div className="debug-row">
          <dt>reporting</dt>
          <dd>{surface == null ? "off (no VITE_SENTRY_DSN)" : `on · surface ${surface}`}</dd>
        </div>
        <div className="debug-row">
          <dt>environment</dt>
          <dd>{envConfig.dev ? "dev" : envConfig.chain.network || "unknown"}</dd>
        </div>
        <div className="debug-row">
          <dt>flow sample rate</dt>
          <dd>{envConfig.telemetry.tracesSampleRate}</dd>
        </div>
        <div className="debug-row">
          <dt>release</dt>
          <dd>{envConfig.telemetry.release ?? "none"}</dd>
        </div>
      </dl>
      <div className="debug-flows">
        <button type="button" className="debug-chip" disabled={surface == null} onClick={logError}>
          Log an error
        </button>
        <button type="button" className="debug-chip" disabled={surface == null} onClick={throwUncaught}>
          Throw uncaught
        </button>
        <button type="button" className="debug-chip" disabled={surface == null} onClick={runProbeFlow}>
          Run a flow
        </button>
      </div>
      {probe == null ? null : <p className="debug-note">{probe}</p>}
      {sent.length === 0 ? (
        <p className="debug-note">nothing sent yet</p>
      ) : (
        <dl className="debug-rows">
          {sent.map((entry) => (
            <div className="debug-row" key={`${entry.id}-${entry.at}`}>
              <dt>{entry.type}</dt>
              <dd>
                {entry.id.slice(0, 8)} · {entry.status == null ? "no response" : `HTTP ${entry.status}`}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
