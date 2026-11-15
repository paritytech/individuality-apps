// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The tail of the app's own log records, as the console received them.
 *
 * Reads the LogTape ring buffer rather than the page's published state, so it
 * shows records emitted before the panel was ever opened — including the chain
 * and host failures that happen during the first load, which is exactly when
 * DevTools is least likely to already be open.
 *
 * Newest first: the panel does not autoscroll, and the record you want is
 * almost always the one that just arrived.
 */
import { useSyncExternalStore } from "react";

import {
  LEVEL_ABBR,
  clearLogs,
  formatLogTime,
  logSnapshot,
  subscribeLogs,
} from "@humanity/shared/logging/log-buffer.ts";

export function DebugLogs() {
  const entries = useSyncExternalStore(subscribeLogs, logSnapshot, logSnapshot);

  return (
    <section className="debug-section">
      <div className="debug-flows">
        <button
          type="button"
          className="debug-chip"
          disabled={entries.length === 0}
          onClick={clearLogs}
        >
          Clear
        </button>
        <span className="debug-note">{entries.length} held</span>
      </div>
      {entries.length === 0 ? (
        <p className="debug-note">
          Nothing logged yet at this level — raise it with VITE_LOG_LEVEL.
        </p>
      ) : (
        <ol className="debug-logs">
          {[...entries].reverse().map((entry) => (
            <li key={entry.id} className="debug-log" data-level={entry.level}>
              <span className="debug-log-meta">
                {formatLogTime(entry.time)} {LEVEL_ABBR[entry.level]}
                {entry.category === "" ? "" : ` ${entry.category}`}
              </span>
              <span className="debug-log-message">{entry.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
