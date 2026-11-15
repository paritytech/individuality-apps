// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import "@humanity/shared/logging/logger.ts";
import { initTelemetry } from "@humanity/shared/telemetry/sentry.ts";
import { followHostTheme } from "@humanity/shared/theme/host-theme.ts";
import { App } from "./app/App.tsx";
import { cardLoad } from "@features/card/telemetry/card-load.ts";
import { getPeopleClient } from "@humanity/shared/chain/client.ts";

// After the logger, before anything that can fail: the Sentry sink is wired
// into the logger and only reports once this has run.
initTelemetry("app");
// The card load is timed from the script start; the hooks take it from here.
cardLoad.begin();

const container = document.getElementById("root");
if (container == null) {
  throw new Error("missing #root container");
}

// Theme failures are logged by the host-call trace; the default palette stays.
void followHostTheme().catch(() => {});

// Open the People client and settle its head and runtime now, in parallel
// with the host identity reads, so the card read does not start with the
// chainHead subscription and the metadata load. A failure here is not a
// story: the card read makes the same call and reports it.
void getPeopleClient()
  .then(({ client, api }) =>
    Promise.all([client.getFinalizedBlock(), api.getStaticApis()]),
  )
  .catch(() => {});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
