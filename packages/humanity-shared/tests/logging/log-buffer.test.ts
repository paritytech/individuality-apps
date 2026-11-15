// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** What is pinned here is the buffer's two load-bearing contracts: LogTape's
 *  odd/even message convention (reimplemented because LogTape exports no
 *  interpolation helper, so a version bump could silently change it), and the
 *  snapshot identity `useSyncExternalStore` depends on — a fresh array from an
 *  unchanged buffer renders forever. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LogRecord } from "@logtape/logtape";

import {
  LEVEL_ABBR,
  clearLogs,
  createLogBufferSink,
  formatLogCategory,
  formatLogTime,
  logSnapshot,
  renderLogMessage,
  subscribeLogs,
} from "@humanity/shared/logging/log-buffer.ts";

const sink = createLogBufferSink("humanity");

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    category: ["humanity", "prize", "claim"],
    level: "info",
    message: ["hello"],
    rawMessage: "hello",
    timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
    properties: {},
    ...overrides,
  } as LogRecord;
}

beforeEach(() => {
  clearLogs();
});

describe("renderLogMessage", () => {
  it("interleaves literal segments with interpolated values", () => {
    expect(renderLogMessage(["claim failed; code=", "timeout", " retrying"])).toBe(
      "claim failed; code=timeout retrying",
    );
  });

  it("passes a lone segment through", () => {
    expect(renderLogMessage(["plain"])).toBe("plain");
  });

  // Prizes are asset base units, and `JSON.stringify` throws on a bigint
  // rather than skipping it — an unhandled one would lose the whole record.
  it("names bigints instead of throwing on them", () => {
    expect(renderLogMessage(["amount=", 10_000_000_000n, ""])).toBe(
      "amount=10000000000n",
    );
    expect(renderLogMessage(["at=", { amount: 5n }, ""])).toBe('at={"amount":"5n"}');
  });

  it("renders an error as name and message, not [object Object]", () => {
    expect(renderLogMessage(["failed: ", new TypeError("bad input"), ""])).toBe(
      "failed: TypeError: bad input",
    );
    expect(renderLogMessage(["failed: ", new Error("plain"), ""])).toBe(
      "failed: plain",
    );
  });

  it("renders objects, nullish and primitives legibly", () => {
    expect(renderLogMessage(["v=", { a: 1 }, ""])).toBe('v={"a":1}');
    expect(renderLogMessage(["v=", null, ""])).toBe("v=null");
    expect(renderLogMessage(["v=", undefined, ""])).toBe("v=undefined");
    expect(renderLogMessage(["v=", false, ""])).toBe("v=false");
  });

  it("survives a value that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => renderLogMessage(["v=", cyclic, ""])).not.toThrow();
  });
});

describe("formatLogCategory", () => {
  it("drops the app root and joins the rest", () => {
    expect(formatLogCategory(["humanity", "prize", "claim"], "humanity")).toBe(
      "prize·claim",
    );
  });

  it("keeps a category that is not under the app root", () => {
    expect(formatLogCategory(["logtape", "meta"], "humanity")).toBe("logtape·meta");
  });

  it("renders the bare root as empty rather than a stray separator", () => {
    expect(formatLogCategory(["humanity"], "humanity")).toBe("");
    expect(formatLogCategory([], "humanity")).toBe("");
  });
});

describe("the ring buffer", () => {
  it("captures level, category and interpolated message", () => {
    sink(
      record({
        level: "error",
        message: ["code=", "signing", ""],
      }),
    );
    expect(logSnapshot()).toHaveLength(1);
    expect(logSnapshot()[0]).toMatchObject({
      level: "error",
      category: "prize·claim",
      message: "code=signing",
    });
  });

  it("evicts the oldest past capacity and keeps the newest", () => {
    for (let index = 0; index < 260; index += 1) {
      sink(record({ message: [`entry-${index}`] }));
    }
    const held = logSnapshot();
    expect(held).toHaveLength(200);
    expect(held[held.length - 1]?.message).toBe("entry-259");
    expect(held[0]?.message).toBe("entry-60");
  });

  it("gives every entry a distinct key across evictions", () => {
    for (let index = 0; index < 260; index += 1) {
      sink(record({ message: [`entry-${index}`] }));
    }
    const ids = logSnapshot().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // `useSyncExternalStore` re-renders whenever getSnapshot returns a new
  // reference, so an unchanged buffer must return the identical array.
  it("keeps the snapshot reference stable until a record arrives", () => {
    const before = logSnapshot();
    expect(logSnapshot()).toBe(before);
    sink(record());
    expect(logSnapshot()).not.toBe(before);
  });

  it("does not churn the snapshot when clearing an already-empty buffer", () => {
    const empty = logSnapshot();
    clearLogs();
    expect(logSnapshot()).toBe(empty);
  });

  it("notifies subscribers on push and on clear, and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLogs(listener);
    sink(record());
    expect(listener).toHaveBeenCalledTimes(1);
    clearLogs();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    sink(record());
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("display helpers", () => {
  it("pads wall-clock time to a fixed width so lines align", () => {
    expect(formatLogTime(new Date(2026, 0, 1, 9, 5, 3).getTime())).toBe("09:05:03");
    expect(formatLogTime(new Date(2026, 0, 1, 23, 59, 59).getTime())).toBe("23:59:59");
  });

  it("abbreviates every level the console sink can emit", () => {
    expect(Object.values(LEVEL_ABBR)).toEqual(["TRC", "DBG", "INF", "WRN", "ERR", "FTL"]);
  });
});
