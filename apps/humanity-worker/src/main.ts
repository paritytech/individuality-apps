// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Entry point of the Humanity worker - the product's second executable
 * (`dist/index.js`), which the host boots in a hidden WebView.
 *
 * There is no DOM and no user gesture here: the module's only job is to
 * register the Pocket card renderer. The Daily Dollar's chat and background
 * registration live in Jollity's chat worker now, and so do its pushes; the
 * app still registers while it is open. The shared `logging/logger.ts`
 * module is imported first because importing it is what configures LogTape,
 * and a failure during dependency setup must already have somewhere to go.
 */
import { loggerFor } from "@humanity/shared/logging/logger.ts";
import { initTelemetry } from "@humanity/shared/telemetry/sentry.ts";

import { createPocketCardDeps } from "./host-deps.ts";
import { createPocketCardRenderer } from "./pocket-card.ts";

const logger = loggerFor("worker", "main");

// Same order as the app: logger first, then telemetry, then the work.
initTelemetry("worker");

try {
  // A host with no renderer surface leaves the card static rather than
  // failing the boot.
  void createPocketCardRenderer(createPocketCardDeps())
    .start()
    .catch((error: unknown) => logger.error("pocket card renderer not registered: {error}", { error }));
} catch (error) {
  // Nothing can retry from here: the host owns the WebView's lifetime and
  // boots the worker again on the next wake, so the one useful act is to
  // leave a record of why this boot did nothing.
  logger.error("worker failed to start: {error}", { error });
}
