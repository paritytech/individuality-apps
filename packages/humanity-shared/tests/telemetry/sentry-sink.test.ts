// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The sink is where a failure becomes an issue: an error-level record is one
 * event, grouped by its template and not its values, carrying the Error it
 * logged when it logged one; everything below error is a breadcrumb on the
 * next event and never an event itself.
 */
import { flush, init } from "@sentry/browser";
import type { LogRecord } from "@logtape/logtape";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { sentrySink } from "@humanity/shared/telemetry/sentry-sink.ts";

interface EventJson {
  type?: string;
  message?: string;
  level?: string;
  tags?: Record<string, string>;
  fingerprint?: string[];
  breadcrumbs?: { category?: string; message?: string; level?: string }[];
  exception?: { values?: { type?: string; value?: string }[] };
  contexts?: Record<string, Record<string, unknown>>;
}

const sent: unknown[] = [];

function isErrorEvent(payload: unknown): payload is EventJson {
  return (
    payload != null &&
    typeof payload === "object" &&
    "event_id" in payload &&
    !("type" in payload && payload.type === "transaction")
  );
}

function events(): EventJson[] {
  const out: EventJson[] = [];
  for (const envelope of sent) {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) continue;
    for (const item of envelope[1] as unknown[]) {
      if (Array.isArray(item) && isErrorEvent(item[1])) out.push(item[1]);
    }
  }
  return out;
}

function record(
  level: LogRecord["level"],
  category: string[],
  rawMessage: string,
  properties: Record<string, unknown>,
  message: readonly unknown[],
): LogRecord {
  return { level, category, rawMessage, properties, message, timestamp: 1_700_000_000_000 };
}

beforeAll(() => {
  init({
    dsn: "https://key@o0.ingest.sentry.io/0",
    defaultIntegrations: false,
    transport: () => ({
      send: (envelope) => {
        sent.push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });
});

afterEach(() => {
  sent.length = 0;
});

describe("sentrySink", () => {
  it("files an error record as one event grouped by template, with its values as tags", async () => {
    sentrySink(
      record("info", ["humanity", "card", "register-personhood"], "stage sign: {bytes} bytes", { bytes: 32 }, [
        "stage sign: ",
        32,
        " bytes",
      ]),
    );
    sentrySink(
      record(
        "error",
        ["humanity", "card", "register-personhood"],
        "Score.register stopped ({kind}): {detail}",
        { kind: "refused", detail: "ringVrfSign: PermissionDenied" },
        ["Score.register stopped (", "refused", "): ", "ringVrfSign: PermissionDenied"],
      ),
    );
    await flush();

    const [event, ...rest] = events();
    expect(rest).toEqual([]);
    expect(event?.level).toBe("error");
    expect(event?.message).toBe("Score.register stopped (refused): ringVrfSign: PermissionDenied");
    expect(event?.fingerprint).toEqual([
      "humanity.card.register-personhood",
      "Score.register stopped ({kind}): {detail}",
    ]);
    expect(event?.tags).toMatchObject({
      "log.category": "humanity.card.register-personhood",
      "log.kind": "refused",
      "log.detail": "ringVrfSign: PermissionDenied",
    });
    // The info record before it rode along as a breadcrumb, not an event.
    expect(event?.breadcrumbs?.map((crumb) => [crumb.level, crumb.message])).toEqual([
      ["info", "stage sign: 32 bytes"],
    ]);
  });

  it("reports the Error a record carries as the exception, keeping its type", async () => {
    class HostProviderAcquisitionError extends Error {
      name = "HostProviderAcquisitionError";
    }
    sentrySink(
      record("error", ["humanity", "card", "humanity-card"], "first card read failed: {error}", {
        error: new HostProviderAcquisitionError("bridge-unavailable"),
      }, ["first card read failed: ", "HostProviderAcquisitionError: bridge-unavailable"]),
    );
    await flush();
    const [event] = events();
    expect(event?.exception?.values?.[0]).toMatchObject({
      type: "HostProviderAcquisitionError",
      value: "bridge-unavailable",
    });
    expect(event?.fingerprint).toEqual(["humanity.card.humanity-card", "first card read failed: {error}"]);
  });

  it("never turns a warning into an event", async () => {
    sentrySink(
      record("warning", ["humanity", "chain", "connection"], "provider slow: {ms} ms", { ms: 900 }, [
        "provider slow: ",
        900,
        " ms",
      ]),
    );
    await flush();
    expect(events()).toEqual([]);
  });

  it("blanks identity properties in the tags and the line unless the deployer opted in", async () => {
    sentrySink(
      record(
        "info",
        ["humanity", "card", "claim-dotns-name"],
        "linking {label} to lite {lite} for {owner}",
        { label: "alice", lite: "alice.01", owner: "5Fowner" },
        ["linking ", "alice", " to lite ", "alice.01", " for ", "5Fowner", ""],
      ),
    );
    sentrySink(
      record(
        "error",
        ["humanity", "card", "claim-dotns-name"],
        "dotNS claim of {label} stopped: {code}",
        { label: "alice", code: "refused" },
        ["dotNS claim of ", "alice", " stopped: ", "refused", ""],
      ),
    );
    await flush();

    const [event] = events();
    expect(event?.message).toBe("dotNS claim of [redacted] stopped: refused");
    expect(event?.tags).toMatchObject({ "log.label": "[redacted]", "log.code": "refused" });
    expect(event?.breadcrumbs?.at(-1)?.message).toBe("linking [redacted] to lite [redacted] for [redacted]");
    expect(event?.fingerprint).toEqual(["humanity.card.claim-dotns-name", "dotNS claim of {label} stopped: {code}"]);
  });
});
