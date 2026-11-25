// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Sentry, initialised once per executable from `envConfig.telemetry`.
 *
 * Both executables are browser code — the app in the host's visible WebView,
 * the worker in a hidden one — so one SDK (`@sentry/browser`) serves
 * both, told apart by the `surface` tag. Every other telemetry module in
 * this package goes through the SDK's global API, which is a no-op until
 * `initTelemetry` has run and stays one in a build with no DSN: nothing here
 * throws, nothing is sent from a build without a DSN (`vite dev` and every
 * test included), and a host that blocks the ingest origin loses reports,
 * not the app.
 *
 * The client is built by hand rather than through `init`, and the
 * integrations are listed, because both bundles are published to a chain
 * and paid for by the byte: `init` pins every default integration into the
 * bundle whether used or not, while a listed set lets the bundler drop the
 * rest (Sentry's own tree-shaking recipe). What is deliberately NOT on:
 *  - `browserTracingIntegration`: page loads and navigations are not the
 *    question. Every transaction is a named user flow (`flow.ts`).
 *  - Console, fetch and XHR breadcrumbs: the LogTape sink
 *    (`sentry-sink.ts`) supplies structured ones from the same records the
 *    console prints, and chain traffic is one WebSocket.
 *  - User, cookies, headers, query strings, bodies: `dataCollection` turns
 *    every category off. With no User-Agent header, the device is parsed
 *    on the device instead (`device.ts`) and sent as tags and contexts.
 *  - Usernames and account addresses, unless the deployer opts in with
 *    `VITE_SENTRY_SEND_IDENTITY=true`: `beforeSend` and
 *    `beforeSendTransaction` run every event through `redactEvent`
 *    (`redact.ts`). A tx hash is still sent; it is what finds a
 *    failed submission on chain.
 *
 * `traceLifecycle: "static"`: a flow is sent as one transaction when its
 * root span ends, children inside it — one envelope per story, which is
 * also what the tests assert on — rather than streamed span by span.
 */
import {
  breadcrumbsIntegration,
  BrowserClient,
  dedupeIntegration,
  defaultStackParser,
  type ErrorEvent,
  eventFiltersIntegration,
  functionToStringIntegration,
  getCurrentScope,
  globalHandlersIntegration,
  linkedErrorsIntegration,
  makeFetchTransport,
} from "@sentry/browser";

import { envConfig } from "@humanity/shared/config/env.ts";
import { setDeviceContext } from "@humanity/shared/telemetry/device.ts";
import { setHostSession } from "@humanity/shared/telemetry/host-session.ts";
import { redactEvent } from "@humanity/shared/telemetry/redact.ts";

/** Which executable is reporting. */
export type TelemetrySurface = "app" | "worker";

let initialised: TelemetrySurface | null = null;

/** The surface `initTelemetry` ran for, or null when it did not run. */
export function telemetrySurface(): TelemetrySurface | null {
  return initialised;
}

/**
 * Drop an unhandled rejection that is nothing but an `AbortError`. Every
 * signal the app aborts is its own: a bounded read's deadline
 * (`chain/bounded-read.ts`) or a query the UI let go. polkadot-api rejects
 * the pulls still waiting on that signal (`firstValueFromWithSignal`), and a
 * pull no caller was awaiting any more surfaces as an unhandled rejection.
 * The deadline already rejects the read that missed it with its own error;
 * the abort it caused is not a second failure. A caught `AbortError` a log line reports is left
 * alone, as is any rejection with another error in its chain.
 */
export function dropAbandonedAbort<E extends ErrorEvent>(event: E): E | null {
  const values = event.exception?.values;
  if (values == null || values.length === 0) return event;
  const unhandledRejection = values.some(
    (value) => value.mechanism?.type.endsWith("onunhandledrejection") === true,
  );
  if (!unhandledRejection) return event;
  return values.every((value) => value.type === "AbortError") ? null : event;
}

/** The client's last word on an event: drop an abandoned abort, then take
 *  the person out of what is left unless the deployer opted in. */
export function prepareEvent<E extends ErrorEvent>(event: E): E | null {
  const kept = dropAbandonedAbort(event);
  return kept == null ? null : redactEvent(kept);
}

/**
 * Start reporting for `surface`. Safe to call once per executable, before
 * anything else runs; a build without `VITE_SENTRY_DSN` returns at once and
 * every later telemetry call is a no-op.
 */
export function initTelemetry(surface: TelemetrySurface): void {
  if (initialised != null) return;
  const { sentryDsn, tracesSampleRate, release } = envConfig.telemetry;
  if (sentryDsn == null) return;
  const client = new BrowserClient({
    dsn: sentryDsn,
    release: release ?? undefined,
    environment: envConfig.dev ? "dev" : envConfig.chain.network || "unknown",
    // `card.load` and `pocket.open` (the same wait from the tap) happen once
    // per launch and are the durations we need every sample of; everything
    // else follows the configured rate.
    tracesSampler: ({ name, parentSampled }) =>
      name === "card.load" || name === "pocket.open" ? 1 : (parentSampled ?? tracesSampleRate),
    traceLifecycle: "static",
    transport: makeFetchTransport,
    stackParser: defaultStackParser,
    integrations: [
      eventFiltersIntegration(),
      functionToStringIntegration(),
      dedupeIntegration(),
      // Uncaught throws and unhandled rejections: the failures no flow and
      // no log line declared.
      globalHandlersIntegration(),
      linkedErrorsIntegration(),
      breadcrumbsIntegration({ fetch: false, xhr: false }),
    ],
    maxBreadcrumbs: 60,
    beforeSend: prepareEvent,
    beforeSendTransaction: redactEvent,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      httpBodies: [],
    },
  });
  const scope = getCurrentScope();
  scope.setClient(client);
  scope.setTags({
    surface,
    product: envConfig.host.productLabel,
    ...(envConfig.host.productSubname === ""
      ? {}
      : { "product.subname": envConfig.host.productSubname }),
  });
  client.init();
  setDeviceContext();
  // App only today: no host gives the worker a bootstrap, so this is a no-op there.
  setHostSession(scope);
  initialised = surface;
}
