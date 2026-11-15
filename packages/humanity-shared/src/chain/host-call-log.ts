// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Ledger of every host (truAPI) call the app makes, for the debug panel:
 * one record per method with the last call's arguments, outcome and timing.
 *
 * Calls are observed through a Proxy around the SDK handles (`host-api.ts`),
 * so no call site is touched and none can be forgotten. Results are only ever
 * summarised — keys, lengths, short hex — never printed whole, so a signer or
 * a secret can never reach the panel or the copied snapshot.
 *
 * The same observation point feeds Sentry: a call made while a flow is in
 * flight (`telemetry/flow.ts`) is a timed `host.call` span under that flow's
 * current stage, carrying the method name and outcome only — never the
 * arguments or the result, which the ledger summarises for the panel alone.
 */

import { childSpan } from "@humanity/shared/telemetry/flow.ts";
import { monotonicNow } from "@humanity/shared/utils/monotonic-now.ts";

export type HostCallOutcome = "pending" | "ok" | "error";

export interface HostCallRecord {
  method: string;
  calls: number;
  lastAt: number;
  lastElapsedMs: number | null;
  outcome: HostCallOutcome;
  args: string;
  result: string;
}

const records: Record<string, HostCallRecord> = {};

export function getHostCallDiagnostics(): HostCallRecord[] {
  return Object.values(records).sort((a, b) => a.method.localeCompare(b.method));
}

export function resetHostCallDiagnostics(): void {
  for (const method of Object.keys(records)) delete records[method];
}

const MAX_STRING = 96;
const MAX_DEPTH = 3;
const MAX_ENTRIES = 8;
const MAX_TOTAL = 400;
const SECRET_KEY = /secret|private|mnemonic|seed|password/i;

function hex(bytes: Uint8Array): string {
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${body}`;
}

interface ResultLike {
  isOk(): boolean;
  value?: unknown;
  error?: unknown;
}

function isResultLike(value: object): value is ResultLike {
  return "isOk" in value && typeof value.isOk === "function";
}

function isSubscriptionHandle(value: object): boolean {
  return "unsubscribe" in value && typeof value.unsubscribe === "function";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function render(value: unknown, depth: number): string {
  if (value == null) return String(value);
  switch (typeof value) {
    case "string":
      return clip(value, MAX_STRING);
    case "number":
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "function":
      return "fn";
    case "symbol":
      return value.toString();
    case "object":
      break;
    default:
      return typeof value;
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof Uint8Array) return clip(hex(value), MAX_STRING);
  if (isResultLike(value)) {
    return value.isOk() ? render(value.value, depth) : `Err(${render(value.error, depth)})`;
  }
  if (isSubscriptionHandle(value)) return "subscription";
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length}]` : "{…}";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => render(item, depth + 1));
    if (value.length > MAX_ENTRIES) items.push(`… +${value.length - MAX_ENTRIES}`);
    return `[${items.join(", ")}]`;
  }
  if ("tag" in value && typeof value.tag === "string") {
    const inner = "value" in value && value.value !== undefined ? render(value.value, depth + 1) : "";
    return inner === "" ? value.tag : `${value.tag}(${inner})`;
  }
  const entries = Object.entries(value).filter(([, item]) => typeof item !== "function");
  const shown = entries.slice(0, MAX_ENTRIES).map(([key, item]) =>
    SECRET_KEY.test(key) ? `${key}: «redacted»` : `${key}: ${render(item, depth + 1)}`,
  );
  if (entries.length > MAX_ENTRIES) shown.push(`… +${entries.length - MAX_ENTRIES}`);
  return `{${shown.join(", ")}}`;
}

/** Readable rendering of a value for a table cell: real values, not key
 *  lists — bounded in depth and length, functions elided, and any key that
 *  smells like a secret redacted so a signer or seed can never reach the
 *  panel or the copied snapshot. */
export function summarize(value: unknown): string {
  return clip(render(value, 0), MAX_TOTAL);
}

function begin(method: string, args: readonly unknown[]): void {
  const previous = records[method];
  records[method] = {
    method,
    calls: (previous?.calls ?? 0) + 1,
    lastAt: Date.now(),
    lastElapsedMs: null,
    outcome: "pending",
    args: args.map(summarize).join(", "),
    result: "",
  };
}

function settle(method: string, startedAt: number, outcome: HostCallOutcome, result: unknown): void {
  const record = records[method];
  if (record == null) return;
  record.outcome = outcome;
  record.result = summarize(result);
  record.lastElapsedMs = Math.round(monotonicNow() - startedAt);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value == null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return "then" in value && typeof value.then === "function";
}

/** Record `method` around `run`, following a promise or neverthrow result to
 *  its settlement. The original return value is handed back untouched. */
export function traceHostCall<T>(method: string, run: () => T, args: readonly unknown[] = []): T {
  const startedAt = monotonicNow();
  const endSpan = childSpan("host.call", method);
  begin(method, args);
  let out: T;
  try {
    out = run();
  } catch (error) {
    settle(method, startedAt, "error", error);
    endSpan({ ok: false, detail: error instanceof Error ? error.name : "threw" });
    throw error;
  }
  if (isThenable(out)) {
    void Promise.resolve(out).then(
      (value) => {
        const failed = typeof value === "object" && value != null && isResultLike(value) && !value.isOk();
        settle(method, startedAt, failed ? "error" : "ok", value);
        endSpan({ ok: !failed, detail: failed ? "host error" : undefined });
      },
      (error: unknown) => {
        settle(method, startedAt, "error", error);
        endSpan({ ok: false, detail: error instanceof Error ? error.name : "rejected" });
      },
    );
  } else {
    settle(method, startedAt, "ok", out);
    endSpan({ ok: true });
  }
  return out;
}

function isLeafObject(value: object): boolean {
  return (
    Array.isArray(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    isThenable(value)
  );
}

/**
 * Wrap a host handle so every method call on it — and on the namespaces it
 * exposes — lands in the ledger as `<prefix>.<method>`. Methods run with the
 * original object as `this`, so class internals and private fields are
 * unaffected; the proxy is a listener, not a replacement.
 */
export function traceHostObject<T extends object>(prefix: string, target: T): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj);
      if (typeof prop === "symbol") return value;
      if (typeof value === "function") {
        return (...args: unknown[]) =>
          traceHostCall(`${prefix}.${prop}`, () => Reflect.apply(value, obj, args), args);
      }
      if (value != null && typeof value === "object" && !isLeafObject(value)) {
        return traceHostObject(`${prefix}.${prop}`, value);
      }
      return value;
    },
  });
}
