// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The ledger is a listener on the SDK handles: it must never change what a
 *  call returns, must follow promises and neverthrow results to their real
 *  outcome, and must summarise rather than print — a signer or a secret key
 *  passes through these handles. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getHostCallDiagnostics,
  resetHostCallDiagnostics,
  summarize,
  traceHostCall,
  traceHostObject,
} from "@humanity/shared/chain/host-call-log.ts";

const okResult = { isOk: () => true, value: { primaryUsername: "alice.61" } };
const errResult = { isOk: () => false, error: { tag: "PermissionDenied" } };

beforeEach(resetHostCallDiagnostics);

describe("summarize", () => {
  it("renders real values — scalars, bytes, tagged unions, results, objects — bounded", () => {
    expect(summarize("x".repeat(120))).toBe(`${"x".repeat(96)}…`);
    expect(summarize(7n)).toBe("7n");
    expect(summarize(new Uint8Array([0x90, 0xe5, 0x5d, 0xb3]))).toBe("0x90e55db3");
    expect(summarize({ tag: "ProductAccount", value: { derivationIndex: 1 } })).toBe(
      "ProductAccount({derivationIndex: 1})",
    );
    expect(summarize({ tag: "PermissionDenied" })).toBe("PermissionDenied");
    expect(summarize(okResult)).toBe("{primaryUsername: alice.61}");
    expect(summarize(errResult)).toBe("Err(PermissionDenied)");
    expect(summarize([1, "two", { three: 3n }])).toBe("[1, two, {three: 3n}]");
    expect(summarize(() => undefined)).toBe("fn");
  });

  it("elides functions, caps entries and depth, and names subscription handles", () => {
    expect(summarize({ publicKey: "0xab", signTx: () => undefined })).toBe("{publicKey: 0xab}");
    const wide = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    expect(summarize(wide)).toBe("{k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, … +2}");
    expect(summarize({ a: { b: { c: { d: 1 } } } })).toBe("{a: {b: {c: {…}}}}");
    expect(summarize({ unsubscribe: () => undefined, onInterrupt: () => undefined })).toBe(
      "subscription",
    );
  });

  it("redacts anything keyed like a secret, at any depth", () => {
    expect(
      summarize({ tag: "PrivateKey", value: { sr25519SecretKey: "0xdeadbeef" } }),
    ).toBe("PrivateKey({sr25519SecretKey: «redacted»})");
    expect(summarize({ mnemonic: "hub daughter lunar", publicKey: "0x01" })).toBe(
      "{mnemonic: «redacted», publicKey: 0x01}",
    );
  });
});

describe("traceHostCall", () => {
  it("returns the original value and records a sync ok", () => {
    expect(traceHostCall("host.sync", () => 42, ["arg"])).toBe(42);
    expect(getHostCallDiagnostics()).toMatchObject([
      { method: "host.sync", calls: 1, outcome: "ok", args: "arg", result: "42" },
    ]);
  });

  it("follows a promise to ok and to rejection without swallowing either", async () => {
    await expect(traceHostCall("host.p", () => Promise.resolve("done"))).resolves.toBe("done");
    expect(getHostCallDiagnostics()[0]).toMatchObject({ outcome: "ok", result: "done" });
    const failing = traceHostCall("host.p", () => Promise.reject(new Error("nope")));
    await expect(failing).rejects.toThrow("nope");
    expect(getHostCallDiagnostics()[0]).toMatchObject({
      calls: 2,
      outcome: "error",
      result: "Error: nope",
    });
  });

  it("reads a resolved neverthrow Err as an error outcome", async () => {
    await traceHostCall("host.r", () => Promise.resolve(errResult));
    expect(getHostCallDiagnostics()[0]).toMatchObject({
      outcome: "error",
      result: "Err(PermissionDenied)",
    });
  });

  it("traces on a runtime with no `performance` global", async () => {
    // Polkadot Desktop's QuickJS worker sandbox defines none, and every host
    // entry point goes through this tracer.
    vi.stubGlobal("performance", undefined);
    try {
      expect(traceHostCall("host.sync", () => 42)).toBe(42);
      await expect(traceHostCall("host.p", () => Promise.resolve("done"))).resolves.toBe("done");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(getHostCallDiagnostics()).toMatchObject([
      { method: "host.p", outcome: "ok", lastElapsedMs: expect.any(Number) },
      { method: "host.sync", outcome: "ok", lastElapsedMs: expect.any(Number) },
    ]);
  });
});

describe("traceHostObject", () => {
  class Provider {
    #secret = "never shown";
    calls = 0;
    nested = { ping: (n: number) => n + 1 };
    getUserId() {
      this.calls += 1;
      return Promise.resolve(okResult);
    }
    secretLength() {
      return this.#secret.length;
    }
  }

  it("records every method under its path and keeps the original as `this`", async () => {
    const provider = new Provider();
    const traced = traceHostObject("accounts", provider);
    await expect(traced.getUserId()).resolves.toBe(okResult);
    expect(traced.secretLength()).toBe(11);
    expect(traced.nested.ping(1)).toBe(2);
    expect(provider.calls).toBe(1);
    expect(getHostCallDiagnostics().map((call) => [call.method, call.outcome, call.result])).toEqual([
      ["accounts.getUserId", "ok", "{primaryUsername: alice.61}"],
      ["accounts.nested.ping", "ok", "2"],
      ["accounts.secretLength", "ok", "11"],
    ]);
  });

  it("passes non-function, non-namespace properties through untouched", () => {
    const traced = traceHostObject("accounts", { bytes: new Uint8Array(2), n: 3 });
    expect(traced.bytes).toBeInstanceOf(Uint8Array);
    expect(traced.n).toBe(3);
    expect(getHostCallDiagnostics()).toEqual([]);
  });
});
