// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Copies the whole panel — sections, simulation overrides and the log tail — as
 * one JSON document.
 *
 * Sections come from the same `buildDebugView` call the panel renders from, so
 * the copied document cannot disagree with what was on screen.
 *
 * `navigator.clipboard` needs a secure context and a permission that a deployed
 * preview over plain http will refuse, so a failure falls back to
 * `console.log`: devtools is already open in the situation where anyone wants
 * this button, and a dev tool that silently does nothing is worse than one that
 * tells you where the payload went.
 */
import { useCallback, useState, type ReactNode } from "react";

import { CAPACITY, logSnapshot } from "@humanity/shared/logging/log-buffer.ts";

import {
  MUTATION_CAPACITY,
  mutationJournal,
} from "./debug-mutation-journal.ts";

import {
  buildDebugSnapshot,
  serializeDebugSnapshot,
} from "./debug-snapshot.ts";
import { useDebugStore, withChainDiagnostics } from "./debug-store.ts";
import { buildDebugView } from "./debug-view.ts";

type CopyState = "idle" | "copied" | "logged" | "empty";

const LABEL: Record<CopyState, string> = {
  idle: "Copy state",
  copied: "Copied",
  logged: "Logged to console",
  empty: "Nothing to copy",
};

/** `actions` sit on the same row, before the copy button. */
export function DebugCopyState({ actions }: { actions?: ReactNode }) {
  const input = useDebugStore((state) => state.input);
  const scenario = useDebugStore((state) => state.scenario);
  const pendingScenario = useDebugStore((state) => state.pendingScenario);
  const applying = useDebugStore((state) => state.applying);
  const prize = useDebugStore((state) => state.prize);
  const [state, setState] = useState<CopyState>("idle");

  const copy = useCallback(() => {
    const logs = logSnapshot();
    const mutations = mutationJournal();
    if (input == null && logs.length === 0 && mutations.length === 0) {
      setState("empty");
      return;
    }
    const json = serializeDebugSnapshot(
      buildDebugSnapshot({
        capturedAtMs: Date.now(),
        sections: input == null ? [] : buildDebugView(withChainDiagnostics(input)),
        logs,
        logCapacity: CAPACITY,
        mutations,
        mutationCapacity: MUTATION_CAPACITY,
        scenario,
        pendingScenario,
        applying,
        prize,
      }),
    );
    // Not `clipboard?.writeText(...).then(...)`: on an insecure origin
    // `clipboard` is undefined, and optional-chaining the call would leave
    // `.then` to throw on undefined.
    const clipboard = navigator.clipboard;
    if (clipboard == null) {
      console.log(json);
      setState("logged");
      return;
    }
    void clipboard.writeText(json).then(
      () => setState("copied"),
      () => {
        console.log(json);
        setState("logged");
      },
    );
  }, [applying, input, pendingScenario, prize, scenario]);

  return (
    <div className="debug-copy">
      {actions}
      <button
        type="button"
        className="debug-chip"
        onClick={copy}
        // Reset on focus rather than a timer: a stale "Copied" is only
        // misleading once you come back to press it again.
        onFocus={() => setState("idle")}
        onPointerEnter={() => setState("idle")}
      >
        {LABEL[state]}
      </button>
    </div>
  );
}
