// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The last line under the whole app: a render that throws must not leave a
 * blank page. The one class of throw met so far came from durable browser
 * state written by an earlier build (a card state name retired since), so
 * the first catch clears every cache this app keeps in the browser and
 * renders again from chain. A second throw shows the fallback with a reload.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { queryClient } from "@shared/chain/query-client.ts";
import { queryPersister } from "@shared/chain/query-persistence.ts";
import { Ambient, Screen } from "@shared/components/chrome.tsx";
import { Icon } from "@shared/components/icons.tsx";
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { clearLastCard } from "@features/card/storage/last-card-store.ts";

const logger = loggerFor("app", "error-boundary");

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

/**
 * Drops what this app keeps in the browser, so the next render reads live.
 * Every step is attempted and none can fail the whole: a store that refuses
 * one removal must not keep the page on the recovery screen.
 */
async function clearBrowserState(): Promise<void> {
  const steps: [string, () => unknown][] = [
    ["last card", () => clearLastCard()],
    ["query cache", () => queryClient.clear()],
    ["persisted query cache", () => queryPersister.removeClient()],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error: unknown) {
      logger.warning("could not clear the {name}: {error}", { name, error });
    }
  }
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failed: false };
  private recoveryAttempted = false;

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The Error itself, not its text: the Sentry sink files the record as
    // that exception, with its stack, and the component stack beside it.
    logger.error("render failed: {error}{stack}", {
      error,
      stack: info.componentStack ?? "",
    });
    if (this.recoveryAttempted) return;
    this.recoveryAttempted = true;
    void clearBrowserState().finally(() => this.setState({ failed: false }));
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // First failure: caches are being cleared and the children render again.
    if (!this.recoveryAttempted) return <Recovering />;
    return <RenderFailed />;
  }
}

function Recovering() {
  return (
    <Screen>
      <Ambient color="rgba(220,224,232,0.1)" />
      <div className="hero-col">
        <p
          role="status"
          style={{
            font: "400 15px/1.5 var(--font-body)",
            color: "var(--fg-secondary)",
            maxWidth: 280,
          }}
        >
          Refreshing your card…
        </p>
      </div>
    </Screen>
  );
}

function RenderFailed() {
  return (
    <Screen>
      <Ambient color="rgba(220,224,232,0.1)" />
      <div className="hero-col">
        <div className="squircle" style={{ color: "var(--fg-secondary)" }}>
          <Icon name="dollar" size={42} />
        </div>
        <p
          style={{
            font: "400 15px/1.5 var(--font-body)",
            color: "var(--fg-secondary)",
            maxWidth: 280,
          }}
        >
          Humanity couldn&apos;t draw your card. Reload to try again.
        </p>
        <button
          type="button"
          className="cta-pill is-quiet"
          style={{ maxWidth: 240 }}
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </Screen>
  );
}
