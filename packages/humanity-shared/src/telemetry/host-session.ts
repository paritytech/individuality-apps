// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The native host's session on every Sentry event, and when it says the
 * person opened the product.
 *
 * The Pocket app installs a frozen `globalThis.__trinityHostTelemetry` before
 * the product's first script. Its `hostSessionId` is the id the host's own
 * `host.*` events carry, so a Sentry query on the `host.session_id` tag lines
 * the host's side of a launch up with this product's `card.load` and
 * `pocket.open`. Outside a host (a browser, `vite dev`, a test) the global is
 * absent and nothing here does anything; a bootstrap the host got wrong costs
 * the join, never the app.
 */
import type { Scope } from "@sentry/core";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** An open older than this is a stale value, not the open this page load answers. */
const MAX_OPEN_AGE_MS = 5 * 60 * 1000;

const OPEN_SOURCES = ["pocket_card", "deeplink"] as const;

export interface HostBootstrap {
  readonly hostSessionId: string;
  /** When the person opened the product (a card tap or a link), epoch ms. */
  readonly openedAtEpochMs?: number;
  /** What opened it; a source this build does not know is `other`. */
  readonly openSource?: string;
}

/**
 * The host's bootstrap, or null when there is none or its session id is not a
 * UUID. `openedAtEpochMs` is kept only when it is finite, not in the future and
 * under five minutes old; dropped on its own, never the session.
 */
export function readHostBootstrap(
  root: typeof globalThis = globalThis,
  now: number = Date.now(),
): HostBootstrap | null {
  try {
    const value: unknown = (root as { __trinityHostTelemetry?: unknown }).__trinityHostTelemetry;
    if (value == null || typeof value !== "object") return null;
    const { hostSessionId, openedAtEpochMs, openSource } = value as Record<string, unknown>;
    if (typeof hostSessionId !== "string" || !UUID.test(hostSessionId)) return null;
    return {
      hostSessionId,
      ...(typeof openedAtEpochMs === "number" &&
      Number.isFinite(openedAtEpochMs) &&
      openedAtEpochMs <= now &&
      now - openedAtEpochMs < MAX_OPEN_AGE_MS
        ? { openedAtEpochMs }
        : {}),
      ...(typeof openSource === "string" && openSource !== ""
        ? { openSource: OPEN_SOURCES.find((known) => known === openSource) ?? "other" }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Tag `scope`, and so every event and transaction, with the host's session. */
export function setHostSession(scope: Pick<Scope, "setTags">): void {
  const host = readHostBootstrap();
  if (host == null) return;
  scope.setTags({
    "host.session_id": host.hostSessionId,
    ...(host.openSource == null ? {} : { "open.source": host.openSource }),
  });
}
