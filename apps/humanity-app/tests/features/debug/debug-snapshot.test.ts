// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** This document gets pasted into bug reports, so what is pinned here is the
 *  two things a reader cannot check for themselves: that a simulated panel says
 *  so, and that a log tail which has already evicted records admits it. Getting
 *  either wrong makes the report actively misleading rather than merely thin. */
import { describe, expect, it } from "vitest";

import {
  buildDebugSnapshot,
  serializeDebugSnapshot,
  type DebugSnapshotInput,
} from "@features/debug/debug-snapshot.ts";
import { INITIAL_DEBUG_PRIZE_STATE } from "@features/debug/debug-prize-state.ts";
import type { LogEntry } from "@humanity/shared/logging/log-buffer.ts";

const CAPTURED_AT = Date.UTC(2026, 7, 26, 14, 30, 0);

function log(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    time: Date.UTC(2026, 7, 26, 14, 29, 0),
    level: "error",
    category: "prize·claim",
    message: "claim failed; code=timeout",
    ...overrides,
  } as LogEntry;
}

function input(overrides: Partial<DebugSnapshotInput> = {}): DebugSnapshotInput {
  return {
    capturedAtMs: CAPTURED_AT,
    sections: [
      { title: "session", rows: [{ label: "network", value: "previewnet" }] },
      { title: "identity", rows: [{ label: "username", value: "bob.02" }] },
    ],
    logs: [],
    logCapacity: 200,
    mutations: [],
    mutationCapacity: 50,
    scenario: null,
    pendingScenario: null,
    applying: false,
    prize: INITIAL_DEBUG_PRIZE_STATE,
    ...overrides,
  };
}

describe("buildDebugSnapshot", () => {
  it("flattens sections to title -> label -> value in panel order", () => {
    const snapshot = buildDebugSnapshot(input());
    expect(snapshot.sections).toEqual({
      session: { network: "previewnet" },
      identity: { username: "bob.02" },
    });
    expect(Object.keys(snapshot.sections)).toEqual(["session", "identity"]);
  });

  it("flattens a section table into the same label -> value map, cells dotted", () => {
    const snapshot = buildDebugSnapshot(
      input({
        sections: [
          {
            title: "airdrops",
            rows: [{ label: "draws", value: "1 · registered 0 · won 0 · claimable 0" }],
            table: {
              columns: ["#", "status", "you", "in / won / claimed", "deadline"],
              rows: [["#27", "open", "not registered", "0 / — / —", "2026-09-12 08:33Z"]],
            },
          },
        ],
      }),
    );
    expect(snapshot.sections["airdrops"]).toEqual({
      draws: "1 · registered 0 · won 0 · claimable 0",
      "#27": "open · not registered · 0 / — / — · 2026-09-12 08:33Z",
    });
  });

  it("stamps the capture time as ISO-8601", () => {
    expect(buildDebugSnapshot(input()).capturedAt).toBe("2026-08-26T14:30:00.000Z");
  });

  // Without this flag the section values look like chain reads when a scenario
  // is overriding them, and the reader has no way to tell.
  it("marks the panel simulated when a scenario is applied", () => {
    const snapshot = buildDebugSnapshot(input({ scenario: "devicehood" as never }));
    expect(snapshot.simulation.active).toBe(true);
    expect(snapshot.simulation.scenario).toBe("devicehood");
  });

  it("marks the panel simulated when a prize outcome is picked", () => {
    const snapshot = buildDebugSnapshot(
      input({ prize: { ...INITIAL_DEBUG_PRIZE_STATE, outcome: "win" } }),
    );
    expect(snapshot.simulation.active).toBe(true);
  });

  it("reports a clean panel as not simulated", () => {
    const snapshot = buildDebugSnapshot(input());
    expect(snapshot.simulation.active).toBe(false);
    expect(snapshot.simulation.scenario).toBeNull();
  });

  it("carries a pending scenario that has not landed yet", () => {
    const snapshot = buildDebugSnapshot(
      input({ pendingScenario: "member" as never, applying: true }),
    );
    expect(snapshot.simulation).toMatchObject({
      pendingScenario: "member",
      applying: true,
    });
  });

  it("renders logs oldest-first with ISO times", () => {
    const snapshot = buildDebugSnapshot(
      input({
        logs: [
          log({ id: 1, time: Date.UTC(2026, 7, 26, 14, 0, 0), message: "first" }),
          log({ id: 2, time: Date.UTC(2026, 7, 26, 14, 1, 0), message: "second" }),
        ],
      }),
    );
    expect(snapshot.logs.map((entry) => entry.message)).toEqual(["first", "second"]);
    expect(snapshot.logs[0]).toEqual({
      at: "2026-08-26T14:00:00.000Z",
      level: "error",
      category: "prize·claim",
      message: "first",
    });
  });

  // A reader who mistakes an evicted tail for the whole session concludes the
  // earlier failure never happened.
  it("flags a log tail that reached the buffer bound", () => {
    const full = Array.from({ length: 4 }, (_, index) => log({ id: index }));
    expect(buildDebugSnapshot(input({ logs: full, logCapacity: 4 })).logsTruncated).toBe(
      true,
    );
    expect(buildDebugSnapshot(input({ logs: full, logCapacity: 5 })).logsTruncated).toBe(
      false,
    );
  });

  it("handles a panel that published no page state", () => {
    const snapshot = buildDebugSnapshot(input({ sections: [], logs: [log()] }));
    expect(snapshot.sections).toEqual({});
    expect(snapshot.logs).toHaveLength(1);
  });
});

