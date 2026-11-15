// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * LogTape is configured exactly once, on first import, from `envConfig`.
 * `VITE_LOG_LEVEL` sets the root threshold (default `info`). Set
 * `VITE_LOG_LEVEL=debug` (or `trace`) to surface the chain-read tracing
 * emitted by the prize/card hooks.
 *
 * Three sinks: the console; in a build with the debug panel, a ring buffer
 * the panel renders; and Sentry (`telemetry/sentry-sink.ts`), which turns
 * every record into a breadcrumb and every error into an issue — a no-op
 * until `initTelemetry` has run with a DSN. LogTape applies the logger's
 * `lowestLevel` before dispatching to any sink, so all three see exactly the
 * same records and that one threshold governs them together.
 *
 * The application (not a library) owns this setup, so `configureSync` lives
 * here rather than in the hooks that log.
 */
import {
  configureSync,
  getConsoleSink,
  getLogger,
  getTextFormatter,
  type Sink,
} from "@logtape/logtape";

import { DEBUG_PANEL } from "@humanity/shared/config/debug-panel.ts";
import { envConfig } from "@humanity/shared/config/env.ts";
import { sentrySink } from "@humanity/shared/telemetry/sentry-sink.ts";

import { createLogBufferSink } from "./log-buffer.ts";

/** The app's own root logging category. */
const APP_CATEGORY = "humanity";

const DROP_RECORD: Sink = () => {};

configureSync({
  sinks: {
    console: getConsoleSink({
      // Plain text, not LogTape's default console formatter: that one emits
      // `%c` CSS directives plus a style argument per span, which DevTools
      // renders as unreadable `color: gray; background-color: …` noise in the
      // message list. One formatted string per record instead.
      formatter: getTextFormatter({ timestamp: "time", level: "ABBR" }),
      // `debug`/`trace` → console.log so they show in DevTools by default
      // (Chrome hides console.debug under the "Verbose" filter).
      levelMap: {
        trace: "log",
        debug: "log",
        info: "info",
        warning: "warn",
        error: "error",
        fatal: "error",
      },
    }),
    // `DEBUG_PANEL` is a build-time literal, so a build without the panel
    // folds this to the no-op and drops the ring buffer entirely rather than
    // retaining log records nothing can read.
    buffer: DEBUG_PANEL ? createLogBufferSink(APP_CATEGORY) : DROP_RECORD,
    sentry: sentrySink,
  },
  loggers: [
    {
      category: [],
      lowestLevel: envConfig.logging.level,
      sinks: ["console", "buffer", "sentry"],
    },
    {
      // LogTape's own diagnostics; keep them quiet unless something breaks —
      // but when something does, the panel should say so too.
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console", "buffer", "sentry"],
    },
  ],
});

/** A logger scoped under the app's root category. */
export function loggerFor(...categories: string[]) {
  return getLogger([APP_CATEGORY, ...categories]);
}
