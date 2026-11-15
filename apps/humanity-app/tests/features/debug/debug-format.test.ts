// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** A panel that renders a chain failure as "[object Object]" hides the only
 *  evidence there is, so every non-Error shape PAPI and the host bridge throw
 *  has to survive formatting. */
import { describe, expect, it } from "vitest";

import { duration, errorText, queryStatus } from "@features/debug/debug-format.ts";

describe("errorText", () => {
  it("uses the bare message for a plain Error", () => {
    expect(errorText(new Error("People Chain did not respond in time."))).toBe(
      "People Chain did not respond in time.",
    );
  });

  it("keeps a distinguishing error name", () => {
    const error = new Error("Client destroyed");
    error.name = "DestroyedError";
    expect(errorText(error)).toBe("DestroyedError: Client destroyed");
  });

  it("reads the message off a non-Error object that carries one", () => {
    expect(errorText({ message: "chain not supported" })).toBe(
      "chain not supported",
    );
  });

  it("serializes a dispatch-error object instead of stringifying it", () => {
    expect(errorText({ type: "Module", value: { index: 1, error: "0x01" } })).toBe(
      '{"type":"Module","value":{"index":1,"error":"0x01"}}',
    );
  });

  it("survives bigint fields, which JSON.stringify throws on", () => {
    expect(errorText({ type: "Insufficient", amount: 5n })).toBe(
      '{"type":"Insufficient","amount":"5"}',
    );
  });

  it("falls back to the keys when the value cannot be serialized", () => {
    const circular: Record<string, unknown> = { type: "Cyclic" };
    circular["self"] = circular;
    expect(errorText(circular)).toBe("type,self");
  });

  it("ignores an empty message rather than reporting nothing", () => {
    expect(errorText({ message: "", code: 7 })).toBe('{"message":"","code":7}');
  });

  it("still handles primitives", () => {
    expect(errorText("boom")).toBe("boom");
    expect(errorText(null)).toBe("null");
  });
});

describe("queryStatus", () => {
  it("reports a non-Error failure with its serialized shape", () => {
    expect(queryStatus(false, { type: "Module", value: 3 }, undefined)).toBe(
      'error: {"type":"Module","value":3}',
    );
  });

  it("prefers the failure over pending and data", () => {
    expect(queryStatus(true, new Error("nope"), { kind: "game" })).toBe(
      "error: nope",
    );
  });

  it("keeps a resolved card's result kind visible", () => {
    expect(queryStatus(false, null, { kind: "card" })).toBe("ok: card");
  });

  it("names a resolved degraded card result", () => {
    expect(queryStatus(false, null, { kind: "account-unavailable" })).toBe(
      "ok: account-unavailable",
    );
  });

  it("keeps a resolved game result's kind visible", () => {
    expect(queryStatus(false, null, { kind: "no-game" })).toBe("ok: no-game");
  });

  it("prefers resolved data over a stale pending flag", () => {
    expect(queryStatus(true, null, { kind: "game" })).toBe("ok: game");
  });
});

describe("duration", () => {
  it("keeps the two largest units and never goes negative", () => {
    expect(duration(0)).toBe("<1m");
    expect(duration(59)).toBe("<1m");
    expect(duration(-30)).toBe("<1m");
    expect(duration(60)).toBe("1m");
    expect(duration(3_599)).toBe("59m");
    expect(duration(3_600)).toBe("1h 0m");
    expect(duration(5 * 3_600 + 7 * 60 + 30)).toBe("5h 7m");
    expect(duration(86_400)).toBe("1d 0h");
    expect(duration(2 * 86_400 + 23 * 3_600 + 59 * 60)).toBe("2d 23h");
  });
});