describe("serializeDebugSnapshot", () => {
  it("round-trips through JSON without losing anything", () => {
    const snapshot = buildDebugSnapshot(input({ logs: [log()] }));
    expect(JSON.parse(serializeDebugSnapshot(snapshot))).toEqual(snapshot);
  });

  it("indents so the document is readable when pasted", () => {
    expect(serializeDebugSnapshot(buildDebugSnapshot(input()))).toContain(
      '\n  "sections": {',
    );
  });
});

describe("mutation journal in the snapshot", () => {
  const attempt = (
    overrides: Partial<{
      id: number;
      at: number;
      mutation: string;
      outcome: string;
      detail: string;
    }> = {},
  ) =>
    ({
      id: 1,
      at: Date.UTC(2026, 7, 26, 14, 20, 0),
      mutation: "PeopleAirdrops.register",
      outcome: "rejected",
      detail: "nope: expected a draw index or an 0x… event id",
      ...overrides,
    }) as never;

  // A refusal never reaches the logger, so this document is its only record.
  it("carries refusals the panel never submitted", () => {
    const snapshot = buildDebugSnapshot(input({ mutations: [attempt()] }));
    expect(snapshot.mutations).toEqual([
      {
        at: "2026-08-26T14:20:00.000Z",
        mutation: "PeopleAirdrops.register",
        outcome: "rejected",
        detail: "nope: expected a draw index or an 0x… event id",
      },
    ]);
  });

  it("keeps attempts oldest-first so a retry sequence reads in order", () => {
    const snapshot = buildDebugSnapshot(
      input({
        mutations: [
          attempt({ id: 1, outcome: "submitted", detail: "draw 4" }),
          attempt({ id: 2, outcome: "failed", detail: "BadOrigin" }),
          attempt({ id: 3, outcome: "submitted", detail: "draw 4" }),
        ],
      }),
    );
    expect(snapshot.mutations.map((entry) => entry.outcome)).toEqual([
      "submitted",
      "failed",
      "submitted",
    ]);
  });

  it("flags a journal that reached its bound", () => {
    const full = Array.from({ length: 3 }, (_, index) => attempt({ id: index }));
    expect(
      buildDebugSnapshot(input({ mutations: full, mutationCapacity: 3 })).mutationsTruncated,
    ).toBe(true);
    expect(
      buildDebugSnapshot(input({ mutations: full, mutationCapacity: 4 })).mutationsTruncated,
    ).toBe(false);
  });

  it("is empty when nothing was attempted", () => {
    expect(buildDebugSnapshot(input()).mutations).toEqual([]);
    expect(buildDebugSnapshot(input()).mutationsTruncated).toBe(false);
  });
});
